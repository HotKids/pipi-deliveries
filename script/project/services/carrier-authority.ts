import { postGateway } from "./gateway";
import {
  readDurableTextResult,
  writeDurableText,
} from "./durable-files";
import {
  installCarrierQueryRecords,
  validateCarrierQueryRecords,
  type CarrierQueryRecord,
} from "./carrier-query";

const CARRIER_AUTHORITY_ROUTE = "/api/express/carriers";
const CARRIER_AUTHORITY_FILE = "carrier-authority-v2.json";
const CARRIER_AUTHORITY_ATTEMPT_FILE = "carrier-authority-attempt-v1.json";
const STORAGE_SCHEMA = 1;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export type CarrierAuthorityPayload = Readonly<{
  schemaVersion: 2;
  version: string;
  source: string;
  entries: readonly CarrierQueryRecord[];
}>;

type StoredCarrierAuthority = Readonly<{
  storageSchema: 1;
  fetchedAtMs: number;
  payload: CarrierAuthorityPayload;
}>;

type StoredCarrierAuthorityAttempt = Readonly<{
  storageSchema: 1;
  lastAttemptAtMs: number;
}>;

type CarrierAuthorityDependencies = Readonly<{
  post?: (
    route: string,
    body: Record<string, never>,
    options: Readonly<{ timeoutMs: number }>,
  ) => Promise<unknown>;
}>;

let loadedFetchedAtMs = 0;
let loadedLastAttemptAtMs = 0;

function text(value: unknown, pattern: RegExp, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= maxLength && pattern.test(clean) ? clean : null;
}

function list(value: unknown, maxLength = 64): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const clean = item.trim();
    if (!clean || clean.length > maxLength) return null;
    if (!result.includes(clean)) result.push(clean);
  }
  return Object.freeze(result);
}

function entry(value: unknown): CarrierQueryRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const standardCode = text(raw.standardCode, /^[A-Z0-9]+$/, 16);
  const displayName = text(raw.displayName, /^.+$/u, 64);
  const kuaidi100Code = text(raw.kuaidi100Code, /^[a-z0-9_-]+$/, 32);
  const hotline = typeof raw.hotline === "string" && raw.hotline.length <= 32
    ? raw.hotline.trim()
    : null;
  const iconKey = text(raw.iconKey, /^[a-z0-9_-]+$/, 32);
  const codeAliases = list(raw.codeAliases);
  const kuaidi100CodeAliases = raw.kuaidi100CodeAliases == null
    ? Object.freeze([] as string[])
    : list(raw.kuaidi100CodeAliases);
  const codePrefixAliases = raw.codePrefixAliases == null
    ? Object.freeze([] as string[])
    : list(raw.codePrefixAliases);
  const nameAliases = list(raw.nameAliases);
  if (!standardCode || !displayName || kuaidi100Code == null || hotline == null ||
    !iconKey || typeof raw.requiresPhoneTail !== "boolean" || !codeAliases ||
    !kuaidi100CodeAliases || !codePrefixAliases || !nameAliases) return null;
  return Object.freeze({
    standardCode,
    displayName,
    kuaidi100Code,
    kuaidi100CodeAliases,
    hotline,
    iconKey,
    requiresPhoneTail: raw.requiresPhoneTail,
    aliases: codeAliases,
    codePrefixAliases,
    nameAliases,
  });
}

export function parseCarrierAuthorityPayload(
  value: unknown,
): CarrierAuthorityPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const version = text(raw.version, /^[A-Za-z0-9._-]+$/, 128);
  const source = text(raw.source, /^[\x20-\x7E]+$/, 256);
  if (raw.schemaVersion !== 2 || !version || !source ||
    !Array.isArray(raw.entries) || raw.entries.length < 17 ||
    raw.entries.length > 256) return null;
  const entries: CarrierQueryRecord[] = [];
  for (const value of raw.entries) {
    const parsed = entry(value);
    if (!parsed) return null;
    entries.push(parsed);
  }
  if (!validateCarrierQueryRecords(entries, version)) return null;
  return Object.freeze({
    schemaVersion: 2,
    version,
    source,
    entries: Object.freeze(entries),
  });
}

function storedCandidate(value: string, nowMs: number): StoredCarrierAuthority | null {
  try {
    const raw = JSON.parse(value) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const stored = raw as Record<string, unknown>;
    const fetchedAtMs = Number(stored.fetchedAtMs);
    const payload = parseCarrierAuthorityPayload(stored.payload);
    if (stored.storageSchema !== STORAGE_SCHEMA ||
      !Number.isSafeInteger(fetchedAtMs) || fetchedAtMs <= 0 ||
      fetchedAtMs > nowMs + MAX_CLOCK_SKEW_MS || !payload) return null;
    return Object.freeze({
      storageSchema: STORAGE_SCHEMA,
      fetchedAtMs,
      payload,
    });
  } catch {
    return null;
  }
}

function attemptCandidate(
  value: string,
  nowMs: number,
): StoredCarrierAuthorityAttempt | null {
  try {
    const raw = JSON.parse(value) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const stored = raw as Record<string, unknown>;
    const lastAttemptAtMs = Number(stored.lastAttemptAtMs);
    if (stored.storageSchema !== STORAGE_SCHEMA ||
      !Number.isSafeInteger(lastAttemptAtMs) || lastAttemptAtMs <= 0 ||
      lastAttemptAtMs > nowMs + MAX_CLOCK_SKEW_MS) return null;
    return Object.freeze({
      storageSchema: STORAGE_SCHEMA,
      lastAttemptAtMs,
    });
  } catch {
    return null;
  }
}

function loadCarrierAuthorityAttempt(nowMs: number): void {
  const selected = readDurableTextResult(CARRIER_AUTHORITY_ATTEMPT_FILE)
    .candidates
    .map((value) => attemptCandidate(value, nowMs))
    .filter((value): value is StoredCarrierAuthorityAttempt => value != null)
    .sort((left, right) => right.lastAttemptAtMs - left.lastAttemptAtMs)[0];
  loadedLastAttemptAtMs = selected?.lastAttemptAtMs || 0;
}

/** Loads the newest fully validated primary/backup snapshot without networking. */
export function loadCarrierAuthorityCache(nowMs = Date.now()): boolean {
  loadCarrierAuthorityAttempt(nowMs);
  const candidates = readDurableTextResult(CARRIER_AUTHORITY_FILE).candidates
    .map((value) => storedCandidate(value, nowMs))
    .filter((value): value is StoredCarrierAuthority => value != null)
    .sort((left, right) => right.fetchedAtMs - left.fetchedAtMs);
  const selected = candidates[0];
  if (!selected || !installCarrierQueryRecords(
    selected.payload.entries,
    selected.payload.version,
    selected.payload.source,
  )) return false;
  loadedFetchedAtMs = selected.fetchedAtMs;
  return true;
}

/** Refreshes at most once per day; any failure leaves the installed table intact. */
export async function refreshCarrierAuthorityIfNeeded(
  nowMs = Date.now(),
  dependencies: CarrierAuthorityDependencies = {},
): Promise<boolean> {
  const latestActivityAtMs = Math.max(
    loadedFetchedAtMs,
    loadedLastAttemptAtMs,
  );
  if (latestActivityAtMs > 0 &&
    nowMs - latestActivityAtMs < REFRESH_INTERVAL_MS) return false;
  try {
    const attempt: StoredCarrierAuthorityAttempt = {
      storageSchema: STORAGE_SCHEMA,
      lastAttemptAtMs: nowMs,
    };
    // The throttle survives process death only if it is durable before the
    // request can leave this process. A failed request never replaces last-good.
    writeDurableText(
      CARRIER_AUTHORITY_ATTEMPT_FILE,
      JSON.stringify(attempt),
    );
    loadedLastAttemptAtMs = nowMs;
    const post = dependencies.post || postGateway;
    const response = await post(
      CARRIER_AUTHORITY_ROUTE,
      {},
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    const payload = parseCarrierAuthorityPayload(response);
    if (!payload) return false;
    const stored: StoredCarrierAuthority = {
      storageSchema: STORAGE_SCHEMA,
      fetchedAtMs: nowMs,
      payload,
    };
    writeDurableText(CARRIER_AUTHORITY_FILE, JSON.stringify(stored));
    if (!installCarrierQueryRecords(
      payload.entries,
      payload.version,
      payload.source,
    )) return false;
    loadedFetchedAtMs = nowMs;
    return true;
  } catch {
    return false;
  }
}

export function initializeCarrierAuthority(): void {
  loadCarrierAuthorityCache();
  void refreshCarrierAuthorityIfNeeded();
}

export function resetCarrierAuthorityRuntimeForTesting(): void {
  loadedFetchedAtMs = 0;
  loadedLastAttemptAtMs = 0;
}
