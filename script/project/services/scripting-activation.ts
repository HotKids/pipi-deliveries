import {
  readDurableTextCandidates,
  writeDurableText,
} from "./durable-files";
import { loadGatewayCredentials } from "./credentials";
import { utf8Data } from "./scripting-data";
import { writeDiagnostic } from "./logger";

/**
 * iOS Access Key activation identity (user decisions 2026-09-26/27; PLAN-ADDENDUM §2.1, CONTRACT
 * §2 and §3.1, evidence ACCESS-KEY-BETA-20260927).
 *
 * A personal Access Key can be activated only once: the Worker binds it to the first activation
 * identity that authenticates with it. The identity is a dedicated 32-byte random value, kept in
 * this script's iCloud-synchronized Keychain so every device of the same Apple ID presents the same
 * one, with two local backups (App Group file and shared Storage) that survive a replaced Keychain
 * scope. It is deliberately NOT the interface-5 installation identity: that one is forwarded to the
 * Xiaomi upstream and never leaves this device.
 *
 * Read order: the synchronized Keychain first; when it is empty, the local backups (App Group file,
 * then shared Storage), written back to the Keychain; only when every copy is missing a new identity
 * is generated, and it is saved before any request carries it. When the Keychain and a backup
 * disagree the Keychain wins and the backup is rewritten, so the devices converge on one value.
 *
 * The identity travels unsigned in X-Scripting-Activation (protocol v1 is unchanged). It is never
 * logged: diagnostics only name where it came from.
 */
export const SCRIPTING_ACTIVATION_HEADER = "X-Scripting-Activation";

const ACTIVATION_KEYCHAIN_KEY = "pipi_deliveries_scripting_activation_v1";
const ACTIVATION_SHARED_KEY = "pipi_deliveries_scripting_activation_shared_v1";
const ACTIVATION_FILE = "scripting-activation-v1.json";
const ACTIVATION_REJECTION_KEY =
  "pipi_deliveries_scripting_activation_rejected_v1";
// Items written with synchronizable must be read with it too (Scripting Keychain §12).
const SYNCED_KEYCHAIN = { synchronizable: true } as const;
const ACTIVATION_PATTERN = /^[0-9a-f]{64}$/;

export type ScriptingActivationSource =
  | "synced_keychain"
  | "synced_keychain_replaced_backup"
  | "local_backup"
  | "generated";

export class ScriptingActivationUnavailableError extends Error {
  constructor() {
    super("activation identity could not be saved");
    this.name = "ScriptingActivationUnavailableError";
  }
}

function validActivation(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return ACTIVATION_PATTERN.test(text) ? text : "";
}

function sha256Hex(value: string): string {
  return Crypto.sha256(utf8Data(value)).toHexString().toLowerCase();
}

function backupChecksum(activation: string): string {
  return sha256Hex(`pipi-scripting-activation-backup-v1\n${activation}`);
}

function encodeBackup(activation: string): string {
  return JSON.stringify({
    schema: 1,
    activation,
    checksum: backupChecksum(activation),
  });
}

function decodeBackup(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  try {
    const stored = JSON.parse(raw) as {
      schema?: unknown;
      activation?: unknown;
      checksum?: unknown;
    };
    const activation = validActivation(stored?.activation);
    return stored?.schema === 1 &&
      activation &&
      typeof stored.checksum === "string" &&
      stored.checksum.toLowerCase() === backupChecksum(activation)
      ? activation
      : "";
  } catch {
    return "";
  }
}

function readSyncedKeychain(): string {
  try {
    return validActivation(Keychain.get(ACTIVATION_KEYCHAIN_KEY, SYNCED_KEYCHAIN));
  } catch {
    return "";
  }
}

function writeSyncedKeychain(activation: string): boolean {
  try {
    return Keychain.set(ACTIVATION_KEYCHAIN_KEY, activation, SYNCED_KEYCHAIN) !== false &&
      readSyncedKeychain() === activation;
  } catch {
    return false;
  }
}

function readFileBackup(): string {
  try {
    for (const raw of readDurableTextCandidates(ACTIVATION_FILE)) {
      const activation = decodeBackup(raw);
      if (activation) return activation;
    }
  } catch {
    /* the shared Storage backup is read next */
  }
  return "";
}

function writeFileBackup(activation: string): boolean {
  try {
    // writeDurableText reads the installed primary back before it returns.
    writeDurableText(ACTIVATION_FILE, encodeBackup(activation));
    return true;
  } catch {
    return false;
  }
}

function readSharedBackup(): string {
  try {
    return decodeBackup(Storage.get<string>(ACTIVATION_SHARED_KEY, { shared: true }));
  } catch {
    return "";
  }
}

function writeSharedBackup(activation: string): boolean {
  try {
    return Storage.set(ACTIVATION_SHARED_KEY, encodeBackup(activation), { shared: true }) !== false;
  } catch {
    return false;
  }
}

/** 32 bytes from the system CSPRNG: the same generator every request nonce already uses. */
function generateActivation(): string {
  return [0, 1]
    .map(() => Crypto.generateSymmetricKey(128).toHexString().toLowerCase())
    .join("");
}

// The identity whose two backups this process has already seen equal to the Keychain, so the
// steady state costs one Keychain read per request and no file or Storage traffic.
let mirroredActivation = "";
const reportedOutcomes = new Set<string>();

/** Forgets this process's memo and reported outcomes, as a fresh app or widget process would. */
export function resetScriptingActivationProcessState(): void {
  mirroredActivation = "";
  reportedOutcomes.clear();
}

function report(result: ScriptingActivationSource, persisted: boolean): void {
  const key = `${result}:${persisted}`;
  if (reportedOutcomes.has(key)) return;
  reportedOutcomes.add(key);
  writeDiagnostic("gateway.activation.resolved", {
    stage: "activation_identity",
    result,
    persisted,
  }, result === "generated" || persisted ? "info" : "warning");
}

/**
 * Returns the activation identity every Scripting request must carry, generating and saving it on
 * first use. Throws ScriptingActivationUnavailableError, before anything is sent, when a new
 * identity cannot be saved: a key must never bind to an identity that is lost right after.
 */
export function loadScriptingActivation(
  generate: () => string = generateActivation,
): string {
  const synced = readSyncedKeychain();
  if (synced) {
    if (synced === mirroredActivation) return synced;
    const file = readFileBackup();
    const shared = readSharedBackup();
    const fileSaved = file === synced || writeFileBackup(synced);
    const sharedSaved = shared === synced || writeSharedBackup(synced);
    if (fileSaved && sharedSaved) mirroredActivation = synced;
    if (file !== synced || shared !== synced) {
      report(
        (file && file !== synced) || (shared && shared !== synced)
          ? "synced_keychain_replaced_backup"
          : "synced_keychain",
        true,
      );
    }
    return synced;
  }

  const file = readFileBackup();
  const shared = readSharedBackup();
  const backup = file || shared;
  if (backup) {
    const persisted = writeSyncedKeychain(backup);
    if (file !== backup) writeFileBackup(backup);
    if (shared !== backup) writeSharedBackup(backup);
    report("local_backup", persisted);
    return backup;
  }

  const generated = validActivation(generate());
  if (!generated) throw new ScriptingActivationUnavailableError();
  const persisted = writeSyncedKeychain(generated);
  // Another runtime (app or widget) may have saved its own identity between our read and write;
  // the synchronized Keychain is the authority, so adopt its value instead of sending ours.
  const current = persisted ? generated : readSyncedKeychain();
  if (current && current !== generated) {
    writeFileBackup(current);
    writeSharedBackup(current);
    return current;
  }
  const fileSaved = writeFileBackup(generated);
  // Shared Storage persists asynchronously, so only the Keychain or the verified App Group file
  // counts as saved; an unsaved identity is not left behind for a later request to pick up.
  if (!persisted && !fileSaved) {
    writeDiagnostic("gateway.activation.failed", {
      stage: "activation_identity",
      result: "save_failed",
    }, "error");
    throw new ScriptingActivationUnavailableError();
  }
  writeSharedBackup(generated);
  report("generated", persisted);
  return generated;
}

function keyFingerprint(token: string): string {
  return sha256Hex(`pipi-scripting-activation-notice-v1\n${token}`);
}

function readRejectedFingerprint(): string {
  try {
    const raw = Storage.get<string>(ACTIVATION_REJECTION_KEY, { shared: true });
    if (typeof raw !== "string" || !raw) return "";
    const stored = JSON.parse(raw) as { schema?: unknown; key?: unknown };
    const key = typeof stored?.key === "string" ? stored.key : "";
    return stored?.schema === 1 && ACTIVATION_PATTERN.test(key) ? key : "";
  } catch {
    return "";
  }
}

/**
 * Records the Worker's answer about the activation of the key a request carried (user decision
 * 2026-09-27: the settings page shows only "activated on another device"). 403
 * key_activated_elsewhere marks that exact key; a 2xx proves it works here and a 401 unauthorized
 * means it no longer exists, so both clear the mark. A delayed answer for a key that has since been
 * replaced never marks or clears the new one.
 */
export function recordScriptingActivationOutcome(
  token: string,
  status: number,
  gatewayCode: string,
): void {
  try {
    const fingerprint = keyFingerprint(token);
    if (status === 403 && gatewayCode === "key_activated_elsewhere") {
      if (readRejectedFingerprint() !== fingerprint) {
        Storage.set(
          ACTIVATION_REJECTION_KEY,
          JSON.stringify({ schema: 1, key: fingerprint }),
          { shared: true },
        );
      }
      return;
    }
    const cleared = (status >= 200 && status < 300) ||
      (status === 401 && gatewayCode === "unauthorized");
    if (cleared && readRejectedFingerprint() === fingerprint) {
      Storage.remove(ACTIVATION_REJECTION_KEY, { shared: true });
    }
  } catch {
    /* the notice is advisory; the request result is unchanged */
  }
}

/** Whether the Worker last refused the currently saved Access Key as activated elsewhere. */
export function savedKeyActivatedElsewhere(): boolean {
  try {
    const credentials = loadGatewayCredentials();
    const rejected = readRejectedFingerprint();
    return Boolean(credentials && rejected && rejected === keyFingerprint(credentials.token));
  } catch {
    return false;
  }
}
