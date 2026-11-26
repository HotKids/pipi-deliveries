import { postGateway } from "./gateway";
import { gatewayCredentialForLocalCache, gatewayCredentialGeneration } from "./credentials";
import {
  readDurableTextResult,
  writeDurableText,
} from "./durable-files";
import {
  installCarrierQueryRecords,
  validateCarrierQueryRecords,
  type CarrierQueryRecord,
  activeCarrierTableVersion,
  resolveCarrierQuery,
} from "./carrier-query";
import { diagnosticErrorDetails, writeDiagnostic } from "./logger";
import {
  installStatusLabelTable,
  parseStatusLabelTable,
  type StatusLabelTable,
} from "./status-labels";

import { compileMealRules, mealCredentialScope, parseMealRuleOffer, type MealRuleOffer, type MealRules } from "./meal/rules";

const CARRIER_AUTHORITY_ROUTE = "/api/express/carriers";
const CARRIER_AUTHORITY_FILE = "carrier-authority-v2.json";
const CARRIER_AUTHORITY_ATTEMPT_FILE = "carrier-authority-attempt-v1.json";
const STORAGE_SCHEMA = 1;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 5_000;
/** After a rules request for a key fails or brings no pack, automatic meal pulls wait this long (N3, 2026-11-21). */
export const MEAL_RULES_RETRY_BACKOFF_MS = 30_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export type CarrierAuthorityPayload = Readonly<{
  schemaVersion: 2;
  version: string;
  source: string;
  entries: readonly CarrierQueryRecord[];
  /**
   * The Worker's status label table (audit L5, user default #2): every surface reads its labels from it.
   * A snapshot without one (an older Worker) keeps the table already in use.
   */
  statusLabels?: StatusLabelTable;
}>;

type ScopedMealOffer = MealRuleOffer & { scope: string };
type StoredCarrierAuthority = Readonly<{
  storageSchema: 1;
  fetchedAtMs: number;
  payload: CarrierAuthorityPayload;
  meal?: ScopedMealOffer;
}>;

type StoredCarrierAuthorityAttempt = Readonly<{
  storageSchema: 1;
  lastAttemptAtMs: number;
  mealScope?: string;
  mealRulesRetryNotBeforeMs?: number;
}>;

type CarrierAuthorityDependencies = Readonly<{
  post?: (
    route: string,
    body: { includeMealRules?: true },
    options: Readonly<{ timeoutMs: number }>,
  ) => Promise<unknown>;
}>;

let loadedFetchedAtMs = 0;
let loadedLastAttemptAtMs = 0;
let loadedAttemptScope = "";
let loadedMealOffer: ScopedMealOffer | undefined;
/** `mealScope` is the Access Key scope this request asked rules for; empty for a request without rules. */
let inFlight: { generation: number | null; mealScope: string; operation: Promise<boolean> } | undefined;
type MealSyncSkip = "no_access_key" | "access_key_rejected" | "no_meal_rules";
let reportedMealSyncSkip: MealSyncSkip | "" = "";
/** The key scope whose last rules request ended without a pack, and when automatic meal pulls may ask again. */
let mealRulesRetry: { scope: string; notBeforeMs: number } | undefined;

/** `explicit`: 立即同步 or an Access Key change, which the automatic retry backoff does not delay. */
type MealRulesRequest = CarrierAuthorityDependencies & Readonly<{ explicit?: boolean }>;

export function cachedMealRules(): MealRules | null {
  const scope = mealCredentialScope();
  return scope && loadedMealOffer?.scope === scope ? compileMealRules(loadedMealOffer) : null;
}

/**
 * The current Access Key's meal rules, requested while none were accepted for it. `meal_sync` marks the app's
 * meal pull (launch, foreground return, list pull, 立即同步, a key change), which does not run without them and
 * records why it was skipped. An automatic call (launch, foreground return, list pull, a Shortcut) made within
 * MEAL_RULES_RETRY_BACKOFF_MS after a rules request for the same key ended without a pack does not ask again; an
 * explicit one (立即同步, a key change) does, and a call made while such a request runs still waits for it.
 */
export async function ensureMealRules(
  trigger?: "meal_sync",
  request: MealRulesRequest = {},
): Promise<MealRules | null> {
  const rules = await currentMealRules(request);
  if (trigger) reportMealSyncGate(rules);
  return rules;
}

async function currentMealRules(request: MealRulesRequest): Promise<MealRules | null> {
  const scope = mealCredentialScope();
  if (!scope) return null;
  if (!loadedMealOffer) loadCarrierAuthorityCache();
  const cached = cachedMealRules();
  if (cached) return cached;
  const backoff = mealRulesRetry?.scope === scope && Date.now() < mealRulesRetry.notBeforeMs;
  if (!request.explicit && backoff && inFlight?.mealScope !== scope) return null;
  // Only an accepted pack settles a key's rules (owner decision, 2026-11-21): a failed or unusable answer
  // is asked again by a later call instead of waiting for the carrier table's daily refresh.
  await requestCarrierAuthority(Date.now(), request, undefined, scope);
  return scope === mealCredentialScope() ? cachedMealRules() : null;
}

/** A meal pull that cannot run for want of a usable Access Key (D111); written like the app pull's own skip. */
export function reportMealSyncSkipped(): void {
  reportMealSyncGate(null);
}

/**
 * Records a skipped meal pull once per change of reason in a runtime (owner decision, 2026-11-21: 诊断日志事件);
 * a pull that runs clears it, so the next skip is recorded again. The key events carry the key's own state.
 */
function reportMealSyncGate(rules: MealRules | null): void {
  const reason: MealSyncSkip | "" = rules ? "" : mealCredentialScope() ? "no_meal_rules"
    : gatewayCredentialForLocalCache() ? "access_key_rejected" : "no_access_key";
  if (reason === reportedMealSyncSkip) return;
  reportedMealSyncSkip = reason;
  if (!reason) return;
  writeDiagnostic("cloud.sync.skipped", { domain: "meal_pickup", stage: "cloud_record_sync", result: reason, skipReason: reason },
    reason === "no_meal_rules" ? "warning" : "info");
}

export function carrierAuthorityDiagnosticDetails(nowMs = Date.now()) {
  const hotline = resolveCarrierQuery("HTKY")?.hotline || "";
  const latestActivityAtMs = Math.max(loadedFetchedAtMs, loadedLastAttemptAtMs);
  return {
    carrierTableVersion: activeCarrierTableVersion(),
    carrierFetchedAtMs: loadedFetchedAtMs,
    carrierLastAttemptAtMs: loadedLastAttemptAtMs,
    carrierRefreshRemainingMs: latestActivityAtMs > 0
      ? Math.max(0, latestActivityAtMs + REFRESH_INTERVAL_MS - nowMs) : 0,
    hotlinePresent: Boolean(hotline),
    hotlineMatchesExpected: hotline === "956025",
  };
}

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

function entry(value: unknown, stored = false): CarrierQueryRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const standardCode = text(raw.standardCode, /^[A-Z0-9]+$/, 16);
  const displayName = text(raw.displayName, /^.+$/u, 64);
  const kuaidi100Code = text(raw.kuaidi100Code, /^[a-z0-9_-]+$/, 32);
  const hotline = typeof raw.hotline === "string" && raw.hotline.length <= 32
    ? raw.hotline.trim()
    : null;
  const iconKey = text(raw.iconKey, /^[a-z0-9_-]+$/, 32);
  // Earlier cache writers serialized the internal record's aliases field.
  const codeAliases = list(stored && raw.codeAliases === undefined ? raw.aliases : raw.codeAliases);
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

function parseCarrierPayload(value: unknown, stored = false): CarrierAuthorityPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const version = text(raw.version, /^[A-Za-z0-9._-]+$/, 128);
  // The Worker's rule for `source`: any non-empty string of at most 128 characters (user decision
  // 2026-09-25, audit C5 follow-up 2).
  const source = text(raw.source, /^[\s\S]+$/, 128);
  if (raw.schemaVersion !== 2 || !version || !source ||
    !Array.isArray(raw.entries) || raw.entries.length < 17 ||
    raw.entries.length > 256) return null;
  const entries: CarrierQueryRecord[] = [];
  for (const value of raw.entries) {
    const parsed = entry(value, stored);
    if (!parsed) return null;
    entries.push(parsed);
  }
  if (!validateCarrierQueryRecords(entries, version)) return null;
  // A table that is served but malformed rejects the snapshot, as kdbot does: one bad publication must
  // not silently change the labels in use.
  const statusLabels = raw.statusLabels === undefined ? undefined : parseStatusLabelTable(raw.statusLabels);
  if (statusLabels === null) return null;
  return Object.freeze({
    schemaVersion: 2,
    version,
    source,
    entries: Object.freeze(entries),
    ...(statusLabels ? { statusLabels } : {}),
  });
}

export function parseCarrierAuthorityPayload(value: unknown): CarrierAuthorityPayload | null {
  return parseCarrierPayload(value);
}

function storedCandidate(value: string, nowMs: number): StoredCarrierAuthority | null {
  try {
    const raw = JSON.parse(value) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const stored = raw as Record<string, unknown>;
    const fetchedAtMs = Number(stored.fetchedAtMs);
    const payload = parseCarrierPayload(stored.payload, true);
    if (stored.storageSchema !== STORAGE_SCHEMA ||
      !Number.isSafeInteger(fetchedAtMs) || fetchedAtMs <= 0 ||
      fetchedAtMs > nowMs + MAX_CLOCK_SKEW_MS || !payload) return null;
    const meal = parseMealRuleOffer(stored.meal);
    const scope = (stored.meal as { scope?: unknown } | undefined)?.scope;
    return Object.freeze({
      storageSchema: STORAGE_SCHEMA,
      fetchedAtMs,
      payload,
      ...(meal && typeof scope === "string" && /^[0-9a-f]{64}$/.test(scope)
        ? { meal: { ...meal, scope } } : {}),
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
    const retryNotBefore = Number(stored.mealRulesRetryNotBeforeMs);
    return Object.freeze({
      storageSchema: STORAGE_SCHEMA,
      lastAttemptAtMs,
      mealScope: typeof stored.mealScope === "string" ? stored.mealScope : undefined,
      ...(Number.isSafeInteger(retryNotBefore) && retryNotBefore > 0 && retryNotBefore <= nowMs + MAX_CLOCK_SKEW_MS
        ? { mealRulesRetryNotBeforeMs: retryNotBefore }
        : {}),
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
  loadedAttemptScope = selected?.mealScope || "";
  if (selected?.mealScope && selected.mealRulesRetryNotBeforeMs && selected.mealRulesRetryNotBeforeMs > nowMs) {
    if (!mealRulesRetry || mealRulesRetry.scope !== selected.mealScope || selected.mealRulesRetryNotBeforeMs > mealRulesRetry.notBeforeMs) {
      mealRulesRetry = { scope: selected.mealScope, notBeforeMs: selected.mealRulesRetryNotBeforeMs };
    }
  }
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
  )) {
    writeDiagnostic("carrier.authority.loaded", {
      ...carrierAuthorityDiagnosticDetails(nowMs), result: "cache_unavailable",
    });
    return false;
  }
  loadedMealOffer = selected.meal;
  installStatusLabelTable(selected.payload.statusLabels);
  loadedFetchedAtMs = selected.fetchedAtMs;
  const details = carrierAuthorityDiagnosticDetails(nowMs);
  if (!details.hotlineMatchesExpected) {
    writeDiagnostic("carrier.authority.loaded", { ...details, result: "cache_loaded" }, "warning");
  }
  return true;
}

/** Refreshes at most once per day; any failure leaves the installed table intact. */
export function refreshCarrierAuthorityIfNeeded(
  nowMs = Date.now(),
  dependencies: CarrierAuthorityDependencies = {},
): Promise<boolean> {
  return requestCarrierAuthority(nowMs, dependencies);
}

export async function checkSavedAccessKey(): Promise<void> {
  const generation = gatewayCredentialGeneration();
  if (generation === null) return;
  await requestCarrierAuthority(Date.now(), {}, generation);
}

function requestCarrierAuthority(
  nowMs: number, dependencies: CarrierAuthorityDependencies, verifyGeneration?: number, mealRulesScope?: string,
): Promise<boolean> {
  if (inFlight) {
    const { generation, mealScope, operation } = inFlight;
    if (mealRulesScope !== undefined) {
      if (mealScope === mealRulesScope) return operation;
      // A preceding key's request or the cooldown's authorization check carries no rules for this key.
      return operation.then(() => mealRulesScope === mealCredentialScope() && loadedMealOffer?.scope !== mealRulesScope
        ? requestCarrierAuthority(Date.now(), dependencies, undefined, mealRulesScope) : false);
    }
    if (verifyGeneration === undefined || verifyGeneration === generation) return operation;
    return operation.then(() => gatewayCredentialGeneration() === verifyGeneration
      ? requestCarrierAuthority(Date.now(), dependencies, verifyGeneration) : false);
  }
  const scope = mealCredentialScope();
  const post = dependencies.post || postGateway;
  const latestActivityAtMs = Math.max(
    loadedFetchedAtMs,
    loadedLastAttemptAtMs,
  );
  // A key's first attempt passes the daily throttle for every caller; until a pack is accepted only the meal
  // path asks again, so the carrier table's own refreshes keep their 24-hour throttle.
  const scopeNeedsRules = Boolean(scope) && loadedMealOffer?.scope !== scope &&
    (mealRulesScope === scope || loadedAttemptScope !== scope);
  const onCooldown = !scopeNeedsRules && latestActivityAtMs > 0 && nowMs - latestActivityAtMs < REFRESH_INTERVAL_MS;
  if (onCooldown && verifyGeneration === undefined) {
    const details = carrierAuthorityDiagnosticDetails(nowMs);
    if (!details.hotlineMatchesExpected) {
      writeDiagnostic("carrier.authority.skipped", { ...details, result: "cooldown" }, "warning");
    }
    return Promise.resolve(false);
  }
  const generation = verifyGeneration ?? gatewayCredentialGeneration();
  const checkStartedAt = Date.now();
  // D113/D123: the saved key's check records its result (accepted, rejected or unreachable) without the key.
  const recordCheck = (error?: unknown) => {
    if (verifyGeneration === undefined) return;
    const details = error === undefined ? {} : diagnosticErrorDetails(error);
    writeDiagnostic("gateway.credential.checked", {
      stage: onCooldown ? "credential_check" : "carrier_table",
      result: error === undefined ? "accepted" : details.errorCategory === "authorization" ? "rejected" : "unreachable",
      durationMs: Date.now() - checkStartedAt, ...details,
    }, error === undefined || details.errorCategory === "authorization" ? "info" : "warning");
  };
  // Auth can be checked during the catalog cooldown without querying a shipment or touching the cache.
  const request = onCooldown
    ? post(CARRIER_AUTHORITY_ROUTE, {}, { timeoutMs: REQUEST_TIMEOUT_MS }).then(() => {
      recordCheck();
      return false;
    }, (error: unknown) => {
      recordCheck(error);
      return false;
    })
    : refreshAuthority(nowMs, scope, post).then((installed) => {
      recordCheck(installed ? undefined : lastAuthorityRequestError);
      return installed;
    });
  const operation = request.finally(() => {
    if (inFlight?.operation === operation) inFlight = undefined;
  });
  inFlight = { generation, mealScope: onCooldown ? "" : scope, operation };
  return operation;
}

async function refreshAuthority(
  nowMs: number, scope: string, post: NonNullable<CarrierAuthorityDependencies["post"]>,
): Promise<boolean> {
  try {
    return await refreshAuthorityOnce(nowMs, scope, post);
  } finally {
    // A request that asked for this key's rules and ended without them holds automatic meal pulls briefly,
    // persisted to CARRIER_AUTHORITY_ATTEMPT_FILE so background/Shortcut hosts share the backoff (M-08).
    if (scope) {
      if (loadedMealOffer?.scope === scope) {
        mealRulesRetry = undefined;
      } else {
        const notBeforeMs = Date.now() + MEAL_RULES_RETRY_BACKOFF_MS;
        mealRulesRetry = { scope, notBeforeMs };
        try {
          writeDurableText(CARRIER_AUTHORITY_ATTEMPT_FILE, JSON.stringify({
            storageSchema: STORAGE_SCHEMA,
            lastAttemptAtMs: loadedLastAttemptAtMs || nowMs,
            mealScope: scope,
            mealRulesRetryNotBeforeMs: notBeforeMs,
          } satisfies StoredCarrierAuthorityAttempt));
        } catch {
          // Best-effort cross-process backoff persistence.
        }
      }
    }
  }
}

/** The last carrier-table request's transport or authorization error; a reply with any payload clears it. */
let lastAuthorityRequestError: unknown;

async function refreshAuthorityOnce(
  nowMs: number, scope: string, post: NonNullable<CarrierAuthorityDependencies["post"]>,
): Promise<boolean> {
  const startedAtMs = Date.now();
  lastAuthorityRequestError = undefined;
  try {
    const attempt: StoredCarrierAuthorityAttempt = {
      storageSchema: STORAGE_SCHEMA,
      lastAttemptAtMs: nowMs,
      ...(scope ? { mealScope: scope } : {}),
    };
    // The throttle survives process death only if it is durable before the
    // request can leave this process. A failed request never replaces last-good.
    writeDurableText(
      CARRIER_AUTHORITY_ATTEMPT_FILE,
      JSON.stringify(attempt),
    );
    loadedLastAttemptAtMs = nowMs;
    loadedAttemptScope = scope;
    const response = await post(
      CARRIER_AUTHORITY_ROUTE,
      scope ? { includeMealRules: true } : {},
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    const payload = parseCarrierAuthorityPayload(response);
    if (!payload) {
      writeDiagnostic("carrier.authority.failed", {
        ...carrierAuthorityDiagnosticDetails(), result: "invalid_payload",
        durationMs: Date.now() - startedAtMs,
      }, "warning");
      return false;
    }
    const offered = scope && mealCredentialScope() === scope
      ? parseMealRuleOffer((response as { mealRules?: unknown }).mealRules) : null;
    const meal = offered && compileMealRules(offered) ? { ...offered, scope } : loadedMealOffer;
    const serializedBody = {
      payload: {
        ...payload,
        entries: payload.entries.map(({ aliases, ...record }) => ({ ...record, codeAliases: aliases })),
      },
      ...(meal ? { meal } : {}),
    };
    const existingRaw = readDurableTextResult(CARRIER_AUTHORITY_FILE).candidates[0];
    let unchangedWithinWindow = false;
    if (existingRaw && loadedFetchedAtMs > 0 && nowMs - loadedFetchedAtMs < REFRESH_INTERVAL_MS) {
      try {
        const parsedExisting = JSON.parse(existingRaw) as Record<string, unknown>;
        const existingBody = {
          payload: parsedExisting.payload,
          ...(parsedExisting.meal ? { meal: parsedExisting.meal } : {}),
        };
        unchangedWithinWindow = JSON.stringify(existingBody) === JSON.stringify(serializedBody);
      } catch {
        unchangedWithinWindow = false;
      }
    }
    if (!unchangedWithinWindow) {
      writeDurableText(CARRIER_AUTHORITY_FILE, JSON.stringify({
        storageSchema: STORAGE_SCHEMA,
        fetchedAtMs: nowMs,
        ...serializedBody,
      }));
    }
    if (!installCarrierQueryRecords(
      payload.entries,
      payload.version,
      payload.source,
    )) {
      writeDiagnostic("carrier.authority.failed", {
        ...carrierAuthorityDiagnosticDetails(), result: "install_rejected",
        durationMs: Date.now() - startedAtMs,
      }, "warning");
      return false;
    }
    loadedMealOffer = meal;
    installStatusLabelTable(payload.statusLabels);
    loadedFetchedAtMs = nowMs;
    writeDiagnostic("carrier.authority.refreshed", {
      ...carrierAuthorityDiagnosticDetails(), result: "installed",
      durationMs: Date.now() - startedAtMs,
      // D113: whether the meal rule pack this request asked for was accepted for the key.
      ...(scope ? { mealRulesResult: !offered ? "absent" : meal?.scope === scope ? "accepted" : "rejected" } as const : {}),
    });
    return true;
  } catch (error) {
    lastAuthorityRequestError = error;
    writeDiagnostic("carrier.authority.failed", {
      ...carrierAuthorityDiagnosticDetails(), ...diagnosticErrorDetails(error),
      durationMs: Date.now() - startedAtMs,
    }, "warning");
    return false;
  }
}

export function resetCarrierAuthorityRuntimeForTesting(): void {
  loadedFetchedAtMs = 0;
  loadedLastAttemptAtMs = 0;
  loadedAttemptScope = "";
  loadedMealOffer = undefined;
  inFlight = undefined;
  reportedMealSyncSkip = "";
  mealRulesRetry = undefined;
  lastAuthorityRequestError = undefined;
}
