function pddImageHost(host: string): boolean {
  return /^img(?:-[1-4])?\.pddpic\.com$/.test(host);
}

export function allowedProductImageURL(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    const authority = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1];
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && authority != null && !authority.includes("@") &&
      (!url.port || url.port === "443") &&
      (host === "jd.com" || host.endsWith(".jd.com") ||
        host === "360buyimg.com" || host.endsWith(".360buyimg.com") ||
        host === "img.alicdn.com" && !url.search && !url.hash ||
        pddImageHost(host) && url.pathname.length > 1 && !/[?#]/.test(trimmed))
      ? url.href : null;
  } catch { return null; }
}

export function pddProductImageURL(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(value)) return "";
  const input = value.trim().replace(/^(?:http:)?\/\//i, "https://")
    .replace(/^https:\/\/t00img\.yangkeduo\.com(?=\/)/i, "https://img.pddpic.com");
  const url = allowedProductImageURL(input);
  return url && pddImageHost(new URL(url).hostname) ? url : "";
}

export function cloudProductImageURL(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || !/^https:\/\/[^@/?#]+\/[^\s?#\\]+$/i.test(value)) return "";
  const allowed = allowedProductImageURL(value);
  if (!allowed) return "";
  const { hostname } = new URL(allowed);
  return hostname === "img.alicdn.com" || hostname.endsWith(".360buyimg.com") || pddImageHost(hostname)
    ? allowed : "";
}

export function cainiaoProductImageURL(value: unknown): string {
  if (typeof value !== "string") return "";
  const input = value.trim().replace(/^http:\/\//i, "https://").replace(/^\/\//, "https://");
  const url = allowedProductImageURL(input);
  return url && new URL(url).hostname === "img.alicdn.com" ? url : "";
}

export function normalizedProductImageMetadataURL(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f\\]/.test(value) || /^https:\/\/[^/]*@/i.test(value)) return null;
  try {
    const url = new URL(value);
    // Metadata historically normalizes before the downloader applies its raw-authority boundary.
    return !url.username && !url.password && url.hostname !== "img.alicdn.com" && !pddImageHost(url.hostname)
      ? allowedProductImageURL(url.href) : null;
  } catch { return null; }
}
