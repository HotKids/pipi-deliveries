import assert from "node:assert/strict";
import { RefreshCoordinator } from "../services/refresh-coordination";
const coordinator = new RefreshCoordinator<string, string, string, string>();
let resolveFull!: (value: string) => void;
const full = coordinator.runFull("v5", () => new Promise(resolve => { resolveFull = resolve; }));
await new Promise(resolve => setImmediate(resolve));
for (const mode of ["detail_open", "detail_pull"]) {
  let calls = 0;
  const result = await coordinator.runIndependentDetail(`unknown:${mode}`, "v5", async () => {
    calls++; return mode;
  }, Date.now() + 1000);
  assert.equal(result, mode);
  assert.equal(calls, 1, "a list round cannot stand in for a mode-specific missing-status request");
}
resolveFull("list");
assert.equal(await full, "list");
console.log("detail status work remains independent of a concurrent list round");
