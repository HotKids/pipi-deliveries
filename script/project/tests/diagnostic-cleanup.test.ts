import assert from "node:assert/strict";
import { memory } from "./state-storage-mock";
import {
  changedSinceLastLogged, clearDiagnostics, flushDiagnostics, readDiagnostics, REPEAT_RELOG_MS, setDiagnosticsEnabled,
} from "../services/logger";
import { performShipmentCompletion, performShipmentDeletion } from "../services/shipment-actions";
import type { AppState } from "../models";

// 2026-11-12 诊断日志清理（与 Pipi 同一规则）：内容没变的行不再每轮重复写；变了马上写；没变的最多每 6 小时再写一次。
{
  const now = 1_000_000;
  assert.equal(changedSinceLastLogged("row-a", "f1", now), true, "first sighting is written");
  assert.equal(changedSinceLastLogged("row-a", "f1", now + 1_000), false, "unchanged line is collapsed");
  assert.equal(changedSinceLastLogged("row-a", "f2", now + 2_000), true, "changed content is written at once");
  assert.equal(changedSinceLastLogged("row-a", "f2", now + 2_000 + REPEAT_RELOG_MS), true, "relogged after six hours");
  assert.equal(changedSinceLastLogged("row-b", "f2", now), true, "keys are independent");
  memory.clear();
  setDiagnosticsEnabled(true);
  clearDiagnostics();
  assert.equal(changedSinceLastLogged("row-a", "f2", now + 3_000 + REPEAT_RELOG_MS), true, "clearing the log forgets keys");
}

// 右滑签收与删除的结果写进诊断日志；只记动作、结果、耗时与错误分类，不记行 id。
{
  memory.clear();
  setDiagnosticsEnabled(true);
  const state = { shipments: [] } as unknown as AppState;
  const deps = { mutate: () => state, pruneRoutes: () => {}, reloadWidgets: () => {} };
  assert.equal(performShipmentCompletion("secret-row-id", deps).ok, true);
  assert.equal(performShipmentDeletion("secret-row-id", {
    ...deps, mutate: () => { throw new Error("保存失败"); },
  }).ok, false);
  flushDiagnostics();
  const entries = readDiagnostics();
  const completed = entries.find((entry) => entry.event === "shipment.complete.succeeded");
  const failed = entries.find((entry) => entry.event === "shipment.delete.failed");
  assert.ok(completed, "a successful sign-off is logged");
  assert.equal(completed!.level, "info");
  assert.ok(failed, "a failed deletion is logged");
  assert.equal(failed!.level, "error");
  assert.equal(failed!.details.errorCategory, "storage");
  assert.equal(JSON.stringify(entries).includes("secret-row-id"), false, "the row id is never logged");
}

// I-02: flushDiagnostics() prunes over-cap (>200) and expired batches via meta.json ONLY with zero rXXXX.json reads.
{
  memory.clear();
  setDiagnosticsEnabled(true);
  clearDiagnostics();
  const originalRead = FileManager.readAsStringSync;
  let recordReadsOnFlush = 0;
  FileManager.readAsStringSync = ((path: string) => {
    if (/\/r[0-9]{4}\.json$/.test(path)) recordReadsOnFlush++;
    return originalRead(path);
  }) as typeof FileManager.readAsStringSync;
  try {
    for (let batch = 0; batch < 12; batch++) {
      for (let i = 0; i < 20; i++) {
        performShipmentCompletion(`row-${batch}-${i}`, {
          mutate: () => ({ shipments: [] } as unknown as AppState),
          pruneRoutes: () => {},
          reloadWidgets: () => {},
        });
      }
      flushDiagnostics();
    }
    assert.equal(recordReadsOnFlush, 0, "flush path must perform zero reads of rXXXX.json record files");
  } finally {
    FileManager.readAsStringSync = originalRead;
  }
  const exported = readDiagnostics();
  assert.equal(exported.length, 200, "readDiagnostics still exports bounded 200 newest entries");
}

console.log("diagnostic cleanup tests passed");
