import os from "node:os";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { advertise as bonjour, type Advertise, type Advertisement } from "./discovery.ts";
import { Link, type LinkOptions } from "./link.ts";
import { PROTOCOL_VERSION, isSheetId, parseSheetState, type InkMessage, type Picture, type SheetState, type Theme } from "./protocol.ts";
import { acceptedPoseKeys } from "./poses.ts";
import { Store, parseSettingsChange } from "./store.ts";

/** A window that has not confirmed its open pad for this long is treated as gone
 * (reloaded or closed without saying so). The window confirms every 10 seconds. */
export const PAD_TTL_MS = 30_000;
const WINDOW_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface StoredInk { sheet: string; seq: number; through: number; theme: Theme; drawing?: string; image?: Picture }
export interface Status {
  serverId: string;
  name: string;
  port: number | null;
  error: string | null;
  discoveryError: string | null;
  devices: { id: string; name: string; pairedAt: string; connected: boolean }[];
  pairing: { uri: string; expiresAt: number } | null;
  /** The window whose pad the iPad draws into. */
  activeWindow: string | null;
}
export interface Dependencies {
  advertise: Advertise;
  hostname(): string;
  addresses(): string[];
  now(): number;
  link?: LinkOptions;
  sweepMs?: number;
}
const defaults: Dependencies = {
  advertise: bonjour,
  hostname: () => os.hostname().replace(/\.local$/i, ""),
  addresses: () => Object.values(os.networkInterfaces()).flatMap(list => list ?? [])
    .filter(address => address.family === "IPv4" && !address.internal).map(address => address.address),
  now: () => Date.now(),
};
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length ||
    keys.some(key => !(key in input))) throw new Error(`Expected exactly: ${keys.join(", ")}.`);
  return input as Record<string, unknown>;
}
function windowId(input: Record<string, unknown>): string {
  if (typeof input.windowId !== "string" || !WINDOW_ID.test(input.windowId)) throw new Error("Expected a valid windowId.");
  return input.windowId;
}
function sheetId(input: Record<string, unknown>): string {
  if (!isSheetId(input.sheet)) throw new Error("Expected a valid sheet id.");
  return input.sheet;
}

export const activate = (ctx: PluginBackendContext) => activateWith(ctx, defaults);

/** Relay between the iPad and the app windows, plus pairing and preferences.
 * Drawings are owned by the windows; this keeps only what a reconnecting iPad
 * or a window that missed a notification needs. */
export async function activateWith(ctx: PluginBackendContext, deps: Dependencies): Promise<() => Promise<void>> {
  const store = new Store(ctx.dataDirectory);
  let disposed = false, order = 0, seq = 0;
  let advertisement: Advertisement | undefined, discoveryError: string | undefined;
  const pads = new Map<string, { sheet: SheetState; order: number; touchedAt: number }>();
  const inks = new Map<string, StoredInk>();
  const assertActive = () => { if (disposed || ctx.signal.aborted) throw new Error("Remote Draw is disabled."); };
  const emit = (topic: string, data: unknown) => { if (!disposed && !ctx.signal.aborted) ctx.events.emit(topic, data); };

  const activeWindow = (): string | undefined => {
    let best: string | undefined, bestOrder = -1;
    for (const [id, pad] of pads) if (pad.order > bestOrder) { best = id; bestOrder = pad.order; }
    return best;
  };
  let published: string | undefined;
  /** Re-send the sheet to the iPad only when the active window or its sheet changed. */
  const publish = (force = false) => {
    const id = activeWindow();
    if (!force && id === published) return;
    published = id;
    link.setPad(id ? pads.get(id)!.sheet : undefined);
    emit("status-changed", status());
  };
  const link = new Link({
    serverId: store.serverId,
    device: id => store.device(id),
    saveDevice: device => store.saveDevice(device),
    changed: () => emit("status-changed", status()),
    preview: message => { const id = activeWindow(); if (id) emit("preview", { windowId: id, ...message }); },
    ink: message => storeInk(message),
  }, deps.link);
  function storeInk(message: InkMessage): void {
    const id = activeWindow(), pad = id ? pads.get(id) : undefined;
    if (!id || pad?.sheet.id !== message.sheet) return;
    const { drawing: _old, ...rest } = pad.sheet;
    pad.sheet = message.image ? { ...rest, drawing: message.drawing } : rest;
    const ink: StoredInk = { sheet: message.sheet, seq: ++seq, through: message.through, theme: message.theme,
      ...(message.image ? { drawing: message.drawing, image: message.image } : {}) };
    inks.set(id, ink);
    emit("ink-updated", { windowId: id, sheet: ink.sheet, seq: ink.seq });
  }
  function status(): Status {
    const pairing = link.pairingCode, port = link.port;
    return {
      serverId: store.serverId, name: deps.hostname(), port: port ?? null, error: link.error ?? null, discoveryError: discoveryError ?? null,
      devices: store.devices.map(device => ({ id: device.id, name: device.name, pairedAt: device.pairedAt, connected: link.activeDeviceId === device.id })),
      pairing: pairing && port !== undefined ? { expiresAt: pairing.expiresAt, uri: "remotedraw://pair?" + new URLSearchParams({
        v: String(PROTOCOL_VERSION), id: store.serverId, name: deps.hostname(), port: String(port),
        hosts: deps.addresses().join(","), code: pairing.code.toString("base64url") }) } : null,
      activeWindow: activeWindow() ?? null,
    };
  }
  async function listen(): Promise<void> {
    advertisement?.stop(); advertisement = undefined; discoveryError = undefined;
    await link.listen(store.settings.port);
    if (disposed || link.port === undefined) return;
    advertisement = deps.advertise({ name: `Remote Draw (${deps.hostname()})`, port: link.port, serverId: store.serverId,
      failed: message => { discoveryError = message; emit("status-changed", status()); } });
  }
  // Port changes are serialized so two quick saves cannot leave two servers.
  let listening: Promise<void> = Promise.resolve();
  const relisten = () => (listening = listening.then(() => disposed ? undefined : listen()));

  const handlers = [
    ctx.handle("get-settings", () => { assertActive(); return { ...store.settings }; }),
    ctx.handle("set-image-scale", input => {
      assertActive();
      const before = store.settings, next = store.change({ imageScale: parseSettingsChange(input, "imageScale") });
      if (next !== before) emit("settings-changed", { ...next });
      return { ...next };
    }),
    ctx.handle("set-port", async input => {
      assertActive();
      const before = store.settings, next = store.change({ port: parseSettingsChange(input, "port") });
      if (next !== before) { emit("settings-changed", { ...next }); await relisten(); }
      return { ...next };
    }),
    ctx.handle("get-status", () => { assertActive(); return status(); }),
    // Read-only: accepted practice-problem identities, to know when a new problem resets the sheet.
    ctx.handle("get-session-poses", input => {
      assertActive();
      const { sessionId } = fields(input, ["sessionId"]);
      if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("Expected a valid sessionId.");
      const record = ctx.learning.getSession(sessionId);
      return { sessionId, poses: record?.kind === "practice" ? acceptedPoseKeys(record.messages) : [] };
    }),
    ctx.handle("start-pairing", () => {
      assertActive();
      if (link.port === undefined) throw new Error(link.error ?? "Remote Draw is not listening yet.");
      store.ensureServerId();
      link.startPairing();
      return status();
    }),
    ctx.handle("cancel-pairing", () => { assertActive(); link.cancelPairing(); return status(); }),
    ctx.handle("forget-device", input => {
      assertActive();
      const { deviceId } = fields(input, ["deviceId"]);
      if (typeof deviceId !== "string") throw new Error("Expected a deviceId.");
      if (store.removeDevice(deviceId)) { link.forget(deviceId); emit("status-changed", status()); }
      return status();
    }),
    ctx.handle("set-pad", input => {
      assertActive();
      const body = fields(input, ["windowId", "sheet"]), id = windowId(body);
      if (body.sheet === null) {
        inks.delete(id);
        if (pads.delete(id)) publish();
        return { active: false };
      }
      const sheet = parseSheetState(body.sheet), existing = pads.get(id);
      // Only a newly opened sheet takes the iPad; a theme or picture update of
      // an already open sheet keeps its place among the windows.
      const sameSheet = existing?.sheet.id === sheet.id;
      if (!sameSheet) inks.delete(id);
      pads.set(id, { sheet, order: sameSheet ? existing.order : ++order, touchedAt: deps.now() });
      publish(activeWindow() === id);
      return { active: activeWindow() === id };
    }),
    ctx.handle("keep-pad", input => {
      assertActive();
      const id = windowId(fields(input, ["windowId"])), pad = pads.get(id);
      if (pad) pad.touchedAt = deps.now();
      return { open: !!pad, active: !!pad && activeWindow() === id };
    }),
    ctx.handle("clear-sheet", input => {
      assertActive();
      const body = fields(input, ["windowId", "sheet"]), id = windowId(body), sheet = sheetId(body), pad = pads.get(id);
      if (pad?.sheet.id !== sheet) return { cleared: false };
      const { drawing: _old, ...rest } = pad.sheet;
      pad.sheet = rest;
      inks.delete(id);
      if (activeWindow() === id) link.clear(sheet);
      return { cleared: true };
    }),
    ctx.handle("get-ink", input => {
      assertActive();
      const body = fields(input, ["windowId", "sheet"]), ink = inks.get(windowId(body));
      return ink?.sheet === sheetId(body) ? ink : null;
    }),
  ];
  const sweep = setInterval(() => {
    const limit = deps.now() - PAD_TTL_MS;
    let removed = false;
    for (const [id, pad] of pads) if (pad.touchedAt < limit) { pads.delete(id); inks.delete(id); removed = true; }
    if (removed) publish();
  }, deps.sweepMs ?? 5_000);
  sweep.unref?.();

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    clearInterval(sweep);
    for (const off of handlers) off();
    advertisement?.stop(); advertisement = undefined;
    pads.clear(); inks.clear();
    await listening.catch(() => {});
    await link.dispose();
  };
  ctx.signal.addEventListener("abort", () => { void dispose(); }, { once: true });
  await relisten();
  return dispose;
}
