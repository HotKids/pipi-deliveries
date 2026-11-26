/**
 * Reads optional local state where a throw has no caller to catch it: a render body, a state initializer, an effect
 * or an error handler (G-MED-20, 2026-11-20 review). A failed Keychain or storage read answers `fallback`, and the
 * caller proceeds as if the value were absent.
 */
export function safeRead<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}
