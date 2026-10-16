import { Path } from "scripting";
import { writeDiagnostic } from "./logger";

type CredentialKind = "token" | "activation";
const LEGACY_SHARED_KEY: Record<CredentialKind, string> = {
  token: "pipi_deliveries_scripting_token_shared_v1",
  activation: "pipi_deliveries_scripting_activation_shared_v1",
};
const LEGACY_FILE: Record<CredentialKind, RegExp> = {
  token: /^gateway-credential-v1\.json(?:\.backup)?(?:\.(?:pending|rollback)-[0-9]+-[a-z0-9]*)?$/,
  activation: /^scripting-activation-v1\.json(?:\.backup)?(?:\.(?:pending|rollback)-[0-9]+-[a-z0-9]*)?$/,
};
let failureReported = false;

/** Removes only former credential replicas, without loading their plaintext. */
export function removeLegacyCredentialCopies(kind: CredentialKind): void {
  let failed = false;
  try { Storage.remove(LEGACY_SHARED_KEY[kind], { shared: true }); }
  catch { failed = true; }
  try {
    const root = Path.join(FileManager.appGroupDocumentsDirectory, "pipi-deliveries");
    if (FileManager.existsSync(root)) {
      for (const entry of FileManager.readDirectorySync(root, false)) {
        const name = entry.split("/").pop()!;
        if (!LEGACY_FILE[kind].test(name)) continue;
        const path = Path.join(root, name);
        try {
          if (!FileManager.isFileSync(path)) { failed = true; continue; }
          FileManager.removeSync(path);
          if (FileManager.existsSync(path)) failed = true;
        } catch { failed = true; }
      }
    }
  } catch { failed = true; }
  // Cleanup is retried on every access; an unavailable shared store must not disable
  // a valid private Keychain credential or become an alternate authority.
  if (failed && !failureReported) {
    writeDiagnostic("gateway.credential.cleanup", {
      stage: "credential_storage", result: "cleanup_failed",
    }, "warning");
  }
  failureReported = failed;
}
