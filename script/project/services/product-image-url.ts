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
        host === "360buyimg.com" || host.endsWith(".360buyimg.com"))
      ? url.href : null;
  } catch { return null; }
}

export function normalizedProductImageMetadataURL(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f\\]/.test(value) || /^https:\/\/[^/]*@/i.test(value)) return null;
  try {
    const url = new URL(value);
    // Metadata historically normalizes before the downloader applies its raw-authority boundary.
    return !url.username && !url.password ? allowedProductImageURL(url.href) : null;
  } catch { return null; }
}
