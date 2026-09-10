import assert from "node:assert/strict";
import { memory } from "./state-storage-mock";
import { diagnosticText, readDiagnostics, setDiagnosticsEnabled, writeDiagnostic } from "../services/logger";

for (const [sourceProvider, expected] of [
  ["CaiNiao", "cainiao"], ["JingDong", "jingdong"], ["ShunFeng", "sfexpress"],
  ["shunfeng", "sfexpress"], ["sfexpress", "sfexpress"], ["DouYin", "douyin"],
]) {
  memory.clear();
  setDiagnosticsEnabled(true);
  const identity = Object.freeze({ sourceProvider });
  writeDiagnostic("detail.refresh.started", identity);
  assert.equal(readDiagnostics()[0]?.details.sourceProvider, expected);
  assert.ok(diagnosticText().includes(`sourceProvider=${expected}`));
  assert.equal(identity.sourceProvider, sourceProvider, "log naming never rewrites business identity");
}
console.log("Automatic diagnostic source labels tests passed");
