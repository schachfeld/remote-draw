import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
try {
  if (fs.lstatSync(output).isSymbolicLink()) throw new Error("Refusing to build into a symlinked dist directory.");
  try { fs.lstatSync(path.join(output, "data")); throw new Error("Refusing to build over dist/data; preserve plugin data outside dist first."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
} catch (error) { if (error.code !== "ENOENT") throw error; }
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const backend = await build({
  absWorkingDir: root, bundle: true, target: "es2022", minify: true, legalComments: "eof", metafile: true,
  entryPoints: ["src/backend.ts"], outfile: path.join(output, "backend.cjs"), format: "cjs", platform: "node",
  // Optional native accelerators of `ws`; it falls back to JavaScript without them.
  external: ["bufferutil", "utf-8-validate"],
});
for (const input of Object.keys(backend.metafile.inputs)) {
  if (!input.startsWith("src/") && !input.startsWith("node_modules/")) throw new Error(`Unexpected runtime input: ${input}`);
}
fs.copyFileSync(path.join(root, "manifest.json"), path.join(output, "manifest.json"));
console.log(`Built Remote Draw plugin: ${output}`);
