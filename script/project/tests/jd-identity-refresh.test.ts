import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import { accountOrderTextIdentity } from "../services/account-order-text-identity";
import { parcelToShipment } from "../services/account-sync";
import { emptyState, saveState, loadState } from "../services/storage";
import { mergeAccountParcel, runShipmentRefreshForTesting } from "../services/sync";
import { saveOrderProjectionReferences, loadOrderProjectionReference } from "../services/routes";
import { performShipmentDeletion } from "../services/shipment-actions";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { selectShipmentDetailTimeline } from "../services/shipment-policy";
import { shouldRetryAccountOrderProjection } from "../services/account-sync-policy";

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
test("deleting another row preserves the projected JD owner's reusable page reference", () => {
  const state = seed();
  const owner = state.shipments[0];
  owner.identity = { ...owner.identity, projectedWaybill: WAYBILL };
  const other = { ...owner, identity: { ...owner.identity, id: "interface5:account:SYNTHETIC-OTHER" } };
  saveState({ ...state, shipments: [owner, other] }, Date.now());
  const before = loadOrderProjectionReference(owner.identity.id, "interface5");
  assert.ok(before);
  assert.equal(performShipmentDeletion(other.identity.id).ok, true);
  assert.equal(loadOrderProjectionReference(owner.identity.id, "interface5"), before);
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
test("detail entry publishes the order query's three nodes over an equal-time list summary", async () => {
  memory.clear();
  const tracks = [
    { timeText: "2026-09-08 12:00:00", detail: "正在打包", statusCode: "" },
    { timeText: "2026-09-08 11:59:00", detail: "等待出库", statusCode: "" },
    { timeText: "2026-09-08 11:58:00", detail: "已下单", statusCode: "" },
  ];
  const query: AccountParcelDto = { ...parcel(), semantic: "ORDERED", sourceStateCode: "101",
    sourceStateText: "已下单", normalizedStatusScope: "ORDER", normalizedStatusSemantic: "ORDERED",
    normalizedStatusText: "已下单", latestDetail: tracks[0].detail, tracks,
    textIdentity: accountOrderTextIdentity(tracks) };
  const owner = parcelToShipment({ ...query, tracks: tracks.slice(0, 1) }, [PHONE], NOW)!;
  saveState({ ...emptyState(), shipments: [owner], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 },
  ] }, NOW);
  let requests = 0;
  const result = await runShipmentRefreshForTesting(owner.identity.id,
    { isCurrent: () => true }, { trigger: "detail_open" }, {
      refreshAccountParcel: async () => { requests++; return query; },
      projectAccountOrderWithCarrier: async () => { assert.fail("entry query must retain its source-only boundary"); },
    });
  assert.equal(requests, 1);
  for (const current of [result.shipment, loadState().shipments[0]]) {
    const history = selectShipmentDetailTimeline(current);
    assert.equal(history.provider, "v5_query");
    assert.equal(history.tracks.length, 3);
    assert.equal(history.semantic, "ORDERED");
    assert.equal(current.identity.projectedWaybill, "");
    assert.equal(current.sourceTimeline!.tracks.length, 1);
  }
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

test("an interrupted identity capture retains its ten-minute cooldown after the attempt lease expires", async () => {
  const state = seed();
  const startedAt = Date.now();
  const controller = new AbortController();
  await assert.rejects(runShipmentRefreshForTesting(state.shipments[0].identity.id,
    { isCurrent: () => true, signal: controller.signal },
    { trigger: "identity_projection", forceAccountOrderProjection: true }, {
      projectAccountOrderWithCarrier: async input => {
        controller.abort();
        return input;
      },
    }));
  const retry = loadState(NOW).shipments[0].identity.orderProjectionRetry!;
  assert.ok(retry.failedAtMs! >= startedAt && retry.failedAtMs! <= Date.now());
  assert.equal(shouldRetryAccountOrderProjection(retry, retry.routeHash, retry.failedAtMs! + 23000), false);
  assert.equal(shouldRetryAccountOrderProjection(retry, retry.routeHash, retry.failedAtMs! + 600000), true);
});
test("HTTP 200 with the exact JD page risk message persists the hour cooldown", async () => {
  const state = seed();
  await runShipmentRefreshForTesting(state.shipments[0].identity.id, { isCurrent: () => true },
    { trigger: "identity_projection", forceAccountOrderProjection: true }, {
      projectAccountOrderWithCarrier: async (input, _deadline, _recognitionDeadline, diagnostics) => {
        diagnostics?.({ unionResponseStatuses: "200", riskControlSeen: true } as
          import("../services/account-order-projection").AccountOrderProjectionDiagnostics);
        return input;
      },
    });
  const retry = loadState().shipments[0].identity.orderProjectionRetry!;
  assert.ok(retry.riskControlAtMs);
  assert.equal(shouldRetryAccountOrderProjection(retry, retry.routeHash, retry.riskControlAtMs! + 600000), false);
  assert.equal(shouldRetryAccountOrderProjection(retry, retry.routeHash, retry.riskControlAtMs! + 3600000), true);
});
test("cancelling after observed JD risk control retains the hour cooldown without publishing identity", async () => {
  const state = seed(), controller = new AbortController();
  await assert.rejects(runShipmentRefreshForTesting(state.shipments[0].identity.id,
    { isCurrent: () => true, signal: controller.signal },
    { trigger: "identity_projection", forceAccountOrderProjection: true }, {
      projectAccountOrderWithCarrier: async (input, _deadline, _recognitionDeadline, diagnostics) => {
        diagnostics?.({ unionResponseStatuses: "403", riskControlSeen: true } as
          import("../services/account-order-projection").AccountOrderProjectionDiagnostics);
        controller.abort();
        return { ...input, waybill: WAYBILL };
      },
    }));
  const owner = loadState().shipments[0];
  assert.equal(owner.identity.projectedWaybill || "", "");
  const retry = owner.identity.orderProjectionRetry!;
  assert.ok(retry.riskControlAtMs);
  assert.equal(shouldRetryAccountOrderProjection(retry, retry.routeHash, retry.riskControlAtMs! + 600000), false);
});
test("a normal projection error commits risk and releases the attempt in its original transaction", async () => {
  const state = seed();
  const result = await runShipmentRefreshForTesting(state.shipments[0].identity.id,
    { isCurrent: () => true }, { trigger: "identity_projection", forceAccountOrderProjection: true }, {
      projectAccountOrderWithCarrier: async (_input, _deadline, _recognitionDeadline, diagnostics) => {
        diagnostics?.({ unionResponseStatuses: "403", riskControlSeen: true } as
          import("../services/account-order-projection").AccountOrderProjectionDiagnostics);
        throw new Error("Synthetic projection failure after risk response");
      },
    });
  const retry = loadState().shipments[0].identity.orderProjectionRetry!;
  assert.equal(result.refreshed, true);
  assert.ok(retry.riskControlAtMs);
  assert.equal(retry.attemptId, undefined);
});

test("an aborted old projection cannot add cooldown to a replacement attempt", async () => {
  const state = seed(), controller = new AbortController();
  await assert.rejects(runShipmentRefreshForTesting(state.shipments[0].identity.id,
    { isCurrent: () => true, signal: controller.signal },
    { trigger: "identity_projection", forceAccountOrderProjection: true }, {
      projectAccountOrderWithCarrier: async (input, _deadline, _recognitionDeadline, diagnostics) => {
        diagnostics?.({ unionResponseStatuses: "403", riskControlSeen: true } as
          import("../services/account-order-projection").AccountOrderProjectionDiagnostics);
        const current = loadState();
        const owner = current.shipments[0];
        saveState({ ...current, shipments: [{ ...owner, identity: { ...owner.identity,
          orderProjectionRetry: { ...owner.identity.orderProjectionRetry!, attemptId: "replacement-attempt" } } }] });
        controller.abort();
        return input;
      },
    }));
  const retry = loadState().shipments[0].identity.orderProjectionRetry!;
  assert.equal(retry.attemptId, "replacement-attempt");
  assert.equal(retry.riskControlAtMs, undefined);
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
    assert.equal(queries, trigger === "detail_open" ? 1 : 0,
      "only detail entry checks active JD account status; identity and pull do not add a query");
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
