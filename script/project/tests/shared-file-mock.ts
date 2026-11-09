import { createHash, randomUUID } from "node:crypto";

/** Adds exclusive directory/link operations to the synthetic native bridge. */
export function installSharedFileMock(memory: Map<string, unknown>): void {
  const native = (globalThis as any).FileManager || { appGroupDocumentsDirectory: "/group" };
  const isJournal = (path: string) => path.includes("/transactions-v1") || path.includes("/diagnostics-v2");
  const parent = (path: string) => path.slice(0, path.lastIndexOf("/"));
  const exists = (path: string) => ["dir:", "link:", "file:"].some(prefix => memory.has(prefix + path));
  const delegate = (method: string, implementation: (...args: any[]) => any) => (...args: any[]) =>
    isJournal(args[0]) ? implementation(...args) : native[method]?.(...args);
  Object.assign(globalThis, {
    UUID: (globalThis as any).UUID || { string: randomUUID },
    Data: (globalThis as any).Data || { fromRawString: (s: string) => s },
    Crypto: (globalThis as any).Crypto?.sha256 ? (globalThis as any).Crypto : { sha256: (s: string) => ({ toHexString: () => createHash("sha256").update(s).digest("hex") }) },
    FileManager: {
      ...native,
      createDirectorySync: delegate("createDirectorySync", (path: string, recursive: boolean) => {
        if (recursive) { memory.set("dir:" + path, true); return; }
        if (exists(path) || !memory.has("dir:" + parent(path))) throw new Error("mkdir rejected");
        memory.set("dir:" + path, true);
      }),
      existsSync: delegate("existsSync", exists),
      isLinkSync: (path: string) => memory.has("link:" + path),
      createLinkSync(path: string, target: string) {
        if (exists(path) || !memory.has("dir:" + parent(path))) throw new Error("link rejected");
        memory.set("link:" + path, target);
      },
      destinationOfSymbolicLink(path: string) {
        if (!memory.has("link:" + path)) throw new Error("missing link");
        return memory.get("link:" + path);
      },
      readDirectorySync(path: string, recursive?: boolean) {
        if (!isJournal(path) && native.readDirectorySync) return native.readDirectorySync(path, recursive);
        return [...memory.keys()].map(key => key.slice(key.indexOf(":") + 1))
          .filter(name => parent(name) === path).map(name => name.slice(path.length + 1));
      },
      readAsStringSync: delegate("readAsStringSync", (path: string) => {
        if (!path.includes("/diagnostics-v2") && native.readAsStringSync) return native.readAsStringSync(path);
        if (!memory.has("file:" + path)) throw new Error("missing file");
        return memory.get("file:" + path);
      }),
      writeAsStringSync: delegate("writeAsStringSync", (path: string, value: string) => {
        if (!memory.has("dir:" + parent(path))) throw new Error("missing parent");
        if (!path.includes("/diagnostics-v2") && native.writeAsStringSync) native.writeAsStringSync(path, value);
        else memory.set("file:" + path, value);
      }),
      renameSync: delegate("renameSync", (path: string, target: string) => {
        if (!exists(path) || exists(target) || !memory.has("dir:" + parent(target))) throw new Error("rename rejected");
        for (const key of [...memory.keys()]) {
          const name = key.slice(key.indexOf(":") + 1);
          if (name === path || name.startsWith(path + "/")) {
            const value = memory.get(key);
            memory.delete(key);
            memory.set(key.slice(0, key.indexOf(":") + 1) + target + name.slice(path.length), value);
          }
        }
      }),
      removeSync: delegate("removeSync", (path: string) => {
        for (const key of memory.keys()) {
          const name = key.slice(key.indexOf(":") + 1);
          if (name === path || name.startsWith(path + "/")) memory.delete(key);
        }
      }),
    },
  });
}
