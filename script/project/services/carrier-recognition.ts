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
import { OperationTimeoutError } from "./deadline";

const CACHE_KEY = "pipi_deliveries_carrier_recognition_v1";
export const CARRIER_RETRY_DELAY_MS = 15 * 60 * 1_000;
export const CARRIER_NETWORK_FAILURE_LIMIT = 3;
const MAX_TRANSIENT_CACHE_ENTRIES = 256;

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
}>;

export type CarrierRecognitionStore = Readonly<{
  load: () => readonly CarrierRecognitionEntry[];
  save: (entries: readonly CarrierRecognitionEntry[]) => void;
}>;

export type CarrierRecognitionResult = Readonly<{
  normalization: CarrierNormalization | null;
  terminal: boolean;
  pendingSecondLevel: boolean;
  coolingDown: boolean;
}>;

type FirstLevelDetector = typeof detectKuaidi100CarrierCandidates;
type SecondLevelClassifier = (input: Readonly<{
  waybill: string;
  firstStageCompleted: true;
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

export function buildCarrierClassificationRequest(waybillInput: string): Readonly<{
  route: "/api/express/classify";
  payload: Readonly<{ waybill: string; firstStageCompleted: true }>;
}> {
  const waybill = normalizeWaybill(waybillInput);
  if (!waybill) throw new Error("invalid waybill");
  return {
    route: "/api/express/classify",
    payload: { waybill, firstStageCompleted: true },
  };
}

export function parseCarrierClassificationResponse(
  response: ClassificationResponse,
): CarrierNormalization | null {
  if (!Array.isArray(response.auto)) {
    throw new RetryableClassificationError();
  }
  for (const candidate of response.auto) {
    const code = typeof candidate?.comCode === "string"
      ? candidate.comCode.trim()
      : "";
    const record = resolveCarrierKuaidi100Code(code);
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

async function classifyWithWorker(input: Readonly<{
  waybill: string;
  firstStageCompleted: true;
}>, options: Readonly<{
  deadlineAtMs?: number;
  signal?: AbortSignal;
}> = {}): Promise<CarrierNormalization | null> {
  const request = buildCarrierClassificationRequest(input.waybill);
  let response: ClassificationResponse;
  try {
    response = await postGateway<ClassificationResponse & Record<string, unknown>>(
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
    if (
      !(error instanceof GatewayError) ||
      error.status === 0 ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500
    ) {
      throw new RetryableClassificationError();
    }
    throw error;
  }
  return parseCarrierClassificationResponse(response);
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
};

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
  ).slice(0, MAX_TRANSIENT_CACHE_ENTRIES);
  return [...durable, ...transient].sort(
    (left, right) => right.updatedAtMs - left.updatedAtMs,
  );
}

function result(entry: CarrierRecognitionEntry): CarrierRecognitionResult {
  return {
    normalization: entry.state === "resolved"
      ? currentBuiltInNormalization(entry.normalization)
      : null,
    terminal: entry.state === "terminal",
    pendingSecondLevel:
      entry.state === "needs_classify" ||
      (entry.state === "retry" && entry.retryStage === "worker_classify"),
    coolingDown: entry.state === "retry" && Date.now() < entry.retryAfterMs,
  };
}

function writeEntry(
  store: CarrierRecognitionStore,
  entry: CarrierRecognitionEntry,
): CarrierRecognitionResult {
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
  });
}

export async function recognizeNonSyncCarrier(
  waybillInput: string,
  options: Readonly<{
    deadlineAtMs?: number;
    signal?: AbortSignal;
    detect?: FirstLevelDetector;
    classify?: SecondLevelClassifier;
    store?: CarrierRecognitionStore;
    now?: number;
  }> = {},
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
  const now = options.now ?? Date.now();
  const store = options.store || storageStore;
  const loadedCached = store.load().find(
    (entry) => normalizeWaybill(entry.waybill) === waybill,
  );
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
  const cached = loadedCached?.state === "resolved" ? undefined : loadedCached;
  if (cached?.state === "terminal") {
    return result(cached);
  }
  if (cached?.state === "retry" && now < cached.retryAfterMs) {
    return {
      ...result(cached),
      coolingDown: true,
    };
  }

  let candidates = cached?.candidates || [];
  const retryingClassifier = cached?.state === "needs_classify" ||
    (cached?.state === "retry" && cached.retryStage === "worker_classify");
  if (!retryingClassifier) {
    try {
      candidates = await (options.detect || detectKuaidi100CarrierCandidates)(
        waybill,
        { deadlineAtMs: options.deadlineAtMs, signal: options.signal },
      );
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
  }

  const classify = options.classify || classifyWithWorker;
  try {
    const normalization = await classify({
      waybill,
      firstStageCompleted: true,
    }, {
      deadlineAtMs: options.deadlineAtMs,
      signal: options.signal,
    });
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
    return writeEntry(store, {
      waybill,
      state: "terminal",
      candidates: [],
      networkFailures: cached?.networkFailures || 0,
      retryAfterMs: 0,
      updatedAtMs: now,
    });
  } catch (error) {
    if (error instanceof OperationTimeoutError || options.signal?.aborted) {
      throw new OperationTimeoutError();
    }
    if (!(error instanceof RetryableClassificationError) && error instanceof GatewayError) {
      throw error;
    }
    return networkFailure(
      store,
      waybill,
      cached?.networkFailures || 0,
      "worker_classify",
      candidates,
      now,
    );
  }
}
