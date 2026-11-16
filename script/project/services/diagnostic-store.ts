import { removeBestEffort } from "./durable-files";

type StoredRow = { value: unknown; path: string; order: string };
const DIRECTORY = "pipi-deliveries/diagnostics-v2";
const EPOCH = /^e([0-9]{16})-[a-f0-9-]{36}\.clear$/;
const BATCH = /^b[0-9a-z]+-[a-f0-9-]{36}-[0-9]{8}\.ready$/;
const ROW = /^r[0-9]{4}\.json$/;
let runtimeId: string | undefined;
let sequence = 0;

function root(): string {
  if (typeof FileManager.appGroupDocumentsDirectory !== "string") throw new Error("Shared files unavailable");
  return `${FileManager.appGroupDocumentsDirectory}/${DIRECTORY}`;
}
function uuid(): string {
  const id = UUID.string().toLowerCase();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) {
    throw new Error("Invalid diagnostic file identity");
  }
  return id;
}
function names(): string[] {
  const directory = root();
  if (!FileManager.existsSync(directory)) return [];
  return FileManager.readDirectorySync(directory, false).map(name => name.split("/").pop()!);
}
function verifiedWrite(path: string, text: string): void {
  FileManager.writeAsStringSync(path, text);
  if (FileManager.readAsStringSync(path) !== text) throw new Error("Diagnostic file verification failed");
}

/** Immutable clear markers order concurrent clears without an overwritten shared pointer. */
export function diagnosticEpoch(): string {
  return names().filter(name => EPOCH.test(name)).sort().at(-1) || "legacy";
}

export function diagnosticBatchId(): string {
  runtimeId ||= uuid();
  sequence++;
  return `b${Date.now().toString(36).padStart(11, "0")}-${runtimeId}-${String(sequence).padStart(8, "0")}`;
}

function entryTimestampRange(values: readonly unknown[]): {
  minEntryAtMs?: number;
  maxEntryAtMs?: number;
} {
  let minEntryAtMs = Number.POSITIVE_INFINITY;
  let maxEntryAtMs = Number.NEGATIVE_INFINITY;
  for (const item of values) {
    if (!item || typeof item !== "object") continue;
    const rawAt = (item as { at?: unknown }).at;
    if (typeof rawAt !== "string") continue;
    const parsed = Date.parse(rawAt);
    if (!Number.isFinite(parsed)) continue;
    if (parsed < minEntryAtMs) minEntryAtMs = parsed;
    if (parsed > maxEntryAtMs) maxEntryAtMs = parsed;
  }
  return {
    ...(Number.isFinite(minEntryAtMs) ? { minEntryAtMs } : {}),
    ...(Number.isFinite(maxEntryAtMs) ? { maxEntryAtMs } : {}),
  };
}

export function publishDiagnosticBatch(id: string, epoch: string, values: readonly unknown[]): void {
  if (!BATCH.test(`${id}.ready`) || epoch !== "legacy" && !EPOCH.test(epoch)) {
    throw new Error("Invalid diagnostic publication");
  }
  FileManager.createDirectorySync(root(), true);
  const directory = `${root()}/${id}.batch`;
  const ready = `${root()}/${id}.ready`;
  const published = () => {
    try { return FileManager.destinationOfSymbolicLink(ready) === directory; } catch { return false; }
  };
  if (published()) return;
  try {
    if (!FileManager.existsSync(directory)) FileManager.createDirectorySync(directory, false);
    const createdAtMs = Date.now();
    const range = entryTimestampRange(values);
    verifiedWrite(
      `${directory}/meta.json`,
      JSON.stringify({
        version: 2,
        epoch,
        createdAtMs,
        recordCount: values.length,
        ...range,
      }),
    );
    for (let index = 0; index < values.length; index++) {
      FileManager.writeAsStringSync(`${directory}/r${String(index).padStart(4, "0")}.json`, JSON.stringify(values[index]));
    }
    FileManager.createLinkSync(ready, directory);
  } catch (error) {
    // A lost native acknowledgement must not replay an already published batch.
    if (!published()) throw error;
  }
}

export function diagnosticFiles(epoch = diagnosticEpoch()): StoredRow[] {
  const result: StoredRow[] = [];
  for (const name of names().filter(name => BATCH.test(name)).sort()) {
    const directory = `${root()}/${name.replace(/\.ready$/, ".batch")}`;
    try {
      if (FileManager.destinationOfSymbolicLink(`${root()}/${name}`) !== directory) continue;
      const metadata = JSON.parse(FileManager.readAsStringSync(`${directory}/meta.json`));
      if (metadata?.version !== 2 || metadata.epoch !== epoch) continue;
      for (const row of FileManager.readDirectorySync(directory, false)) {
        const leaf = row.split("/").pop()!;
        if (!ROW.test(leaf)) continue;
        const path = `${directory}/${leaf}`;
        try { result.push({ value: JSON.parse(FileManager.readAsStringSync(path)), path, order: `${name}/${leaf}` }); }
        catch { /* Another reader may already have retired this row. */ }
      }
    } catch { /* Unpublished or partially retired batches never grant log records. */ }
  }
  return result;
}

export function diagnosticLegacyImported(): boolean {
  return FileManager.existsSync(`${root()}/legacy-imported`);
}

export function markDiagnosticLegacyImported(): void {
  FileManager.createDirectorySync(root(), true);
  const marker = `${root()}/legacy-imported`;
  if (FileManager.existsSync(marker)) return;
  const pending = `${marker}.${Date.now().toString(36)}.pending-${uuid()}`;
  verifiedWrite(pending, "");
  try { FileManager.renameSync(pending, marker); }
  catch (error) { if (!FileManager.existsSync(marker)) throw error; }
  finally { removeBestEffort(pending); }
}

export function clearDiagnosticFiles(): void {
  FileManager.createDirectorySync(root(), true);
  const previous = diagnosticEpoch();
  const next = Number(EPOCH.exec(previous)?.[1] || 0) + 1;
  if (!Number.isSafeInteger(next)) throw new Error("Diagnostic clear sequence unavailable");
  const name = `e${String(next).padStart(16, "0")}-${uuid()}.clear`;
  const target = `${root()}/${name}`;
  const pending = `${target}.${Date.now().toString(36)}.pending`;
  verifiedWrite(pending, "");
  try { FileManager.renameSync(pending, target); }
  catch (error) { if (!FileManager.existsSync(target)) throw error; }
  finally { removeBestEffort(pending); }
}

function cleanupDiagnosticStagingAndEpochs(epoch: string, now: number, maxAgeMs: number): void {
  for (const name of names()) {
    if (EPOCH.test(name) && epoch !== "legacy" && name < epoch) removeBestEffort(`${root()}/${name}`);
    const marker = /^(?:legacy-imported|e[0-9]{16}-[a-f0-9-]{36}\.clear)\.([a-z0-9]+)\.pending(?:-[a-f0-9-]{36})?$/.exec(name);
    if (marker && now - parseInt(marker[1]!, 36) >= maxAgeMs) {
      removeBestEffort(`${root()}/${name}`);
    }
    const staged = /^(b([0-9a-z]+)-[a-f0-9-]{36}-[0-9]{8})\.batch$/.exec(name);
    if (staged && !FileManager.isLinkSync(`${root()}/${staged[1]}.ready`)) {
      try {
        const metadata = JSON.parse(FileManager.readAsStringSync(`${root()}/${name}/meta.json`));
        const cleared = metadata.epoch === "legacy" && epoch !== "legacy"
          || typeof metadata.epoch === "string" && EPOCH.test(metadata.epoch)
          && epoch !== "legacy" && metadata.epoch < epoch;
        if (cleared || now - parseInt(staged[2]!, 36) >= maxAgeMs) {
          removeBestEffort(`${root()}/${name}`);
        }
      } catch { /* An active writer may not have published its metadata yet. */ }
    }
  }
}

/**
 * Flush-path retention using ONLY `.batch/meta.json` (`createdAtMs` / `maxEntryAtMs` + `recordCount`),
 * without reading or parsing any `rXXXX.json` record files.
 */
export function pruneDiagnosticBatchesByMetadata(
  epoch: string,
  now = Date.now(),
  maxRecords = 200,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
): void {
  const activeBatches: Array<{
    ready: string;
    directory: string;
    recordCount: number;
    timestampMs: number;
  }> = [];
  for (const name of names().filter((entry) => BATCH.test(entry)).sort()) {
    const ready = `${root()}/${name}`;
    const directory = `${root()}/${name.replace(/\.ready$/, ".batch")}`;
    try {
      if (FileManager.destinationOfSymbolicLink(ready) !== directory) continue;
      const metadata = JSON.parse(
        FileManager.readAsStringSync(`${directory}/meta.json`),
      ) as {
        version?: unknown;
        epoch?: unknown;
        createdAtMs?: unknown;
        maxEntryAtMs?: unknown;
        recordCount?: unknown;
      };
      const olderEpoch =
        (metadata.epoch === "legacy" && epoch !== "legacy") ||
        (typeof metadata.epoch === "string" &&
          EPOCH.test(metadata.epoch) &&
          epoch !== "legacy" &&
          metadata.epoch < epoch);
      if (olderEpoch) {
        removeBestEffort(ready);
        removeBestEffort(directory);
        continue;
      }
      if (metadata?.version !== 2 || metadata.epoch !== epoch) continue;
      const recordCount =
        typeof metadata.recordCount === "number" &&
          Number.isInteger(metadata.recordCount) &&
          metadata.recordCount >= 0
          ? metadata.recordCount
          : FileManager.readDirectorySync(directory, false).filter((row) =>
              ROW.test(row.split("/").pop()!)
            ).length;
      const batchIdTime = parseInt(/^b([0-9a-z]+)-/.exec(name)?.[1] || "", 36);
      const timestampMs =
        typeof metadata.maxEntryAtMs === "number" && Number.isFinite(metadata.maxEntryAtMs)
          ? metadata.maxEntryAtMs
          : typeof metadata.createdAtMs === "number" && Number.isFinite(metadata.createdAtMs)
            ? metadata.createdAtMs
            : batchIdTime;
      const expired =
        recordCount === 0 ||
        (Number.isFinite(timestampMs) &&
          timestampMs <= now &&
          now - timestampMs >= maxAgeMs);
      if (expired) {
        removeBestEffort(ready);
        removeBestEffort(directory);
        continue;
      }
      activeBatches.push({
        ready,
        directory,
        recordCount,
        timestampMs: Number.isFinite(timestampMs) ? timestampMs : now,
      });
    } catch {
      /* Unpublished or concurrently retired batches are skipped safely. */
    }
  }
  let retainedRecords = 0;
  for (let index = activeBatches.length - 1; index >= 0; index--) {
    const batch = activeBatches[index]!;
    if (retainedRecords >= maxRecords && batch.timestampMs <= now) {
      removeBestEffort(batch.ready);
      removeBestEffort(batch.directory);
      continue;
    }
    retainedRecords += batch.recordCount;
  }
  cleanupDiagnosticStagingAndEpochs(epoch, now, maxAgeMs);
}

/** Delete individual rows so a partially retained batch cannot keep extra log content. */
export function pruneDiagnosticFiles(keep: ReadonlySet<string>, epoch: string, observed: readonly StoredRow[]): void {
  const seen = new Set(observed.map(row => row.path));
  for (const name of names().filter(name => BATCH.test(name))) {
    const ready = `${root()}/${name}`;
    const directory = `${root()}/${name.replace(/\.ready$/, ".batch")}`;
    try {
      if (FileManager.destinationOfSymbolicLink(ready) !== directory) continue;
      const metadata = JSON.parse(FileManager.readAsStringSync(`${directory}/meta.json`));
      const olderEpoch = metadata.epoch === "legacy" && epoch !== "legacy"
        || typeof metadata.epoch === "string" && EPOCH.test(metadata.epoch)
        && epoch !== "legacy" && metadata.epoch < epoch;
      for (const row of FileManager.readDirectorySync(directory, false)) {
        const leaf = row.split("/").pop()!;
        const path = `${directory}/${leaf}`;
        if (ROW.test(leaf) && (olderEpoch || seen.has(path) && !keep.has(path))) {
          removeBestEffort(`${directory}/${leaf}`);
        }
      }
      if (!FileManager.readDirectorySync(directory, false).some(row => ROW.test(row.split("/").pop()!))) {
        removeBestEffort(ready);
        removeBestEffort(directory);
      }
    } catch { /* A different cleaner can retire the same immutable batch concurrently. */ }
  }
  cleanupDiagnosticStagingAndEpochs(epoch, Date.now(), 7 * 24 * 60 * 60 * 1000);
}
