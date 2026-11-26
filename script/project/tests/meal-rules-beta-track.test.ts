import assert from "node:assert/strict";
import { register } from "node:module";
import { installSharedFileMock } from "./shared-file-mock";

// N3 (2026-11-21): only the formal Worker serves the meal rule pack and the meal record routes. A beta build has no
// meal scope, like activeWatchScope, so a saved Access Key no longer makes every meal pull ask the carrier route for
// rules that never come, and the carrier refresh asks for the table only.

const files = new Map<string, string>();
const memory = new Map<string, unknown>();
const keychain = new Map<string, string>();
Object.assign(globalThis, {
  Storage: {
    get: (key: string) => memory.get(key) ?? null,
    set: (key: string, value: unknown) => { memory.set(key, structuredClone(value)); return true; },
    remove: (key: string) => { memory.delete(key); },
  },
  Path: { join: (...parts: string[]) => parts.join("/").replace(/\/+/g, "/") },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    existsSync: (path: string) => files.has(path),
    isFileSync: (path: string) => files.has(path),
    readDirectorySync: () => [],
    readAsStringSync: (path: string) => files.get(path) || "",
    createDirectorySync: () => {},
    writeAsStringSync: (path: string, value: string) => files.set(path, value),
    renameSync: (from: string, to: string) => {
      const value = files.get(from);
      if (value == null) throw new Error("missing source");
      files.delete(from);
      files.set(to, value);
    },
    removeSync: (path: string) => files.delete(path),
  },
  Keychain: {
    get: (name: string) => keychain.get(name),
    set: (name: string, value: string) => { keychain.set(name, value); return true; },
    remove: (name: string) => keychain.delete(name),
  },
});
installSharedFileMock(memory);

// Modules imported with `?track=beta` (and everything they import) see a beta build-track.ts; the checked-in
// formal build stays as it is for the plain imports.
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ? new URL(context.parentURL) : null;
  const track = parent && parent.protocol === "file:" ? parent.searchParams.get("track") : null;
  if (!track || !specifier.startsWith(".")) return nextResolve(specifier, context);
  if (/(^|\\/)build-track(\\.ts)?$/.test(specifier)) {
    const source = "export const SCRIPT_BUILD_TRACK = " + JSON.stringify(track) + ";" +
      "export const SCRIPT_VERSION = \\"0.0.1-beta1\\";export const SCRIPT_CLIENT_BUILD = 1;" +
      "export const GATEWAY_ORIGIN = \\"https://example.invalid\\";" +
      "export const SCRIPTING_GATEWAY_PROTOCOL_VERSION = \\"2\\";";
    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) };
  }
  const resolved = await nextResolve(specifier, context);
  if (!resolved.url.startsWith("file:")) return resolved;
  const url = new URL(resolved.url);
  url.searchParams.set("track", track);
  return { ...resolved, url: url.href };
}
`)}`);

const formalRules = await import("../services/meal/rules");
const formalCredentials = await import("../services/credentials");
const beta = await import("../services/carrier-authority.ts?track=beta") as typeof import("../services/carrier-authority");
const betaRules = await import("../services/meal/rules.ts?track=beta") as typeof import("../services/meal/rules");
const betaCredentials = await import("../services/credentials.ts?track=beta") as typeof import("../services/credentials");

formalCredentials.saveGatewayToken("AAAAAAAAAAAAAAAA");
assert.notEqual(formalRules.mealCredentialScope(), "", "fixture premise: the formal build has a meal scope for the key");
assert.equal(betaCredentials.gatewayCredentialStatus(), "configured", "fixture premise: the beta build reads the same key");
assert.equal(betaRules.mealCredentialScope(), "", "a beta build has no meal scope");

const requests: string[] = [];
const answer = {
  post: async (route: string, body: { includeMealRules?: true }) => {
    assert.equal(route, "/api/express/carriers");
    requests.push(body.includeMealRules ? "with_rules" : "table_only");
    throw new Error("synthetic beta Worker answer without meal rules");
  },
};
beta.resetCarrierAuthorityRuntimeForTesting();
for (let pull = 0; pull < 5; pull++) {
  assert.equal(await beta.ensureMealRules("meal_sync", answer), null);
  assert.equal(await beta.ensureMealRules("meal_sync", { ...answer, explicit: true }), null);
}
assert.deepEqual(requests, [], "beta meal pulls, explicit or automatic, never ask the carrier route for rules");
assert.equal(beta.cachedMealRules(), null);
assert.equal(await beta.refreshCarrierAuthorityIfNeeded(Date.now(), answer), false);
assert.deepEqual(requests, ["table_only"], "the beta carrier refresh asks for the table only");
console.log("meal rules stay on the formal track checks passed");
