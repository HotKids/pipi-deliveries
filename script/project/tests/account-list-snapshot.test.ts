import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import { parseAccountSyncResult } from "../services/account-parser";
import { accountParcelWithExistingProjection, parcelToShipment } from "../services/account-sync";
import {
  applyAccountShipment, applyTargetedAccountShipment, asAccountDetailObservation,
  foreignPackageAnchorMs, isForeignManualPackage,
} from "../services/shipment-policy";
import { emptyState, loadState, saveState } from "../services/storage";
import type { Shipment, TimelinePackage } from "../models";

const PHONE = "13800000000", ORDER = "9999000011112222", WAYBILL = "SF123456789012";
const at = (hours: number) => NOW + hours * 3600000;
const textTime = (hours: number) => new Date(at(hours) + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
const track = (hours: number, desc: string) => ({ time: textTime(hours), desc });
function parcel(details: ReturnType<typeof track>[], stateNum = 104) {
  return parseAccountSyncResult("interface5", { code: 0, data: { expressList: [{
    mailNo: ORDER, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE,
    stateNum, details,
  }] } }).parcels[0];
}
function first() {
  return applyAccountShipment(undefined, parcelToShipment(parcel([
    track(-2, `您的订单由第三方卖家拣货完成，待出库交付顺丰速运，运单号为${WAYBILL}`),
    track(-3, "已下单"),
  ]), [PHONE], NOW)!, NOW);
}
function accept(current: Shipment, details: ReturnType<typeof track>[], stateNum = 104) {
  const incoming = parcelToShipment(accountParcelWithExistingProjection(parcel(details, stateNum), [current]), [PHONE], NOW)!;
  return applyAccountShipment(current, incoming, NOW);
}
function persist(shipment: Shipment) {
  saveState({ ...emptyState(), shipments: [shipment], bindings: [{
    source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000,
  }], feedSlotRebuiltAtMs: NOW }, NOW);
  return loadState(NOW).shipments[0];
}

test("a fresh list replaces its snapshot and preserves the JD identity and foreign-package anchor after reload", () => {
  memory.clear();
  const original = first(), anchor = foreignPackageAnchorMs(original);
  const next = persist(accept(original, [track(-1, "New list event")], 105));
  assert.deepEqual(next.sourceTimeline?.tracks.map(node => node.detail), ["New list event"]);
  assert.equal(next.sourceTimeline?.semantic, "DELIVERY");
  assert.equal(next.sourceTimeline?.statusEventAtMs, at(-1));
  assert.equal(next.accountRecord?.updateTime, textTime(-1));
  assert.equal(next.accountRecord?.waybill, ORDER);
  assert.equal(next.identity.projectedWaybill, WAYBILL);
  assert.ok(anchor);
  assert.equal(foreignPackageAnchorMs(next), anchor);
  const foreign: TimelinePackage = { ...next.sourceTimeline!, provider: "k100_h5", waybill: WAYBILL,
    tracks: [{ timeMs: at(-30), timeText: textTime(-30), detail: "Foreign history", statusCode: "", raw: {} }] };
  assert.equal(isForeignManualPackage(next, foreign), true);
});

test("an older list cannot replace the latest snapshot or lower its state", () => {
  memory.clear();
  const latest = accept(first(), [track(-1, "New list event")], 105);
  const stale = persist(accept(latest, [track(-2, "Stale list event")], 104));
  assert.deepEqual(stale.sourceTimeline?.tracks.map(node => node.detail), ["New list event"]);
  assert.equal(stale.sourceTimeline?.semantic, "DELIVERY");
  assert.equal(stale.sourceTimeline?.latestTimeText, textTime(-1));
});

test("a JD list event advances its snapshot without requiring a status transition after projection", () => {
  memory.clear();
  const original = first();
  const dto = { ...parcel([track(-1, "Later JD order event")]), normalizedStatusScope: "ORDER" as const };
  const incoming = parcelToShipment(accountParcelWithExistingProjection(dto, [original]), [PHONE], NOW)!;
  const next = persist(applyAccountShipment(original, incoming, NOW));
  assert.deepEqual(next.sourceTimeline?.tracks.map(node => node.detail), ["Later JD order event"]);
  assert.equal(next.sourceTimeline?.semantic, "TRANSIT");
  assert.equal(next.identity.projectedWaybill, WAYBILL);
});

test("JD list advances extend the same account query while its raw snapshot remains separate", () => {
  memory.clear();
  let current = first();
  const query = (hours: number, description: string) => {
    const dto = { ...parcel([track(hours, description)]), waybill: WAYBILL };
    const incoming = parcelToShipment(dto, [PHONE], NOW)!;
    current = applyTargetedAccountShipment(current, asAccountDetailObservation(current, incoming), NOW);
  };
  query(-1.5, "Query event A");
  query(-1, "Query event B");
  const before = current.manualTimelines?.find(pack => pack.provider === "v5_query")!;
  assert.deepEqual(before.tracks.map(node => node.detail), ["Query event B", "Query event A"]);
  current = persist(accept(current, [track(-0.5, "Newest list event")], 105));
  assert.deepEqual(current.sourceTimeline?.tracks.map(node => node.detail), ["Newest list event"]);
  // User decision 2026-09-13: JD list increments continue the existing v5 query history.
  const after = current.manualTimelines?.find(pack => pack.provider === "v5_query")!;
  assert.deepEqual(after.tracks.map(node => node.detail), ["Newest list event", "Query event B", "Query event A"]);
  assert.deepEqual(after.tracks.slice(1), before.tracks);
  assert.equal(after.semantic, "DELIVERY");
  assert.equal(after.statusEventAtMs, at(-0.5));
});

test("first text projection preserves the order anchor while replacing its list snapshot", () => {
  memory.clear();
  const unresolved = applyAccountShipment(undefined,
    parcelToShipment(parcel([track(-3, "已下单")]), [PHONE], NOW)!, NOW);
  const anchor = foreignPackageAnchorMs(unresolved);
  assert.equal(unresolved.identity.projectedWaybill, "");
  const projected = accept(unresolved, [track(-2, `交付顺丰速运，运单号为${WAYBILL}`)]);
  assert.equal(projected.identity.projectedWaybill, WAYBILL);
  assert.equal(foreignPackageAnchorMs(projected), anchor);
  assert.equal(projected.automaticOwnership?.observations[0].sourceTimeline.listOriginAtMs, at(-3));
  const rolled = persist(accept(projected, [track(-1, "Later projected event")]));
  assert.equal(foreignPackageAnchorMs(rolled), anchor);
  assert.deepEqual(rolled.sourceTimeline?.tracks.map(node => node.detail), ["Later projected event"]);
});
