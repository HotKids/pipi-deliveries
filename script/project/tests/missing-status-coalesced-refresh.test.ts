import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../services/sync.ts", import.meta.url), "utf8");
const callback = source.match(/const reuseFullRefresh = async \(summary: RefreshSummary\) => \{([\s\S]*?)\n  \};/)?.[1];
assert.ok(callback);
for (const trigger of ["detail_open", "detail_pull"]) {
  for (const semantic of ["UNKNOWN", "COMPLETED"]) {
    for (const detailSemantic of ["UNKNOWN", "COMPLETED"]) {
      let calls = 0;
      const current = { identity: { id: "synthetic" }, updatedAtMs: 2, semantic };
      const context = {
        refreshOptions: { trigger }, trigger, shipmentId: "synthetic", source: "interface5",
        shipment: { updatedAtMs: 1 },
        assertRefreshSignal() {}, writeDiagnostic() {}, diagnosticState: () => ({}),
        unprojectedAccountOrder: () => false,
        selectShipmentTimeline: (value: typeof current) => value,
        selectShipmentDetailTimeline: () => ({ semantic: detailSemantic }),
        runTargetedShipmentRefreshWithProjectionWait: async () => { calls++; return { shipment: current }; },
      };
      const run = runInNewContext(stripTypeScriptTypes(`async function reuse(summary: any) {${callback}}\nreuse;`), context);
      await run({ state: { shipments: [current] } });
      assert.equal(calls, semantic === "UNKNOWN" ? 1 : 0,
        "a coalesced full refresh must still fulfill an explicit unresolved-status query");
    }
  }
}
console.log("Missing status after coalesced full refresh partitions passed");
