import type { Shipment } from "../models";
import { OperationTimeoutError, pauseWhileActive, waitForRefresh } from "./deadline";
import {
  currentPlatformSession, clearPlatformLogin, replacePlatformCookies, type PlatformSession, type WebPlatform,
} from "./platform-accounts";
import { deliveryForecast, objectList, productTitle, type PlatformParcel } from "./platform-parcel-data";
import { JD_ORDERS_PAGE, jdSyncView, openProviderController, PlatformWireError, verifiedJdCookies } from "./platform-wire";
import { platformPickupCode } from "./fengchao-account";
import { acquireProjectionViewport, projectionSceneActive, releaseProjectionViewport } from "./projection-viewport";
import { displayWaybill } from "./shipment-policy";
import { normalizeWaybill, shipmentPresentationStatus } from "./status";
import { runParcelWebRead } from "./sync";
import { asPlainObject, cleanScalarText } from "./value-guards";
import { jdDiagnosticPage, writeDiagnostic, type DiagnosticDetails } from "./logger";

const PDD_ORDERS = "https://mobile.yangkeduo.com/orders.html";

type JdSyncStage = "jd_sync_queue" | "jd_sync_session" | "jd_sync_viewport" | "jd_sync_orders"
  | "jd_sync_document" | "jd_sync_load_failed" | "jd_sync_script" | "jd_sync_unexpected_page"
  | "jd_sync_order_navigation" | "jd_sync_order_entry" | "jd_sync_order_cards" | "jd_sync_detail" | "jd_sync_save";
type JdPageDetails = Pick<DiagnosticDetails, "jdPage" | "jdNativeLoad">;
type ReportStage = (stage: JdSyncStage, page?: JdPageDetails) => void;

const JD_ACCOUNT_PAGE_CHECK = String.raw`
  if (window !== window.top || location.protocol === 'about:') {
    return { state: 'pending', stage: 'jd_sync_document' };
  }
  if (location.protocol === 'https:' && !location.port &&
    ['plogin.m.jd.com','passport.jd.com'].includes(location.hostname)) {
    return { state: 'expired', scheme: location.protocol, hostname: location.hostname };
  }
`;

// Follow JdAccountActivity.READ_ORDERS: use the order cards or entry before classifying page text.
const READ_JD_ORDERS = JD_ACCOUNT_PAGE_CHECK + String.raw`
  if (!['https://my.m.jd.com','https://trade.m.jd.com','https://home.m.jd.com'].includes(location.origin)) {
    return { state: 'pending', stage: 'jd_sync_unexpected_page', scheme: location.protocol, hostname: location.hostname };
  }
  const text = el => (el?.textContent || '').trim();
  const nickname = text(document.querySelector('.my_header_name'));
  if (nickname && nickname !== '京东用户') window.__pipiDeliveriesJDName = nickname;
  const states = Array.from(document.querySelectorAll('[class*="order_state"]'));
  if (!states.length) {
    const entry = document.querySelector('.my_order_entrance.type_orders') ||
      Array.from(document.querySelectorAll('div,span,a,button')).filter(el =>
        text(el) === '全部订单' && el.children.length < 3 && el.getClientRects().length).pop();
    if (entry && !window.__pipiDeliveriesJDOpened) {
      window.__pipiDeliveriesJDOpened = true;
      entry.click();
      return { state: 'pending', stage: 'jd_sync_order_navigation' };
    }
    const body = document.body?.innerText || '';
    if (/暂时没有相关订单|暂无相关订单|没有找到相关订单/.test(body)) return { orders: [] };
    if (/快速验证|验证一下|滑动验证|人机验证|安全验证/.test(body)) return { state: 'verification' };
    if (/大促异常火爆|稍后再试/.test(body)) return { state: 'unavailable' };
    return { state: 'pending', stage: window.innerWidth === 0 || window.innerHeight === 0
      ? 'jd_sync_viewport' : window.__pipiDeliveriesJDOpened
        ? 'jd_sync_order_navigation' : document.readyState === 'complete' ? 'jd_sync_order_entry' : 'jd_sync_orders' };
  }
  const orders = [], seen = new Set();
  for (const state of states) {
    let card = state.parentElement;
    while (card && !card.querySelector('[class*="order_item"]')) card = card.parentElement;
    if (!card || card.querySelectorAll('[class*="order_state"]').length !== 1) continue;
    const data = Array.from(card.querySelectorAll('[data-eparam]')).map(el => {
      try { return JSON.parse(el.getAttribute('data-eparam').replace(/&quot;/g,'"')); }
      catch (_) { return null; }
    }).find(entry => /^[0-9]{8,32}$/.test(String(entry?.orderid || '')));
    if (!data || seen.has(String(data.orderid))) continue;
    seen.add(String(data.orderid));
    const titles = new Set(Array.from(card.querySelectorAll('[class*="order_item"] [class*="desc"]')).map(text).filter(Boolean));
    const sku = data.orderSkus?.[0] || {};
    orders.push({ orderId: String(data.orderid), title: titles.size === 1 && (data.orderSkus?.length || 0) <= 1 ? [...titles][0] : '',
      forecast: text(card.querySelector('[class*="order_wuliubar"]')), state: text(state),
      skuId: String(sku.skuid || data.skuid || ''), shopId: String(data.shopId || sku.shopid || data.shopid || '') });
  }
  return orders.length ? { orders, nickname: window.__pipiDeliveriesJDName || nickname }
    : { state: 'pending', stage: 'jd_sync_order_cards' };
`;

function readJdParcel(order: string) {
  return JD_ACCOUNT_PAGE_CHECK + String.raw`
    if (location.origin !== 'https://trade.m.jd.com' ||
      location.pathname !== '/order/deal_wuliu_jdm.shtml' ||
      new URLSearchParams(location.search).get('dealId') !== ` + JSON.stringify(order) + String.raw`) return null;
    const text = (document.body?.innerText || '').split('可能您还想要')[0];
    const numbers = new Set(Array.from(text.matchAll(/(?:运单号|快递单号|物流单号)\s*[:：]?\s*([A-Za-z0-9-]{8,})/g), item => item[1]));
    const title = text.match(/我要催单\s*([\s\S]{4,160}?)\s*(?:\d+\s*件|国内承运人|承运人|运单号|$)/);
    const codes = new Set(Array.from(text.matchAll(/(?:取件码|提货码|取货码|凭码|自提码)[:：\s]*([A-Za-z0-9-]{3,12})(?![A-Za-z0-9-])/g), item => item[1]));
    return numbers.size === 1 && (title || codes.size === 1) ?
      { waybill: [...numbers][0], title: title ? title[1].trim() : '', code: codes.size === 1 ? [...codes][0] : '' } : null;
  `;
}

const PDD_WAYBILL_FIELDS = ["tracking_number", "trackingNumber", "tracking_no", "mailNo", "mail_no",
  "express_no", "expressNo", "logistics_no", "waybillNo", "waybill_no", "delivery_no"];
const PDD_ORDER_FIELDS = ["order_sn", "orderSn", "order_id", "orderId", "mall_order_sn"];
const CAPTURE_PDD_ORDERS = `(() => {
  if (window !== window.top || location.origin !== 'https://mobile.yangkeduo.com') return;
  const waybillKeys = ${JSON.stringify(PDD_WAYBILL_FIELDS)};
  const orderKeys = ${JSON.stringify(PDD_ORDER_FIELDS)};
  const paths = new Set(['/proxy/api/api/aristotle/order_list_v3','/proxy/api/api/aristotle/order_list_v4','/proxy/api/api/express_trackbox/list']);
  const output = window.__pipiDeliveriesPddOrders = [];
  const field = (object, keys) => {
    for (const key of keys) {
      const value = object?.[key];
      if (typeof value === 'string' || typeof value === 'number') {
        const text = String(value).trim();
        if (text) return text;
      }
    }
    return '';
  };
  let bytes = 0;
  function scan(value, order, depth) {
    if (!value || typeof value !== 'object' || depth > 32) return;
    if (!Array.isArray(value)) {
      order = field(value, orderKeys) || order;
      const waybill = field(value, waybillKeys);
      if (waybill.length >= 5 && waybill.length <= 64) {
        const title = field(value.order_goods?.[0], ['goods_name','goods_title']).slice(0, 512);
        output.push({ waybill, orderId: order, title, forecast: typeof value.timeForecast === 'string' ? value.timeForecast.slice(0, 100) : '' });
      }
    }
    Object.values(value).forEach(child => scan(child, order, depth + 1));
  }
  function approved(address) {
    const url = new URL(address, location.href);
    return url.origin === location.origin && paths.has(url.pathname) && !url.username && !url.password;
  }
  function keep(address, text) {
    if (!approved(address) || typeof text !== 'string' || bytes + text.length > 2097152) return;
    try {
      const value = JSON.parse(text);
      const code = String(value.error_code ?? '');
      if (value.success === false || !['', '0', '1000000'].includes(code)) return;
      bytes += text.length;
      scan(value, '', 0);
      window.__pipiDeliveriesPddSuccess = true;
    } catch (_) {}
  }
  const fetchPage = window.fetch;
  window.fetch = function (...args) {
    return fetchPage.apply(this, args).then(response => {
      if (response.ok && approved(response.url)) response.clone().text().then(text => keep(response.url, text)).catch(() => {});
      return response;
    });
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      if (this.status >= 200 && this.status < 300 && approved(this.responseURL) &&
        (this.responseType === '' || this.responseType === 'text')) keep(this.responseURL, this.responseText);
      else if (this.status >= 200 && this.status < 300 && approved(this.responseURL) && this.responseType === 'json') {
        keep(this.responseURL, JSON.stringify(this.response));
      }
    }, { once: true });
    return send.apply(this, args);
  };
})();`;

function assertCurrent(platform: WebPlatform, session: PlatformSession) {
  if (!projectionSceneActive() || !currentPlatformSession(platform, session.generation)) throw new PlatformWireError("changed");
}

async function saveJdCookies(web: WebViewController, generation: string, deadline: number): Promise<void> {
  const current = currentPlatformSession("jingdong", generation);
  if (current?.credentials.kind !== "web") throw new PlatformWireError("changed");
  const cookies = await verifiedJdCookies(web, current, deadline);
  replacePlatformCookies("jingdong", generation, current.credentials.cookies, cookies);
}

async function withProviderPage<T>(
  platform: WebPlatform, session: PlatformSession,
  read: (controller: WebViewController, deadline: number, reportStage: ReportStage) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + 30_000;
  let stage: JdSyncStage = "jd_sync_queue";
  let pageDetails: JdPageDetails | undefined;
  try {
    return await runParcelWebRead(async () => {
      assertCurrent(platform, session);
      if (session.credentials.kind !== "web") throw new PlatformWireError("changed");
      stage = "jd_sync_session";
      const web = platform === "jingdong" ? await jdSyncView(session, deadline)
        : await openProviderController(platform, session.credentials.cookies);
      try {
        stage = "jd_sync_viewport";
        if (!await waitForRefresh(acquireProjectionViewport(web), deadline)) throw new PlatformWireError("unavailable");
        const capture = read(web, deadline, (next, page) => {
          stage = next;
          pageDetails = page;
        });
        if (platform !== "jingdong") return await capture;
        return await capture.finally(async () => {
          // A failed order read can still renew cookies in the native browser.
          // Commit them before the isolated controller is lost at script exit.
          const saveDeadline = Math.min(deadline, Date.now() + 1_000);
          if (!projectionSceneActive() || Date.now() >= saveDeadline) return;
          try {
            await saveJdCookies(web, session.generation, saveDeadline);
          } catch (error) {
            if (error instanceof PlatformWireError && error.reason === "changed") return;
            writeDiagnostic("platform.jingdong.session.save_failed", {
              stage: "jd_sync_session",
              result: error instanceof OperationTimeoutError ? "timeout" : "unavailable",
            }, "warning");
          }
        });
      } finally {
        releaseProjectionViewport();
        if (platform !== "jingdong") web.dispose();
      }
    }, deadline);
  } catch (error) {
    if (platform === "jingdong") {
      writeDiagnostic("platform.jingdong.sync.failed", {
        stage,
        ...pageDetails,
        ...(error instanceof OperationTimeoutError ? error.waitDetails : undefined),
        result: error instanceof OperationTimeoutError ? "timeout"
          : error instanceof PlatformWireError ? error.reason : "failed",
      }, "warning");
    }
    throw error;
  }
}

async function pageResult(platform: WebPlatform, session: PlatformSession, web: WebViewController,
  url: string, script: string, deadline: number, reportStage?: ReportStage): Promise<unknown> {
  assertCurrent(platform, session);
  const pageDeadline = Math.min(deadline, Date.now() + 12_000);
  let jdNativeLoad: NonNullable<DiagnosticDetails["jdNativeLoad"]> = "pending";
  const loadRejected = () => jdNativeLoad === "returned_false" || jdNativeLoad === "rejected";
  let committedDocument = false;
  if (platform === "jingdong") {
    // The same browser can still display the previous order page until navigation commits.
    await waitForRefresh(web.evaluateJavaScript("window.__pipiDeliveriesPreviousJDPage = true; return true;"),
      Math.min(pageDeadline, Date.now() + 1_000)).catch(() => undefined);
    assertCurrent(platform, session);
    script = "if (window.__pipiDeliveriesPreviousJDPage === true) return {state:'pending',stage:'jd_sync_document'};\n" + script;
    reportStage?.("jd_sync_document");
  }
  const load = web.loadURL(url);
  if (platform === "jingdong") {
    // Like Pipi's JD probe, accept the matching document as soon as it renders.
    void load.then((loaded) => { jdNativeLoad = loaded ? "returned_true" : "returned_false"; },
      () => { jdNativeLoad = "rejected"; });
  } else if (!await waitForRefresh(load, pageDeadline)) {
    throw new PlatformWireError("unavailable");
  }
  while (Date.now() < pageDeadline) {
    assertCurrent(platform, session);
    let value: unknown;
    try {
      value = await waitForRefresh(web.evaluateJavaScript<unknown>(script), pageDeadline);
    } catch (error) {
      assertCurrent(platform, session);
      if (platform === "jingdong") {
        reportStage?.(loadRejected() && !committedDocument ? "jd_sync_load_failed" : "jd_sync_script", { jdNativeLoad });
      }
      if (error instanceof OperationTimeoutError) throw error;
      value = null;
    }
    if (value != null) {
      assertCurrent(platform, session);
      const { state, stage, scheme, hostname } = asPlainObject(value);
      if (state === "expired") {
        if (platform === "jingdong") reportStage?.("jd_sync_session", { jdNativeLoad, jdPage: jdDiagnosticPage(scheme, hostname) });
        clearPlatformLogin(platform, session.generation, true);
        throw new PlatformWireError("expired");
      }
      if (state === "verification" || state === "unavailable") throw new PlatformWireError(state);
      if (state !== "pending") return value;
      if (stage === "jd_sync_document") {
        reportStage?.(loadRejected() ? "jd_sync_load_failed" : stage, { jdNativeLoad });
      } else if (stage === "jd_sync_viewport" || stage === "jd_sync_orders" || stage === "jd_sync_order_navigation" ||
        stage === "jd_sync_order_entry" || stage === "jd_sync_order_cards" || stage === "jd_sync_unexpected_page") {
        committedDocument = true;
        reportStage?.(stage, {
          jdNativeLoad,
          ...(stage === "jd_sync_unexpected_page" ? { jdPage: jdDiagnosticPage(scheme, hostname) } : undefined),
        });
      }
    }
    await pauseWhileActive(250);
  }
  if (platform === "jingdong") {
    if (loadRejected() && !committedDocument) reportStage?.("jd_sync_load_failed", { jdNativeLoad });
    throw new OperationTimeoutError();
  }
  throw new PlatformWireError("unavailable");
}

export async function fetchJdParcels(
  session: PlatformSession, shipments: readonly Shipment[], saveOrderFields: (fields: PlatformParcel[]) => void,
) {
  const jdOrders = new Map(shipments.filter((shipment) =>
    shipment.identity.accountOrder && shipment.identity.sourceProvider?.toLowerCase() === "jingdong")
    .map((shipment) => [shipment.identity.orderId || shipment.identity.sourceId, shipment]));
  const waiting = new Set(shipments.filter((shipment) => shipmentPresentationStatus(shipment).semantic === "WAITING_PICKUP")
    .map(displayWaybill).filter(Boolean));
  return withProviderPage("jingdong", session, async (web, deadline, reportStage) => {
    const now = Date.now();
    reportStage("jd_sync_orders");
    const result = asPlainObject(await pageResult("jingdong", session, web, JD_ORDERS_PAGE, READ_JD_ORDERS, deadline, reportStage));
    reportStage("jd_sync_session");
    await saveJdCookies(web, session.generation, deadline);
    const orders = objectList(result.orders).flatMap((row) => {
      const order = cleanScalarText(row.orderId);
      return /^\d{8,32}$/.test(order) ? [{ row, order, associated: jdOrders.get(order), title: productTitle(row.title) }] : [];
    });
    const orderFields = orders.flatMap(({ row, order, associated, title }) => associated ? [{
        source: "jingdong", waybill: "", orderIds: [order], title, estimate: deliveryForecast(row.forecast, now),
    } as const] : []);
    if (orderFields.length) {
      // As in Pipi, a slower logistics page must not hold up verified order-card fields.
      reportStage("jd_sync_save");
      saveOrderFields(orderFields);
    }
    const parcels: PlatformParcel[] = [];
    for (const { row, order, associated, title } of orders) {
      if (Date.now() >= deadline || (!(associated && !title) &&
        !(waiting.size && /待收货|待取件|配送中|派送中|运输中/.test(cleanScalarText(row.state))))) continue;
      const digits = (value: unknown) => /^\d{1,32}$/.test(cleanScalarText(value)) ? cleanScalarText(value) : "";
      const url = "https://trade.m.jd.com/order/deal_wuliu_jdm.shtml?from=orderdetail&dealState=7&dealId=" + order +
        "&orderType=22&skuid=" + digits(row.skuId) + "&shopid=" + digits(row.shopId) + "&source=m_inner_orderList.track_orderTrack";
      reportStage("jd_sync_detail");
      const match = asPlainObject(await pageResult("jingdong", session, web, url, readJdParcel(order), deadline).catch((error) => {
        if (error instanceof PlatformWireError && error.reason !== "unavailable") throw error;
        return null;
      }));
      const waybill = normalizeWaybill(cleanScalarText(match.waybill));
      if (!waybill) continue;
      const parcelTitle = associated && displayWaybill(associated) === waybill && !title ? productTitle(match.title) : "";
      const code = waiting.has(waybill) ? platformPickupCode(match.code, waybill) : "";
      if (parcelTitle || code) {
        parcels.push({ source: "jingdong", waybill, title: parcelTitle, code });
        if (code) waiting.delete(waybill);
      }
    }
    return { parcels, nickname: cleanScalarText(result.nickname) };
  });
}

export async function fetchPddOrders(session: PlatformSession): Promise<PlatformParcel[]> {
  return withProviderPage("pinduoduo", session, async (web, deadline) => {
    const supportsScripts = web as WebViewController & {
      addUserScript?: (options: { source: string; injectionTime: "documentStart"; forMainFrameOnly: boolean }) => Promise<string>;
    };
    if (!supportsScripts.addUserScript) throw new PlatformWireError("unavailable");
    await waitForRefresh(supportsScripts.addUserScript({ source: CAPTURE_PDD_ORDERS, injectionTime: "documentStart", forMainFrameOnly: true }), deadline);
    const response = await pageResult("pinduoduo", session, web, PDD_ORDERS, String.raw`
      if (window !== window.top || location.origin !== 'https://mobile.yangkeduo.com') return null;
      if (/login\.html|passport/.test(location.pathname)) return { state: 'expired' };
      if (/安全验证|滑动验证/.test(document.body?.innerText || '')) return { state: 'verification' };
      return window.__pipiDeliveriesPddSuccess ? window.__pipiDeliveriesPddOrders : null;
    `, deadline);
    const orders = new Map<string, PlatformParcel>();
    const conflicts = new Set<string>();
    for (const item of objectList(response)) {
      const waybill = normalizeWaybill(cleanScalarText(item.waybill));
      const id = cleanScalarText(item.orderId);
      if (!waybill || waybill.length < 6 || waybill === normalizeWaybill(id)) continue;
      const previous = orders.get(waybill);
      if (previous?.orderIds?.length && id && !previous.orderIds.includes(id)) conflicts.add(waybill);
      orders.set(waybill, {
        source: "pinduoduo", waybill, orderIds: id ? [id] : previous?.orderIds,
        title: productTitle(item.title) || previous?.title,
        estimate: deliveryForecast(item.forecast, Date.now()) || previous?.estimate,
      });
    }
    return [...orders.values()].filter(({ waybill }) => !conflicts.has(waybill));
  });
}
