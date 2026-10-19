import assert from "node:assert/strict";
import test from "node:test";
import { memory, NOW, sha256 } from "./state-storage-mock";
import type { Shipment } from "../models";
import { parseAccountSyncResponse } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { applyAccountShipment } from "../services/shipment-policy";
import { replayPendingShipmentNotifications } from "../services/notifications";
import { commitRefreshState, emptyState, loadState, loadWidgetSnapshot, saveState,
  visibleShipments, storedShipmentsForProcessing } from "../services/storage";

const PHONE = "13800002121";
const ORDER = "351100064421";
const scheduled: string[] = [];
Date.now = () => NOW;
Object.assign(Data, { fromFile: () => null });
Object.assign(globalThis, {
  Notification: { schedule: async () => { scheduled.push("sent"); } },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
});

function order(id = ORDER, stateNum = 107): Shipment {
  const parcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [{
    mailNo: id, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE, stateNum,
    details: [{ time: "2026-09-08 12:00:00", desc: stateNum === 107 ? `您的订单${id}已完成` : "运输途中" }],
  }] } })[0]!;
  return applyAccountShipment(undefined, parcelToShipment(parcel, [PHONE], NOW)!, NOW);
}

function state(row: Shipment) {
  return { ...emptyState(), shipments: [row],
    bindings: [{ source: "interface5" as const, phone: PHONE, boundAtMs: NOW - 86400000 }],
    feedSlotRebuiltAtMs: NOW };
}

test("a completed 3-prefixed 12-digit JD placeholder hides without an empty-page marker", () => {
  memory.clear();
  const row = order();
  saveState(state(row), NOW);
  assert.equal(visibleShipments(loadState(), NOW).length, 0);
  assert.equal(loadWidgetSnapshot(NOW).rows.length, 0);
  assert.equal(loadState().shipments.length, 1, "visibility does not delete the order");
  assert.equal(storedShipmentsForProcessing(loadState(), NOW).length, 1, "projection and alignment keep processing the row");
});

for (const id of ["461100064421", "3500000000044421", "35110006442", "３５１１０００６４４２１"]) {
  test(`the new rule does not widen the approved order-number shape: ${id}`, () => {
    const row = order();
    row.identity.orderId = id;
    row.identity.sourceId = id;
    assert.equal(visibleShipments(state(row), NOW).length, 1);
  });
}

for (const kind of ["manual", "carrier-row", "other-platform", "unstructured", "in-transit"]) {
  test(`all conditions are required: ${kind}`, () => {
    const row = order();
    if (kind === "manual") row.identity.manuallyAdded = true;
    if (kind === "carrier-row") row.identity.accountOrder = false;
    if (kind === "other-platform") row.identity.sourceProvider = "CaiNiao";
    if (kind === "unstructured") {
      row.timeline = { ...row.timeline, structuredStatus: false, normalizedStatus: undefined };
      row.sourceTimeline = row.timeline;
    }
    if (kind === "in-transit") return assert.equal(visibleShipments(state(order(ORDER, 104)), NOW).length, 1);
    assert.equal(visibleShipments(state(row), NOW).length, 1);
  });
}

for (const waybill of ["JD000000044421", "YT000000044421", "351234567890"]) {
  for (const evidence of ["projected", "pending", "history", "observation", "feed-text"]) {
    test(`saved ${evidence} protects a real waybill independent of format: ${waybill}`, () => {
      const row = order();
      if (evidence === "projected") row.identity.projectedWaybill = waybill;
      if (evidence === "pending") row.identity.pendingProjection = { waybill, capturedAtMs: NOW };
      if (evidence === "history") row.manualTimelines = [{ ...row.timeline, waybill, provider: "jd_h5" }];
      if (evidence === "observation") row.automaticOwnership = {
        ownerSource: "v5", ownerBindingIdentity: "synthetic", claimedAtMs: NOW,
        lastTakeoverAtMs: 0, ownerMisses: 0, takeoverPending: false, observations: [{
          source: "v5", bindingIdentity: "old", bindingValid: false, observedAtMs: NOW - 86400000,
          identity: { ...row.identity, projectedWaybill: waybill }, sourceTimeline: row.timeline,
        }],
      };
      if (evidence === "feed-text") row.sourceTimeline = { ...row.timeline, tracks: [{
        ...row.timeline.tracks[0]!, detail: `已交付承运商，运单号为${waybill}`,
      }] };
      assert.equal(visibleShipments(state(row), NOW).length, 1);
    });
  }
}

test("new and queued notifications stay hidden while the row remains stored", async () => {
  memory.clear(); scheduled.length = 0;
  saveState(state(order(ORDER, 104)), NOW);
  const before = loadState();
  const next = commitRefreshState(before, { ...before, shipments: [order()] }, "interface5", NOW).state;
  assert.equal(next.pendingNotifications?.length || 0, 0);
  saveState({ ...next, pendingNotifications: [{ id: "queued-before-hide", shipmentId: order().identity.id,
    semantic: "COMPLETED", title: "Synthetic order", body: "Synthetic event", iconName: "" }] }, NOW);
  await replayPendingShipmentNotifications();
  assert.deepEqual(scheduled, []);
  assert.equal(loadState().pendingNotifications?.length || 0, 0);
  assert.equal(loadState().shipments.length, 1);
});

for (const id of ["311100064421", "391100064421"]) {
  test(`the approved prefix includes every 3-prefixed order: ${id}`, () => {
    assert.equal(visibleShipments(state(order(id)), NOW).length, 0);
  });
}

test("a saved association survives packet replacement and state reload", () => {
  memory.clear();
  const row = order();
  row.manualTimelines = [{ ...row.timeline, waybill: "YT000000044421", provider: "jd_h5" }];
  saveState(state(row), NOW);
  assert.equal(loadState().shipments[0]?.identity.hadRealWaybill, true);
  saveState(state(order()), NOW + 1);
  assert.equal(loadState().shipments[0]?.identity.hadRealWaybill, true);
  assert.equal(visibleShipments(loadState(), NOW + 1).length, 1);
});

test("startup backfills a saved association before its old packet is removed", () => {
  memory.clear();
  const row = order();
  row.identity.pendingProjection = { waybill: "351234567890", capturedAtMs: NOW };
  const legacy = state(row);
  memory.set("pipi_deliveries_state_v1", {
    schema: 2, checksum: sha256(JSON.stringify(legacy)), state: legacy,
  });
  assert.equal(loadState().shipments[0]?.identity.hadRealWaybill, true);
  saveState(state(order()), NOW + 1);
  assert.equal(visibleShipments(loadState(), NOW + 1).length, 1);
});

test("unlabelled numbers in ordinary text never establish a waybill", () => {
  const row = order();
  row.sourceTimeline = { ...row.timeline, tracks: [{
    ...row.timeline.tracks[0]!, detail: "配送员留言351234567890，请评价本次购物",
  }] };
  assert.equal(visibleShipments(state(row), NOW).length, 0);
});
