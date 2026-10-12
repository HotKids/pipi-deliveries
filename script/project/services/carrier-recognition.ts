import type { Kuaidi100CarrierCandidate } from "./kuaidi100-carrier-detection";
import { detectKuaidi100CarrierCandidates } from "./kuaidi100-carrier-detection";
import {
  activeCarrierTableVersion,
  resolveCarrierKuaidi100Code,
  resolveCarrierQuery,
} from "./carrier-query";
import type { CarrierNormalization } from "./carrier-normalization";
import { GatewayError, postGateway } from "./gateway";
import { normalizeWaybill } from "./status";
import { deadlineExpired, OperationTimeoutError } from "./deadline";
import { RefreshCoordinator } from "./refresh-coordination";
import { writeDiagnostic } from "./logger";

const CACHE_KEY = "pipi_deliveries_carrier_recognition_v1";
/**
 * 用户 2026-09-27 第二轮清单：截断排后（预算截断的下一轮排到最后）；同步轮里被其它时限截住的也记，是截断排后细则，
 * 用户 2026-09-27 提交前核对答「这样做」。The waybills a sync round's time limits cut off, kept beside the recognition
 * record (same shared App Group storage, so every host — app, widget, App Intent — reads what another host's round
 * left: each host process is short-lived). Only the order of the next rounds reads it.
 */
const TRUNCATED_KEY = "pipi_deliveries_carrier_recognition_truncated_v1";
const MAX_TRUNCATION_MARKS = 256;
export const CARRIER_RETRY_DELAY_MS = 15 * 60 * 1_000;
export const CARRIER_NETWORK_FAILURE_LIMIT = 3;
const MAX_TRANSIENT_CACHE_ENTRIES = 256;
// A terminal verdict is a statement about one moment, not a permanent fact: the carrier table
// grows and the upstream recovers. The Worker's own terminal record already self-heals on this
// schedule, so the clients no longer outlive the server they ask.
export const CARRIER_TERMINAL_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * 用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒（「Lite、iOS 也对齐到每轮 30 秒」，与 Pipi
 * ExpressAutomaticCarrierRecognizer.ROUND_BUDGET_MILLIS 同一语义）。一轮同步里所有等承运商识别的时间共用这一份；
 * 不在同步轮里的一次用户操作（打开详情 / 详情下拉、首页存盘行投影、手动加件识别）各自一份。只计等识别的时间，
 * 列表请求等其它时间不算；调用方原有的截止时间照旧生效，取更早的那个。用光后剩下的运单不再发请求，留到下一轮
 * （照现有 T23 机制压着）；到点时在途的请求被取消，不写失败次数、不写终态。
 */
export const CARRIER_RECOGNITION_BUDGET_MS = 30_000;

/**
 * What is left of one round's (or one operation's) carrier-recognition wait. Only time during which
 * at least one recognition of the round is being waited for is spent: waits that overlap (the
 * round's concurrent manual-row tasks) spend it once, at the rate of the clock.
 */
export class CarrierRecognitionBudget {
  private remainingMs: number;
  private waits = 0;
  private waitingSinceMs = 0;
  /**
   * A sync round's budget (`runFullRefresh`). Only within a sync round is a waybill any time limit cuts off marked to go
   * last in the next rounds (用户 2026-09-27 第二轮清单：截断排后；任一时限截住都记是截断排后细则，用户 2026-09-27
   * 提交前核对答「这样做」); a user operation's budget marks nothing.
   */
  readonly syncRound: boolean;

  constructor(
    budgetMs = CARRIER_RECOGNITION_BUDGET_MS,
    options: Readonly<{ syncRound?: boolean }> = {},
  ) {
    this.remainingMs = Math.max(0, Math.floor(Number(budgetMs) || 0));
    this.syncRound = options.syncRound === true;
  }

  remainingAt(now = Date.now()): number {
    const waited = this.waits > 0 ? Math.max(0, now - this.waitingSinceMs) : 0;
    return Math.max(0, this.remainingMs - waited);
  }

  spent(now = Date.now()): boolean {
    return this.remainingAt(now) <= 0;
  }

  /** Opens one wait and returns the moment the budget runs out if the round keeps waiting. */
  beginWait(now = Date.now()): number {
    if (this.waits++ === 0) this.waitingSinceMs = now;
    return now + this.remainingAt(now);
  }

  endWait(now = Date.now()): void {
    if (this.waits <= 0) return;
    if (--this.waits === 0) {
      this.remainingMs = Math.max(0, this.remainingMs - Math.max(0, now - this.waitingSinceMs));
    }
  }

  exhaust(): void {
    this.remainingMs = 0;
  }
}

/**
 * The round's budget ran out before this waybill could be asked, or while it was being asked. Nothing
 * was recorded for the waybill: no failure count, no terminal verdict. Callers handle it as the
 * timeout it is: the row stays as it is until a later round.
 */
export class CarrierRecognitionBudgetSpentError extends OperationTimeoutError {}

type RetryStage = "auto_com_num" | "worker_classify";

export type CarrierRecognitionEntry = Readonly<{
  waybill: string;
  state: "resolved" | "terminal" | "needs_classify" | "retry";
  normalization?: CarrierNormalization;
  candidates?: readonly Kuaidi100CarrierCandidate[];
  retryStage?: RetryStage;
  networkFailures: number;
  retryAfterMs: number;
  updatedAtMs: number;
  /**
   * 其余裁决 32（用户 2026-09-26）：这张运单的识别第一次进入终态（连续 3 次失败，或付费级明确认不出）且快递100 没给名字的
   * 时间。之后 24 小时终态到期、重新识别又失败时照旧带着，直到真的识别出来；行上的原始承运商码因此不会来回闪、通知不会再被压。
   */
  exhaustedAtMs?: number;
}>;

export type CarrierRecognitionStore = Readonly<{
  load: () => readonly CarrierRecognitionEntry[];
  save: (entries: readonly CarrierRecognitionEntry[]) => void;
  /** 截断排后 marks; a store without them keeps its marks in memory. */
  loadTruncated?: () => readonly CarrierRecognitionTruncation[];
  saveTruncated?: (marks: readonly CarrierRecognitionTruncation[]) => void;
}>;

/**
 * 用户 2026-09-27 第二轮清单：截断排后；任一时限截住都记是截断排后细则（用户 2026-09-27 提交前核对答「这样做」）。
 * A waybill a sync round's time limits cut off, and when.
 */
export type CarrierRecognitionTruncation = Readonly<{
  waybill: string;
  truncatedAtMs: number;
  /**
   * How the round's time limit met it (same classes as Pipi and Lite): "skipped", not asked because the time was already
   * up; "cut", asked, and the request in flight was cut off — the waybill that hung. A mark stored before classes
   * existed has none and reads as "skipped".
   */
  kind?: CarrierRecognitionTruncationKind;
}>;

export type CarrierRecognitionTruncationKind = "skipped" | "cut";

export type CarrierRecognitionResult = Readonly<{
  normalization: CarrierNormalization | null;
  terminal: boolean;
  pendingSecondLevel: boolean;
  coolingDown: boolean;
  /**
   * 表外承运商（用户 2026-09-26，其余裁决 29）：快递100 免费识别认得出、却换不成内置表标准码时，它给的中文名。
   * 只作显示：不进表、没有专属图标、不改原始元组。有内置表结果时不给。
   */
  displayName?: string;
  /**
   * 其余裁决 32（用户 2026-09-26）：识别已进入终态（连续 3 次失败，或付费级明确认不出），快递100 也没给名字。这样的件不再
   * 无限期挂着：挂起的通知与停在订单阶段的投影照常放行，承运商位置显示原始承运商码。
   */
  exhausted?: boolean;
}>;

const recognitionCoordinators = new WeakMap<
  CarrierRecognitionStore,
  RefreshCoordinator<undefined, string, CarrierRecognitionResult, never>
>();

type FirstLevelDetector = typeof detectKuaidi100CarrierCandidates;
type SecondLevelClassifier = (input: Readonly<{
  waybill: string;
  firstStageCompleted: true;
  parcelAnchorAtMs?: number;
}>, options?: Readonly<{
  deadlineAtMs?: number;
  signal?: AbortSignal;
}>) => Promise<CarrierNormalization | null>;

class RetryableClassificationError extends Error {
  constructor() {
    super("retryable carrier classification failure");
    this.name = "RetryableClassificationError";
  }
}

type ClassificationResponse = Readonly<{
  auto?: readonly Readonly<{
    comCode?: unknown;
    name?: unknown;
  }>[];
}>;

/**
 * 用户 2026-10-03「答案按新件分开、总额仍按运单」（优化 5，接口约定协调方定）：请求带可选的 `parcelAnchorAtMs`——这一行自己
 * 记录的运单号重用锚点（services/waybill-reuse.ts：最早的有时间节点；没有节点取状态时间，再没有取最新时间）。须是大于 0、
 * 不在未来的时间，否则不传（Worker 照旧按运单记）。不认识这个字段的 Worker 忽略它，回答照常解析。
 */
export function classificationParcelAnchor(value: unknown, now = Date.now()): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= now ? value : undefined;
}

export function buildCarrierClassificationRequest(
  waybillInput: string,
  parcelAnchorAtMs?: number,
  now = Date.now(),
): Readonly<{
  route: "/api/express/classify";
  payload: Readonly<{ waybill: string; firstStageCompleted: true; parcelAnchorAtMs?: number }>;
}> {
  const waybill = normalizeWaybill(waybillInput);
  if (!waybill) throw new Error("invalid waybill");
  const anchor = classificationParcelAnchor(parcelAnchorAtMs, now);
  return {
    route: "/api/express/classify",
    payload: { waybill, firstStageCompleted: true, ...(anchor ? { parcelAnchorAtMs: anchor } : {}) },
  };
}

/**
 * Reads a 2xx /api/express/classify answer (audits C1/C4, adopted 2026-09-25; shared cases in
 * tests/fixtures/express/carrier-classify-responses.v1.json). The Worker answers with carrier
 * standard codes (KYSY, JTSD, ZTO…), never Kuaidi100 codes, so a candidate counts only when its
 * comCode is exactly a standard code of the current table. A 2xx without a resolvable candidate —
 * no `auto` list included — is a terminal answer, not a retry.
 */
export function parseCarrierClassificationResponse(
  response: ClassificationResponse,
): CarrierNormalization | null {
  if (!response || !Array.isArray(response.auto)) return null;
  for (const candidate of response.auto) {
    const code = typeof candidate?.comCode === "string"
      ? candidate.comCode.trim()
      : "";
    const record = code ? resolveCarrierQuery(code) : null;
    if (!record || record.standardCode !== code) continue;
    return {
      standardCode: record.standardCode,
      displayName: record.displayName,
      kuaidi100Code: record.kuaidi100Code,
      isBuiltIn: true,
      tableVersion: activeCarrierTableVersion(),
    };
  }
  return null;
}

/** The paid stage; `post` is the gateway call, replaceable so the shared fixtures can replay answers. */
export async function classifyWithWorker(input: Readonly<{
  waybill: string;
  firstStageCompleted: true;
  parcelAnchorAtMs?: number;
}>, options: Readonly<{
  deadlineAtMs?: number;
  signal?: AbortSignal;
}> = {}, post: typeof postGateway = postGateway): Promise<CarrierNormalization | null> {
  const request = buildCarrierClassificationRequest(input.waybill, input.parcelAnchorAtMs);
  let response: ClassificationResponse;
  try {
    response = await post<ClassificationResponse & Record<string, unknown>>(
      request.route,
      request.payload,
      {
        deadlineAtMs: options.deadlineAtMs,
        signal: options.signal,
      },
    );
  } catch (error) {
    if (error instanceof OperationTimeoutError || options.signal?.aborted) {
      throw new OperationTimeoutError();
    }
    if (error instanceof GatewayError && error.status === 502
        && error.gatewayCode === "recognition_pending"
        && Number.isSafeInteger(error.retryAtMs) && error.retryAtMs > 0) {
      throw error;
    }
    if (workerRefusedAccess(error)) throw error;
    // Every other answer, a 4xx included, is a counted failure (audit C4).
    throw new RetryableClassificationError();
  }
  return parseCarrierClassificationResponse(response);
}

/**
 * iOS only (user decision 2026-09-26, with the per-holder Access Key): a Worker 401 or 403 refuses
 * this device's key — invalid, replaced, revoked, or activated on another device — and says nothing
 * about the waybill. It is not a recognition failure: no count, no terminal verdict, no exhaustion;
 * the waybill cools down for the usual 15 minutes and asks again.
 */
function workerRefusedAccess(error: unknown): error is GatewayError {
  return error instanceof GatewayError && (error.status === 401 || error.status === 403);
}

function validCandidate(value: unknown): value is Kuaidi100CarrierCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<Kuaidi100CarrierCandidate>;
  return typeof candidate.courierCode === "string" &&
    /^[A-Za-z0-9_-]{1,32}$/.test(candidate.courierCode) &&
    typeof candidate.companyName === "string" &&
    candidate.companyName.length <= 64;
}

function durableStandardCode(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const normalization = value as Partial<CarrierNormalization>;
  const standardCode = typeof normalization.standardCode === "string"
    ? normalization.standardCode.trim().toUpperCase()
    : "";
  return /^[A-Z0-9]{2,16}$/.test(standardCode) &&
      standardCode === normalization.standardCode
    ? standardCode
    : "";
}

function currentBuiltInNormalization(
  value: unknown,
): CarrierNormalization | null {
  const standardCode = durableStandardCode(value);
  if (!standardCode) return null;
  const record = resolveCarrierQuery(standardCode);
  if (!record || record.standardCode !== standardCode) return null;
  return {
    standardCode: record.standardCode,
    displayName: record.displayName,
    kuaidi100Code: record.kuaidi100Code,
    isBuiltIn: true,
    tableVersion: activeCarrierTableVersion(),
  };
}

function hasCurrentBuiltInPresentation(
  value: unknown,
  current: CarrierNormalization,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const normalization = value as Partial<CarrierNormalization>;
  return normalization.standardCode === current.standardCode &&
    normalization.displayName === current.displayName &&
    normalization.kuaidi100Code === current.kuaidi100Code &&
    normalization.isBuiltIn === true &&
    normalization.tableVersion === current.tableVersion;
}

function validEntry(value: unknown): value is CarrierRecognitionEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<CarrierRecognitionEntry>;
  return Boolean(
    normalizeWaybill(entry.waybill || "") &&
    ["resolved", "terminal", "needs_classify", "retry"].includes(entry.state || "") &&
    Number.isInteger(entry.networkFailures) &&
    Number(entry.networkFailures) >= 0 &&
    typeof entry.retryAfterMs === "number" && Number.isFinite(entry.retryAfterMs) &&
    typeof entry.updatedAtMs === "number" && Number.isFinite(entry.updatedAtMs) &&
    (entry.state !== "resolved" || Boolean(durableStandardCode(entry.normalization))) &&
    (entry.candidates == null ||
      (Array.isArray(entry.candidates) && entry.candidates.every(validCandidate)))
  );
}

const storageStore: CarrierRecognitionStore = {
  load: () => {
    try {
      const raw = Storage.get<string>(CACHE_KEY, { shared: true });
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return parseCarrierRecognitionEntries(parsed);
    } catch {
      return [];
    }
  },
  save: (entries) => {
    const value = JSON.stringify(retainCarrierRecognitionEntries(entries));
    if (Storage.set(CACHE_KEY, value, { shared: true }) === false) {
      throw new Error("carrier recognition cache unavailable");
    }
  },
  loadTruncated: () => {
    try {
      const raw = Storage.get<string>(TRUNCATED_KEY, { shared: true });
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return Array.isArray(parsed) ? parsed.filter(validTruncation) : [];
    } catch {
      return [];
    }
  },
  saveTruncated: (marks) => {
    if (Storage.set(TRUNCATED_KEY, JSON.stringify(marks), { shared: true }) === false) {
      throw new Error("carrier recognition truncation marks unavailable");
    }
  },
};

function validTruncation(value: unknown): value is CarrierRecognitionTruncation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const mark = value as Partial<CarrierRecognitionTruncation>;
  return typeof mark.waybill === "string" && Boolean(normalizeWaybill(mark.waybill)) &&
    normalizeWaybill(mark.waybill) === mark.waybill &&
    typeof mark.truncatedAtMs === "number" && Number.isFinite(mark.truncatedAtMs) &&
    (mark.kind === undefined || mark.kind === "skipped" || mark.kind === "cut");
}

/** An old mark without a class was not asked. */
function truncationKind(mark: CarrierRecognitionTruncation): CarrierRecognitionTruncationKind {
  return mark.kind === "cut" ? "cut" : "skipped";
}

/** The waybills each sync round cut off in flight, so a later "not asked" in the same round does not demote them. */
const roundCuts = new WeakMap<CarrierRecognitionBudget, Set<string>>();

const memoryTruncations = new WeakMap<CarrierRecognitionStore, readonly CarrierRecognitionTruncation[]>();

function loadTruncations(store: CarrierRecognitionStore): readonly CarrierRecognitionTruncation[] {
  try {
    return store.loadTruncated ? store.loadTruncated() : memoryTruncations.get(store) || [];
  } catch {
    return [];
  }
}

/** Best effort: a mark only orders later rounds, so failing to keep one changes no recognition result. */
function saveTruncations(
  store: CarrierRecognitionStore,
  marks: readonly CarrierRecognitionTruncation[],
): void {
  const kept = marks.slice(0, MAX_TRUNCATION_MARKS);
  try {
    if (store.saveTruncated) store.saveTruncated(kept);
    else memoryTruncations.set(store, kept);
  } catch {
    /* the next rounds keep their ordinary order */
  }
}

/**
 * 截断排后: the waybill goes last in the next rounds, with this round's class replacing an earlier round's; within one
 * round a waybill cut off in flight stays "cut". No failure count, no terminal verdict.
 */
function markTruncated(
  store: CarrierRecognitionStore,
  waybill: string,
  now: number,
  kind: CarrierRecognitionTruncationKind,
  round: CarrierRecognitionBudget,
): void {
  let cutThisRound = roundCuts.get(round);
  if (!cutThisRound) {
    cutThisRound = new Set();
    roundCuts.set(round, cutThisRound);
  }
  if (kind === "cut") cutThisRound.add(waybill);
  else if (cutThisRound.has(waybill)) return;
  const others = loadTruncations(store).filter((mark) => mark.waybill !== waybill);
  saveTruncations(store, [{ waybill, truncatedAtMs: now, kind }, ...others]);
}

/** 截断排后: a waybill recognised (built-in carrier or Kuaidi100's off-table name) or given a terminal verdict leaves the end of the queue. */
function settleTruncation(
  store: CarrierRecognitionStore,
  waybill: string,
  outcome: CarrierRecognitionResult,
): void {
  if (!outcome.normalization && !outcome.displayName && !outcome.terminal) return;
  const marks = loadTruncations(store);
  if (!marks.some((mark) => mark.waybill === waybill)) return;
  saveTruncations(store, marks.filter((mark) => mark.waybill !== waybill));
}

/**
 * 承运商复用旧运单号（用户 2026-10-02 细节 2）：新件拿走这个号码时，这台设备上这个号码的识别记录（结果、失败次数、冷却、
 * 终态、表外名）一并清掉，新件从头识别。截断排后记录只管排序，留着（协调方 2026-10-02，与 Pipi 同）。Worker 自己的识别与
 * 付费记录不在这里（Worker 付费计数重置待定）。
 */
export function forgetCarrierRecognition(
  waybillInput: string,
  store: CarrierRecognitionStore = storageStore,
): void {
  const waybill = normalizeWaybill(waybillInput);
  if (!waybill) return;
  const entries = store.load();
  if (entries.some((entry) => normalizeWaybill(entry.waybill) === waybill)) {
    store.save(entries.filter((entry) => normalizeWaybill(entry.waybill) !== waybill));
  }
}

/** 用户 2026-09-27 第二轮清单：截断排后。Whether a sync round cut this waybill off and it has not settled since. */
export function carrierRecognitionTruncated(
  waybillInput: string,
  store: CarrierRecognitionStore = storageStore,
): boolean {
  const waybill = normalizeWaybill(waybillInput);
  return Boolean(waybill) && loadTruncations(store).some((mark) => mark.waybill === waybill);
}

/**
 * 用户 2026-09-27 第二轮清单：截断排后（「被截断的下一轮排到最后」）。Orders a round's recognition work, as Pipi and Lite
 * do: first the items no round cut off, then those a round left unasked, last those whose request a round cut off in
 * flight — so the waybill that hung does not come first again and hold up the rest. Each group keeps its own order.
 * 分这两类（时限到时正在请求的那张排在没来得及问的后面）是截断排后细则，用户 2026-09-27 提交前核对答「这样做」；上面
 * 的理由是助手提问时写的，不是用户原话。
 * Items without a marked waybill — nearly always all of them — are returned as they were.
 */
export function truncatedCarrierRecognitionLast<T>(
  items: readonly T[],
  waybillsOf: (item: T) => readonly (string | null | undefined)[],
  store: CarrierRecognitionStore = storageStore,
): T[] {
  const marks = loadTruncations(store);
  if (!marks.length) return [...items];
  const kindOf = new Map(marks.map((mark) => [mark.waybill, truncationKind(mark)]));
  const untruncated: T[] = [];
  const skipped: T[] = [];
  const cut: T[] = [];
  for (const item of items) {
    const found = waybillsOf(item).map((waybill) => kindOf.get(normalizeWaybill(waybill || "")));
    const group = found.includes("cut") ? cut : found.includes("skipped") ? skipped : untruncated;
    group.push(item);
  }
  return [...untruncated, ...skipped, ...cut];
}

export function parseCarrierRecognitionEntries(
  value: unknown,
): CarrierRecognitionEntry[] {
  return Array.isArray(value) ? value.filter(validEntry) : [];
}

export function retainCarrierRecognitionEntries(
  entries: readonly CarrierRecognitionEntry[],
): CarrierRecognitionEntry[] {
  const ordered = [...entries].sort(
    (left, right) => right.updatedAtMs - left.updatedAtMs,
  );
  const durable = ordered.filter(
    (entry) => entry.state === "resolved" || entry.state === "terminal",
  );
  const transient = ordered.filter(
    (entry) => entry.state !== "resolved" && entry.state !== "terminal",
  );
  // 用户 2026-09-27 提交前核对答复五：带「已放弃」（exhaustedAtMs）的记录不参与挤掉。A released waybill (其余裁决 32) keeps
  // its mark through the cap; losing it would count its next failure as a first one and hold its notification again.
  const released = transient.filter((entry) => Number(entry.exhaustedAtMs) > 0);
  const capped = transient.filter((entry) => !(Number(entry.exhaustedAtMs) > 0))
    .slice(0, MAX_TRANSIENT_CACHE_ENTRIES);
  return [...durable, ...released, ...capped].sort(
    (left, right) => right.updatedAtMs - left.updatedAtMs,
  );
}

/**
 * A terminal entry stops binding once it is older than the Worker's own self-heal window.
 *
 * An entry whose timestamp cannot be read stops binding at once rather than binding forever: a
 * record we cannot date must not outrank one we can, and the app offers no way to clear this
 * cache, so the only cost of asking again is one free recognition call.
 */
export function terminalStillBinding(
  entry: Readonly<{ updatedAtMs?: number }>,
  now: number,
): boolean {
  const writtenAt = entry.updatedAtMs || 0;
  if (writtenAt <= 0) return false;
  if (now < writtenAt) return true;
  return now - writtenAt < CARRIER_TERMINAL_TTL_MS;
}

/** The Kuaidi100 name of an entry the table cannot place (其余裁决 29); "" when it has none. */
function offTableName(entry: CarrierRecognitionEntry): string {
  if (entry.state === "resolved") return "";
  for (const candidate of entry.candidates || []) {
    const name = String(candidate.companyName || "").trim();
    if (name && name !== "快递") return name;
  }
  return "";
}

/** Whether the entry records an exhausted recognition (其余裁决 32): terminal, or retrying after one, without a name. */
function entryExhausted(entry: CarrierRecognitionEntry): boolean {
  if (entry.state === "resolved" || offTableName(entry)) return false;
  return entry.state === "terminal" || Number(entry.exhaustedAtMs) > 0;
}

/** The exhaustion time a new entry for the same waybill carries forward (其余裁决 32). */
function exhaustedSince(entry: CarrierRecognitionEntry | undefined): number {
  if (!entry || !entryExhausted(entry)) return 0;
  return Number(entry.exhaustedAtMs) > 0 ? Number(entry.exhaustedAtMs) : entry.updatedAtMs;
}

function result(entry: CarrierRecognitionEntry): CarrierRecognitionResult {
  const normalization = entry.state === "resolved"
    ? currentBuiltInNormalization(entry.normalization)
    : null;
  const displayName = normalization ? "" : offTableName(entry);
  return {
    normalization,
    terminal: entry.state === "terminal",
    pendingSecondLevel:
      entry.state === "needs_classify" ||
      (entry.state === "retry" && entry.retryStage === "worker_classify"),
    coolingDown: entry.state === "retry" && Date.now() < entry.retryAfterMs,
    ...(displayName ? { displayName } : {}),
    ...(!normalization && entryExhausted(entry) ? { exhausted: true } : {}),
  };
}

export type CachedCarrierRecognition = Readonly<{
  normalization: CarrierNormalization | null;
  displayName: string;
  kuaidi100Code: string;
}>;

function findEntry(
  store: CarrierRecognitionStore,
  waybill: string,
): CarrierRecognitionEntry | undefined {
  return store.load().find((entry) => normalizeWaybill(entry.waybill) === waybill);
}

/**
 * T23（用户 2026-09-26，其余裁决 28）：这张运单的承运商在识别缓存里已经对上了没有——内置表结果，或快递100 认得出的
 * 表外名。只读、不发请求；同步的展示路径（订单文案套号）靠它判断能不能把运单号亮出来。没对上返回 null。
 */
export function cachedCarrierRecognition(
  waybillInput: string,
  store: CarrierRecognitionStore = storageStore,
): CachedCarrierRecognition | null {
  const waybill = normalizeWaybill(waybillInput);
  if (!waybill) return null;
  const entry = findEntry(store, waybill);
  if (!entry) return null;
  const outcome = result(entry);
  if (outcome.normalization) {
    return {
      normalization: outcome.normalization,
      displayName: outcome.normalization.displayName,
      kuaidi100Code: outcome.normalization.kuaidi100Code,
    };
  }
  if (!outcome.displayName) return null;
  const code = (entry.candidates || []).find((candidate) =>
    String(candidate.companyName || "").trim() === outcome.displayName)?.courierCode || "";
  return { normalization: null, displayName: outcome.displayName, kuaidi100Code: code };
}

/**
 * 其余裁决 32（用户 2026-09-26）：这张运单的识别已进入终态、快递100 也没给名字（只读、不发请求）。之后因终态到期重新
 * 识别又失败时仍算，直到真的识别出来。
 */
export function carrierRecognitionExhausted(
  waybillInput: string,
  store: CarrierRecognitionStore = storageStore,
): boolean {
  const waybill = normalizeWaybill(waybillInput);
  if (!waybill) return false;
  const entry = findEntry(store, waybill);
  return Boolean(entry && entryExhausted(entry));
}

/**
 * T23: whether asking the recognizer about this waybill now can give an answer the cache does not already hold as
 * "nothing": no entry yet, a carrier already known, or a rest that has run out. A cooling retry or a still-binding
 * terminal verdict without a name answers nothing new, so a held projection is not re-reserved for it.
 */
export function carrierRecognitionDue(
  waybillInput: string,
  now = Date.now(),
  store: CarrierRecognitionStore = storageStore,
): boolean {
  const waybill = normalizeWaybill(waybillInput);
  if (!waybill) return false;
  const entry = findEntry(store, waybill);
  if (!entry || entry.state === "resolved" || entry.state === "needs_classify") return true;
  if (offTableName(entry)) return true;
  if (entry.state === "terminal") return !terminalStillBinding(entry, now);
  return now >= entry.retryAfterMs;
}

function writeEntry(
  store: CarrierRecognitionStore,
  entryInput: CarrierRecognitionEntry,
  exhaustedBefore = 0,
): CarrierRecognitionResult {
  // 其余裁决 32: an exhausted recognition stays exhausted through later failures, until a carrier is recognised (a
  // terminal entry is exhausted by its state; the time is carried to the entries that follow it).
  const { exhaustedAtMs: _previous, ...plain } = entryInput;
  const exhaustedAtMs = entryInput.state === "resolved" || offTableName(entryInput) ? 0 : exhaustedBefore;
  const entry: CarrierRecognitionEntry = exhaustedAtMs > 0 ? { ...plain, exhaustedAtMs } : plain;
  const key = normalizeWaybill(entry.waybill);
  const entries = store.load().filter(
    (value) => normalizeWaybill(value.waybill) !== key,
  );
  store.save([entry, ...entries]);
  return result(entry);
}

function localNormalization(
  candidates: readonly Kuaidi100CarrierCandidate[],
): CarrierNormalization | null {
  for (const candidate of candidates) {
    const record = resolveCarrierKuaidi100Code(candidate.courierCode);
    if (!record) continue;
    return {
      standardCode: record.standardCode,
      displayName: record.displayName,
      kuaidi100Code: record.kuaidi100Code,
      isBuiltIn: true,
      tableVersion: activeCarrierTableVersion(),
    };
  }
  return null;
}

function networkFailure(
  store: CarrierRecognitionStore,
  waybill: string,
  previousFailures: number,
  stage: RetryStage,
  candidates: readonly Kuaidi100CarrierCandidate[],
  now: number,
  exhaustedBefore = 0,
): CarrierRecognitionResult {
  const networkFailures = previousFailures + 1;
  return writeEntry(store, {
    waybill,
    state: networkFailures >= CARRIER_NETWORK_FAILURE_LIMIT ? "terminal" : "retry",
    candidates: stage === "worker_classify" ? candidates : [],
    retryStage: stage,
    networkFailures,
    retryAfterMs: networkFailures >= CARRIER_NETWORK_FAILURE_LIMIT
      ? 0
      : now + CARRIER_RETRY_DELAY_MS,
    updatedAtMs: now,
  }, exhaustedBefore);
}

type RecognitionOptions = Readonly<{
  deadlineAtMs?: number;
  signal?: AbortSignal;
  /** The round's (or operation's) shared wait budget; absent, this call has one of its own. */
  budget?: CarrierRecognitionBudget;
  detect?: FirstLevelDetector;
  classify?: SecondLevelClassifier;
  store?: CarrierRecognitionStore;
  now?: number;
  /**
   * The asking row's own waybill-reuse anchor, sent with the paid stage (优化 5, 2026-10-03); omitted when invalid. A
   * function is asked only right before the paid request goes out (优化 5 续「第一次识别时记下锚点，之后不变」: the row
   * ledger records the first anchor then). Two callers asking the same waybill at once share one request, and the first
   * caller's anchor goes with it.
   */
  parcelAnchorAtMs?: number | (() => number | undefined);
}>;

/**
 * What the cache already answers without a request — the answers `runCarrierRecognition` gives before
 * it asks anyone — or null when only a request can answer. A spent budget still gives these: they
 * cost no wait.
 */
function cacheOnlyAnswer(
  entry: CarrierRecognitionEntry | undefined,
  now: number,
): CarrierRecognitionResult | null {
  if (!entry) return null;
  if (entry.state === "resolved") {
    const normalization = currentBuiltInNormalization(entry.normalization);
    return normalization ? result({ ...entry, normalization }) : null;
  }
  if (entry.state === "terminal") return terminalStillBinding(entry, now) ? result(entry) : null;
  if (entry.state === "retry" && now < entry.retryAfterMs) return { ...result(entry), coolingDown: true };
  return null;
}

export async function recognizeNonSyncCarrier(
  waybillInput: string,
  options: RecognitionOptions = {},
): Promise<CarrierRecognitionResult> {
  const waybill = normalizeWaybill(waybillInput);
  if (!waybill) {
    return {
      normalization: null,
      terminal: false,
      pendingSecondLevel: false,
      coolingDown: false,
    };
  }
  const store = options.store || storageStore;
  // 用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒。A call outside a round has a budget of its own.
  const budget = options.budget || new CarrierRecognitionBudget();
  // 用户 2026-09-27 第二轮清单：截断排后（预算截断的下一轮排到最后）；同步轮里被任一时限截住的也记，是截断排后细则，
  // 用户 2026-09-27 提交前核对答「这样做」。In a sync round, a recognition any time limit cuts off — the round's budget, the
  // stage's own deadline (the account list's 25 seconds), the host's remaining time, the request's own timeout — goes
  // last in the next rounds, so one waybill that hangs cannot hold up the ones after it every round. A user operation
  // marks nothing. The caller's cancellation is not a time limit.
  const cutOff = (at: number, kind: CarrierRecognitionTruncationKind) => {
    if (budget.syncRound && !options.signal?.aborted) markTruncated(store, waybill, at, kind, budget);
  };
  if (deadlineExpired(options.deadlineAtMs)) {
    // Past the caller's deadline: not asked. A waybill the cache already answers needs no request, so it is not cut off.
    if (!cacheOnlyAnswer(findEntry(store, waybill), options.now ?? Date.now())) cutOff(Date.now(), "skipped");
    throw new OperationTimeoutError();
  }
  const now = Date.now();
  if (budget.spent(now)) {
    const cached = cacheOnlyAnswer(findEntry(store, waybill), options.now ?? now);
    if (cached) {
      settleTruncation(store, waybill, cached);
      return cached;
    }
    // Not asked because the round's budget is spent.
    cutOff(now, "skipped");
    throw new CarrierRecognitionBudgetSpentError();
  }
  let coordinator = recognitionCoordinators.get(store);
  if (!coordinator) {
    coordinator = new RefreshCoordinator<undefined, string, CarrierRecognitionResult, never>();
    recognitionCoordinators.set(store, coordinator);
  }
  const budgetDeadlineAtMs = budget.beginWait(now);
  // The caller's own deadline still applies; the budget never extends it.
  const waitDeadlineAtMs = options.deadlineAtMs == null
    ? budgetDeadlineAtMs
    : Math.min(options.deadlineAtMs, budgetDeadlineAtMs);
  try {
    // When this wait ends first, the coordinator aborts the request (unless another consumer still
    // waits for it); an aborted recognition records nothing.
    const outcome = await coordinator.runIndependentDetail(
      waybill,
      undefined,
      signal => reportCarrierRecognition(
        waybill,
        { ...options, deadlineAtMs: undefined, signal },
      ),
      waitDeadlineAtMs,
      options.signal,
    );
    settleTruncation(store, waybill, outcome);
    return outcome;
  } catch (error) {
    // The budget, not the caller's deadline or cancellation, ended this wait: at its end, the wait timed
    // out, or the request's own timeout arrived no earlier.
    if (error instanceof OperationTimeoutError && !options.signal?.aborted) {
      // 截断排后: whichever time limit ended this wait — the budget, the caller's deadline, the request's own timeout — it
      // cut off a request in flight.
      cutOff(Date.now(), "cut");
      if (waitDeadlineAtMs === budgetDeadlineAtMs &&
          (error.waitDetails?.waitTimeoutOrigin === "deadline" || Date.now() >= budgetDeadlineAtMs)) {
        budget.exhaust();
        throw new CarrierRecognitionBudgetSpentError();
      }
    }
    throw error;
  } finally {
    budget.endWait(Date.now());
  }
}

/**
 * Records one line per recognition attempt. Until now this path wrote nothing at all, so every
 * way of ending up without a carrier — an answer outside the built-in table, a burnt-in terminal
 * entry, a network failure, a cooling-down retry — reached the screen as the same absent chip and
 * could only be told apart by reading device storage.
 */
async function reportCarrierRecognition(
  waybill: string,
  options: RecognitionOptions,
): Promise<CarrierRecognitionResult> {
  const cachedBefore = (options.store || storageStore).load().find(
    (entry) => normalizeWaybill(entry.waybill) === waybill,
  );
  try {
    const outcome = await runCarrierRecognition(waybill, options);
    writeDiagnostic("carrier.recognition.completed", {
      waybillTail: waybill.slice(-4),
      // The shared words for this endpoint, the ones Pipi already tags it with: source
      // k100_autoCom, stage classify. The internal retryStage names stay internal.
      stage: "classify",
      // An off-table carrier is logged with Kuaidi100's own code, so the ones that appear can be reviewed for the
      // Worker table (其余裁决 29, 2026-09-26).
      carrierCode: outcome.normalization?.standardCode ||
        (outcome.displayName
          ? cachedCarrierRecognition(waybill, options.store || storageStore)?.kuaidi100Code || undefined
          : undefined),
      carrierCandidateCount: cachedBefore?.candidates?.length,
      attempt: (cachedBefore?.networkFailures || 0) + 1,
      skipReason: cachedBefore?.state,
      result: outcome.normalization
        ? "succeeded"
        : outcome.displayName
          ? "off_table"
        : outcome.terminal
          ? "terminal"
          : outcome.coolingDown
            ? "cooldown"
            : outcome.pendingSecondLevel ? "pending" : "no_result",
    });
    return outcome;
  } catch (error) {
    writeDiagnostic("carrier.recognition.completed", {
      waybillTail: waybill.slice(-4),
      attempt: (cachedBefore?.networkFailures || 0) + 1,
      skipReason: cachedBefore?.state,
      result: "failed",
    }, "error");
    throw error;
  }
}

async function runCarrierRecognition(
  waybill: string,
  options: RecognitionOptions,
): Promise<CarrierRecognitionResult> {
  if (options.signal?.aborted) throw new OperationTimeoutError();
  const now = options.now ?? Date.now();
  const store = options.store || storageStore;
  const loadedCached = store.load().find(
    (entry) => normalizeWaybill(entry.waybill) === waybill,
  );
  const exhaustedBefore = exhaustedSince(loadedCached);
  if (loadedCached?.state === "resolved") {
    const normalization = currentBuiltInNormalization(
      loadedCached.normalization,
    );
    if (normalization) {
      const rebuilt = { ...loadedCached, normalization };
      if (hasCurrentBuiltInPresentation(
        loadedCached.normalization,
        normalization,
      )) {
        return result(rebuilt);
      }
      return writeEntry(store, {
        ...rebuilt,
        updatedAtMs: now,
      });
    }
  }
  let cached = loadedCached?.state === "resolved" ? undefined : loadedCached;
  if (cached?.state === "terminal") {
    if (terminalStillBinding(cached, now)) return result(cached);
    // An expired verdict releases its failure count with it. Carrying the old three forward
    // would let the very next failure re-terminate the waybill, leaving one attempt a day
    // forever — Pipi and Lite both start the budget again, and this is the same rule.
    cached = undefined;
  }
  if (cached?.state === "retry" && now < cached.retryAfterMs) {
    return {
      ...result(cached),
      coolingDown: true,
    };
  }

  let candidates = cached?.candidates || [];
  // Every attempt starts with the free stage (audit C4, adopted 2026-09-25): a retry after a failed
  // or pending paid stage runs autoComNum again instead of going straight back to the paid route.
  try {
    candidates = await (options.detect || detectKuaidi100CarrierCandidates)(
      waybill,
      { deadlineAtMs: options.deadlineAtMs, signal: options.signal },
    );
    if (options.signal?.aborted) throw new OperationTimeoutError();
  } catch (error) {
    if (error instanceof OperationTimeoutError || options.signal?.aborted) {
      throw new OperationTimeoutError();
    }
    return networkFailure(
      store,
      waybill,
      cached?.networkFailures || 0,
      "auto_com_num",
      [],
      now,
      exhaustedBefore,
    );
  }
  const local = localNormalization(candidates);
  if (local) {
    return writeEntry(store, {
      waybill,
      state: "resolved",
      normalization: local,
      candidates: [],
      networkFailures: 0,
      retryAfterMs: 0,
      updatedAtMs: now,
    });
  }

  const classify = options.classify || classifyWithWorker;
  let parcelAnchorAtMs: number | undefined;
  try {
    parcelAnchorAtMs = classificationParcelAnchor(typeof options.parcelAnchorAtMs === "function"
      ? options.parcelAnchorAtMs()
      : options.parcelAnchorAtMs);
  } catch {
    // An anchor that cannot be read is simply not sent; it never fails the recognition.
    parcelAnchorAtMs = undefined;
  }
  try {
    const normalization = await classify({
      waybill,
      firstStageCompleted: true,
      ...(parcelAnchorAtMs ? { parcelAnchorAtMs } : {}),
    }, {
      deadlineAtMs: options.deadlineAtMs,
      signal: options.signal,
    });
    if (options.signal?.aborted) throw new OperationTimeoutError();
    const currentNormalization = currentBuiltInNormalization(normalization);
    if (currentNormalization) {
      return writeEntry(store, {
        waybill,
        state: "resolved",
        normalization: currentNormalization,
        candidates: [],
        networkFailures: 0,
        retryAfterMs: 0,
        updatedAtMs: now,
      });
    }
    // A paid no-match is a 24-hour terminal verdict of its own; it does not carry a failure count. The free stage's
    // candidates stay with it: a named one is the off-table carrier shown for display (其余裁决 29, 2026-09-26).
    return writeEntry(store, {
      waybill,
      state: "terminal",
      candidates,
      networkFailures: 0,
      retryAfterMs: 0,
      updatedAtMs: now,
    }, exhaustedBefore);
  } catch (error) {
    if (error instanceof OperationTimeoutError || options.signal?.aborted) {
      throw new OperationTimeoutError();
    }
    if (error instanceof GatewayError && error.status === 502
        && error.gatewayCode === "recognition_pending"
        && Number.isSafeInteger(error.retryAtMs) && error.retryAtMs > now) {
      return writeEntry(store, {
        waybill, state: "retry", retryStage: "worker_classify", candidates,
        networkFailures: cached?.networkFailures || 0,
        retryAfterMs: Math.min(error.retryAtMs, now + CARRIER_RETRY_DELAY_MS),
        updatedAtMs: now,
      }, exhaustedBefore);
    }
    if (workerRefusedAccess(error)) {
      return writeEntry(store, {
        waybill, state: "retry", retryStage: "worker_classify", candidates,
        networkFailures: cached?.networkFailures || 0,
        retryAfterMs: now + CARRIER_RETRY_DELAY_MS,
        updatedAtMs: now,
      }, exhaustedBefore);
    }
    return networkFailure(
      store,
      waybill,
      cached?.networkFailures || 0,
      "worker_classify",
      candidates,
      now,
      exhaustedBefore,
    );
  }
}
