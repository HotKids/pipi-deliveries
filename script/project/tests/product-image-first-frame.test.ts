import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const identity = { bindingSource: "interface5", id: "synthetic-one", sourceId: "synthetic-one",
  phone: "13800000000", orderId: "synthetic-one" };
const key = createHash("sha256").update(JSON.stringify([
  identity.bindingSource, identity.id, identity.sourceId, identity.phone, identity.orderId,
])).digest("hex");
const otherKey = "2".repeat(64);
const directory = "/synthetic-group/pipi-deliveries/product-images";
const path = `${directory}/${key}.100-first.img`;

class FakeData {
  constructor(readonly bytes: Buffer) {}
  get size() { return this.bytes.length; }
}

// Execute the real hooks, selection branches and image services with Node alone. Only the two
// JSX return trees become synthetic leaves; their source assertions retain the native image binding.
function mount(files = new Map<string, FakeData>(), options: {
  linked?: boolean; width?: number; height?: number; duringPreparation?: (files: Map<string, FakeData>) => void;
} = {}) {
  const values: any[] = [], effects: Array<() => void> = [];
  let hook = 0, networkCalls = 0, bitmapReads = 0, thumbnailReads = 0;
  const image = { syntheticImage: true, width: 432, height: 216, scale: 1 };
  const stat = (file: string) => {
    const data = files.get(file);
    if (!data) throw new Error("synthetic missing cache");
    return { type: "file", size: data.size };
  };
  const host = {
    AbortController,
    Path: { join: (...parts: string[]) => parts.join("/") },
    useState(initial: any) {
      const at = hook++;
      if (!(at in values)) values[at] = typeof initial === "function" ? initial() : initial;
      return [values[at], (value: any) => { values[at] = value; }];
    },
    useEffect(effect: () => void) { effects.push(effect); },
    async fetch() { networkCalls++; throw new Error("synthetic transport unavailable"); },
  };
  const globals = {
    AbortController, URL, Date, Math, setTimeout, clearTimeout,
    FileManager: {
      appGroupDocumentsDirectory: "/synthetic-group", temporaryDirectory: "/synthetic-temporary",
      readDirectorySync: (dir: string) => [...files.keys()].filter(file => file.startsWith(`${dir}/`)),
      existsSync: (file: string) => files.has(file),
      isLinkSync: () => options.linked || false,
      statSync: stat,
      readAsDataSync: (file: string) => { stat(file); return files.get(file); },
      removeSync: (file: string) => files.delete(file),
      stat: async (file: string) => stat(file),
      isLink: async () => false,
      readAsData: async (file: string) => { stat(file); return files.get(file); },
      remove: async (file: string) => files.delete(file),
    },
    Crypto: { sha256: (data: FakeData) => ({
      toHexString: () => createHash("sha256").update(data.bytes).digest("hex"),
    }) },
    UIImage: {
      fromData(data: FakeData, scale: number) {
        assert.equal(scale, 1, "the first-frame native container uses a scale of one");
        bitmapReads++;
        return data.bytes[0] ? { width: options.width ?? 432, height: options.height ?? 216,
          scale, preparingThumbnail: () => {
            thumbnailReads++;
            options.duringPreparation?.(files);
            return image;
          } } : null;
      },
      fromFile(file: string) {
        const data = files.get(file);
        bitmapReads++;
        return data?.bytes[0] ? image : null;
      },
    },
    ImageIO: { async readMetadata(data: FakeData) {
      if (!data.bytes[0]) throw new Error("synthetic invalid image");
      return { pixelWidth: 432, pixelHeight: 216 };
    } },
  };
  function evaluate(source: string, exported: string, scope = {}) {
    const executable = stripTypeScriptTypes(source.replace(/^import[\s\S]*?;\n/gm, "")
      .replace(/^export /gm, ""), { mode: "transform" });
    return runInNewContext(`${executable}\n({ ${exported} });`, {
      ...globals, ...host,
      utf8Data: (value: string) => new FakeData(Buffer.from(value)),
      writeDiagnostic: () => {}, ...scope,
    });
  }
  const read = (file: string) => readFileSync(join(project, file), "utf8");
  const cache = evaluate(read("services/product-image-cache.ts"),
    "cachedProductImage, productImageCacheKey, productImageCacheFiles, productImageCachePath, rememberProductImage, PRODUCT_IMAGE_TIMEOUT_MS");
  const images = evaluate(read("services/product-images.ts"),
    "loadProductImage, initialProductImage: typeof initialProductImage === 'function' ? initialProductImage : undefined",
    { ...cache, TIMEOUT_MS: cache.PRODUCT_IMAGE_TIMEOUT_MS });
  const thumbnailSource = read("components/ProductThumbnail.tsx");
  const carrierReturn = /return \(\s+<CourierIcon[\s\S]*?\/>\s+\);/;
  const imageReturn = /return \(\s+<VStack[\s\S]*?<\/VStack>\s+\);/;
  assert.match(thumbnailSource, /if \(!image\) \{\s+return \(\s+<CourierIcon/);
  assert.match(thumbnailSource, /<Image\s+image=\{image\}/);
  assert.match(thumbnailSource, carrierReturn);
  assert.match(thumbnailSource, imageReturn);
  const { ProductThumbnail } = evaluate(thumbnailSource
    .replace(carrierReturn, 'return { type: "CourierIcon", props };')
    .replace(imageReturn, 'return { type: "Image", props: { image } };'), "ProductThumbnail", {
      ...cache, ...images, loadState: () => ({ shipments: [{ identity }] }),
    });
  return {
    image, cache,
    render(props: any = {}) {
      hook = 0;
      effects.length = 0;
      return ProductThumbnail({ imageURL: "https://img.jd.com/synthetic.jpg", cacheKey: key,
        courierCode: "JD", companyName: "京东快递", size: 72, ...props });
    },
    runEffects() { for (const effect of effects.splice(0)) effect(); },
    get networkCalls() { return networkCalls; },
    get bitmapReads() { return bitmapReads; },
    get thumbnailReads() { return thumbnailReads; },
  };
}

function displayedImage(view: any): any {
  if (view.type === "Image") return view.props.image;
  return view.children?.map(displayedImage).find(Boolean) || null;
}

const remembered = mount();
remembered.cache.rememberProductImage(key, remembered.image);
assert.equal(displayedImage(remembered.render()), remembered.image,
  "a warm memory cache supplies the product image before any effect");
assert.equal(remembered.bitmapReads, 0);
assert.equal(remembered.networkCalls, 0);

const persisted = mount(new Map([[path, new FakeData(Buffer.from([1, 2, 3]))]]));
assert.equal(displayedImage(persisted.render()), persisted.image,
  "a cold memory cache must show the persisted product image on the first render, before effects");
assert.equal(persisted.networkCalls, 0, "opening a cached image does not request the network");
assert.equal(displayedImage(persisted.render({ imageURL: "https://img.jd.com/changed.jpg" })), persisted.image,
  "the cached product image remains visible when the record's image URL changes");
assert.equal(displayedImage(persisted.render({ imageURL: "" })), persisted.image,
  "a previously downloaded image remains available when metadata has no current URL");
assert.equal(persisted.render({ cacheKey: otherKey }).type, "CourierIcon",
  "another record must never display the previous record's product image");
const switched = mount(new Map([[`${directory}/${otherKey}.100-second.img`, new FakeData(Buffer.from([1, 2, 3]))]]));
assert.equal(switched.render().type, "CourierIcon");
assert.equal(displayedImage(switched.render({ cacheKey: otherKey })), switched.image,
  "a reused component shows the next record's disk cache before its new effect");

const absent = mount();
assert.equal(absent.render({ imageURL: "", cacheKey: "" }).type, "CourierIcon",
  "a record with no product image keeps its carrier icon on the first render");
assert.equal(absent.networkCalls, 0);

const corrupt = mount(new Map([[path, new FakeData(Buffer.from([0, 0, 0]))]]));
assert.equal(corrupt.render().type, "CourierIcon", "a damaged disk cache cannot crash the detail view");
corrupt.runEffects();
for (let tick = 0; tick < 30; tick++) await Promise.resolve();
assert.equal(corrupt.networkCalls, 1, "a damaged cache still allows the normal asynchronous download");

for (const [label, files, options] of [
  ["oversized file", new Map([[path, new FakeData(Buffer.alloc(4 * 1024 * 1024 + 1, 1))]]), {}],
  ["symbolic link", new Map([[path, new FakeData(Buffer.from([1, 2, 3]))]]), { linked: true }],
] as const) {
  const invalid = mount(files, options);
  assert.equal(invalid.render().type, "CourierIcon", `${label} cannot be used by the first render`);
  assert.equal(invalid.bitmapReads, 0, `${label} is rejected before constructing a native image`);
}
for (const dimensions of [
  { width: 0 }, { height: -1 }, { width: Number.NaN }, { width: 432.5 },
  { width: 4096, height: 4097 },
]) {
  const invalid = mount(new Map([[path, new FakeData(Buffer.from([1, 2, 3]))]]), dimensions);
  assert.equal(invalid.render().type, "CourierIcon", "invalid native pixel dimensions keep the carrier icon");
  assert.equal(invalid.thumbnailReads, 0, "invalid native pixel dimensions cannot prepare a thumbnail");
}
const boundary = mount(new Map([[path, new FakeData(Buffer.from([1, 2, 3]))]]),
  { width: 4096, height: 4096 });
assert.equal(displayedImage(boundary.render()), boundary.image,
  "the existing inclusive 16M-pixel image limit remains accepted");

for (const duringPreparation of [
  (files: Map<string, FakeData>) => files.delete(path),
  (files: Map<string, FakeData>) => files.set(path.replace(/\.img$/, ".deleted"), new FakeData(Buffer.alloc(0))),
]) {
  const removed = mount(new Map([[path, new FakeData(Buffer.from([1, 2, 3]))]]), { duringPreparation });
  assert.equal(removed.render().type, "CourierIcon",
    "deletion during thumbnail preparation cannot publish the removed record's product image");
  assert.equal(removed.cache.cachedProductImage(key), null,
    "a concurrent deletion cannot resurrect the product image in memory");
}

console.log("product image first frame: memory, persisted cache, isolation, URL changes and invalid cache passed");
