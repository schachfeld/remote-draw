/** Runs the plugin's background service without LearnHarness and plays the app
 * window, so the iPad app can be tried against the real server code.
 *
 *   npx tsx scripts/dev-desktop.ts [--port 47610] [--out <folder for received PNGs>]
 *
 * Commands on stdin: pair | open [light|dark] | new | close | clear | theme <light|dark> | status | quit
 * Pairings are kept in plugin/.dev-desktop/. */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import { encodePng } from "../../tools/fake-ipad-lib.mjs";

const option = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]!; };
const root = fileURLToPath(new URL("../.dev-desktop/", import.meta.url));
const out = path.resolve(option("out", path.join(root, "received")));
const port = Number(option("port", "47610"));
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ revision: 0, imageScale: 50, port }));

const handlers = new Map<string, (input: unknown) => unknown>();
const controller = new AbortController();
const windowId = "dev-window-1";
let sheetNumber = 0, theme: "light" | "dark" = "dark", open = false, previews = 0;
const call = async (name: string, input?: unknown): Promise<any> => handlers.get(name)!(input);

/** A stand-in question picture: a framed block with a few "text" lines. */
function reference(dark: boolean) {
  const width = 670, height = 160, scale = 2, w = width * scale, h = height * scale, pixels = Buffer.alloc(w * h * 4);
  const paper = dark ? [44, 44, 46] : [242, 242, 247], line = dark ? [174, 174, 178] : [99, 99, 102];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const border = x < 4 || y < 4 || x >= w - 4 || y >= h - 4;
    const text = [60, 130, 200].some(top => y >= top && y < top + 28) && x >= 40 && x < w - (y > 190 ? 500 : 80);
    pixels.set([...(border || text ? line : paper), 255], (y * w + x) * 4);
  }
  return { x: (4000 - width) / 2, y: 200, width, height, png: encodePng(w, h, pixels).toString("base64") };
}
const sheet = (drawing?: string) => ({ id: `${windowId}_${sheetNumber}`, theme, backgroundColor: theme === "dark" ? "#1c1c1e" : "#ffffff",
  reference: reference(theme === "dark"), ...(drawing ? { drawing } : {}) });
let drawing: string | undefined;
async function setPad() {
  const result = await call("set-pad", { windowId, sheet: open ? sheet(drawing) : null });
  console.log(open ? `Pad open: sheet ${windowId}_${sheetNumber}, ${theme}${drawing ? ", with stored drawing" : ""}.` : "Pad closed.", JSON.stringify(result));
}

const ctx = { dataDirectory: root, signal: controller.signal,
  handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => { handlers.delete(name); }; },
  events: { emit(topic: string, data: any) {
    if (topic === "preview") {
      previews++;
      if (data.end) { console.log(`Preview: stroke ${data.stroke} ended${data.cancelled ? " (cancelled)" : ""} after ${previews} messages, colour ${data.color}, width ${data.width}.`); previews = 0; }
      else if (previews === 1) console.log(`Preview: stroke ${data.stroke} started at ${JSON.stringify(data.points[0])}.`);
    } else if (topic === "ink-updated") void call("get-ink", { windowId, sheet: data.sheet }).then(ink => {
      if (!ink) return;
      drawing = ink.drawing;
      if (!ink.image) return console.log(`Ink #${ink.seq}: empty drawing (through ${ink.through}).`);
      const file = path.join(out, `ink-${ink.seq}-${ink.theme}.png`), png = Buffer.from(ink.image.png, "base64");
      fs.writeFileSync(file, png);
      const { x, y, width, height } = ink.image;
      console.log(`Ink #${ink.seq}: through ${ink.through}, ${ink.theme}, at ${x},${y} size ${width}x${height}, PNG ${png.readUInt32BE(16)}x${png.readUInt32BE(20)} px, ` +
        `${png.length} bytes, drawing ${Buffer.from(ink.drawing, "base64").length} bytes -> ${file}`);
    });
    else if (topic === "status-changed") {
      const devices = data.devices.map((d: any) => `${d.name}${d.connected ? " (connected)" : ""}`).join(", ") || "none";
      console.log(`Status: port ${data.port}, devices: ${devices}${data.error ? `, error: ${data.error}` : ""}${data.discoveryError ? `, Bonjour: ${data.discoveryError}` : ""}`);
    }
  } },
  learning: { getSession() { return null; } },
} as unknown as PluginBackendContext;

const dispose = await activate(ctx);
setInterval(() => { void call("keep-pad", { windowId }); }, 10_000).unref();
console.log(`Remote Draw dev desktop on port ${port}. Commands: pair | open [light|dark] | new | close | clear | theme <light|dark> | status | quit`);

for await (const line of readline.createInterface({ input: process.stdin })) {
  const [command, argument] = line.trim().split(/\s+/);
  try {
    if (command === "pair") console.log((await call("start-pairing")).pairing.uri);
    else if (command === "open" || command === "new") {
      if (argument === "light" || argument === "dark") theme = argument;
      if (command === "new" || !sheetNumber) { sheetNumber++; drawing = undefined; }
      open = true; await setPad();
    } else if (command === "close") { open = false; await setPad(); }
    else if (command === "clear") { drawing = undefined; console.log(JSON.stringify(await call("clear-sheet", { windowId, sheet: `${windowId}_${sheetNumber}` }))); }
    else if (command === "theme" && (argument === "light" || argument === "dark")) { theme = argument; if (open) await setPad(); }
    else if (command === "status") console.log(JSON.stringify(await call("get-status"), null, 2));
    else if (command === "quit") break;
    else if (command) console.log("Unknown command.");
  } catch (error) { console.log(`Failed: ${error instanceof Error ? error.message : error}`); }
}
await dispose();
process.exit(0);
