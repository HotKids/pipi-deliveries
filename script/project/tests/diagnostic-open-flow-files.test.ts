import assert from "node:assert/strict";
import { test } from "node:test";
import { memory } from "./state-storage-mock";
import * as runtimeA from "../services/logger";
import { LEGACY_OPEN_FLOWS_KEY, OPEN_FLOWS_DIRECTORY, openFlows, setOpenFlows } from "./open-flow-markers";

// R5-NEW-11 ⑥ (fifth review, 2026-11-25): the markers of running operations (D4) are one file per flow, so runtimes
// that share the device (app, widget, App Intent, Shortcut) never rewrite each other's markers. The interleavings below
// are the ones a shared read-modify-write map loses: another runtime acting between this runtime's read and write.
const runtimeB = await import("../services/logger.ts?runtime=b") as typeof runtimeA;

function reset() {
  memory.clear();
  runtimeA.setDiagnosticsEnabled(true);
  runtimeA.clearDiagnostics();
}

/** Runs `concurrent` once, right after the next read of the marker state returns its value. */
function onNextMarkerRead(concurrent: () => void) {
  const storage = globalThis.Storage as { get: (key: string, options?: unknown) => unknown };
  const files = FileManager as unknown as { readDirectorySync: (path: string, recursive?: boolean) => string[] };
  const realGet = storage.get, realList = files.readDirectorySync;
  let armed = true;
  const fire = () => {
    if (!armed) return;
    armed = false;
    storage.get = realGet;
    files.readDirectorySync = realList;
    concurrent();
  };
  storage.get = (key, options) => {
    const value = realGet.call(storage, key, options);
    if (key === LEGACY_OPEN_FLOWS_KEY) fire();
    return value;
  };
  files.readDirectorySync = (path, recursive) => {
    const names = realList.call(files, path, recursive);
    if (path === OPEN_FLOWS_DIRECTORY) fire();
    return names;
  };
  return () => { storage.get = realGet; files.readDirectorySync = realList; };
}

test("a marker another runtime closes while this runtime opens a flow stays closed", () => {
  reset();
  const other = runtimeB.beginDiagnosticOperation("shortcut.query", {});
  assert.ok(Object.keys(openFlows()).some(key => key.startsWith(`${other.flowId}:`)));
  const restore = onNextMarkerRead(() => other("succeeded"));
  let mine: ReturnType<typeof runtimeA.beginDiagnosticOperation>;
  try { mine = runtimeA.beginDiagnosticOperation("pickup.action", {}); } finally { restore(); }
  const keys = Object.keys(openFlows());
  assert.equal(keys.some(key => key.startsWith(`${other.flowId}:`)), false, "the closed marker does not come back");
  assert.ok(keys.some(key => key.startsWith(`${mine!.flowId}:`)), "this runtime's marker is kept");
  mine!("succeeded");
  assert.deepEqual(openFlows(), {});
});

test("a marker this runtime closes while another runtime opens a flow stays closed", () => {
  reset();
  const mine = runtimeA.beginDiagnosticOperation("pickup.action", {});
  const restore = onNextMarkerRead(() => mine("succeeded"));
  let other: ReturnType<typeof runtimeB.beginDiagnosticOperation>;
  try { other = runtimeB.beginDiagnosticOperation("shortcut.query", {}); } finally { restore(); }
  assert.deepEqual(Object.values(openFlows()).map(flow => flow.event), ["shortcut.query"]);
  other!("succeeded");
});

test("runtimes that start together report an earlier runtime's unfinished flow once", () => {
  reset();
  const flowId = String(Date.now() * 1024 + 7);
  setOpenFlows({ [`${flowId}:platform.parcel_sync`]: {
    event: "platform.parcel_sync", startedAtMs: Date.now() - 3_600_000, runtime: "earlier-runtime",
  } });
  const restore = onNextMarkerRead(() => {
    runtimeB.reportUnfinishedDiagnosticFlows();
    runtimeB.flushDiagnostics();
  });
  try { runtimeA.reportUnfinishedDiagnosticFlows(); } finally { restore(); }
  runtimeA.flushDiagnostics();
  const unfinished = runtimeA.readDiagnostics().filter(entry => entry.event === "diagnostic.flow.unfinished");
  assert.equal(unfinished.length, 1, "one report for one unfinished flow");
  assert.equal(unfinished[0]!.details.flowId, flowId);
  assert.deepEqual(openFlows(), {});
});

test("markers an earlier build left in the shared map are moved into files and still reported", () => {
  reset();
  const now = Date.now();
  const stuck = String(now * 1024 + 11), running = String(now * 1024 + 12);
  memory.set(LEGACY_OPEN_FLOWS_KEY, JSON.stringify({
    [`${stuck}:cloud.sync`]: { event: "cloud.sync", startedAtMs: now - 3_600_000, runtime: "earlier-build" },
    [running]: { event: "refresh", startedAtMs: now - 60_000, runtime: "earlier-build" },
  }));
  runtimeA.reportUnfinishedDiagnosticFlows(now);
  assert.equal(memory.has(LEGACY_OPEN_FLOWS_KEY), false, "the shared map is retired");
  const unfinished = runtimeA.readDiagnostics().filter(entry => entry.event === "diagnostic.flow.unfinished");
  assert.deepEqual(unfinished.map(entry => [entry.details.flowId, entry.details.unfinishedEvent]), [[stuck, "cloud.sync"]]);
  assert.deepEqual(Object.keys(openFlows()), [`${running}:refresh`], "a recent marker waits in its own file");
  runtimeA.reportUnfinishedDiagnosticFlows(now + 20 * 60_000);
  assert.equal(runtimeA.readDiagnostics().filter(entry => entry.event === "diagnostic.flow.unfinished").length, 2);
  assert.deepEqual(openFlows(), {});
});

test("turning recording off or clearing the log drops every marker", () => {
  reset();
  runtimeA.beginDiagnosticOperation("pickup.action", {});
  runtimeB.beginDiagnosticOperation("shortcut.query", {});
  assert.equal(Object.keys(openFlows()).length, 2);
  runtimeA.clearDiagnostics();
  assert.deepEqual(openFlows(), {});
  runtimeA.beginDiagnosticOperation("pickup.action", {});
  runtimeA.setDiagnosticsEnabled(false);
  assert.deepEqual(openFlows(), {});
  runtimeA.setDiagnosticsEnabled(true);
});
