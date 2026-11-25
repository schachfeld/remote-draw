import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { deviceKey, newNonce, newPairingCode, proof, proofMatches } from "./auth.ts";
import { CLOSE, HANDSHAKE_TIMEOUT_MS, MAX_MESSAGE_BYTES, PAIRING_TTL_MS, PING_INTERVAL_MS, PROTOCOL_VERSION, ProtocolError, WS_PATH,
  parseClientMessage, type ErrorCode, type InkMessage, type PreviewMessage, type ServerMessage, type SheetState } from "./protocol.ts";

export interface LinkDevice { id: string; name: string; key: Buffer; pairedAt: string }
export interface LinkHost {
  readonly serverId: string;
  device(id: string): LinkDevice | undefined;
  /** Persist a newly paired device. Throwing refuses the pairing. */
  saveDevice(device: LinkDevice): void;
  /** Connection, pairing or listening state changed. */
  changed(): void;
  preview(message: PreviewMessage): void;
  ink(message: InkMessage): void;
}
export interface LinkOptions { handshakeTimeoutMs?: number; pingIntervalMs?: number; pairingTtlMs?: number; host?: string }
interface Peer { socket: WebSocket; nonce: string; deviceId?: string; alive: boolean; timer?: ReturnType<typeof setTimeout> }

/** The WebSocket side of the plugin: one authenticated iPad at a time. Knows
 * nothing about windows or LearnHarness; the backend supplies the open sheet. */
export class Link {
  private server?: WebSocketServer;
  private readonly peers = new Set<Peer>();
  private active?: Peer;
  private pad?: SheetState;
  private pairing?: { code: Buffer; expiresAt: number; timer: ReturnType<typeof setTimeout> };
  private ping?: ReturnType<typeof setInterval>;
  private listenError?: string;
  private listeningPort?: number;
  constructor(private readonly host: LinkHost, private readonly options: LinkOptions = {}) {}

  get port(): number | undefined { return this.listeningPort; }
  get error(): string | undefined { return this.listenError; }
  get activeDeviceId(): string | undefined { return this.active?.deviceId; }
  get pairingCode(): { code: Buffer; expiresAt: number } | undefined {
    return this.pairing && { code: this.pairing.code, expiresAt: this.pairing.expiresAt };
  }

  /** Never rejects: a port that cannot be opened is reported through `error`. */
  async listen(port: number): Promise<void> {
    await this.close();
    this.listenError = undefined;
    const server = new WebSocketServer({ port, host: this.options.host, path: WS_PATH, maxPayload: MAX_MESSAGE_BYTES, clientTracking: false });
    try {
      await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    } catch (error) {
      server.close();
      this.listenError = (error as NodeJS.ErrnoException).code === "EADDRINUSE"
        ? `Port ${port} is already in use. Choose another port in the Remote Draw settings.`
        : `Could not listen on port ${port}: ${(error as Error).message}`;
      this.host.changed();
      return;
    }
    server.on("error", error => { this.listenError = error.message; this.host.changed(); });
    server.on("connection", (socket, request) => this.accept(socket, request));
    this.server = server;
    const address = server.address();
    this.listeningPort = typeof address === "object" && address ? address.port : port;
    this.ping = setInterval(() => this.heartbeat(), this.options.pingIntervalMs ?? PING_INTERVAL_MS);
    this.host.changed();
  }
  async close(): Promise<void> {
    clearInterval(this.ping); this.ping = undefined;
    for (const peer of [...this.peers]) this.drop(peer, 1001);
    const server = this.server;
    this.server = undefined; this.listeningPort = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }
  dispose(): Promise<void> { this.cancelPairing(false); return this.close(); }

  startPairing(): { code: Buffer; expiresAt: number } {
    this.cancelPairing(false);
    const ttl = this.options.pairingTtlMs ?? PAIRING_TTL_MS;
    const timer = setTimeout(() => this.cancelPairing(), ttl);
    timer.unref?.();
    this.pairing = { code: newPairingCode(), expiresAt: Date.now() + ttl, timer };
    this.host.changed();
    return { code: this.pairing.code, expiresAt: this.pairing.expiresAt };
  }
  cancelPairing(notify = true): void {
    if (!this.pairing) return;
    clearTimeout(this.pairing.timer); this.pairing = undefined;
    if (notify) this.host.changed();
  }
  /** The sheet the connected iPad should show, or undefined for "no pad open". */
  setPad(pad: SheetState | undefined): void {
    this.pad = pad;
    if (this.active) this.send(this.active, pad ? { type: "pad", open: true, sheet: pad } : { type: "pad", open: false });
  }
  /** Keeps the copy used for reconnects current without re-sending the sheet. */
  rememberDrawing(sheet: string, drawing: string | undefined): void {
    if (this.pad?.id !== sheet) return;
    const { drawing: _old, ...rest } = this.pad;
    this.pad = drawing === undefined ? rest : { ...rest, drawing };
  }
  clear(sheet: string): void {
    this.rememberDrawing(sheet, undefined);
    if (this.active && this.pad?.id === sheet) this.send(this.active, { type: "clear", sheet });
  }
  /** A device removed in settings loses its connection at once. */
  forget(deviceId: string): void {
    for (const peer of [...this.peers]) if (peer.deviceId === deviceId) this.drop(peer, CLOSE.forgotten);
  }

  private accept(socket: WebSocket, _request: IncomingMessage): void {
    const peer: Peer = { socket, nonce: newNonce(), alive: true };
    this.peers.add(peer);
    peer.timer = setTimeout(() => this.drop(peer, CLOSE.unauthorized), this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    socket.on("pong", () => { peer.alive = true; });
    socket.on("error", () => this.drop(peer, 1011));
    socket.on("close", () => this.gone(peer));
    socket.on("message", (data, binary) => {
      if (binary) return this.reject(peer, "bad-message", "Binary frames are not supported.");
      try { this.receive(peer, data.toString()); }
      catch (error) {
        this.reject(peer, "bad-message", error instanceof ProtocolError ? error.message : "The message could not be handled.");
      }
    });
    this.send(peer, { type: "hello", v: PROTOCOL_VERSION, serverId: this.host.serverId, nonce: peer.nonce });
  }
  private receive(peer: Peer, raw: string): void {
    const message = parseClientMessage(raw);
    if (peer !== this.active) {
      if (peer.deviceId !== undefined) return; // Already rejected or replaced; closing.
      if (message.type === "pair") return this.pair(peer, message.deviceId, message.deviceName, message.nonce, message.proof);
      if (message.type === "auth") return this.authenticate(peer, message.deviceId, message.nonce, message.proof);
      throw new ProtocolError("Authenticate first.");
    }
    if (message.type === "pair" || message.type === "auth") throw new ProtocolError("Already authenticated.");
    // A message for another sheet may simply have crossed a `pad` on the wire.
    if (message.sheet !== this.pad?.id) return;
    if (message.type === "preview") this.host.preview(message);
    else { this.rememberDrawing(message.sheet, message.image ? message.drawing : undefined); this.host.ink(message); }
  }
  private pair(peer: Peer, deviceId: string, name: string, clientNonce: string, received: string): void {
    const pairing = this.pairing;
    if (!pairing || pairing.expiresAt <= Date.now() ||
      !proofMatches(proof(pairing.code, "pair", peer.nonce, clientNonce, deviceId), received))
      return this.reject(peer, "unauthorized", "The pairing code is wrong or has expired. Show a new QR code and scan it again.");
    if (this.busyFor(deviceId)) return this.reject(peer, "busy", "Another iPad is connected.");
    const key = deviceKey(pairing.code, peer.nonce, clientNonce, deviceId);
    this.cancelPairing(false); // Single use, even if saving fails below.
    try { this.host.saveDevice({ id: deviceId, name, key, pairedAt: new Date().toISOString() }); }
    catch { this.host.changed(); return this.reject(peer, "unauthorized", "The desktop could not save the pairing. Try again."); }
    this.admit(peer, deviceId, "paired", proof(key, "server", peer.nonce, clientNonce, deviceId));
  }
  private authenticate(peer: Peer, deviceId: string, clientNonce: string, received: string): void {
    const device = this.host.device(deviceId);
    if (!device || !proofMatches(proof(device.key, "auth", peer.nonce, clientNonce, deviceId), received))
      return this.reject(peer, "unauthorized", "This iPad is not paired with this desktop. Pair it again.");
    if (this.busyFor(deviceId)) return this.reject(peer, "busy", "Another iPad is connected.");
    this.admit(peer, deviceId, "ready", proof(device.key, "server", peer.nonce, clientNonce, deviceId));
  }
  private busyFor(deviceId: string): boolean { return !!this.active && this.active.deviceId !== deviceId; }
  private admit(peer: Peer, deviceId: string, type: "paired" | "ready", serverProof: string): void {
    clearTimeout(peer.timer);
    const previous = this.active;
    peer.deviceId = deviceId;
    this.active = peer;
    if (previous) this.drop(previous, CLOSE.replaced);
    this.send(peer, { type, proof: serverProof });
    this.send(peer, this.pad ? { type: "pad", open: true, sheet: this.pad } : { type: "pad", open: false });
    this.host.changed();
  }
  private reject(peer: Peer, code: ErrorCode, message: string): void {
    peer.deviceId ??= ""; // Marks the peer as finished so late frames are ignored.
    this.send(peer, { type: "error", code, message });
    this.drop(peer, code === "busy" ? CLOSE.busy : code === "bad-message" ? CLOSE.badMessage :
      code === "unsupported-version" ? CLOSE.unsupportedVersion : CLOSE.unauthorized);
  }
  private send(peer: Peer, message: ServerMessage): void {
    if (peer.socket.readyState === peer.socket.OPEN) peer.socket.send(JSON.stringify(message));
  }
  private drop(peer: Peer, code: number): void {
    const state = peer.socket.readyState;
    if (state === peer.socket.OPEN || state === peer.socket.CONNECTING) peer.socket.close(code);
    this.gone(peer);
  }
  private gone(peer: Peer): void {
    if (!this.peers.delete(peer)) return;
    clearTimeout(peer.timer);
    if (this.active === peer) { this.active = undefined; this.host.changed(); }
  }
  private heartbeat(): void {
    for (const peer of [...this.peers]) {
      if (!peer.alive) { peer.socket.terminate(); this.gone(peer); continue; }
      peer.alive = false;
      try { peer.socket.ping(); } catch { /* The close handler cleans up. */ }
    }
  }
}
