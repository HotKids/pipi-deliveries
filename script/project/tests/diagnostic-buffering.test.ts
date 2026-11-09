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
console.log("diagnostic buffering tests passed");
