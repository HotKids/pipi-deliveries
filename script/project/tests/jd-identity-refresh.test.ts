import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW, sha256 } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import { accountOrderTextIdentity } from "../services/account-order-text-identity";
import { parcelToShipment } from "../services/account-sync";
import { emptyState, saveState, loadState } from "../services/storage";
import { mergeAccountParcel, runShipmentRefreshForTesting, runProjectionAwareShipmentRefreshForTesting, projectStoredAccountOrders, hasActiveAccountOrderProjection } from "../services/sync";
import { OperationTimeoutError } from "../services/deadline";
import { saveOrderProjectionReferences, loadOrderProjectionReference } from "../services/routes";
import { performShipmentDeletion } from "../services/shipment-actions";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { selectShipmentDetailTimeline } from "../services/shipment-policy";
import { shouldRetryAccountOrderProjection } from "../services/account-sync-policy";
import { registerProjectionViewportHost } from "../services/projection-viewport";
import { seedRecognizedCarriers } from "./carrier-recognition-seed";

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
// T23 (user 2026-09-26, 其余裁决 28): a text waybill is projected only once recognition matched its carrier. The cases
// below start from the recognizer's answer — 圆通, deliberately not the 中通 the text names (其余裁决 7) — unless
// `recognized` is false.
function seed(text = false, recognized = true) {
  memory.clear();
  if (recognized) seedRecognizedCarriers({ [WAYBILL]: "YTO" }, NOW);
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
  // 其余裁决 7 (2026-09-26): the text's 「交付中通快递」 is not carrier evidence; the carrier is the recognizer's answer,
  // which the list sync runs before this merge (old expectation, before T23: an empty carrier).
  assert.equal(merged[0].identity.courierCode, "YTO");
  assert.equal(merged[0].identity.companyName, "圆通速递");
  assert.equal(merged[0].accountRecord?.waybill, ORDER);
  assert.equal(merged[0].identity.jingDongH5Retry, undefined);
  // T23: with no carrier matched yet the order stays as it is — no waybill, no empty carrier, still no page or cooldown.
  const held = seed(false, false);
  const unmatched = mergeAccountParcel(held, held.shipments, parcel(true), [PHONE], "interface5", NOW, new Map());
  assert.equal(unmatched[0].identity.projectedWaybill, "");
  assert.equal(unmatched[0].identity.companyName, "京东购物");
  assert.equal(unmatched[0].identity.orderProjectionRetry, undefined);
  assert.equal(unmatched[0].identity.jingDongH5Retry, undefined);
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
  seed();
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

test("a separate detail pull immediately retries a timed-out identity capture", async () => {
  const state = seed();
  let captures = 0;
  const runtime = {
    projectAccountOrderWithCarrier: async (input: AccountParcelDto) => {
      captures++;
      if (captures === 1) throw new OperationTimeoutError("Synthetic identity timeout");
      return { ...input, waybill: WAYBILL, courierCode: "ZTO", rawCourierCode: "", companyName: "中通快递" };
    },
    refreshWebTimeline: async () => null,
    queryManualForSource: async () => ({ shipment: null, pending: null, routeUrl: "" }),
  };
  const failed = await runShipmentRefreshForTesting(state.shipments[0].identity.id,
    { isCurrent: () => true }, { trigger: "identity_projection", forceAccountOrderProjection: true }, runtime);
  assert.equal(failed.shipment.identity.projectedWaybill, "");
  assert.ok(failed.shipment.identity.orderProjectionRetry?.failedAtMs);
  assert.equal(failed.shipment.identity.orderProjectionRetry?.riskControlAtMs, undefined);
  const result = await runShipmentRefreshForTesting(failed.shipment.identity.id,
    { isCurrent: () => true }, { trigger: "detail_pull", forceAccountOrderProjection: true,
      forceManualRefresh: true }, runtime);
  assert.equal(captures, 2, "a new user gesture may retry ordinary timeout without ten minutes of waiting");
  assert.equal(result.shipment.identity.projectedWaybill, WAYBILL);
});

for (const trigger of ["detail_open", "identity_projection", "status_alignment"] as const) {
  test(`${trigger} retains ordinary identity cooldown even with force options`, async () => {
    const state = seed();
    let captures = 0;
    const runtime = {
      refreshAccountParcel: async () => parcel(),
      projectAccountOrderWithCarrier: async () => {
        captures++;
        throw new OperationTimeoutError("Synthetic identity timeout");
      },
      refreshWebTimeline: async () => null,
      queryManualForSource: async () => ({ shipment: null, pending: null, routeUrl: "" }),
    };
    await runShipmentRefreshForTesting(state.shipments[0].identity.id,
      { isCurrent: () => true }, { trigger: "identity_projection", forceAccountOrderProjection: true }, runtime);
    await runShipmentRefreshForTesting(state.shipments[0].identity.id,
      { isCurrent: () => true }, { trigger, forceAccountOrderProjection: true, forceManualRefresh: true }, runtime);
    assert.equal(captures, 1, "force flags do not turn automatic entry into a user pull");
    assert.equal(loadState().shipments[0].identity.projectedWaybill, "");
  });
}

for (const risk of ["403", "message"] as const) {
  test(`a detail pull preserves the hour after JD ${risk} risk control`, async () => {
    const realNow = Date.now;
    let clock = NOW;
    Date.now = () => clock;
    try {
      const state = seed();
      let captures = 0;
      const runtime = {
        projectAccountOrderWithCarrier: async (input: AccountParcelDto, _deadline: unknown,
          _recognitionDeadline: unknown, diagnostics?: (value: any) => void) => {
          captures++;
          diagnostics?.({ unionResponseStatuses: risk === "403" ? "403" : "200", riskControlSeen: risk === "message" });
          return input;
        },
        refreshWebTimeline: async () => null,
        queryManualForSource: async () => ({ shipment: null, pending: null, routeUrl: "" }),
      };
      await runShipmentRefreshForTesting(state.shipments[0].identity.id,
        { isCurrent: () => true }, { trigger: "identity_projection", forceAccountOrderProjection: true }, runtime);
      clock += 59 * 60_000;
      const result = await runShipmentRefreshForTesting(state.shipments[0].identity.id,
        { isCurrent: () => true }, { trigger: "detail_pull", forceAccountOrderProjection: true,
          forceManualRefresh: true }, runtime);
      assert.equal(captures, 1, "ordinary cooldown bypass never removes the last minute of JD risk protection");
      assert.equal(result.expressToast, "jdRiskControl");
      assert.equal(result.expressToastRemainingMs, 60_000);
      clock += 60_000;
      await runShipmentRefreshForTesting(state.shipments[0].identity.id,
        { isCurrent: () => true }, { trigger: "detail_pull", forceAccountOrderProjection: true,
          forceManualRefresh: true }, runtime);
      assert.equal(captures, 2, "the next independent pull may try once the whole hour has elapsed");
    } finally {
      Date.now = realNow;
    }
  });
}

for (const succeeds of [false, true]) {
  test(`a pull reuses an in-flight identity capture without appending after ${succeeds ? "success" : "timeout"}`, async () => {
    const state = seed();
    const owner = state.shipments[0];
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    let started!: () => void;
    const starting = new Promise<void>(resolve => { started = resolve; });
    let captures = 0;
    const runtime = {
      projectAccountOrderWithCarrier: async (input: AccountParcelDto) => {
        captures++;
        started();
        await gate;
        if (!succeeds) throw new OperationTimeoutError("Synthetic in-flight identity timeout");
        return { ...input, waybill: WAYBILL, courierCode: "ZTO", rawCourierCode: "", companyName: "中通快递" };
      },
      refreshWebTimeline: async () => null,
      queryManualForSource: async () => ({ shipment: null, pending: null, routeUrl: "" }),
    };
    const first = runProjectionAwareShipmentRefreshForTesting(owner.identity.id,
      { trigger: "identity_projection", forceAccountOrderProjection: true }, runtime);
    await starting;
    let pullFinished = false;
    const pulled = runProjectionAwareShipmentRefreshForTesting(owner.identity.id,
      { trigger: "detail_pull", forceAccountOrderProjection: true, forceManualRefresh: true }, runtime)
      .then(result => { pullFinished = true; return result; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const completedBeforeCapture = pullFinished;
    open();
    await Promise.all([first, pulled]);
    assert.equal(completedBeforeCapture, false, "the pull waits for the capture it reused");
    assert.equal(captures, 1, "one gesture does not queue a second capture after the first result");
    assert.equal(loadState().shipments[0].identity.projectedWaybill || "", succeeds ? WAYBILL : "");
  });
}

for (const waitExpires of [false, true]) {
  test(`an expired reservation ${waitExpires ? "ends bounded waiting without another capture" : "still joins its live local capture"}`, async () => {
    const realNow = Date.now;
    let clock = NOW;
    Date.now = () => clock;
    let open!: () => void;
    let firstSettled: Promise<unknown> | undefined;
    try {
      const state = seed();
      const owner = state.shipments[0];
      const gate = new Promise<void>(resolve => { open = resolve; });
      let started!: () => void;
      const starting = new Promise<void>(resolve => { started = resolve; });
      let captures = 0;
      const runtime = {
        projectAccountOrderWithCarrier: async () => {
          captures++;
          started();
          await gate;
          throw new OperationTimeoutError("Synthetic capture settled after reservation expiry");
        },
        refreshWebTimeline: async () => null,
        queryManualForSource: async () => ({ shipment: null, pending: null, routeUrl: "" }),
      };
      firstSettled = runProjectionAwareShipmentRefreshForTesting(owner.identity.id,
        { trigger: "identity_projection", forceAccountOrderProjection: true }, runtime)
        .then(result => result, error => error);
      await starting;
      clock += 23_000;
      const retry = loadState().shipments[0].identity.orderProjectionRetry!;
      assert.ok(retry.attemptExpiresAtMs! < clock, "the 22-second durable reservation has expired");
      let pullFinished = false;
      const pulled = runProjectionAwareShipmentRefreshForTesting(owner.identity.id,
        { trigger: "detail_pull", forceAccountOrderProjection: true, forceManualRefresh: true,
          deadlineAtMs: clock + 5_000 }, runtime)
        .then(result => { pullFinished = true; return result; });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(pullFinished, false, "the live local promise outlasts its reservation");
      if (waitExpires) {
        clock += 6_000;
        const result = await pulled;
        assert.equal(result.refreshed, false);
        assert.equal(captures, 1, "the caller's waiting deadline cannot start a replacement capture");
        assert.equal(pullFinished, true);
      }
      open();
      await firstSettled;
      await pulled;
      assert.equal(captures, 1, "settling the original capture never appends another from this gesture");
    } finally {
      open?.();
      await firstSettled;
      Date.now = realNow;
    }
  });
}

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
test("entry stage diagnostics distinguish the response from accumulated display history", async () => {
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
      assert.equal(details.effectiveTrackCount, 2, "the query returned two nodes");
      assert.equal(details.displayedTrackCount, event.endsWith("started") ? 2 : 8);
      assert.equal(details.selectionScope, event.endsWith("started") ? "display" : "query_response");
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


test("a Home held-identity retry cannot overwrite an active detail capture reservation", async () => {
  const state = seed(false, false), owner = state.shipments[0];
  const payload = JSON.stringify({ ...state, pendingNotifications: [{
    id: "synthetic-old-notice", shipmentId: owner.identity.id, semantic: "DELIVERY",
    title: "Synthetic", body: "Synthetic", iconName: null,
  }] });
  memory.clear();
  memory.set("pipi_deliveries_state_v1", JSON.stringify({ schema: 3, checksum: sha256(payload), payload }));
  saveOrderProjectionReferences([{ ownerId: owner.identity.id, source: "interface5", url: parcel().projectionUrl }], NOW);
  setDiagnosticsEnabled(true);
  const previous = { Notification: globalThis.Notification, Script: globalThis.Script, fetch: globalThis.fetch };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const notificationEntered = new Promise<void>(resolve => { entered = resolve; });
  Object.assign(globalThis, {
    Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
    Notification: { schedule: async () => { entered(); await gate; } },
    fetch: async () => { throw new Error("Unexpected network in the held-identity test"); },
  });
  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  const detail = runProjectionAwareShipmentRefreshForTesting(owner.identity.id,
    { trigger: "identity_projection", forceAccountOrderProjection: true }, {
      projectAccountOrderWithCarrier: async input => ({ ...input, waybill: "ZZ1234567890",
        courierCode: "", rawCourierCode: "", companyName: "", projectionTimeline: null }),
      queryManualForSource: async () => ({ shipment: null, pending: null, routeUrl: "" }),
      refreshWebTimeline: async () => null,
    });
  try {
    await notificationEntered;
    const held = loadState().shipments[0];
    assert.ok(held.identity.pendingProjection);
    assert.equal(hasActiveAccountOrderProjection(owner.identity.id), true);
    const result = await projectStoredAccountOrders({ onScreen: () => true });
    assert.notEqual(result.result, "failed", "the held path must share the existing owner, not throw after reserving");
    assert.deepEqual(loadState().shipments[0].identity.orderProjectionRetry, held.identity.orderProjectionRetry);
    assert.equal(readDiagnostics().some(entry => entry.event === "order.projection.failed"), false);
  } finally { release(); await detail; registerProjectionViewportHost(null); Object.assign(globalThis, previous); }
});
