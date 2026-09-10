import assert from "node:assert/strict";
import { memory } from "./state-storage-mock";
import { queryMeizuShipment } from "../services/manual-query";
import { diagnosticText, readDiagnostics, setDiagnosticsEnabled, writeDiagnostic } from "../services/logger";

memory.clear();
setDiagnosticsEnabled(true);
const waybill = "SF123456789012";
const withheld = "synthetic_private_response";
const payloads: Record<string, unknown>[] = [];
let requests = 0;
await queryMeizuShipment({ waybill, rawCourierCode: "SF", diagnosticFlowId: "picker-metadata-test",
  dependencies: { post: async (_route, payload) => {
    payloads.push(payload);
    requests++;
    return requests === 1
      ? { code: "503", msg: withheld, value: {}, redirect: `https://example.invalid/${withheld}` }
      : { code: 200, msg: withheld, value: JSON.stringify({ nu: waybill, com: "SF", state: "2",
        time: "2026-09-09 23:00:00", context: withheld }), redirect: "" };
  } },
});
assert.equal(requests, 2, "diagnostics must preserve the existing retry count");
assert.deepEqual(payloads[0], payloads[1], "diagnostics must not alter the retried request");
const attempts = () => readDiagnostics().filter(entry => entry.event === "manual.meizu.response").reverse();
assert.equal(attempts().length, 2);
assert.deepEqual(attempts().map(({ details }) => ({ attempt: details.attempt, mode: details.mode,
  upstreamCode: details.upstreamCode, valueKind: details.valueKind, redirectPresent: details.redirectPresent })), [
  { attempt: 1, mode: "refresh", upstreamCode: 503, valueKind: "object", redirectPresent: true },
  { attempt: 2, mode: "refresh", upstreamCode: 200, valueKind: "string", redirectPresent: false },
]);
for (const { details } of attempts()) {
  assert.equal(details.flowId, "picker-metadata-test");
  assert.ok(Number.isFinite(details.durationMs) && details.durationMs! >= 0);
}
assert.equal(diagnosticText().includes(withheld), false);
assert.equal(diagnosticText().includes(waybill), false);
assert.equal(diagnosticText().includes("https"), false);

memory.delete("pipi_deliveries_diagnostic_log_v1");
const transport = Object.assign(new Error(withheld), { status: 403 });
await assert.rejects(queryMeizuShipment({ waybill, dependencies: { post: async () => { throw transport; } } }),
  error => error === transport, "transport errors retain their existing HTTP metadata and are not retried");
assert.equal(attempts().length, 1);
assert.equal(attempts()[0]!.details.mode, "refresh");
assert.equal(attempts()[0]!.details.valueKind, "missing");
assert.equal(attempts()[0]!.details.upstreamCode, undefined);

memory.delete("pipi_deliveries_diagnostic_log_v1");
writeDiagnostic("manual.meizu.response", { attempt: 2, mode: "last_detail", upstreamCode: -1001,
  valueKind: "array", redirectPresent: false });
assert.equal(attempts()[0]!.details.upstreamCode, -1001, "negative integer business codes remain diagnostic");
for (const unsafe of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, "200", withheld]) {
  memory.delete("pipi_deliveries_diagnostic_log_v1");
  writeDiagnostic("manual.meizu.response", { attempt: 3, mode: withheld, upstreamCode: unsafe,
    valueKind: withheld, redirectPresent: withheld, msg: withheld, value: withheld, redirect: withheld } as never);
  assert.deepEqual(attempts()[0]!.details, {}, "only bounded attempt/mode/type/code/boolean metadata is retained");
}
console.log("Meizu response metadata diagnostics tests passed");
