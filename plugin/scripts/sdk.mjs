/** Generate the type-only LearnHarness plugin API into .sdk/ from a source
 * checkout. Usage: npm run sdk -- [path to learnharness checkout]
 * (default: $LEARNHARNESS_CHECKOUT, then ~/projects/learnharness). */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const checkout = path.resolve(process.argv[2] ?? process.env.LEARNHARNESS_CHECKOUT ?? path.join(os.homedir(), "projects/learnharness"));
const script = path.join(checkout, "scripts/build-plugin-types.mjs");
if (!fs.existsSync(script)) throw new Error(`No LearnHarness checkout at ${checkout}. Pass its path as an argument.`);
const output = path.join(root, ".sdk");
fs.rmSync(output, { recursive: true, force: true });
const result = spawnSync(process.execPath, [script, output], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
