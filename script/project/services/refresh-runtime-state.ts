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
}>;

type RefreshRuntimeState = Readonly<{
  version: 1;
  revision: number;
  lastAccountSyncSuccessAtMs: number;
  lastBackgroundPollSuccessAtMs: number;
  providers: readonly ProviderSchedule[];
  leases: readonly RuntimeLease[];
}>;

const RUNTIME_STATE_KEY = "pipi_deliveries_refresh_runtime_v1";
const MAX_PROVIDER_SCHEDULES = 256;
const PROVIDER_SUCCESS_INTERVAL_MS: Readonly<Record<RefreshProvider, number>> = {
  account_list: 60_000,
  account_detail: 5 * 60_000,
  picker: 2 * 60_000,
  moto: 5 * 60_000,
  kuaidi100: 5 * 60_000,
  kdniao: 10 * 60_000,
};

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

function readRuntimeState(now = Date.now()): RefreshRuntimeState {
  try {
    const raw = Storage.get<Partial<RefreshRuntimeState>>(RUNTIME_STATE_KEY);
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

function writeRuntimeState(state: RefreshRuntimeState): boolean {
  try {
    return Storage.set(RUNTIME_STATE_KEY, state) !== false;
  } catch {
    return false;
  }
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

export function providerNextDueAt(input: Readonly<{
  key: string;
  provider: RefreshProvider;
  result: RefreshProviderResult;
  consecutiveFailures: number;
  now: number;
}>): number {
  const failures = Math.max(0, Math.floor(input.consecutiveFailures));
  let intervalMs: number;
  switch (input.result) {
    case "success":
      intervalMs = PROVIDER_SUCCESS_INTERVAL_MS[input.provider];
      break;
    case "invalid_query":
      intervalMs = 24 * 60 * 60_000;
      break;
    case "upstream_rejected":
      intervalMs = 30 * 60_000;
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
  return input.now + intervalMs + stableJitter(
    `${input.key}:${input.provider}`,
    intervalMs,
  );
}

export function refreshProviderDue(
  key: string,
  provider: RefreshProvider,
  identityFingerprint: string,
  now = Date.now(),
): boolean {
  const current = readRuntimeState(now).providers.find(
    (item) => item.key === key && item.provider === provider,
  );
  if (!current || current.identityFingerprint !== identityFingerprint) {
    return true;
  }
  return current.nextDueAtMs <= now;
}

export function recordRefreshProviderResult(input: Readonly<{
  key: string;
  provider: RefreshProvider;
  identityFingerprint: string;
  result: RefreshProviderResult;
  now?: number;
}>): void {
  const now = input.now ?? Date.now();
  const current = readRuntimeState(now);
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
  const providers = [
    ...current.providers.filter((item) =>
      item.key !== input.key || item.provider !== input.provider
    ),
    schedule,
  ].sort((left, right) => right.lastAttemptAtMs - left.lastAttemptAtMs)
    .slice(0, MAX_PROVIDER_SCHEDULES);
  writeRuntimeState({
    ...current,
    revision: current.revision + 1,
    providers,
  });
}

export function lastNetworkRefreshSuccessAtMs(): number {
  const state = readRuntimeState();
  return Math.max(
    state.lastAccountSyncSuccessAtMs,
    state.lastBackgroundPollSuccessAtMs,
  );
}

export function recordNetworkRefreshSuccess(
  kind: "account" | "background",
  now = Date.now(),
): void {
  const current = readRuntimeState(now);
  writeRuntimeState({
    ...current,
    revision: current.revision + 1,
    ...(kind === "account"
      ? { lastAccountSyncSuccessAtMs: now }
      : { lastBackgroundPollSuccessAtMs: now }),
  });
}

export type DurableRefreshLease = Readonly<{
  key: string;
  token: string;
  release: () => void;
  isCurrent: () => boolean;
}>;

export function acquireDurableRefreshLease(
  key: string,
  ttlMs: number,
  now = Date.now(),
): DurableRefreshLease | null {
  const current = readRuntimeState(now);
  if (current.leases.some((lease) => lease.key === key && lease.expiresAtMs > now)) {
    return null;
  }
  const token = `${now.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  const lease: RuntimeLease = {
    key,
    token,
    expiresAtMs: now + Math.max(1_000, Math.floor(ttlMs)),
  };
  if (!writeRuntimeState({
    ...current,
    revision: current.revision + 1,
    leases: [...current.leases.filter((item) => item.key !== key), lease],
  })) return null;
  const owns = () => readRuntimeState().leases.some(
    (item) => item.key === key && item.token === token &&
      item.expiresAtMs > Date.now(),
  );
  if (!owns()) return null;
  return {
    key,
    token,
    isCurrent: owns,
    release: () => {
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
    },
  };
}
