import assert from "node:assert/strict";
import test from "node:test";
import type { Shipment } from "../models.ts";
import { memory, NOW } from "./state-storage-mock.ts";
import {
  commitRefreshState, commitTargetShipmentRefresh, emptyState, forceCompleteShipment, loadState,
  loadWidgetSnapshot, removeShipment, saveState, visibleShipments,
} from "../services/storage.ts";
import { shouldRefreshShipment } from "../services/status.ts";

const DAY = 24 * 60 * 60 * 1000;

function row(kind: "account" | "manual" | "projected", at = NOW): Shipment {
  const waybill = "JD123456789000";
  const timeline = {
    provider: kind === "manual" ? "v6_query" : "interface5",
    waybill, courierCode: "JD", companyName: "京东快递", complete: true,
    structuredStatus: true, semantic: "COMPLETED" as const,
    statusEventAtMs: at, latestTimeText: "2026-09-08 14:00:00",
    latestDetail: "快件已签收", successAtMs: at,
    tracks: [{ timeText: "2026-09-08 14:00:00", timeMs: at,
      detail: "快件已签收", statusCode: "3", raw: {} }],
  };
  return {
    identity: {
      id: `interface5:${kind}:${waybill}`, bindingSource: "interface5",
      sourceOwner: kind === "manual" ? "manual" : "account", sourceId: waybill,
      courierCode: "JD", rawCourierCode: "JD", companyName: "京东快递",
      phoneTail: "", manuallyAdded: kind === "manual", createdAtMs: at - DAY,
      ...(kind === "projected" ? {
        accountOrder: true, orderId: "ORDER123456", projectedWaybill: waybill,
      } : {}),
    },
    timeline,
    ...(kind === "manual" ? { manualTimelines: [timeline] } : { sourceTimeline: timeline }),
    updatedAtMs: at,
  };
}

for (const kind of ["account", "manual", "projected"] as const) {
  test(`${kind}: hide at day 14, retain history until day 21, then delete`, () => {
    memory.clear();
    const original = saveState({ ...emptyState(), shipments: [row(kind)] }, NOW);
    assert.equal(original.shipments[0]?.settledAtMs, NOW);
    assert.equal(visibleShipments(loadState(NOW + 14 * DAY - 1), NOW + 14 * DAY - 1).length, 1);
    for (const age of [14 * DAY, 21 * DAY - 1]) {
      const state = loadState(NOW + age);
      assert.equal(state.shipments.length, 1, "hidden rows still own their history");
      assert.equal(state.shipments[0].settledAtMs, NOW);
      assert.equal(state.shipments[0].timeline.tracks.length, 1);
      assert.equal(visibleShipments(state, NOW + age).length, 0);
      assert.equal(loadWidgetSnapshot(NOW + age).rows.length, 0);
    }
    assert.equal(loadState(NOW + 21 * DAY).shipments.length, 0,
      "signed expiry overrides account and projection retention");
    assert.equal(loadState(NOW + 22 * DAY).shipments.length, 0,
      "reloading cannot restore the expired row or its embedded history");
  });
}

test("a rebuilt account row cannot restart its first terminal timestamp", () => {
  memory.clear();
  saveState({ ...emptyState(), shipments: [row("account")] }, NOW);
  const now = NOW + 15 * DAY;
  const base = loadState(now);
  const rebuilt = row("account", now);
  delete rebuilt.settledAtMs;
  const state = commitRefreshState(base, { ...base, shipments: [rebuilt] }, "interface5", now).state;
  assert.equal(state.shipments[0]?.settledAtMs, NOW);
  assert.equal(visibleShipments(state, now).length, 0);
  assert.equal(loadState(NOW + 21 * DAY).shipments.length, 0);
});

test("a signed manual detail refresh retains its original clock and history", () => {
  memory.clear();
  saveState({ ...emptyState(), shipments: [row("manual")] }, NOW);
  const now = NOW + 15 * DAY;
  const state = loadState(now);
  const refreshed = row("manual", now);
  refreshed.timeline.tracks = [...refreshed.timeline.tracks, ...row("manual").timeline.tracks];
  const commit = commitTargetShipmentRefresh(state, refreshed, now);
  assert.equal(commit.applied, true);
  const saved = commit.state;
  assert.equal(saved.shipments[0]?.settledAtMs, NOW);
  assert.equal(saved.shipments[0]?.timeline.tracks.length, 2);
  assert.equal(visibleShipments(saved, now).length, 0);
  assert.equal(loadState(NOW + 21 * DAY).shipments.length, 0);
});

test("forced completion uses the same fourteen plus seven day lifecycle", () => {
  memory.clear();
  const pending = row("account");
  pending.timeline.semantic = "TRANSIT";
  pending.timeline.latestDetail = "快件运输中";
  pending.timeline.tracks = [{ ...pending.timeline.tracks[0], detail: "快件运输中" }];
  saveState({ ...emptyState(), shipments: [pending] }, NOW);
  const forced = forceCompleteShipment(pending.identity.id, NOW);
  assert.equal(forced.shipments[0]?.forcedCompletedAtMs, NOW);
  assert.equal(forced.shipments[0]?.settledAtMs, NOW);
  assert.equal(loadState(NOW + 14 * DAY).shipments.length, 1);
  assert.equal(visibleShipments(loadState(NOW + 14 * DAY), NOW + 14 * DAY).length, 0);
  assert.equal(loadState(NOW + 21 * DAY).shipments.length, 0);
});

test("a new query cannot extend a signed row older than twenty-one days", () => {
  memory.clear();
  for (const kind of ["account", "manual", "projected"] as const) {
    const old = row(kind, NOW - 21 * DAY);
    old.identity.createdAtMs = NOW;
    const state = saveState({ ...emptyState(), shipments: [old] }, NOW);
    assert.equal(state.shipments.length, 0, `${kind} cannot bypass the signed cutoff`);
  }
});

test("cancelled rows keep their existing four-hour visibility and account cache", () => {
  memory.clear();
  const cancelled = row("account");
  cancelled.timeline.semantic = "CANCELLED";
  cancelled.timeline.latestDetail = "订单已取消";
  cancelled.timeline.tracks = [{ ...cancelled.timeline.tracks[0], detail: "订单已取消" }];
  saveState({ ...emptyState(), shipments: [cancelled] }, NOW);
  const hiddenAt = NOW + 4 * 60 * 60 * 1000;
  assert.equal(visibleShipments(loadState(hiddenAt - 1), hiddenAt - 1).length, 1);
  assert.equal(visibleShipments(loadState(hiddenAt), hiddenAt).length, 0);
  assert.equal(loadState(NOW + 21 * DAY).shipments.length, 1);
  assert.equal(loadState(NOW + 30 * DAY).shipments.length, 0);
});

test("a refresh crossing day 21 cannot recreate its expired owner", () => {
  memory.clear();
  saveState({ ...emptyState(), shipments: [row("projected")] }, NOW);
  const base = loadState(NOW + 21 * DAY - 1);
  const incoming = row("projected", NOW + 21 * DAY);
  const detail = commitTargetShipmentRefresh(base, incoming, NOW + 21 * DAY);
  assert.equal(detail.applied, false);
  assert.equal(detail.state.shipments.length, 0);
  assert.equal(commitRefreshState(base, { ...base, shipments: [incoming] },
    "interface5", NOW + 21 * DAY).state.shipments.length, 0);
});

test("actual deletion lets a newly created owner start its own terminal clock", () => {
  memory.clear();
  const original = row("account");
  saveState({ ...emptyState(), shipments: [original] }, NOW);
  removeShipment(original.identity.id, NOW + DAY);
  const next = saveState({ ...emptyState(), shipments: [row("account", NOW + 2 * DAY)] }, NOW + 2 * DAY);
  assert.equal(next.shipments[0]?.settledAtMs, NOW + 2 * DAY);
});

test("a terminal row without event time keeps one retention clock without freezing", () => {
  memory.clear();
  const untimed = (at: number) => {
    const shipment = row("account", at);
    shipment.timeline.statusEventAtMs = null;
    shipment.timeline.latestTimeText = "";
    shipment.timeline.tracks = [];
    return shipment;
  };
  const initial = saveState({ ...emptyState(), shipments: [untimed(NOW)] }, NOW);
  assert.equal(initial.shipments[0]?.settledAtMs, NOW);
  assert.equal(shouldRefreshShipment(initial.shipments[0], NOW), true);
  for (const age of [DAY, 14 * DAY, 21 * DAY - 1]) {
    const now = NOW + age;
    const base = loadState(now);
    assert.equal(base.shipments[0]?.settledAtMs, NOW);
    const commit = commitRefreshState(base, { ...base, shipments: [untimed(now)] }, "interface5", now);
    assert.equal(commit.applied, true);
    const current = commit.state.shipments[0];
    assert.equal(current?.settledAtMs, NOW, "an untimed feed must not restart retention");
    assert.equal(current.timeline.statusEventAtMs, null);
    assert.equal(shouldRefreshShipment(current, now), true,
      "the local retention timestamp is not provider evidence for freezing");
    assert.equal(visibleShipments(commit.state, now).length, age < 14 * DAY ? 1 : 0);
  }
  assert.equal(loadState(NOW + 21 * DAY).shipments.length, 0);
});

test("hidden signed rows stay in the notification baseline without replaying their old event", () => {
  memory.clear();
  const signed = row("account");
  const active = row("account");
  active.identity.id = "interface5:account:ACTIVE";
  active.identity.sourceId = "JD123456789001";
  active.timeline.waybill = active.identity.sourceId;
  active.timeline.semantic = "TRANSIT";
  saveState({ ...emptyState(), shipments: [signed, active] }, NOW);

  const now = NOW + 15 * DAY;
  const initial = loadState(now);
  assert.equal(initial.shipments.length, 2);
  assert.equal(visibleShipments(initial, now).length, 1);
  const context = {
    previousById: new Map(initial.shipments.map((shipment) => [shipment.identity.id, shipment])),
    batchId: "hidden-signed-refresh",
  };
  assert.ok(context.previousById.has(signed.identity.id));
  const refreshed = initial.shipments.map((shipment) => ({
    ...shipment,
    sourceTimeline: undefined,
    timeline: {
      ...shipment.timeline,
      semantic: "COMPLETED" as const,
      latestDetail: "快件已签收，感谢使用",
      statusEventAtMs: shipment.identity.id === signed.identity.id ? NOW : now,
    },
    updatedAtMs: now,
  }));
  const committed = commitRefreshState(initial, { ...initial, shipments: refreshed },
    "interface5", now, undefined, context).state;
  assert.equal(committed.shipments.find((shipment) => shipment.identity.id === signed.identity.id)?.settledAtMs, NOW);
  assert.deepEqual(committed.pendingNotifications?.map((event) => event.shipmentId), [active.identity.id],
    "the newly signed control notifies; rereading the hidden event does not");
  const next = loadState(now + 1);
  const repeated = commitRefreshState(next, {
    ...next, shipments: next.shipments.map((shipment) => ({ ...shipment, updatedAtMs: now + 1 })),
  }, "interface5", now + 1).state;
  assert.deepEqual(repeated.pendingNotifications?.map((event) => event.shipmentId), [active.identity.id],
    "the next durable refresh does not create another event for the hidden owner");
});

function notificationRow(waybill: string): Shipment {
  const shipment = row("account");
  shipment.identity = {
    ...shipment.identity, id: `interface5:account:${waybill}`, sourceId: waybill,
    sourceProvider: "ShunFeng", courierCode: "SF", rawCourierCode: "SF", companyName: "顺丰速运",
  };
  shipment.timeline = {
    ...shipment.timeline, waybill, courierCode: "SF", companyName: "顺丰速运",
  };
  shipment.sourceTimeline = shipment.timeline;
  return shipment;
}

test("a newer event cannot publish a notification for a hidden signed owner", () => {
  memory.clear();
  const hidden = notificationRow("SF123456789000");
  const active = notificationRow("SF123456789001");
  active.timeline.semantic = "TRANSIT";
  saveState({ ...emptyState(), shipments: [hidden, active] }, NOW);
  const now = NOW + 15 * DAY;
  const initial = loadState(now);
  const incoming = initial.shipments.map((shipment) => ({
    ...shipment, sourceTimeline: undefined, updatedAtMs: now,
    timeline: { ...shipment.timeline, semantic: "COMPLETED" as const,
      latestDetail: "快件已签收，配送服务已完成", statusEventAtMs: now },
  }));
  const committed = commitRefreshState(initial, { ...initial, shipments: incoming },
    "interface5", now, undefined, {
      previousById: new Map(initial.shipments.map((shipment) => [shipment.identity.id, shipment])),
      batchId: "hidden-newer-event",
    }).state;
  assert.equal(committed.shipments.find((shipment) => shipment.identity.id === hidden.identity.id)?.settledAtMs, NOW);
  assert.deepEqual(committed.pendingNotifications?.map((event) => event.shipmentId), [active.identity.id]);
});

test("an outbox event that becomes hidden is acknowledged without blocking the next visible event", async () => {
  memory.clear();
  const hidden = notificationRow("SF123456789010");
  const active = notificationRow("SF123456789011");
  active.timeline.semantic = "TRANSIT";
  const initial = saveState({ ...emptyState(), shipments: [hidden, active] }, NOW);
  const beforeHidden = NOW + 13 * DAY;
  const first = commitRefreshState(initial, {
    ...initial,
    shipments: initial.shipments.map((shipment) => shipment.identity.id === hidden.identity.id ? {
      ...shipment, sourceTimeline: undefined, updatedAtMs: beforeHidden,
      timeline: { ...shipment.timeline, latestDetail: "快件已签收，配送服务已完成", statusEventAtMs: beforeHidden },
    } : shipment),
  }, "interface5", beforeHidden).state;
  assert.deepEqual(first.pendingNotifications?.map((event) => event.shipmentId), [hidden.identity.id]);
  const queued = commitRefreshState(first, {
    ...first,
    shipments: first.shipments.map((shipment) => shipment.identity.id === active.identity.id ? {
      ...shipment, sourceTimeline: undefined, updatedAtMs: beforeHidden + 1,
      timeline: { ...shipment.timeline, semantic: "COMPLETED" as const,
        latestDetail: "快件已签收", statusEventAtMs: beforeHidden + 1 },
    } : shipment),
  }, "interface5", beforeHidden + 1).state;
  assert.deepEqual(queued.pendingNotifications?.map((event) => event.shipmentId), [hidden.identity.id, active.identity.id]);

  const scheduled: string[] = [];
  const realNow = Date.now;
  Date.now = () => NOW + 15 * DAY;
  Object.assign(globalThis, {
    Script: { directory: "/synthetic", name: "synthetic", createRunSingleURLScheme: () => "synthetic:detail" },
    Notification: { async schedule(event: { userInfo: { shipment: string } }) {
      scheduled.push(event.userInfo.shipment);
    } },
  });
  Object.assign(Data, { fromFile: () => null });
  try {
    const { replayPendingShipmentNotifications } = await import("../services/notifications.ts");
    await replayPendingShipmentNotifications();
    assert.deepEqual(scheduled, [active.identity.id], "only the still-visible owner reaches the host");
    assert.deepEqual(loadState().pendingNotifications, [], "the skipped head and delivered successor are both acknowledged");
  } finally {
    Date.now = realNow;
  }
});
