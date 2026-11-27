import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import type { Shipment } from "../models";
import { memory, NOW } from "./state-storage-mock";
import { clearPlatformLogin, platformSession, savePlatformLogin } from "../services/platform-accounts";
import { cainiaoParcelDetails, cainiaoRecipientParcels } from "../services/platform-parcel-data";
import { fetchJdParcelDetails, fetchJdParcels, fetchPddOrders } from "../services/platform-web-parcels";
import { registerProjectionViewportHost } from "../services/projection-viewport";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(projectDir, rel), "utf8");

test("Cainiao, PDD, and JD multi-item orders grab the LAST non-empty product title", async (t) => {
  // 1) Cainiao multi-item -> last non-empty title, while keeping first valid product image
  const cnWaybill = "YT2026112700001";
  const cnFromPackageItems = cainiaoParcelDetails({
    result: {
      mailNo: cnWaybill,
      packageItem: [
        { itemTitle: "第一件商品" },
        { itemTitle: "   " },
        { itemTitle: "最后一件商品" },
      ],
      goodsList: [
        { itemPic: "https://img.alicdn.com/first-valid.jpg", goodsName: "商品一" },
        { itemPic: "https://img.alicdn.com/second-valid.jpg", goodsName: "商品二" },
      ],
    },
  }, cnWaybill, NOW);
  assert.equal(cnFromPackageItems?.title, "最后一件商品");
  assert.equal(cnFromPackageItems?.productImageURL, "https://img.alicdn.com/first-valid.jpg");

  const cnFromRecipientList = cainiaoRecipientParcels({
    result: [{
      mailNo: cnWaybill,
      status: "TRANSIT",
      updateTime: String(NOW),
      packageItem: [
        { itemTitle: "首件零食" },
        { itemTitle: "末件坚果礼盒" },
      ],
    }],
  }, NOW);
  assert.equal(cnFromRecipientList[0]?.title, "末件坚果礼盒");

  // 2) PDD multi-item -> last non-empty goods_name
  t.mock.method(UUID, "string", randomUUID);
  memory.clear();
  const pddWaybill = "SF1550026112701";
  const pddCookie: Cookie = {
    name: "PDDAccessToken",
    value: "synthetic-pdd-multi-item",
    domain: ".yangkeduo.com",
    path: "/",
    isSecure: true,
    isHTTPOnly: true,
    isSessionOnly: false,
  };
  savePlatformLogin("pinduoduo", "", { kind: "web", cookies: [pddCookie] }, "synthetic-pdd-multi");
  const pddSession = platformSession("pinduoduo")!;
  const originalWebView = globalThis.WebViewController;
  let pddCaptureScript = "";
  let pddPage = new URL("about:blank");
  const pddWin: any = {
    top: null,
    fetch: async () => ({
      ok: true,
      url: "https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4",
      clone() {
        return {
          text: async () => JSON.stringify({
            orders: [{
              order_sn: "261127-000111222333",
              shipping_id: "73000999",
              tracking_number: pddWaybill,
              order_goods: [
                { goods_name: "第一件拼多多商品", thumb_url: "https://img.pddpic.com/a.jpg" },
                { goods_name: "第二件拼多多商品", thumb_url: "https://img.pddpic.com/b.jpg" },
                { goods_name: "最后一件拼多多商品", thumb_url: "https://img.pddpic.com/c.jpg" },
              ],
            }],
          }),
        };
      },
    }),
    XMLHttpRequest: { prototype: { send() {} } },
  };
  pddWin.top = pddWin;
  Object.assign(globalThis, {
    WebViewController: class {
      cookies: Cookie[] = [];
      async setCookie(value: Cookie) { this.cookies.push(value); return true; }
      async getAllCookies() { return this.cookies; }
      async addUserScript(options: { source: string }) { pddCaptureScript = options.source; return "ok"; }
      async loadURL(url: string) { pddPage = new URL(url); return true; }
      async evaluateJavaScript(script: string) {
        const doc = { readyState: "complete", body: { innerText: "" } };
        const ctx = {
          window: pddWin,
          document: doc,
          location: pddPage,
          URL,
          URLSearchParams,
          XMLHttpRequest: pddWin.XMLHttpRequest,
        };
        if (pddCaptureScript) {
          const capture = pddCaptureScript;
          pddCaptureScript = "";
          runInNewContext(capture, ctx);
          await pddWin.fetch("https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const raw = runInNewContext(`(() => {${script}})()`, ctx);
        return raw === undefined ? undefined : JSON.parse(JSON.stringify(raw));
      }
      dispose() {}
    },
  });
  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  try {
    const pddRecords = await fetchPddOrders(pddSession);
    assert.equal(pddRecords.length, 1);
    assert.equal(pddRecords[0]?.title, "最后一件拼多多商品");
  } finally {
    clearPlatformLogin("pinduoduo", pddSession.generation);
    globalThis.WebViewController = originalWebView;
    registerProjectionViewportHost(null);
  }

  // 3) JD multi-item: detail page with thumbnails only falls back to order list and picks last ware title
  memory.clear();
  const jdWaybill = "JD0000000001001";
  const jdOrder = "332211009988";
  const cookie: Cookie = {
    name: "pt_key",
    value: "synthetic-jd-multi-item",
    domain: ".jd.com",
    path: "/",
    isSecure: true,
    isHTTPOnly: true,
    isSessionOnly: false,
  };
  savePlatformLogin("jingdong", "", { kind: "web", cookies: [cookie] }, "synthetic-jd-multi");
  const session = platformSession("jingdong")!;
  const parcel: Shipment = {
    identity: {
      id: `interface5:account:${jdWaybill}`,
      sourceId: jdOrder,
      sourceOwner: "interface5:13800000000",
      bindingSource: "interface5",
      phoneTail: "0000",
      courierCode: "JD",
      companyName: "京东快递",
      manuallyAdded: false,
      accountOrder: true,
      sourceProvider: "jingdong",
      orderId: jdOrder,
      projectedWaybill: jdWaybill,
      createdAtMs: NOW - 60_000,
    },
    timeline: {
      provider: "v5_list",
      waybill: jdWaybill,
      courierCode: "JD",
      companyName: "京东快递",
      semantic: "TRANSIT",
      statusEventAtMs: NOW - 10_000,
      latestTimeText: "2026-11-27 14:34",
      latestDetail: "您的订单在京东【深圳万丰站】收货完成",
      tracks: [],
      successAtMs: NOW - 10_000,
    },
    updatedAtMs: NOW - 10_000,
  };
  let currentPage = new URL("about:blank");
  // Detail summary has waybill copy node + empty thumbnail elements (no text title, just like Fold8 JD0000000001001)
  const detailSummary = {
    querySelectorAll: (selector: string) =>
      selector.includes("data-copy-cont")
        ? [{ getAttribute: () => jdWaybill }]
        : [],
  };
  const orderCard: any = {
    querySelector: (selector: string) => selector.includes("order_item") ? {} : null,
    querySelectorAll: (selector: string) => {
      if (selector.includes("order_state")) return [orderState];
      if (selector.includes("data-eparam")) return [{ getAttribute: () => JSON.stringify({ orderid: jdOrder }) }];
      if (selector.includes("desc")) {
        return [
          { textContent: "第一件京东自营商品" },
          { textContent: "第二件京东自营商品" },
          { textContent: "最后一件京东自营商品" },
        ];
      }
      return [];
    },
  };
  const orderState = { parentElement: orderCard, innerText: "待收货", textContent: "待收货" };
  Object.assign(globalThis, {
    WebViewController: class {
      cookies: Cookie[] = [];
      async setCookie(value: Cookie) { this.cookies.push(value); return true; }
      async getAllCookies() { return this.cookies; }
      async loadURL(url: string) { currentPage = new URL(url); return true; }
      async evaluateJavaScript(script: string) {
        const onDetail = currentPage.pathname.endsWith("/deal_wuliu_jdm.shtml");
        const win: any = { top: null, innerWidth: 390, innerHeight: 844 };
        win.top = win;
        const doc = {
          readyState: "complete",
          body: { innerText: onDetail ? `运单号：${jdWaybill}\n运输中` : "待收货" },
          querySelector: (sel: string) => onDetail && sel.includes("Summary-module") ? detailSummary : null,
          querySelectorAll: () => onDetail ? [] : [orderState],
        };
        const raw = runInNewContext(`(() => {${script}})()`, { window: win, document: doc, location: currentPage, URLSearchParams });
        return raw === undefined ? undefined : JSON.parse(JSON.stringify(raw));
      }
      dispose() {}
    },
  });
  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  try {
    const jdDetailFallback = await fetchJdParcelDetails(session, jdOrder, jdWaybill, () => true);
    assert.equal(jdDetailFallback?.waybill, jdWaybill);
    assert.equal(jdDetailFallback?.title, "最后一件京东自营商品");

    let savedOrderTitles: string[] = [];
    await fetchJdParcels(session, [parcel], (items) => {
      savedOrderTitles = items.map((item) => item.title || "");
    });
    assert.deepEqual(savedOrderTitles, ["最后一件京东自营商品"]);
  } finally {
    clearPlatformLogin("jingdong", session.generation);
    globalThis.WebViewController = originalWebView;
    registerProjectionViewportHost(null);
  }
});

test("PickupTabCard keeps static box artwork visible through transparent frames 0..6 and prewarms bundled assets", () => {
  const pickupCardSource = read("components/PickupTabCard.tsx");
  const bundledImageSource = read("components/bundled-image.ts");
  const appSource = read("index.tsx");

  assert.match(bundledImageSource, /export function prewarmBundledImages\(paths: readonly \(string \| undefined\)\[\]\): Promise<void>/);
  assert.match(pickupCardSource, /const BOX_PLAYBACK: ArtworkPlayback = \{[\s\S]*?firstVisibleFrame:\s*7,\s*\}/,
    "box-frames.png skips transparent frames 0..6 on initial playback");
  assert.match(pickupCardSource, /export function prewarmPickupTabAssets\(/);
  assert.match(pickupCardSource, /<PickupTabArtwork key=\{`\$\{art\.baseAsset\}:\$\{art\.playback\?\.path \?\? ""\}`\}/,
    "parcel box artwork keeps a stable key across static/atlas transitions");
  assert.match(pickupCardSource, /const keepStaticUnderlay = !showCanvas \|\| !canvasHandedOff;/,
    "static box underlay stays visible until the atlas has drawn its first visible frame");
  assert.match(pickupCardSource, /onFirstVisibleFrame=\{\(\) => setCanvasHandedOff\(true\)\}/);
  assert.match(appSource, /if \(hasPickupTab\) prewarmPickupTabAssets\(pickupCards, pickupPreview\);/);
});

test("DetailPage prefetches only the tapped shipment and defers disk/Keychain reads until post-paint", () => {
  const detailSource = read("pages/DetailPage.tsx");
  const homeSource = read("pages/HomePage.tsx");
  const pickupSource = read("pages/PickupPage.tsx");

  assert.match(detailSource, /export function prefetchShipmentDetailEntry\(/);
  assert.match(detailSource, /prefetchDetailController\?\.abort\(\);/,
    "tapping another shipment cancels any superseded single-shipment prefetch");
  assert.match(detailSource, /deferDiskDecode=\{true\}/,
    "DetailPage keeps synchronous disk/ImageIO thumbnail decode outside render across its entire lifecycle");
  assert.match(detailSource, /postPaintReady=\{detailPostPaintReady\}/,
    "post-paint readiness gates asynchronous ProductThumbnail disk decode");
  assert.match(detailSource, /allowDownload=\{detailPostPaintReady && imageDownloadScope === imageScope\}/,
    "network image download stays gated until post-paint Stage 3");
  assert.match(homeSource, /prefetchShipmentDetailEntry\(shipment, shipments\);/);
  assert.match(pickupSource, /prefetchShipmentDetailEntry\(shipment, shipments\);/);
});

test("HomePage scopes swipe flags per ID, reuses unchanged row items & buckets, buffers scroll, and App coalesces bursts", () => {
  const homeSource = read("pages/HomePage.tsx");
  const appSource = read("index.tsx");

  // Evaluate sameShipmentRowPresentation & sameShipmentItemList directly from HomePage.tsx
  const start = homeSource.indexOf("type ShipmentListItem =");
  const end = homeSource.indexOf("export function HomePage(");
  assert.ok(start >= 0 && end > start);
  const helpers = runInNewContext(
    `${stripTypeScriptTypes(homeSource.slice(start, end))}\n({ sameShipmentRowPresentation, sameShipmentItemList })`,
    { displayWaybill: (row: any) => row.timeline.waybill || row.identity.sourceId },
  ) as {
    sameShipmentRowPresentation: (a: any, b: any) => boolean;
    sameShipmentItemList: (a: any[] | undefined, b: any[]) => boolean;
  };

  const baseRow = {
    identity: {
      id: "row-1",
      sourceId: "SF1001",
      companyName: "顺丰速运",
      courierCode: "SF",
      sender: false,
      accountOrder: false,
      projectedWaybill: undefined,
    },
    timeline: {
      waybill: "SF1001",
      semantic: "TRANSIT",
      latestTimeText: "2026-11-27 15:00",
      latestDetail: "快件已发车",
    },
    note: "",
    forcedCompletedAtMs: undefined,
    updatedAtMs: 1000,
  };
  const clonedUnchanged = JSON.parse(JSON.stringify(baseRow));
  const changedHeadline = {
    ...clonedUnchanged,
    updatedAtMs: 2000,
    timeline: { ...clonedUnchanged.timeline, latestDetail: "派送中" },
  };
  assert.equal(helpers.sameShipmentRowPresentation(baseRow, clonedUnchanged), true,
    "cloned shipment with identical row presentation reuses existing row item");
  assert.equal(helpers.sameShipmentRowPresentation(baseRow, changedHeadline), false,
    "changed headline or updatedAtMs invalidates only that shipment's row item");

  const itemA = { id: "row-1", shipment: baseRow, deleting: false, completing: false };
  const itemB = { id: "row-2", shipment: clonedUnchanged, deleting: false, completing: false };
  assert.equal(helpers.sameShipmentItemList([itemA, itemB], [itemA, itemB]), true);
  assert.equal(helpers.sameShipmentItemList([itemA, itemB], [itemA, { ...itemB, deleting: true }]), false);

  assert.match(homeSource, /const \[deletingId, setDeletingId\] = useState<string \| null>\(null\);/);
  assert.match(homeSource, /const \[completingId, setCompletingId\] = useState<string \| null>\(null\);/);
  assert.match(homeSource, /onListScrollSettled=\{onListScrollSettled\}/);
  assert.match(appSource, /const BACKGROUND_STATE_COALESCE_MS = 60;/);
  assert.match(appSource, /function applyImmediateState\(next: AppState\)/);
});
