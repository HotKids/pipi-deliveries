import { removeLegacyCredentialCopies } from "./legacy-credential-cleanup";
import { loadGatewayCredentials } from "./credentials";
import { utf8Data } from "./scripting-data";
import { writeDiagnostic } from "./logger";

/**
 * The dedicated 32-byte activation identity lives only in this script's synchronized
 * Keychain. It is separate from the interface-5 identity forwarded to Xiaomi.
 * A replaced script scope requires a newly issued Access Key; shared plaintext is
 * deleted without restoring it. Gateway v2 sends its existing domain-separated digest in the
 * same header and authenticates that digest in the request MAC.
 */
export const SCRIPTING_ACTIVATION_HEADER = "X-Scripting-Activation";

const ACTIVATION_KEYCHAIN_KEY = "pipi_deliveries_scripting_activation_v1";
const ACTIVATION_REJECTION_KEY = "pipi_deliveries_scripting_activation_rejected_v1";
// Scripting requires the same synchronization option for every operation on an item.
const SYNCED_KEYCHAIN = { synchronizable: true } as const;
const ACTIVATION_PATTERN = /^[0-9a-f]{64}$/;
export type ScriptingActivationSource = "synced_keychain" | "generated";

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
function readSyncedKeychain(): string {
  return validActivation(Keychain.get(ACTIVATION_KEYCHAIN_KEY, SYNCED_KEYCHAIN));
}
function generateActivation(): string {
  return [0, 1].map(() => Crypto.generateSymmetricKey(128).toHexString().toLowerCase()).join("");
}
const reportedOutcomes = new Set<string>();
export function resetScriptingActivationProcessState(): void {
  reportedOutcomes.clear();
}
function report(result: ScriptingActivationSource): void {
  if (reportedOutcomes.has(result)) return;
  reportedOutcomes.add(result);
  writeDiagnostic("gateway.activation.resolved", {
    stage: "activation_identity", result, persisted: true,
  }, "info");
}

/** Returns only an identity confirmed in Keychain before a request can carry it. */
export function loadScriptingActivation(generate: () => string = generateActivation): string {
  removeLegacyCredentialCopies("activation");
  try {
    const synced = readSyncedKeychain();
    if (synced) { report("synced_keychain"); return synced; }
    const generated = validActivation(generate());
    if (!generated) throw new ScriptingActivationUnavailableError();
    const saved = Keychain.set(ACTIVATION_KEYCHAIN_KEY, generated, SYNCED_KEYCHAIN);
    // Another runtime may have installed a different identity. Read the protected
    // authority again and adopt it rather than sending an unconfirmed generated value.
    const current = readSyncedKeychain();
    if (current) {
      report(saved !== false && current === generated ? "generated" : "synced_keychain");
      return current;
    }
  } catch {
    /* A Keychain failure cannot fall back to a cross-script plaintext copy. */
  }
  writeDiagnostic("gateway.activation.failed", {
    stage: "activation_identity", result: "save_failed",
  }, "error");
  throw new ScriptingActivationUnavailableError();
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
