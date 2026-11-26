// Diagnostics log plan (docs/DIAGNOSTICS_LOG_PLAN_20261121.md), Deliveries iOS steps 1, 2 and 4, under the owner's
// rulings of 2026-11-21: D4/D207 (start merged into the end line, an unfinished operation reported by the next
// runtime), D5/D7 (waybill tail kept, order fingerprint replaced by a local handle), D6 (relative times), D8 (numeric
// flow id), D11 (closed JD page kind), and D124/D131 (recognition attempts, per-row lines).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppState, Shipment } from "../models.ts";
import { memory, NOW, sha256 } from "./state-storage-mock.ts";
import { emptyState, loadState, saveState } from "../services/storage.ts";
import { replayPendingShipmentNotifications } from "../services/notifications.ts";
import { saveNotificationStatuses } from "../services/notification-preferences.ts";
import {
  beginDiagnosticOperation, clearDiagnostics, createDiagnosticFlowId, diagnosticHandle, jdDiagnosticPage,
  readDiagnostics, reportUnfinishedDiagnosticFlows, setDiagnosticsEnabled, writeDiagnostic, writeRuntimeCapabilities,
} from "../services/logger.ts";
import { projectionOwnerFingerprint } from "../services/sync/shared.ts";
import { openFlows, setOpenFlows } from "./open-flow-markers.ts";

const HANDLE_KEY = "pipi_deliveries_diagnostic_handle_key_v1";
Object.assign(globalThis, {
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic:detail" },
  Notification: { schedule: async () => true },
});

function reset() {
  memory.clear();
  setDiagnosticsEnabled(true);
  clearDiagnostics();
}

/** A marker is keyed by its flow id and event (step 5: one flow id can carry several tracked flows). */
function markerKey(flowId: string): string | undefined {
  return Object.keys(openFlows()).find(key => key.split(":")[0] === flowId);
}

test("D8: a flow id is a non-negative number whose start time can be read back", () => {
  const before = Date.now();
  const first = createDiagnosticFlowId("refresh");
  const second = createDiagnosticFlowId("detail");
  assert.match(first, /^\d+$/);
  assert.match(second, /^\d+$/);
  assert.notEqual(first, second, "two ids in the same millisecond still differ");
  const startedAt = Math.floor(Number(first) / 1024);
  assert.ok(startedAt >= before && startedAt <= Date.now(), "the id carries its start time (Pipi newFlowId)");
  assert.ok(Number.isSafeInteger(Number(first)));
});

test("D4: an operation writes one end line and no start line, and an abandoned one is reported next run", () => {
  reset();
  // D188: the meal and PDD cloud reads are cloud.sync operations of their domains.
  const finish = beginDiagnosticOperation("cloud.sync", { domain: "meal_pickup", stage: "cloud_record_sync" });
  assert.ok(markerKey(finish.flowId), "a running operation keeps a marker");
  finish("succeeded");
  assert.equal(markerKey(finish.flowId), undefined, "an ended operation leaves no marker");
  assert.deepEqual(readDiagnostics().map(entry => entry.event), ["cloud.sync.completed"]);
  assert.ok(Number(readDiagnostics()[0].details.durationMs) >= 0);

  const quiet = beginDiagnosticOperation("cloud.sync", { domain: "pdd" });
  quiet.discard();
  assert.equal(markerKey(quiet.flowId), undefined, "a discarded operation closes its marker without a line");
  assert.equal(readDiagnostics().filter(entry => entry.event === "cloud.sync.completed").length, 1);

  // An earlier runtime started an operation an hour ago and never ended it.
  const stuck = beginDiagnosticOperation("platform.parcel_sync", { sourceProvider: "cainiao" });
  const flows = openFlows();
  const stuckKey = markerKey(stuck.flowId)!;
  flows[stuckKey] = { ...flows[stuckKey]!, runtime: "earlier-runtime", startedAtMs: Date.now() - 3_600_000 };
  setOpenFlows(flows);
  clearDiagnostics();
  setOpenFlows(flows);
  writeRuntimeCapabilities("widget");
  const unfinished = readDiagnostics().filter(entry => entry.event === "diagnostic.flow.unfinished");
  assert.equal(unfinished.length, 1);
  assert.equal(unfinished[0].level, "warning");
  assert.equal(unfinished[0].details.flowId, stuck.flowId);
  assert.equal(unfinished[0].details.unfinishedEvent, "platform.parcel_sync");
  assert.ok(Math.abs(Number(unfinished[0].details.ageMs) - 3_600_000) < 5_000);
  assert.equal(markerKey(stuck.flowId), undefined, "a reported marker is dropped");
  reportUnfinishedDiagnosticFlows();
  assert.equal(readDiagnostics().filter(entry => entry.event === "diagnostic.flow.unfinished").length, 1,
    "it is reported once");

  // A marker this runtime still holds, or one started moments ago elsewhere, is not reported.
  const running = beginDiagnosticOperation("shortcut.query", {});
  const recent = beginDiagnosticOperation("pickup.action", {});
  const current = openFlows();
  const recentKey = markerKey(recent.flowId)!;
  current[recentKey] = { ...current[recentKey]!, runtime: "another-runtime" };
  setOpenFlows(current);
  reportUnfinishedDiagnosticFlows();
  assert.equal(readDiagnostics().filter(entry => entry.event === "diagnostic.flow.unfinished").length, 1);
  running("succeeded");
  recent("succeeded");

  // Turning recording off forgets running operations; nothing is reported for them later.
  beginDiagnosticOperation("cloud.sync", { domain: "meal_pickup" });
  setDiagnosticsEnabled(false);
  assert.deepEqual(openFlows(), {});
  setDiagnosticsEnabled(true);
});

test("D6: absolute business times are kept as ages, a due time as the time left", () => {
  reset();
  const now = Date.now();
  writeDiagnostic("refresh.stage.skipped", {
    statusEventAtMs: now - 60_000, headlineAtMs: now - 120_000, detailAtMs: 0,
    providerNextDueAtMs: now + 30_000, listEventAtMs: now + 5_000,
  });
  const entry = readDiagnostics()[0];
  const lineAt = Date.parse(entry.at);
  assert.equal(entry.details.statusEventAtMs, undefined);
  assert.equal(entry.details.statusEventAgeMs, lineAt - (now - 60_000));
  assert.equal(entry.details.headlineAgeMs, lineAt - (now - 120_000));
  assert.equal(entry.details.detailAgeMs, undefined, "an absent time is left out");
  assert.equal(entry.details.providerNextDueInMs, now + 30_000 - lineAt);
  assert.equal(entry.details.listEventAgeMs, 0, "a time after the line counts as zero");
  assert.doesNotMatch(JSON.stringify(entry.details), /AtMs/);
});

test("D7: an order's handle is local, keyed and not the unsalted order-number hash", () => {
  reset();
  const order = "interface5:account:3201234567890";
  const handle = projectionOwnerFingerprint(order);
  assert.match(handle, /^[0-9a-f]{12}$/);
  assert.notEqual(handle, sha256(order).slice(0, 12), "the handle cannot be matched against an order-number hash");
  assert.equal(projectionOwnerFingerprint(order), handle, "the same order reads alike within one log");
  assert.notEqual(projectionOwnerFingerprint(`${order}1`), handle);
  assert.ok(typeof memory.get(HANDLE_KEY) === "string", "the key stays on this device");
  clearDiagnostics();
  assert.notEqual(projectionOwnerFingerprint(order), handle, "a cleared log starts with a new key");
  setDiagnosticsEnabled(false);
  assert.equal(diagnosticHandle("order", order), "", "no handle while recording is off");
  setDiagnosticsEnabled(true);
});

test("D11: a JD web page is a closed kind and older host lines read back as one", () => {
  reset();
  assert.equal(jdDiagnosticPage("https:", "plogin.m.jd.com"), "jd_login");
  assert.equal(jdDiagnosticPage("https:", "my.m.jd.com"), "jd_account");
  assert.equal(jdDiagnosticPage("https:", "trade.m.jd.com"), "jd_orders");
  assert.equal(jdDiagnosticPage("https:", "item.m.jd.com"), "jd_other");
  assert.equal(jdDiagnosticPage("https:", "synthetic.example"), "web_other");
  assert.equal(jdDiagnosticPage("webkit-error:", "x"), "error_page");
  assert.equal(jdDiagnosticPage("blob:", ""), "local_page");
  assert.equal(jdDiagnosticPage("javascript:", ""), "other");
  writeDiagnostic("platform.jingdong.sync.failed", { jdPage: "https:passport.jd.com" });
  writeDiagnostic("platform.jingdong.sync.failed", { jdPage: "synthetic-private-value" });
  const [unknown, legacy] = readDiagnostics();
  assert.equal(legacy.details.jdPage, "jd_login");
  assert.equal(unknown.details.jdPage, undefined);
});

test("D124: the paid stage's third attempt is kept on the recognition line", () => {
  reset();
  writeDiagnostic("carrier.recognition.completed", { attempt: 3, result: "failed" }, "warning");
  writeDiagnostic("carrier.recognition.completed", { attempt: 4, result: "failed" }, "warning");
  const [fourth, third] = readDiagnostics();
  assert.equal(third.details.attempt, 3);
  assert.equal(fourth.details.attempt, undefined);
});

function manualRow(id: string, semantic: Shipment["timeline"]["semantic"], sender = false): Shipment {
  return {
    identity: { id: `interface5:manual:${id}`, sourceId: id, bindingSource: "interface5", sourceOwner: "manual",
      phoneTail: "", courierCode: "", companyName: "Synthetic", manuallyAdded: true, createdAtMs: NOW,
      ...(sender ? { sender: true } : {}) },
    timeline: { provider: "v6_query", waybill: id, courierCode: "", companyName: "Synthetic", semantic,
      statusEventAtMs: NOW, latestTimeText: "", latestDetail: "Synthetic", tracks: [], successAtMs: NOW },
    updatedAtMs: NOW,
  } as Shipment;
}

function seedState(shipments: Shipment[]): AppState {
  const state: AppState = { ...emptyState(), revision: 1, updatedAtMs: NOW, shipments, pendingNotifications: [] };
  const payload = JSON.stringify(state);
  memory.set("pipi_deliveries_state_v1", JSON.stringify({ schema: 3, checksum: sha256(payload), payload }));
  return state;
}

test("D131: a row's list presentation change and a first sighting are recorded with the tail only", () => {
  reset();
  seedState([manualRow("SYNTH7054A", "TRANSIT", true)]);
  clearDiagnostics();
  const before = loadState(NOW);
  const changed = { ...before.shipments[0]!, timeline: { ...before.shipments[0]!.timeline, semantic: "DELIVERY" as const },
    updatedAtMs: NOW + 1 };
  saveState({ ...before, shipments: [changed, manualRow("SYNTH7055B", "TRANSIT")] }, NOW + 1, { notifyChanges: true });
  const rows = readDiagnostics().filter(entry => entry.event === "express.row.changed" ||
    entry.event === "express.row.mismatch");
  const sent = rows.find(entry => entry.details.waybillTail === "054A");
  assert.ok(sent, "the changed row is recorded");
  assert.equal(sent.details.result, "changed");
  assert.equal(sent.details.statusSemantic, "DELIVERY");
  assert.equal(sent.details.senderRole, true, "the 寄 mark is recorded");
  assert.equal(typeof sent.details.detailStatusSemantic, "string");
  assert.equal(rows.find(entry => entry.details.waybillTail === "055B")?.details.result, "added");
  const decisions = readDiagnostics().filter(entry => entry.event === "notification.decision");
  const firstSeen = decisions.find(entry => entry.details.skipReason === "first_seen");
  assert.equal(firstSeen?.details.records, 1, "first sightings are one count per commit");
  assert.equal(firstSeen?.details.pushOrigin, "app_local");
  const text = JSON.stringify(readDiagnostics());
  assert.doesNotMatch(text, /SYNTH7054A|SYNTH7055B|interface5:manual/, "no waybill or row id is written");

  // The same presentation written again is not repeated.
  clearDiagnostics();
  const current = loadState(NOW + 2);
  saveState({ ...current, shipments: current.shipments.map(row => ({ ...row, updatedAtMs: row.updatedAtMs + 1 })) },
    NOW + 2, { notifyChanges: true });
  assert.equal(readDiagnostics().filter(entry => entry.event === "express.row.changed").length, 0);
});

test("D131: the outbox drain records what became of each event", async (t) => {
  // The rows are dated at the storage mock's clock; the drain reads them at that time.
  const realNow = Date.now;
  Date.now = () => NOW + 10;
  t.after(() => { Date.now = realNow; });
  reset();
  const delivered = manualRow("SYNTHDELIV1", "DELIVERY");
  const muted = manualRow("SYNTHMUTED2", "COMPLETED");
  const state = seedState([delivered, muted]);
  const pending = [delivered, muted].map(row => ({ id: `event-${row.identity.id}`, shipmentId: row.identity.id,
    semantic: row.timeline.semantic, title: "Synthetic", body: "Synthetic", iconName: null }));
  const payload = JSON.stringify({ ...state, pendingNotifications: pending });
  memory.set("pipi_deliveries_state_v1", JSON.stringify({ schema: 3, checksum: sha256(payload), payload }));
  saveNotificationStatuses(["DELIVERY"]);
  clearDiagnostics();
  await replayPendingShipmentNotifications(() => true, { flowId: createDiagnosticFlowId("refresh") });
  const decisions = readDiagnostics().filter(entry => entry.event === "notification.decision");
  const byTail = new Map(decisions.map(entry => [entry.details.waybillTail, entry.details]));
  assert.equal(byTail.get("LIV1")?.result, "notified");
  assert.equal(byTail.get("TED2")?.result, "suppressed");
  assert.equal(byTail.get("TED2")?.skipReason, "channel_off");
  assert.ok(decisions.every(entry => entry.details.pushOrigin === "app_local" && /^\d+$/.test(String(entry.details.flowId))));
});

test("D126: a saved notification choice is recorded as a count", () => {
  reset();
  saveNotificationStatuses(["DELIVERY", "WAITING_PICKUP"]);
  const line = readDiagnostics().find(entry => entry.event === "settings.changed");
  assert.equal(line?.details.stage, "notifications");
  assert.equal(line?.details.records, 2);
});
