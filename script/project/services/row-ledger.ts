import { utf8Data } from "./scripting-data";

/**
 * 每行一份的持久化台账（用户 2026-10-03 逐条决定，docs/EXPRESS_OPTIMIZATION_REVIEW_20261003.md 第四节）：
 * - 优化 1「这轮就统一」：签收后的一次性放行合成每行一份「签收后台账」，按完成时间 T 分代（T 变了就是新的一代）。iOS 的
 *   一次性放行只有京东签收缺口那一次京粉页（shipment-policy jingDongSignedHistoryGap），「拿到回答就算用掉」：有回答但没
 *   轨迹、只抓到部分包也算；网络失败、超时、风控、冷却跳过不算。三态冻结的「放行先用掉」（signedTripleReached）读这里。
 * - Alignment attempts share this ledger; the 2026-10-08 revision completes only on newer node/status evidence.
 *   Legacy `pipi_deliveries_status_alignment_v1` keys migrate as an unfinished first attempt.
 * - 优化 3「四端都持久化、不因暂时消失删除」：台账只在行真正删除（上一次存盘有这一行、这一次没有）或运单号被承运商重用、
 *   新件接管这一行时清掉（storage saveStateAndPrune 调 pruneRowLedgerForState）；行暂时隐藏、冻结、某轮没报都不清。从没
 *   落过盘的行（比如列表这一轮先识别承运商、后落库的新件）记下的条目保留 24 小时等它落库，过期仍没有这一行才清。
 * - 优化 5 续（用户 2026-10-03「第一次识别时记下锚点，之后不变」）：这一行第一次向 /api/express/classify 发锚点时，按当时
 *   的历史算出 parcelAnchorAtMs 记在这里，之后一律发记下的这个，历史变多变少都不漂；真实删除清掉，运单号被新件接管时从头
 *   再记；还没有行的手动加件照旧不发。
 *
 * 实现口径（协调方定，不是用户原话）：按行 id 的哈希存，不存运单号、订单号；存在 App Group 共享存储里，App、小组件与
 * App Intent 宿主读到的是同一份（签收三态冻结在后台宿主里也要读放行用没用掉）。Signed releases and classification keep
 * their existing best-effort storage behavior. Alignment must reserve its bounded attempt successfully before asking.
 */

const LEDGER_KEY = "pipi_deliveries_row_ledger_v1";
/** The status alignment's own record before it moved into this ledger (2026-10-03); read once, never written again. */
const LEGACY_ALIGNMENT_KEY = "pipi_deliveries_status_alignment_v1";

/** The one-time releases of a signed generation (iOS has one: the JD signed-history union page). */
export type SignedRelease = "jingDongUnionGap";

export type SignedGeneration = Readonly<{
  /** The completion time T the generation belongs to. */
  completedAtMs: number;
  /** When the JD union page answered for this generation (the release is then used). */
  jingDongUnionGapAtMs?: number;
}>;

export type RowLedgerEntry = Readonly<{
  /** Serialized attempt state for the latest S/H/D group, or its legacy three-time key. */
  alignment?: string;
  signed?: SignedGeneration;
  /** The parcelAnchorAtMs this row first sent with the paid carrier classification (优化 5 续). */
  classifyAnchorAtMs?: number;
  /** When this entry was last written (an entry of a row never saved expires on it). */
  updatedAtMs?: number;
}>;

export type RowLedger = Record<string, RowLedgerEntry>;

export type AlignmentAttempt = Readonly<{
  times: string;
  attempts: number;
  lastAttemptAtMs: number;
  complete: boolean;
  finished: boolean;
  completionStatus?: string;
  completionHeadline?: string;
}>;

/** Old start-only records prove an attempt, never that it returned newer evidence. */
export function parseAlignmentAttempt(value: string | undefined): AlignmentAttempt | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed.times === "string" && Number.isInteger(parsed.attempts) &&
        parsed.attempts >= 0 && Number.isFinite(parsed.lastAttemptAtMs)) {
      return { times: parsed.times, attempts: parsed.attempts, lastAttemptAtMs: parsed.lastAttemptAtMs,
        complete: parsed.complete === true, finished: parsed.finished === true,
        ...(typeof parsed.completionStatus === "string" ? { completionStatus: parsed.completionStatus } : {}),
        ...(typeof parsed.completionHeadline === "string" ? { completionHeadline: parsed.completionHeadline } : {}) };
    }
  } catch { /* legacy three-time key */ }
  return { times: value, attempts: 1, lastAttemptAtMs: 0, complete: false, finished: false };
}

export function alignmentAttemptFinished(rowId: string, times: string): boolean {
  const record = parseAlignmentAttempt(loadRowLedger()[rowLedgerKey(rowId)]?.alignment);
  return record?.times === times && record.finished;
}

type RowLedgerStore = Readonly<{
  load: () => RowLedger;
  save: (ledger: RowLedger) => void;
}>;

const RELEASE_FIELD: Record<SignedRelease, "jingDongUnionGapAtMs"> = {
  jingDongUnionGap: "jingDongUnionGapAtMs",
};

function validTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function parseEntry(value: unknown): RowLedgerEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const alignment = typeof raw.alignment === "string" && raw.alignment ? raw.alignment : undefined;
  let signed: SignedGeneration | undefined;
  if (raw.signed && typeof raw.signed === "object" && !Array.isArray(raw.signed)) {
    const generation = raw.signed as Record<string, unknown>;
    const completedAtMs = validTime(generation.completedAtMs);
    const gapAtMs = validTime(generation.jingDongUnionGapAtMs);
    if (completedAtMs) signed = { completedAtMs, ...(gapAtMs ? { jingDongUnionGapAtMs: gapAtMs } : {}) };
  }
  const classifyAnchorAtMs = validTime(raw.classifyAnchorAtMs);
  const updatedAtMs = validTime(raw.updatedAtMs);
  if (!alignment && !signed && !classifyAnchorAtMs) return null;
  return {
    ...(alignment ? { alignment } : {}),
    ...(signed ? { signed } : {}),
    ...(classifyAnchorAtMs ? { classifyAnchorAtMs } : {}),
    ...(updatedAtMs ? { updatedAtMs } : {}),
  };
}

/** An entry of a row no saved state has carried is kept this long, waiting for its row to land (优化 5 续). */
export const UNSAVED_ROW_ENTRY_TTL_MS = 24 * 60 * 60_000;

/** Parses a stored ledger; anything unreadable is left out. */
export function parseRowLedger(value: unknown): RowLedger {
  let parsed: unknown = value;
  try {
    if (typeof value === "string") parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const rows = (parsed as Record<string, unknown>).rows;
  if (!rows || typeof rows !== "object" || Array.isArray(rows)) return {};
  const ledger: RowLedger = {};
  for (const [key, entry] of Object.entries(rows as Record<string, unknown>)) {
    const valid = parseEntry(entry);
    if (valid) ledger[key] = valid;
  }
  return ledger;
}

/** The separate alignment record of earlier versions (row key → times key), as ledger entries. */
export function migratedAlignmentRecords(value: unknown): RowLedger {
  let parsed: unknown = value;
  try {
    if (typeof value === "string") parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const ledger: RowLedger = {};
  for (const [key, times] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof times === "string" && times) ledger[key] = { alignment: times };
  }
  return ledger;
}

const storageStore: RowLedgerStore = {
  load: () => {
    try {
      const stored = Storage.get<string>(LEDGER_KEY, { shared: true });
      if (typeof stored === "string") return parseRowLedger(stored);
    } catch {
      return {};
    }
    // Never written yet: the alignment's own record of earlier versions comes along (it was kept per script).
    try {
      return migratedAlignmentRecords(Storage.get<string>(LEGACY_ALIGNMENT_KEY));
    } catch {
      return {};
    }
  },
  save: (ledger) => {
    try {
      Storage.set(LEDGER_KEY, JSON.stringify({ version: 1, rows: ledger }), { shared: true });
    } catch {
      /* Signed releases and classification retain their best-effort storage contract. */
    }
  },
};

export function loadRowLedger(): RowLedger {
  try {
    return storageStore.load();
  } catch {
    return {};
  }
}

function saveRowLedger(ledger: RowLedger): void {
  try {
    storageStore.save(ledger);
  } catch {
    /* best effort, as above */
  }
}

/** The ledger key of a row: a hash of its id (the key the status alignment record always used). */
export function rowLedgerKey(rowId: string): string {
  const hash = Crypto.sha256(utf8Data(String(rowId || ""))).toHexString().toLowerCase();
  return `row:${hash.slice(0, 24)}`;
}

/** Applies `change` to one row's entry and saves the ledger when it changed. */
function updateEntry(
  rowId: string,
  change: (entry: RowLedgerEntry | undefined) => RowLedgerEntry | undefined,
  now = Date.now(),
): void {
  const ledger = loadRowLedger();
  const key = rowLedgerKey(rowId);
  const before = ledger[key];
  const after = change(before);
  if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return;
  if (after && (after.alignment || after.signed || after.classifyAnchorAtMs)) ledger[key] = { ...after, updatedAtMs: now };
  else delete ledger[key];
  saveRowLedger(ledger);
}

/**
 * Whether the row's one-time release of generation `completedAtMs` was already used (it answered). A different T is a
 * new generation, whose releases are all still open.
 */
export function signedReleaseUsed(rowId: string, completedAtMs: number, release: SignedRelease): boolean {
  const completed = validTime(completedAtMs);
  if (!completed) return false;
  const generation = loadRowLedger()[rowLedgerKey(rowId)]?.signed;
  return Boolean(generation && generation.completedAtMs === completed && validTime(generation[RELEASE_FIELD[release]]));
}

/** Records that the release of generation `completedAtMs` answered (only an answer uses it up; the caller decides). */
export function recordSignedRelease(
  rowId: string,
  completedAtMs: number,
  release: SignedRelease,
  answeredAtMs = Date.now(),
): void {
  const completed = validTime(completedAtMs);
  if (!completed) return;
  const at = validTime(answeredAtMs) || Date.now();
  updateEntry(rowId, (entry) => {
    const generation = entry?.signed?.completedAtMs === completed ? entry.signed : { completedAtMs: completed };
    if (validTime(generation[RELEASE_FIELD[release]])) return entry;
    return { ...(entry || {}), signed: { ...generation, [RELEASE_FIELD[release]]: at } };
  });
}

/**
 * 优化 5 续（用户 2026-10-03「第一次识别时记下锚点，之后不变」）：the parcelAnchorAtMs this row sends with the paid carrier
 * classification. Asked right before the request goes out: the first time, `compute` gives the row's reuse anchor from
 * its history as it is now, and a valid one (positive, not in the future) is recorded; every later request sends the
 * recorded one, however the history grows or shrinks. Undefined (nothing sent) without a valid anchor.
 */
export function firstClassifyAnchor(
  rowId: string,
  compute: () => number,
  now = Date.now(),
): number | undefined {
  if (!rowId) return undefined;
  const stored = validTime(loadRowLedger()[rowLedgerKey(rowId)]?.classifyAnchorAtMs);
  if (stored && stored <= now) return stored;
  let anchor = 0;
  try {
    anchor = validTime(compute());
  } catch {
    return undefined;
  }
  if (!anchor || anchor > now) return undefined;
  updateEntry(rowId, (entry) => ({ ...(entry || {}), classifyAnchorAtMs: anchor }), now);
  return anchor;
}

/** A failed read cannot become an empty mixed ledger and erase another row or its signed/classification fields. */
function loadAlignmentLedger(): RowLedger {
  const stored = Storage.get<string>(LEDGER_KEY, { shared: true });
  if (stored != null) {
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        !parsed.rows || typeof parsed.rows !== "object" || Array.isArray(parsed.rows)) {
      throw new Error("Invalid alignment row ledger");
    }
    return parseRowLedger(parsed);
  }
  const legacy = Storage.get<string>(LEGACY_ALIGNMENT_KEY);
  if (legacy == null) return {};
  const parsed = JSON.parse(legacy);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid legacy alignment records");
  }
  return migratedAlignmentRecords(parsed);
}

/** Status alignment records (row key → times key); storage failures propagate before an attempt is sent. */
export function loadAlignmentRecords(): Record<string, string> {
  const records: Record<string, string> = {};
  for (const [key, entry] of Object.entries(loadAlignmentLedger())) {
    if (entry.alignment) records[key] = entry.alignment;
  }
  return records;
}

/**
 * Writes the alignment records the pass set. A row the pass does not mention keeps its record (优化 3: records go only
 * with the row itself or when its times change, which overwrites them).
 */
export function saveAlignmentRecords(records: Readonly<Record<string, string>>): void {
  const ledger = loadAlignmentLedger();
  let changed = false;
  for (const [key, times] of Object.entries(records)) {
    if (typeof times !== "string" || !times || ledger[key]?.alignment === times) continue;
    ledger[key] = { ...(ledger[key] || {}), alignment: times, updatedAtMs: Date.now() };
    changed = true;
  }
  if (changed && !Storage.set(LEDGER_KEY, JSON.stringify({ version: 1, rows: ledger }), { shared: true })) {
    throw new Error("Failed to save alignment row ledger");
  }
}

/**
 * After a durable state save: the entries of rows the previous state had and the saved state no longer has (a real
 * deletion) go, and so do the entries of rows a new parcel took over on a reused waybill number (user 2026-10-01/02:
 * nothing of the old parcel stays; its next classification records a fresh anchor). Rows in the saved state keep
 * theirs, hidden or frozen ones included. An entry of a row neither state has — written before its row first landed,
 * or left behind by a save that could not prune — waits UNSAVED_ROW_ENTRY_TTL_MS from its last write.
 */
export function pruneRowLedgerForState(
  previousRowIds: readonly string[],
  rowIds: readonly string[],
  reusedRowIds: ReadonlySet<string> = new Set(),
  now = Date.now(),
): void {
  const ledger = loadRowLedger();
  const keys = Object.keys(ledger);
  if (!keys.length) return;
  const reused = new Set([...reusedRowIds].map(rowLedgerKey));
  const live = new Set(rowIds.map(rowLedgerKey));
  const before = new Set(previousRowIds.map(rowLedgerKey));
  let changed = false;
  for (const key of keys) {
    const deleted = reused.has(key) || (!live.has(key) && (before.has(key) ||
      !(validTime(ledger[key]!.updatedAtMs) > now - UNSAVED_ROW_ENTRY_TTL_MS)));
    if (!deleted) continue;
    delete ledger[key];
    changed = true;
  }
  if (changed) saveRowLedger(ledger);
}
