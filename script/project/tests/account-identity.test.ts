import assert from "node:assert/strict";
import {
  generateInterface5Identity,
  isInterface5Identity,
  loadAccountIdentity,
  resolveInterface5Identity,
  type IdentityStore,
} from "../services/account-identity";
import { createHash } from "node:crypto";

const keychain = new Map<string, string>();
const files = new Map<string, string>();
const shared = new Map<string, unknown>();

Object.assign(globalThis, {
  Data: {
    fromIntArray(value: number[]) {
      return String.fromCharCode(...value);
    },
    fromRawString(value: string) {
      return value;
    },
  },
  Crypto: {
    sha256(value: string) {
      const hex = createHash("sha256").update(value).digest("hex");
      return { toHexString: () => hex };
    },
  },
  Path: {
    join(...parts: string[]) {
      return parts.join("/").replace(/\/{2,}/g, "/");
    },
  },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    createDirectorySync() {},
    existsSync(path: string) {
      return files.has(path);
    },
    isFileSync(path: string) {
      return files.has(path);
    },
    readAsStringSync(path: string) {
      const value = files.get(path);
      if (value == null) throw new Error("missing file");
      return value;
    },
    removeSync(path: string) {
      files.delete(path);
    },
    renameSync(path: string, newPath: string) {
      const value = files.get(path);
      if (value == null || files.has(newPath)) throw new Error("rename rejected");
      files.set(newPath, value);
      files.delete(path);
    },
    writeAsStringSync(path: string, value: string) {
      files.set(path, value);
    },
  },
  Keychain: {
    get(key: string) {
      return keychain.get(key) || null;
    },
    set(key: string, value: string) {
      keychain.set(key, value);
      return true;
    },
  },
  Storage: {
    get<T>(key: string): T | null {
      return (shared.get(key) as T | undefined) ?? null;
    },
    set(key: string, value: unknown): boolean {
      shared.set(key, structuredClone(value));
      return true;
    },
  },
});

function deterministic(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

const v5 = generateInterface5Identity(deterministic);
assert.deepEqual(v5, {
  userId: "0123456789",
  oaid: "0a0b0c0d0e0f1011",
  vaid: "1213141516171819",
});
assert.equal(isInterface5Identity(v5), true);
assert.equal(isInterface5Identity({ ...v5, oaid: "ABCDEF0123456789" }), false);

const values = new Map<string, string>();
const store: IdentityStore = {
  read: (key) => values.get(key) || "",
  write: (key, value) => {
    values.set(key, value);
    return true;
  },
};
const storedV5 = resolveInterface5Identity(store, deterministic);
assert.deepEqual(resolveInterface5Identity(store, () => [255]), storedV5);

assert.throws(
  () => resolveInterface5Identity({ read: () => "", write: () => false }, deterministic),
  /could not be saved/,
);

// The installation identity survives replacement of the per-script Keychain namespace.
keychain.set(
  "pipi_deliveries_account_v5_identity_v1",
  JSON.stringify(v5),
);
assert.deepEqual(loadAccountIdentity("interface5"), v5);
keychain.clear();
assert.deepEqual(loadAccountIdentity("interface5"), v5);
files.set(
  "/group/pipi-deliveries/account-identity-v1.json",
  "corrupted-primary",
);
keychain.clear();
assert.deepEqual(loadAccountIdentity("interface5"), v5);

// A replacement script can restore the exact installation identity from shared Storage even
// when its per-script Keychain and durable file namespace are unavailable.
files.clear();
keychain.clear();
assert.deepEqual(loadAccountIdentity("interface5"), v5);
assert.equal(files.has("/group/pipi-deliveries/account-identity-v1.json"), true);

// The verified App Group file remains canonical when an older shared mirror disagrees.
const other = generateInterface5Identity((count) =>
  Array.from({ length: count }, (_, index) => 255 - index),
);
const otherPayload = JSON.stringify(other);
shared.set("pipi_deliveries_account_v5_identity_shared_v1", JSON.stringify({
  schema: 1,
  checksum: createHash("sha256").update(otherPayload).digest("hex"),
  payload: otherPayload,
}));
assert.deepEqual(loadAccountIdentity("interface5"), v5);

console.log("account identity tests passed");
