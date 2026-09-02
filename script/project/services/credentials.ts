import type { GatewayCredentials } from "../models";
import {
  normalizeScriptingToken,
} from "./scripting-auth";
import {
  readDurableTextResult,
  writeDurableText,
} from "./durable-files";
import { utf8Data } from "./scripting-data";

const SCRIPTING_TOKEN_KEY = "pipi_deliveries_scripting_token_v1";
const SCRIPTING_TOKEN_SHARED_KEY = "pipi_deliveries_scripting_token_shared_v1";
const SCRIPTING_TOKEN_FILE = "gateway-credential-v1.json";

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

type DurableCandidateRead = {
  candidates: readonly CredentialCandidate[];
  failed: boolean;
};

type KeyRawRead = {
  value: string | null;
  failed: boolean;
};

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
    schema: 4,
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

function encodePendingToken(
  token: string,
  generation: number,
  previousKey: string | null,
  availability: CredentialAvailability,
): string {
  const stored: PendingCredential = {
    schema: 5,
    token,
    generation,
    previousKey,
    availability,
    checksum: pendingChecksumV5(
      token,
      generation,
      previousKey,
      availability,
    ),
  };
  return JSON.stringify(stored);
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
    if (stored.schema === 4) {
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

function readDurableCandidates(): DurableCandidateRead {
  try {
    const result = readDurableTextResult(SCRIPTING_TOKEN_FILE);
    return {
      candidates: result.candidates
        .map(decodeToken)
        .filter((candidate) => candidate.present),
      failed: result.failed,
    };
  } catch {
    return { candidates: [], failed: true };
  }
}

function readDurableCandidate(): CredentialCandidate {
  return readDurableCandidates().candidates[0] ?? absent();
}

function writeDurableToken(
  token: string,
  generation: number,
  availability: CredentialAvailability,
): void {
  writeDurableText(
    SCRIPTING_TOKEN_FILE,
    encodeToken(token, generation, availability),
  );
}

function readSharedToken(): CredentialCandidate {
  try {
    return decodeToken(Storage.get<string>(
      SCRIPTING_TOKEN_SHARED_KEY,
      { shared: true },
    ));
  } catch {
    return absent();
  }
}

function removeSharedTokenBestEffort(): void {
  try {
    Storage.remove(SCRIPTING_TOKEN_SHARED_KEY, { shared: true });
  } catch {
    /* A later credential read retries legacy shared-domain cleanup. */
  }
}

function readKeyRawResult(): KeyRawRead {
  try {
    const value = Keychain.get(SCRIPTING_TOKEN_KEY);
    return {
      value: typeof value === "string" ? value : null,
      failed: false,
    };
  } catch {
    return { value: null, failed: true };
  }
}

function readKeyCandidateFromRaw(value: string | null): CredentialCandidate {
  const encoded = decodeToken(value);
  if (encoded.present) return encoded;
  const token = normalizeScriptingToken(value?.trim() ?? "");
  return token
    ? {
      present: true,
      token,
      generation: 0,
      availability: "available",
    }
    : absent();
}

function readKeyCandidate(): CredentialCandidate {
  return readKeyCandidateFromRaw(readKeyRawResult().value);
}

function keyRawMatches(raw: string | null): boolean {
  const current = readKeyRawResult();
  return !current.failed && current.value === raw;
}

function writeKeyRaw(raw: string): boolean {
  try {
    return Keychain.set(SCRIPTING_TOKEN_KEY, raw) !== false &&
      keyRawMatches(raw);
  } catch {
    return false;
  }
}

function writeKey(
  token: string,
  generation: number,
  availability: CredentialAvailability,
): boolean {
  return writeKeyRaw(encodeToken(token, generation, availability));
}

function keyMatches(
  token: string,
  generation: number,
  availability: CredentialAvailability,
): boolean {
  const candidate = readKeyCandidate();
  return candidate.present &&
    candidate.token === token &&
    candidate.generation === generation &&
    candidate.availability === availability;
}

function restoreKeyRaw(raw: string | null): boolean {
  try {
    if (raw == null) {
      if (Keychain.remove(SCRIPTING_TOKEN_KEY) === false) return false;
    } else {
      if (Keychain.set(SCRIPTING_TOKEN_KEY, raw) === false) return false;
    }
    return keyRawMatches(raw);
  } catch {
    return false;
  }
}

function removeKeyBestEffort(): void {
  try {
    Keychain.remove(SCRIPTING_TOKEN_KEY);
  } catch {
    /* A durable deletion tombstone still blocks this stale value. */
  }
}

function newestGeneration(): number {
  const keyRaw = readKeyRawResult().value;
  const pending = decodePendingToken(keyRaw);
  return [
    readKeyCandidateFromRaw(keyRaw),
    readDurableCandidate(),
    readSharedToken(),
  ].reduce(
    (latest, candidate) => candidate.present
      ? Math.max(latest, candidate.generation)
      : latest,
    pending?.generation ?? 0,
  );
}

function nextGeneration(): number {
  return Math.max(Date.now(), newestGeneration() + 1);
}

function resolved(candidate: CredentialCandidate): CredentialResolution {
  return {
    status: candidate.token
      ? candidate.availability === "unavailable"
        ? "unavailable"
        : "configured"
      : "missing",
    candidate: candidate.token ? candidate : null,
  };
}

function conflict(): CredentialResolution {
  return { status: "conflict", candidate: null };
}

function restoreDurableCandidate(
  candidate: CredentialCandidate,
): CredentialResolution {
  if (!candidate.token) {
    removeKeyBestEffort();
    removeSharedTokenBestEffort();
    return { status: "missing", candidate: null };
  }
  if (
    writeKey(
      candidate.token,
      candidate.generation,
      candidate.availability,
    ) &&
    keyMatches(
      candidate.token,
      candidate.generation,
      candidate.availability,
    )
  ) {
    removeSharedTokenBestEffort();
  }
  return resolved(candidate);
}

function migrateSharedCandidate(
  candidate: CredentialCandidate,
): CredentialResolution {
  if (!candidate.token) {
    removeSharedTokenBestEffort();
    return { status: "missing", candidate: null };
  }
  const generation = candidate.generation > 0
    ? candidate.generation
    : Math.max(Date.now(), 1);
  const previousKey = readKeyRawResult();
  if (previousKey.failed) return conflict();

  // The pending Keychain record is deliberately not a credential candidate. If the
  // App Group commit fails and restoring the prior key also fails, later reads remain
  // conflicted instead of authorizing a partially migrated generation.
  const pending = encodePendingToken(
    candidate.token,
    generation,
    previousKey.value,
    candidate.availability,
  );
  if (!writeKeyRaw(pending)) {
    restoreKeyRaw(previousKey.value);
    return conflict();
  }

  try {
    writeDurableToken(candidate.token, generation, candidate.availability);
  } catch {
    restoreKeyRaw(previousKey.value);
    return conflict();
  }

  // writeDurableText verifies the installed primary before returning. That return is
  // the commit point; replacing the pending record with its compact form is cleanup.
  writeKey(candidate.token, generation, candidate.availability);
  removeSharedTokenBestEffort();
  return resolved({
    present: true,
    token: candidate.token,
    generation,
    availability: candidate.availability,
  });
}

function resolvePendingKey(
  pending: PendingCredential,
): CredentialResolution {
  const durable = readDurableCandidates();
  const committed = durable.candidates.some((candidate) =>
    candidate.token === pending.token &&
    candidate.generation === pending.generation &&
    candidate.availability === pending.availability
  );
  if (committed) {
    writeKey(pending.token, pending.generation, pending.availability);
    removeSharedTokenBestEffort();
    return resolved({
      present: true,
      token: pending.token,
      generation: pending.generation,
      availability: pending.availability,
    });
  }

  // An unreadable durable replica may already contain the pending generation. Keep
  // the transaction unavailable until a later read can choose commit or rollback.
  if (durable.failed || !restoreKeyRaw(pending.previousKey)) return conflict();

  const previous = readKeyCandidateFromRaw(pending.previousKey);
  if (previous.present) return resolved(previous);
  if (pending.previousKey != null || readSharedToken().present) return conflict();
  return { status: "missing", candidate: null };
}

function resolveCredentials(): CredentialResolution {
  const keyRaw = readKeyRawResult();
  if (keyRaw.failed) return conflict();
  const pending = decodePendingToken(keyRaw.value);
  if (pending) return resolvePendingKey(pending);

  const key = readKeyCandidateFromRaw(keyRaw.value);
  const durable = readDurableCandidate();

  // An explicit deletion outlives a replaced script Keychain namespace and must also
  // suppress any older value that survived in the legacy shared Storage domain.
  if (
    durable.present &&
    !durable.token &&
    (!key.present || durable.generation >= key.generation)
  ) {
    removeKeyBestEffort();
    removeSharedTokenBestEffort();
    return { status: "missing", candidate: null };
  }

  // Keychain is authoritative during normal operation. Recovery copies never vote
  // against a valid Keychain value, so a stale mirror cannot disable authorization.
  if (key.present && key.token) {
    removeSharedTokenBestEffort();
    return resolved(key);
  }

  // The App Group file exists only so a freshly imported script can restore its
  // per-script Keychain namespace while keeping the user's existing authorization.
  if (durable.present) return restoreDurableCandidate(durable);

  // Older releases wrote the token to global shared Storage. Consume that value once,
  // migrate it into Keychain plus the App Group recovery file, then remove the legacy copy.
  const shared = readSharedToken();
  return shared.present
    ? migrateSharedCandidate(shared)
    : { status: "missing", candidate: null };
}

export function loadGatewayCredentials(): GatewayCredentials | null {
  const resolution = resolveCredentials();
  return resolution.status === "configured" && resolution.candidate
    ? { token: resolution.candidate.token }
    : null;
}

export function saveGatewayToken(token: string): void {
  const clean = normalizeScriptingToken(token);
  if (!clean) throw new Error("Access Key 格式不正确");

  writeCredentialTransaction(
    clean,
    "available",
    "Access Key 保存失败，请重试",
  );
}

function writeCredentialTransaction(
  token: string,
  availability: CredentialAvailability,
  failureMessage: string,
): void {
  const generation = nextGeneration();
  let previousKey = readKeyRawResult();
  if (previousKey.failed) {
    throw new Error(failureMessage);
  }

  const existingPending = decodePendingToken(previousKey.value);
  if (existingPending) {
    const resolution = resolvePendingKey(existingPending);
    if (resolution.status === "conflict") {
      throw new Error(failureMessage);
    }
    previousKey = {
      value: resolution.candidate
        ? encodeToken(
          resolution.candidate.token,
          resolution.candidate.generation,
          resolution.candidate.availability,
        )
        : null,
      failed: false,
    };
  }

  const pending = encodePendingToken(
    token,
    generation,
    previousKey.value,
    availability,
  );
  if (!writeKeyRaw(pending)) {
    restoreKeyRaw(previousKey.value);
    throw new Error(failureMessage);
  }

  try {
    writeDurableToken(token, generation, availability);
  } catch {
    // A failed compensation leaves the pending record in Keychain. resolveCredentials
    // treats it as conflict, so the uncommitted generation can never become authorized.
    restoreKeyRaw(previousKey.value);
    throw new Error(failureMessage);
  }

  // The durable writer verifies its primary before returning, so a later independent
  // read failure cannot turn this committed save into a reported rollback.
  writeKey(token, generation, availability);
  removeSharedTokenBestEffort();
}

export function removeGatewayToken(): void {
  const generation = nextGeneration();
  try {
    writeDurableToken("", generation, "available");
  } catch {
    throw new Error("Access Key 删除失败，请重试");
  }

  // The durable tombstone is the commit. Keychain and shared Storage cleanup can be
  // retried by later reads without changing the already committed deletion.
  removeKeyBestEffort();
  removeSharedTokenBestEffort();
}

export function gatewayConfigured(): boolean {
  return gatewayCredentialStatus() === "configured";
}

export function gatewayCredentialStatus(): GatewayCredentialStatus {
  return resolveCredentials().status;
}
