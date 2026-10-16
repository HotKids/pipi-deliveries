import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Shipment, StatusSemantic, TimelinePackage, TrackNode } from "../models";
import { memory, NOW } from "./state-storage-mock";
import { emptyState, loadState, saveState } from "../services/storage";
import { replayPendingShipmentNotifications } from "../services/notifications";
import { saveNotificationStatuses } from "../services/notification-preferences";
import { acquireDurableRefreshLease } from "../services/refresh-runtime-state";
import { runStatusAlignmentPass } from "../services/status-alignment";
import { runShipmentRefreshForTesting } from "../services/sync";
import { selectShipmentTimeline, statusAlignmentTimes } from "../services/shipment-policy";
import { loadAlignmentRecords, parseAlignmentAttempt, rowLedgerKey, saveAlignmentRecords } from "../services/row-ledger";

const PHONE = "13800001937";
const WAYBILL = "SF900000001937";
const SIGNED_AT = NOW - 60_000;
const OLD_AT = SIGNED_AT - 60 * 60_000;
const OLD_BODY = "Synthetic old transit event";
const SIGNED_BODY = "Synthetic detailed signing event";
const COARSE_BODY = "Synthetic coarse signing event";
const actualNow = Date.now;
const scheduled: Array<{ title: string; body: string }> = [];
let rejectSchedule = false;
const text = (at: number) => new Date(at + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

Object.assign(globalThis, {
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic:detail" },
  Data: { ...globalThis.Data, fromFile: () => null },
  Widget: { reloadAll() {} },
  Notification: { schedule: async (event: { title: string; body: string }) => {
    scheduled.push(event);
    if (rejectSchedule) throw new Error("Synthetic host rejection");
  } },
});

beforeEach(() => {
  memory.clear(); Date.now = () => NOW; scheduled.length = 0; rejectSchedule = false;
  saveNotificationStatuses(["TRANSIT", "DELIVERY", "COMPLETED"], NOW);
});
afterEach(() => { Date.now = actualNow; });

function node(at: number, detail: string, semantic: StatusSemantic | null): TrackNode {
  return { timeMs: at, timeText: text(at), detail, statusCode: semantic || "", raw: semantic ? {
    normalizedStatus: { version: 1, scope: "SHIPMENT", semantic, code: semantic, text: semantic,
      priority: 0, eventAtMs: at, structured: true },
  } : {} };
}

function pack(provider: string, semantic: StatusSemantic, at: number, tracks: TrackNode[], structured = true): TimelinePackage {
  return { provider, waybill: WAYBILL, courierCode: "SF", companyName: "Synthetic carrier",
    semantic, structuredStatus: structured, statusEventAtMs: at, successAtMs: NOW, complete: false,
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, tracks };
}

function row(): Shipment {
  const source = pack("interface5", "TRANSIT", OLD_AT, [node(OLD_AT, OLD_BODY, "TRANSIT")]);
  const manual = pack("k100_h5", "TRANSIT", OLD_AT,
    [node(OLD_AT, OLD_BODY, "TRANSIT"), node(OLD_AT - 86_400_000, "Synthetic pickup", "PICKED")], false);
  return { identity: { id: `interface5:account:${WAYBILL}`, sourceId: WAYBILL,
    bindingSource: "interface5", sourceOwner: "interface5:parcel", sourceProvider: "ShunFeng",
    courierCode: "SF", rawCourierCode: "SF", companyName: "Synthetic carrier", phone: PHONE,
    phoneTail: "1937", manuallyAdded: false, createdAtMs: OLD_AT - 86_400_000 },
    timeline: manual, sourceTimeline: source, manualTimelines: [manual], updatedAtMs: NOW,
    accountRecord: { waybill: WAYBILL, companyCode: "SF", provider: "ShunFeng", phone: PHONE },
  };
}

function seedSigning(): Shipment {
  const initial = saveState({ ...emptyState(), shipments: [row()], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: OLD_AT - 86_400_000 },
  ] }, NOW);
  const previous = initial.shipments[0];
  const source = pack("interface5", "COMPLETED", SIGNED_AT, [node(SIGNED_AT, COARSE_BODY, "COMPLETED")]);
  const manual = { ...previous.manualTimelines![0], semantic: "COMPLETED" as const,
    structuredStatus: true, statusEventAtMs: SIGNED_AT };
  const next = saveState({ ...initial, shipments: [{ ...previous, sourceTimeline: source,
    manualTimelines: [manual] }] }, NOW, { notifyChanges: true });
  assert.equal(next.shipments[0].timeline.semantic, "COMPLETED", "signing is committed before the notification waits");
  assert.equal(next.pendingNotifications?.length, 1, "the state commit retains a durable notification obligation");
  assert.equal(next.pendingNotifications[0].body, OLD_BODY);
  return next.shipments[0];
}

test("an SF signing waits durably for alignment while an unavailable host reserves nothing", async () => {
  const signing = seedSigning();
  await replayPendingShipmentNotifications();
  assert.deepEqual(scheduled, [], "old transit text must not be sent under a signed title");
  assert.equal(loadState().pendingNotifications?.length, 1);
  assert.equal(loadState().shipments[0].timeline.semantic, "COMPLETED");
  const result = await runStatusAlignmentPass({}, { appHost: () => false, now: () => NOW });
  assert.equal(result.result, "not_app_host");
  assert.equal(loadAlignmentRecords()[rowLedgerKey(signing.identity.id)], undefined);
  assert.equal(loadState().pendingNotifications?.length, 1);
});

test("a feed-only SF signing remains queued until an actual first alignment attempt finishes", async () => {
  const previous = row();
  previous.manualTimelines = [];
  previous.timeline = previous.sourceTimeline!;
  const initial = saveState({ ...emptyState(), shipments: [previous], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: OLD_AT - 86_400_000 },
  ] }, NOW);
  const source = pack("interface5", "COMPLETED", SIGNED_AT, [node(SIGNED_AT, COARSE_BODY, "COMPLETED")]);
  const committed = saveState({ ...initial, shipments: [{ ...initial.shipments[0],
    timeline: source, sourceTimeline: source }] }, NOW, { notifyChanges: true });
  assert.equal(committed.shipments[0].timeline.semantic, "COMPLETED");
  assert.equal(committed.pendingNotifications?.length, 1);
  await replayPendingShipmentNotifications();
  assert.equal(scheduled.length, 0, "a matching coarse node is the final fallback, not the first response");
  const skipped = await runStatusAlignmentPass({}, { appHost: () => true, busy: () => false, now: () => NOW,
    refresh: async () => ({ state: loadState() }),
  });
  assert.equal(skipped.result, "nothing_due");
  assert.equal(loadAlignmentRecords()[rowLedgerKey(previous.identity.id)], undefined);
  await replayPendingShipmentNotifications();
  assert.equal(scheduled.length, 0, "a host pass that dispatched no query cannot release the final fallback");
  await runStatusAlignmentPass({}, { appHost: () => true, busy: () => false, now: () => NOW,
    refresh: async (_id, beforeQuery) => { beforeQuery(); return { state: loadState() }; },
  });
  const attempt = parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(previous.identity.id)])!;
  assert.equal(attempt.finished, true);
  assert.equal(attempt.complete, false, "an unchanged reply is settled without claiming newer evidence");
  assert.equal(attempt.attempts, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].body, COARSE_BODY);
  assert.equal(loadState().pendingNotifications?.length, 0);
});

test("the real forced-detail flow finishes before the signed event uses its new detailed headline", async () => {
  const signing = seedSigning();
  const calls: string[] = [];
  const result = await runStatusAlignmentPass({}, { appHost: () => true, busy: () => false, now: () => NOW,
    refresh: async (id, beforeQuery) => {
      const lease = acquireDurableRefreshLease(`detail:${id}`, 35_000)!;
      assert.ok(lease);
      try {
        const response = await runShipmentRefreshForTesting(id, { isCurrent: lease.isCurrent, deadlineAtMs: NOW + 30_000 },
          { trigger: "status_alignment", beforeQuery, forceManualRefresh: true, includeKdniaoFallback: true }, {
            refreshAccountParcel: async () => { assert.fail("SF alignment does not query the account detail"); },
            queryManualForSource: async (input) => {
              input.beforeQuery?.(); input.onQueryAttempted?.(true);
              calls.push(input.pickerOnly ? "v6_query" : "fallback");
              assert.equal(input.pickerOnly, true, "this complete Online reply keeps the paid gate closed");
              const fresh = pack("v6_query", "COMPLETED", SIGNED_AT, [node(SIGNED_AT, SIGNED_BODY, "COMPLETED"),
                node(OLD_AT, OLD_BODY, "TRANSIT"), node(OLD_AT - 86_400_000, "Synthetic pickup", "PICKED")]);
              return { shipment: { ...input.currentShipment!, timeline: fresh, sourceTimeline: null,
                manualTimelines: [fresh] }, pending: null, routeUrl: "" };
            },
            refreshWebTimeline: async () => { calls.push("h5"); return null; },
          });
        assert.equal(scheduled.length, 0, "an inner refresh drain cannot send before the alignment round settles");
        return response;
      } finally { lease.release(); }
    },
  });
  assert.equal(result.result, "attempted");
  assert.equal(calls[0], "v6_query");
  assert.ok(!calls.includes("fallback"), "the existing paid gate is preserved");
  assert.equal(parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(signing.identity.id)])?.finished, true);
  assert.equal(scheduled.length, 1, "completion drains the retained signing without another refresh");
  assert.match(scheduled[0].title, /已签收$/);
  assert.equal(scheduled[0].body, SIGNED_BODY);
  assert.equal(loadState().pendingNotifications?.length, 0);
  await replayPendingShipmentNotifications();
  assert.equal(scheduled.length, 1, "the successful host acknowledgement remains durable");
});

test("a settled failed force may use the existing coarse same-state fallback, but host failure never ACKs", async () => {
  const signing = seedSigning();
  rejectSchedule = true;
  const result = await runStatusAlignmentPass({}, { appHost: () => true, busy: () => false, now: () => NOW,
    refresh: async (_id, beforeQuery) => { beforeQuery(); throw new Error("Synthetic request timeout"); },
  });
  assert.equal(result.result, "failed");
  assert.equal(parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(signing.identity.id)])?.finished, true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].body, COARSE_BODY, "failure still settles the existing first-force final fallback");
  assert.equal(loadState().pendingNotifications?.length, 1, "a rejected schedule preserves the obligation");
  rejectSchedule = false;
  await replayPendingShipmentNotifications();
  assert.equal(scheduled[1].body, COARSE_BODY);
  assert.equal(loadState().pendingNotifications?.length, 0);
});

test("a known conflicting enum cannot pass the five-minute unknown-node allowance", async () => {
  const signing = seedSigning();
  const manual = pack("v6_query", "COMPLETED", SIGNED_AT,
    [node(SIGNED_AT, OLD_BODY, "TRANSIT"), node(OLD_AT - 86_400_000, "Synthetic pickup", "PICKED")]);
  const source = { ...signing.sourceTimeline!, tracks: [], latestDetail: "", latestTimeText: "" };
  saveState({ ...loadState(), shipments: [{ ...signing, sourceTimeline: source, manualTimelines: [manual] }] }, NOW);
  const current = loadState().shipments[0];
  const times = statusAlignmentTimes(current)!;
  saveAlignmentRecords({ [rowLedgerKey(current.identity.id)]: JSON.stringify({
    times: `${times.statusAtMs}|${times.headlineAtMs}|${times.detailAtMs}`, attempts: 3,
    lastAttemptAtMs: NOW, finished: true, complete: false,
  }) });
  await replayPendingShipmentNotifications();
  assert.equal(scheduled.length, 0, "exhaustion cannot authorize conflicting text without a same-state node");
  assert.equal(loadState().pendingNotifications?.length, 1);
  const unknown = { ...manual, tracks: [node(SIGNED_AT - 5 * 60_000, "Synthetic untimed-state event", null), manual.tracks[1]],
    latestDetail: "Synthetic untimed-state event", latestTimeText: text(SIGNED_AT - 5 * 60_000) };
  saveState({ ...loadState(), shipments: [{ ...current, manualTimelines: [unknown] }] }, NOW);
  await replayPendingShipmentNotifications();
  assert.equal(scheduled.length, 1, "the existing exact-five-minute allowance remains valid for unknown node states");
  assert.equal(scheduled[0].body, "Synthetic untimed-state event");
});

test("a headline's raw millisecond clock retains its real node when its text only has seconds", async () => {
  const signing = seedSigning();
  const rawAt = SIGNED_AT + 1;
  const manual = pack("v6_query", "COMPLETED", rawAt,
    [node(rawAt, SIGNED_BODY, "COMPLETED"), node(OLD_AT, OLD_BODY, "TRANSIT")]);
  saveState({ ...loadState(), shipments: [{ ...signing, manualTimelines: [manual] }] }, NOW);
  const current = loadState().shipments[0];
  assert.equal(current.manualTimelines![0].tracks[0].timeMs, rawAt, "raw precision stays intact");
  assert.equal(statusAlignmentTimes(current)?.headlineSemantic, "COMPLETED");
  await replayPendingShipmentNotifications();
  assert.equal(scheduled.length, 1, "an existing signing node must not wait for another request");
  assert.equal(scheduled[0].body, SIGNED_BODY);
});

test("same-second same-text nodes keep the selected provider's actual ordering and own enum", () => {
  const signing = seedSigning();
  for (const signedOffset of [1, 0]) {
    const manual = pack("v6_query", "COMPLETED", SIGNED_AT + signedOffset,
      [node(SIGNED_AT + 2, SIGNED_BODY, "TRANSIT"), node(SIGNED_AT + signedOffset, SIGNED_BODY, "COMPLETED"),
        node(OLD_AT, "Synthetic pickup", "PICKED")]);
    saveState({ ...loadState(), shipments: [{ ...signing, manualTimelines: [manual] }] }, NOW);
    const current = loadState().shipments[0];
    assert.equal(current.manualTimelines![0].tracks.length, 3, "conflicting nodes stay separate");
    assert.equal(statusAlignmentTimes(current)?.headlineSemantic, "TRANSIT",
      "a same-second signing cannot lend its enum, even when its raw clock exactly matches the printed second");
  }
});

test("alignment completion drains only its own signing, leaving unrelated queued events on their original path", async () => {
  seedSigning();
  const second = row();
  const otherWaybill = "ZT900000001937";
  second.identity = { ...second.identity, id: `interface5:account:${otherWaybill}`, sourceId: otherWaybill,
    sourceProvider: "ZhongTong" };
  second.timeline = { ...second.timeline, waybill: otherWaybill };
  second.sourceTimeline = { ...second.sourceTimeline!, waybill: otherWaybill };
  second.manualTimelines = [];
  second.accountRecord = { ...second.accountRecord!, waybill: otherWaybill, provider: "ZhongTong" };
  saveState({ ...loadState(), shipments: [...loadState().shipments, second] }, NOW);
  const source = { ...pack("interface5", "DELIVERY", SIGNED_AT,
    [node(SIGNED_AT, "Synthetic other delivery", "DELIVERY")]), waybill: otherWaybill };
  saveState({ ...loadState(), shipments: loadState().shipments.map(shipment => shipment.identity.id === second.identity.id
    ? { ...shipment, sourceTimeline: source } : shipment) }, NOW, { notifyChanges: true });
  assert.equal(loadState().pendingNotifications?.length, 2);
  await runStatusAlignmentPass({}, { appHost: () => true, busy: () => false, now: () => NOW,
    canAsk: shipment => shipment.identity.sourceProvider === "ShunFeng",
    refresh: async (_id, beforeQuery) => { beforeQuery(); throw new Error("Synthetic request timeout"); },
  });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].body, COARSE_BODY);
  assert.equal(loadState().pendingNotifications?.length, 1);
  assert.equal(loadState().pendingNotifications[0].shipmentId, second.identity.id);
});

test("other statuses and sources keep their existing immediate delivery", async () => {
  const initial = saveState({ ...emptyState(), shipments: [row()], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: OLD_AT - 86_400_000 },
  ] }, NOW);
  const source = pack("interface5", "DELIVERY", SIGNED_AT, [node(SIGNED_AT, "Synthetic delivery", "DELIVERY")]);
  const manual = { ...initial.shipments[0].manualTimelines![0], semantic: "DELIVERY" as const,
    structuredStatus: true, statusEventAtMs: SIGNED_AT };
  saveState({ ...initial, shipments: [{ ...initial.shipments[0], sourceTimeline: source,
    manualTimelines: [manual] }] }, NOW, { notifyChanges: true });
  await replayPendingShipmentNotifications();
  assert.equal(scheduled.length, 1);
  assert.match(scheduled[0].title, /派送中$/);
  assert.equal(loadState().pendingNotifications?.length, 0);
});
