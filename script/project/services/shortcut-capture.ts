// The first invocation opts in only when its Shortcut is ready to capture again on this result.
export const LUCKIN_RESCAN = "pipi.luckin.rescan";
export const SCREEN_SHORTCUT_VERSION = 1;
export const SCREEN_SHORTCUT_INSTALL_URL = "https://www.icloud.com/shortcuts/0fdf5d41f11845538b0e549aed734a02";

export function screenShortcutVersion(texts: readonly string[]): number | undefined {
  const prefix = `${LUCKIN_RESCAN}@`;
  const version = texts.find(value => value.startsWith(prefix))?.slice(prefix.length);
  return version && /^\d{1,6}$/.test(version) ? Number(version) : undefined;
}
