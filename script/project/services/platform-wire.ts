import { fetch, type AbortSignal } from "scripting";
import {
  accountStatus, clearPlatformLogin, cookieHeader, cookiesForURL, cookieValue, currentPlatformSession,
  onPlatformAccountsChanged, providerCookies, replacePlatformCookies, trustedPlatformPage, type IdentityPlatform, type PlatformCookie,
  type PlatformSession, type WebPlatform,
} from "./platform-accounts";
import { utf8Data } from "./scripting-data";
import { asPlainObject, cleanScalarText, isPlainObject, type JsonObject } from "./value-guards";
import { waitForRefresh } from "./deadline";
import { beginDiagnosticOperation } from "./logger";

export const IDENTITY_WEB_URL = {
  cainiao: "https://pages-fast.m.taobao.com/wow/z/uniapp/1011717/last-mile-fe/end-collect-platform/identity-code",
  pinduoduo: "https://m.pinduoduo.net/mdkd/identificationCode",
} as const;
export const IDENTITY_APP_URL = {
  cainiao: "taobao://m.taobao.com/tbopen/index.html?h5Url=" + encodeURIComponent(IDENTITY_WEB_URL.cainiao),
  pinduoduo: "pinduoduo://com.xunmeng.pinduoduo/mdkd/package?tab=ID_CODE&entry_source=11",
} as const;
const CAINIAO_OUTBOUND_PAGE = "https://page.cainiao.com/cn-app-web/identity-code/index.html";
export const CAINIAO_OUTBOUND_WEB_URL = CAINIAO_OUTBOUND_PAGE + "#/?bizEntry=TAOBAO_GUOGUO";
export const CAINIAO_OUTBOUND_APP_URL = "guoguo://go/station_code";

export async function stationIdentityDestination(
  platform: IdentityPlatform, openApp: (url: string) => Promise<boolean>,
): Promise<"local" | "app" | "login"> {
  const finish = beginDiagnosticOperation("platform.identity", { sourceProvider: platform, stage: "station_identity_entry" });
  let route: "local" | "app" | "login" = "login";
  try {
    if (accountStatus(platform).state === "active") route = "local";
    else if (await openApp(IDENTITY_APP_URL[platform]).catch(() => false)) route = "app";
    else if (accountStatus(platform).state === "active") route = "local";
  } catch (error) {
    finish("failed", {}, "warning");
    throw error;
  }
  finish(route);
  return route;
}

export const CAINIAO_RECIPIENT_LIST = "mtop.cainiao.lpc.packageservice.queryPdsPackageDataList";
const CAINIAO_COUNT = "mtop.cainiao.lpc.packageservice.user.package.count.query";
const TAOBAO_PROFILE = "mtop.taobao.reborn.mclaren.h5";
const TAOBAO_PROFILE_PAGE = "https://main.m.taobao.com/mytaobao/index.html";
const TAOBAO_IDENTITY_API = "mtop.cainiao.pickup.identity.getIdentityMessage";
const CAINIAO_OUTBOUND_CODE = "mtop.cainiao.nbpickup.identitycode.get";
const TAOBAO_H5_PAGE = "https://h5.m.taobao.com/";
const CAINIAO_SENDER_LIST = "mtop.cainiao.tdtradeplatform.order.queryUncompletedOrder";
const CAINIAO_SENT_LIST = "mtop.cainiao.tdtradeplatform.order.queryCompletedOrder";
const CAINIAO_SENDER_DETAIL = "mtop.cainiao.tdtradeplatform.order.queryOrderDetail";
const CAINIAO_SENDER_PAGE = "https://page.cainiao.com/mcn/fulfill_new/index.html?from=tbcn";
// Public channel identifier shipped by the sender-history page.
const CAINIAO_SENDER_CHANNEL = "881ce457-c0ce-45df-bb2d-6078a781c613";
export const CAINIAO_LIST_PARAMETERS = {
  pageSize: 50,
  currentPage: 1,
  needTemporality: false,
  needDynInfo: "{'needFindTemporality':true,'needAppointment':true}",
};

const MTOP = "https://h5api.m.taobao.com";
const MTOP_APP_KEY = "12574478";
const PDD = "https://api.pinduoduo.com";
const PDD_STATION_PAGE = "https://m.pinduoduo.net/mdkd/package?pr_page_from=scheme";
const PDD_SESSION_NAMES = ["PDDAccessToken", "pdd_user_id", "pdd_user_uin", "api_uid", "pdduid"];
const MOBILE_WEB_USER_AGENT = "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const pddVerifyUntil = new Map<string, number>();

export class PlatformWireError extends Error {
  constructor(readonly reason: "expired" | "verification" | "unavailable" | "changed") {
    super("Parcel provider " + reason);
    this.name = "PlatformWireError";
  }
}

export const JD_ORDERS_PAGE = "https://my.m.jd.com/index.html?sceneval=2";
const JD_HOME_PAGE = "https://home.m.jd.com/myJd/newhome.action";
export const JD_ORDER_LIST_URL = new URL("/order/orderlist_jdm.shtml", "https://trade.m.jd.com").href;
const JD_ACCOUNT_PAGES = [JD_HOME_PAGE, JD_ORDERS_PAGE, JD_ORDER_LIST_URL];

/** The sign-in view and the order reader use the same JD account evidence. */
export function jdLoginProof(cookies: readonly PlatformCookie[], address?: string) {
  let proof = "";
  for (const url of address ? [address, ...JD_ACCOUNT_PAGES] : JD_ACCOUNT_PAGES) {
    const matching = cookiesForURL(cookies, url);
    const key = cookieValue(matching, "pt_key");
    if (!key) continue;
    proof ||= key;
    const pin = cookieValue(matching, "pt_pin");
    if (!pin || pin.length > 160) continue;
    let id = pin;
    try { id = decodeURIComponent(pin); } catch { /* Keep a literal account ID when it is not URL-encoded. */ }
    return { id, proof: key };
  }
  return proof ? { id: "", proof } : null;
}

type JdBrowser = Readonly<{ generation: string; view: WebViewController; detached: Promise<void> }>;
let jdBrowser: JdBrowser | undefined;

function replaceJdBrowser(next?: JdBrowser): void {
  const previous = jdBrowser;
  jdBrowser = next;
  if (previous && previous.view !== next?.view) {
    void previous.detached.then(() => previous.view.dispose()).catch(() => undefined);
  }
}

onPlatformAccountsChanged(() => {
  if (jdBrowser && !currentPlatformSession("jingdong", jdBrowser.generation)) replaceJdBrowser();
});

export function retainJdLoginView(generation: string, view: WebViewController, detached: Promise<void>): void {
  replaceJdBrowser({ generation, view, detached });
}

export async function verifiedJdCookies(view: WebViewController, session: PlatformSession, deadline: number, signal?: AbortSignal) {
  if (session.credentials.kind !== "web") throw new PlatformWireError("changed");
  const cookies = providerCookies("jingdong", await waitForRefresh(view.getAllCookies(), deadline, signal));
  if (!currentPlatformSession("jingdong", session.generation)) throw new PlatformWireError("changed");
  const observed = jdLoginProof(cookies);
  const expected = jdLoginProof(session.credentials.cookies);
  if (!observed || (expected?.id && observed.id && expected.id !== observed.id)) {
    throw new PlatformWireError("unavailable");
  }
  return cookies;
}

export async function jdSyncView(session: PlatformSession, deadline: number, signal?: AbortSignal): Promise<WebViewController> {
  if (session.credentials.kind !== "web" || !currentPlatformSession("jingdong", session.generation)) {
    throw new PlatformWireError("changed");
  }
  const retained = jdBrowser;
  if (retained?.generation === session.generation) {
    await waitForRefresh(retained.detached, deadline, signal);
    if (retained !== jdBrowser || !currentPlatformSession("jingdong", session.generation)) {
      throw new PlatformWireError("changed");
    }
    return retained.view;
  }
  const view = await openProviderController("jingdong", session.credentials.cookies, "default", deadline, signal);
  try {
    await verifiedJdCookies(view, session, deadline, signal);
    retainJdLoginView(session.generation, view, Promise.resolve());
    return view;
  } catch (error) {
    view.dispose();
    throw error;
  }
}

export async function providerRequest(url: string, headers: Record<string, string>, body?: JsonObject | "", timeout = 10,
  signal?: AbortSignal) {
  try {
    return await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? headers : { "Content-Type": "application/json;charset=UTF-8", ...headers },
      body: body === undefined || body === "" ? body : JSON.stringify(body),
      timeout,
      signal,
      handleRedirect: async () => null,
    });
  } catch {
    throw new PlatformWireError("unavailable");
  }
}

export function jsonObject(text: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function cookieKey(cookie: PlatformCookie): string {
  return JSON.stringify([cookie.name, cookie.domain, cookie.path]);
}

function mergeMtopCookies(cookies: readonly PlatformCookie[], incoming: readonly PlatformCookie[]): PlatformCookie[] {
  const result = new Map(cookies.map((cookie) => [cookieKey(cookie), cookie]));
  for (const cookie of incoming) {
    if (cookie.name !== "_m_h5_tk" && cookie.name !== "_m_h5_tk_enc") continue;
    const key = cookieKey(cookie);
    if (cookie.value && cookie.value.toLowerCase() !== "deleted" &&
      (!cookie.expiresAtMs || cookie.expiresAtMs > Date.now())) result.set(key, cookie);
    else result.delete(key);
  }
  return Array.from(result.values());
}

async function mtopOnce(api: string, data: string, cookies: readonly PlatformCookie[], signal?: AbortSignal) {
  const version = "1.0";
  const endpoint = MTOP + "/h5/" + api.toLowerCase() + "/" + version + "/";
  const attached = cookiesForURL(cookies, endpoint);
  const token = cookieValue(attached, "_m_h5_tk").split("_")[0];
  const now = String(Date.now());
  const sign = Crypto.md5(utf8Data([token, now, MTOP_APP_KEY, data].join("&"))).toHexString().toLowerCase();
  const query = Object.entries({
    jsv: "2.7.4", appKey: MTOP_APP_KEY, t: now, sign, api, v: version,
    type: "originaljson", dataType: "json", data,
  }).map(([key, value]) => key + "=" + encodeURIComponent(value)).join("&");
  const referer = api === TAOBAO_PROFILE ? TAOBAO_PROFILE_PAGE :
    isCainiaoSenderApi(api) ? CAINIAO_SENDER_PAGE : TAOBAO_H5_PAGE;
  const response = await providerRequest(endpoint + "?" + query, {
    Cookie: cookieHeader(attached), Referer: referer,
    Accept: "application/json",
    "User-Agent": MOBILE_WEB_USER_AGENT,
  }, undefined, api === TAOBAO_PROFILE ? 3 : 10, signal);
  const payload = jsonObject(await response.text());
  const ret = Array.isArray(payload?.ret) ? String(payload.ret[0] ?? "").toUpperCase() : "";
  return {
    ret,
    data: payload?.data,
    ok: response.ok && ret.startsWith("SUCCESS"),
    cookies: mergeMtopCookies(cookies, providerCookies("cainiao", response.cookies ?? [])),
  };
}

async function mtop(api: string, body: JsonObject, cookies: readonly PlatformCookie[], current?: () => boolean,
  signal?: AbortSignal) {
  const data = JSON.stringify(body);
  const first = await mtopOnce(api, data, cookies, signal);
  if (signal?.aborted) throw new PlatformWireError("changed");
  if (!/TOKEN_EMPTY|TOKEN_EXPIRED|TOKEN_EXOIRED|ILLEGAL_ACCESS/.test(first.ret)) return first;
  let fresh = first.cookies;
  if ((api === TAOBAO_IDENTITY_API || api === CAINIAO_OUTBOUND_CODE) &&
      JSON.stringify(fresh) === JSON.stringify(cookies)) {
    if (!current?.()) throw new PlatformWireError("changed");
    const deadline = Date.now() + 15_000;
    const web = await openProviderController("cainiao", cookies, "default", deadline, signal);
    try {
      await waitForRefresh(web.loadURL(TAOBAO_H5_PAGE), deadline, signal);
      await waitForRefresh(web.waitForLoad(), deadline, signal);
      const incoming = await waitForRefresh(web.getAllCookies(), deadline, signal);
      fresh = mergeMtopCookies(cookies, providerCookies("cainiao", incoming));
    } finally {
      web.dispose();
    }
  }
  if (current && !current()) throw new PlatformWireError("changed");
  return JSON.stringify(fresh) === JSON.stringify(cookies) ? first : mtopOnce(api, data, fresh, signal);
}

export async function checkCainiaoLogin(cookies: readonly PlatformCookie[]): Promise<PlatformCookie[]> {
  const result = await mtop(CAINIAO_COUNT, { appName: "GUOGUO" }, cookies);
  if (!result.ok) throw new PlatformWireError("unavailable");
  return result.cookies;
}

export async function readCainiaoProfileNickname(session: PlatformSession): Promise<string> {
  if (session.credentials.kind !== "web") return "";
  const profile = await mtop(TAOBAO_PROFILE, {}, session.credentials.cookies);
  if (!profile.ok) return "";
  const header = asPlainObject(asPlainObject(profile.data).h5HeaderValve);
  const nickname = cleanScalarText(asPlainObject(header.userInfo).nickName);
  const loginName = cleanScalarText(asPlainObject(header.accountTip).userName);
  return nickname === loginName || nickname === "我的淘宝昵称" ? "" : nickname;
}

function isCainiaoSenderApi(api: string): boolean {
  return api === CAINIAO_SENDER_LIST || api === CAINIAO_SENT_LIST || api === CAINIAO_SENDER_DETAIL;
}

export async function readCainiao(session: PlatformSession, api: string, params: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
  if (signal?.aborted) throw new PlatformWireError("changed");
  const generation = session.generation;
  const active = currentPlatformSession("cainiao", generation);
  if (active?.credentials.kind !== "web") throw new PlatformWireError("changed");
  const before = active.credentials.cookies;
  const current = () => currentPlatformSession("cainiao", generation) != null;
  const result = await mtop(api, params, before, current, signal);
  if (signal?.aborted || !currentPlatformSession("cainiao", generation)) throw new PlatformWireError("changed");
  if (/SESSION_EXPIRED|USER_NOT_LOGIN|NOT_LOGIN|NEED_LOGIN/.test(result.ret)) {
    if (api === CAINIAO_OUTBOUND_CODE) throw new PlatformWireError("unavailable");
    if (isCainiaoSenderApi(api)) {
      await readCainiao(session, CAINIAO_COUNT, { appName: "GUOGUO" }, signal);
      throw new PlatformWireError("unavailable");
    }
    clearPlatformLogin("cainiao", generation, true);
    throw new PlatformWireError("expired");
  }
  replacePlatformCookies("cainiao", generation, before, result.cookies);
  if (!result.ok || !isPlainObject(result.data)) throw new PlatformWireError("unavailable");
  return result.data;
}

function senderOrderId(order: JsonObject): string {
  const id = cleanScalarText(order.orderId);
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "";
}

function senderOrderSent(order: JsonObject): boolean {
  return cleanScalarText(order.orderStatus) === "100" ||
    ["status", "statusDesc", "orderStatusDesc"].some((key) =>
      /^(?:已寄件|已寄出|已揽收)$/.test(cleanScalarText(order[key])));
}

function senderSummaryPrefix(value: unknown): string {
  return cleanScalarText(value).split(/[|｜]/, 1)[0].trim();
}

function senderProviderTitle(rows: readonly JsonObject[], inferTaobao: boolean): string {
  for (const row of rows) {
    const refund = cleanScalarText(row.ttRefundMsg);
    const title = [refund, row.title].map(senderSummaryPrefix)
      .find((prefix) => /^[\p{L}\p{N}][\p{L}\p{N}\p{Zs}·.-]{0,27}退货$/u.test(prefix));
    if (title) return title;
    if (inferTaobao && refund && !/^(?:null|false|0|\{\}|\[\])$/i.test(refund) &&
        cleanScalarText(row.orderSource) === "2") {
      return "淘宝退货";
    }
  }
  return rows.flatMap((row) => Object.values(row)).map(senderSummaryPrefix)
    .find((title) => /^寄给[^|｜\u0000-\u001f]{1,28}的(?:快递|包裹)$/u.test(title)) || "";
}

export async function readCainiaoSenderAppointments(session: PlatformSession,
  shouldReadCompleted: (observedIds: readonly string[]) => boolean = () => false) {
  const accessCode = CAINIAO_SENDER_CHANNEL;
  const listParams = { accessCode, pageSize: 199, pageNo: 0 };
  const list = await readCainiao(session, CAINIAO_SENDER_LIST, listParams);
  const orders = asPlainObject(list.data ?? list).orderBriefList;
  if (!Array.isArray(orders)) throw new PlatformWireError("unavailable");
  const packages: JsonObject[] = [];
  const waiting = new Map<string, JsonObject>();
  const sentOrders = new Set<string>();
  for (const row of orders) {
    const order = asPlainObject(row);
    const id = senderOrderId(order);
    if (!id) continue;
    if (senderOrderSent(order)) sentOrders.add(id);
    else if (/^\d{1,3}$/.test(cleanScalarText(order.orderStatus)) &&
        cleanScalarText(order.carryoutStatus) === "20" && !waiting.has(id)) waiting.set(id, order);
  }
  let incomplete = false;
  for (const [tdOrderId, brief] of waiting) {
    if (sentOrders.has(tdOrderId)) continue;
    try {
      const response = await readCainiao(session, CAINIAO_SENDER_DETAIL, { accessCode, tdOrderId });
      const item = asPlainObject(response.data ?? response);
      const order = asPlainObject(item.orderInfo);
      const detail = asPlainObject(item.detail);
      const listedItem = asPlainObject(brief.item);
      const listedDetail = asPlainObject(listedItem.detail);
      if (senderOrderSent(order) || senderOrderSent(item) || senderOrderSent(detail)) {
        sentOrders.add(tdOrderId);
        continue;
      }
      // The authenticated detail request is scoped to the waiting ID from the list.
      packages.push({
        appointmentId: tdOrderId, status: "WAIT_GOT",
        mailNo: order.packageMailNo, pickupCode: item.pickupCode,
        providerTitle: senderProviderTitle([listedDetail, listedItem, brief], false) ||
          senderProviderTitle([detail, listedDetail, item, order, brief, listedItem], true),
        appointStartTime: cleanScalarText(detail.appointmentStart) || cleanScalarText(order.appointmentStart) ||
          cleanScalarText(order.appointStartTime) || cleanScalarText(order.expectedGotStartTime) ||
          cleanScalarText(order.expectGotDate) || cleanScalarText(item.appointmentStart) || listedDetail.appointmentStart,
        appointEndTime: cleanScalarText(detail.appointmentEnd) || cleanScalarText(order.appointmentEnd) ||
          cleanScalarText(order.appointEndTime) || cleanScalarText(order.expectedGotEndTime) ||
          cleanScalarText(item.appointmentEnd) || listedDetail.appointmentEnd,
        appointTimeStr: cleanScalarText(order.appointTimeStr) || cleanScalarText(order.appointTimeDesc) || item.appointTimeStr,
      });
    } catch (error) {
      if (!(error instanceof PlatformWireError) || error.reason !== "unavailable") throw error;
      incomplete = true;
    }
  }
  if (shouldReadCompleted([...waiting.keys(), ...sentOrders])) {
    try {
      // A completed appointment may disappear from the unfinished list.
      const result = await readCainiao(session, CAINIAO_SENT_LIST, listParams);
      const completed = asPlainObject(result.data ?? result).orderBriefList;
      if (!Array.isArray(completed)) incomplete = true;
      else for (const row of completed) {
        const order = asPlainObject(row);
        const id = senderOrderId(order);
        if (id && senderOrderSent(order)) sentOrders.add(id);
      }
    } catch (error) {
      if (!(error instanceof PlatformWireError) || error.reason !== "unavailable") throw error;
      incomplete = true;
    }
  }
  return { packages, sentOrders: [...sentOrders], incomplete };
}

function pddCredentialsFor(cookies: readonly PlatformCookie[], target: string) {
  const native = cookiesForURL(cookies, target);
  const original = cookiesForURL(cookies, "https://mobile.yangkeduo.com/orders.html");
  const extras = original.filter((cookie) => PDD_SESSION_NAMES.includes(cookie.name) &&
    !native.some((current) => current.name === cookie.name));
  return [...native, ...extras];
}

export async function readPdd(session: PlatformSession, path: string, body: JsonObject, identity = false,
  signal?: AbortSignal): Promise<JsonObject> {
  if (signal?.aborted) throw new PlatformWireError("changed");
  const active = currentPlatformSession("pinduoduo", session.generation);
  if (active?.credentials.kind !== "web") throw new PlatformWireError("changed");
  const until = pddVerifyUntil.get(session.generation) ?? 0;
  if (until > Date.now()) throw new PlatformWireError("verification");
  pddVerifyUntil.delete(session.generation);
  const endpoint = PDD + path;
  const attached = pddCredentialsFor(active.credentials.cookies, endpoint);
  const token = cookieValue(attached, "PDDAccessToken");
  const response = await providerRequest(endpoint, {
    Cookie: cookieHeader(attached), Referer: PDD_STATION_PAGE + (identity ? "&tab=ID_CODE" : ""),
    "User-Agent": MOBILE_WEB_USER_AGENT,
    ...(token ? { AccessToken: token } : {}),
  }, body, 10, signal);
  const raw = await response.text();
  const result = jsonObject(raw);
  const code = cleanScalarText(result?.error_code);
  if (signal?.aborted || !currentPlatformSession("pinduoduo", session.generation)) throw new PlatformWireError("changed");
  if ([401, 424].includes(response.status) || code === "40001" ||
    (!result && /<h5response/i.test(raw) && /登录|login|扫码|安全验证|verify/i.test(raw))) {
    clearPlatformLogin("pinduoduo", session.generation, true);
    throw new PlatformWireError("expired");
  }
  if (code === "54001") {
    pddVerifyUntil.set(session.generation, Date.now() + 600_000);
    throw new PlatformWireError("verification");
  }
  if (!response.ok || !result || (code && code !== "0" && code !== "1000000")) {
    throw new PlatformWireError("unavailable");
  }
  return result;
}

export async function fetchPddBoundPhoneTails(session: PlatformSession, signal?: AbortSignal): Promise<string[]> {
  try {
    if (signal?.aborted) return [];
    const active = currentPlatformSession("pinduoduo", session.generation);
    if (active?.credentials.kind !== "web") return [];
    const endpoint = PDD + "/api/apoc/express/detail";
    const attached = pddCredentialsFor(active.credentials.cookies, endpoint);
    const token = cookieValue(attached, "PDDAccessToken");
    const response = await providerRequest(endpoint, {
      Cookie: cookieHeader(attached),
      Referer: PDD_STATION_PAGE,
      "User-Agent": MOBILE_WEB_USER_AGENT,
      ...(token ? { AccessToken: token } : {}),
    }, { entry_source: 17 }, 5, signal);
    if (!response.ok) return [];
    const payload = jsonObject(await response.text());
    if (!payload) return [];
    const result = asPlainObject(payload.result ?? payload);
    const lists = [result.new_binding_list, result.binding_list, payload.new_binding_list, payload.binding_list];
    const tails = new Set<string>();
    const collect = (node: unknown, depth: number) => {
      if (depth > 4 || !node) return;
      if (typeof node === "string") {
        const masked = node.match(/\b1[3-9]\d\*{4}(\d{4})\b/) || node.match(/\b1[3-9]\d{5}(\d{4})\b/);
        if (masked?.[1]) tails.add(masked[1]);
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) collect(item, depth + 1);
        return;
      }
      if (typeof node === "object") {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (/mobile|phone/i.test(key) && typeof value === "string") collect(value, depth + 1);
          else if (Array.isArray(value) || isPlainObject(value)) collect(value, depth + 1);
        }
      }
    };
    for (const list of lists) collect(list, 0);
    if (!tails.size) collect(result, 0);
    return [...tails];
  } catch {
    return [];
  }
}

export function identityWebCookies(platform: IdentityPlatform, session: PlatformSession | null): readonly PlatformCookie[] {
  const cookies = session?.credentials.kind === "web" ? session.credentials.cookies : [];
  if (platform !== "pinduoduo") return cookies;
  const firstParty = cookiesForURL(cookies, "https://mobile.yangkeduo.com/orders.html");
  const aliases = [PDD, IDENTITY_WEB_URL.pinduoduo].flatMap((url) => {
    const present = cookiesForURL(cookies, url);
    const domain = url === PDD ? ".pinduoduo.com" : ".pinduoduo.net";
    return firstParty.filter((cookie) => PDD_SESSION_NAMES.includes(cookie.name) &&
      !present.some(({ name }) => name === cookie.name))
      .map((cookie) => ({ ...cookie, domain, path: "/", isSecure: true }));
  });
  return [...cookies, ...aliases];
}

export type StationIdentityCode = Readonly<{ value: string; expiresAtMs: number; mobile?: string }>;

const STATION_IDENTITY_DEFAULT_MS = 300_000;

function validStationCode(value: unknown): value is string {
  return typeof value === "string" && /^[ -~]{1,80}$/.test(value) && !!value.trim();
}

function taobaoIdentity(response: JsonObject): { value: string; lifetime: number } | undefined {
  const identityCodes = new Map<string, number>();
  const nestedCodes = new Map<string, number>();
  function read(node: unknown, inheritedLifetime: number, depth: number) {
    if (depth > 6 || node === null || typeof node !== "object") return;
    const fields = asPlainObject(node);
    const seconds = Object.entries(fields).find(([key, value]) => /expire/i.test(key) &&
      typeof value === "number" && Number.isFinite(value) && value > 0)?.[1];
    const lifetime = typeof seconds === "number"
      ? Math.round(seconds > 1e6 ? seconds : seconds * 1000) : inheritedLifetime;
    const explicit = fields.identityCode ?? fields.identity_code;
    const value = validStationCode(explicit) ? explicit : fields.code;
    if (validStationCode(value) && (value === explicit || /^[A-Z]{2}[0-9A-Z]{8,26}$/.test(value))) {
      const codes = value === explicit ? identityCodes : nestedCodes;
      codes.set(value, Math.min(codes.get(value) ?? lifetime, lifetime));
    }
    (Array.isArray(node) ? node : Object.values(fields)).forEach((child) => read(child, lifetime, depth + 1));
  }
  read(response.data ?? response.result ?? response, STATION_IDENTITY_DEFAULT_MS, 0);
  const codes = identityCodes.size ? identityCodes : nestedCodes;
  if (codes.size !== 1) return undefined;
  const [[value, lifetime]] = codes;
  return { value, lifetime };
}

export function identityCodeFromResponse(
  platform: IdentityPlatform, response: JsonObject, now = Date.now(),
): StationIdentityCode {
  const fields = asPlainObject(response.result);
  const taobao = platform === "cainiao" ? taobaoIdentity(response) : undefined;
  const value = platform === "cainiao" ? taobao?.value : fields.identification_code;
  const lifetime = platform === "cainiao" ? taobao?.lifetime ?? 0 : fields.expire_mills == null
    ? STATION_IDENTITY_DEFAULT_MS : Number(cleanScalarText(fields.expire_mills));
  if (!validStationCode(value) || !Number.isSafeInteger(lifetime) || lifetime <= 0 ||
    !Number.isSafeInteger(now + lifetime)) throw new PlatformWireError("unavailable");
  const info = asPlainObject(fields.mobile_info);
  const mobile = platform === "pinduoduo"
    ? cleanScalarText(info.mobile_desc ?? info.mobile ?? info.mobile_info_desc ?? fields.mobile_info_desc)
      .match(/\b1\d{2}\*{4}\d{4}\b/)?.[0] : undefined;
  return { value, expiresAtMs: now + lifetime, ...(mobile ? { mobile } : {}) };
}

export async function fetchStationIdentity(platform: IdentityPlatform, session: PlatformSession,
  signal?: AbortSignal, cainiaoOutbound = false): Promise<StationIdentityCode> {
  let stage = "station_identity_request";
  const trigger = cainiaoOutbound ? "station_identity_outbound"
    : platform === "cainiao" ? "station_identity_taobao" : "station_identity_pdd";
  const finish = beginDiagnosticOperation("platform.identity", { sourceProvider: platform, trigger, stage });
  try {
    if (platform === "cainiao" && cainiaoOutbound) {
      const result = await readCainiao(session, CAINIAO_OUTBOUND_CODE, {
        appName: "GUOGUO", verifyVersion: "V2",
      }, signal);
      stage = "station_identity_response";
      const { identityCode, expireTime } = asPlainObject(result.model);
      const lifetime = Number(cleanScalarText(expireTime)) * 1_000;
      const now = Date.now();
      if (!validStationCode(identityCode) || !Number.isSafeInteger(lifetime) || lifetime <= 0 ||
          !Number.isSafeInteger(now + lifetime)) throw new PlatformWireError("unavailable");
      finish("succeeded", { stage });
      return { value: identityCode, expiresAtMs: now + lifetime };
    }
    const result = platform === "cainiao"
      ? await readCainiao(session, TAOBAO_IDENTITY_API, {}, signal)
      : await readPdd(session, "/api/express_trackbox/generate_identification_code", { entry_source: "APP" }, true, signal);
    stage = "station_identity_response";
    const decoded = identityCodeFromResponse(platform, result);
    finish("succeeded", { stage });
    return decoded;
  } catch (error) {
    if (signal?.aborted) finish("cancelled", { stage });
    else finish(error instanceof PlatformWireError ? error.reason : "failed", { stage }, "warning");
    throw error;
  }
}

export async function openProviderController(
  platform: WebPlatform,
  cookies: readonly PlatformCookie[] = [],
  mode: "default" | "login" = "default",
  deadline?: number,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new PlatformWireError("changed");
  // Match Pipi Android's desktop user agent for the provider's QR sign-in.
  const controller = new WebViewController({ ephemeral: true });
  try {
    if (platform === "pinduoduo" && mode === "login") {
      const desktopUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
      await controller.setCustomUserAgent(desktopUserAgent);
    }
    controller.shouldAllowRequest = async ({ url }) => trustedPlatformPage(platform, url);
    for (const { expiresAtMs, ...cookie } of cookies) {
      if (!expiresAtMs || expiresAtMs > Date.now()) {
        const install = controller.setCookie({ ...cookie, expiresDate: expiresAtMs ? new Date(expiresAtMs) : undefined });
        if (deadline === undefined) await install;
        else await waitForRefresh(install, deadline, signal);
      }
    }
    return controller;
  } catch {
    controller.dispose();
    throw new PlatformWireError("unavailable");
  }
}
