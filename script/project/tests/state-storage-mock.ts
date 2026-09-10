import { createHash } from "node:crypto";
const NOW = Date.UTC(2026, 8, 8, 6, 0, 0);
const memory = new Map<string, unknown>();

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

Object.assign(globalThis, {
  Path: {
    join(...parts: string[]) {
      return parts.join("/").replace(/\/{2,}/g, "/");
    },
  },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    createDirectorySync() {},
    existsSync(path: string) {
      return memory.has(`file:${path}`);
    },
    isFileSync(path: string) {
      return memory.has(`file:${path}`);
    },
    readAsStringSync(path: string) {
      const value = memory.get(`file:${path}`);
      if (typeof value !== "string") throw new Error("missing file");
      return value;
    },
    removeSync(path: string) {
      memory.delete(`file:${path}`);
    },
    renameSync(path: string, newPath: string) {
      const key = `file:${path}`;
      const destination = `file:${newPath}`;
      const value = memory.get(key);
      if (typeof value !== "string" || memory.has(destination)) {
        throw new Error("rename rejected");
      }
      memory.set(destination, value);
      memory.delete(key);
    },
    writeAsStringSync(path: string, value: string) {
      memory.set(`file:${path}`, value);
    },
  },
  Data: {
    fromIntArray(value: number[]) {
      return String.fromCharCode(...value);
    },
    fromString(value: string) {
      return value;
    },
    fromRawString(value: string) {
      return value;
    },
  },
  Crypto: {
    sha256(value: string) {
      const hex = sha256(value);
      return { toHexString: () => hex };
    },
  },
  Storage: {
    get<T>(key: string): T | null {
      return (memory.get(key) as T | undefined) ?? null;
    },
    set(key: string, value: unknown): boolean | void {
      memory.set(key, structuredClone(value));
      return true;
    },
  },
  Keychain: {
    get(key: string): string | null {
      return (memory.get(`keychain:${key}`) as string | undefined) ?? null;
    },
    set(key: string, value: string): boolean {
      memory.set(`keychain:${key}`, value);
      return true;
    },
    remove(key: string): void {
      memory.delete(`keychain:${key}`);
    },
  },
});


export { memory, NOW, sha256 };
