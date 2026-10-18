import type { GatewayCredentials } from "../models";
import {
  normalizeScriptingToken,
} from "./scripting-auth";
import { readDurableTextResult } from "./durable-files";
import { removeLegacyCredentialCopies } from "./legacy-credential-cleanup";
import { utf8Data } from "./scripting-data";

const SCRIPTING_TOKEN_KEY = "pipi_deliveries_scripting_token_v1";

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

type CredentialResolution = {
  status: GatewayCredentialStatus;
  candidate: CredentialCandidate | null;
};

type KeyRawRead = {
  value: string | null;
  failed: boolean;
};

export type GatewayCredentialObservation = {
  generation: number;
  sequence: number;
};

let observedCredential = "";
let observationGeneration = 0;
let requestSequence = 0;
let settledSequence = 0;
let accessKeyRejected = false;
const rejectionListeners = new Set<(rejected: boolean) => void>();

function setAccessKeyRejected(rejected: boolean): void {
  if (accessKeyRejected === rejected) return;
  accessKeyRejected = rejected;
  for (const listener of rejectionListeners) {
    try { listener(rejected); } catch { /* UI observers cannot fail gateway work. */ }
  }
}

function observeCredential(resolution: CredentialResolution): void {
  const candidate = resolution.status === "configured" ? resolution.candidate : null;
  const identity = candidate ? tokenChecksumV2(candidate.token, candidate.generation) : "";
  if (identity === observedCredential) return;
  observedCredential = identity;
  observationGeneration += 1;
  settledSequence = 0;
  setAccessKeyRejected(false);
}

export function gatewayAccessKeyRejected(): boolean {
  observeCredential(resolveCredentials());
  return accessKeyRejected;
}

export function subscribeGatewayAccessKeyRejected(listener: (rejected: boolean) => void): () => void {
  const rejected = gatewayAccessKeyRejected();
  rejectionListeners.add(listener);
  listener(rejected);
  return () => { rejectionListeners.delete(listener); };
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
  if (status === 401 && code === "unauthorized") setAccessKeyRejected(true);
  else if (status >= 200 && status < 300 && bodyAccepted) setAccessKeyRejected(false);
}

function tokenChecksum(value: string): string {
  return Crypto.sha256(utf8Data(value)).toHexString().toLowerCase();
}

function tokenChecksumV2(token: string, generation: number): string {
  return tokenChecksum(`${generation}\n${token}`);
}

function tokenChecksumV4(
  token: string,
  generation: number,
  availability: CredentialAvailability,
): string {
  return tokenChecksum(
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
  return tokenChecksum(
    `pending\n${generation}\n${token}\n${JSON.stringify(previousKey)}`,
  );
}

function pendingChecksumV5(
  token: string,
  generation: number,
  previousKey: string | null,
  availability: CredentialAvailability,
): string {
  return tokenChecksum(
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
    let availability: CredentialAvailability = "available";
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
      availability = "available";
    } else if (stored.schema === 2) {
      if (!Number.isSafeInteger(stored.generation) || Number(stored.generation) < 1) {
        return absent();
      }
      generation = Number(stored.generation);
      checksum = tokenChecksumV2(stored.token, generation);
    } else if (stored.schema === 1) {
      checksum = tokenChecksum(stored.token);
    } else {
      return absent();
    }
    if (stored.checksum.toLowerCase() !== checksum) return absent();
    const token = normalizeScriptingToken(stored.token);
    if (stored.token && !token) return absent();
    if (!token && availability === "unavailable") return absent();
    return { present: true, token, generation, availability };
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
  try {
    return Keychain.set(SCRIPTING_TOKEN_KEY, raw) !== false && keyRawMatches(raw);
  } catch {
    return false;
  }
}

function restoreKeyRaw(raw: string | null): boolean {
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
    return { status: "conflict", candidate: null };
  }
  let key = readKeyCandidateFromRaw(keyRaw.value);
  const pending = decodePendingToken(keyRaw.value);
  if (pending || (key.present && key.token && !keychainOnly(keyRaw.value))) {
    let legacy: ReturnType<typeof readDurableTextResult>;
    try { legacy = readDurableTextResult("gateway-credential-v1.json"); }
    catch { return { status: "conflict", candidate: null }; }
    const candidates = legacy.candidates.map(decodeToken);
    // A legacy deletion committed its file before best-effort Keychain removal.
    // Preserve that evidence until its deletion is confirmed in the protected store.
    if (legacy.failed || candidates.some((candidate) => !candidate.present)) {
      return { status: "conflict", candidate: null };
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
          return { status: "conflict", candidate: null };
        }
        key = previous;
      }
    }
    for (const candidate of candidates) {
      if (!candidate.token && candidate.generation >= key.generation) key = candidate;
    }
    if (!writeKeyRaw(encodeToken(key.token, key.generation || 1, "available"))) {
      restoreKeyRaw(keyRaw.value);
      return { status: "conflict", candidate: null };
    }
  }
  removeLegacyCredentialCopies("token");
  return key.present && key.token
    ? { status: "configured", candidate: key }
    : { status: "missing", candidate: null };
}

export function loadGatewayCredentials(): GatewayCredentials | null {
  const resolution = resolveCredentials();
  observeCredential(resolution);
  return resolution.status === "configured" && resolution.candidate
    ? { token: resolution.candidate.token }
    : null;
}

export function saveGatewayToken(token: string): void {
  const clean = normalizeScriptingToken(token);
  // User decision 2026-09-27: a malformed key reads the same as an invalid one.
  if (!clean) throw new Error("Access Key 无效或已失效");
  writeCredential(clean, "Access Key 保存失败，请重试");
}

function writeCredential(token: string, failureMessage: string): void {
  const previous = readKeyRawResult();
  if (previous.failed) throw new Error(failureMessage);
  const candidate = readKeyCandidateFromRaw(previous.value);
  const pending = decodePendingToken(previous.value);
  const generation = Math.max(Date.now(), candidate.generation + 1, (pending?.generation ?? 0) + 1);
  if (!writeKeyRaw(encodeToken(token, generation, "available"))) {
    restoreKeyRaw(previous.value);
    throw new Error(failureMessage);
  }
  removeLegacyCredentialCopies("token");
  observeCredential(resolveCredentials());
}

export function removeGatewayToken(): void {
  // Replace the protected record with an empty credential before acknowledging removal.
  // Legacy shared files are cleanup only and can never resurrect the removed key.
  writeCredential("", "Access Key 删除失败，请重试");
}

export function gatewayConfigured(): boolean {
  return gatewayCredentialStatus() === "configured";
}

export function gatewayCredentialStatus(): GatewayCredentialStatus {
  const resolution = resolveCredentials();
  observeCredential(resolution);
  return resolution.status;
}
