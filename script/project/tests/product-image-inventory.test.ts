import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = stripTypeScriptTypes(readFileSync(new URL("../services/product-image-cache.ts", import.meta.url), "utf8"), { mode: "transform" })
  .replace(/^import .*\n/gm, "").replace(/^export /gm, "");
const root = "/group/pipi-deliveries/product-images";
const key = "a".repeat(64);
const image = `${key}.100-old.img`;
const existing = `${"b".repeat(64)}.100-old`;
const now = 100_000;
const pendingOld = `${key}.100-write.img.pending-${now - 20_001}-old`;
const pendingBoundary = `${key}.100-write.img.pending-${now - 20_000}-boundary`;
const pendingFuture = `${key}.100-write.img.pending-${now + 1}-future`;
const files = new Set([image, `${existing}.img`, `${existing}.deleted`, pendingOld, pendingBoundary, pendingFuture]);
let reads = 0;
const prune = runInNewContext(`${source}\npruneProductImages;`, {
  Map, Set, Date, Math,
  Path: { join: (...parts: string[]) => parts.join("/") },
  Crypto: { sha256: () => ({ toHexString: () => key }) },
  utf8Data: (value: string) => value,
  writeDiagnostic: () => {},
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    readDirectorySync: () => { reads++; return [...files].map(name => `${root}/${name}`); },
    writeAsStringSync: (path: string) => files.add(path.slice(root.length + 1)),
    existsSync: (path: string) => files.has(path.slice(root.length + 1)),
    removeSync: (path: string) => { files.delete(path.slice(root.length + 1)); },
  },
});
prune([{ id: "synthetic-removed" }], [], now);
assert.equal(reads, 1, "one prune operation inventories the directory once");
assert.equal(files.has(image), false);
assert.equal(files.has(image.replace(/\.img$/, ".deleted")), false, "fresh deletion markers replay in the same prune");
assert.equal(files.has(`${existing}.img`), false);
assert.equal(files.has(`${existing}.deleted`), false);
assert.equal(files.has(pendingOld), false);
assert.equal(files.has(pendingBoundary), true);
assert.equal(files.has(pendingFuture), true);
console.log("product image inventory tests passed");
