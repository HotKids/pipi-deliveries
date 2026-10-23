import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const MAX_BYTES = 4 * 1024 * 1024;
const files = new Map<string, FakeData>();
let metadataReads = 0, bitmapReads = 0, bodyReads = 0, networkCalls = 0;
let appendedBytes = 0, cancelled = 0, failWrite = false, failRename = false;
let beforeWrite: (() => Promise<void>) | undefined;
let afterRename: (() => void) | undefined;
const events: string[] = [];

class FakeData {
  constructor(readonly bytes: Buffer) {}
  get size(): number { return this.bytes.length; }
  append(other: FakeData): void {
    appendedBytes += other.size;
    (this as { bytes: Buffer }).bytes = Buffer.concat([this.bytes, other.bytes]);
  }
}

const data = (kind = 1, size = 4) => {
  const bytes = Buffer.alloc(size);
  if (size) bytes[0] = kind;
  return new FakeData(bytes);
};
const nativeController = globalThis.AbortController;
const requested: Array<{ url: string; init: any }> = [];
let reply: {
  redirects?: string[];
  finalURL?: string;
  mime?: string;
  length?: string;
  expected?: number;
  chunks?: FakeData[];
  status?: number;
  pendingBody?: boolean;
  pendingFetch?: boolean;
} = {};

Object.assign(globalThis, {
  Data: {
    fromIntArray: (value: number[]) => new FakeData(Buffer.from(value)),
    fromRawString: (value: string) => new FakeData(Buffer.from(value)),
  },
  Crypto: { sha256: (value: FakeData) => ({ toHexString: () => createHash("sha256").update(value.bytes).digest("hex") }) },
  Path: { join: (...parts: string[]) => parts.join("/") },
  FileManager: {
    temporaryDirectory: "/synthetic-cache",
    appGroupDocumentsDirectory: "/synthetic-group",
    existsSync(path: string) { return files.has(path); },
    readDirectorySync(path: string) { return [...files.keys()].filter(file => file.startsWith(path + "/")); },
    writeAsStringSync(path: string, value: string) { files.set(path, new FakeData(Buffer.from(value))); },
    statSync(path: string) {
      const value = files.get(path);
      if (!value) throw new Error("synthetic cache miss");
      return { type: "file", size: value.size };
    },
    isLinkSync() { return false; },
    readAsDataSync(path: string) { return files.get(path)!; },
    async stat(path: string) {
      const value = files.get(path);
      if (!value) throw new Error("synthetic cache miss");
      return { type: "file", size: value.size };
    },
    async isLink() { return false; },
    async readAsData(path: string) { return files.get(path)!; },
    async createDirectory(path: string, recursive: boolean) {
      assert.ok(["/synthetic-cache/pipi-product-images", "/synthetic-group/pipi-deliveries/product-images"].includes(path));
      assert.equal(recursive, true);
    },
    async writeAsData(path: string, value: FakeData) {
      if (failWrite) throw new Error("synthetic cache denied");
      assert.match(path, /^\/(synthetic-cache\/pipi-product-images\/[a-f0-9]{64}|synthetic-group\/pipi-deliveries\/product-images\/[a-f0-9]{64}\.\d+-[a-z0-9]+)\.img\.pending-/);
      events.push("write-pending");
      files.set(path, value);
      await beforeWrite?.();
    },
    async rename(before: string, after: string) {
      if (failRename) throw new Error("synthetic publication denied");
      assert.ok(before.startsWith(after + ".pending-"));
      assert.ok(files.has(before));
      events.push("publish");
      files.set(after, files.get(before)!);
      files.delete(before);
    },
    renameSync(before: string, after: string) {
      if (failRename || files.has(after)) throw new Error("synthetic publication denied");
      assert.ok(before.startsWith(after + ".pending-"));
      files.set(after, files.get(before)!);
      files.delete(before);
      afterRename?.();
    },
    removeSync(path: string) { files.delete(path); },
    async remove(path: string) { files.delete(path); },
  },
  ImageIO: {
    async readMetadata(value: FakeData) {
      metadataReads++;
      events.push("metadata");
      switch (value.bytes[0]) {
        case 2: return { pixelWidth: 0, pixelHeight: 100 };
        case 3: return { pixelWidth: 5000, pixelHeight: 5000 };
        case 4: throw new Error("synthetic invalid image");
        case 5: return { pixelWidth: 100.5, pixelHeight: 100 };
        case 7: return { pixelWidth: 4096, pixelHeight: 4096 };
        case 8: return { pixelWidth: 4096, pixelHeight: 4097 };
        default: return { pixelWidth: 600, pixelHeight: 300 };
      }
    },
  },
  UIImage: {
    fromData(value: FakeData) {
      bitmapReads++;
      events.push("bitmap");
      return {
        width: 600, height: 300, scale: 1,
        preparingThumbnail(size: { width: number; height: number }) {
          assert.deepEqual(size, { width: 432, height: 432 });
          return { syntheticThumbnail: true, syntheticKind: value.bytes[0] };
        },
      };
    },
  },
  async fetch(url: string, init: any) {
    networkCalls++;
    requested.push({ url, init });
    assert.equal(init.timeout, 20);
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(init.headers, { Accept: "image/jpeg,image/png,image/webp,image/gif", "Accept-Encoding": "identity" });
    if (reply.pendingFetch) return new Promise(() => {});
    let finalURL = url;
    for (const target of reply.redirects || []) {
      const redirect = await init.handleRedirect({ url: target, method: "GET", cookies: [{ value: "discard-me" }],
        headers: { Cookie: "synthetic-only" }, body: data() });
      if (!redirect) return response(302, finalURL);
      assert.deepEqual(redirect.cookies, []);
      assert.equal(redirect.headers.Cookie, undefined);
      assert.equal(redirect.body, undefined);
      requested.push({ url: redirect.url, init: redirect });
      finalURL = redirect.url;
    }
    return response(reply.status || 200, reply.finalURL || finalURL);
  },
});

function response(status: number, url: string) {
  let index = 0;
  const headers = new Headers({ "content-type": reply.mime || "image/jpeg" });
  if (reply.length != null) headers.set("content-length", reply.length);
  return { status, ok: status >= 200 && status < 300, url, headers, expectedContentLength: reply.expected,
    dataStream: { getReader() { return {
      async read() {
        bodyReads++;
        if (reply.pendingBody) return new Promise(() => {});
        const value = (reply.chunks || [data()])[index++];
        return { done: !value, value };
      },
      async cancel() { cancelled++; },
      releaseLock() {},
    }; } } };
}

const { initialProductImage, loadProductImage } = await import("../services/product-images");
const { cachedProductImage, productImageCacheKey, productImageCacheFiles, rememberProductImage,
  pruneProductImages } = await import("../services/product-image-cache");
let sequence = 0;
const url = () => `https://img.jd.com/synthetic-${++sequence}.jpg`;
function reset(value: typeof reply = {}) {
  reply = value;
  requested.length = 0;
  metadataReads = bitmapReads = bodyReads = networkCalls = appendedBytes = cancelled = 0;
  failWrite = failRename = false;
  beforeWrite = afterRename = undefined;
  events.length = 0;
  files.clear();
}

for (const invalid of ["", "http://img.jd.com/a", "https://jd.com.evil.test/a", "https://eviljd.com/a",
  "https://jd.com:444/a", "https://user@jd.com/a", "https://@jd.com/a", "https://jd.com./a",
  "https://im\ng.jd.com/a", "https://jd.com\\@evil.test/a", "file:///synthetic.jpg"]) {
  reset();
  assert.equal(await loadProductImage(invalid), null);
  assert.equal(networkCalls, 0, "invalid initial URL never reaches the transport");
}
for (const valid of ["https://jd.com/a", "https://img.jd.com:443/a", "https://360buyimg.com/a", "https://a.360buyimg.com/a"]) {
  reset();
  assert.ok(await loadProductImage(valid));
  assert.deepEqual(events, ["metadata", "bitmap", "write-pending", "publish"]);
}

reset({ redirects: ["https://one.jd.com/1", "https://two.360buyimg.com/2", "https://jd.com/3", "https://360buyimg.com/4"] });
assert.ok(await loadProductImage(url()));
assert.equal(requested.length, 5, "the initial URL plus four allowed redirects");
for (const redirects of [["https://off-domain.test/a"], ["http://jd.com/a"], ["https://user@jd.com/a"],
  ["https://one.jd.com/1", "https://one.jd.com/1"],
  ["https://jd.com/1", "https://jd.com/2", "https://jd.com/3", "https://jd.com/4", "https://jd.com/5"]]) {
  reset({ redirects });
  assert.equal(await loadProductImage(url()), null);
  assert.equal(bitmapReads, 0);
  assert.ok(requested.length <= 5);
  assert.ok(requested.every(request => !request.url.includes("off-domain")));
}
reset({ finalURL: "https://off-domain.test/final" });
assert.equal(await loadProductImage(url()), null, "a transport that bypasses redirect validation is rejected");
reset({ finalURL: "https://other.jd.com/unobserved" });
assert.equal(await loadProductImage(url()), null, "the final URL must belong to this redirect chain");

for (const mime of ["image/jpeg", "image/png; charset=binary", "IMAGE/WEBP", "image/gif"]) {
  reset({ mime });
  assert.ok(await loadProductImage(url()));
}
for (const value of [{ mime: "text/html" }, { mime: "image/svg+xml" }, { status: 404 },
  { length: String(MAX_BYTES + 1) }, { length: "invalid" }, { expected: MAX_BYTES + 1 }]) {
  reset(value);
  assert.equal(await loadProductImage(url()), null);
  assert.equal(bodyReads, 0, "invalid status, type or length rejects before reading a body");
}
reset({ length: String(MAX_BYTES), chunks: [data(1, MAX_BYTES)] });
assert.ok(await loadProductImage(url()), "exactly four MiB is permitted");
reset({ chunks: [data(1, MAX_BYTES), data(1, 1)] });
assert.equal(await loadProductImage(url()), null);
assert.equal(appendedBytes, MAX_BYTES, "overflowing chunks are never appended");
assert.equal(bitmapReads, 0);
assert.equal(cancelled, 1);
reset({ chunks: [] });
assert.equal(await loadProductImage(url()), null);
for (const kind of [2, 3, 4, 5, 8]) {
  reset({ chunks: [data(kind)] });
  assert.equal(await loadProductImage(url()), null);
  assert.equal(bitmapReads, 0, "invalid dimensions or metadata never create a bitmap");
  assert.equal(files.size, 0);
}
reset({ chunks: [data(7)] });
assert.ok(await loadProductImage(url()), "exactly sixteen million binary pixels is permitted");

reset();
const cachedURL = url();
assert.ok(await loadProductImage(cachedURL));
const cachedFile = [...files.keys()][0];
assert.match(cachedFile, /^\/synthetic-cache\/pipi-product-images\/[a-f0-9]{64}\.img$/);
assert.ok(await loadProductImage(cachedURL));
assert.equal(networkCalls, 1, "a valid cached image needs no second request");
assert.equal(metadataReads, 2, "cached images are checked before bitmap creation too");
files.set(cachedFile, data(3));
assert.ok(await loadProductImage(cachedURL), "an invalid cache entry does not hide a valid download");
assert.equal(networkCalls, 2);
for (const field of ["failWrite", "failRename"]) {
  reset();
  if (field === "failWrite") failWrite = true;
  else failRename = true;
  assert.ok(await loadProductImage(url()), "a cache failure preserves a validated image");
  assert.equal(files.size, 0, "failed cache publications leave no pending files");
}

reset();
const preAborted = new nativeController();
preAborted.abort();
assert.equal(await loadProductImage(url(), preAborted.signal), null);
assert.equal(networkCalls, 0);
for (const pending of [{ pendingFetch: true }, { pendingBody: true }]) {
  reset(pending);
  const controller = new nativeController();
  const task = loadProductImage(url(), controller.signal);
  setTimeout(() => controller.abort(), 5);
  assert.equal(await task, null, "cancellation settles even if a native bridge never resolves");
  assert.equal(bitmapReads, 0);
  assert.equal(files.size, 0);
}
reset({ pendingBody: true });
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((callback: (...args: any[]) => void, delay: number, ...args: any[]) => {
  assert.equal(delay, 20_000);
  return realTimeout(callback, 5, ...args);
}) as typeof setTimeout;
try { assert.equal(await loadProductImage(url()), null, "the total operation has a finite deadline"); }
finally { globalThis.setTimeout = realTimeout; }

const identity = (id: string) => ({ id, bindingSource: "interface5", sourceId: "jingdong",
  phone: "13800000000", orderId: id, createdAtMs: 1 } as any);
const owner = (id: string) => ({ key: productImageCacheKey(identity(id)), isRetained: () => true });
for (const failure of ["write", "rename"] as const) {
  reset();
  let retained = true;
  const memoryOnlyOwner = { ...owner(`memory-only-${failure}`), isRetained: () => retained };
  if (failure === "write") failWrite = true;
  else failRename = true;
  const image = await loadProductImage(url(), undefined, memoryOnlyOwner);
  assert.ok(image, "a failed record-cache publication preserves its validated in-memory image");
  for (let tick = 0; tick < 30; tick++) await Promise.resolve();
  assert.equal(cachedProductImage(memoryOnlyOwner.key), image);
  assert.equal(productImageCacheFiles(memoryOnlyOwner.key).length, 0);
  retained = false;
  assert.equal(cachedProductImage(memoryOnlyOwner.key), null, "memory-only images remain fenced by the original owner lifecycle");
}
const evictImages = () => {
  for (let index = 0; index < 32; index++) rememberProductImage(`synthetic-eviction-${index}`, {} as UIImage);
};

reset({ chunks: [data(9)] });
const lifetime = owner("lifetime");
const firstImage = await loadProductImage(url(), undefined, lifetime);
assert.ok(firstImage);
const lifetimeFile = productImageCacheFiles(lifetime.key)[0]!;
assert.ok(files.has(lifetimeFile), "successful record images use persistent App Group storage");
assert.equal(productImageCacheKey({ ...identity("lifetime"), createdAtMs: 900, waybill: "REAL-WAYBILL",
  productImageURL: "https://img.jd.com/replacement.jpg" }), lifetime.key,
"account refresh and waybill projection keep the same image identity");
reply = { status: 503 };
assert.equal(await loadProductImage(url(), undefined, lifetime), firstImage,
  "a changed URL cannot replace the first successfully decoded record image");
assert.equal(await loadProductImage("", undefined, lifetime), firstImage, "missing metadata retains the image");
assert.equal(networkCalls, 1);
evictImages();
assert.equal(cachedProductImage(lifetime.key), null, "decoded memory is bounded");
const restored = await loadProductImage("", undefined, lifetime);
assert.equal((restored as any).syntheticKind, 9, "a new memory lifetime restores the persistent image without a URL");
assert.equal(networkCalls, 1);
evictImages();
const previousMetadataReads = metadataReads;
const immediate = initialProductImage(lifetime.key);
assert.equal((immediate as any).syntheticKind, 9,
  "the writer's existing immutable cache is available synchronously before the detail first render");
assert.equal(metadataReads, previousMetadataReads, "first-frame restoration does not wait on asynchronous ImageIO");
assert.equal(networkCalls, 1);
const previousBitmapReads = bitmapReads;
assert.equal(initialProductImage(lifetime.key), immediate, "later renders reuse the restored decoded image");
assert.equal(bitmapReads, previousBitmapReads);
pruneProductImages([identity("lifetime")], [identity("lifetime")]);
assert.ok(files.has(lifetimeFile), "retained rows preserve files even when the list hides them");
pruneProductImages([identity("lifetime")], []);
assert.equal(files.has(lifetimeFile), false);
assert.equal(cachedProductImage(lifetime.key), null);
assert.equal(await loadProductImage(url(), undefined, { ...lifetime, isRetained: () => false }), null,
  "removed rows cannot revive a decoded cache or begin a new request");
assert.equal(networkCalls, 1);

reset({ chunks: [data(3)] });
const retryOwner = owner("retry-after-failure");
assert.equal(await loadProductImage(url(), undefined, retryOwner), null);
reply = { chunks: [data(10)] };
assert.ok(await loadProductImage(url(), undefined, retryOwner), "failed downloads do not pin a record to failure");
assert.equal(networkCalls, 2);

reset();
const unavailableCache = owner("unavailable-cache-address");
const originalHash = Crypto.sha256;
try {
  (Crypto as any).sha256 = () => { throw new Error("synthetic hash unavailable"); };
  assert.equal(productImageCacheKey(identity("unavailable")), "");
  assert.doesNotThrow(() => pruneProductImages([identity("unavailable")], [identity("retained")]));
  assert.ok(await loadProductImage(url(), undefined, unavailableCache),
    "an unavailable temporary cache address cannot block a valid record image download");
} finally { (Crypto as any).sha256 = originalHash; }
reset();
failWrite = true;
const failedCache = owner("cache-write-denied");
const uncachedImage = await loadProductImage(url(), undefined, failedCache);
assert.ok(uncachedImage);
assert.equal(await loadProductImage("", undefined, failedCache), uncachedImage,
  "a persistent cache write failure still preserves a decoded image for this runtime");
assert.equal(files.size, 0);

reset();
const simultaneous = owner("simultaneous");
const [left, right] = await Promise.all([loadProductImage(url(), undefined, simultaneous),
  loadProductImage(url(), undefined, simultaneous)]);
assert.ok(left);
assert.equal(left, right, "concurrent detail loads share the first successful decoded image");
assert.equal([...files.keys()].filter(path => path.endsWith(".img")).length, 1);

reset();
let releaseOptionalWrite!: () => void;
beforeWrite = () => new Promise<void>(resolve => { releaseOptionalWrite = resolve; });
const slowDisk = owner("slow-optional-disk");
assert.ok(await loadProductImage(url(), undefined, slowDisk),
  "an optional disk write cannot delay the successfully decoded image");
assert.ok(releaseOptionalWrite);
releaseOptionalWrite();
for (let tick = 0; tick < 8; tick++) await Promise.resolve();
assert.equal(productImageCacheFiles(slowDisk.key).length, 1);

reset();
let isRetained = true;
let finishWrite!: () => void;
let startedWrite!: () => void;
const writing = new Promise<void>(resolve => { startedWrite = resolve; });
beforeWrite = () => { startedWrite(); return new Promise<void>(resolve => { finishWrite = resolve; }); };
const removedDuringWrite = owner("removed-during-write");
const pendingImage = loadProductImage(url(), undefined, { ...removedDuringWrite, isRetained: () => isRetained });
await writing;
isRetained = false;
pruneProductImages([identity("removed-during-write")], []);
finishWrite();
assert.equal(await pendingImage, null);
assert.equal(files.size, 0, "record deletion during an awaited write leaves no published or pending image");
assert.equal(cachedProductImage(removedDuringWrite.key), null);

reset();
isRetained = true;
const removedAtPublish = owner("removed-at-publish");
afterRename = () => {
  isRetained = false;
  pruneProductImages([identity("removed-at-publish")], []);
};
assert.equal(await loadProductImage(url(), undefined, { ...removedAtPublish, isRetained: () => isRetained }), null);
assert.equal(files.size, 0, "the post-publication retention check removes an image deleted by another writer");
assert.equal(cachedProductImage(removedAtPublish.key), null);

const diagnosticMemory = new Map<string, unknown>();
Object.assign(globalThis, { Storage: {
  get: (key: string) => diagnosticMemory.get(key) ?? null,
  set: (key: string, value: unknown) => { diagnosticMemory.set(key, structuredClone(value)); return true; },
  remove: (key: string) => { diagnosticMemory.delete(key); },
} });
const { setDiagnosticsEnabled, clearDiagnostics, readDiagnostics } = await import("../services/logger");
setDiagnosticsEnabled(true);
for (const [response, stage, result] of [
  [{ status: 503 }, "response", "http_error"],
  [{ mime: "text/html" }, "response", "unsupported_type"],
  [{ chunks: [data(3)] }, "metadata", "invalid_dimensions"],
  [{ chunks: [data(4)] }, "metadata", "failed"],
] as const) {
  reset(response);
  clearDiagnostics();
  const imageURL = url();
  assert.equal(await loadProductImage(imageURL), null);
  const entries = readDiagnostics();
  assert.equal(entries.length, 1, "one image attempt records one terminal result");
  assert.equal(entries[0].event, "product.image.completed");
  assert.equal(entries[0].details.stage, stage);
  assert.equal(entries[0].details.result, result);
  assert.equal(JSON.stringify(entries).includes(imageURL), false, "image addresses never enter diagnostics");
}
reset();
clearDiagnostics();
const imageIO = (globalThis as any).ImageIO;
delete (globalThis as any).ImageIO;
try {
  assert.equal(await loadProductImage(url()), null);
  assert.equal(readDiagnostics()[0].details.result, "unavailable_api");
} finally { (globalThis as any).ImageIO = imageIO; }
reset();
clearDiagnostics();
const loggedCachedURL = url();
assert.ok(await loadProductImage(loggedCachedURL));
assert.equal(readDiagnostics()[0].details.result, "loaded");
clearDiagnostics();
assert.ok(await loadProductImage(loggedCachedURL));
assert.equal(readDiagnostics()[0].details.stage, "cache");
reset({ pendingFetch: true });
clearDiagnostics();
const closedPage = new nativeController();
const cancelledLoad = loadProductImage(url(), closedPage.signal);
closedPage.abort();
assert.equal(await cancelledLoad, null);
assert.equal(readDiagnostics().length, 0, "closing a page does not report an image failure");
setDiagnosticsEnabled(false);
reset();
assert.ok(await loadProductImage(url()));
assert.equal(readDiagnostics().length, 0, "the existing logging switch remains authoritative");

console.log("product-images: URL, redirects, MIME, streaming bounds, metadata, cache, cancellation and private diagnostics passed");
