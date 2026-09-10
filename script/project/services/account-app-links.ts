export type AccountAppTarget = Readonly<{
  kind: "jd" | "cainiao" | "taobao" | "alipay" | "sf";
  url: string;
}>;

/** Validated links and their same-packet credential stay together in encrypted route storage. */
export type AccountAppRoute = Readonly<{
  targets: readonly AccountAppTarget[];
  secretKey: string;
}>;

const PARCEL_FIELDS = ["from", "showcard", "insertPackage", "cpCode", "mailNo"];

function decode(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value.replace(/\+/g, " "));
    return /[\u0000-\u001f\u007f-\u009f]/.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

function query(value: string): Map<string, string> | null {
  const fields = new Map<string, string>();
  for (const field of value.split("&")) {
    const separator = field.indexOf("=");
    if (separator <= 0) return null;
    const key = decode(field.slice(0, separator));
    const content = decode(field.slice(separator + 1));
    if (!key || content == null || !/^[A-Za-z0-9_.~-]+$/.test(key)) return null;
    const normalized = key.toLowerCase();
    if (fields.has(normalized)) return null;
    fields.set(normalized, content);
  }
  return fields;
}

function get(fields: Map<string, string> | null, name: string): string {
  return fields?.get(name.toLowerCase()) || "";
}

function url(value: string): URL | null {
  if (value !== value.trim() || /[\u0000-\u001f\u007f-\u009f#\\]/.test(value)) return null;
  try {
    const parsed = new URL(value);
    return parsed.username || parsed.password || parsed.port ? null : parsed;
  } catch {
    return null;
  }
}

function matchesTuple(fields: Map<string, string> | null, waybill: string, cp: string): boolean {
  return fields != null &&
    (!fields.has("mailno") || get(fields, "mailNo") === waybill) &&
    (!fields.has("cpcode") || get(fields, "cpCode") === cp);
}

function attribution(fields: Map<string, string> | null, waybill: string, cp: string): boolean {
  return get(fields, "from") === "xiaomi" && get(fields, "showcard") === "true" &&
    get(fields, "insertPackage") === "true" && get(fields, "mailNo") === waybill &&
    get(fields, "cpCode") === cp;
}

// Match Pipi's v5 CainiaoAppLinks boundary: every nested capability belongs to this packet.
function matchesSecret(value: string, secret: string): boolean {
  for (let depth = 0; depth < 5; depth++) {
    for (const match of value.matchAll(/(?:^|[?&#])secretKey=([^&#]*)/gi)) {
      if (decode(match[1]) !== secret) return false;
    }
    const decoded = decode(value);
    if (decoded == null) return false;
    if (decoded === value) return true;
    value = decoded;
  }
  return true;
}

function cainiaoTarget(link: string, waybill: string, cp: string, secret: string): AccountAppTarget["kind"] | null {
  const outer = url(link);
  if (!outer || !matchesSecret(link, secret)) return null;
  const fields = query(outer.search.slice(1));
  if (!fields || !matchesTuple(fields, waybill, cp)) return null;
  if (outer.protocol === "cainiao:" && outer.hostname === "startapp" && outer.pathname === "/logistic") {
    return get(fields, "mailNo") === waybill && get(fields, "cpCode") === cp &&
      get(fields, "comefrom") === "xiaomi" ? "cainiao" : null;
  }
  if (outer.protocol === "tbopen:" && outer.hostname === "m.taobao.com" && outer.pathname === "/tbopen/index.html") {
    if (get(fields, "action") !== "ali.open.nav" || get(fields, "module") !== "h5" ||
      PARCEL_FIELDS.some((key) => fields.has(key.toLowerCase()))) return null;
    const rawInner = get(fields, "h5Url");
    const inner = url(rawInner.replace(/^h5\.m\.taobao\.com\//i, "https://h5.m.taobao.com/"));
    if (!inner || inner.protocol !== "https:") return null;
    const direct = query(inner.search.slice(1));
    if (inner.hostname === "h5.m.taobao.com" && inner.pathname === "/awp/mtb/oper.htm") {
      return get(direct, "mailNo") === waybill && matchesTuple(direct, waybill, cp) ? "taobao" : null;
    }
    if (inner.hostname !== "m.duanqu.com" || inner.pathname !== "/" ||
      get(direct, "_ariver_appid") !== "11509317") return null;
    const nested = query(get(direct, "query"));
    return attribution(direct, waybill, cp) && attribution(nested, waybill, cp) ? "taobao" : null;
  }
  if (outer.protocol === "alipays:" && outer.hostname === "platformapi" && outer.pathname === "/startapp") {
    if (get(fields, "appId") !== "2021001141626787") return null;
    const nested = query(get(fields, "query"));
    if (fields.has("page")) {
      const page = get(fields, "page");
      const separator = page.indexOf("?");
      if (separator < 0 || page.slice(0, separator) !== "pages/logistic/logistic") return null;
      const detail = query(page.slice(separator + 1));
      return get(detail, "mailNo") === waybill && matchesTuple(detail, waybill, cp) &&
        get(nested, "from") === "xiaomifuyiping202409" && matchesTuple(nested, waybill, cp)
        ? "alipay" : null;
    }
    return attribution(nested, waybill, cp) ? "alipay" : null;
  }
  return null;
}

/** Keep upstream bytes and duplicate order within each App, then apply Pipi's App priority. */
export function accountAppTargets(
  links: readonly unknown[], provider: string, waybill: string, cp: string, secret: string,
): AccountAppTarget[] {
  const bytes = encodeURIComponent(JSON.stringify(links)).replace(/%[0-9a-f]{2}/gi, "_").length;
  if (bytes > 128 * 1024) return [];
  const targets: AccountAppTarget[] = [];
  for (const entry of links) {
    if (!entry || typeof entry !== "object") continue;
    const { type, link } = entry as Record<string, unknown>;
    if (typeof type !== "string" || type.toLowerCase() !== "app" ||
      typeof link !== "string" || !link || link.length > 16_384 ||
      link !== link.trim() || /[\u0000-\u001f\u007f-\u009f#]/.test(link)) continue;
    if (provider === "jingdong") {
      const prefix = "openapp.jdmobile://virtual?params=";
      if (link.toLowerCase().startsWith(prefix) && link.length > prefix.length) {
        targets.push({ kind: "jd", url: link });
      }
    } else if (provider === "cainiao" && waybill && cp) {
      const kind = cainiaoTarget(link, waybill, cp, secret);
      if (kind) targets.push({ kind, url: link });
    } else if (provider === "shunfeng" && waybill && cp) {
      // Match Pipi's SfAppLinks boundary; quick-app and webpage entries are not native App routes.
      const prefix = "com.sf-express://";
      if (link.toLowerCase().startsWith(prefix) && link.length > prefix.length) {
        targets.push({ kind: "sf", url: link });
      }
    }
  }
  return (["jd", "cainiao", "taobao", "alipay", "sf"] as const)
    .flatMap((kind) => targets.filter((target) => target.kind === kind));
}
