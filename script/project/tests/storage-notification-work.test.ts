import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { beforeEach, test } from "node:test";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { memory, NOW, sha256 } from "./state-storage-mock.ts";
import { installNativeSharedFiles } from "./shared-file-native.ts";
import type { AppState, Shipment } from "../models.ts";
import {
  acknowledgeShipmentNotification,
  commitTargetShipmentRefresh,
  deferShipmentNotification,
  emptyState,
  loadState,
  saveState,
} from "../services/storage.ts";

const PRIMARY = "pipi_deliveries_state_v1";
const BACKUP = "pipi_deliveries_state_backup_v1";
const audit = fileURLToPath(new URL("../../../../project-data/audits/20261103-ios-refresh-lag/", import.meta.url));
const memoryBridge = Object.fromEntries(
  ["Path", "FileManager", "Data", "Crypto", "Storage", "Keychain"].map(key => [key, (globalThis as any)[key]]),
);
const operations = { ack: acknowledgeShipmentNotification, defer: deferShipmentNotification };
type Operation = keyof typeof operations;
type Work = {
  latestStateValidations: number;
  fullStateEncodes: number;
  statePublications: number;
  primaryMirrorWrites: number;
  backupMirrorWrites: number;
};

function shipment(index: number, trackCount = 2): Shipment {
  const id = `SYNTHETIC${String(index).padStart(6, "0")}`;
  const waybill = `WB${id}`;
  return {
    identity: {
      id: `interface5:manual:${waybill}`, bindingSource: "interface5", sourceOwner: "manual", sourceId: waybill,
      phoneTail: "", courierCode: "SF", rawCourierCode: "SF", companyName: "Synthetic Carrier",
      manuallyAdded: true, createdAtMs: NOW - 3_600_000,
    },
    timeline: {
      provider: "test", waybill, courierCode: "SF", companyName: "Synthetic Carrier",
      semantic: "TRANSIT", structuredStatus: true, statusEventAtMs: NOW - 60_000,
      latestTimeText: "2026-09-08 13:59:00", latestDetail: "Synthetic transit", successAtMs: NOW,
      tracks: Array.from({ length: trackCount }, (_, track) => ({
        timeText: "2026-09-08 13:59:00", timeMs: NOW - (track + 1) * 60_000,
        detail: "Synthetic transit", statusCode: "", raw: { synthetic: "x".repeat(48) },
      })),
    },
    note: "Original synthetic note", updatedAtMs: NOW,
  };
}

function seed(rowCount = 2, eventCount = 3, trackCount = 2): AppState {
  const rows = Array.from({ length: rowCount }, (_, index) => shipment(index, trackCount));
  const state: AppState = {
    ...emptyState(), revision: 1, updatedAtMs: NOW, shipments: rows,
    pendingNotifications: Array.from({ length: eventCount }, (_, index) => ({
      id: `event-${index}`, shipmentId: rows[index % rows.length].identity.id,
      semantic: "DELIVERY", title: "Synthetic", body: "Synthetic", iconName: null,
    })),
  };
  const payload = JSON.stringify(state);
  Storage.set(PRIMARY, JSON.stringify({ schema: 3, checksum: sha256(payload), payload }));
  return saveState(loadState(NOW), NOW);
}

function measure<T>(operation: () => T): { value: T; work: Work; elapsedMs: number } {
  let latestPayload = "";
  try { latestPayload = JSON.parse(String(Storage.get(PRIMARY))).payload; } catch { /* unreadable fixture */ }
  const work: Work = {
    latestStateValidations: 0, fullStateEncodes: 0, statePublications: 0,
    primaryMirrorWrites: 0, backupMirrorWrites: 0,
  };
  const originalHash = Crypto.sha256;
  const originalStringify = JSON.stringify;
  const originalWrite = FileManager.writeAsStringSync;
  const originalSet = Storage.set;
  Crypto.sha256 = ((value: unknown) => {
    if (latestPayload && value === latestPayload) work.latestStateValidations++;
    return originalHash(value as any);
  }) as typeof Crypto.sha256;
  JSON.stringify = ((value: any, replacer: any, space: any) => {
    if (value?.version === 2 && Array.isArray(value.shipments) && Array.isArray(value.bindings)) {
      work.fullStateEncodes++;
    }
    return originalStringify(value, replacer, space);
  }) as typeof JSON.stringify;
  FileManager.writeAsStringSync = ((name: string, value: string) => {
    if (name.includes("/transactions-v1/") && name.endsWith("/state.json")) work.statePublications++;
    return originalWrite(name, value);
  }) as typeof FileManager.writeAsStringSync;
  Storage.set = ((key: string, value: unknown, options: any) => {
    if (key === PRIMARY) work.primaryMirrorWrites++;
    if (key === BACKUP) work.backupMirrorWrites++;
    return originalSet(key, value, options);
  }) as typeof Storage.set;
  const startedAt = performance.now();
  try { return { value: operation(), work, elapsedMs: performance.now() - startedAt }; }
  finally {
    Crypto.sha256 = originalHash;
    JSON.stringify = originalStringify;
    FileManager.writeAsStringSync = originalWrite;
    Storage.set = originalSet;
  }
}

function assertMirrors(state: AppState): void {
  assert.equal(Storage.get(PRIMARY), Storage.get(BACKUP));
  assert.deepEqual(JSON.parse(JSON.parse(String(Storage.get(PRIMARY))).payload), state);
  assert.deepEqual(loadState(NOW + 2), state, "the acknowledged/rotated event is durably readable");
}

if (!isMainThread) {
  Date.now = () => NOW + 2;
  const barrier = new Int32Array(workerData.barrier);
  let armed = true;
  let preparedEventIds: string[] | undefined;
  installNativeSharedFiles(workerData.root, name => {
    if (armed && name.endsWith("/next")) {
      armed = false;
      parentPort!.postMessage({ paused: true, preparedEventIds });
      if (Atomics.wait(barrier, 0, 0, 10_000) === "timed-out") throw new Error("Synthetic CAS barrier timed out");
    }
  });
  const write = FileManager.writeAsStringSync;
  FileManager.writeAsStringSync = ((name: string, value: string) => {
    if (name.includes("/transactions-v1/") && name.endsWith("/state.json")) {
      const proposed = JSON.parse(JSON.parse(value).payload) as AppState;
      preparedEventIds = proposed.pendingNotifications?.map(event => event.id);
    }
    return write(name, value);
  }) as typeof FileManager.writeAsStringSync;
  const state = operations[workerData.operation as Operation]("event-0", NOW + 2);
  parentPort!.postMessage({ revision: state.revision });
} else if (process.env.PIPI_STORAGE_NOTIFICATION_BENCH) {
  Date.now = () => NOW;
  fs.mkdirSync(audit, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(audit, "storage-work-bench-"));
  const results: Record<string, unknown> = {};
  try {
    for (const name of Object.keys(operations) as Operation[]) {
      fs.rmSync(temporary, { recursive: true });
      fs.mkdirSync(temporary);
      installNativeSharedFiles(temporary);
      seed(64, 16, 16);
      const stateBytes = Buffer.byteLength(JSON.parse(String(Storage.get(PRIMARY))).payload);
      for (let index = 0; index < 2; index++) operations[name](`event-${index}`, NOW + 1);
      const samples = Array.from({ length: 12 }, (_, index) =>
        measure(() => operations[name](`event-${index + 2}`, NOW + 1)));
      const sorted = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b);
      results[name] = {
        stateBytes, samples: samples.length, workPerOperation: samples[0].work,
        workConsistent: samples.every(sample => JSON.stringify(sample.work) === JSON.stringify(samples[0].work)),
        medianMs: (sorted[5] + sorted[6]) / 2, maxMs: sorted.at(-1), elapsedMs: samples.map(sample => sample.elapsedMs),
      };
    }
    console.log(JSON.stringify({
      phase: process.env.PIPI_STORAGE_NOTIFICATION_BENCH,
      adapter: "Node synthetic state with real local filesystem adapters; not iOS latency evidence",
      rows: 64, tracksPerRow: 16, results,
    }, null, 2));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
} else {
  beforeEach(() => {
    Object.assign(globalThis, memoryBridge);
    memory.clear();
    Date.now = () => NOW;
  });

  for (const name of Object.keys(operations) as Operation[]) {
    test(`${name} validates its transaction-local snapshot once and keeps one durable publication`, () => {
      const before = seed();
      const { value: state, work } = measure(() => operations[name]("event-0", NOW + 1));
      assert.deepEqual(state.pendingNotifications?.map(event => event.id),
        name === "ack" ? ["event-1", "event-2"] : ["event-1", "event-2", "event-0"]);
      assert.deepEqual(state.shipments, before.shipments);
      assert.equal(state.revision, before.revision + 1);
      assertMirrors(state);
      assert.deepEqual(work, {
        latestStateValidations: 1, fullStateEncodes: 2, statePublications: 1,
        primaryMirrorWrites: 1, backupMirrorWrites: 1,
      }, "one fresh load plus the unchanged full save, without a second pre-save load");
    });

    test(`${name} of a missing event makes no state publication or mirror write`, () => {
      const before = seed();
      const { value: state, work } = measure(() => operations[name]("event-absent", NOW + 1));
      assert.deepEqual(state, before);
      assert.deepEqual(work, {
        latestStateValidations: 1, fullStateEncodes: 1, statePublications: 0,
        primaryMirrorWrites: 0, backupMirrorWrites: 0,
      });
    });

    test(`${name} cannot replace unreadable existing state`, () => {
      seed();
      for (const key of memory.keys()) {
        if (key === PRIMARY || key === BACKUP || key.startsWith("file:") &&
            (key.endsWith("/state.json") || key.includes("/state-v3-"))) {
          memory.set(key, "synthetic-invalid-state");
        }
      }
      const unreadable = new Map(memory);
      const { work } = measure(() => assert.throws(() => operations[name]("event-0", NOW + 1), /读取失败/));
      assert.equal(work.statePublications, 0);
      assert.equal(work.primaryMirrorWrites + work.backupMirrorWrites, 0);
      assert.deepEqual(memory, unreadable);
    });

    test(`${name} re-reads a foreign generation after CAS conflict and preserves its row and outbox`, { timeout: 15_000 }, async () => {
      fs.mkdirSync(audit, { recursive: true });
      const temporary = fs.mkdtempSync(path.join(audit, `storage-${name}-cas-`));
      installNativeSharedFiles(temporary);
      Date.now = () => NOW + 1;
      const before = seed();
      const barrier = new SharedArrayBuffer(4);
      const worker = new Worker(new URL(import.meta.url), { workerData: { root: temporary, barrier, operation: name } });
      let pausedResolve: (events: string[]) => void;
      let doneResolve: () => void;
      const paused = new Promise<string[]>((resolve, reject) => { pausedResolve = resolve; worker.once("error", reject); });
      const done = new Promise<void>((resolve, reject) => { doneResolve = resolve; worker.once("error", reject); });
      worker.on("message", message => { if (message.paused) pausedResolve(message.preparedEventIds); else doneResolve(); });
      try {
        assert.deepEqual(await paused, name === "ack" ? ["event-1", "event-2"] : ["event-1", "event-2", "event-0"],
          "the paused CAS must own the actual ACK/defer proposal, not a load-time healing write");
        const marked = saveState({ ...loadState(NOW + 1), shipments: before.shipments.map(row => ({
          ...row, note: "Accepted by the foreign runtime",
        })) }, NOW + 1);
        const row = shipment(0);
        const incoming: Shipment = { ...row, note: marked.shipments.find(item => item.identity.id === row.identity.id)!.note,
          timeline: { ...row.timeline,
          semantic: "DELIVERY", statusEventAtMs: NOW + 1, latestDetail: "Synthetic foreign delivery",
        }, updatedAtMs: NOW + 1 };
        const foreignCommit = commitTargetShipmentRefresh(marked, incoming, NOW + 1);
        const foreign = foreignCommit.state;
        assert.ok(foreign.shipments.every(item => item.note === "Accepted by the foreign runtime"));
        const foreignEvent = foreign.pendingNotifications?.find(event => !before.pendingNotifications?.some(old => old.id === event.id));
        assert.ok(foreignEvent, "a real concurrent storage commit must add a distinct notification obligation: " + JSON.stringify({
          applied: foreignCommit.applied,
          before: marked.shipments.map(row => ({ id: row.identity.id, semantic: row.timeline.semantic, provider: row.timeline.provider })),
          after: foreign.shipments.map(row => ({ id: row.identity.id, semantic: row.timeline.semantic, provider: row.timeline.provider })),
          pendingCount: foreign.pendingNotifications?.length,
        }));
        Atomics.store(new Int32Array(barrier), 0, 1);
        Atomics.notify(new Int32Array(barrier), 0);
        await done;
        Date.now = () => NOW + 2;
        const state = loadState(NOW + 2);
        assert.equal(state.revision, foreign.revision + 1);
        assert.equal(state.shipments[0].note, "Accepted by the foreign runtime");
        assert.ok(state.pendingNotifications?.some(event => event.id === foreignEvent.id));
        assert.equal(state.pendingNotifications?.some(event => event.id === "event-0"), name === "defer");
        assertMirrors(state);
      } finally {
        await worker.terminate();
        fs.rmSync(temporary, { recursive: true, force: true });
        Object.assign(globalThis, memoryBridge);
      }
    });
  }
}
