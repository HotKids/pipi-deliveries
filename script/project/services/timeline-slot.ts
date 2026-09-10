/**
 * Durable provider slots are independent whole-package caches. `v6_query` owns Meizu Online
 * history; legacy Meizu names normalize to this slot when reading stored rows.
 * `k100_h5` owns the fixed /app/query/?nu= page. `kuaidi100` is the unused paid poll slot.
 * Legacy names normalize once through normalizeTimelineSlot when reading stored rows.
 * `interface5` / `account` are feed packages (log level v5_list), not v5_query.
 */
export const TIMELINE_SLOT = {
  V5_QUERY: "v5_query",
  V4_QUERY: "v4_query",
  V6_QUERY: "v6_query",
  V2_QUERY: "v2_query",
  JD_H5: "jd_h5",
  CN_H5: "cn_h5",
  K100_H5: "k100_h5",
  KDNIAO: "kdniao",
  K100_PAID: "kuaidi100",
} as const;

export type TimelineSlot = typeof TIMELINE_SLOT[keyof typeof TIMELINE_SLOT];

/**
 * @param legacyWebSlot 旧的 `web` 包既可能是菜鸟 H5 也可能是 K100 页，读盘时按票据来源决定。
 */
export function normalizeTimelineSlot(
  value: unknown,
  legacyWebSlot: "cn_h5" | "k100_h5" = TIMELINE_SLOT.K100_H5,
): string {
  const clean = String(value || "").trim().toLowerCase();
  switch (clean) {
    case "local":
    case "moto":
      return TIMELINE_SLOT.V4_QUERY;
    case "route":
    case "meizu":
    case "meizu_picker":
    case "v6_picker":
      return TIMELINE_SLOT.V6_QUERY;
    case "oppo":
      return TIMELINE_SLOT.V2_QUERY;
    case "fallback":
      return TIMELINE_SLOT.KDNIAO;
    case "cainiao_h5":
      return TIMELINE_SLOT.CN_H5;
    case "kuaidi100_h5":
      return TIMELINE_SLOT.K100_H5;
    case "web":
      return legacyWebSlot;
    case "account_detail":
      return TIMELINE_SLOT.V5_QUERY;
    case "jingdong_h5":
      return TIMELINE_SLOT.JD_H5;
    default:
      return clean;
  }
}

export function isTimelineSlot(value: unknown, slot: string): boolean {
  return normalizeTimelineSlot(value) === slot;
}
