import type { Cookie } from "scripting";
import type { PickupPlatform } from "../models";
import type { CabinetParcel } from "./fengchao-account";
import { sha256Hex } from "./scripting-data";
import { asPlainObject, cleanString } from "./value-guards";

export const PLATFORM_SOURCES = ["cainiao", "jingdong", "pinduoduo", "fengchao"] as const;
export type ExpressPlatform = typeof PLATFORM_SOURCES[number];
export type IdentityPlatform = Extract<PickupPlatform, "cainiao" | "pinduoduo">;
export type WebPlatform = Exclude<ExpressPlatform, "fengchao">;

export const PLATFORM_NAMES: Record<ExpressPlatform, string> = {
  cainiao: "菜鸟",
  jingdong: "京东",
  pinduoduo: "拼多多",
  fengchao: "丰巢",
};

export type PlatformCookie = Readonly<Omit<Cookie, "expiresDate"> & { expiresAtMs?: number }>;

type AccountBase = Readonly<{
  generation: string;
  label: string;
  syncedAtMs?: number;
}>;

type WebCredentials = Readonly<{ kind: "web"; cookies: readonly PlatformCookie[] }>;
export type CabinetCredentials = Readonly<{
  kind: "cabinet";
  token: string;
  flag: string;
  userAuth: string;
  mobile: string;
  clientIp: string;
  cabinetLinks?: readonly (Readonly<{ recordKey: string; parcel: CabinetParcel }>)[];
}>;
export type PlatformCredentials = WebCredentials | CabinetCredentials;

export type PlatformSession = AccountBase & Readonly<{
  state: "active";
  ownerKey: string;
  credentials: PlatformCredentials;
  lastDiscoveryAtMs?: number;
}>;

export type PlatformAccount = PlatformSession | AccountBase & Readonly<{
  state: "offline" | "expired";
}>;

export type AccountStatus = AccountBase & Readonly<{ state: PlatformAccount["state"] }>;

const INITIAL: PlatformAccount = { state: "offline", generation: "", label: "" };

export const WEB_PLATFORMS = {
  cainiao: {
    login: "https://login.m.taobao.com/login.htm",
    families: ["taobao.com", "tmall.com", "cainiao.com", "alicdn.com", "alibaba.com", "tbcdn.cn", "mmstat.com"],
    sessionFamilies: ["taobao.com", "tmall.com", "cainiao.com"],
  },
  jingdong: {
    login: "https://plogin.m.jd.com/login/login?appid=0&returnurl=https%3A%2F%2Fhome.m.jd.com%2FmyJd%2Fnewhome.action",
    families: ["jd.com", "jd.hk", "360buyimg.com"],
    sessionFamilies: ["jd.com"],
  },
  pinduoduo: {
    login: "https://mobile.yangkeduo.com/login.html",
    families: ["yangkeduo.com", "pinduoduo.com", "pinduoduo.net", "pddpic.com", "pddugc.com"],
    sessionFamilies: ["yangkeduo.com", "pinduoduo.com", "pinduoduo.net"],
  },
} as const;

function underDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

export function trustedPlatformPage(platform: WebPlatform, value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      WEB_PLATFORMS[platform].families.some((domain) => underDomain(url.hostname, domain));
  } catch {
    return false;
  }
}

function sessionCookieDomain(platform: WebPlatform, domain: string): boolean {
  const host = domain.toLowerCase().replace(/^\./, "");
  return WEB_PLATFORMS[platform].sessionFamilies.some((family) => underDomain(host, family));
}

export function providerCookies(platform: WebPlatform, cookies: readonly Cookie[]): PlatformCookie[] {
  return cookies.filter((cookie) => sessionCookieDomain(platform, cookie.domain)).map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    isSecure: cookie.isSecure,
    isHTTPOnly: cookie.isHTTPOnly,
    isSessionOnly: cookie.isSessionOnly,
    expiresAtMs: cookie.expiresDate?.getTime(),
  }));
}

export function cookieValue(cookies: readonly PlatformCookie[], name: string): string {
  return cookies.find((cookie) => cookie.name === name)?.value || "";
}

export function cookiesForURL(cookies: readonly PlatformCookie[], target: string, now = Date.now()): PlatformCookie[] {
  const url = new URL(target);
  return cookies.filter((cookie) => {
    const domain = cookie.domain.toLowerCase();
    return (domain.startsWith(".") ? underDomain(url.hostname, domain.slice(1)) : url.hostname === domain) &&
      (cookie.path === url.pathname ||
        url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : cookie.path + "/")) &&
      (!cookie.expiresAtMs || cookie.expiresAtMs > now);
  }).sort((a, b) => b.path.length - a.path.length);
}

export function cookieHeader(cookies: readonly PlatformCookie[]): string {
  return cookies.filter(({ name, value }) => /^[!#$%&'*+.^_`|~\w-]+$/.test(name) && !/[;\r\n\0]/.test(value))
    .map(({ name, value }) => name + "=" + value).join("; ");
}

function accountKey(platform: ExpressPlatform): string {
  return "pipi.deliveries.platform.v1." + platform;
}

function maskedAccountLabel(identifier: string): string {
  const value = cleanString(identifier);
  if (/^1[3-9]\d{9}$/.test(value)) return value.slice(0, 3) + "****" + value.slice(-4);
  return value.length > 4 ? "账号 ****" + value.slice(-4) : "已登录账号";
}

export function readPlatformAccount(platform: ExpressPlatform): PlatformAccount {
  const raw = Keychain.get(accountKey(platform));
  if (!raw) return INITIAL;
  const value = asPlainObject(JSON.parse(raw));
  if (!cleanString(value.generation) ||
    !["offline", "expired", "active"].includes(String(value.state))) {
    throw new Error("Invalid saved platform account");
  }
  if (value.state === "active") {
    const credentials = asPlainObject(value.credentials);
    const valid = platform === "fengchao"
      ? credentials?.kind === "cabinet" && cleanString(credentials.token) && cleanString(credentials.mobile)
      : credentials?.kind === "web" && Array.isArray(credentials.cookies) && credentials.cookies.length > 0;
    if (!valid) throw new Error("Invalid saved platform account");
  }
  return value as PlatformAccount;
}

const listeners = new Set<() => void>();

export function onPlatformAccountsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function saveAccount(platform: ExpressPlatform, account: PlatformAccount): void {
  if (!Keychain.set(accountKey(platform), JSON.stringify(account), {
    accessibility: "first_unlock_this_device",
    synchronizable: false,
  })) throw new Error("Unable to save platform account");
  for (const listener of listeners) listener();
}

export function accountStatus(platform: ExpressPlatform): AccountStatus {
  const { generation, label, syncedAtMs, state } = readPlatformAccount(platform);
  return { generation, label, syncedAtMs, state };
}

export function platformSession(platform: ExpressPlatform): PlatformSession | null {
  const account = readPlatformAccount(platform);
  return account.state === "active" ? account : null;
}

export function currentPlatformSession(platform: ExpressPlatform, expected: string): PlatformSession | null {
  const session = platformSession(platform);
  return session?.generation === expected ? session : null;
}

export function savePlatformLogin(
  platform: ExpressPlatform,
  expected: string,
  credentials: PlatformCredentials,
  identifier: string,
  nickname = "",
): boolean {
  if (readPlatformAccount(platform).generation !== expected) return false;
  saveAccount(platform, {
    state: "active",
    generation: UUID.string(),
    ownerKey: sha256Hex(platform + ":" + identifier),
    label: cleanString(nickname) || maskedAccountLabel(identifier),
    credentials,
  });
  return true;
}

export function clearPlatformLogin(platform: ExpressPlatform, expected: string, expired = false): boolean {
  const current = readPlatformAccount(platform);
  if (current.generation !== expected || current.state === "offline") return false;
  saveAccount(platform, {
    state: expired ? "expired" : "offline",
    generation: UUID.string(),
    label: expired ? current.label : "",
  });
  return true;
}

export function replacePlatformCookies(
  platform: WebPlatform, generation: string, previous: readonly PlatformCookie[], cookies: readonly PlatformCookie[],
): boolean {
  const current = currentPlatformSession(platform, generation);
  if (current?.credentials.kind !== "web") return false;
  if (JSON.stringify(current.credentials.cookies) !== JSON.stringify(previous)) return false;
  if (JSON.stringify(previous) !== JSON.stringify(cookies)) {
    saveAccount(platform, { ...current, credentials: { kind: "web", cookies } });
  }
  return true;
}

export function notePlatformSync(
  platform: ExpressPlatform, generation: string, atMs: number,
  fields: { nickname?: string; discovery?: boolean; cabinetLinks?: CabinetCredentials["cabinetLinks"] } = {},
): boolean {
  const current = currentPlatformSession(platform, generation);
  if (!current) return false;
  if (!current.syncedAtMs || current.syncedAtMs < atMs || fields.discovery || fields.cabinetLinks || fields.nickname) {
    const credentials = current.credentials.kind === "cabinet" && fields.cabinetLinks
      ? { ...current.credentials, cabinetLinks: fields.cabinetLinks } : current.credentials;
    saveAccount(platform, {
      ...current, credentials, syncedAtMs: Math.max(current.syncedAtMs || 0, atMs),
      label: cleanString(fields.nickname) || current.label,
      ...(fields.discovery ? { lastDiscoveryAtMs: atMs } : {}),
    });
  }
  return true;
}
