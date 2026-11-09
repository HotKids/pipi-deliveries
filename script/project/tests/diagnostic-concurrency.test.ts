import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const LOG = "pipi_deliveries_diagnostic_log_v1";
const role = process.argv[2] || "parent";
const audit = resolve(here, "../../../../project-data/audits/20261109-ios-bot-mcp-review");
fs.mkdirSync(audit, { recursive: true });
const root = process.argv[3] || fs.mkdtempSync(join(audit, "diagnostic-concurrency-"));
const shared = join(root, "group");
fs.mkdirSync(shared, { recursive: true });
let barrierEntered = false;
let lostAcknowledgement = false;
function exists(path: string): boolean {
  try { fs.lstatSync(path); return true; } catch { return false; }
}
Object.assign(globalThis, {
  UUID: { string: randomUUID },
  FileManager: {
    appGroupDocumentsDirectory: shared,
    createDirectorySync(path: string, recursive = false) { fs.mkdirSync(path, { recursive }); },
    existsSync: exists,
    isFileSync: (path: string) => fs.statSync(path).isFile(),
    isLinkSync: (path: string) => exists(path) && fs.lstatSync(path).isSymbolicLink(),
    destinationOfSymbolicLink: (path: string) => fs.readlinkSync(path),
    createLinkSync(path: string, target: string) {
      if (role === "crash" && path.endsWith(".ready")) process.exit(0);
      fs.symlinkSync(target, path);
      if (role === "ack-lost" && path.endsWith(".ready") && !lostAcknowledgement) {
        lostAcknowledgement = true;
        throw new Error("Synthetic lost publication acknowledgement");
      }
    },
    readDirectorySync: (path: string) => fs.readdirSync(path),
    readAsStringSync: (path: string) => fs.readFileSync(path, "utf8"),
    writeAsStringSync(path: string, text: string) {
      fs.writeFileSync(path, text);
      if (role.startsWith("clear-") && /\.clear\.[a-z0-9]+\.pending$/.test(path)) {
        fs.writeFileSync(join(root, `${role}.ready`), "");
        const until = Date.now() + 5_000;
        while (!exists(join(root, "clear-A.ready")) || !exists(join(root, "clear-B.ready"))) {
          if (Date.now() >= until) throw new Error("Synthetic clear barrier timed out");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
    },
    removeSync: (path: string) => fs.rmSync(path, { recursive: true }),
    renameSync(path: string, target: string) {
      if (exists(target)) throw new Error("Synthetic destination already exists");
      fs.renameSync(path, target);
    },
  },
  Storage: {
    get(key: string) {
      const file = join(root, `${key}.json`);
      const value = exists(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
      if (role.startsWith("writer-") && key === LOG && !barrierEntered) {
        barrierEntered = true;
        fs.writeFileSync(join(root, `${role}.ready`), "");
        const until = Date.now() + 5_000;
        while (!exists(join(root, "writer-A.ready")) || !exists(join(root, "writer-B.ready"))) {
          if (Date.now() >= until) throw new Error("Synthetic append barrier timed out");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
      return value;
    },
    set(key: string, value: unknown) {
      const file = join(root, `${key}.json`);
      const pending = `${file}.${role}.pending`;
      fs.writeFileSync(pending, JSON.stringify(value));
      fs.renameSync(pending, file);
      return true;
    },
    remove(key: string) { fs.rmSync(join(root, `${key}.json`), { force: true }); },
  },
});

if (role !== "parent") {
  const logger = await import("../services/logger");
  if (role.startsWith("clear")) logger.clearDiagnostics();
  else if (role === "late-buffer" || role === "late-read-without-files") {
    logger.writeDiagnostic("refresh.started", { flowId: "pre-clear-buffer" });
    fs.writeFileSync(join(root, `${role}.ready`), "");
    const until = Date.now() + 8_000;
    while (!exists(join(root, `${role}.release`))) {
      if (Date.now() >= until) throw new Error("Synthetic late buffer timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    if (role === "late-read-without-files") {
      delete (globalThis as any).FileManager;
      fs.writeFileSync(join(root, "unavailable-read.json"), JSON.stringify(logger.readDiagnostics().map(entry => entry.details.flowId)));
    } else logger.flushDiagnostics();
  } else logger.writeDiagnosticBatch("refresh.started", [{ flowId: process.argv[4] || role }]);
} else {
  try {
    Storage.set("pipi_deliveries_diagnostic_enabled_v1", true, { shared: true });
    const run = (writer: string, flow = writer) => new Promise<void>((resolveRun, reject) => {
      const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), writer, root, flow],
        { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", data => { output += data; });
      child.stderr.on("data", data => { output += data; });
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Synthetic writer timed out")); }, 15_000);
      child.on("error", reject);
      child.on("exit", code => {
        clearTimeout(timeout);
        if (code === 0) resolveRun();
        else reject(new Error(`Synthetic writer ${writer} exited ${code}: ${output}`));
      });
    });
    await Promise.all([run("writer-A"), run("writer-B")]);
    const logger = await import("../services/logger");
    assert.deepEqual(new Set(logger.readDiagnostics().map(entry => entry.details.flowId)),
      new Set(["writer-A", "writer-B"]), "simultaneous app/widget flushes must both remain durable");
    await run("ack-lost");
    assert.deepEqual(new Set(logger.readDiagnostics().map(entry => entry.details.flowId)),
      new Set(["writer-A", "writer-B", "ack-lost"]), "a lost publication acknowledgement neither drops nor duplicates a batch");
    await run("crash");
    assert.equal(logger.readDiagnostics().length, 3, "death before the ready link leaves previous published logs intact");
    await run("clear");
    await run("append", "after-clear");
    assert.deepEqual(logger.readDiagnostics().map(entry => entry.details.flowId), ["after-clear"],
      "a completed clear precedes a nonoverlapping new process append");

    const late = run("late-buffer");
    const until = Date.now() + 5_000;
    while (!exists(join(root, "late-buffer.ready"))) {
      assert.ok(Date.now() < until, "the old runtime must first hold an unflushed buffer");
      await new Promise(resolveWait => setTimeout(resolveWait, 5));
    }
    await run("clear");
    fs.writeFileSync(join(root, "late-buffer.release"), "");
    await late;
    assert.deepEqual(logger.readDiagnostics(), [], "a different process cannot resurrect its pre-clear buffered lines");
    const unavailable = run("late-read-without-files");
    const readUntil = Date.now() + 5_000;
    while (!exists(join(root, "late-read-without-files.ready"))) {
      assert.ok(Date.now() < readUntil);
      await new Promise(resolveWait => setTimeout(resolveWait, 5));
    }
    await run("clear");
    fs.writeFileSync(join(root, "late-read-without-files.release"), "");
    await unavailable;
    assert.deepEqual(JSON.parse(fs.readFileSync(join(root, "unavailable-read.json"), "utf8")), [],
      "a known old buffer stays hidden when a different process cleared it and the file bridge cannot verify its epoch");
    await Promise.all([run("clear-A"), run("clear-B")]);
    await run("append", "after-concurrent-clear");
    assert.deepEqual(logger.readDiagnostics().map(entry => entry.details.flowId), ["after-concurrent-clear"],
      "concurrent clears establish an epoch that preserves later new lines");
    Storage.set(LOG, [{ id: "old-array", at: new Date().toISOString(), level: "info", event: "refresh.started", details: {} }]);
    assert.equal(logger.readDiagnostics().length, 1, "a cleared old shared array cannot become authoritative again");

    logger.clearDiagnostics();
    logger.writeDiagnosticBatch("refresh.stage.started", Array.from({ length: 205 }, (_, index) => ({ flowId: `retention-${index}` })));
    assert.equal(logger.readDiagnostics().length, 200);
    const store = await import("../services/diagnostic-store");
    assert.equal(store.diagnosticFiles().length, 200, "window pruning removes individual persisted rows, not just exported lines");
    logger.clearDiagnostics();
    const now = Date.now();
    const make = (id: string, age: number) => ({ id, at: new Date(now - age).toISOString(), level: "info",
      event: "refresh.started", details: {} });
    store.publishDiagnosticBatch(store.diagnosticBatchId(), store.diagnosticEpoch(), [
      make("expired", 7 * 86_400_000), make("kept", 7 * 86_400_000 - 2_000),
    ]);
    assert.deepEqual(logger.readDiagnostics().map(entry => entry.id), ["kept"]);
    assert.equal(store.diagnosticFiles().length, 1, "seven-day pruning removes the expired physical row from a mixed batch");
    const diagnosticRoot = join(shared, "pipi-deliveries/diagnostics-v2");
    const abandonedMarker = join(diagnosticRoot, `legacy-imported.${(Date.now() - 8 * 86_400_000).toString(36)}.pending-${randomUUID()}`);
    const activeMarker = join(diagnosticRoot, `legacy-imported.${Date.now().toString(36)}.pending-${randomUUID()}`);
    fs.writeFileSync(abandonedMarker, "");
    fs.writeFileSync(activeMarker, "");
    logger.readDiagnostics();
    assert.equal(exists(abandonedMarker), false, "expired orphaned marker staging is removed");
    assert.equal(exists(activeMarker), true, "a cleaner does not interrupt a live marker publisher");

    const previousGroup = FileManager.appGroupDocumentsDirectory;
    (FileManager as any).appGroupDocumentsDirectory = join(root, "legacy-group");
    fs.mkdirSync(FileManager.appGroupDocumentsDirectory, { recursive: true });
    Storage.set(LOG, [{ id: "legacy-id", at: new Date().toISOString(), level: "info", event: "refresh.started",
      rawResponse: "synthetic-private-root", details: { flowId: "legacy-flow", trigger: "foreground_sync", phone: "synthetic-private-marker" } }]);
    assert.equal(logger.readDiagnostics()[0]?.details.trigger, "foreground");
    assert.equal(logger.readDiagnostics().length, 1, "legacy reads are idempotent before migration");
    logger.writeDiagnosticBatch("refresh.started", [{ flowId: "new-flow" }]);
    assert.deepEqual(new Set(logger.readDiagnostics().map(entry => entry.details.flowId)), new Set(["legacy-flow", "new-flow"]));
    assert.equal(Storage.get(LOG), null, "legacy data is removed only after an immutable migration is published");
    const persisted = store.diagnosticFiles();
    assert.equal(persisted.length, 2);
    assert.equal(JSON.stringify(persisted).includes("synthetic-private-marker"), false, "migration sanitizes before creating a new surface");
    assert.equal(JSON.stringify(persisted).includes("synthetic-private-root"), false, "migration also excludes unknown top-level fields");
    (FileManager as any).appGroupDocumentsDirectory = previousGroup;
    console.log("diagnostic cross-process append/clear/crash/acknowledgement/retention/legacy tests passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
