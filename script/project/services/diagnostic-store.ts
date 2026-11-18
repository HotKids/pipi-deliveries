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

async function asyncNames(): Promise<string[]> {
  const directory = root();
  if (!await FileManager.exists(directory)) return [];
  return (await FileManager.readDirectory(directory, false)).map(name => name.split("/").pop()!);
}

export async function readDiagnosticEpoch(): Promise<string> {
  return (await asyncNames()).filter(name => EPOCH.test(name)).sort().at(-1) || "legacy";
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

function diagnosticBatch(id: string, epoch: string) {
  if (!BATCH.test(`${id}.ready`) || epoch !== "legacy" && !EPOCH.test(epoch)) {
    throw new Error("Invalid diagnostic publication");
  }
  const directory = `${root()}/${id}.batch`;
  const ready = `${root()}/${id}.ready`;
  const published = () => {
    try { return FileManager.destinationOfSymbolicLink(ready) === directory; } catch { return false; }
  };
  return { directory, ready, published };
}

function diagnosticMetadata(epoch: string, values: readonly unknown[]): string {
  return JSON.stringify({ version: 2, epoch, createdAtMs: Date.now(), recordCount: values.length, ...entryTimestampRange(values) });
}

function rowName(index: number): string {
  return `r${String(index).padStart(4, "0")}.json`;
}

export function publishDiagnosticBatch(id: string, epoch: string, values: readonly unknown[]): void {
  const { directory, ready, published } = diagnosticBatch(id, epoch);
  FileManager.createDirectorySync(root(), true);
  if (published()) return;
  try {
    if (!FileManager.existsSync(directory)) FileManager.createDirectorySync(directory, false);
    verifiedWrite(`${directory}/meta.json`, diagnosticMetadata(epoch, values));
    for (let index = 0; index < values.length; index++) {
      FileManager.writeAsStringSync(`${directory}/${rowName(index)}`, JSON.stringify(values[index]));
    }
    FileManager.createLinkSync(ready, directory);
  } catch (error) {
    // A lost native acknowledgement must not replay an already published batch.
    if (!published()) throw error;
  }
}

export async function publishDiagnosticBatchAsync(
  id: string, epoch: string, values: readonly unknown[], current: () => boolean,
): Promise<boolean> {
  const { directory, ready, published } = diagnosticBatch(id, epoch);
  if (published()) return true;
  const metaPath = `${directory}/meta.json`;
  try {
    await FileManager.createDirectory(directory, true);
    const metadata = diagnosticMetadata(epoch, values);
    await FileManager.writeAsString(metaPath, metadata);
    if (await FileManager.readAsString(metaPath) !== metadata) throw new Error("Diagnostic file verification failed");
    // Wait for other writes to settle before any retry can use this batch id.
    const writes = await Promise.allSettled(values.map((value, index) =>
      FileManager.writeAsString(`${directory}/${rowName(index)}`, JSON.stringify(value))));
    const failed = writes.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    if (!current() || await readDiagnosticEpoch() !== epoch || !current()) {
      await FileManager.remove(directory).catch(() => undefined);
      return false;
    }
    // Keep the final commit in the same turn as the local recording check.
    FileManager.createLinkSync(ready, directory);
  } catch (error) {
    if (!published()) throw error;
  }
  return true;
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

function staleMarker(name: string, epoch: string, now: number, maxAgeMs: number): boolean {
  if (EPOCH.test(name) && olderEpoch(name, epoch)) return true;
  const pending = /^(?:legacy-imported|e[0-9]{16}-[a-f0-9-]{36}\.clear)\.([a-z0-9]+)\.pending(?:-[a-f0-9-]{36})?$/.exec(name);
  return !!pending && now - parseInt(pending[1]!, 36) >= maxAgeMs;
}

function unpublishedBatchTime(name: string): number | undefined {
  const staged = /^(b([0-9a-z]+)-[a-f0-9-]{36}-[0-9]{8})\.batch$/.exec(name);
  if (staged && !FileManager.isLinkSync(`${root()}/${staged[1]}.ready`)) return parseInt(staged[2]!, 36);
}

function cleanupDiagnosticStagingAndEpochs(epoch: string, now: number, maxAgeMs: number): void {
  for (const name of names()) {
    const path = `${root()}/${name}`;
    if (staleMarker(name, epoch, now, maxAgeMs)) removeBestEffort(path);
    const stagedAt = unpublishedBatchTime(name);
    if (stagedAt !== undefined) {
      try {
        const metadata = JSON.parse(FileManager.readAsStringSync(`${path}/meta.json`));
        if (olderEpoch(metadata.epoch, epoch) || now - stagedAt >= maxAgeMs) removeBestEffort(path);
      } catch { /* An active writer may not have published its metadata yet. */ }
    }
  }
}

type BatchMetadata = {
  version?: number;
  epoch?: string;
  createdAtMs?: number;
  maxEntryAtMs?: number;
  recordCount?: number;
};

type RetentionBatch = {
  ready: string;
  directory: string;
  recordCount: number;
  timestampMs: number;
  obsolete: boolean;
};

function olderEpoch(value: unknown, epoch: string): boolean {
  return epoch !== "legacy" && (value === "legacy" ||
    typeof value === "string" && EPOCH.test(value) && value < epoch);
}

function recordedRowCount(metadata: BatchMetadata): number | undefined {
  const count = metadata.recordCount;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : undefined;
}

function batchPaths(name: string) {
  return { ready: `${root()}/${name}`, directory: `${root()}/${name.replace(/\.ready$/, ".batch")}` };
}

function retentionBatch(name: string, metadata: BatchMetadata, epoch: string,
  count: number, now: number, maxAgeMs: number): RetentionBatch | undefined {
  const obsolete = olderEpoch(metadata.epoch, epoch);
  if (!obsolete && (metadata.version !== 2 || metadata.epoch !== epoch)) return;
  const timestamp = [metadata.maxEntryAtMs, metadata.createdAtMs,
    parseInt(/^b([0-9a-z]+)-/.exec(name)?.[1] || "", 36)].find(value => Number.isFinite(value)) ?? now;
  return { ...batchPaths(name), recordCount: count, timestampMs: timestamp,
    obsolete: obsolete || count === 0 || now - timestamp >= maxAgeMs };
}

function* prunedBatches(batches: readonly (RetentionBatch | undefined)[], now: number, maxRecords: number) {
  let retainedRecords = 0;
  for (let index = batches.length - 1; index >= 0; index--) {
    const batch = batches[index];
    if (!batch) continue;
    if (batch.obsolete || retainedRecords >= maxRecords && batch.timestampMs <= now) yield batch;
    else retainedRecords += batch.recordCount;
  }
}

/** Use metadata to retire whole batches without opening individual records. */
export function pruneDiagnosticBatchesByMetadata(
  epoch: string, now = Date.now(), maxRecords = 200, maxAgeMs = 7 * 24 * 60 * 60 * 1000,
): void {
  const batches = names().filter(name => BATCH.test(name)).sort().map(name => {
    const { ready, directory } = batchPaths(name);
    try {
      if (FileManager.destinationOfSymbolicLink(ready) !== directory) return;
      const metadata = JSON.parse(FileManager.readAsStringSync(`${directory}/meta.json`)) as BatchMetadata;
      const count = metadata.version === 2 && metadata.epoch === epoch
        ? recordedRowCount(metadata) ?? FileManager.readDirectorySync(directory, false).filter(row => ROW.test(row.split("/").pop()!)).length
        : 0;
      return retentionBatch(name, metadata, epoch, count, now, maxAgeMs);
    } catch { /* A different reader can retire this batch while it is being inspected. */ }
  });
  for (const { ready, directory } of prunedBatches(batches, now, maxRecords)) {
    removeBestEffort(ready);
    removeBestEffort(directory);
  }
  cleanupDiagnosticStagingAndEpochs(epoch, now, maxAgeMs);
}

export async function pruneDiagnosticBatchesAsync(epoch: string, now: number, maxRecords: number, maxAgeMs: number): Promise<void> {
  const entries = await asyncNames();
  const remove = async (file: string) => { await FileManager.remove(file).catch(() => undefined); };
  const batches = await Promise.all(entries.filter(name => BATCH.test(name)).sort().map(async name => {
    const { ready, directory } = batchPaths(name);
    try {
      const metadata = JSON.parse(await FileManager.readAsString(`${directory}/meta.json`)) as BatchMetadata;
      if (FileManager.destinationOfSymbolicLink(ready) !== directory) return;
      const count = metadata.version === 2 && metadata.epoch === epoch
        ? recordedRowCount(metadata) ?? (await FileManager.readDirectory(directory, false)).filter(row => ROW.test(row.split("/").pop()!)).length
        : 0;
      return retentionBatch(name, metadata, epoch, count, now, maxAgeMs);
    } catch { /* Ignore a batch retired by another runtime. */ }
  }));
  await Promise.all([...prunedBatches(batches, now, maxRecords)].map(async ({ ready, directory }) => {
    await remove(ready);
    await remove(directory);
  }));
  await Promise.all(entries.map(async name => {
    const path = `${root()}/${name}`;
    if (staleMarker(name, epoch, now, maxAgeMs)) return remove(path);
    const stagedAt = unpublishedBatchTime(name);
    if (stagedAt === undefined) return;
    try {
      const metadata = JSON.parse(await FileManager.readAsString(`${path}/meta.json`));
      if ((olderEpoch(metadata.epoch, epoch) || now - stagedAt >= maxAgeMs)
        && unpublishedBatchTime(name) !== undefined) await remove(path);
    } catch { /* Another runtime can publish or remove this staged batch. */ }
  }));
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
