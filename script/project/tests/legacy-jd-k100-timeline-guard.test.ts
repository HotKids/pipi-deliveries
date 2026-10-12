import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Audit C13 (adopted 2026-09-25, "删除，或加守卫防止重新被调用"): `queryKuaidi100JdTimeline` calls the
// free autoComNum directly and bypasses the per-waybill recognition memory. It has no production
// caller; this guard keeps it that way. Only its own module and its tests may name it.
const root = fileURLToPath(new URL("..", import.meta.url));
const offenders: string[] = [];
function walk(directory: string): void {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const rel = relative(root, path);
    if (statSync(path).isDirectory()) {
      if (rel === "tests" || rel === "node_modules" || rel === "assets") continue;
      walk(path);
      continue;
    }
    if (!/\.(ts|tsx|mjs|js)$/.test(name) || rel === join("services", "kuaidi100-h5.ts")) continue;
    if (readFileSync(path, "utf8").includes("queryKuaidi100JdTimeline")) offenders.push(rel);
  }
}
walk(root);
assert.deepEqual(offenders, [], "no production module may call queryKuaidi100JdTimeline");

console.log("legacy JD Kuaidi100 timeline guard passed");
