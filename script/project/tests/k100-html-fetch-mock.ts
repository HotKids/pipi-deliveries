import assert from "node:assert/strict";

// Existing extraction tests keep their synthetic WebView; the native HTML fetch is separate.
Object.assign(globalThis, { fetch: async (url: string) => {
  assert.match(url, /^https:\/\/m\.kuaidi100\.com\/app\/query\/\?nu=[A-Z0-9]+$/);
  return { status: 200, url, mimeType: "text/html", async text() { return "<!doctype html><main id=main></main>"; } };
} });
