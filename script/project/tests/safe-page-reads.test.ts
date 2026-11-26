import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { safeRead } from "../services/safe-read";

// G-MED-20 (2026-11-20 review): a Keychain or storage read in a render body, a state initializer, an effect or an
// error handler has no caller to catch it, so a failure there ended the page or the Scripting session. Those reads
// go through safeRead and answer a fallback.
assert.equal(safeRead(() => 3, 0), 3);
assert.equal(safeRead(() => { throw new Error("Synthetic keychain failure"); }, "fallback"), "fallback");

const page = (name: string) => readFileSync(new URL(`../pages/${name}`, import.meta.url), "utf8");
const identity = page("StationIdentityPage.tsx");
assert.match(identity, /useState\(\(\) => safeRead\(\(\) => platformSession\(platform\)\?\.generation, undefined\)\)/);
assert.match(identity, /safeRead\(\(\) => platform === "cainiao" && Storage\.get<boolean>\(CAINIAO_OUTBOUND_PREFERENCE\) === true, false\)/);
assert.match(identity, /const next = safeRead\(\(\) => platformSession\(platform\)\?\.generation, undefined\);/);
assert.match(identity, /safeRead\(\(\) => Storage\.set\(CAINIAO_OUTBOUND_PREFERENCE, !outbound\), false\);/);
assert.match(identity, /const currentSession = \(\) => safeRead\(\(\) => currentPlatformSession\(platform, expectedGeneration\), null\);/);
assert.doesNotMatch(identity, /(?<!safeRead\(\(\) => )platformSession\(platform\)\?\.generation/, "no bare session read");

const pickup = page("PickupPage.tsx");
assert.match(pickup, /const shownQr = mealQr && mealQrCard \? safeRead\(\(\) => mealCredentialScope\(\) === mealQr\.scope\s*\? currentMeal\(readMeals\(mealQr\.scope\), mealQr\.id\) : undefined, undefined\) : undefined;/);

const settings = page("SettingsPage.tsx");
assert.doesNotMatch(settings, /\.\.\.diagnosticState\(loadState\(\)\)/, "an error handler cannot throw while it logs");
assert.match(settings, /\.\.\.safeRead\(\(\) => diagnosticState\(loadState\(\)\), \{\}\)/);
console.log("page reads with no caller to catch them are contained");
