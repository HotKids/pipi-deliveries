import { fetch } from "scripting";
import {
  clearPlatformLogin, cookieHeader, cookiesForURL, cookieValue, currentPlatformSession,
  providerCookies, replacePlatformCookies, trustedPlatformPage, type IdentityPlatform, type PlatformCookie,
  type PlatformSession, type WebPlatform,
} from "./platform-accounts";
import { utf8Data } from "./scripting-data";
import { asPlainObject, cleanScalarText, isPlainObject, type JsonObject } from "./value-guards";

export const IDENTITY_WEB_URL = {
  cainiao: "https://pages-fast.m.taobao.com/wow/z/uniapp/1011717/last-mile-fe/end-collect-platform/identity-code",
  pinduoduo: "https://m.pinduoduo.net/mdkd/identificationCode",
} as const;

export const CAINIAO_RECIPIENT_LIST = "mtop.cainiao.lpc.packageservice.queryPdsPackageDataList";
export const CAINIAO_SENDER_LIST = "mtop.cainiao.lpc.packageservice.querySendPackageDataList";
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

export async function providerRequest(url: string, headers: Record<string, string>, body?: JsonObject | "") {
  try {
    return await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? headers : { "Content-Type": "application/json;charset=UTF-8", ...headers },
      body: body === undefined || body === "" ? body : JSON.stringify(body),
      timeout: 10,
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

async function mtopOnce(api: string, data: string, cookies: readonly PlatformCookie[]) {
  const endpoint = MTOP + "/h5/" + api.toLowerCase() + "/1.0/";
  const attached = cookiesForURL(cookies, endpoint);
  const token = cookieValue(attached, "_m_h5_tk").split("_")[0];
  const now = String(Date.now());
  const sign = Crypto.md5(utf8Data([token, now, MTOP_APP_KEY, data].join("&"))).toHexString().toLowerCase();
  const query = Object.entries({
    jsv: "2.7.4", appKey: MTOP_APP_KEY, t: now, sign, api, v: "1.0",
    type: "originaljson", dataType: "json", data,
  }).map(([key, value]) => key + "=" + encodeURIComponent(value)).join("&");
  const response = await providerRequest(endpoint + "?" + query, {
    Cookie: cookieHeader(attached), Referer: "https://h5.m.taobao.com/", Accept: "application/json",
    "User-Agent": MOBILE_WEB_USER_AGENT,
  });
  const payload = jsonObject(await response.text());
  const ret = Array.isArray(payload?.ret) ? String(payload.ret[0] ?? "").toUpperCase() : "";
  return {
    ret,
    data: payload?.data,
    ok: response.ok && ret.startsWith("SUCCESS"),
    cookies: mergeMtopCookies(cookies, providerCookies("cainiao", response.cookies ?? [])),
  };
}

async function mtop(api: string, body: JsonObject, cookies: readonly PlatformCookie[]) {
  const data = JSON.stringify(body);
  const first = await mtopOnce(api, data, cookies);
  const retry = /TOKEN_EMPTY|TOKEN_EXPIRED|TOKEN_EXOIRED|ILLEGAL_ACCESS/.test(first.ret) &&
    JSON.stringify(first.cookies) !== JSON.stringify(cookies);
  return retry ? mtopOnce(api, data, first.cookies) : first;
}

export async function checkCainiaoLogin(cookies: readonly PlatformCookie[]): Promise<PlatformCookie[]> {
  const result = await mtop("mtop.cainiao.lpc.packageservice.user.package.count.query", { appName: "GUOGUO" }, cookies);
  if (!result.ok) throw new PlatformWireError("unavailable");
  return result.cookies;
}

export async function readCainiao(session: PlatformSession, api: string, params: JsonObject): Promise<JsonObject> {
  const generation = session.generation;
  const active = currentPlatformSession("cainiao", generation);
  if (active?.credentials.kind !== "web") throw new PlatformWireError("changed");
  const before = active.credentials.cookies;
  const result = await mtop(api, params, before);
  if (!currentPlatformSession("cainiao", generation)) throw new PlatformWireError("changed");
  if (/SESSION_EXPIRED|USER_NOT_LOGIN|NOT_LOGIN|NEED_LOGIN/.test(result.ret)) {
    clearPlatformLogin("cainiao", generation, true);
    throw new PlatformWireError("expired");
  }
  replacePlatformCookies("cainiao", generation, before, result.cookies);
  if (!result.ok || !isPlainObject(result.data)) throw new PlatformWireError("unavailable");
  return result.data;
}

function pddCredentialsFor(cookies: readonly PlatformCookie[], target: string) {
  const native = cookiesForURL(cookies, target);
  const original = cookiesForURL(cookies, "https://mobile.yangkeduo.com/orders.html");
  const extras = original.filter((cookie) => PDD_SESSION_NAMES.includes(cookie.name) &&
    !native.some((current) => current.name === cookie.name));
  return [...native, ...extras];
}

export async function readPdd(session: PlatformSession, path: string, body: JsonObject, identity = false): Promise<JsonObject> {
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
  }, body);
  const raw = await response.text();
  const result = jsonObject(raw);
  const code = cleanScalarText(result?.error_code);
  if (!currentPlatformSession("pinduoduo", session.generation)) throw new PlatformWireError("changed");
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

export type StationIdentityCode = Readonly<{ value: string; expiresAtMs: number }>;

const TAOBAO_IDENTITY_API = "mtop.cainiao.pickup.identity.getIdentityMessage";
// The Taobao H5 page renews the code every three minutes.
const TAOBAO_IDENTITY_REFRESH_MS = 180_000;

export function identityCodeFromResponse(
  platform: IdentityPlatform, response: JsonObject, now = Date.now(),
): StationIdentityCode {
  const taobao = platform === "cainiao";
  const fields = asPlainObject(taobao ? response.result ?? response.data : response.result);
  const value = taobao ? fields.identityCode : fields.identification_code;
  const lifetime = taobao ? TAOBAO_IDENTITY_REFRESH_MS : Number(cleanScalarText(fields.expire_mills));
  if (typeof value !== "string" || !/^[ -~]{1,80}$/.test(value) || !value.trim() ||
    !Number.isSafeInteger(lifetime) || lifetime <= 0 ||
    !Number.isSafeInteger(now + lifetime)) throw new PlatformWireError("unavailable");
  return { value, expiresAtMs: now + lifetime };
}

export async function fetchStationIdentity(platform: IdentityPlatform, session: PlatformSession): Promise<StationIdentityCode> {
  const result = platform === "cainiao"
    ? await readCainiao(session, TAOBAO_IDENTITY_API, {})
    : await readPdd(session, "/api/express_trackbox/generate_identification_code", { entry_source: "APP" }, true);
  return identityCodeFromResponse(platform, result);
}

export async function openProviderController(platform: WebPlatform, cookies: readonly PlatformCookie[] = []) {
  const controller = new WebViewController({ ephemeral: true });
  try {
    controller.shouldAllowRequest = async ({ url }) => trustedPlatformPage(platform, url);
    for (const { expiresAtMs, ...cookie } of cookies) {
      if (!expiresAtMs || expiresAtMs > Date.now()) {
        await controller.setCookie({ ...cookie, expiresDate: expiresAtMs ? new Date(expiresAtMs) : undefined });
      }
    }
    return controller;
  } catch {
    controller.dispose();
    throw new PlatformWireError("unavailable");
  }
}
