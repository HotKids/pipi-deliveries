import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment } from "../models";
import { emptyState, isStoredShipmentRetained, loadState, readAppStateSnapshot, removeShipment, saveState } from "../services/storage";
import { cachedProductImage, cainiaoImageCacheKey, cloudProductImageCacheKey, pddImageCacheKey, productImageCacheKey,
  rememberProductImage } from "../services/product-image-cache";
import { initialProductImage, loadProductImage } from "../services/product-images";
import { pddParcelProductImage } from "../services/platform-parcel-merge";
import { accountStatus, clearPlatformLogin, currentPlatformSession, currentPlatformSessionInTurn, notePlatformSync,
  platformSession, replacePlatformCookies, saveCainiaoNickname, savePlatformLogin } from "../services/platform-accounts";
import { beginGatewayCredentialObservation, gatewayCredentialForLocalCache, recordGatewayCredentialOutcome,
  removeGatewayToken, saveGatewayToken } from "../services/credentials";
import { shipmentLifecycleKey } from "../services/shipment-lifecycle";
import { sharedData, withSharedFileTransaction } from "../services/shared-file-transaction";

type View = { type: "CourierIcon" } | { type: "Image"; image: UIImage };
type Props = {
  shipment: Shipment; cacheKey: string; imageURL?: string; cloudImage?: { url: string; scope: string };
  courierCode: string; companyName: string; size: number; allowDownload?: boolean;
};

const DAY = 86_400_000;
const ACCOUNT_KEY = "pipi.deliveries.platform.v1.cainiao";
const thumbnail = readFileSync(new URL("../components/ProductThumbnail.tsx", import.meta.url), "utf8");
const carrierReturn = /return \(\s+<CourierIcon[\s\S]*?\/>\s+\);/;
const imageReturn = /return \(\s+<VStack[\s\S]*?<\/VStack>\s+\);/;
assert.match(thumbnail, carrierReturn);
assert.match(thumbnail, imageReturn);
const thumbnailModule = stripTypeScriptTypes(thumbnail.replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, "")
  .replace(carrierReturn, 'return { type: "CourierIcon" };')
  .replace(imageReturn, 'return { type: "Image", image };'), { mode: "transform" });

const services = {
  cachedProductImage, cainiaoImageCacheKey, cloudProductImageCacheKey, pddImageCacheKey, productImageCacheKey,
  initialProductImage, loadProductImage, pddParcelProductImage, currentPlatformSessionInTurn,
  gatewayCredentialForLocalCache, isStoredShipmentRetained, readAppStateSnapshot, shipmentLifecycleKey,
  sharedData, withSharedFileTransaction,
};

// One module evaluation serves every mounted thumbnail, as one Scripting runtime does. Only the hooks and
// the two native view trees are substituted; effects are optional downloads and are not run.
function loadThumbnails(scope: Partial<typeof services> = {}) {
  let current: { values: unknown[]; hook: number } | undefined;
  const { ProductThumbnail } = runInNewContext(`${thumbnailModule}\n({ ProductThumbnail });`, {
    AbortController, ...services, ...scope,
    useState(initial: unknown) {
      const instance = current!;
      const at = instance.hook++;
      if (!(at in instance.values)) instance.values[at] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [instance.values[at], (value: unknown) => {
        instance.values[at] = typeof value === "function" ? (value as (old: unknown) => unknown)(instance.values[at]) : value;
      }];
    },
    useEffect() {},
  }) as { ProductThumbnail: (props: Props) => View };
  return (props: () => Props) => {
    const instance = { values: [] as unknown[], hook: 0 };
    return (): View => {
      current = instance;
      instance.hook = 0;
      try { return ProductThumbnail(props()); } finally { current = undefined; }
    };
  };
}
const shown = (view: View) => view.type === "Image" ? view.image : null;
const image = (name: string) => ({ syntheticImage: name }) as unknown as UIImage;

function manualRow(id: string, waybill: string, overrides: Partial<Shipment> = {}): Shipment {
  return {
    identity: { id, bindingSource: null, sourceOwner: "manual", sourceId: waybill, phoneTail: "",
      courierCode: "YTO", companyName: "圆通速递", manuallyAdded: true, createdAtMs: NOW - 20_000 },
    timeline: { provider: "picker", waybill, courierCode: "YTO", companyName: "圆通速递", semantic: "WAITING_PICKUP",
      statusEventAtMs: NOW - 10_000, latestTimeText: "2026-09-08 13:59", latestDetail: "快递已到驿站",
      tracks: [{ timeMs: NOW - 10_000, timeText: "2026-09-08 13:59", detail: "快递已到驿站", statusCode: "", raw: {} }],
      successAtMs: NOW - 10_000 },
    updatedAtMs: NOW - 10_000,
    ...overrides,
  };
}
function signedRow(id: string, signedAt = NOW - 60_000): Shipment {
  const timeText = new Date(signedAt + 8 * 3_600_000).toISOString().replace("T", " ").slice(0, 19);
  return {
    identity: { id, bindingSource: "interface5", sourceOwner: "account", sourceId: id,
      phone: "13800000000", phoneTail: "0000", courierCode: "JD", rawCourierCode: "JD",
      companyName: "JD", manuallyAdded: false, createdAtMs: signedAt, enhancedMode: true,
      productImageURL: "https://img.jd.com/synthetic.jpg" },
    timeline: { provider: "v5_query", waybill: `JD${id}`, courierCode: "JD", companyName: "JD",
      semantic: "COMPLETED", structuredStatus: true, statusEventAtMs: signedAt, latestTimeText: timeText,
      latestDetail: "Signed", tracks: [{ timeText, timeMs: signedAt, detail: "Signed", statusCode: "107", raw: {} }],
      successAtMs: NOW },
    updatedAtMs: NOW,
  };
}
// Storage gives manual rows their canonical id, so the records are found by their stable source id.
const stored = (sourceId: string) => loadState().shipments.find(row => row.identity.sourceId === sourceId);
const cookie = { name: "cookie2", value: "synthetic-taobao-session", domain: ".taobao.com", path: "/",
  isSecure: true, isHTTPOnly: true, isSessionOnly: true };

const realNow = Date.now;
const realGet = Keychain.get;
const realHash = Crypto.sha256;
let clock = NOW;
Date.now = () => clock;
try {
  // C1: every Cainiao thumbnail rendered in one synchronous turn shares one saved-account read.
  memory.clear();
  savePlatformLogin("cainiao", "", { kind: "web", cookies: [cookie] }, "synthetic-cainiao-account");
  const generation = platformSession("cainiao")!.generation;
  const cainiaoRows = saveState({ ...emptyState(), shipments: Array.from({ length: 12 }, (_, index) => {
    const waybill = `YT00000000710${String(index).padStart(2, "0")}`;
    return manualRow(`thumb-cainiao-${index}`, waybill, { platformFields: { waybill, waybillGeneration: 0,
      cainiaoImage: { url: `https://img.alicdn.com/thumb-${index}.jpg`, generation } } });
  }) }, NOW).shipments;
  assert.equal(cainiaoRows.length, 12);
  const cainiaoImages = new Map(cainiaoRows.map(row => {
    const key = cainiaoImageCacheKey(row);
    assert.ok(key, "the stored row keeps its Cainiao product image");
    return [row.identity.id, rememberProductImage(key, image(row.identity.id))];
  }));
  await Promise.resolve();
  let accountReads = 0;
  Keychain.get = (key: string) => {
    if (key === ACCOUNT_KEY) accountReads += 1;
    return realGet(key);
  };
  const cainiaoThumbnails = loadThumbnails();
  const cainiaoViews = cainiaoRows.map(shipment => cainiaoThumbnails(() => ({ shipment, cacheKey: "", imageURL: "",
    courierCode: "YTO", companyName: "圆通速递", size: 72, allowDownload: false })));
  cainiaoViews.forEach((render, index) => assert.equal(shown(render()), cainiaoImages.get(cainiaoRows[index].identity.id),
    "a current Cainiao login keeps each row's cached product image on its first render"));
  assert.equal(accountReads, 1, "every Cainiao row rendered in one turn shares one Keychain read");
  for (const render of cainiaoViews) render();
  assert.equal(accountReads, 1, "repeated renders in the same turn reuse that read");
  await Promise.resolve();
  for (const render of cainiaoViews) assert.ok(shown(render()));
  assert.equal(accountReads, 2, "the next turn reads the saved account again");

  // C1: a saved account change is read by the same turn's next check.
  assert.ok(currentPlatformSessionInTurn("cainiao", generation));
  clearPlatformLogin("cainiao", generation);
  for (const render of cainiaoViews) assert.equal(render().type, "CourierIcon", "a removed login hides its Cainiao images at once");
  assert.equal(currentPlatformSessionInTurn("cainiao", generation), null);
  savePlatformLogin("cainiao", accountStatus("cainiao").generation, { kind: "web", cookies: [cookie] }, "synthetic-cainiao-account");
  const rebound = platformSession("cainiao")!;
  assert.notEqual(rebound.generation, generation);
  assert.deepEqual(currentPlatformSessionInTurn("cainiao", rebound.generation), rebound, "a new login is read at once");
  for (const render of cainiaoViews) {
    assert.equal(render().type, "CourierIcon", "an image of the previous login generation stays hidden after rebinding");
  }
  assert.ok(notePlatformSync("cainiao", rebound.generation, NOW + 5));
  assert.equal(currentPlatformSessionInTurn("cainiao", rebound.generation)?.syncedAtMs, NOW + 5, "a saved sync is read at once");
  assert.ok(saveCainiaoNickname(rebound.generation, "Synthetic nickname"));
  assert.equal(currentPlatformSessionInTurn("cainiao", rebound.generation)?.label, "Synthetic nickname");
  const renewed = [{ ...cookie, value: "synthetic-taobao-session-2" }];
  assert.ok(replacePlatformCookies("cainiao", rebound.generation, [cookie], renewed));
  assert.deepEqual(currentPlatformSessionInTurn("cainiao", rebound.generation), platformSession("cainiao"),
    "renewed cookies are read at once");
  clearPlatformLogin("cainiao", rebound.generation, true);
  assert.equal(currentPlatformSessionInTurn("cainiao", rebound.generation), null, "an expired login is read at once");
  assert.equal(accountStatus("cainiao").state, "expired");

  // Another runtime's write is read from the next turn, as the Access Key scope already is.
  await Promise.resolve();
  savePlatformLogin("cainiao", accountStatus("cainiao").generation, { kind: "web", cookies: [cookie] }, "synthetic-cainiao-account");
  const external = platformSession("cainiao")!;
  await Promise.resolve();
  assert.ok(currentPlatformSessionInTurn("cainiao", external.generation));
  const reads = accountReads;
  memory.set(`keychain:${ACCOUNT_KEY}`, JSON.stringify({ state: "offline", generation: "another-runtime", label: "" }));
  assert.ok(currentPlatformSessionInTurn("cainiao", external.generation), "checks in one turn share one read");
  assert.equal(accountReads, reads);
  await Promise.resolve();
  assert.equal(currentPlatformSessionInTurn("cainiao", external.generation), null, "the next turn observes another runtime's change");
  assert.equal(accountReads, reads + 1);
  Keychain.get = realGet;

  // C2: thumbnails of one state version share one owner index; a new version or an expired owner rebuilds it once.
  memory.clear();
  await Promise.resolve();
  const indexRows = saveState({ ...emptyState(), shipments: [
    ...Array.from({ length: 11 }, (_, index) => signedRow(`thumb-index-${index}`)),
    signedRow("thumb-index-old", NOW - 20 * DAY),
  ] }, NOW).shipments;
  assert.equal(indexRows.length, 12);
  const keyInputs = new Set(indexRows.map(({ identity }) => JSON.stringify([identity.bindingSource, identity.id, identity.sourceId,
    identity.phone || "", identity.orderId || ""])));
  let snapshotReads = 0, keyHashes = 0;
  const indexThumbnails = loadThumbnails({
    readAppStateSnapshot: (...args: Parameters<typeof readAppStateSnapshot>) => {
      snapshotReads += 1;
      return readAppStateSnapshot(...args);
    },
  });
  const indexViews = indexRows.map(shipment => {
    const cacheKey = productImageCacheKey(shipment.identity);
    return { id: shipment.identity.id, image: rememberProductImage(cacheKey, image(shipment.identity.id)),
      render: indexThumbnails(() => ({ shipment, cacheKey, imageURL: "", courierCode: "JD", companyName: "JD", size: 72,
        allowDownload: false })) };
  });
  Crypto.sha256 = ((value: string) => {
    if (keyInputs.has(value)) keyHashes += 1;
    return realHash(value);
  }) as typeof Crypto.sha256;
  const renderAll = () => new Map(indexViews.map(view => [view.id, shown(view.render())]));
  for (const [id, displayed] of renderAll()) assert.equal(displayed, indexViews.find(view => view.id === id)!.image);
  assert.equal(snapshotReads, 1, "one state version builds one owner index for all twelve thumbnails");
  renderAll();
  renderAll();
  assert.equal(snapshotReads, 1, "unchanged state reuses that index for every later check");

  saveState({ ...loadState(), shipments: [...loadState().shipments, manualRow("thumb-index-extra", "YT000000007199")] }, NOW + 1);
  for (const [id, displayed] of renderAll()) assert.equal(displayed, indexViews.find(view => view.id === id)!.image,
    "an ordinary commit keeps every same-lifecycle image");
  assert.equal(snapshotReads, 2, "a new state version rebuilds the index once, not once per thumbnail");

  removeShipment("thumb-index-1", NOW + 2);
  for (const [id, displayed] of renderAll()) {
    assert.equal(displayed, id === "thumb-index-1" ? null : indexViews.find(view => view.id === id)!.image);
  }
  assert.equal(snapshotReads, 3, "a deletion is one more state version");

  clock = NOW + 1.5 * DAY;
  for (const [id, displayed] of renderAll()) {
    assert.equal(displayed, ["thumb-index-1", "thumb-index-old"].includes(id) ? null : indexViews.find(view => view.id === id)!.image,
      "time-based retention hides only the expired owner's image, before any commit");
  }
  assert.equal(snapshotReads, 4, "the expired owner rebuilds the index once for all thumbnails");
  renderAll();
  assert.equal(snapshotReads, 4);
  assert.equal(keyHashes, 0, "neither the index nor the row checks hash a key again");
  Crypto.sha256 = realHash;
  clock = NOW;

  // The retained/evicted decision equals the previous per-check scan across representative states.
  memory.clear();
  await Promise.resolve();
  const selection = thumbnail.slice(thumbnail.indexOf("  const cainiao ="), thumbnail.indexOf("  const lifecycle ="));
  const owner = thumbnail.slice(thumbnail.indexOf("  const lifecycle ="), thumbnail.indexOf("  const [loaded,"));
  const prelude = thumbnail.slice(0, thumbnail.indexOf("export function ProductThumbnail(")).replace(/^import[\s\S]*?;\n/gm, "");
  // The owner check before this change, verbatim, including its direct Keychain read through the selection.
  const previous = `
  const lifecycle = shipmentLifecycleKey(props.shipment);
  let checkedStateRef: string | undefined;
  let retained = false;
  let checkedShipment = props.shipment;
  const isRetained = () => {
    if (!cacheKey || useCainiao && !cainiaoCurrent() || cloud && !cloudCurrent()) return false;
    const stateRef = sharedData().stateRef;
    if (stateRef && stateRef === checkedStateRef && (!retained || isStoredShipmentRetained(checkedShipment))) return retained;
    return withSharedFileTransaction(() => {
      const current = readAppStateSnapshot().state.shipments.find(shipment =>
        shipmentLifecycleKey(shipment) === lifecycle && keyFor(shipment) === cacheKey);
      retained = current != null;
      if (current) checkedShipment = current;
      checkedStateRef = sharedData().stateRef;
      return retained;
    });
  };`;
  const { storedImageOwner } = Function("scope", `with(scope) { ${stripTypeScriptTypes(prelude)}; return { storedImageOwner }; }`)(services);
  const ownerChecks = (props: Props) => ({
    current: Function("scope", `with(scope) { ${stripTypeScriptTypes(selection + owner)}; return isRetained; }`)(
      { ...services, storedImageOwner, props }) as () => boolean,
    previous: Function("scope", `with(scope) { ${stripTypeScriptTypes(selection + previous)}; return isRetained; }`)(
      { ...services, currentPlatformSessionInTurn: currentPlatformSession, props }) as () => boolean,
  });
  const decisionThumbnails = loadThumbnails();

  saveGatewayToken("SyntheticKey_301");
  const scope = gatewayCredentialForLocalCache()!.scope;
  const pddAssociation = JSON.stringify(["synthetic-pdd-owner", "88000009301", "73000301"]);
  saveState({ ...emptyState(), shipments: [
    signedRow("decision-signed"),
    manualRow("decision-cainiao", "YT000000009301"),
    manualRow("decision-pdd", "YT000000009302", {
      pddImport: { ownerKey: "synthetic-pdd-owner", orderId: "88000009301", shippingId: "73000301" },
      platformFields: { waybill: "YT000000009302", waybillGeneration: 0,
        pddImage: { url: "https://img.pddpic.com/decision.jpeg", association: pddAssociation } },
    }),
    manualRow("decision-cloud", "YT000000009303"),
  ] }, NOW);
  const cases: Array<{ name: string; props: () => Props }> = [
    { name: "identity", props: () => {
      const shipment = stored("decision-signed") ?? signedRow("decision-signed");
      return { shipment, cacheKey: productImageCacheKey(shipment.identity), courierCode: "JD", companyName: "JD", size: 72 };
    } },
    { name: "cainiao", props: () => ({ shipment: stored("YT000000009301") ?? manualRow("decision-cainiao", "YT000000009301"),
      cacheKey: "", courierCode: "YTO", companyName: "圆通速递", size: 72 }) },
    { name: "pdd", props: () => ({ shipment: stored("YT000000009302") ?? manualRow("decision-pdd", "YT000000009302"),
      cacheKey: "", courierCode: "YTO", companyName: "圆通速递", size: 72 }) },
    { name: "cloud", props: () => ({ shipment: stored("YT000000009303") ?? manualRow("decision-cloud", "YT000000009303"),
      cacheKey: "", cloudImage: { url: "https://img.alicdn.com/decision-cloud.jpg", scope }, courierCode: "YTO",
      companyName: "圆通速递", size: 72 }) },
    { name: "foreign scope", props: () => ({ shipment: stored("YT000000009303") ?? manualRow("decision-cloud", "YT000000009303"),
      cacheKey: "", cloudImage: { url: "https://img.alicdn.com/decision-cloud.jpg", scope: "another-access-key" },
      courierCode: "YTO", companyName: "圆通速递", size: 72 }) },
    { name: "unrelated", props: () => {
      const shipment = signedRow("decision-unrelated");
      return { shipment, cacheKey: productImageCacheKey(shipment.identity), courierCode: "JD", companyName: "JD", size: 72 };
    } },
    { name: "carrier only", props: () => ({ shipment: manualRow("decision-carrier", "YT000000009304"), cacheKey: "",
      courierCode: "YTO", companyName: "圆通速递", size: 72 }) },
  ];
  const keyOf = (props: Props) => Function("scope", `with(scope) { ${stripTypeScriptTypes(selection)}; return cacheKey; }`)(
    { ...services, props }) as string;
  let persistent: Array<{ name: string; checks: ReturnType<typeof ownerChecks> }> = [];
  function verify(step: string, expected: Record<string, boolean>) {
    for (const item of cases) {
      const props = item.props();
      const fresh = ownerChecks(props);
      const decision = fresh.previous();
      assert.equal(fresh.current(), decision, `${step}: a new ${item.name} check keeps the previous decision`);
      if (item.name in expected) assert.equal(decision, expected[item.name], `${step}: ${item.name}`);
      const key = keyOf(props);
      const cachedImage = key ? rememberProductImage(key, image(`${item.name}:${key}`)) : null;
      assert.equal(shown(decisionThumbnails(item.props)()), decision ? cachedImage : null,
        `${step}: the rendered ${item.name} thumbnail is unchanged`);
    }
    for (const { name, checks } of persistent) {
      assert.equal(checks.current(), checks.previous(), `${step}: an earlier ${name} owner keeps the previous decision`);
    }
  }

  verify("without a Cainiao login", { identity: true, cainiao: false, pdd: true, cloud: true, "foreign scope": false,
    unrelated: false, "carrier only": false });
  savePlatformLogin("cainiao", accountStatus("cainiao").generation, { kind: "web", cookies: [cookie] }, "synthetic-cainiao-account");
  const decisionGeneration = platformSession("cainiao")!.generation;
  saveState({ ...loadState(), shipments: loadState().shipments.map(row => row.identity.sourceId !== "YT000000009301" ? row : {
    ...row, platformFields: { waybill: "YT000000009301", waybillGeneration: 0,
      cainiaoImage: { url: "https://img.alicdn.com/decision-cainiao.jpg", generation: decisionGeneration } } }) }, NOW);
  persistent = cases.map(item => ({ name: item.name, checks: ownerChecks(item.props()) }));
  verify("present", { identity: true, cainiao: true, pdd: true, cloud: true, "foreign scope": false, unrelated: false,
    "carrier only": false });
  saveState({ ...loadState(), shipments: [...loadState().shipments, manualRow("decision-extra", "YT000000009305")] }, NOW + 1);
  verify("after an unrelated commit", { identity: true, cainiao: true, pdd: true, cloud: true });
  clearPlatformLogin("cainiao", decisionGeneration);
  verify("after the Cainiao login is removed", { cainiao: false, identity: true });
  savePlatformLogin("cainiao", accountStatus("cainiao").generation, { kind: "web", cookies: [cookie] }, "synthetic-cainiao-account");
  verify("after a new Cainiao login", { cainiao: false, identity: true });
  recordGatewayCredentialOutcome(beginGatewayCredentialObservation(), 401, "unauthorized");
  verify("after the Access Key is rejected", { cloud: false, identity: true });
  removeGatewayToken();
  verify("after the Access Key is removed", { cloud: false, identity: true });
  removeShipment(stored("YT000000009302")!.identity.id, NOW + 2);
  verify("after deletion", { pdd: false, identity: true });
  const reimported = { ...signedRow("decision-signed"), identity: { ...signedRow("decision-signed").identity, createdAtMs: NOW - 30_000 } };
  saveState({ ...loadState(), shipments: [...loadState().shipments.filter(row => row.identity.id !== "decision-signed"), reimported] }, NOW + 3);
  const earlier = persistent.find(item => item.name === "identity")!.checks;
  assert.equal(earlier.current(), false, "an earlier owner of a deleted and reimported record is evicted");
  verify("after reimport", { identity: true });
  clock = NOW + 15 * DAY;
  verify("fifteen days after signing", { identity: true });
  clock = NOW + 22 * DAY;
  verify("twenty-two days after signing", { identity: false });
} finally {
  Date.now = realNow;
  Keychain.get = realGet;
  Crypto.sha256 = realHash;
}
assert.equal(cachedProductImage(""), null);
console.log("product thumbnails share one account read per turn and one owner index per state version");
