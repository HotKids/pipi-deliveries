import { gatewayAccessKeyState, subscribeGatewayAccessKeyState } from "./credentials";
import { scriptingInstallationRecorded } from "./scripting-activation";

/**
 * The Access Key notice on Home. `rejected`: the Worker answered 401 for the saved key. `missing` and `conflict`
 * (owner decision, 2026-11-21: 首页提醒): this script copy cannot read a key, for example after a replaced
 * Keychain scope, and meal codes and queries stop until the key is entered again in Settings.
 */
export type AccessKeyReminder = "rejected" | "missing" | "conflict";

/**
 * A missing key is reminded only when one was in use before: the App Group still holds the installation
 * digest that a keyed gateway request committed, or this Keychain scope holds a record that no longer
 * decodes. A first run without a key keeps Home as it was, and a key removed in Settings is not reminded.
 * An unreadable record is always reminded.
 */
export function accessKeyReminder(): AccessKeyReminder | null {
  try {
    const { status, verification, missing } = gatewayAccessKeyState();
    if (status === "configured") return verification === "rejected" ? "rejected" : null;
    if (status !== "missing") return "conflict";
    if (missing === "removed") return null;
    return missing === "invalid" || scriptingInstallationRecorded() ? "missing" : null;
  } catch {
    return null;
  }
}

/**
 * Calls `listener` with the current reminder once after subscribing, which covers a change since the first
 * render, and after each change to the saved key or its verification. The check runs on a later turn, once
 * per burst of changes, so a gateway reply or a save never waits for it.
 */
export function subscribeAccessKeyReminder(listener: (reminder: AccessKeyReminder | null) => void): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (active) listener(accessKeyReminder());
    }, 0);
  };
  const unsubscribe = subscribeGatewayAccessKeyState(schedule);
  schedule();
  return () => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
  };
}
