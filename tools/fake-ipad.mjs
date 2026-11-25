#!/usr/bin/env node
/** Plays the iPad against a running Remote Draw plugin.
 *
 *   node tools/fake-ipad.mjs pair '<remotedraw://pair?... from the QR code>'
 *   node tools/fake-ipad.mjs run [--host 192.168.1.5] [--strokes 3]
 *
 * Pairing is remembered in .fake-ipad.json in the current directory. `run`
 * draws a few squiggles under the question whenever a new sheet opens. */
import fs from "node:fs";
import { FakeIpad, newDevice, parsePairingUri } from "./fake-ipad-lib.mjs";

const STATE = ".fake-ipad.json";
const [command, ...rest] = process.argv.slice(2);
const option = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i < 0 ? fallback : rest[i + 1]; };
const url = (state, host = state.hosts[0] ?? "127.0.0.1") => `ws://${host}:${state.port}/remote-draw/v1`;

if (command === "pair" && rest[0]) {
  const pairing = parsePairingUri(rest[0]), device = newDevice();
  const state = { ...device, serverId: pairing.serverId, name: pairing.name, port: pairing.port, hosts: pairing.hosts };
  const ipad = new FakeIpad();
  const { deviceKey } = await ipad.connect({ url: url(state, option("host")), ...device, code: pairing.code });
  fs.writeFileSync(STATE, JSON.stringify({ ...state, deviceKey }, null, 2) + "\n", { mode: 0o600 });
  console.log(`Paired with ${pairing.name}. Saved ${STATE}.`);
  ipad.close();
} else if (command === "run") {
  if (!fs.existsSync(STATE)) throw new Error(`No ${STATE} here. Run the pair command first.`);
  const state = JSON.parse(fs.readFileSync(STATE, "utf8")), count = Number(option("strokes", 3));
  let drawnFor;
  const ipad = new FakeIpad({
    onClear: () => console.log("Desktop cleared the sheet."),
    onClose: ({ code, error }) => { console.log(`Disconnected (${code})${error ? `: ${error.message}` : ""}`); process.exit(error ? 1 : 0); },
    async onPad(message) {
      if (!message.open) return console.log("No pad open on the desktop.");
      const { id, theme, reference } = message.sheet;
      console.log(`Pad open: sheet ${id}, ${theme} theme, ${reference ? "with" : "no"} question picture.`);
      if (drawnFor === id) return ipad.sendInk(); // Same sheet again, e.g. a theme change: render anew.
      drawnFor = id;
      const left = reference ? reference.x : 1700, top = reference ? reference.y + reference.height + 40 : 1900;
      for (let n = 0; n < count && ipad.sheet?.id === id; n++) {
        const points = Array.from({ length: 60 }, (_, i) => [left + i * 6, top + n * 50 + Math.sin(i / 4) * 16]);
        await ipad.drawStroke(points, { color: theme === "dark" ? "#ffffff" : "#000000", delayMs: 33 });
        console.log(`Stroke ${n + 1} sent.`);
      }
    },
  });
  await ipad.connect({ url: url(state, option("host")), deviceId: state.deviceId, deviceKey: state.deviceKey });
  console.log(`Connected to ${state.name}. Ctrl+C to stop.`);
} else {
  console.log("Usage:\n  node tools/fake-ipad.mjs pair '<pairing URI>' [--host <address>]\n  node tools/fake-ipad.mjs run [--host <address>] [--strokes <n>]");
  process.exit(command ? 1 : 0);
}
