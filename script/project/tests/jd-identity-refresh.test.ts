import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import { accountOrderTextIdentity } from "../services/account-order-text-identity";
import { parcelToShipment } from "../services/account-sync";
import { emptyState, saveState, loadState } from "../services/storage";
import { mergeAccountParcel, runShipmentRefreshForTesting } from "../services/sync";
import { saveOrderProjectionReferences } from "../services/routes";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { selectShipmentDetailTimeline } from "../services/shipment-policy";

const PHONE = "13800001234", ORDER = "3610000000001844", WAYBILL = "75600000001844";
const TEXT = `您的订单由第三方卖家拣货完成，待出库交付中通快递，运单号为 ${WAYBILL}`;
function parcel(text = false): AccountParcelDto {
  const tracks = [{ timeText: "2026-09-08 12:00:00", detail: "已揽收", statusCode: "" },
    { timeText: "2026-09-08 11:00:00", detail: text ? TEXT : "正在打包", statusCode: "" }];
  return { source: "interface5", ownerId: ORDER, waybill: ORDER, orderId: ORDER,
    accountOrder: true, courierCode: "JDKD", rawCourierCode: "JDKD", companyName: "京东购物",
    sourceProvider: "JingDong", sourceStateCode: "104", sourceStateText: "运输中", semantic: "TRANSIT",
    normalizedStatusScope: "SHIPMENT", normalizedStatusSemantic: "TRANSIT", normalizedStatusText: "运输中",
    receiverPhone: PHONE, senderPhone: "", latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail,
    tracks, routeUrl: "", projectionUrl: "https://u.jd.com/forward?test=identity",
    textIdentity: accountOrderTextIdentity(tracks) };
}
function seed(text = false) {
  memory.clear();
  const row = parcelToShipment(parcel(false), [PHONE], NOW)!;
  if (text) {
    row.sourceTimeline = { ...row.sourceTimeline!, tracks: row.sourceTimeline!.tracks.map((t, i) =>
      i === 1 ? { ...t, detail: TEXT } : t) };
    row.timeline = row.sourceTimeline;
  }
  const state = saveState({ ...emptyState(), shipments: [row], bindings: [
    {source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000},
  ] }, NOW);
  saveOrderProjectionReferences([{ownerId: row.identity.id, source: "interface5", url: parcel().projectionUrl}], NOW);
  return state;
}
test("list merge applies text identity without a page or cooldown", () => {
  const state = seed();
  const merged = mergeAccountParcel(state, state.shipments, parcel(true), [PHONE], "interface5", NOW, new Map());
  assert.equal(merged[0].identity.projectedWaybill, WAYBILL);
  assert.equal(merged[0].identity.courierCode, "ZTO");
  assert.equal(merged[0].accountRecord?.waybill, ORDER);
  assert.equal(merged[0].identity.jingDongH5Retry, undefined);
});
test("text identity ignores returned status and never replaces an established waybill", () => {
  for (const semantic of ["ORDERED", "UNKNOWN", "COMPLETED"] as const) {
    const input = {...parcel(true), semantic, normalizedStatusSemantic: semantic};
    assert.equal(parcelToShipment(input, [PHONE], NOW)!.identity.projectedWaybill, WAYBILL);
    assert.equal(parcelToShipment({...input, waybill: "OTHER000001844"}, [PHONE], NOW)!
      .identity.projectedWaybill, "OTHER000001844");
  }
});
test("text received by the entry query is applied without opening H5", async () => {
  const state = seed();
  // A real latest-node conflict makes the entry query due without relying on prose classification.
  state.shipments[0].sourceTimeline!.tracks[0].statusCode = "103";
  saveState(state, NOW);
  const result = await runShipmentRefreshForTesting(state.shipments[0].identity.id,
    {isCurrent: () => true}, {trigger: "detail_open"}, {
      refreshAccountParcel: async () => parcel(true),
      projectAccountOrderWithCarrier: async () => { assert.fail("query text already resolved identity"); },
    });
  assert.equal(result.shipment.identity.projectedWaybill, WAYBILL);
});
test("failed identity capture retains the order and its existing cooldown", async () => {
  const state = seed(); let captures = 0;
  const runtime = {projectAccountOrderWithCarrier: async (input: AccountParcelDto) => {captures++; return input;}};
  const first = await runShipmentRefreshForTesting(state.shipments[0].identity.id, {isCurrent: () => true},
    {trigger: "identity_projection", forceAccountOrderProjection: true}, runtime);
  assert.equal(first.shipment.identity.projectedWaybill, "");
  assert.ok(first.shipment.identity.orderProjectionRetry?.failedAtMs);
  await runShipmentRefreshForTesting(first.shipment.identity.id, {isCurrent: () => true},
    {trigger: "detail_open"}, {...runtime, refreshAccountParcel: async () => parcel()});
  assert.equal(captures, 1);
});
test("opening old cached text repairs identity without H5", async () => {
  const state = seed(true);
  const result = await runShipmentRefreshForTesting(state.shipments[0].identity.id,
    {isCurrent: () => true}, {trigger: "detail_open"}, {
      refreshAccountParcel: async () => null,
      projectAccountOrderWithCarrier: async () => { assert.fail("text identity needs no H5"); },
    });
  assert.equal(result.shipment.identity.projectedWaybill, WAYBILL);
  assert.equal(loadState().shipments[0].identity.projectedWaybill, WAYBILL);
});
test("entry stage diagnostics count the same package as their displayed provider", async () => {
  const state = seed(true);
  const row = state.shipments[0];
  row.sourceTimeline!.tracks[0].statusCode = "103";
  const tracks = [...row.timeline.tracks, ...Array.from({ length: 6 }, (_, index) => ({
    timeText: `2026-09-08 0${index + 1}:00:00`, timeMs: NOW - (10 - index) * 3600000,
    detail: `Synthetic earlier node ${index}`, statusCode: "", raw: {},
  }))];
  tracks[0].statusCode = "103";
  row.manualTimelines = [{ ...row.timeline, provider: "v5_query", tracks }];
  saveState(state, NOW);
  setDiagnosticsEnabled(true);
  try {
    const result = await runShipmentRefreshForTesting(row.identity.id, {isCurrent: () => true},
      {trigger: "detail_open"}, {refreshAccountParcel: async () => parcel(true)});
    assert.equal(selectShipmentDetailTimeline(result.shipment).tracks.length, 8);
    for (const event of ["detail.refresh.stage_started", "detail.refresh.stage_succeeded"]) {
      const details = readDiagnostics().find(entry => entry.event === event)!.details;
      assert.equal(details.displayTimelineProvider, event.endsWith("started") ? "v5_list" : "v5_query");
      assert.equal(details.effectiveTrackCount, event.endsWith("started") ? 2 : 8,
        "the pre-projection order query cannot be labelled as the real-waybill query before it is confirmed");
    }
  } finally {
    setDiagnosticsEnabled(false);
  }
});
for (const trigger of ["identity_projection", "detail_pull", "detail_open"] as const) {
  test(`${trigger} obtains identity despite cached pickup and timed query history`, async () => {
    const state = seed(); let queries = 0, captures = 0;
    const runtime = {
      refreshAccountParcel: async () => { queries++; return parcel(); },
      projectAccountOrderWithCarrier: async (input: AccountParcelDto) => {
        captures++;
        return {...input, waybill: WAYBILL, courierCode: "ZTO", rawCourierCode: "", companyName: "中通快递"};
      },
      refreshWebTimeline: async () => { assert.fail("identity does not request primary H5"); },
      queryManualForSource: async () => { assert.fail("identity does not request manual providers"); },
    };
    const result = await runShipmentRefreshForTesting(state.shipments[0].identity.id,
      {isCurrent: () => true}, {trigger, forceAccountOrderProjection: true}, runtime);
    assert.equal(result.shipment.identity.projectedWaybill, WAYBILL);
    assert.equal(captures, 1);
    assert.equal(queries, 0);
    await runShipmentRefreshForTesting(result.shipment.identity.id, {isCurrent: () => true},
      {trigger: "identity_projection", forceAccountOrderProjection: true}, runtime);
    assert.equal(captures, 1, "a resolved identity must not reopen H5");
  });
}

for (const detail of ["已下单", "正在打包", "等待揽收", "预计明天送达"]) {
  test(`detail entry acquires missing identity for ${detail}`, async () => {
    const state = seed();
    const row = state.shipments[0];
    row.timeline = row.sourceTimeline = {...row.sourceTimeline!, semantic: "ORDERED",
      tracks: [{...row.sourceTimeline!.tracks[0], detail, statusCode: "", raw: {}}]};
    saveState(state, NOW);
    const result = await runShipmentRefreshForTesting(row.identity.id,
      {isCurrent: () => true}, {trigger: "identity_projection", forceAccountOrderProjection: true}, {
        refreshAccountParcel: async () => { assert.fail("missing identity enters the original projection path"); },
        projectAccountOrderWithCarrier: async input => ({...input, waybill: WAYBILL, courierCode: "ZTO"}),
      });
    assert.equal(result.shipment.identity.projectedWaybill, WAYBILL);
  });
}
