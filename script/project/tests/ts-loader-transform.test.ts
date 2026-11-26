import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// R5-NEW-11 ⑧ (fifth review, 2026-11-25): Node 26 removed --experimental-transform-types. Without it Node only strips
// types and rejects the TypeScript-only syntax the sources use; the test loader then transforms the sources itself, and
// tools/test.sh passes the flag only to a Node that accepts it.
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A source with a parameter property (PlatformWireError), loaded by a child Node without the transform flag.
const output = execFileSync(process.execPath, [
  "--no-warnings", "--experimental-loader", resolve(projectDir, "tools/ts-loader.mjs"), "--input-type=module", "-e",
  "const { PlatformWireError } = await import('./services/platform-wire.ts');" +
    "console.log(JSON.stringify([process.features.typescript, new PlatformWireError('changed').reason]));",
], { cwd: projectDir, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
const [mode, reason] = JSON.parse(output.trim().split("\n").at(-1)!) as [unknown, string];
assert.notEqual(mode, "transform", "the child runs without Node's own transform");
assert.equal(reason, "changed", "the loader transforms a parameter property");

const script = readFileSync(resolve(projectDir, "tools/test.sh"), "utf8");
assert.match(script, /if node --experimental-transform-types -e "" >\/dev\/null 2>&1; then\s+TRANSFORM_TYPES="--experimental-transform-types"/,
  "the runner probes the flag before passing it");
assert.match(script, /--no-warnings \\\n\s+\$TRANSFORM_TYPES \\\n\s+--experimental-loader "\$PROJECT_DIR\/tools\/ts-loader.mjs"/);
const loop = script.slice(script.indexOf("for test_file in"));
assert.doesNotMatch(loop, /--experimental-transform-types/, "the test loop passes the flag only through the probe");

console.log("the test loader runs TypeScript sources without Node's transform flag");
