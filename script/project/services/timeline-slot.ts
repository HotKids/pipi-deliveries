/**
 * 轨迹缓存的槽名，三端统一等于日志里的 `level` 用词（用户定 2026-09-05）：
 * v5_query（接口 5 按件详情）、v4_query（moto）、v6_picker（魅族 picker）、v2_query（OPPO）、
 * jd_h5、cn_h5、k100_h5（picker 返回的 K100 详情页）、kdniao；`kuaidi100` 是网关付费 poll，留着不用。
 * 旧写法（local / route / fallback / web / moto / meizu / oppo / cainiao_h5 / kuaidi100_h5 /
 * account_detail）只在 {@link normalizeTimelineSlot} 里翻译一次；持久化的旧行在读盘时改名。
 * `interface5` / `account` 是 feed（列表增量，日志名 v5_list），不是 v5_query 槽（2026-09-06）。
 */
export const TIMELINE_SLOT = {
  V5_QUERY: "v5_query",
  V4_QUERY: "v4_query",
  V6_PICKER: "v6_picker",
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
      return TIMELINE_SLOT.V6_PICKER;
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
