import type { GatewayCredentials } from "../models";
import {
  normalizeScriptingToken,
} from "./scripting-auth";
import { readDurableTextResult } from "./durable-files";
import { removeLegacyCredentialCopies } from "./legacy-credential-cleanup";
import { REPEAT_RELOG_MS, diagnosticsEnabled, writeDiagnostic } from "./logger";
import { sha256Hex } from "./scripting-data";
import { scriptingInstallationRecorded } from "./scripting-installation";

const SCRIPTING_TOKEN_KEY = "pipi_deliveries_scripting_token_v1";
/**
 * The last key state this script copy wrote to the diagnostic log and when, in its own Storage (like its
 * Keychain scope, it belongs to one script copy). It holds only a state name and a time, never the key.
 */
const CREDENTIAL_REPORT_KEY = "pipi_deliveries_credential_report_v1";

type StoredCredential = {
  schema: number;
  token: string;
  generation?: number;
  availability?: CredentialAvailability;
  checksum: string;
};

type PendingCredential = {
  schema: 3 | 5;
  token: string;
  generation: number;
  previousKey: string | null;
  availability: CredentialAvailability;
  checksum: string;
};

type CredentialAvailability = "available" | "unavailable";

type CredentialCandidate = {
  present: boolean;
  token: string;
  generation: number;
  availability: CredentialAvailability;
};

export type GatewayCredentialStatus =
  | "missing"
  | "configured"
  | "unavailable"
  | "conflict";

/** Why a missing key reads as missing: no record, an explicit removal, or a record that does not decode. */
export type MissingCredential = "absent" | "removed" | "invalid";
type CredentialConflict =
  | "keychain_read_failed"
  | "legacy_record_unreadable"
  | "legacy_record_invalid"
  | "migration_failed";

type CredentialResolution = {
  status: GatewayCredentialStatus;
  candidate: CredentialCandidate | null;
  missing?: MissingCredential;
  conflict?: CredentialConflict;
};

type KeyRawRead = {
  value: string | null;
  failed: boolean;
};

export type GatewayCredentialObservation = {
  generation: number;
  sequence: number;
};

export type GatewayAccessKeyVerification = "unchecked" | "accepted" | "rejected";

let observedCredential = "";
let observationGeneration = 0;
let requestSequence = 0;
let settledSequence = 0;
let accessKeyVerification: GatewayAccessKeyVerification = "unchecked";
const verificationListeners = new Set<(verification: GatewayAccessKeyVerification) => void>();
const stateListeners = new Set<() => void>();
let observedReport = "";

type LocalCacheCredential = { generation: number; scope: string; rejected: boolean };
// One synchronous turn shares the Keychain read and digest behind the local cache scope.
let localCacheInTurn: LocalCacheCredential | null | undefined;

function forgetLocalCacheCredential(): void {
  localCacheInTurn = undefined;
}

function publishAccessKeyState(): void {
  for (const listener of stateListeners) {
    try { listener(); } catch { /* UI observers cannot fail gateway work. */ }
  }
}

function setAccessKeyVerification(verification: GatewayAccessKeyVerification): void {
  if (accessKeyVerification === verification) return;
  accessKeyVerification = verification;
  forgetLocalCacheCredential();
  for (const listener of verificationListeners) {
    try { listener(verification); } catch { /* UI observers cannot fail gateway work. */ }
  }
  publishAccessKeyState();
}

function credentialReport(resolution: CredentialResolution): string {
  if (resolution.status === "conflict") return `conflict:${resolution.conflict ?? "keychain_read_failed"}`;
  return resolution.status === "missing" ? `missing:${resolution.missing ?? "absent"}` : resolution.status;
}

function storedCredentialReport(): { report: string; atMs: number } | null {
  const raw = Storage.get<string>(CREDENTIAL_REPORT_KEY);
  if (typeof raw !== "string" || !raw) return null;
  try {
    const stored = JSON.parse(raw) as { report?: unknown; atMs?: unknown };
    return typeof stored?.report === "string" && Number.isSafeInteger(stored.atMs)
      ? { report: stored.report, atMs: Number(stored.atMs) } : null;
  } catch {
    return null;
  }
}

/**
 * Records a missing or unreadable key once per state change (owner decision, 2026-11-21: 诊断日志事件).
 * The last report is stored with this script copy, so its app, widget and Shortcut runs do not repeat an
 * unchanged state; like other repeating lines it is written again after REPEAT_RELOG_MS, so a key that stays
 * unreadable remains visible in the 7-day log. An explicit removal is recorded where it happens. A key this
 * device never used (no record, no installation digest) is a first run, like the Home reminder: nothing is
 * recorded (N3, 2026-11-21).
 */
function reportCredentialState(resolution: CredentialResolution, report: string): void {
  if (resolution.status === "missing" && (resolution.missing ?? "absent") === "absent" &&
      !scriptingInstallationRecorded()) return;
  const enabled = diagnosticsEnabled();
  try {
    const stored = storedCredentialReport();
    const now = Date.now();
    // A change made while recording is off cannot leave an older report that hides the next one.
    if (!enabled) {
      if (stored) Storage.remove(CREDENTIAL_REPORT_KEY);
    } else if (stored?.report === report && now - stored.atMs >= 0 && now - stored.atMs < REPEAT_RELOG_MS) {
      return;
    } else {
      Storage.set(CREDENTIAL_REPORT_KEY, JSON.stringify({ report, atMs: now }));
    }
  } catch { /* Without the stored report each runtime records the state once. */ }
  if (!enabled) return;
  if (resolution.status === "conflict") {
    writeDiagnostic("gateway.credential.read_failed", {
      stage: "credential_storage", result: resolution.conflict ?? "keychain_read_failed",
    }, "warning");
  } else if (resolution.status === "missing" && resolution.missing !== "removed") {
    writeDiagnostic("gateway.credential.missing", {
      stage: "credential_storage", result: resolution.missing ?? "absent",
    }, "warning");
  }
}

function observeCredential(resolution: CredentialResolution): void {
  const report = credentialReport(resolution);
  const reportChanged = report !== observedReport;
  if (reportChanged) {
    observedReport = report;
    reportCredentialState(resolution, report);
  }
  const candidate = resolution.status === "configured" ? resolution.candidate : null;
  const identity = candidate ? tokenChecksumV2(candidate.token, candidate.generation) : "";
  const identityChanged = identity !== observedCredential;
  if (identityChanged) {
    forgetLocalCacheCredential();
    observedCredential = identity;
    observationGeneration += 1;
    settledSequence = 0;
    setAccessKeyVerification("unchecked");
  }
  if (reportChanged || identityChanged) publishAccessKeyState();
}

export function gatewayAccessKeyState(): {
  status: GatewayCredentialStatus;
  verification: GatewayAccessKeyVerification;
  /** Why a missing key is missing; `removed` means Settings saved an empty record in its place. */
  missing?: MissingCredential;
} {
  const resolution = resolveCredentials();
  observeCredential(resolution);
  return {
    status: resolution.status,
    verification: accessKeyVerification,
    ...(resolution.status === "missing" ? { missing: resolution.missing ?? "absent" } : {}),
  };
}

/** Notifies after any change to the saved key's status or its verification. */
export function subscribeGatewayAccessKeyState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => { stateListeners.delete(listener); };
}

export function subscribeGatewayAccessKeyVerification(
  listener: (verification: GatewayAccessKeyVerification) => void,
): () => void {
  verificationListeners.add(listener);
  return () => { verificationListeners.delete(listener); };
}

export function gatewayAccessKeyRejected(): boolean {
  return gatewayAccessKeyState().verification === "rejected";
}

export function subscribeGatewayAccessKeyRejected(listener: (rejected: boolean) => void): () => void {
  let previous = gatewayAccessKeyRejected();
  const unsubscribe = subscribeGatewayAccessKeyVerification(verification => {
    const rejected = verification === "rejected";
    if (previous === rejected) return;
    previous = rejected;
    listener(rejected);
  });
  listener(previous);
  return unsubscribe;
}

export function beginGatewayCredentialObservation(): GatewayCredentialObservation {
  return { generation: observationGeneration, sequence: ++requestSequence };
}

export function recordGatewayCredentialOutcome(
  observation: GatewayCredentialObservation,
  status: number,
  code: string,
  bodyAccepted = true,
): void {
  observeCredential(resolveCredentials());
  if (!observedCredential || observation.generation !== observationGeneration ||
      observation.sequence <= settledSequence) return;
  if (!Number.isInteger(status) || status < 100 || status > 599) return;
  // A newer completed response fences older replies without inventing a new diagnosis.
  settledSequence = observation.sequence;
  if (status === 401 && code === "unauthorized") setAccessKeyVerification("rejected");
  else if (status >= 200 && status < 300 && bodyAccepted) setAccessKeyVerification("accepted");
}

function tokenChecksumV2(token: string, generation: number): string {
  return sha256Hex(`${generation}\n${token}`);
}

function tokenChecksumV4(
  token: string,
  generation: number,
  availability: CredentialAvailability,
): string {
  return sha256Hex(
    `credential\n${generation}\n${availability}\n${token}`,
  );
}

function encodeToken(
  token: string,
  generation: number,
  availability: CredentialAvailability,
): string {
  const stored: StoredCredential = {
    // Schema 6 marks completed shared-replica migration; the V4 checksum stays unchanged.
    schema: 6,
    token,
    generation,
    availability,
    checksum: tokenChecksumV4(token, generation, availability),
  };
  return JSON.stringify(stored);
}

function pendingChecksumV3(
  token: string,
  generation: number,
  previousKey: string | null,
): string {
  return sha256Hex(
    `pending\n${generation}\n${token}\n${JSON.stringify(previousKey)}`,
  );
}

function pendingChecksumV5(
  token: string,
  generation: number,
  previousKey: string | null,
  availability: CredentialAvailability,
): string {
  return sha256Hex(
    `pending\n${generation}\n${availability}\n${token}\n${JSON.stringify(previousKey)}`,
  );
}

function absent(): CredentialCandidate {
  return {
    present: false,
    token: "",
    generation: 0,
    availability: "available",
  };
}

function decodeToken(raw: unknown): CredentialCandidate {
  if (typeof raw !== "string" || !raw) return absent();
  try {
    const stored = JSON.parse(raw) as Partial<StoredCredential>;
    if (typeof stored.token !== "string" || typeof stored.checksum !== "string") {
      return absent();
    }
    let generation = 0;
    let checksum = "";
    if (stored.schema === 4 || stored.schema === 6) {
      if (
        !Number.isSafeInteger(stored.generation) ||
        Number(stored.generation) < 1 ||
        (stored.availability !== "available" &&
          stored.availability !== "unavailable")
      ) {
        return absent();
      }
      generation = Number(stored.generation);
      const storedAvailability = stored.availability;
      checksum = tokenChecksumV4(stored.token, generation, storedAvailability);
      // Older v1.2.13 builds persisted every HTTP 401/403 as a permanent token
      // disable marker. The gateway does not expose a durable revocation contract,
      // so a valid legacy record must remain eligible for the next request.
    } else if (stored.schema === 2) {
      if (!Number.isSafeInteger(stored.generation) || Number(stored.generation) < 1) {
        return absent();
      }
      generation = Number(stored.generation);
      checksum = tokenChecksumV2(stored.token, generation);
    } else if (stored.schema === 1) {
      checksum = sha256Hex(stored.token);
    } else {
      return absent();
    }
    if (stored.checksum.toLowerCase() !== checksum) return absent();
    const token = normalizeScriptingToken(stored.token);
    if (stored.token && !token) return absent();
    return { present: true, token, generation, availability: "available" };
  } catch {
    return absent();
  }
}

function decodePendingToken(raw: unknown): PendingCredential | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const stored = JSON.parse(raw) as Partial<PendingCredential>;
    if (
      (stored.schema !== 3 && stored.schema !== 5) ||
      typeof stored.token !== "string" ||
      !Number.isSafeInteger(stored.generation) ||
      Number(stored.generation) < 1 ||
      (stored.previousKey !== null && typeof stored.previousKey !== "string") ||
      typeof stored.checksum !== "string"
    ) {
      return null;
    }
    const token = normalizeScriptingToken(stored.token);
    if (!token) return null;
    const generation = Number(stored.generation);
    const previousKey = stored.previousKey;
    const storedAvailability = stored.schema === 3
      ? "available"
      : stored.availability;
    if (
      storedAvailability !== "available" &&
      storedAvailability !== "unavailable"
    ) {
      return null;
    }
    const checksum = stored.schema === 3
      ? pendingChecksumV3(token, generation, previousKey)
      : pendingChecksumV5(token, generation, previousKey, storedAvailability);
    if (stored.checksum.toLowerCase() !== checksum) return null;
    return {
      schema: stored.schema,
      token,
      generation,
      previousKey,
      availability: "available",
      checksum: stored.checksum,
    };
  } catch {
    return null;
  }
}

function readKeyRawResult(): KeyRawRead {
  try {
    const value = Keychain.get(SCRIPTING_TOKEN_KEY);
    return { value: typeof value === "string" ? value : null, failed: false };
  } catch {
    return { value: null, failed: true };
  }
}

function readKeyCandidateFromRaw(value: string | null): CredentialCandidate {
  const encoded = decodeToken(value);
  if (encoded.present) return encoded;
  const token = normalizeScriptingToken(value?.trim() ?? "");
  return token
    ? { present: true, token, generation: 0, availability: "available" }
    : absent();
}

function keyRawMatches(raw: string | null): boolean {
  const current = readKeyRawResult();
  return !current.failed && current.value === raw;
}

function writeKeyRaw(raw: string): boolean {
  forgetLocalCacheCredential();
  try {
    return Keychain.set(SCRIPTING_TOKEN_KEY, raw) !== false && keyRawMatches(raw);
  } catch {
    return false;
  }
}

function restoreKeyRaw(raw: string | null): boolean {
  forgetLocalCacheCredential();
  try {
    const restored = raw == null
      ? Keychain.remove(SCRIPTING_TOKEN_KEY)
      : Keychain.set(SCRIPTING_TOKEN_KEY, raw);
    return restored !== false && keyRawMatches(raw);
  } catch {
    return false;
  }
}

function keychainOnly(raw: string | null): boolean {
  try { return JSON.parse(raw ?? "null")?.schema === 6; }
  catch { return false; }
}

function resolveCredentials(): CredentialResolution {
  // Missing credentials stop the gateway before it reaches the activation entry.
  removeLegacyCredentialCopies("activation");
  const keyRaw = readKeyRawResult();
  if (keyRaw.failed) {
    return { status: "conflict", candidate: null, conflict: "keychain_read_failed" };
  }
  let key = readKeyCandidateFromRaw(keyRaw.value);
  const pending = decodePendingToken(keyRaw.value);
  if (pending || (key.present && key.token && !keychainOnly(keyRaw.value))) {
    let legacy: ReturnType<typeof readDurableTextResult>;
    try { legacy = readDurableTextResult("gateway-credential-v1.json"); }
    catch { return { status: "conflict", candidate: null, conflict: "legacy_record_unreadable" }; }
    const candidates = legacy.candidates.map(decodeToken);
    // A legacy deletion committed its file before best-effort Keychain removal.
    // Preserve that evidence until its deletion is confirmed in the protected store.
    if (legacy.failed || candidates.some((candidate) => !candidate.present)) {
      return { status: "conflict", candidate: null,
        conflict: legacy.failed ? "legacy_record_unreadable" : "legacy_record_invalid" };
    }
    if (pending) {
      const committed = candidates.some((candidate) =>
        candidate.token === pending.token && candidate.generation === pending.generation &&
        candidate.availability === pending.availability);
      if (committed) {
        // The replica proves the old commit, but the secret comes from Keychain.
        key = { present: true, token: pending.token, generation: pending.generation,
          availability: pending.availability };
      } else {
        const previous = readKeyCandidateFromRaw(pending.previousKey);
        if ((pending.previousKey != null && !previous.present) ||
            !restoreKeyRaw(pending.previousKey)) {
          return { status: "conflict", candidate: null, conflict: "migration_failed" };
        }
        key = previous;
      }
    }
    for (const candidate of candidates) {
      if (!candidate.token && candidate.generation >= key.generation) key = candidate;
    }
    if (!writeKeyRaw(encodeToken(key.token, key.generation || 1, "available"))) {
      restoreKeyRaw(keyRaw.value);
      return { status: "conflict", candidate: null, conflict: "migration_failed" };
    }
  }
  removeLegacyCredentialCopies("token");
  if (key.present && key.token) return { status: "configured", candidate: key };
  // An empty record is an explicit removal; no record at all is a key this Keychain scope never held or lost.
  const missing: MissingCredential = key.present ? "removed"
    : keyRaw.value == null || pending?.previousKey === null ? "absent" : "invalid";
  return { status: "missing", candidate: null, missing };
}

export function loadGatewayCredentials(): GatewayCredentials | null {
  const resolution = resolveCredentials();
  observeCredential(resolution);
  return resolution.status === "configured" && resolution.candidate
    ? { token: resolution.candidate.token }
    : null;
}

/** Why writing the key record failed; the only results gateway.credential.save_failed carries. */
type CredentialWriteFailure = "keychain_read_failed" | "write_failed" | "restore_failed";

/** Keeps the ordinary error message and name the Settings page already shows; only the reason is added. */
class CredentialWriteError extends Error {
  constructor(message: string, readonly reason: CredentialWriteFailure) {
    super(message);
  }
}

export function saveGatewayToken(token: string): void {
  const clean = normalizeScriptingToken(token);
  // User decision 2026-09-27: a malformed key reads the same as an invalid one.
  if (!clean) throw new Error("Access Key 无效或已失效");
  let previous: CredentialCandidate;
  try {
    previous = writeCredential(clean, "Access Key 保存失败，请稍后重试");
  } catch (error) {
    // Owner 2026-11-21: 记录保存失败（推荐）. Only the stage and a fixed reason, never the key or its digest.
    writeDiagnostic("gateway.credential.save_failed", {
      stage: "credential_storage", result: error instanceof CredentialWriteError ? error.reason : "write_failed",
    }, "warning");
    throw error;
  }
  // The log names only whether a key was saved before and whether it was the same one.
  writeDiagnostic("gateway.credential.saved", {
    stage: "credential_storage",
    result: !previous.token ? "new_key" : previous.token === clean ? "same_key" : "different_key",
  });
}

const credentialChangeListeners = new Set<() => void>();

export function onGatewayCredentialChanged(listener: () => void): () => void {
  credentialChangeListeners.add(listener);
  return () => { credentialChangeListeners.delete(listener); };
}

function writeCredential(token: string, failureMessage: string): CredentialCandidate {
  const previous = readKeyRawResult();
  if (previous.failed) throw new CredentialWriteError(failureMessage, "keychain_read_failed");
  const candidate = readKeyCandidateFromRaw(previous.value);
  const pending = decodePendingToken(previous.value);
  const generation = Math.max(Date.now(), candidate.generation + 1, (pending?.generation ?? 0) + 1);
  if (!writeKeyRaw(encodeToken(token, generation, "available"))) {
    // A first key restores to no record, so the half-written key is removed.
    const restored = restoreKeyRaw(previous.value);
    throw new CredentialWriteError(failureMessage, restored ? "write_failed" : "restore_failed");
  }
  removeLegacyCredentialCopies("token");
  observeCredential(resolveCredentials());
  for (const listener of [...credentialChangeListeners]) {
    try { listener(); } catch { /* credential listeners are best-effort */ }
  }
  return candidate;
}

export function removeGatewayToken(): void {
  // Replace the protected record with an empty credential before acknowledging removal.
  // Legacy shared files are cleanup only and can never resurrect the removed key.
  writeCredential("", "Access Key 删除失败，请稍后重试");
  writeDiagnostic("gateway.credential.removed", { stage: "credential_storage" });
}

export function gatewayConfigured(): boolean {
  return gatewayCredentialStatus() === "configured";
}

export function gatewayCredentialStatus(): GatewayCredentialStatus {
  const resolution = resolveCredentials();
  observeCredential(resolution);
  return resolution.status;
}

export function gatewayCredentialGeneration(): number | null {
  return gatewayCredentialStatus() === "configured" ? observationGeneration : null;
}

export function gatewayCredentialForLocalCache(): LocalCacheCredential | null {
  if (localCacheInTurn !== undefined) return localCacheInTurn;
  const resolved = gatewayCredentialStatus() !== "configured" ? null : {
    generation: observationGeneration,
    scope: sha256Hex(`local-cloud-cache\n${observedCredential}`),
    rejected: accessKeyVerification === "rejected",
  };
  localCacheInTurn = resolved;
  void Promise.resolve().then(forgetLocalCacheCredential);
  return resolved;
}
