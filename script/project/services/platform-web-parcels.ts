import type { Shipment } from "../models";
import { pauseWhileActive, waitForRefresh } from "./deadline";
import { currentPlatformSession, clearPlatformLogin, type PlatformSession, type WebPlatform } from "./platform-accounts";
import { deliveryForecast, objectList, productTitle, type PlatformParcel } from "./platform-parcel-data";
import { openProviderController, PlatformWireError } from "./platform-wire";
import { platformPickupCode } from "./fengchao-account";
import { acquireProjectionViewport, projectionSceneActive, releaseProjectionViewport } from "./projection-viewport";
import { displayWaybill } from "./shipment-policy";
import { normalizeWaybill, shipmentPresentationStatus } from "./status";
import { runParcelWebRead } from "./sync";
import { asPlainObject, cleanScalarText } from "./value-guards";

const JD_ORDERS = "https://my.m.jd.com/index.html?sceneval=2";
const PDD_ORDERS = "https://mobile.yangkeduo.com/orders.html";

// Keep this projection scoped to the same JD order-card evidence used by JdAccountActivity.
const READ_JD_ORDERS = String.raw`
  if (window !== window.top) return null;
  if (location.hostname === 'plogin.m.jd.com') return { state: 'expired' };
  if (!['https://my.m.jd.com','https://trade.m.jd.com','https://home.m.jd.com'].includes(location.origin)) return null;
  const text = el => (el?.textContent || '').trim();
  const nickname = text(document.querySelector('.my_header_name'));
  if (nickname && nickname !== '京东用户') window.__pipiDeliveriesJDName = nickname;
  const states = Array.from(document.querySelectorAll('[class*="order_state"]'));
  const body = document.body?.innerText || '';
  if (/快速验证|验证一下|滑动验证|人机验证|安全验证/.test(body)) return { state: 'verification' };
  if (!states.length) {
    if (/暂时没有相关订单|暂无相关订单|没有找到相关订单/.test(body)) return { orders: [] };
    const entry = document.querySelector('.my_order_entrance.type_orders') ||
      Array.from(document.querySelectorAll('div,span,a,button')).filter(el =>
        text(el) === '全部订单' && el.children.length < 3 && el.getClientRects().length).pop();
    if (entry && !window.__pipiDeliveriesJDOpened) {
      window.__pipiDeliveriesJDOpened = true;
      entry.click();
    }
    return null;
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
  return orders.length ? { orders, nickname: window.__pipiDeliveriesJDName || nickname } : null;
`;

function readJdParcel(order: string) {
  return String.raw`
    if (window !== window.top || location.origin !== 'https://trade.m.jd.com' ||
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

async function withProviderPage<T>(
  platform: WebPlatform, session: PlatformSession,
  read: (controller: WebViewController, deadline: number) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + 30_000;
  return runParcelWebRead(async () => {
    assertCurrent(platform, session);
    if (session.credentials.kind !== "web") throw new PlatformWireError("changed");
    const web = await openProviderController(platform, session.credentials.cookies);
    try {
      if (!await waitForRefresh(acquireProjectionViewport(web), deadline)) throw new PlatformWireError("unavailable");
      return await read(web, deadline);
    } finally {
      releaseProjectionViewport();
      web.dispose();
    }
  }, deadline);
}

async function pageResult(platform: WebPlatform, session: PlatformSession, web: WebViewController,
  url: string, script: string, deadline: number): Promise<unknown> {
  assertCurrent(platform, session);
  const pageDeadline = Math.min(deadline, Date.now() + 12_000);
  if (!await waitForRefresh(web.loadURL(url), pageDeadline)) throw new PlatformWireError("unavailable");
  while (Date.now() < pageDeadline) {
    assertCurrent(platform, session);
    const value = await waitForRefresh(web.evaluateJavaScript<unknown>(script).catch(() => null), pageDeadline);
    if (value != null) {
      const { state } = asPlainObject(value);
      if (state === "expired") {
        clearPlatformLogin(platform, session.generation, true);
        throw new PlatformWireError("expired");
      }
      if (state === "verification") throw new PlatformWireError("verification");
      return value;
    }
    await pauseWhileActive(250);
  }
  throw new PlatformWireError("unavailable");
}

export async function fetchJdParcels(session: PlatformSession, shipments: readonly Shipment[]) {
  const jdOrders = new Map(shipments.filter((shipment) =>
    shipment.identity.accountOrder && shipment.identity.sourceProvider?.toLowerCase() === "jingdong")
    .map((shipment) => [shipment.identity.orderId || shipment.identity.sourceId, shipment]));
  const waiting = new Set(shipments.filter((shipment) => shipmentPresentationStatus(shipment).semantic === "WAITING_PICKUP")
    .map(displayWaybill).filter(Boolean));
  return withProviderPage("jingdong", session, async (web, deadline) => {
    const now = Date.now();
    const result = asPlainObject(await pageResult("jingdong", session, web, JD_ORDERS, READ_JD_ORDERS, deadline));
    const parcels: PlatformParcel[] = [];
    for (const row of objectList(result.orders)) {
      const order = cleanScalarText(row.orderId);
      if (!/^\d{8,32}$/.test(order)) continue;
      const associated = jdOrders.get(order);
      const title = productTitle(row.title);
      if (associated) parcels.push({
        source: "jingdong", waybill: "", orderIds: [order], title, estimate: deliveryForecast(row.forecast, now),
      });
      if (Date.now() >= deadline || (!(associated && !title) &&
        !(waiting.size && /待收货|待取件|配送中|派送中|运输中/.test(cleanScalarText(row.state))))) continue;
      const digits = (value: unknown) => /^\d{1,32}$/.test(cleanScalarText(value)) ? cleanScalarText(value) : "";
      const url = "https://trade.m.jd.com/order/deal_wuliu_jdm.shtml?from=orderdetail&dealState=7&dealId=" + order +
        "&orderType=22&skuid=" + digits(row.skuId) + "&shopid=" + digits(row.shopId) + "&source=m_inner_orderList.track_orderTrack";
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
