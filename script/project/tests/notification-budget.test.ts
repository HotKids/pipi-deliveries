import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppState, Shipment } from "../models.ts";
import { memory, NOW, sha256 } from "./state-storage-mock.ts";
import { emptyState, loadState } from "../services/storage.ts";
import { replayPendingShipmentNotifications } from "../services/notifications.ts";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger.ts";

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

function seed() {
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
    pendingNotifications: shipments.map(row => ({ id: `event-${row.identity.id}`, shipmentId: row.identity.id,
      semantic: "DELIVERY", title: "Synthetic", body: "Synthetic", iconName: null })) };
  const payload = JSON.stringify(state);
  memory.set("pipi_deliveries_state_v1", JSON.stringify({ schema: 3, checksum: sha256(payload), payload }));
  return state;
}

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
