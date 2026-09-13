import * as fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export function installNativeSharedFiles(root: string, beforeLink = (_path: string) => {}, afterLink = (_path: string) => {}): void {
  const memory = new Map<string, unknown>();
  Object.assign(globalThis, {
    Path: { join: path.join },
    FileManager: {
      appGroupDocumentsDirectory: root,
      createDirectorySync: (p: string, recursive: boolean) => fs.mkdirSync(p, { recursive }),
      existsSync: fs.existsSync,
      isFileSync: (p: string) => fs.statSync(p).isFile(),
      isLinkSync: (p: string) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (e: any) { if (e.code === "ENOENT") return false; throw e; } },
      readAsStringSync: (p: string) => fs.readFileSync(p, "utf8"),
      writeAsStringSync: (p: string, value: string) => {
        if (process.env.PIPI_ATOMIC_BASELINE && /state-v3-[ab]\.json\.pending-/.test(p)) beforeLink("legacy/next");
        fs.writeFileSync(p, value);
      },
      readDirectorySync: (p: string) => fs.readdirSync(p),
      createLinkSync: (p: string, target: string) => { beforeLink(p); fs.symlinkSync(target, p); afterLink(p); },
      destinationOfSymbolicLink: fs.readlinkSync,
      removeSync: (p: string) => fs.rmSync(p, { recursive: true }),
      renameSync: fs.renameSync,
    },
    Data: { fromRawString: (s: string) => s },
    Crypto: { sha256: (s: string) => ({ toHexString: () => createHash("sha256").update(s).digest("hex") }) },
    Storage: {
      get(k: string) {
        const p = path.join(root, "storage-" + createHash("sha256").update(k).digest("hex"));
        const value = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
        if (process.env.PIPI_ATOMIC_BASELINE && k === "pipi_deliveries_refresh_runtime_v1") beforeLink("legacy/next");
        return value;
      },
      set(k: string, value: unknown) {
        const p = path.join(root, "storage-" + createHash("sha256").update(k).digest("hex"));
        const temporary = p + "." + Math.random();
        fs.writeFileSync(temporary, JSON.stringify(value));
        fs.renameSync(temporary, p);
        return true;
      },
    },
    Keychain: { get: (k: string) => memory.get(k) ?? null, set: (k: string, v: unknown) => { memory.set(k, v); return true; }, remove: (k: string) => memory.delete(k) },
  });
}
