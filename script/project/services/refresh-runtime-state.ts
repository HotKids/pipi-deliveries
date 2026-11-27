import { sharedData, publishSharedData, withSharedFileTransaction } from "./shared-file-transaction";

export type RefreshProvider =
  | "account_list"
  | "account_detail"
  | "picker"
  | "moto"
  | "kuaidi100"
  | "kdniao";

export type RefreshProviderResult =
  | "success"
  | "no_result"
  | "invalid_query"
  | "upstream_rejected"
  | "timeout"
  | "network"
  | "failed";

type ProviderSchedule = Readonly<{
  key: string;
  provider: RefreshProvider;
  identityFingerprint: string;
  lastAttemptAtMs: number;
  lastSuccessAtMs: number;
  consecutiveFailures: number;
  nextDueAtMs: number;
  lastResult: RefreshProviderResult;
}>;

type RuntimeLease = Readonly<{
  key: string;
  token: string;
  expiresAtMs: number;
  /** A renewing holder's hard limit: renewals never carry `expiresAtMs` past it. */
  maxExpiresAtMs?: number;
  startedAtMs?: number;
  flowId?: string;
  trigger?: string;
}>;

export type RuntimeManualRefreshAttempt = Readonly<{
  shipmentId: string;
  attemptId: string;
  lastAttemptAtMs: number;
  activeUntilMs: number;
}>;

type RefreshRuntimeState = Readonly<{
  version: 1;
  revision: number;
  lastAccountSyncSuccessAtMs: number;
  lastBackgroundPollSuccessAtMs: number;
  lastWidgetFailureAtMs?: number;
  lastWidgetFailureStateRevision?: number;
  providers: readonly ProviderSchedule[];
  leases: readonly RuntimeLease[];
  manualAttempts?: readonly RuntimeManualRefreshAttempt[];
}>;

const RUNTIME_STATE_KEY = "pipi_deliveries_refresh_runtime_v1";
const RUNTIME_METADATA_KEY = "pipi_deliveries_refresh_metadata_v1";
const MAX_PROVIDER_SCHEDULES = 256;
/** Module-memory cache once legacy Storage cooldown keys are confirmed absent for the active shared store. */
let emptyLegacyRuntimeConfirmed = false;
// 用户定 2026-09-04：手动链各级冷却与京东 H5 一致（10 分钟），只有快递100 H5 是 30 分钟——
// 那是**快递100 上游自己的限制**，不是我们定的节流，必须遵守。
const PROVIDER_SUCCESS_INTERVAL_MS: Readonly<Record<RefreshProvider, number>> = {
  account_list: 60_000,
  account_detail: 5 * 60_000,
  picker: 10 * 60_000,
  moto: 10 * 60_000,
  kuaidi100: 30 * 60_000,
  kdniao: 10 * 60_000,
};

function retainProviderSchedules(providers: readonly ProviderSchedule[], now: number): ProviderSchedule[] {
  let ordinaryCount = 0;
  return [...providers].sort((left, right) => right.lastAttemptAtMs - left.lastAttemptAtMs).filter(item => {
    // Evicting an active H5 reservation would reopen an upstream request before its mandatory interval.
    if (item.provider === "kuaidi100" && item.identityFingerprint === "k100_h5" &&
        item.key.startsWith("k100_h5:") && now < item.lastAttemptAtMs + PROVIDER_SUCCESS_INTERVAL_MS.kuaidi100) return true;
    return ordinaryCount++ < MAX_PROVIDER_SCHEDULES;
  });
}

function emptyRuntimeState(): RefreshRuntimeState {
  return {
    version: 1,
    revision: 0,
    lastAccountSyncSuccessAtMs: 0,
    lastBackgroundPollSuccessAtMs: 0,
    providers: [],
    leases: [],
  };
}

function finiteTimestamp(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function readLegacyRuntimeState(now = Date.now(), key = RUNTIME_STATE_KEY): RefreshRuntimeState {
  try {
    const raw = Storage.get<Partial<RefreshRuntimeState>>(key) ??
      (key === RUNTIME_METADATA_KEY
        ? Storage.get<Partial<RefreshRuntimeState>>(RUNTIME_STATE_KEY) : null);
    if (!raw || raw.version !== 1) return emptyRuntimeState();
    const providers = Array.isArray(raw.providers)
      ? raw.providers.flatMap((item) => {
          if (
            !item || typeof item.key !== "string" ||
            typeof item.provider !== "string" ||
            typeof item.identityFingerprint !== "string"
          ) return [];
          return [{
            ...item,
            lastAttemptAtMs: finiteTimestamp(item.lastAttemptAtMs),
            lastSuccessAtMs: finiteTimestamp(item.lastSuccessAtMs),
            consecutiveFailures: Math.max(
              0,
              Math.floor(Number(item.consecutiveFailures) || 0),
            ),
            nextDueAtMs: finiteTimestamp(item.nextDueAtMs),
          } as ProviderSchedule];
        })
      : [];
    const leases = Array.isArray(raw.leases)
      ? raw.leases.flatMap((item) => {
          const expiresAtMs = finiteTimestamp(item?.expiresAtMs);
          return item && typeof item.key === "string" &&
              typeof item.token === "string" && expiresAtMs > now
            ? [{ ...item, expiresAtMs } as RuntimeLease]
            : [];
        })
      : [];
    return {
      version: 1,
      revision: Math.max(0, Math.floor(Number(raw.revision) || 0)),
      lastAccountSyncSuccessAtMs: finiteTimestamp(
        raw.lastAccountSyncSuccessAtMs,
      ),
      lastBackgroundPollSuccessAtMs: finiteTimestamp(
        raw.lastBackgroundPollSuccessAtMs,
      ),
      providers,
      leases,
    };
  } catch {
    return emptyRuntimeState();
  }
}

function hasLegacyRuntimePayload(): boolean {
  try {
    return Storage.get<unknown>(RUNTIME_STATE_KEY) != null ||
      Storage.get<unknown>(RUNTIME_METADATA_KEY) != null;
  } catch {
    return false;
  }
}

function retainManualAttempts(
  attempts: readonly RuntimeManualRefreshAttempt[] | undefined,
  now: number,
): RuntimeManualRefreshAttempt[] {
  if (!Array.isArray(attempts) || !attempts.length) return [];
  let ordinaryCount = 0;
  return [...attempts]
    .filter((item) =>
      Boolean(item && typeof item.shipmentId === "string" && item.shipmentId &&
        typeof item.attemptId === "string" && finiteTimestamp(item.lastAttemptAtMs) > 0)
    )
    .sort((left, right) => right.lastAttemptAtMs - left.lastAttemptAtMs)
    .filter((item) => {
      if (finiteTimestamp(item.activeUntilMs) > now) return true;
      return ordinaryCount++ < MAX_PROVIDER_SCHEDULES;
    });
}

function readRuntimeState(now = Date.now()): RefreshRuntimeState {
  const raw = sharedData().refresh as RefreshRuntimeState | undefined;
  if (!raw) {
    emptyLegacyRuntimeConfirmed = false;
    return readLegacyRuntimeState(now);
  }
  if (raw.version !== 1 || !Array.isArray(raw.leases) || !Array.isArray(raw.providers)) {
    throw new Error("Invalid shared refresh state");
  }
  return {
    ...raw,
    leases: raw.leases.filter(item => item.expiresAtMs > now),
    ...(raw.manualAttempts ? { manualAttempts: retainManualAttempts(raw.manualAttempts, now) } : {}),
  };
}

function writeRuntimeState(state: RefreshRuntimeState): void {
  publishSharedData({ refresh: state });
}

function writeRuntimeMetadata(state: RefreshRuntimeState): void {
  const latest = readRuntimeState();
  writeRuntimeState({
    ...state,
    leases: latest.leases,
    ...(latest.manualAttempts ? { manualAttempts: latest.manualAttempts } : {}),
  });
}

function readRuntimeMetadata(now = Date.now()): RefreshRuntimeState {
  if (!sharedData().refresh) emptyLegacyRuntimeConfirmed = false;
  if (emptyLegacyRuntimeConfirmed) {
    const current = sharedData().refresh as RefreshRuntimeState;
    return {
      ...current,
      providers: retainProviderSchedules(current.providers, now),
    };
  }
  const hasLegacy = hasLegacyRuntimePayload();
  const legacy = hasLegacy ? readLegacyRuntimeState(now) : emptyRuntimeState();
  const shared = sharedData().refresh as RefreshRuntimeState | undefined;
  if (shared && !hasLegacy) {
    emptyLegacyRuntimeConfirmed = true;
    return {
      ...shared,
      providers: retainProviderSchedules(shared.providers, now),
    };
  }
  const current = shared ||
    readLegacyRuntimeState(now, RUNTIME_METADATA_KEY);
  const providers = new Map<string, ProviderSchedule>();
  // An already-running older widget may still finish into the combined record.
  for (const item of [...legacy.providers, ...current.providers]) {
    const key = JSON.stringify([item.key, item.provider]);
    if ((providers.get(key)?.lastAttemptAtMs ?? -1) <= item.lastAttemptAtMs) {
      providers.set(key, item);
    }
  }
  return {
    ...current,
    lastAccountSyncSuccessAtMs: Math.max(legacy.lastAccountSyncSuccessAtMs, current.lastAccountSyncSuccessAtMs),
    lastBackgroundPollSuccessAtMs: Math.max(legacy.lastBackgroundPollSuccessAtMs, current.lastBackgroundPollSuccessAtMs),
    providers: retainProviderSchedules([...providers.values()], now),
  };
}

function stableJitter(key: string, intervalMs: number): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const ratio = ((hash >>> 0) % 2001) / 10_000 - 0.1;
  return Math.round(intervalMs * ratio);
}

function isManualFallbackCooldownProvider(provider: RefreshProvider): boolean {
  return provider === "picker" ||
    provider === "moto" ||
    provider === "kuaidi100" ||
    provider === "kdniao";
}

export function providerNextDueAt(input: Readonly<{
  key: string;
  provider: RefreshProvider;
  result: RefreshProviderResult;
  consecutiveFailures: number;
  now: number;
}>): number {
  const failures = Math.max(0, Math.floor(input.consecutiveFailures));
  const baseIntervalMs = PROVIDER_SUCCESS_INTERVAL_MS[input.provider];
  const manualFallbackLane = isManualFallbackCooldownProvider(input.provider);
  let intervalMs: number;
  switch (input.result) {
    case "success":
      intervalMs = baseIntervalMs;
      break;
    case "invalid_query":
      intervalMs = 24 * 60 * 60_000;
      break;
    case "upstream_rejected":
      // 风控／上游明确拒绝：歇 60 分钟，与京东 H5 的风控冷却一致（用户定 2026-09-04）。
      intervalMs = 60 * 60_000;
      break;
    case "no_result":
      intervalMs = 5 * 60_000;
      break;
    case "timeout":
    case "network":
      intervalMs = Math.min(
        60 * 60_000,
        60_000 * 2 ** Math.min(6, Math.max(0, failures - 1)),
      );
      break;
    default:
      intervalMs = Math.min(
        30 * 60_000,
        2 * 60_000 * 2 ** Math.min(4, Math.max(0, failures - 1)),
      );
  }
  // X-05 / Android ExpressManualCooldown parity: public/paid manual fallback lanes clamp any
  // non-success cooldown interval and due timestamp to at least the provider's base cooldown
  // (>= 10m default, >= 30m for kuaidi100), while account_detail keeps its fast 1m/5m recovery.
  if (manualFallbackLane && input.result !== "success") {
    intervalMs = Math.max(baseIntervalMs, intervalMs);
  }
  const dueAt = input.now + intervalMs + stableJitter(
    `${input.key}:${input.provider}`,
    intervalMs,
  );
  return manualFallbackLane && input.result !== "success"
    ? Math.max(input.now + baseIntervalMs, dueAt)
    : dueAt;
}

export function refreshProviderDue(
  key: string,
  provider: RefreshProvider,
  identityFingerprint: string,
  now = Date.now(),
): boolean {
  const current = readRuntimeMetadata(now).providers.find(
    (item) => item.key === key && item.provider === provider,
  );
  if (!current || current.identityFingerprint !== identityFingerprint) {
    return true;
  }
  return current.nextDueAtMs <= now;
}

export function refreshProviderCooldownDetails(
  key: string,
  provider: RefreshProvider,
  identityFingerprint: string,
  now = Date.now(),
) {
  const current = readRuntimeMetadata(now).providers.find(item =>
    item.key === key && item.provider === provider && item.identityFingerprint === identityFingerprint);
  if (!current) return {};
  return {
    cooldownReason: current.lastResult,
    cooldownRemainingMs: Math.max(0, current.nextDueAtMs - now),
    providerLastAttemptAtMs: current.lastAttemptAtMs,
    providerNextDueAtMs: current.nextDueAtMs,
    providerFailures: current.consecutiveFailures,
  };
}

function kuaidi100CaptureKey(waybill: string, phones?: readonly string[]): { key: string; fingerprint: string } {
  const normalizedTails = [...new Set((phones ?? [])
    .map(value => String(value || "").replace(/\D/g, ""))
    .filter(value => value.length === 4))].sort().join(",");
  return {
    key: normalizedTails ? `k100_h5:${waybill}:${normalizedTails}` : `k100_h5:${waybill}`,
    fingerprint: normalizedTails ? `k100_h5:${normalizedTails}` : "k100_h5",
  };
}

/** Reserve the upstream's per-(waybill, phones) H5 interval before loading. */
export function claimKuaidi100Capture(
  waybill: string,
  beforeQuery?: () => void,
  now = Date.now(),
  phones?: readonly string[],
): boolean {
  return withSharedFileTransaction(() => {
    const current = readRuntimeMetadata(now);
    const { key, fingerprint } = kuaidi100CaptureKey(waybill, phones);
    const previous = current.providers.find(item => item.key === key && item.provider === "kuaidi100");
    const intervalMs = PROVIDER_SUCCESS_INTERVAL_MS.kuaidi100;
    if (previous && now < previous.lastAttemptAtMs + intervalMs) return false;
    beforeQuery?.();
    const schedule: ProviderSchedule = {
      key, provider: "kuaidi100", identityFingerprint: fingerprint,
      lastAttemptAtMs: now, lastSuccessAtMs: previous?.lastSuccessAtMs || 0,
      consecutiveFailures: previous?.consecutiveFailures || 0,
      nextDueAtMs: now + intervalMs, lastResult: "no_result",
    };
    writeRuntimeMetadata({ ...current, revision: current.revision + 1,
      providers: retainProviderSchedules([
        ...current.providers.filter(item => item.key !== key || item.provider !== "kuaidi100"), schedule,
      ], now) });
    return true;
  });
}

/** Release a no-tail probe reservation when Kuaidi100 asks for phone verification without running an upstream query. */
export function releaseKuaidi100Capture(waybill: string, phones?: readonly string[], now = Date.now()): void {
  withSharedFileTransaction(() => {
    const current = readRuntimeMetadata(now);
    const { key } = kuaidi100CaptureKey(waybill, phones);
    const filtered = current.providers.filter(item => !(item.key === key && item.provider === "kuaidi100"));
    if (filtered.length === current.providers.length) return;
    writeRuntimeMetadata({ ...current, revision: current.revision + 1, providers: filtered });
  });
}

export function recordRefreshProviderResult(input: Readonly<{
  key: string;
  provider: RefreshProvider;
  identityFingerprint: string;
  result: RefreshProviderResult;
  now?: number;
}>): void {
  return withSharedFileTransaction(() => {
    const now = input.now ?? Date.now();
    const current = readRuntimeMetadata(now);
    const previous = current.providers.find(
      (item) => item.key === input.key && item.provider === input.provider &&
        item.identityFingerprint === input.identityFingerprint,
    );
    const consecutiveFailures = input.result === "success"
      ? 0
      : (previous?.consecutiveFailures || 0) + 1;
    const schedule: ProviderSchedule = {
      key: input.key,
      provider: input.provider,
      identityFingerprint: input.identityFingerprint,
      lastAttemptAtMs: now,
      lastSuccessAtMs: input.result === "success"
        ? now
        : previous?.lastSuccessAtMs || 0,
      consecutiveFailures,
      nextDueAtMs: providerNextDueAt({
        key: input.key,
        provider: input.provider,
        result: input.result,
        consecutiveFailures,
        now,
      }),
      lastResult: input.result,
    };
    const providers = retainProviderSchedules([
      ...current.providers.filter((item) =>
        item.key !== input.key || item.provider !== input.provider
      ),
      schedule,
    ], now);
    writeRuntimeMetadata({
      ...current,
      revision: current.revision + 1,
      providers,
  });
  });
}

export function lastNetworkRefreshSuccessAtMs(): number {
  const state = readRuntimeMetadata();
  return Math.max(
    state.lastAccountSyncSuccessAtMs,
    state.lastBackgroundPollSuccessAtMs,
  );
}

export function recordNetworkRefreshSuccess(
  kind: "account" | "background",
  now = Date.now(),
): void {
  return withSharedFileTransaction(() => {
    const current = readRuntimeMetadata(now);
    writeRuntimeMetadata({
      ...current,
      revision: current.revision + 1,
      lastWidgetFailureAtMs: undefined,
      lastWidgetFailureStateRevision: undefined,
      ...(kind === "account"
        ? { lastAccountSyncSuccessAtMs: now }
        : { lastBackgroundPollSuccessAtMs: now }),
  });
  });
}

export function recordWidgetNetworkFailure(
  stateRevision = 0,
  now = Date.now(),
): void {
  withSharedFileTransaction(() => {
    const current = readRuntimeMetadata(now);
    writeRuntimeMetadata({
      ...current,
      revision: current.revision + 1,
      lastWidgetFailureAtMs: now,
      lastWidgetFailureStateRevision: Math.max(0, Math.floor(Number(stateRevision) || 0)),
    });
  });
}

export function lastWidgetNetworkFailure(
  now = Date.now(),
): Readonly<{ failedAtMs: number; stateRevision: number }> {
  const state = readRuntimeMetadata(now);
  return {
    failedAtMs: finiteTimestamp(state.lastWidgetFailureAtMs),
    stateRevision: Math.max(0, Math.floor(Number(state.lastWidgetFailureStateRevision) || 0)),
  };
}

export type DurableRefreshLease = Readonly<{
  key: string;
  token: string;
  expiresAtMs: number;
  release: () => void;
  isCurrent: () => boolean;
}>;

/**
 * 用户 2026-09-28「30 秒有效 + 每 10 秒续约」: a renewing holder's lease is valid for 30 seconds and the
 * holder extends it every 10 seconds while its work runs. A holder that is replaced, closed or suspended
 * stops renewing, so its lease lapses within about 30 seconds instead of blocking every other runtime
 * for its whole maximum operation duration.
 */
const DURABLE_REFRESH_LEASE_TTL_MS = 30_000;
const DURABLE_REFRESH_LEASE_RENEW_INTERVAL_MS = 10_000;

export function acquireDurableRefreshLease(
  key: string,
  ttlMs: number,
  now = Date.now(),
  context?: Readonly<{ flowId: string; trigger: string }>,
): DurableRefreshLease | null {
  return acquireLease(key, ttlMs, now, context);
}

function acquireLease(
  key: string,
  ttlMs: number,
  now: number,
  context?: Readonly<{ flowId: string; trigger: string }>,
  maxExpiresAtMs?: number,
): DurableRefreshLease | null {
  return withSharedFileTransaction(() => {
    const current = readRuntimeState(now);
    if (current.leases.some((lease) => lease.key === key && lease.expiresAtMs > now)) {
      return null;
    }
    const token = `${now.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const lease: RuntimeLease = {
      key,
      token,
      expiresAtMs: now + Math.max(1_000, Math.floor(ttlMs)),
      ...(maxExpiresAtMs == null ? {} : { maxExpiresAtMs }),
      startedAtMs: now,
      ...(context ? { flowId: context.flowId, trigger: context.trigger } : {}),
    };
    writeRuntimeState({
      ...current,
      revision: current.revision + 1,
      leases: [...current.leases.filter((item) => item.key !== key), lease],
  });
  const owns = () => readRuntimeState().leases.some(
    (item) => item.key === key && item.token === token &&
      item.expiresAtMs > Date.now(),
  );
  if (!owns()) return null;
  return {
    key,
    token,
    expiresAtMs: lease.expiresAtMs,
    isCurrent: owns,
    release: () => withSharedFileTransaction(() => {
      const latest = readRuntimeState();
      if (!latest.leases.some((item) => item.key === key && item.token === token)) {
        return;
      }
      writeRuntimeState({
        ...latest,
        revision: latest.revision + 1,
        leases: latest.leases.filter(
          (item) => item.key !== key || item.token !== token,
        ),
      });
    }),
  };
  });
}

/**
 * Extends the holder's lease to 30 seconds from now, never past its hard limit, only while `token` still
 * holds `key`. False when the lease was released, lapsed or taken by another runtime: a lapsed lease is
 * not revived, so a holder resuming after a suspension cannot reclaim what another runtime may own.
 */
export function renewDurableRefreshLease(key: string, token: string, now = Date.now()): boolean {
  return withSharedFileTransaction(() => {
    const current = readRuntimeState(now);
    const held = current.leases.find((item) => item.key === key && item.token === token);
    if (!held) return false;
    const limit = finiteTimestamp(held.maxExpiresAtMs) || held.expiresAtMs;
    const expiresAtMs = Math.min(limit, now + DURABLE_REFRESH_LEASE_TTL_MS);
    if (expiresAtMs > held.expiresAtMs) {
      writeRuntimeState({
        ...current,
        revision: current.revision + 1,
        leases: current.leases.map((item) => item === held ? { ...held, expiresAtMs } : item),
      });
    }
    return true;
  });
}

/** The stop functions of this runtime's running renewal loops; every loop ends with its lease. */
const activeRenewals = new Set<() => void>();

/**
 * A lease valid for 30 seconds that its holder renews every 10 seconds until `release`, for at most
 * `maxDurationMs` (the holder's maximum operation duration, which the lease's `expiresAtMs` reports).
 * Renewal stops on release, when the lease is lost, and at that limit, so no timer outlives the work.
 */
export function acquireRenewingDurableRefreshLease(
  key: string,
  maxDurationMs: number,
  now = Date.now(),
  context?: Readonly<{ flowId: string; trigger: string }>,
): DurableRefreshLease | null {
  const maxMs = Math.max(1_000, Math.floor(maxDurationMs));
  const maxExpiresAtMs = now + maxMs;
  const lease = acquireLease(
    key, Math.min(DURABLE_REFRESH_LEASE_TTL_MS, maxMs), now, context, maxExpiresAtMs,
  );
  if (!lease) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    activeRenewals.delete(stop);
  };
  // Nothing is left to renew once the lease already runs to its limit.
  const schedule = () => {
    if (stopped) return;
    if (Date.now() + DURABLE_REFRESH_LEASE_TTL_MS >= maxExpiresAtMs) {
      stop();
      return;
    }
    timer = setTimeout(renew, DURABLE_REFRESH_LEASE_RENEW_INTERVAL_MS);
  };
  const renew = () => {
    timer = undefined;
    if (stopped) return;
    let held = true;
    try {
      held = renewDurableRefreshLease(key, lease.token);
    } catch {
      // A contended shared file is retried on the next tick; the lease still has time left.
    }
    if (held) schedule();
    else stop();
  };
  activeRenewals.add(stop);
  schedule();
  return {
    key,
    token: lease.token,
    expiresAtMs: maxExpiresAtMs,
    isCurrent: lease.isCurrent,
    release: () => {
      stop();
      lease.release();
    },
  };
}

function activeRenewalCount(): number {
  return activeRenewals.size;
}

/**
 * How long the current holder of `key` may still hold it: a renewing holder until its hard limit,
 * any other holder until its lease expires; 0 when nobody holds it. Read-only.
 */
export function durableRefreshLeaseMaxRemainingMs(key: string, now = Date.now()): number {
  const lease = readRuntimeState(now).leases.find(item => item.key === key);
  if (!lease) return 0;
  const limit = Math.max(lease.expiresAtMs, finiteTimestamp(lease.maxExpiresAtMs));
  return Math.max(0, limit - now);
}

/** How long the current holder of `key` still owns it; 0 when nobody does. Read-only. */
export function durableRefreshLeaseRemainingMs(key: string, now = Date.now()): number {
  const lease = readRuntimeState(now).leases.find(item => item.key === key);
  return lease ? Math.max(0, lease.expiresAtMs - now) : 0;
}

/** Report an observed holder without exposing its ownership token or extending its lifetime. */
export function durableRefreshLeaseDiagnostics(key: string, now = Date.now()) {
  const lease = readRuntimeState(now).leases.find(item => item.key === key);
  if (!lease) return {};
  return {
    blockingFlowId: lease.flowId,
    blockingTrigger: lease.trigger,
    ...(finiteTimestamp(lease.startedAtMs) ? {
      blockingLeaseAgeMs: Math.max(0, now - lease.startedAtMs!),
    } : {}),
    blockingLeaseRemainingMs: Math.max(0, lease.expiresAtMs - now),
  };
}

export function runtimeManualRefreshAttempt(
  shipmentId: string,
  now = Date.now(),
): RuntimeManualRefreshAttempt | null {
  try {
    const attempt = readRuntimeState(now).manualAttempts?.find(
      (item) => item.shipmentId === shipmentId,
    );
    return attempt ?? null;
  } catch {
    return null;
  }
}

export function beginRuntimeManualRefreshAttempt(
  shipmentId: string,
  attemptId: string,
  startedAtMs: number,
  expiresAtMs: number,
): boolean {
  return withSharedFileTransaction(() => {
    const current = readRuntimeState(startedAtMs);
    const existing = current.manualAttempts?.find(
      (item) => item.shipmentId === shipmentId,
    );
    if (
      existing &&
      existing.attemptId !== attemptId &&
      finiteTimestamp(existing.activeUntilMs) > startedAtMs
    ) {
      return false;
    }
    const nextAttempt: RuntimeManualRefreshAttempt = {
      shipmentId,
      attemptId,
      lastAttemptAtMs: Math.max(startedAtMs, finiteTimestamp(existing?.lastAttemptAtMs)),
      activeUntilMs: Math.max(startedAtMs + 1, expiresAtMs),
    };
    const manualAttempts = retainManualAttempts(
      [
        ...(current.manualAttempts || []).filter(
          (item) => item.shipmentId !== shipmentId,
        ),
        nextAttempt,
      ],
      startedAtMs,
    );
    writeRuntimeState({
      ...current,
      revision: current.revision + 1,
      manualAttempts,
    });
    return true;
  });
}

export function ownsRuntimeManualRefreshAttempt(
  shipmentId: string,
  attemptId: string,
  now = Date.now(),
): boolean {
  const existing = runtimeManualRefreshAttempt(shipmentId, now);
  return Boolean(
    existing &&
      existing.attemptId === attemptId &&
      finiteTimestamp(existing.activeUntilMs) > now,
  );
}

export function releaseRuntimeManualRefreshAttempt(
  shipmentId: string,
  attemptId: string,
  now = Date.now(),
): void {
  withSharedFileTransaction(() => {
    const current = readRuntimeState(now);
    const existing = current.manualAttempts?.find(
      (item) => item.shipmentId === shipmentId && item.attemptId === attemptId,
    );
    if (!existing) return;
    const manualAttempts = retainManualAttempts(
      (current.manualAttempts || []).filter(
        (item) => item.shipmentId !== shipmentId || item.attemptId !== attemptId,
      ),
      now,
    );
    writeRuntimeState({
      ...current,
      revision: current.revision + 1,
      manualAttempts,
    });
  });
}

export { activeRenewalCount as activeDurableLeaseRenewalsForTesting };
