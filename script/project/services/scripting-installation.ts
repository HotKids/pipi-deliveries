import { sharedData } from "./shared-file-transaction";

/** The shared installation digest scriptingInstallationDigest commits: 64 lowercase hex characters. */
const INSTALLATION_DIGEST = /^[0-9a-f]{64}$/;

/**
 * Whether a gateway request on this device already committed the shared installation digest. Only a request
 * that carried an Access Key creates it, and it lives in the App Group, so it outlasts one script copy's
 * Keychain scope. This read never creates the digest. It lives apart from scripting-activation so the
 * credential store can ask it without importing the activation module, which imports the store.
 */
export function scriptingInstallationRecorded(): boolean {
  try {
    const current = sharedData().scriptingInstallation;
    return typeof current === "string" && INSTALLATION_DIGEST.test(current);
  } catch {
    return false;
  }
}
