import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Owner 2026-11-24 「Clear once after update (Recommended)」: lines stored by builds before the keyed handle (D7) can
// hold the old unsalted, reversible ownerFingerprint for up to seven days. The first runtime of the new version clears
// such a log once and writes one fixed line; a device-wide marker keeps it from repeating in any runtime, and runtimes
// that start together clear it once. The recording switch and business data stay as they were. Each child process
// below is one runtime (widget, App Intent, Shortcut) of the same device; each device is its own directory.

const here = dirname(fileURLToPath(import.meta.url));
const role = process.argv[2] || "parent";
const ENABLED = "pipi_deliveries_diagnostic_enabled_v1";
const LEGACY_LOG = "pipi_deliveries_diagnostic_log_v1";
const BUSINESS = "synthetic_business_record";
const OLD_FINGERPRINT = "0123456789ab";
const audit = resolve(here, "../../../../project-data/audits/20261109-ios-bot-mcp-review");
fs.mkdirSync(audit, { recursive: true });
const base = role === "parent" ? fs.mkdtempSync(join(audit, "diagnostic-handle-reset-")) : "";
let device = process.argv[3] || "";

function exists(path: string): boolean {
  try { fs.lstatSync(path); return true; } catch { return false; }
}
function waitFor(paths: readonly string[], what: string): void {
  const until = Date.now() + 5_000;
  while (!paths.every(exists)) {
    if (Date.now() >= until) throw new Error(`Synthetic ${what} barrier timed out`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
const storageFile = (key: string) => join(device, "storage", `${key}.json`);

Object.assign(globalThis, {
  UUID: { string: randomUUID },
  Path: { join: (...parts: string[]) => parts.join("/").replace(/\/{2,}/g, "/") },
  SQLite: { open() {} },
  Data: { fromRawString: (value: string) => ({ value }), fromIntArray: () => ({ value: "" }) },
  Crypto: {
    sha256: (data: { value: string }) => ({ toHexString: () => createHash("sha256").update(data.value).digest("hex") }),
    generateSymmetricKey: () => ({ toHexString: () => randomBytes(32).toString("hex") }),
  },
  FileManager: {
    get appGroupDocumentsDirectory() { return join(device, "group"); },
    createDirectorySync(path: string, recursive = false) { fs.mkdirSync(path, { recursive }); },
    // iOS answers for the item a link points to; a claim link has no target.
    existsSync: (path: string) => fs.existsSync(path),
    isFileSync: (path: string) => fs.statSync(path).isFile(),
    isLinkSync: (path: string) => exists(path) && fs.lstatSync(path).isSymbolicLink(),
    destinationOfSymbolicLink: (path: string) => fs.readlinkSync(path),
    createLinkSync(path: string, target: string) {
      if (role.startsWith("race-") && path.endsWith("/handle-reset-v1")) {
        fs.writeFileSync(join(device, `${role}.at-claim`), "");
        waitFor([join(device, "race-A.at-claim"), join(device, "race-B.at-claim")], "claim");
      }
      fs.symlinkSync(target, path);
    },
    readDirectorySync(path: string) {
      if (role === "clear-fails" && path.endsWith("/diagnostics-v2")) throw new Error("Synthetic listing failure");
      return fs.readdirSync(path);
    },
    readAsStringSync: (path: string) => fs.readFileSync(path, "utf8"),
    writeAsStringSync: (path: string, text: string) => fs.writeFileSync(path, text),
    renameSync(path: string, target: string) {
      if (exists(target)) throw new Error("Synthetic destination already exists");
      fs.renameSync(path, target);
    },
    removeSync(path: string) {
      // Every removal of a stored line's batch is counted, to show one clear.
      if (/\/b[0-9a-z]+-[a-f0-9-]{36}-[0-9]{8}\.batch$/.test(path) && exists(path)) {
        fs.appendFileSync(join(device, "clears.log"), `${role}\n`);
      }
      fs.rmSync(path, { recursive: true, force: true });
    },
  },
  Storage: {
    get(key: string) {
      return exists(storageFile(key)) ? JSON.parse(fs.readFileSync(storageFile(key), "utf8")) : null;
    },
    set(key: string, value: unknown) {
      fs.mkdirSync(join(device, "storage"), { recursive: true });
      const pending = `${storageFile(key)}.${role}.${process.pid}.pending`;
      fs.writeFileSync(pending, JSON.stringify(value));
      fs.renameSync(pending, storageFile(key));
      return true;
    },
    remove(key: string) { fs.rmSync(storageFile(key), { force: true }); },
  },
});

const HOSTS: Record<string, "widget" | "app_intent" | "shortcut"> = {
  "race-A": "widget", "race-B": "app_intent", "off": "widget", "clear-fails": "widget",
};

if (role !== "parent") {
  const logger = await import("../services/logger");
  // An entrypoint's first touch of the log (index.tsx, widget.tsx, app_intents.tsx, intent.tsx).
  logger.writeRuntimeCapabilities(HOSTS[role] || "shortcut");
  // A line of this version, written whether or not this runtime is the one that clears.
  if (role !== "off" && role !== "clear-fails") logger.writeDiagnosticBatch("refresh.skipped", [{ flowId: role }]);
  if (role === "later") {
    fs.writeFileSync(join(device, `${role}.handle`), logger.diagnosticHandle("order", "synthetic-order"));
  }
  logger.flushDiagnostics();
} else {
  const run = (child: string) => new Promise<void>((resolveRun, reject) => {
    const process_ = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), child, device],
      { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    process_.stdout.on("data", data => { output += data; });
    process_.stderr.on("data", data => { output += data; });
    const timeout = setTimeout(() => {
      process_.kill();
      reject(new Error(`Synthetic runtime ${child} timed out`));
    }, 15_000);
    process_.on("error", reject);
    process_.on("exit", code => {
      clearTimeout(timeout);
      if (code === 0) resolveRun();
      else reject(new Error(`Synthetic runtime ${child} exited ${code}: ${output}`));
    });
  });
  const newDevice = (name: string) => {
    device = join(base, name);
    fs.mkdirSync(join(device, "group"), { recursive: true });
  };
  const oldLine = () => ({
    id: "old-line", at: new Date(Date.now() - 60_000).toISOString(), level: "info", event: "order.projection.skipped",
    details: { ownerFingerprint: OLD_FINGERPRINT, result: "skipped", skipReason: "before_pickup" },
  });
  // The files a build before the keyed handle left: one published batch in its store format, in a cleared epoch.
  const seedOldBuild = (epoch: string) => {
    globalThis.Storage.set(ENABLED, true, { shared: true });
    globalThis.Storage.set(BUSINESS, { parcels: ["synthetic-row"] }, { shared: true });
    const store = join(device, "group/pipi-deliveries/diagnostics-v2");
    fs.mkdirSync(store, { recursive: true });
    if (epoch !== "legacy") fs.writeFileSync(join(store, epoch), "");
    const id = `b${Date.now().toString(36).padStart(11, "0")}-${randomUUID()}-00000001`;
    const line = oldLine();
    const at = Date.parse(line.at);
    fs.mkdirSync(join(store, `${id}.batch`));
    fs.writeFileSync(join(store, `${id}.batch/meta.json`), JSON.stringify({
      version: 2, epoch, createdAtMs: at, recordCount: 1, minEntryAtMs: at, maxEntryAtMs: at }));
    fs.writeFileSync(join(store, `${id}.batch/r0000.json`), JSON.stringify(line));
    fs.symlinkSync(join(store, `${id}.batch`), join(store, `${id}.ready`));
  };
  const clears = () => exists(join(device, "clears.log"))
    ? fs.readFileSync(join(device, "clears.log"), "utf8").trim().split("\n") : [];
  const marker = () => exists(join(device, "group/pipi-deliveries/diagnostics-v2/handle-reset-v1"));
  const holdsOldFingerprint = (path = device): boolean => fs.readdirSync(path).some(name => {
    const child = join(path, name);
    const stat = fs.lstatSync(child);
    if (stat.isDirectory()) return holdsOldFingerprint(child);
    return stat.isFile() && fs.readFileSync(child, "utf8").includes(OLD_FINGERPRINT);
  });
  try {
    // An updated device whose widget and App Intent start together: one clear and one fixed line, and the line each
    // runtime writes stays, whichever of them clears and whenever the other publishes.
    newDevice("updated");
    seedOldBuild(`e${"1".padStart(16, "0")}-${randomUUID()}.clear`);
    await Promise.all([run("race-A"), run("race-B")]);
    const logger = await import("../services/logger");
    let lines = logger.readDiagnostics();
    assert.equal(lines.some(entry => entry.id === "old-line"), false, "the line of the old build is cleared");
    assert.equal(holdsOldFingerprint(), false, "no stored file or value keeps the old reversible fingerprint");
    assert.equal(clears().length, 1, "runtimes that start together clear the log once");
    const cleared = lines.filter(entry => entry.event === "diagnostics.log.cleared");
    assert.deepEqual(cleared.map(entry => entry.details.result), ["handle_upgrade"],
      "one fixed line records why the log was cleared");
    assert.deepEqual(lines.filter(entry => entry.event === "refresh.skipped").map(entry => entry.details.flowId).sort(),
      ["race-A", "race-B"], "no line of this version is lost to the clear");
    assert.equal(lines.length, 3);
    assert.equal(marker(), true, "a durable marker records that the clear ran");
    assert.equal(globalThis.Storage.get(ENABLED, { shared: true }), true, "the recording switch is unchanged");
    assert.deepEqual(globalThis.Storage.get(BUSINESS, { shared: true }), { parcels: ["synthetic-row"] },
      "business data is unchanged");
    // Later runtimes of the same device never clear again and keep one handle key.
    await run("later");
    const handle = fs.readFileSync(join(device, "later.handle"), "utf8");
    fs.rmSync(join(device, "later.handle"));
    await run("later");
    lines = logger.readDiagnostics();
    assert.equal(clears().length, 1, "the clear never repeats");
    assert.deepEqual(lines.map(entry => entry.details.flowId ?? entry.event).sort(),
      ["diagnostics.log.cleared", "later", "later", "race-A", "race-B"], "lines written after the clear stay");
    assert.match(handle, /^[0-9a-f]{12}$/);
    assert.equal(fs.readFileSync(join(device, "later.handle"), "utf8"), handle,
      "a later runtime does not rotate the handle key again");

    // Recording off: the old lines are still cleared, the switch stays off and no line is written.
    newDevice("recording-off");
    globalThis.Storage.set(ENABLED, false, { shared: true });
    globalThis.Storage.set(LEGACY_LOG, [oldLine()], { shared: true });
    await run("off");
    assert.deepEqual(logger.readDiagnostics(), [], "the shared array of an older build is cleared");
    assert.equal(globalThis.Storage.get(LEGACY_LOG, { shared: true }), null);
    assert.equal(holdsOldFingerprint(), false);
    assert.equal(marker(), true);
    assert.equal(globalThis.Storage.get(ENABLED, { shared: true }), false, "recording stays off");

    // A first install has nothing to clear: no clear, no fixed line, and the marker keeps later runtimes quiet.
    newDevice("fresh");
    globalThis.Storage.set(ENABLED, true, { shared: true });
    await run("fresh");
    assert.deepEqual(logger.readDiagnostics().map(entry => [entry.event, entry.details.flowId]),
      [["refresh.skipped", "fresh"]]);
    assert.deepEqual(clears(), []);
    assert.equal(marker(), true);

    // A clear that fails gives the claim back, so the next runtime clears once.
    newDevice("failed-clear");
    seedOldBuild("legacy");
    await run("clear-fails");
    assert.equal(marker(), false, "a failed clear releases the marker");
    assert.deepEqual(clears(), []);
    assert.equal(holdsOldFingerprint(), true);
    await run("later");
    assert.equal(holdsOldFingerprint(), false);
    assert.deepEqual(clears(), ["later"]);
    assert.deepEqual(logger.readDiagnostics().map(entry => entry.event).sort(),
      ["diagnostics.log.cleared", "refresh.skipped"]);
    console.log("diagnostic one-time handle reset tests passed");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
