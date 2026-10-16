import assert from "node:assert/strict";

const root = "/group/pipi-deliveries";
const tokenShared = "pipi_deliveries_scripting_token_shared_v1";
const activationShared = "pipi_deliveries_scripting_activation_shared_v1";
const shared = new Map<string, unknown>([[tokenShared, "SYNTHETIC_TOKEN"],
  [activationShared, "SYNTHETIC_ACTIVATION"], ["unrelated", "keep"]]);
const files = new Set<string>();
const directories = new Set<string>();
let rootAvailable = true;
let rejectOne = "";
let ignoreOne = "";
let reads = 0;
const removals: string[] = [];
Object.assign(globalThis, {
  Path: { join: (...parts: string[]) => parts.join("/") },
  Storage: {
    get: () => null,
    remove(key: string, options?: { shared: boolean }) {
      assert.deepEqual(options, { shared: true });
      if (key === rejectOne) throw new Error("synthetic remove failure");
      shared.delete(key);
    },
  },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    existsSync: (path: string) => {
      if (!rootAvailable) throw new Error("synthetic directory unavailable");
      return path === root || files.has(path) || directories.has(path);
    },
    readDirectorySync(path: string, recursive: boolean) {
      assert.equal(path, root); assert.equal(recursive, false);
      return [...files, ...directories];
    },
    isFileSync: (path: string) => files.has(path),
    readAsStringSync() { reads++; assert.fail("legacy plaintext must never be read"); },
    removeSync(path: string) {
      removals.push(path);
      if (path === rejectOne) throw new Error("synthetic remove failure");
      if (path !== ignoreOne) files.delete(path);
    },
  },
});
const { removeLegacyCredentialCopies: removeCopies } = await import("../services/legacy-credential-cleanup");
function removeLegacyCredentialCopies(): void { removeCopies("token"); removeCopies("activation"); }
const owned: string[] = [];
for (const stem of ["gateway-credential-v1.json", "scripting-activation-v1.json"]) {
  for (const suffix of ["", ".backup", ".pending-1790000000-a12", ".rollback-1790000000-a12",
    ".backup.pending-1790000000-a12", ".backup.rollback-1790000000-a12"]) {
    owned.push(`${root}/${stem}${suffix}`);
  }
}
const unrelated = ["state-v1.json", "gateway-credential-v1.json.notes", "scripting-activation-v1.json.old",
  "scripting-activation-v1.json.pending-other", "carrier-authority-v1.json"].map((name) => `${root}/${name}`);
for (const path of [...owned, ...unrelated]) files.add(path);
removeLegacyCredentialCopies();
assert.deepEqual([...files].sort(), unrelated.sort());
assert.deepEqual([...shared], [["unrelated", "keep"]]);
assert.deepEqual(removals.sort(), owned.sort());
assert.equal(reads, 0);

// Every failed item is retried independently; no directory or unrelated business data is removed.
files.add(owned[0]); files.add(owned[1]);
rejectOne = owned[0];
directories.add(`${root}/scripting-activation-v1.json`);
const removalsBeforeDirectory = removals.length;
removeLegacyCredentialCopies();
assert.equal(files.has(owned[0]), true); assert.equal(files.has(owned[1]), false);
assert.equal(removals.slice(removalsBeforeDirectory).includes(`${root}/scripting-activation-v1.json`), false);
assert.equal(directories.size, 1);
rejectOne = "";
removeLegacyCredentialCopies(); assert.equal(files.has(owned[0]), false);

// A native remove that returns without removing the file is not memoized as complete.
files.add(owned[0]); ignoreOne = owned[0];
removeLegacyCredentialCopies(); assert.equal(files.has(owned[0]), true);
ignoreOne = ""; removeLegacyCredentialCopies(); assert.equal(files.has(owned[0]), false);

// Unavailable App Group storage never prevents cleanup of the other shared store.
shared.set(tokenShared, "SYNTHETIC_TOKEN"); shared.set(activationShared, "SYNTHETIC_ACTIVATION");
rootAvailable = false; rejectOne = tokenShared;
removeLegacyCredentialCopies(); assert.equal(shared.has(tokenShared), true);
assert.equal(shared.has(activationShared), false);
rootAvailable = true; rejectOne = "";
removeLegacyCredentialCopies(); assert.equal(shared.has(tokenShared), false);
assert.equal(reads, 0);
assert.deepEqual([...files].sort(), unrelated.sort());
console.log("legacy credential metadata-only cleanup tests passed");
