import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, parseSettings, parseSettingsChange } from "../src/store.ts";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "remote-draw-store-"));
const device = (id: string) => ({ id, name: "iPad", key: Buffer.alloc(32, 1), pairedAt: "2026-11-25T10:00:00.000Z" });

it("starts with defaults and writes nothing until asked", () => {
  const root = temp(), directory = path.join(root, "data");
  try {
    const store = new Store(directory);
    assert.deepEqual(store.settings, { revision: 0, imageScale: 50, port: 47600 });
    assert.deepEqual(store.devices, []); assert.equal(fs.existsSync(directory), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
it("keeps the server ID and devices across restarts", () => {
  const root = temp();
  try {
    const first = new Store(root);
    first.ensureServerId(); first.saveDevice(device("device-one")); first.saveDevice(device("device-two"));
    first.saveDevice({ ...device("device-one"), name: "Renamed" });
    const second = new Store(root);
    assert.equal(second.serverId, first.serverId);
    assert.deepEqual(second.devices.map(d => [d.id, d.name]), [["device-two", "iPad"], ["device-one", "Renamed"]]);
    assert.deepEqual(second.device("device-one")!.key, Buffer.alloc(32, 1));
    assert.equal(second.removeDevice("device-two"), true); assert.equal(second.removeDevice("device-two"), false);
    assert.deepEqual(new Store(root).devices.map(d => d.id), ["device-one"]);
    assert.equal(fs.statSync(path.join(root, "devices.json")).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(root).sort(), ["devices.json"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
it("saves settings one field at a time and ignores unchanged values", () => {
  const root = temp();
  try {
    const store = new Store(root), before = store.settings;
    assert.equal(store.change({ port: 47600 }), before);
    assert.deepEqual(store.change({ port: 5000 }), { revision: 1, imageScale: 50, port: 5000 });
    assert.deepEqual(new Store(root).change({ imageScale: 25 }), { revision: 2, imageScale: 25, port: 5000 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
it("refuses damaged files instead of replacing them", () => {
  const root = temp();
  try {
    fs.writeFileSync(path.join(root, "devices.json"), "{broken");
    assert.throws(() => new Store(root));
    fs.writeFileSync(path.join(root, "devices.json"), JSON.stringify({ serverId: "x", devices: [] }));
    assert.throws(() => new Store(root));
    assert.equal(fs.readFileSync(path.join(root, "devices.json"), "utf8"), JSON.stringify({ serverId: "x", devices: [] }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
it("validates settings", () => {
  for (const value of [{ revision: 0, imageScale: 0, port: 47600 }, { revision: 0, imageScale: 50, port: 80 }, { revision: -1, imageScale: 50, port: 47600 },
    { revision: 0, imageScale: 50, port: 47600, extra: 1 }, { revision: 0, imageScale: 50 }, null]) assert.throws(() => parseSettings(value));
  assert.equal(parseSettingsChange({ port: 1024 }, "port"), 1024);
  assert.equal(parseSettingsChange({ imageScale: 100 }, "imageScale"), 100);
  for (const value of [{ port: 1023 }, { port: 65536 }, { port: 5000.5 }, { port: "5000" }, { port: 5000, imageScale: 50 }, {}])
    assert.throws(() => parseSettingsChange(value, "port"));
  for (const value of [{ imageScale: 0 }, { imageScale: 101 }, { imageScale: NaN }]) assert.throws(() => parseSettingsChange(value, "imageScale"));
});
