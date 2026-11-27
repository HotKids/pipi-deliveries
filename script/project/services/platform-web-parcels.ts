import type { AbortSignal } from "scripting";
import type { Shipment } from "../models";
import { OperationTimeoutError, pauseWhileActive, waitForRefresh } from "./deadline";
import {
  currentPlatformSession, clearPlatformLogin, needsJdNickname, replacePlatformCookies, saveJdNickname,
  type PlatformSession, type WebPlatform,
} from "./platform-accounts";
import { deliveryForecast, objectList, pddParcelDetailPath, productTitle, uniqueDeliveryForecast,
  type PddTrace, type PlatformParcel } from "./platform-parcel-data";
import {
  JD_ORDERS_PAGE, JD_ORDER_LIST_URL, jdLoginProof, jdSyncView, openProviderController, PlatformWireError, verifiedJdCookies,
} from "./platform-wire";
import { platformPickupCode } from "./fengchao-account";
import { pddProductImageURL } from "./product-image-url";
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
    ['plogin.m.jd.com','passport.jd.com','passport.m.jd.com'].includes(location.hostname)) {
    return { state: 'expired', scheme: location.protocol, hostname: location.hostname };
  }
`;

// Follow JdAccountActivity.READ_ORDERS: use the order cards or entry before classifying page text.
const READ_JD_PROFILE = String.raw`
  if (window !== window.top || location.protocol === 'about:') return null;
  if (!['https://my.m.jd.com','https://home.m.jd.com'].includes(location.origin)) return { nickname: '' };
  const nickname = (document.querySelector('.my_header_name')?.textContent || '').trim();
  return nickname && nickname !== '京东用户' ? { nickname } : null;
`;

const READ_JD_ORDERS = JD_ACCOUNT_PAGE_CHECK + String.raw`
  if (!['https://my.m.jd.com','https://trade.m.jd.com','https://home.m.jd.com','https://o.m.jd.com'].includes(location.origin)) {
    return { state: 'pending', stage: 'jd_sync_unexpected_page', scheme: location.protocol, hostname: location.hostname };
  }
  if (location.origin === 'https://o.m.jd.com') {
    const appRoot = typeof document.getElementById === 'function' ? document.getElementById('app') : document.querySelector?.('#app');
    let store = null;
    if (appRoot) {
      const rootKeys = Object.keys(appRoot).filter(k => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'));
      const queue = rootKeys.map(k => appRoot[k]).filter(Boolean);
      const visited = new Set();
      let steps = 0;
      while (queue.length && steps < 300 && !store) {
        const fiber = queue.shift();
        if (!fiber || typeof fiber !== 'object' || visited.has(fiber)) continue;
        visited.add(fiber);
        steps++;
        const candidates = [fiber.memoizedProps?.value];
        for (let ctx = fiber.dependencies?.firstContext; ctx; ctx = ctx.next) {
          candidates.push(ctx.memoizedValue, ctx.context?._currentValue);
        }
        for (const val of candidates) {
          if (typeof val?.state === 'function' && val.state()?.orderList) {
            store = val;
            break;
          }
        }
        if (!store) {
          if (fiber.child) queue.push(fiber.child);
          if (fiber.sibling) queue.push(fiber.sibling);
          if (fiber.current) queue.push(fiber.current);
        }
      }
    }
    if (store) {
      const ol = store.state()?.orderList;
      if (ol?.status === 3) {
        return { state: 'expired', scheme: location.protocol, hostname: location.hostname };
      }
      const fnId = ol?.params?.functionId || 'newUserAllOrderList';
      if (ol?.status === 0 && (
        Number(ol?.listQurTime?.[fnId]) > 0 ||
        (!ol?.loading && Array.isArray(ol?.data?.orderList?.[fnId]) && ol?.subTabMap?.[fnId]?.isLoading === false)
      )) {
        const raw = Array.isArray(ol?.data?.orderList?.[fnId]) ? ol.data.orderList[fnId] : [];
        const orders = [], seen = new Set();
        for (const item of raw) {
          const orderId = String(item?.orderId || '').trim();
          if (!/^[0-9]{8,32}$/.test(orderId) || seen.has(orderId)) continue;
          seen.add(orderId);
          const wares = Array.isArray(item?.orderMsg?.wareInfoList) ? item.orderMsg.wareInfoList : [];
          const sku = wares[0] || {};
          const title = wares.length === 1 && !item?.isVirtualOrder ? String(sku.wname || '').trim() : '';
          const tp = item?.trackProgress || (Array.isArray(item?.trackProgressList) ? item.trackProgressList[0] : null) || item?.stepFloor || {};
          const forecast = [tp?.title, tp?.subTitle, tp?.message]
            .map(v => typeof v === 'string' ? v.trim() : '')
            .filter(Boolean)
            .join(' ');
          const state = String(item?.orderStatusShow || item?.orderStatusInfo?.stateTip || '').trim();
          orders.push({
            orderId,
            title,
            forecast,
            state,
            skuId: String(sku.wareId || sku.skuId || ''),
            shopId: String(item?.shopId || ''),
          });
        }
        return { orders };
      }
    }
  }
  const text = el => (el?.textContent || '').trim();
  const states = Array.from(document.querySelectorAll('[class*="order_state"]'));
  if (!states.length) {
    const entry = document.querySelector('.my_order_entrance.type_orders') ||
      Array.from(document.querySelectorAll('div,span,a,button')).filter(el =>
        text(el) === '全部订单' && el.children.length < 3 && el.getClientRects().length).pop();
    if (entry && !window.__pipiDeliveriesJDOpened) {
      window.__pipiDeliveriesJDOpened = true;
      // The account-page action can choose a regional order host from the exit IP.
      location.assign(${JSON.stringify(JD_ORDER_LIST_URL)});
      return { state: 'pending', stage: 'jd_sync_order_navigation' };
    }
    const body = document.body?.innerText || '';
    if (/暂时没有相关订单|暂无相关订单|没有找到相关订单|没有相关订单|没有筛选到相关订单/.test(body)) return { orders: [] };
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
  return orders.length ? { orders }
    : { state: 'pending', stage: 'jd_sync_order_cards' };
`;

function readJdParcel(order: string) {
  return JD_ACCOUNT_PAGE_CHECK + String.raw`
    if (location.origin !== 'https://trade.m.jd.com' || location.pathname !== '/order/deal_wuliu_jdm.shtml') return null;
    const orderIds = new URLSearchParams(location.search).getAll('dealId');
    if (orderIds.length !== 1 || orderIds[0] !== ` + JSON.stringify(order) + String.raw`) return null;
    const text = (document.body?.innerText || '').split('可能您还想要')[0];
    const summary = document.querySelector('[class*="Summary-module__m___"]');
    const copies = summary?.querySelectorAll('[class*="Summary-module__copy___"][data-copy-cont]') || [];
    const waybills = new Set(Array.from(copies, node => (node.getAttribute('data-copy-cont') || '').trim())
      .filter(value => /^[A-Za-z0-9-]{8,}$/.test(value)));
    const structured = waybills.size > 0;
    if (!structured) {
      for (const item of text.matchAll(/(?:运单号|快递单号|物流单号)\s*[:：]?\s*([A-Za-z0-9-]{8,})/g)) {
        waybills.add(item[1]);
      }
    }
    const titles = new Set(Array.from(
      summary?.querySelectorAll('[class*="Summary-module__single___"] [class*="Summary-module__text___"]') || [],
      node => (node.textContent || '').trim()).filter(Boolean));
    const title = structured ? (titles.size === 1 ? [...titles][0] : '')
      : (text.match(/我要催单\s*([\s\S]{4,160}?)\s*(?:\d+\s*件|国内承运人|承运人|运单号|$)/)?.[1] || '').trim();
    const codes = new Set(Array.from(text.matchAll(/(?:取件码|提货码|取货码|凭码|自提码)[:：\s]*([A-Za-z0-9-]{3,12})(?![A-Za-z0-9-])/g), item => item[1]));
    const header = text.split(/\b\d{4}(?:[-/]\d{1,2}[-/]\d{1,2}|年\d{1,2}月\d{1,2}日)/, 1)[0];
    const estimates = new Set(header.match(/预计[^\r\n。；;]{1,70}?送达/g) || []);
    const forecast = estimates.size === 1 ? [...estimates][0] : '';
    return waybills.size === 1 && (structured || title || forecast || codes.size === 1) ?
      { waybill: [...waybills][0], title, forecast, code: codes.size === 1 ? [...codes][0] : '' } : null;
  `;
}

function jdParcelURL(order: string, skuId?: unknown, shopId?: unknown): string {
  const digits = (value: unknown) => /^\d{1,32}$/.test(cleanScalarText(value)) ? cleanScalarText(value) : "";
  return "https://trade.m.jd.com/order/deal_wuliu_jdm.shtml?from=orderdetail&dealState=7&dealId=" + order +
    "&orderType=22&skuid=" + digits(skuId) + "&shopid=" + digits(shopId) + "&source=m_inner_orderList.track_orderTrack";
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
  function shippingId(row, waybill) {
    if (typeof row.jump_url === 'string') {
      const jump = new URL(row.jump_url, location.href);
      if (jump.origin === location.origin && !jump.username && !jump.password &&
        jump.pathname === '/psnl_goods_help.html' && jump.searchParams.getAll('shipping_id').length === 1 &&
        jump.searchParams.getAll('tracking_number').length === 1 &&
        (jump.searchParams.get('tracking_number') || '').toUpperCase().replace(/[^A-Z0-9]/g, '') ===
          waybill.toUpperCase().replace(/[^A-Z0-9]/g, '')) {
        const id = jump.searchParams.get('shipping_id');
        if (/^[1-9][0-9]{0,19}$/.test(id)) return id;
      }
    }
    return field(row, ['shipping_id']);
  }
  function extractTraces(row) {
    const raw = row?.shipping?.traces ?? row?.traces ?? row?.express_traces ?? row?.track_list;
    if (!Array.isArray(raw)) return undefined;
    const out = [];
    for (const item of raw.slice(0, 100)) {
      const time = field(item, ['time', 'ftime', 'accept_time', 'status_time']);
      const info = field(item, ['info', 'context', 'desc', 'status_desc', 'detail']);
      if (time && info) out.push({ time: time.slice(0, 64), info: info.slice(0, 2000) });
    }
    return out.length ? out : undefined;
  }
  function jumpOrderId(row) {
    if (typeof row?.jump_url !== 'string') return '';
    try {
      const jump = new URL(row.jump_url, location.href);
      if (jump.origin !== location.origin || jump.username || jump.password) return '';
      for (const key of orderKeys) {
        const values = jump.searchParams.getAll(key).map(v => v.trim()).filter(Boolean);
        if (values.length === 1) return values[0];
      }
    } catch (_) {}
    return '';
  }
  function scan(value, order, depth) {
    if (!value || typeof value !== 'object' || depth > 32) return;
    if (!Array.isArray(value)) {
      order = field(value, orderKeys) || jumpOrderId(value) || order;
      const waybill = field(value, waybillKeys);
      if (waybill.length >= 5 && waybill.length <= 64) {
        const title = field(value.order_goods?.[0], ['goods_name','goods_title']).slice(0, 512);
        let id = '';
        try { id = shippingId(value, waybill); } catch (_) {}
        const traces = extractTraces(value);
        output.push({ waybill, orderId: order, shippingId: id, title, forecast: typeof value.timeForecast === 'string' ? value.timeForecast.slice(0, 100) : '', ...(traces ? { traces } : {}) });
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

function assertCurrent(platform: WebPlatform, session: PlatformSession, signal?: AbortSignal) {
  if (signal?.aborted || !projectionSceneActive() || !currentPlatformSession(platform, session.generation)) throw new PlatformWireError("changed");
}

export function fetchJdParcelDetails(session: PlatformSession, order: string, waybill: string,
  eligible: () => boolean, signal?: AbortSignal): Promise<PlatformParcel | undefined> {
  if (!/^\d{8,32}$/.test(order)) return Promise.resolve(undefined);
  return withProviderPage("jingdong", session, async (web, deadline) => {
    if (!eligible()) return undefined;
    const row = asPlainObject(await pageResult("jingdong", session, web, jdParcelURL(order), readJdParcel(order), deadline,
      undefined, undefined, signal));
    if (normalizeWaybill(cleanScalarText(row.waybill)) !== waybill) return undefined;
    return { source: "jingdong", waybill, title: productTitle(row.title), estimate: deliveryForecast(row.forecast, Date.now()) };
  }, signal);
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
  signal?: AbortSignal,
  priority: "interactive" | "background" = signal ? "interactive" : "background",
): Promise<T> {
  const deadline = Date.now() + 30_000;
  let stage: JdSyncStage = "jd_sync_queue";
  let pageDetails: JdPageDetails | undefined;
  try {
    return await runParcelWebRead(async () => {
      assertCurrent(platform, session, signal);
      if (session.credentials.kind !== "web") throw new PlatformWireError("changed");
      stage = "jd_sync_session";
      const web = platform === "jingdong" ? await jdSyncView(session, deadline, signal)
        : await openProviderController(platform, session.credentials.cookies, "default", signal ? deadline : undefined, signal);
      try {
        stage = "jd_sync_viewport";
        if (!await waitForRefresh(acquireProjectionViewport(web), deadline, signal)) throw new PlatformWireError("unavailable");
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
    }, deadline, signal, priority);
  } catch (error) {
    if (platform === "jingdong" && !signal?.aborted) {
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
  url: string, script: string, deadline: number, reportStage?: ReportStage,
  keepPartial?: (value: unknown) => boolean, signal?: AbortSignal): Promise<unknown> {
  assertCurrent(platform, session, signal);
  const pageDeadline = Math.min(deadline, Date.now() + 12_000);
  let jdNativeLoad: NonNullable<DiagnosticDetails["jdNativeLoad"]> = "pending";
  const loadRejected = () => jdNativeLoad === "returned_false" || jdNativeLoad === "rejected";
  let committedDocument = false;
  if (platform === "jingdong") {
    // The same browser can still display the previous order page until navigation commits.
    await waitForRefresh(web.evaluateJavaScript("window.__pipiDeliveriesPreviousJDPage = true; return true;"),
      Math.min(pageDeadline, Date.now() + 1_000), signal).catch(() => undefined);
    assertCurrent(platform, session, signal);
    script = "if (window.__pipiDeliveriesPreviousJDPage === true) return {state:'pending',stage:'jd_sync_document'};\n" + script;
    reportStage?.("jd_sync_document");
  }
  const load = web.loadURL(url);
  if (platform === "jingdong") {
    // Like Pipi's JD probe, accept the matching document as soon as it renders.
    void load.then((loaded) => { jdNativeLoad = loaded ? "returned_true" : "returned_false"; },
      () => { jdNativeLoad = "rejected"; });
  } else if (!await waitForRefresh(load, pageDeadline, signal)) {
    throw new PlatformWireError("unavailable");
  }
  let partial: unknown;
  while (Date.now() < pageDeadline) {
    assertCurrent(platform, session, signal);
    let value: unknown;
    try {
      value = await waitForRefresh(web.evaluateJavaScript<unknown>(script), pageDeadline, signal);
    } catch (error) {
      assertCurrent(platform, session, signal);
      if (platform === "jingdong") {
        reportStage?.(loadRejected() && !committedDocument ? "jd_sync_load_failed" : "jd_sync_script", { jdNativeLoad });
      }
      if (error instanceof OperationTimeoutError) {
        if (partial !== undefined) return partial;
        throw error;
      }
      value = null;
    }
    if (value != null) {
      assertCurrent(platform, session, signal);
      const { state, stage, scheme, hostname } = asPlainObject(value);
      if (state === "expired") {
        if (platform === "jingdong") reportStage?.("jd_sync_session", { jdNativeLoad, jdPage: jdDiagnosticPage(scheme, hostname) });
        clearPlatformLogin(platform, session.generation, true);
        throw new PlatformWireError("expired");
      }
      if (state === "verification" || state === "unavailable") throw new PlatformWireError(state);
      if (state !== "pending") return value;
      if (keepPartial?.(value)) partial = value;
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
    await pauseWhileActive(250, signal);
  }
  if (partial !== undefined) {
    assertCurrent(platform, session);
    return partial;
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
    const active = currentPlatformSession("jingdong", session.generation);
    if (active?.credentials.kind === "web" && needsJdNickname(active.label)) {
      // Pipi reads the nickname on the account page. Give it its own brief window
      // so an unavailable profile never sends the order read to a regional host.
      const profileDeadline = Math.min(deadline, now + 3_000);
      const profile = asPlainObject(await pageResult("jingdong", session, web,
        JD_ORDERS_PAGE, READ_JD_PROFILE, profileDeadline).catch((error) => {
        if (error instanceof OperationTimeoutError) return null;
        throw error;
      }));
      const nickname = cleanScalarText(profile.nickname);
      if (nickname && nickname !== jdLoginProof(active.credentials.cookies)?.id) {
        const verified = await verifiedJdCookies(web, active, profileDeadline).catch((error) => {
          if (error instanceof OperationTimeoutError ||
            (error instanceof PlatformWireError && error.reason === "unavailable")) return null;
          throw error;
        });
        if (verified && nickname !== jdLoginProof(verified)?.id) saveJdNickname(active.generation, nickname);
      }
    }
    reportStage("jd_sync_orders");
    const result = asPlainObject(await pageResult("jingdong", session, web, JD_ORDER_LIST_URL, READ_JD_ORDERS, deadline, reportStage));
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
      const url = jdParcelURL(order, row.skuId, row.shopId);
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
    return { parcels };
  });
}

async function addPddCapture(web: WebViewController, source: string, deadline: number, signal?: AbortSignal) {
  const supported = web as WebViewController & {
    addUserScript?: (options: { source: string; injectionTime: "documentStart"; forMainFrameOnly: boolean }) => Promise<string>;
  };
  if (!supported.addUserScript) throw new PlatformWireError("unavailable");
  await waitForRefresh(supported.addUserScript({ source, injectionTime: "documentStart", forMainFrameOnly: true }), deadline, signal);
}

export async function presentPddParcelH5(appURL: string, session: PlatformSession,
  isCurrent: () => boolean, signal: AbortSignal): Promise<boolean> {
  const route = new URL(appURL);
  const waybill = route.searchParams.get("tracking_number") ?? "";
  const shippingId = route.searchParams.get("shipping_id") ?? "";
  const path = pddParcelDetailPath(shippingId, waybill);
  if (!path || session.credentials.kind !== "web" || !isCurrent()) throw new PlatformWireError("changed");
  const deadline = Date.now() + 10_000;
  const origin = "https://mobile.yangkeduo.com";
  const web = await openProviderController("pinduoduo", session.credentials.cookies, "default", deadline, signal);
  try {
    const allowsRequest = web.shouldAllowRequest;
    web.shouldAllowRequest = async (request) => !signal.aborted &&
      !!currentPlatformSession("pinduoduo", session.generation) && !!await allowsRequest?.(request);
    // Match the recommendations and expansion controls in Pipi's PddAccountActivity.
    await addPddCapture(web, `(() => {
      if (window !== window.top || location.origin !== '${origin}' ||
          location.pathname !== '/psnl_goods_help.html' ||
          new URLSearchParams(location.search).get('_t_module_name') !== 'assistant_waybill') return;
      const install = () => {
        const style = document.createElement('style');
        style.textContent = '.assistant-waybill .subject-comp-wrap, ' +
          '.assistant-waybill .express-show:has(> .icon-unfold) { display: none !important; }';
        document.head.appendChild(style);
        const expand = () => {
          const buttons = Array.from(document.querySelectorAll(
            '.express-traces-container .express-show > .label-show.icon-folded')).filter(element =>
              (element.innerText || '').trim() === '展开' && element.getClientRects().length &&
              getComputedStyle(element).visibility === 'visible' && !element.closest('a[href]'));
          if (buttons.length !== 1) return;
          observer.disconnect();
          buttons[0].click();
        };
        const observer = new MutationObserver(expand);
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => observer.disconnect(), 10000);
        expand();
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
      else install();
    })()`, deadline, signal);
    const loaded = await waitForRefresh(web.loadURL(origin + path), deadline, signal);
    if (!isCurrent()) throw new PlatformWireError("changed");
    assertCurrent("pinduoduo", session, signal);
    const shown = new URL(web.url ?? "about:blank");
    if (shown.origin === origin && shown.pathname === "/login.html") {
      clearPlatformLogin("pinduoduo", session.generation, true);
      return false;
    }
    if (!loaded || shown.origin !== origin || shown.pathname !== route.pathname ||
        shown.searchParams.get("_t_module_name") !== "assistant_waybill" ||
        shown.searchParams.get("tracking_number") !== waybill || shown.searchParams.get("shipping_id") !== shippingId) {
      throw new PlatformWireError("unavailable");
    }
    await web.present({ fullscreen: true, navigationTitle: "物流详情" });
    return true;
  } finally {
    web.dispose();
  }
}

function sanitizePddTraces(value: unknown): PddTrace[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PddTrace[] = [];
  for (const item of objectList(value).slice(0, 100)) {
    const time = cleanScalarText(item.time);
    const info = cleanScalarText(item.info);
    if (time && info) out.push({ time, info });
  }
  return out.length ? out : undefined;
}

export function fetchPddParcelDetails(session: PlatformSession, shippingId: string, waybill: string,
  needsTitle: boolean, needsEstimate: boolean, needsImage: boolean,
  eligible: () => boolean, signal?: AbortSignal, needsTraces = false): Promise<PlatformParcel | undefined> {
  const detailPath = pddParcelDetailPath(shippingId, waybill);
  if (!detailPath) return Promise.resolve(undefined);
  const url = "https://mobile.yangkeduo.com" + detailPath;
  const route = String.raw`
    if (window !== window.top || location.origin !== 'https://mobile.yangkeduo.com') return;
    const query = new URLSearchParams(location.search);
    const waybill = ${JSON.stringify(waybill)}, shippingId = ${JSON.stringify(shippingId)};
    if (location.pathname !== '/psnl_goods_help.html' || query.get('_t_module_name') !== 'assistant_waybill' ||
      query.getAll('tracking_number').length !== 1 || query.get('tracking_number') !== waybill ||
      query.getAll('shipping_id').length !== 1 || query.get('shipping_id') !== shippingId) return;
  `;
  return withProviderPage("pinduoduo", session, async (web, deadline) => {
    if (!eligible()) return undefined;
    if (needsEstimate || needsImage || needsTraces) await addPddCapture(web, `(() => { ${route}` + String.raw`
      function keep(address, body) {
        const request = new URL(address, location.href);
        if (request.origin !== location.origin || request.pathname !== '/proxy/api/api/express/shipping/track' ||
          request.searchParams.getAll('shipping_id').length !== 1 || request.searchParams.get('shipping_id') !== shippingId ||
          request.searchParams.getAll('tracking_number').length !== 1 ||
          (request.searchParams.get('tracking_number') || '').toUpperCase().replace(/[^A-Z0-9]/g, '') !== waybill ||
          typeof body !== 'string' || body.length > 2097152) return;
        const shipping = JSON.parse(body).shipping;
        if (String(shipping?.shipping_id) !== shippingId ||
          String(shipping?.tracking_number).toUpperCase().replace(/[^A-Z0-9]/g, '') !== waybill) return;
        const thumb = shipping.thumb_url ?? shipping.thumbUrl;
        if (${needsImage} && typeof thumb === 'string' && thumb.trim() && thumb.length <= 2048)
          window.__pipiDeliveriesPddProductImage = thumb;
        const forecast = shipping.time_forecast ?? shipping.timeForecast;
        const fields = forecast && typeof forecast === 'object' ? Object.values(forecast).slice(0, 24) : [forecast];
        window.__pipiDeliveriesParcelForecast = fields.filter(value => typeof value === 'string').map(value => value.slice(0, 256));
        if (${needsTraces} && Array.isArray(shipping.traces)) {
          window.__pipiDeliveriesPddTraces = shipping.traces.slice(0, 100).flatMap(row => {
            const time = typeof row?.time === 'string' ? row.time.trim().slice(0, 64) : '';
            const info = typeof row?.info === 'string' ? row.info.trim().slice(0, 2000) : '';
            return time && info ? [{ time, info }] : [];
          });
        }
      }
      const fetchPage = window.fetch;
      window.fetch = function (...args) {
        return fetchPage.apply(this, args).then(response => {
          if (response.ok && response.url.includes('/express/shipping/track'))
            response.clone().text().then(text => keep(response.url, text)).catch(() => {});
          return response;
        });
      };
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', () => {
          if (this.status < 200 || this.status >= 300 || !this.responseURL.includes('/express/shipping/track')) return;
          try { keep(this.responseURL, this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText); } catch (_) {}
        }, { once: true });
        return send.apply(this, args);
      };
    })();`, deadline, signal);
    if (!eligible()) return undefined;
    const row = asPlainObject(await pageResult("pinduoduo", session, web, url, String.raw`
      if (location.origin === 'https://mobile.yangkeduo.com' && /login\.html|passport/.test(location.pathname)) return { state: 'expired' };
    ` + route + String.raw`
      if (/安全验证|滑动验证/.test(document.body?.innerText || '')) return { state: 'verification' };
      const titles = new Set(Array.from(document.querySelectorAll('.assistant-waybill .move-order-goods .goods-name'),
        node => (node.textContent || '').trim()).filter(Boolean));
      const title = titles.size === 1 ? [...titles][0] : '';
      const forecasts = window.__pipiDeliveriesParcelForecast;
      const image = window.__pipiDeliveriesPddProductImage;
      const traces = window.__pipiDeliveriesPddTraces;
      if (!title && !forecasts && !image && !traces?.length) return null;
      const pending = (${needsTitle} && !title) || (${needsEstimate} && !forecasts?.length) || (${needsImage} && !image) || (${needsTraces} && !traces?.length);
      return { state: pending ? 'pending' : 'complete', waybill, shippingId, title, forecasts, image, traces };
    `, Math.min(deadline, Date.now() + 8_000), undefined, (value) => {
      const row = asPlainObject(value);
      return row.waybill === waybill && row.shippingId === shippingId &&
        (Boolean(productTitle(row.title) || pddProductImageURL(row.image)) ||
          Array.isArray(row.forecasts) && row.forecasts.length > 0 ||
          Array.isArray(row.traces) && row.traces.length > 0);
    }, signal));
    if (row.waybill !== waybill || row.shippingId !== shippingId) return undefined;
    const estimate = uniqueDeliveryForecast(Array.isArray(row.forecasts) ? row.forecasts : [], Date.now());
    const traces = sanitizePddTraces(row.traces);
    return { source: "pinduoduo", waybill, shippingId, title: productTitle(row.title), estimate,
      productImageURL: pddProductImageURL(row.image), ...(traces ? { traces } : {}) };
  }, signal);
}

export async function fetchPddOrders(session: PlatformSession): Promise<PlatformParcel[]> {
  return withProviderPage("pinduoduo", session, async (web, deadline) => {
    await addPddCapture(web, CAPTURE_PDD_ORDERS, deadline);
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
      const shippingId = cleanScalarText(item.shippingId);
      if (!waybill || waybill.length < 6 || waybill === normalizeWaybill(id)) continue;
      const previous = orders.get(waybill);
      if (previous?.orderIds?.length && id && !previous.orderIds.includes(id)) conflicts.add(waybill);
      if (previous?.shippingId && shippingId && previous.shippingId !== shippingId) conflicts.add(waybill);
      const traces = sanitizePddTraces(item.traces);
      const bestTraces = traces && (!previous?.traces || traces.length >= previous.traces.length) ? traces : previous?.traces;
      orders.set(waybill, {
        source: "pinduoduo", waybill, orderIds: id ? [id] : previous?.orderIds,
        shippingId: /^[1-9][0-9]{0,19}$/.test(shippingId) ? shippingId : previous?.shippingId,
        title: productTitle(item.title) || previous?.title,
        estimate: deliveryForecast(item.forecast, Date.now()) || previous?.estimate,
        ...(bestTraces ? { traces: bestTraces } : {}),
      });
    }
    return [...orders.values()].filter(({ waybill }) => !conflicts.has(waybill));
  });
}
