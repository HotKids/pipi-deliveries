import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppState, Shipment } from "../models.ts";
import { memory, NOW, sha256 } from "./state-storage-mock.ts";
import { emptyState, loadState } from "../services/storage.ts";
import { replayPendingShipmentNotifications } from "../services/notifications.ts";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger.ts";
import { acquireDurableRefreshLease } from "../services/refresh-runtime-state.ts";

let clock = NOW;
const realNow = Date.now;
Date.now = () => clock;
process.on("exit", () => { Date.now = realNow; });
const attempted: string[] = [];
let schedule: () => Promise<void> = async () => {};
Object.assign(globalThis, {
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic:detail" },
  Notification: { schedule(event: { userInfo: { shipment: string } }) {
    attempted.push(event.userInfo.shipment);
    return schedule();
  } },
});

function seed(emptyOutbox = false) {
  memory.clear(); clock = NOW; attempted.length = 0;
  setDiagnosticsEnabled(true);
  const shipments: Shipment[] = ["A", "B", "C"].map(id => ({
    identity: { id: `interface5:manual:BUDGET${id}`, sourceId: `BUDGET${id}`,
      bindingSource: "interface5", sourceOwner: "manual", phoneTail: "", courierCode: "",
      companyName: "Synthetic", manuallyAdded: true, createdAtMs: NOW },
    timeline: { provider: "v6_query", waybill: `BUDGET${id}`, courierCode: "", companyName: "Synthetic",
      semantic: "DELIVERY", statusEventAtMs: NOW, latestTimeText: "", latestDetail: "Synthetic",
      tracks: [], successAtMs: NOW }, updatedAtMs: NOW,
  }));
  const state: AppState = { ...emptyState(), revision: 1, updatedAtMs: NOW, shipments,
    pendingNotifications: emptyOutbox ? [] : shipments.map(row => ({ id: `event-${row.identity.id}`, shipmentId: row.identity.id,
      semantic: "DELIVERY", title: "Synthetic", body: "Synthetic", iconName: null })) };
  const payload = JSON.stringify(state);
  memory.set("pipi_deliveries_state_v1", JSON.stringify({ schema: 3, checksum: sha256(payload), payload }));
  return state;
}

test("an empty outbox records one timed completion while retaining real reads and lease cleanup", async () => {
  const initial = seed(true);
  const originalGet = Storage.get;
  let preferenceReads = 0, stateReads = 0;
  Storage.get = (key, ...options) => {
    if (key === "pipi_deliveries_notification_preferences_v1") { preferenceReads++; clock += 120; }
    if (key === "pipi_deliveries_state_v1") { stateReads++; clock += 80; }
    return originalGet(key, ...options);
  };
  try {
    const result = await replayPendingShipmentNotifications(() => true,
      { deadlineAtMs: NOW + 1_000, flowId: "empty-outbox" });
    const readElapsed = clock - NOW;
    assert.ok(preferenceReads > 0, "empty work still refreshes notification preferences");
    assert.ok(stateReads > 0, "the current durable outbox is still loaded");
    assert.deepEqual(result?.pendingNotifications, initial.pendingNotifications);
    assert.deepEqual(attempted, []);
    const events = readDiagnostics().filter(entry => entry.event.startsWith("notification.replay."));
    assert.deepEqual(events.map(entry => entry.event), ["notification.replay.completed"]);
    assert.deepEqual(events[0].details, {
      clientBuild: events[0].details.clientBuild,
      flowId: "empty-outbox", stage: "notifications", result: "completed",
      budgetMs: 1_000, readDurationMs: readElapsed, durationMs: readElapsed,
      pendingNotifications: 0, attempted: 0, succeeded: 0, failed: 0,
    });
    const next = acquireDurableRefreshLease("notifications", 1_000, clock);
    assert.ok(next, "the empty drain still releases its acquired notification lease");
    next.release();
  } finally {
    Storage.get = originalGet;
  }
});

test("an empty alignment-filtered drain preserves other queued events with one completion", async () => {
  const initial = seed();
  await replayPendingShipmentNotifications(() => true, {
    deadlineAtMs: NOW + 1_000, flowId: "filtered-outbox", alignedShipmentId: "synthetic-other-owner",
  });
  assert.deepEqual(attempted, []);
  assert.deepEqual(loadState().pendingNotifications, initial.pendingNotifications);
  const events = readDiagnostics().filter(entry => entry.event.startsWith("notification.replay."));
  assert.deepEqual(events.map(entry => entry.event), ["notification.replay.completed"]);
  assert.equal(events[0].details.result, "pending_retry");
  assert.equal(events[0].details.pendingNotifications, 3);
  assert.equal(events[0].details.budgetMs, 1_000);
  assert.equal(events[0].details.readDurationMs, 0);
});

test("a nonempty drain preserves its start, read and completion trace with durable ACKs", async () => {
  seed();
  schedule = async () => { clock += 5; };
  await replayPendingShipmentNotifications(() => true, { deadlineAtMs: NOW + 1_000, flowId: "real-outbox" });
  const events = readDiagnostics().filter(entry => entry.event.startsWith("notification.replay.")).reverse();
  assert.deepEqual(events.map(entry => entry.event), [
    "notification.replay.started", "notification.replay.loaded", "notification.replay.completed",
  ]);
  assert.equal(events[0].details.budgetMs, 1_000);
  assert.equal(events[1].details.pendingNotifications, 3);
  assert.equal(events[2].details.succeeded, 3);
  assert.equal(events[2].details.durationMs, 15);
  assert.equal(attempted.length, 3);
  assert.equal(loadState().pendingNotifications?.length, 0);
});

async function withTimers(run: () => Promise<void>) {
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((callback: () => void, ms: number) => {
    const handle = { active: true };
    setImmediate(() => { if (handle.active) { clock += ms; callback(); } });
    return handle;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: { active: boolean }) => { handle.active = false; }) as unknown as typeof clearTimeout;
  try { await run(); }
  finally { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; }
}

test("an exhausted refresh budget starts no notification and retains the durable outbox", async () => {
  const initial = seed();
  schedule = async () => {};
  await replayPendingShipmentNotifications(() => true, { deadlineAtMs: NOW, flowId: "exhausted" });
  assert.deepEqual(attempted, []);
  assert.deepEqual(loadState().pendingNotifications, initial.pendingNotifications);
  assert.equal(readDiagnostics().find(entry => entry.event === "notification.replay.skipped")?.details.result,
    "budget_exhausted");
});

test("remaining budget bounds a stalled schedule, preserves ACKs and advances the next runtime", async () => {
  const initial = seed();
  let resolveLate!: () => void;
  schedule = () => {
    if (attempted.length === 1) { clock += 300; return Promise.resolve(); }
    return new Promise(resolve => { resolveLate = resolve; });
  };
  await withTimers(async () => {
    await replayPendingShipmentNotifications(() => true, { deadlineAtMs: NOW + 500, flowId: "bounded" });
  });
  assert.equal(clock, NOW + 500, "a notification cannot receive a fresh ten-second wait after the refresh budget");
  assert.equal(attempted.length, 2, "the third event must remain queued without starting");
  const remaining = loadState().pendingNotifications!;
  assert.deepEqual(remaining.map(event => event.id), [initial.pendingNotifications![2].id, initial.pendingNotifications![1].id],
    "successful ACKs stay committed and the stalled event rotates behind unattempted work");
  resolveLate(); await Promise.resolve();
  assert.deepEqual(loadState().pendingNotifications, remaining, "late native completion must not acknowledge outside the drain");
  const end = readDiagnostics().find(entry => entry.event === "notification.replay.completed")!;
  assert.equal(end.details.flowId, "bounded");
  assert.equal(end.details.result, "budget_exhausted");
  assert.equal(end.details.pendingNotifications, 2);
  assert.equal(end.details.attempted, 2);
  assert.equal(end.details.succeeded, 1);
  schedule = async () => {};
  await replayPendingShipmentNotifications();
  assert.equal(loadState().pendingNotifications?.length, 0);
  assert.equal(attempted.filter(id => id === initial.shipments[0].identity.id).length, 1,
    "a later runtime must not resend the acknowledged event");
});

test("a schedule response after ownership loss cannot acknowledge its event", async () => {
  const initial = seed();
  let current = true;
  schedule = async () => { current = false; };
  await replayPendingShipmentNotifications(() => current, { deadlineAtMs: NOW + 500, flowId: "lost-owner" });
  assert.equal(attempted.length, 1);
  assert.deepEqual(loadState().pendingNotifications, initial.pendingNotifications);
});
