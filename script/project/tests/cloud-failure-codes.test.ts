import assert from "node:assert/strict";
import "./state-storage-mock";
import { GatewayError, gatewayErrorCode } from "../services/gateway";
import { classifyDiagnosticError, diagnosticErrorDetails, SAFE_FAILURE_CODES } from "../services/logger";
import { PlatformWireError } from "../services/platform-wire";

// R5-NEW-07 ③ (fifth review, 2026-11-25): a failed cloud.sync line keeps the Worker's cloud-record answer as its
// failure code, and a parcel provider's own failure reads in a category instead of 「未知原因」.
const CLOUD_CODES = [
  "cloud_sync_disabled",
  "cloud_metadata_not_granted",
  "cloud_snapshot_changed",
  "invalid_cloud_record_identity",
  "cloud_record_storage_unavailable",
  "cloud_record_retention_pending",
];
for (const code of CLOUD_CODES) {
  assert.equal(gatewayErrorCode(JSON.stringify({ error: code })), code, `the gateway keeps ${code}`);
  assert.ok(SAFE_FAILURE_CODES.has(code), `the log keeps ${code}`);
  assert.equal(diagnosticErrorDetails(new GatewayError("denied", 403, code)).failureCode, code,
    `a failed cloud line carries ${code}`);
}

for (const [reason, category] of [
  ["expired", "authorization"],
  ["verification", "authorization"],
  ["unavailable", "service"],
  ["changed", "validation"],
] as const) {
  const error = new PlatformWireError(reason);
  assert.equal(classifyDiagnosticError(error), category, `a provider ${reason} reads as ${category}`);
  assert.equal(diagnosticErrorDetails(error).errorCategory, category);
}
// Other errors keep their categories.
assert.equal(classifyDiagnosticError(new Error("Synthetic")), "unknown");
assert.equal(classifyDiagnosticError(new GatewayError("busy", 429)), "rate_limited");

console.log("cloud failure codes and provider failure categories pass");
