/** A stand-in for the iPad app, written only from protocol/PROTOCOL.md and
 * deliberately sharing no code with the plugin. Needs Node 22+ (built-in
 * WebSocket client and zlib.crc32); no dependencies. */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import zlib from "node:zlib";

const mac = (key, purpose, serverNonce, clientNonce, deviceId) =>
  createHmac("sha256", key).update(`remote-draw/v1/${purpose}\n${serverNonce}\n${clientNonce}\n${deviceId}`, "utf8").digest();

/** Parse the URI inside the pairing QR code. */
export function parsePairingUri(uri) {
  const url = new URL(uri);
  if (url.protocol !== "remotedraw:" || url.host !== "pair" || url.searchParams.get("v") !== "1") throw new Error("Not a Remote Draw v1 pairing code.");
  const get = name => { const value = url.searchParams.get(name); if (!value) throw new Error(`Pairing code has no ${name}.`); return value; };
  return { serverId: get("id"), name: get("name"), port: Number(get("port")),
    hosts: (url.searchParams.get("hosts") ?? "").split(",").filter(Boolean), code: get("code") };
}
export function newDevice(name = "Fake iPad") { return { deviceId: randomUUID(), deviceName: name }; }

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]), out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), body.length + 4);
  return out;
}
/** RGBA pixels to a PNG file. */
export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
/** Render strokes ({color, width, points}) the way the spec asks: transparent
 * PNG over the drawing bounds at 2 pixels per point. Undefined when empty. */
export function renderInk(strokes, scale = 2) {
  const drawn = strokes.filter(stroke => stroke.points.length);
  if (!drawn.length) return undefined;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const stroke of drawn) for (const [x, y] of stroke.points) {
    left = Math.min(left, x - stroke.width / 2); top = Math.min(top, y - stroke.width / 2);
    right = Math.max(right, x + stroke.width / 2); bottom = Math.max(bottom, y + stroke.width / 2);
  }
  left = Math.floor(left); top = Math.floor(top); right = Math.ceil(right); bottom = Math.ceil(bottom);
  const width = Math.max(1, right - left), height = Math.max(1, bottom - top);
  scale = Math.min(scale, 4096 / width, 4096 / height);
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale)), pixels = Buffer.alloc(w * h * 4);
  const dot = (cx, cy, radius, rgb) => {
    for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(h - 1, Math.ceil(cy + radius)); y++)
      for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(w - 1, Math.ceil(cx + radius)); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) pixels.set([...rgb, 255], (y * w + x) * 4);
  };
  for (const stroke of drawn) {
    const rgb = [1, 3, 5].map(i => parseInt(stroke.color.slice(i, i + 2), 16)), radius = Math.max(.5, stroke.width * scale / 2);
    stroke.points.forEach(([x, y], i) => {
      const [px, py] = stroke.points[Math.max(0, i - 1)], steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) * scale));
      for (let s = 0; s <= steps; s++) dot((px + (x - px) * s / steps - left) * scale, (py + (y - py) * s / steps - top) * scale, radius, rgb);
    });
  }
  return { x: left, y: top, width, height, png: encodePng(w, h, pixels).toString("base64") };
}

/** One connection. Events: onPad(message), onClear(message), onClose({code, error}). */
export class FakeIpad {
  strokes = [];
  sheet = undefined;
  #socket; #stroke = 0; #through = 0;
  /** @param {{ onPad?: Function, onClear?: Function, onClose?: Function }} handlers */
  constructor(handlers = {}) { this.handlers = handlers; }

  /** Resolves with `{ deviceKey }` (base64url) once the server proved itself.
   * Pass `code` (from the QR) to pair, or `deviceKey` to authenticate.
   * @param {{ url: string, deviceId: string, deviceName?: string, code?: string, deviceKey?: string }} options
   * @returns {Promise<{ deviceKey: string }>} */
  connect({ url, deviceId, deviceName, code, deviceKey }) {
    return new Promise((resolve, reject) => {
      const socket = this.#socket = new WebSocket(url);
      let ready = false, expected, key, serverError;
      socket.addEventListener("error", () => { if (!ready) reject(new Error(`Could not connect to ${url}.`)); });
      socket.addEventListener("close", event => {
        if (!ready) reject(Object.assign(new Error(serverError?.message ?? `Closed during handshake (${event.code}).`), { code: event.code, error: serverError }));
        this.handlers.onClose?.({ code: event.code, error: serverError });
      });
      socket.addEventListener("message", event => {
        const message = JSON.parse(event.data);
        if (message.type === "error") { serverError = message; return; }
        if (message.type === "hello") {
          if (message.v !== 1) return socket.close();
          const nonce = randomBytes(24).toString("base64url"), parts = [message.nonce, nonce, deviceId];
          if (code) {
            const secret = Buffer.from(code, "base64url");
            key = mac(secret, "key", ...parts);
            socket.send(JSON.stringify({ type: "pair", deviceId, deviceName, nonce, proof: mac(secret, "pair", ...parts).toString("base64url") }));
          } else {
            key = Buffer.from(deviceKey, "base64url");
            socket.send(JSON.stringify({ type: "auth", deviceId, nonce, proof: mac(key, "auth", ...parts).toString("base64url") }));
          }
          expected = mac(key, "server", ...parts).toString("base64url");
        } else if (message.type === "paired" || message.type === "ready") {
          if (message.proof !== expected) { socket.close(); return reject(new Error("The server failed to prove it knows the device key.")); }
          ready = true; resolve({ deviceKey: key.toString("base64url") });
        } else if (message.type === "pad") {
          if (!message.open) this.sheet = undefined;
          else if (message.sheet.id !== this.sheet?.id) {
            this.sheet = message.sheet;
            // The fake's "drawing data" is its stroke list as JSON, so a stored drawing can be loaded back.
            try { this.strokes = message.sheet.drawing ? JSON.parse(Buffer.from(message.sheet.drawing, "base64").toString()) : []; }
            catch { this.strokes = []; }
            if (message.sheet.drawing) this.sendInk();
          }
          else this.sheet = { ...message.sheet, drawing: this.sheet.drawing };
          this.handlers.onPad?.(message);
        } else if (message.type === "clear") {
          if (message.sheet === this.sheet?.id) { this.strokes = []; this.sendInk(); }
          this.handlers.onClear?.(message);
        }
      });
    });
  }
  send(message) { this.#socket.send(JSON.stringify(message)); }
  /** A stroke that leaves no ink, e.g. a rejected palm. */
  cancelStroke(points, { color = "#ffffff", width = 3 } = {}) {
    const sheet = this.sheet.id, stroke = ++this.#stroke;
    this.send({ type: "preview", sheet, stroke, color, width, points, end: false });
    this.send({ type: "preview", sheet, stroke, color, width, points: [], end: true, cancelled: true });
  }
  /** Draw one stroke: live previews in batches, then the rendered drawing. */
  async drawStroke(points, { color = "#ffffff", width = 3, batch = 8, delayMs = 0 } = {}) {
    if (!this.sheet) throw new Error("No pad is open.");
    const sheet = this.sheet.id, stroke = ++this.#stroke;
    for (let i = 0; i < points.length; i += batch) {
      this.send({ type: "preview", sheet, stroke, color, width, points: points.slice(i, i + batch), end: false });
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    this.send({ type: "preview", sheet, stroke, color, width, points: [], end: true });
    this.strokes.push({ color, width, points });
    this.#through = stroke;
    this.sendInk();
  }
  undo() { this.strokes.pop(); this.sendInk(); }
  sendInk() {
    if (!this.sheet) throw new Error("No pad is open.");
    const image = renderInk(this.strokes);
    // Real drawing data is PKDrawing bytes; any bytes do for the desktop, which only stores them.
    const drawing = Buffer.from(JSON.stringify(this.strokes)).toString("base64");
    this.send({ type: "ink", sheet: this.sheet.id, through: this.#through, theme: this.sheet.theme, drawing, ...(image ? { image } : {}) });
  }
  close() { this.#socket?.close(); }
}
