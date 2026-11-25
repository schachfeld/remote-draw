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
const common = { absWorkingDir: root, bundle: true, target: "es2022", minify: true, legalComments: "eof", metafile: true };
const frontend = await build({ ...common, entryPoints: ["src/main.ts"], outfile: path.join(output, "main.js"), format: "esm", platform: "browser" });
const backend = await build({
  ...common, entryPoints: ["src/backend.ts"], outfile: path.join(output, "backend.cjs"), format: "cjs", platform: "node",
  // Optional native accelerators of `ws`; it falls back to JavaScript without them.
  external: ["bufferutil", "utf-8-validate"],
});
const packages = new Set();
for (const result of [frontend, backend]) for (const input of Object.keys(result.metafile.inputs)) {
  if (input.startsWith("node_modules/")) packages.add(input.split("/").slice(1, input.startsWith("node_modules/@") ? 3 : 2).join("/"));
  else if (!input.startsWith("src/")) throw new Error(`Unexpected runtime input: ${input}`);
}
for (const file of ["manifest.json", "README.md", "LICENSE", "THIRD-PARTY.md"]) fs.copyFileSync(path.join(root, file), path.join(output, file));
fs.copyFileSync(path.join(root, "src/styles.css"), path.join(output, "styles.css"));
// Every bundled package ships its licence; a package without one fails the build.
fs.mkdirSync(path.join(output, "licenses"));
for (const name of [...packages].sort()) {
  const directory = path.join(root, "node_modules", name), target = `${name.replace("/", "__")}-LICENSE`;
  const shipped = fs.readdirSync(directory).find(file => /^licen[cs]e(\.|$)/i.test(file));
  // licenses/ holds the text for packages that publish none.
  const source = shipped ? path.join(directory, shipped) : path.join(root, "licenses", target);
  if (!fs.existsSync(source)) throw new Error(`Bundled package ${name} has no licence file. Add licenses/${target}.`);
  fs.copyFileSync(source, path.join(output, "licenses", target));
}
console.log(`Built Remote Draw plugin: ${output}\nBundled packages: ${[...packages].sort().join(", ")}`);
