import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Shipment } from "../models";
import {
  needsProjectedCarrierRepair,
  repairProjectedShipmentCarrier,
} from "../services/account-carrier-normalization";

const identity = (overrides: Partial<Shipment["identity"]>): Shipment["identity"] => ({
  id: "interface5:account:3610448002878202", bindingSource: "interface5",
  sourceOwner: "interface5:order", sourceId: "3610448002878202", phoneTail: "1515",
  courierCode: "JD", companyName: "京东快递", sourceProvider: "JingDong",
  orderId: "3610448002878202", projectedWaybill: "JT4006839564547", accountOrder: true,
  manuallyAdded: false, createdAtMs: 1,
  ...overrides,
});

// Only a projected non-JD waybill still labelled as JD (or unlabelled) needs the repair.
assert.equal(needsProjectedCarrierRepair(identity({})), true);
assert.equal(needsProjectedCarrierRepair(identity({ courierCode: "JDKD" })), true);
assert.equal(needsProjectedCarrierRepair(identity({ courierCode: "" })), true);
assert.equal(needsProjectedCarrierRepair(identity({ courierCode: "JTSD" })), false);
assert.equal(needsProjectedCarrierRepair(identity({ projectedWaybill: "JDVD10645984010" })), false);
assert.equal(needsProjectedCarrierRepair(identity({ projectedWaybill: "" })), false);
assert.equal(needsProjectedCarrierRepair(identity({ accountOrder: false })), false);

const timeline = {
  provider: "interface5", waybill: "JT4006839564547", courierCode: "JD", companyName: "京东快递",
  semantic: "PICKED", statusEventAtMs: 1, latestTimeText: "2026-09-03 17:48:00",
  latestDetail: "已取件", tracks: [], successAtMs: 1,
} as Shipment["timeline"];
// A kuaidi100_h5 package carries the carrier detected when it was grabbed. The detail sheet reads
// identity, but this package still sits in the chain, so the repair has to retag it as well —
// otherwise the leaked JD order-stage carrier survives the repair inside stored packages.
const manualPackage = { ...timeline, provider: "kuaidi100_h5" } as Shipment["timeline"];
const shipment: Shipment = {
  identity: identity({}), timeline, sourceTimeline: timeline, manualTimelines: [manualPackage],
  route: null, updatedAtMs: 1,
  automaticOwnership: {
    ownerSource: "interface5", ownerBindingIdentity: "b", claimedAtMs: 1, lastTakeoverAtMs: 0,
    ownerMisses: 0, takeoverPending: false,
    observations: [{ source: "interface5", bindingIdentity: "b", observedAtMs: 1, identity: identity({}), sourceTimeline: timeline }],
  },
} as unknown as Shipment;
const repaired = repairProjectedShipmentCarrier(shipment, {
  standardCode: "JTSD", displayName: "极兔速递", kuaidi100Code: "jtexpress", isBuiltIn: true, tableVersion: "t1",
});
assert.equal(repaired.identity.courierCode, "JTSD");
assert.equal(repaired.identity.companyName, "极兔速递");
assert.equal(repaired.identity.rawCourierCode, "");
assert.equal(repaired.timeline.courierCode, "JTSD");
assert.equal(repaired.sourceTimeline?.companyName, "极兔速递");
assert.equal(repaired.automaticOwnership?.observations[0]?.identity.courierCode, "JTSD");
assert.equal(repaired.automaticOwnership?.observations[0]?.sourceTimeline.courierCode, "JTSD");
assert.equal(repaired.manualTimelines?.[0]?.courierCode, "JTSD");
assert.equal(repaired.manualTimelines?.[0]?.companyName, "极兔速递");
assert.equal(repaired.manualTimelines?.[0]?.provider, "kuaidi100_h5");
// Recognition that only re-states JD, or nothing built-in, changes nothing.
assert.equal(repairProjectedShipmentCarrier(shipment, { standardCode: "JD", displayName: "京东快递", kuaidi100Code: "jd", isBuiltIn: true, tableVersion: "t1" }), shipment);
assert.equal(repairProjectedShipmentCarrier(shipment, null), shipment);

// Wiring contract: the detail refresh recognises up front, never rewrites `base` (the commit
// fence compares base's copy of the shipment with storage — a rewritten base is always
// "state_changed"), and re-applies the repair right before the commit fingerprint check.
const syncSource = readFileSync(new URL("../services/sync.ts", import.meta.url), "utf8");
const refreshById = syncSource.slice(
  syncSource.indexOf("async function runShipmentRefreshById"),
  syncSource.indexOf("export function refreshShipmentById"),
);
const repairBlock = refreshById.slice(
  refreshById.indexOf("if (needsProjectedCarrierRepair(original.identity))"),
  refreshById.indexOf("detail.refresh.carrier_repaired"),
);
assert.ok(repairBlock.includes("carrierRepair = recognition.normalization"));
assert.ok(!repairBlock.includes("base = {"));
const finalRepair = refreshById.indexOf(
  "if (carrierRepair && needsProjectedCarrierRepair(refreshed.identity))",
);
assert.ok(finalRepair > 0);
assert.ok(finalRepair < refreshById.indexOf("const commit = commitTargetShipmentRefresh("));

console.log("account carrier repair tests passed");
