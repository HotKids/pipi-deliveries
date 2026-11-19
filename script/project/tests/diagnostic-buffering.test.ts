import assert from "node:assert/strict";
import { installSharedFileMock } from "./shared-file-mock";
import { diagnosticFiles } from "../services/diagnostic-store";

const memory = new Map<string, unknown>();
const LOG = "pipi_deliveries_diagnostic_log_v1";
let logWrites = 0;
let rejectWrites = false;
Object.assign(globalThis, { Storage: {
  get: (key: string) => memory.get(key) ?? null,
  set: (key: string, value: unknown) => { if (key === LOG) { logWrites++; if (rejectWrites) throw new Error("synthetic denied write"); } memory.set(key, structuredClone(value)); return true; },
  remove: (key: string) => memory.delete(key),
} });
installSharedFileMock(memory);
const nativePublish = FileManager.createLinkSync, nativeWrite = FileManager.writeAsStringSync;
FileManager.createLinkSync = (path, target) => { if (path.endsWith(".ready")) logWrites++; return nativePublish(path, target); };
FileManager.writeAsStringSync = (path, text) => { if (rejectWrites) throw new Error("synthetic denied write"); return nativeWrite(path, text); };
const rawEntries = () => diagnosticFiles().map(row => row.value as { event: string });
const logger = await import("../services/logger");
logger.setDiagnosticsEnabled(true);
logger.clearDiagnostics();
for (let index = 0; index < 19; index++) {
  logger.writeDiagnostic("refresh.stage.started", { flowId: "buffer-test", attempt: index,
    phone: "synthetic-private-value" } as never);
}
assert.equal(logWrites, 0, "single diagnostics are buffered rather than rewriting shared storage");
logger.writeDiagnostic("refresh.stage.started", { flowId: "buffer-test", attempt: 19 });
assert.equal(logWrites, 1, "the size threshold makes buffered records durable");
assert.equal(rawEntries().length, 20);
logger.writeDiagnostic("refresh.stage.started", { flowId: "buffer-test", attempt: 20 });
await Promise.resolve();
assert.equal(logWrites, 2, "the end of the current tick flushes a partial batch");
assert.equal(logger.diagnosticText().includes("synthetic-private-value"), false);

logger.clearDiagnostics();
logWrites = 0;
logger.writeDiagnostic("refresh.started", { flowId: "terminal-buffer" });
logger.writeDiagnostic("refresh.stage.started", { flowId: "terminal-buffer" });
logger.writeDiagnostic("refresh.succeeded", { flowId: "terminal-buffer" });
assert.equal(logWrites, 1, "a refresh terminal record flushes its preceding stages synchronously");
assert.deepEqual(rawEntries().map(entry => entry.event), [
  "refresh.started", "refresh.stage.started", "refresh.succeeded",
]);

logger.clearDiagnostics();
logWrites = 0;
logger.writeDiagnostic("refresh.started", { flowId: "disabled-buffer" });
logger.setDiagnosticsEnabled(false);
await Promise.resolve();
assert.equal(logWrites, 0, "disabling recording discards pending records without writing them");
logger.setDiagnosticsEnabled(true);
assert.deepEqual(logger.readDiagnostics(), []);
logger.writeDiagnostic("refresh.started", { flowId: "cleared-buffer" });
logger.clearDiagnostics();
await Promise.resolve();
assert.deepEqual(logger.readDiagnostics(), [], "a queued flush cannot restore a cleared log");

logger.writeDiagnostic("refresh.started", { flowId: "foreign-switch" });
memory.set("pipi_deliveries_diagnostic_enabled_v1", false);
logWrites = 0;
await Promise.resolve();
assert.equal(logWrites, 0, "a switch disabled by another host also discards this runtime's pending records");
logger.setDiagnosticsEnabled(true);
assert.deepEqual(logger.readDiagnostics(), []);

const foreign = await import("../services/logger.ts?runtime=foreign-buffer");
logger.writeDiagnostic("refresh.started", { flowId: "local-buffer" });
foreign.writeDiagnosticBatch("refresh.started", [{ flowId: "foreign-buffer" }]);
logger.flushDiagnostics();
assert.deepEqual(logger.readDiagnostics().map(entry => entry.details.flowId), ["local-buffer", "foreign-buffer"],
  "a flush reads the current shared log instead of an earlier process-local snapshot");
logger.clearDiagnostics();
rejectWrites = true;
assert.doesNotThrow(() => logger.writeDiagnosticBatch("refresh.stage.started", [{ flowId: "retry-buffer" }]));
rejectWrites = false;
assert.equal(logger.readDiagnostics()[0]?.details.flowId, "retry-buffer",
  "an optional failed flush can retry its bounded sanitized records at the next read");

logger.clearDiagnostics();
const missingFiles = await import("../services/logger.ts?runtime=missing-file-api");
const fileApi = (globalThis as any).FileManager;
delete (globalThis as any).FileManager;
missingFiles.writeDiagnostic("runtime.capabilities", { runtimeHost: "widget", sharedFilesAvailable: false });
assert.equal(missingFiles.readDiagnostics()[0]?.event, "runtime.capabilities",
  "a missing file bridge keeps its bounded sanitized capability warning available for export");
(globalThis as any).FileManager = fileApi;
missingFiles.writeDiagnostic("refresh.started", { flowId: "fresh-known-epoch" });
missingFiles.flushDiagnostics();
assert.deepEqual(missingFiles.readDiagnostics().map(entry => entry.details.flowId), ["fresh-known-epoch"],
  "an unknown old buffer cannot be assigned to an already-cleared epoch by the next new line");

logger.clearDiagnostics();
logger.startAppDiagnosticWrites();
let syncRows = 0;
let asyncRows = 0;
let beforeRowWrite: (() => Promise<void>) | undefined;
Object.assign(FileManager, {
  exists: async (...args: Parameters<typeof FileManager.existsSync>) => FileManager.existsSync(...args),
  readDirectory: async (...args: Parameters<typeof FileManager.readDirectorySync>) => FileManager.readDirectorySync(...args),
  readAsString: async (...args: Parameters<typeof FileManager.readAsStringSync>) => FileManager.readAsStringSync(...args),
  createDirectory: async (...args: Parameters<typeof FileManager.createDirectorySync>) => FileManager.createDirectorySync(...args),
  remove: async (...args: Parameters<typeof FileManager.removeSync>) => FileManager.removeSync(...args),
  writeAsStringSync(path: string, value: string) {
    if (/\/r\d+\.json$/.test(path)) syncRows++;
    nativeWrite(path, value);
  },
  async writeAsString(path: string, value: string) {
    if (/\/r\d+\.json$/.test(path)) {
      asyncRows++;
      await beforeRowWrite?.();
    }
    nativeWrite(path, value);
  },
});
logger.writeDiagnosticBatch("refresh.stage.started", Array.from({ length: 20 }, () => ({ flowId: "app-write" })));
logger.writeDiagnostic("refresh.succeeded", { flowId: "app-write" });
assert.equal(syncRows + asyncRows, 0, "app diagnostics must return before beginning native row writes");
await logger.drainAppDiagnostics();
assert.equal(syncRows, 0, "the app host must use the asynchronous row writer");
assert.equal(asyncRows, 21);
assert.equal(rawEntries().at(-1)?.event, "refresh.succeeded");

let continueWrites!: () => void;
let writeStarted!: () => void;
const writing = new Promise<void>(resolve => { writeStarted = resolve; });
const pendingRow = new Promise<void>(resolve => { continueWrites = resolve; });
beforeRowWrite = () => { writeStarted(); return pendingRow; };
logger.writeDiagnosticBatch("refresh.started", [{ flowId: "app-clear-race" }]);
await writing;
logger.clearDiagnostics();
logger.writeDiagnosticBatch("refresh.started", [{ flowId: "app-after-clear" }]);
beforeRowWrite = undefined;
continueWrites();
await logger.drainAppDiagnostics();
assert.deepEqual(logger.readDiagnostics().map(entry => entry.details.flowId), ["app-after-clear"],
  "a native write in flight at clear must not publish old rows or drop new rows");
logger.clearDiagnostics();
const finish = logger.beginDiagnosticOperation("platform.cabinet", { sourceProvider: "fengchao", stage: "cabinet_open" });
finish("cancelled");
finish("accepted");
await logger.drainAppDiagnostics();
const operation = logger.readDiagnostics().reverse();
assert.deepEqual(operation.map(entry => entry.event), ["platform.cabinet.started", "platform.cabinet.completed"]);
assert.ok(operation[0].details.flowId);
assert.equal(operation[0].details.flowId, operation[1].details.flowId);
assert.equal(operation[1].details.sourceProvider, "fengchao");
assert.equal(operation[1].details.result, "cancelled");
assert.ok(Number(operation[1].details.durationMs) >= 0);
logger.clearDiagnostics();
logger.beginDiagnosticOperation("meal.sync", { stage: "cloud_record_sync" }, false);
const finishSync = logger.beginDiagnosticOperation("cloud.pdd", { sourceProvider: "pinduoduo" }, false);
finishSync("unavailable", { stage: "cloud_pdd_pull" }, "warning");
await logger.drainAppDiagnostics();
const summaries = logger.readDiagnostics();
assert.deepEqual(summaries.map(entry => entry.event), ["cloud.pdd.completed"]);
assert.equal(summaries[0].level, "warning");
assert.equal(summaries[0].details.stage, "cloud_pdd_pull");
console.log("diagnostic buffering tests passed");
