import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { installNativeSharedFiles } from "./shared-file-native";
import { sharedData, publishSharedData, withSharedFileTransaction, SharedCommitOutcomeUnknown } from "../services/shared-file-transaction";
import { acquireDurableRefreshLease } from "../services/refresh-runtime-state";
import { emptyState, saveState, loadState, commitRefreshState, commitTargetShipmentRefresh } from "../services/storage";
const NOW = Date.UTC(2026, 8, 8, 6);
function updated(row: any, detail: string) {
  const timeline = { ...row.timeline, latestDetail: detail, latestTimeText: "2026-09-08 14:00:00",
    statusEventAtMs: NOW, tracks: [{ ...row.timeline.tracks[0], timeMs: NOW, timeText: "2026-09-08 14:00:00", detail }, ...row.timeline.tracks] };
  return { ...row, updatedAtMs: NOW + 1, timeline, manualTimelines: [timeline] };
}
if (!isMainThread) {
  Date.now = () => NOW;
  let armed = false;
  const barrier = new Int32Array(workerData.barrier);
  installNativeSharedFiles(workerData.root, p => {
    if (armed && workerData.mode !== "ambiguous" && p.endsWith("/next")) {
      armed = false;
      parentPort!.postMessage({ paused: true });
      if (Atomics.wait(barrier, 0, 0, 10_000) === "timed-out") throw new Error("Barrier timeout");
    }
  }, p => {
    if (armed && workerData.mode === "ambiguous" && p.endsWith("/next")) {
      armed = false;
      parentPort!.postMessage({ paused: true });
      if (Atomics.wait(barrier, 0, 0, 10_000) === "timed-out") throw new Error("Barrier timeout");
      throw new Error("synthetic lost acknowledgement after retirement");
    }
  });
  if (workerData.mode === "ambiguous") {
    const base = loadState(NOW + 1);
    armed = true;
    try {
      saveState({ ...base, shipments: base.shipments.map(s => ({ ...s, note: "accepted-before-lost-ack" })) }, NOW + 1);
      parentPort!.postMessage({ result: true });
    } catch (error: any) {
      if (!error.message.includes("保存失败")) throw error;
      parentPort!.postMessage({ result: false });
    }
  } else if (workerData.mode === "release") {
    const lease = acquireDurableRefreshLease("shared", 1_000)!;
    armed = true;
    lease.release();
    parentPort!.postMessage({ result: true });
  } else if (workerData.mode === "fenced") {
    const lease = acquireDurableRefreshLease("state-fence", 1_000)!;
    const base = loadState(NOW);
    armed = true;
    const commit = commitTargetShipmentRefresh(base, updated(base.shipments[0], "expired-owner"), NOW + 1,
      { isCurrent: lease.isCurrent });
    parentPort!.postMessage({ result: commit.applied });
  } else if (workerData.mode === "snapshot") {
    const base = loadState(NOW);
    armed = true;
    try {
      saveState({ ...base, shipments: [updated(base.shipments[0], "stale-snapshot"), ...base.shipments.slice(1)] }, NOW + 1);
      parentPort!.postMessage({ result: true });
    } catch (error: any) {
      if (!error.message.includes("state changed")) throw error;
      parentPort!.postMessage({ result: false });
    }
  } else if (workerData.mode === "raw") {
    armed = true;
    try {
      withSharedFileTransaction(() => publishSharedData({ refresh: { counter: Number((sharedData().refresh as any)?.counter || 0) + 1 } }));
      parentPort!.postMessage({ result: true });
    } catch (error) {
      if (!(error instanceof SharedCommitOutcomeUnknown)) throw error;
      parentPort!.postMessage({ result: false });
    }
  } else if (workerData.mode === "full") {
    const base = loadState(NOW);
    const incoming = updated(base.shipments[0], "full-update");
    armed = true;
    const commit = commitRefreshState(base, { ...base, shipments: [incoming, ...base.shipments.slice(1)] }, "interface5", NOW + 1);
    parentPort!.postMessage({ result: commit.applied });
  } else {
    armed = true;
    const lease = acquireDurableRefreshLease("shared", 120_000);
    parentPort!.postMessage({ result: Boolean(lease) });
  }
} else {
  const audit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../project-data/audits/ios-atomic-state-20260913");
  fs.mkdirSync(audit, { recursive: true });
  const root = fs.mkdtempSync(audit + "/native-");
  Date.now = () => NOW;
  installNativeSharedFiles(root);
  const workers: Worker[] = [];
  function start(mode: string) {
    const barrier = new SharedArrayBuffer(4);
    const w = new Worker(new URL(import.meta.url), { workerData: { root, barrier, mode } });
    workers.push(w);
    let resolvePaused: () => void;
    let resolveResult: (value: boolean) => void;
    const paused = new Promise<void>((r, reject) => { resolvePaused = r; w.once("error", reject); });
    const result = new Promise<boolean>((r, reject) => { resolveResult = r; w.once("error", reject); });
    w.on("message", value => { if (value.paused) resolvePaused(); else resolveResult(value.result); });
    return { paused, result, stop: () => w.terminate(), resume: () => { Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0); } };
  }
  function reset() { fs.rmSync(root, { recursive: true }); fs.mkdirSync(root); sharedData(); }
  try {
    sharedData();
    const selected = process.env.PIPI_ATOMIC_CASE;
    if (!selected || selected === "claim") {
    const a = start("claim"), b = start("claim");
    await Promise.all([a.paused, b.paused]);
    a.resume(); const first = await a.result;
    b.resume();
    assert.equal([first, await b.result].filter(Boolean).length, 1, "exactly one independent runtime gets the lease");
    }
    reset();
    if (!selected || selected === "release") {
    const releasing = start("release");
    await releasing.paused;
    Date.now = () => NOW + 2_000;
    const replacement = acquireDurableRefreshLease("shared", 120_000)!;
    assert.ok(replacement);
    releasing.resume(); await releasing.result;
    assert.equal(replacement.isCurrent(), true, "old release cannot erase replacement");
    }
    Date.now = () => NOW;
    reset();
    if (!selected || selected === "full") {
    const shipment = (id: string) => ({
      identity: { id, bindingSource: "interface5", sourceOwner: "manual", sourceId: `owner:${id}`, phoneTail: "", courierCode: "TEST", rawCourierCode: "TEST", companyName: "Synthetic", manuallyAdded: true, createdAtMs: NOW - 60_000 },
      timeline: { provider: "test", waybill: `WB${id}`, courierCode: "TEST", companyName: "Synthetic", semantic: "TRANSIT", statusEventAtMs: NOW - 60_000, latestTimeText: "2026-09-08 13:59:00", latestDetail: "Initial", tracks: [{ timeText: "2026-09-08 13:59:00", timeMs: NOW - 60_000, detail: "Initial", statusCode: "", raw: {} }], successAtMs: NOW }, updatedAtMs: NOW,
    });
    saveState({ ...emptyState(), shipments: [shipment("A"), shipment("B")] } as any, NOW);
    const full = start("full"); await full.paused;
    const base = loadState(NOW);
    const detail = commitTargetShipmentRefresh(base, updated(base.shipments[1], "detail-update"), NOW + 1);
    assert.equal(detail.applied, true);
    full.resume(); assert.equal(await full.result, true);
    const final = loadState(NOW + 1);
    assert.deepEqual(new Set(final.shipments.map(s => s.timeline.latestDetail)), new Set(["full-update", "detail-update"]));
    }
    if (!selected) {
      const fenced = start("fenced"); await fenced.paused;
      Date.now = () => NOW + 2_000;
      assert.ok(acquireDurableRefreshLease("state-fence", 120_000));
      fenced.resume(); assert.equal(await fenced.result, false, "a replaced lease fences the business CAS as well as release");
      Date.now = () => NOW;
      assert.ok(loadState(NOW + 1).shipments.every(s => s.timeline.latestDetail !== "expired-owner"));
      const snapshot = start("snapshot"); await snapshot.paused;
      const before = loadState(NOW + 1);
      assert.equal(commitTargetShipmentRefresh(before, updated(before.shipments[1], "newest-detail"), NOW + 1).applied, true);
      snapshot.resume(); assert.equal(await snapshot.result, false, "a raw snapshot cannot retry over a concurrent owner commit");
      assert.ok(loadState(NOW + 1).shipments.some(s => s.timeline.latestDetail === "newest-detail"));
      assert.ok(loadState(NOW + 1).shipments.every(s => s.timeline.latestDetail !== "stale-snapshot"));
    }
    const finalRevision = loadState(NOW + 1).revision;
    // Many metadata commits retain the authoritative state while retiring old parents.
    for (let i = 0; i < 25; i++) withSharedFileTransaction(() => publishSharedData({ refresh: { counter: i } }));
    assert.equal(loadState(NOW + 1).revision, finalRevision);
    const generations = fs.readdirSync(root + "/pipi-deliveries/transactions-v1").filter(n => /^g\d+-/.test(n));
    assert.ok(generations.length <= 5, "retirement bounds generation count and pins state backups");
    const beforeCrash = (sharedData().refresh as any).counter;
    const abandoned = start("raw"); await abandoned.paused;
    await abandoned.stop();
    assert.equal((sharedData().refresh as any).counter, beforeCrash, "a terminated writer's unpublished proposal is invisible");
    const retired = start("raw"); await retired.paused;
    for (let i = 0; i < 10; i++) withSharedFileTransaction(() => publishSharedData({ refresh: { counter: 100 + i } }));
    retired.resume(); assert.equal(await retired.result, false, "an unprovable publication outcome is not replayed");
    assert.equal((sharedData().refresh as any).counter, 109, "retired parents cannot be recreated");
    withSharedFileTransaction(() => publishSharedData({ refresh: { counter: Number((sharedData().refresh as any).counter) + 1 } }));
    assert.equal((sharedData().refresh as any).counter, 110, "a fresh operation uses the latest committed value");
    if (!selected) {
      const ambiguous = start("ambiguous"); await ambiguous.paused;
      for (let i = 0; i < 10; i++) withSharedFileTransaction(() => publishSharedData({ refresh: { counter: 200 + i } }));
      ambiguous.resume(); assert.equal(await ambiguous.result, false);
      assert.ok(loadState(NOW + 1).shipments.every(s => s.note === "accepted-before-lost-ack"),
        "a retired predecessor cannot make lost acknowledgement cleanup delete the accepted state blob");
    }
    console.log("Independent runtime claim, expired release, full/detail CAS and retired-parent tests passed");
  } finally {
    await Promise.all(workers.map(w => w.terminate()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
