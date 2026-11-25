import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { PAD_TTL_MS } from "../src/backend.ts";
import { FakeIpad, newDevice, parsePairingUri, renderInk } from "../../tools/fake-ipad-lib.mjs";
import { PNG, WINDOW_A, WINDOW_B, fixture, sheet, sleep, until } from "./helpers.ts";

type Fixture = ReturnType<typeof fixture>;
interface Client { ipad: FakeIpad; pads: any[]; clears: any[]; closes: { code: number; error?: { code: string } }[]; device: { deviceId: string; deviceName: string }; deviceKey: string }
function client(name = "Test iPad"): Client {
  const self: Client = { pads: [], clears: [], closes: [], device: newDevice(name), deviceKey: "", ipad: undefined as unknown as FakeIpad };
  self.ipad = new FakeIpad({ onPad: (m: unknown) => self.pads.push(m), onClear: (m: unknown) => self.clears.push(m), onClose: (c: any) => self.closes.push(c) });
  return self;
}
async function pair(f: Fixture, name?: string): Promise<Client> {
  const c = client(name), status = await f.call("start-pairing");
  c.deviceKey = (await c.ipad.connect({ url: await f.url(), ...c.device, code: parsePairingUri(status.pairing.uri).code })).deviceKey;
  return c;
}
async function reconnect(f: Fixture, from: Client): Promise<Client> {
  const c = client(); c.device = from.device; c.deviceKey = from.deviceKey;
  await c.ipad.connect({ url: await f.url(), deviceId: c.device.deviceId, deviceKey: c.deviceKey });
  return c;
}
const stroke = (y: number): [number, number][] => Array.from({ length: 20 }, (_, i) => [100 + i * 5, y]);

it("announces itself and builds a pairing URI the client can read", async () => {
  const f = fixture(); try {
    await f.start();
    const idle = await f.call("get-status");
    assert.equal(idle.pairing, null); assert.equal(idle.error, null); assert.deepEqual(idle.devices, []);
    assert.deepEqual(f.advertised, [{ name: "Remote Draw (test-mac)", port: idle.port, serverId: idle.serverId }]);
    const status = await f.call("start-pairing"), parsed = parsePairingUri(status.pairing.uri);
    assert.deepEqual({ ...parsed, code: undefined }, { serverId: idle.serverId, name: "test-mac", port: idle.port, hosts: ["192.0.2.10", "100.64.0.7"], code: undefined });
    assert.equal(Buffer.from(parsed.code, "base64url").length, 32);
    assert.ok(status.pairing.expiresAt > Date.now());
    assert.equal((await f.call("cancel-pairing")).pairing, null);
  } finally { await f.close(); }
});
it("pairs once, remembers the device and reconnects with its key", async () => {
  const f = fixture(); try {
    await f.start();
    const first = await pair(f, "Study iPad");
    await until(() => first.pads.length === 1, "pad state");
    assert.deepEqual(first.pads[0], { type: "pad", open: false });
    let status = await f.call("get-status");
    assert.equal(status.pairing, null, "the code is single use");
    assert.deepEqual(status.devices.map((d: any) => [d.id, d.name, d.connected]), [[first.device.deviceId, "Study iPad", true]]);
    const saved = JSON.parse(fs.readFileSync(path.join(f.directory, "devices.json"), "utf8"));
    assert.equal(saved.devices[0].key, first.deviceKey, "both sides derived the same key");
    first.ipad.close();
    await until(() => f.call("get-status").devices[0].connected === false, "disconnect");
    await f.stop(); await f.start(); // A restart keeps the pairing.
    const again = await reconnect(f, first);
    await until(() => again.pads.length === 1, "pad state after reconnect");
    status = await f.call("get-status");
    assert.equal(status.devices[0].connected, true); assert.equal(status.serverId, saved.serverId);
    again.ipad.close();
  } finally { await f.close(); }
});
it("refuses wrong codes, used codes, unknown devices and wrong keys", async () => {
  const f = fixture(); try {
    await f.start();
    const url = await f.url(), unauthorized = (error: any) => error.error?.code === "unauthorized" && error.code === 4003;
    await assert.rejects(client().ipad.connect({ url, ...newDevice(), code: Buffer.alloc(32, 1).toString("base64url") }), unauthorized, "no pairing started");
    const status = await f.call("start-pairing"), code = parsePairingUri(status.pairing.uri).code;
    await assert.rejects(client().ipad.connect({ url, ...newDevice(), code: Buffer.alloc(32, 1).toString("base64url") }), unauthorized, "wrong code");
    const good = client(); good.deviceKey = (await good.ipad.connect({ url, ...good.device, code })).deviceKey;
    await assert.rejects(client().ipad.connect({ url, ...newDevice(), code }), unauthorized, "code reused");
    good.ipad.close();
    await until(() => f.call("get-status").devices[0].connected === false, "disconnect");
    await assert.rejects(client().ipad.connect({ url, deviceId: newDevice().deviceId, deviceKey: good.deviceKey }), unauthorized, "unknown device");
    await assert.rejects(client().ipad.connect({ url, deviceId: good.device.deviceId, deviceKey: Buffer.alloc(32, 9).toString("base64url") }), unauthorized, "wrong key");
    assert.equal(f.call("get-status").devices.length, 1);
  } finally { await f.close(); }
});
it("lets a pairing code expire", async () => {
  const f = fixture({ link: { host: "127.0.0.1", pairingTtlMs: 30 } }); try {
    await f.start();
    const code = parsePairingUri((await f.call("start-pairing")).pairing.uri).code;
    await until(() => f.call("get-status").pairing === null, "expiry");
    await assert.rejects(client().ipad.connect({ url: await f.url(), ...newDevice(), code }), (error: any) => error.error?.code === "unauthorized");
  } finally { await f.close(); }
});
it("allows one iPad at a time and replaces a device's own older connection", async () => {
  const f = fixture(); try {
    await f.start();
    const first = await pair(f, "First");
    const code = parsePairingUri((await f.call("start-pairing")).pairing.uri).code;
    await assert.rejects(client().ipad.connect({ url: await f.url(), ...newDevice(), code }), (error: any) => error.error?.code === "busy" && error.code === 4009);
    assert.notEqual(f.call("get-status").pairing, null, "a refused busy device does not use up the code");
    const again = await reconnect(f, first);
    await until(() => first.closes.length === 1, "old connection closed");
    assert.equal(first.closes[0]!.code, 4001);
    assert.equal(f.call("get-status").devices[0].connected, true);
    again.ipad.close();
    await until(() => f.call("get-status").devices[0].connected === false, "disconnect");
    const second = client("Second");
    second.deviceKey = (await second.ipad.connect({ url: await f.url(), ...second.device, code })).deviceKey;
    assert.deepEqual(f.call("get-status").devices.map((d: any) => [d.name, d.connected]), [["First", false], ["Second", true]]);
    second.ipad.close();
  } finally { await f.close(); }
});
it("drops a forgotten device at once and for good", async () => {
  const f = fixture(); try {
    await f.start();
    const c = await pair(f);
    assert.deepEqual((await f.call("forget-device", { deviceId: c.device.deviceId })).devices, []);
    await until(() => c.closes.length === 1, "closed");
    assert.equal(c.closes[0]!.code, 4010);
    await assert.rejects(reconnect(f, c), (error: any) => error.error?.code === "unauthorized");
  } finally { await f.close(); }
});
it("closes clients that send rubbish or never authenticate", async () => {
  const f = fixture({ link: { host: "127.0.0.1", handshakeTimeoutMs: 40 } }); try {
    await f.start();
    const closed = (socket: WebSocket) => new Promise<number>(resolve => socket.addEventListener("close", event => resolve(event.code)));
    const silent = new WebSocket(await f.url());
    assert.equal(await closed(silent), 4003);
    const early = new WebSocket(await f.url());
    early.addEventListener("message", () => early.send(JSON.stringify({ type: "ink", sheet: "s", through: 0, theme: "dark", drawing: "AAEC" })), { once: true });
    assert.equal(await closed(early), 4008);
    const c = await pair(f);
    c.ipad.send({ type: "preview", sheet: "s", stroke: 0 });
    await until(() => c.closes.length === 1, "closed after bad message");
    assert.equal(c.closes[0]!.code, 4008); assert.equal(c.closes[0]!.error!.code, "bad-message");
    const wrongPath = new WebSocket((await f.url()).replace("/remote-draw/v1", "/other"));
    await new Promise(resolve => wrongPath.addEventListener("error", resolve));
  } finally { await f.close(); }
});
it("sends the open sheet, relays previews and stores the latest ink", async () => {
  const f = fixture(); try {
    await f.start();
    const reference = { x: 1665, y: 200, width: 670, height: 300, png: PNG };
    assert.deepEqual(await f.call("set-pad", { windowId: WINDOW_A, sheet: sheet("s-1", { reference }) }), { active: true });
    const c = await pair(f);
    await until(() => c.pads.length === 1, "pad");
    assert.deepEqual(c.pads[0], { type: "pad", open: true, sheet: sheet("s-1", { reference }) });
    assert.equal(await f.call("get-ink", { windowId: WINDOW_A, sheet: "s-1" }), null);

    await c.ipad.drawStroke(stroke(700), { color: "#FF0000", width: 4, batch: 8 });
    await until(() => f.topic("ink-updated").length === 1, "ink");
    const previews = f.topic("preview");
    assert.deepEqual(previews.map(p => [p.windowId, p.sheet, p.stroke, p.color, p.width, p.points.length, p.end || p.cancelled]),
      [[WINDOW_A, "s-1", 1, "#ff0000", 4, 8, false], [WINDOW_A, "s-1", 1, "#ff0000", 4, 8, false], [WINDOW_A, "s-1", 1, "#ff0000", 4, 4, false], [WINDOW_A, "s-1", 1, "#ff0000", 4, 0, true]]);
    assert.deepEqual(previews.flatMap(p => p.points), stroke(700));
    assert.deepEqual(f.topic("ink-updated"), [{ windowId: WINDOW_A, sheet: "s-1", seq: 1 }]);
    const ink = await f.call("get-ink", { windowId: WINDOW_A, sheet: "s-1" });
    assert.deepEqual({ ...ink, drawing: undefined }, { sheet: "s-1", seq: 1, through: 1, theme: "dark", drawing: undefined, image: renderInk(c.ipad.strokes) });
    assert.deepEqual({ x: ink.image.x, y: ink.image.y, width: ink.image.width, height: ink.image.height }, { x: 98, y: 698, width: 99, height: 4 });
    assert.equal(await f.call("get-ink", { windowId: WINDOW_A, sheet: "other" }), null);
    assert.equal(await f.call("get-ink", { windowId: WINDOW_B, sheet: "s-1" }), null);

    // The stored drawing is what a reconnecting iPad gets back.
    c.ipad.close();
    await until(() => f.call("get-status").devices[0].connected === false, "disconnect");
    const again = await reconnect(f, c);
    await until(() => again.pads.length === 1, "pad after reconnect");
    assert.equal(again.pads[0].sheet.drawing, ink.drawing);
    // Having loaded it, the iPad renders it again for the desktop.
    await until(() => f.topic("ink-updated").length === 2, "ink after loading");
    assert.deepEqual((await f.call("get-ink", { windowId: WINDOW_A, sheet: "s-1" })).image, ink.image);

    // Undo back to nothing: an empty drawing has no image and nothing to restore.
    again.ipad.undo();
    await until(() => f.topic("ink-updated").length === 3, "empty ink");
    assert.deepEqual(await f.call("get-ink", { windowId: WINDOW_A, sheet: "s-1" }), { sheet: "s-1", seq: 3, through: 0, theme: "dark" });
    again.ipad.close();
    await until(() => f.call("get-status").devices[0].connected === false, "disconnect");
    const third = await reconnect(f, c);
    await until(() => third.pads.length === 1, "pad after second reconnect");
    assert.equal("drawing" in third.pads[0].sheet, false);
    third.ipad.close();
  } finally { await f.close(); }
});
it("ignores ink for a sheet that is no longer open", async () => {
  const f = fixture(); try {
    await f.start();
    await f.call("set-pad", { windowId: WINDOW_A, sheet: sheet("s-1") });
    const c = await pair(f);
    await until(() => c.pads.length === 1, "pad");
    c.ipad.send({ type: "ink", sheet: "stale", through: 0, theme: "dark", drawing: "AAEC", image: { x: 0, y: 0, width: 1, height: 1, png: PNG } });
    c.ipad.send({ type: "preview", sheet: "stale", stroke: 1, color: "#ffffff", width: 2, points: [[1, 1]], end: true });
    await c.ipad.drawStroke(stroke(10));
    await until(() => f.topic("ink-updated").length === 1, "ink");
    assert.ok(f.topic("preview").every(p => p.sheet === "s-1"));
    assert.equal(c.closes.length, 0, "a stale sheet is not an error");
    await f.call("set-pad", { windowId: WINDOW_A, sheet: null });
    await until(() => c.pads.length === 2, "pad closed");
    assert.deepEqual(c.pads[1], { type: "pad", open: false });
    c.ipad.send({ type: "ink", sheet: "s-1", through: 1, theme: "dark", drawing: "AAEC" });
    await sleep(40);
    assert.equal(f.topic("ink-updated").length, 1);
    assert.equal(await f.call("get-ink", { windowId: WINDOW_A, sheet: "s-1" }), null, "closing drops the relay copy");
    c.ipad.close();
  } finally { await f.close(); }
});
it("gives the iPad to the most recently opened pad", async () => {
  const f = fixture(); try {
    await f.start();
    const c = await pair(f);
    assert.deepEqual(await f.call("set-pad", { windowId: WINDOW_A, sheet: sheet("a-1") }), { active: true });
    assert.deepEqual(await f.call("set-pad", { windowId: WINDOW_B, sheet: sheet("b-1") }), { active: true });
    assert.deepEqual(await f.call("keep-pad", { windowId: WINDOW_A }), { open: true, active: false });
    assert.equal(f.call("get-status").activeWindow, WINDOW_B);
    // A theme update of the older pad must not take the iPad away from the newer one.
    assert.deepEqual(await f.call("set-pad", { windowId: WINDOW_A, sheet: sheet("a-1", { theme: "light", backgroundColor: "#ffffff" }) }), { active: false });
    await until(() => c.pads.length === 3, "pads");
    assert.deepEqual(c.pads.map(p => p.open && p.sheet.id), [false, "a-1", "b-1"]);
    await c.ipad.drawStroke(stroke(50));
    await until(() => f.topic("ink-updated").length === 1, "ink");
    assert.equal(f.topic("ink-updated")[0].windowId, WINDOW_B);
    // An update of the active pad is re-sent; closing it hands the iPad back.
    await f.call("set-pad", { windowId: WINDOW_B, sheet: sheet("b-1", { theme: "light", backgroundColor: "#ffffff" }) });
    await f.call("set-pad", { windowId: WINDOW_B, sheet: null });
    await until(() => c.pads.length === 5, "handover");
    assert.deepEqual(c.pads.slice(3).map(p => [p.sheet.id, p.sheet.theme]), [["b-1", "light"], ["a-1", "light"]]);
    assert.deepEqual(await f.call("keep-pad", { windowId: WINDOW_B }), { open: false, active: false });
    // Opening a new sheet in the older window takes the iPad again.
    await f.call("set-pad", { windowId: WINDOW_B, sheet: sheet("b-2") });
    assert.deepEqual(await f.call("set-pad", { windowId: WINDOW_A, sheet: sheet("a-2") }), { active: true });
    c.ipad.close();
  } finally { await f.close(); }
});
it("clears a sheet on the iPad and forgets its stored drawing", async () => {
  const f = fixture(); try {
    await f.start();
    await f.call("set-pad", { windowId: WINDOW_A, sheet: sheet("s-1") });
    const c = await pair(f);
    await until(() => c.pads.length === 1, "pad");
    await c.ipad.drawStroke(stroke(10));
    await until(() => f.topic("ink-updated").length === 1, "ink");
    assert.deepEqual(await f.call("clear-sheet", { windowId: WINDOW_A, sheet: "other" }), { cleared: false });
    assert.deepEqual(await f.call("clear-sheet", { windowId: WINDOW_A, sheet: "s-1" }), { cleared: true });
    await until(() => c.clears.length === 1, "clear");
    assert.deepEqual(c.clears[0], { type: "clear", sheet: "s-1" });
    assert.deepEqual(c.ipad.strokes, []);
    // The iPad confirms with an empty drawing, which settles any stroke that was on its way.
    await until(() => f.topic("ink-updated").length === 2, "confirmation");
    assert.deepEqual(await f.call("get-ink", { windowId: WINDOW_A, sheet: "s-1" }), { sheet: "s-1", seq: 2, through: 1, theme: "dark" });
    c.ipad.close();
    await until(() => f.call("get-status").devices[0].connected === false, "disconnect");
    const again = await reconnect(f, c);
    await until(() => again.pads.length === 1, "pad after reconnect");
    assert.equal("drawing" in again.pads[0].sheet, false);
    again.ipad.close();
  } finally { await f.close(); }
});
it("releases the pad of a window that stopped confirming it", async () => {
  const f = fixture(); try {
    await f.start();
    const c = await pair(f);
    await f.call("set-pad", { windowId: WINDOW_A, sheet: sheet("a-1") });
    await f.call("set-pad", { windowId: WINDOW_B, sheet: sheet("b-1") });
    f.advance(PAD_TTL_MS - 1000);
    await f.call("keep-pad", { windowId: WINDOW_A });
    f.advance(2000);
    await until(() => f.call("get-status").activeWindow === WINDOW_A, "window B expired");
    await until(() => c.pads.at(-1)?.sheet?.id === "a-1", "handover");
    f.advance(PAD_TTL_MS + 1);
    await until(() => f.call("get-status").activeWindow === null, "window A expired");
    await until(() => c.pads.at(-1)?.open === false, "no pad");
    c.ipad.close();
  } finally { await f.close(); }
});
it("changes settings, moves the port and reports a port that is taken", async () => {
  const f = fixture(); try {
    await f.start();
    const before = await f.call("get-settings");
    assert.deepEqual(await f.call("set-image-scale", { imageScale: 25 }), { ...before, revision: 1, imageScale: 25 });
    assert.deepEqual(await f.call("set-image-scale", { imageScale: 25 }), { ...before, revision: 1, imageScale: 25 });
    assert.equal(f.topic("settings-changed").length, 1);
    assert.throws(() => f.call("set-image-scale", { imageScale: 0 }));
    await assert.rejects(async () => f.call("set-port", { port: 80 }));
    const c = await pair(f), port = before.port === 41234 ? 41235 : 41234;
    assert.equal((await f.call("set-port", { port })).port, port);
    await until(() => c.closes.length === 1, "old port closed");
    const status = await f.call("get-status");
    assert.equal(status.port, port); assert.equal(status.error, null);
    assert.deepEqual(f.advertised.map(a => a.port), [before.port, port]); assert.equal(f.stops, 1);
    (await reconnect(f, c)).ipad.close();

    const other = fixture(); try {
      fs.mkdirSync(other.directory, { recursive: true });
      fs.writeFileSync(path.join(other.directory, "settings.json"), JSON.stringify({ revision: 0, imageScale: 50, port }));
      await other.start();
      const taken = await other.call("get-status");
      assert.equal(taken.port, null); assert.match(taken.error, /already in use/); assert.deepEqual(other.advertised, []);
      assert.throws(() => other.call("start-pairing"), /already in use/);
    } finally { await other.close(); }
  } finally { await f.close(); }
});
it("stops everything when disabled", async () => {
  const f = fixture(); try {
    await f.start();
    const c = await pair(f), url = await f.url(), count = f.events.length;
    await f.stop();
    await until(() => c.closes.length === 1, "closed");
    assert.equal(f.handlers.size, 0); assert.equal(f.stops, 1);
    await assert.rejects(client().ipad.connect({ url, deviceId: c.device.deviceId, deviceKey: c.deviceKey }));
    assert.equal(f.events.length, count, "nothing is emitted after disposal");
  } finally { await f.close(); }
});
it("reports accepted practice problems and nothing for other sessions", async () => {
  const f = fixture(); try {
    await f.start();
    f.records.set("practice-1", { kind: "practice", messages: [
      { role: "assistant", id: "m1", content: [{ type: "toolCall", id: "t1", name: "problem" }] },
      { role: "toolResult", toolCallId: "t1", toolName: "problem" }] });
    f.records.set("teaching-1", { kind: "teaching", messages: [] });
    const poses = await f.call("get-session-poses", { sessionId: "practice-1" });
    assert.equal(poses.sessionId, "practice-1"); assert.equal(poses.poses.length, 1);
    assert.deepEqual(await f.call("get-session-poses", { sessionId: "teaching-1" }), { sessionId: "teaching-1", poses: [] });
    assert.deepEqual(await f.call("get-session-poses", { sessionId: "missing" }), { sessionId: "missing", poses: [] });
    assert.throws(() => f.call("get-session-poses", { sessionId: "../x" }));
  } finally { await f.close(); }
});
