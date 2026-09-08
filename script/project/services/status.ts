import { normalizeTimelineSlot, TIMELINE_SLOT } from "./timeline-slot";
import type {
  Shipment,
  ShipmentIdentity,
  StatusSemantic,
  TimelinePackage,
  TrackNode,
  WidgetSnapshot,
} from "../models";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";

export const SIGNED_RETENTION_MS = EXPRESS_POLICY.retention.signedMs;
export const CANCELLED_RETENTION_MS = EXPRESS_POLICY.retention.cancelledMs;
export const SIGNED_REFRESH_MS = EXPRESS_POLICY.retention.signedRefreshMs;

export const STATUS_LABELS: Readonly<Record<StatusSemantic, string>> =
  EXPRESS_POLICY.status.labels;

export const LIST_PRIORITY: readonly StatusSemantic[] =
  EXPRESS_POLICY.status.listPriority;

export const WIDGET_PRIORITY: readonly StatusSemantic[] =
  EXPRESS_POLICY.status.widgetPriority;

export function statusLabel(semantic: StatusSemantic): string {
  return STATUS_LABELS[semantic] || STATUS_LABELS.UNKNOWN;
}

function timelinePresentationSemantic(
  timeline: TimelinePackage,
): StatusSemantic {
  if (timeline.semantic !== "UNKNOWN") return timeline.semantic;
  const tracks = timedTracks(timeline.tracks);
  if (!tracks.length) return "UNKNOWN";
  const inferred = packageSemantic("", tracks).semantic;
  return inferred === "UNKNOWN" ? "TRANSIT" : inferred;
}

function manualPickerStatusTimeline(
  shipment: Shipment,
): TimelinePackage | null {
  const candidates = [
    shipment.timeline,
    ...(shipment.manualTimelines || []),
  ].filter((timeline) =>
    timelineCapability(timeline.provider) === "route" &&
    timedTracks(timeline.tracks).length > 0
  );
  return selectTimelineAuthority(null, candidates);
}

export function shipmentPresentationStatus(
  shipment: Shipment,
): Readonly<{ semantic: StatusSemantic; text: string }> {
  const presentation = shipment.statusPresentation;
  const unprojectedOrder = Boolean(
    shipment.identity.accountOrder &&
    !normalizedProjectedWaybill(shipment.identity),
  );
  const usesOrderPresentation = Boolean(
    presentation?.scope === "ORDER" &&
    unprojectedOrder,
  );
  const text = String(presentation?.text || "").trim();
  if (
    unprojectedOrder &&
    (
      shipment.timeline.semantic === "COMPLETED" ||
      shipment.timeline.semantic === "CANCELLED"
    )
  ) {
    return {
      semantic: shipment.timeline.semantic,
      text: shipment.timeline.semantic === "COMPLETED"
        ? "已完成"
        : statusLabel("CANCELLED"),
    };
  }
  if (
    usesOrderPresentation && presentation &&
    (
      presentation.semantic === "PICKED" ||
      semanticFromText(text) === "PICKED"
    )
  ) {
    return { semantic: "ORDERED", text: statusLabel("ORDERED") };
  }
  if (
    presentation &&
    usesOrderPresentation &&
    Object.prototype.hasOwnProperty.call(STATUS_LABELS, presentation.semantic) &&
    text
  ) {
    return {
      semantic: presentation.semantic,
      text: presentation.semantic === "COMPLETED" ? "已完成" : text,
    };
  }
  const statusTimeline = shipment.identity.manuallyAdded
    ? manualPickerStatusTimeline(shipment) || shipment.timeline
    : shipment.timeline;
  const semantic = shipment.identity.manuallyAdded
    ? timelinePresentationSemantic(statusTimeline)
    : statusTimeline.semantic;
  // A richer timeline must never cost the row its status. The JD H5 and KDNiao packages carry no
  // per-node structured status at all, so once the 2026-09-04 node-count rule made them complete
  // they replaced the feed package and two signed-for rows fell to 暂无状态 with their delivery
  // text unchanged. The account record's own structured status is the fallback — structured to
  // structured, never inferred from the node text (AGENTS §9 forbids reading status from prose).
  if (semantic === "UNKNOWN" && presentation && presentation.semantic !== "UNKNOWN") {
    return {
      semantic: presentation.semantic,
      text: presentation.semantic === "COMPLETED"
        ? "已完成"
        : statusLabel(presentation.semantic),
    };
  }
  return { semantic, text: statusLabel(semantic) };
}

export function shipmentDetailPresentationStatus(
  shipment: Shipment,
  detailTimeline: TimelinePackage,
): Readonly<{ semantic: StatusSemantic; text: string }> {
  if (!shipment.identity.manuallyAdded) {
    return shipmentPresentationStatus(shipment);
  }
  const statusTimeline = manualPickerStatusTimeline(shipment) || detailTimeline;
  const semantic = timelinePresentationSemantic(statusTimeline);
  return { semantic, text: statusLabel(semantic) };
}

/** 备注分隔符（用户定 2026-09-05 晚）：状态词 · 备注。 */
export const NOTE_SEPARATOR = " · ";

/** 列表页、详情页、4×2 桌面卡片共用：状态词后面拼上用户备注（没有备注就是状态词本身）。 */
export function withNote(statusText: string, note?: string): string {
  const trimmed = String(note || "").trim();
  return trimmed ? `${statusText}${NOTE_SEPARATOR}${trimmed}` : statusText;
}

export function withShipmentNote(statusText: string, shipment: Shipment): string {
  return withNote(statusText, shipment.note);
}

export function widgetStatusLabel(semantic: StatusSemantic): string {
  if (semantic === "DANGER") return "异常件";
  return statusLabel(semantic);
}

// 三端同一张状态色表（用户定 2026-09-05：派送中与已签收不能同色）：异常红、待取件橙、
// 派送中绿、已签收青、揽件/运输蓝、下单/发货黄、已取消与未知灰。Pipi ExpressNotificationVisuals、
// Lite ExpressListActivity/ExpressDetailActivity.statusColor 同表。
export function statusTint(semantic: StatusSemantic): string {
  switch (semantic) {
    case "WAITING_PICKUP":
      return "systemOrange";
    case "DELIVERY":
      return "systemGreen";
    case "COMPLETED":
      return "systemTeal";
    case "TRANSIT":
    case "PICKED":
      return "systemBlue";
    case "SHIPPED":
    case "ORDERED":
      return "systemYellow";
    case "DANGER":
      return "systemRed";
    case "CANCELLED":
    default:
      return "secondaryLabel";
  }
}

export function normalizeWaybill(value: string): string {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function normalizedProjectedWaybill(
  identity: Pick<ShipmentIdentity, "projectedWaybill" | "sourceId"> | null | undefined,
): string {
  const projected = normalizeWaybill(identity?.projectedWaybill || "");
  const sourceId = normalizeWaybill(identity?.sourceId || "");
  return projected && projected !== sourceId ? projected : "";
}

export function waybillSuffix(value: string): string {
  const normalized = normalizeWaybill(value);
  return normalized.length <= 4 ? normalized : normalized.slice(-4);
}

export function parseProviderTime(value: string): number | null {
  const clean = String(value || "").trim();
  const simple = clean.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!simple) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = simple;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    year < 1000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }
  const millis = Date.UTC(year, month - 1, day, hour - 8, minute, second);
  return Number.isFinite(millis) ? millis : null;
}

export function semanticFromEventCode(code: string): StatusSemantic {
  switch (String(code || "").trim().toUpperCase()) {
    case "101":
    case "102":
      return "ORDERED";
    case "1":
    case "103":
      return "PICKED";
    case "0":
    case "7":
    case "8":
    case "10":
    case "11":
    case "12":
    case "1001":
    case "1002":
    case "1003":
      return "TRANSIT";
    case "5":
      return "DELIVERY";
    case "501":
      return "WAITING_PICKUP";
    case "3":
    case "301":
    case "302":
    case "303":
    case "304":
      return "COMPLETED";
    case "401":
      return "CANCELLED";
    case "2":
    case "4":
    case "6":
    case "13":
    case "14":
    case "201":
    case "202":
    case "203":
    case "204":
    case "205":
    case "206":
    case "207":
    case "208":
    case "209":
    case "210":
      return "DANGER";
    default:
      return "UNKNOWN";
  }
}

/**
 * The client's only text→status table, used where a source carries no structured state at all
 * (AGENTS §9 keeps status on the structured fields wherever they exist).
 *
 * The account parser used to keep a private second copy of this table whose WAITING_PICKUP and
 * ORDERED branches had drifted wider. The copies are now one function and the union is what
 * survives: narrowing to the old status.ts wording would have downgraded the JD feed's
 * 「…拣货完成，待出库…」 row from 已下单 and a 代取件点/待领取 row from 待取件 to 暂无状态, and would have
 * kept containsTimelineStartTrack blind to a start node the same row already displays as one.
 */
export function semanticFromText(value: string): StatusSemantic {
  const text = String(value || "").replace(/\s+/g, "");
  if (!text) return "UNKNOWN";
  if (/已签收|已妥投/.test(text)) return "COMPLETED";
  if (/已取消|订单关闭/.test(text)) return "CANCELLED";
  if (/待取件|代取件|等待取件|待领取|取件码/.test(text)) return "WAITING_PICKUP";
  if (/派送中|正在派送|配送中|正在配送/.test(text)) return "DELIVERY";
  // 顺丰的揽收节点写「顺丰速运 已收取快件」(2026-09-05 三端同补)，否则那包永远判不完整。
  if (/已揽收|已揽件|揽收完成|揽件成功|揽收成功|已收寄|收取快件/.test(text)) return "PICKED";
  if (/运输中|转运|分拨|已发往|已到达/.test(text)) return "TRANSIT";
  if (/已发货|商家已发货/.test(text)) return "SHIPPED";
  if (/已下单|已经下单|订单已创建|订单已提交|订单已完成|配送完成|等待出库|正在打包|拣货/.test(text)) {
    return "ORDERED";
  }
  if (/异常|问题件/.test(text)) return "DANGER";
  return "UNKNOWN";
}

export function semanticFromStored(
  code: string,
  description: string,
): StatusSemantic {
  switch (String(code || "").trim().toUpperCase()) {
    case "CANCEL":
    case "CANCELLED":
      return "CANCELLED";
    case "FAILED":
    case "PROBLEM":
    case "EXCEPTION":
      return "DANGER";
    case "CREATE":
    case "ORDER":
    case "ORDERED":
      return "ORDERED";
    case "SHIPPED":
    case "CONSIGN":
      return "SHIPPED";
    case "GOT":
    case "ACCEPT":
    case "COLLECT":
    case "PICKED":
      return "PICKED";
    case "TRANSPORT":
    case "TRANSIT":
    case "INTRANSIT":
      return "TRANSIT";
    case "DELIVERING":
    case "DELIVERY":
    case "DISPATCH":
      return "DELIVERY";
    case "AGENT_SIGN":
    case "WAITING_PICKUP":
      return "WAITING_PICKUP";
    case "SIGN":
    case "SIGNED":
    case "COMPLETED":
      return "COMPLETED";
    default:
      return semanticFromText(description);
  }
}

export function semanticFromAccountState(
  stateNumber: unknown,
  stateText: string,
): StatusSemantic {
  switch (String(stateNumber ?? "").trim()) {
    case "101":
      return "ORDERED";
    case "102":
      return "SHIPPED";
    case "103":
      return "PICKED";
    case "104":
      return "TRANSIT";
    case "105":
      return "DELIVERY";
    case "106":
      return "WAITING_PICKUP";
    case "107":
      return "COMPLETED";
    case "108":
    case "109":
    case "110":
      return "DANGER";
    case "111":
      return "CANCELLED";
    default:
      return semanticFromText(stateText);
  }
}

export function accountOrderSemantic(
  summary: string,
  sourceSemantic: StatusSemantic,
): StatusSemantic {
  const text = String(summary || "").replace(/\s+/g, "");
  if (/订单.*已完成|订单完成|配送完成|^已完成$/.test(text)) {
    return "COMPLETED";
  }
  if (/已取消|订单关闭/.test(text)) return "CANCELLED";
  if (
    sourceSemantic === "PICKED" ||
    semanticFromText(text) === "PICKED"
  ) {
    return EXPRESS_POLICY.orders.unprojectedSemantic;
  }
  return sourceSemantic;
}

/** 京东联合页嫁接进来的节点带 `_pipiStatusSource: "jingdong_h5"`；feed 自己的节点不带。 */
export function isJingDongH5Track(track: TrackNode): boolean {
  return String(track.raw?._pipiStatusSource || "").trim().toLowerCase() === "jingdong_h5";
}

/**
 * 用户定 2026-09-05 晚：feed 增量与 query 是两个独立的包，不拼接。把一个 source 包拆成 feed 自己
 * 的节点（留在 source 槽）和京东联合页嫁接的节点（作为 jd_h5 槽的包，由详情页选包）。H5 只供
 * 轨迹不供状态，所以拆出去的包语义是 UNKNOWN；`complete` 沿用原包的展开证明。
 */
export function splitJingDongH5Nodes(
  timeline: TimelinePackage,
): { feed: TimelinePackage; jdH5: TimelinePackage | null } {
  const h5 = timeline.tracks.filter(isJingDongH5Track);
  if (!h5.length) return { feed: timeline, jdH5: null };
  const feedTracks = timeline.tracks.filter((track) => !isJingDongH5Track(track));
  const feedLatest = timedTracks(feedTracks)[0] || feedTracks[0];
  const feed: TimelinePackage = {
    ...timeline,
    tracks: feedTracks,
    complete: false,
    latestTimeText: feedLatest?.timeText || (feedTracks.length ? timeline.latestTimeText : ""),
    latestDetail: feedLatest?.detail || (feedTracks.length ? timeline.latestDetail : ""),
  };
  const sortedH5 = [...h5].sort((left, right) => (right.timeMs || 0) - (left.timeMs || 0));
  const h5Latest = timedTracks(sortedH5)[0] || sortedH5[0];
  const jdH5: TimelinePackage = {
    ...timeline,
    provider: TIMELINE_SLOT.JD_H5,
    tracks: sortedH5,
    complete: timeline.complete === true,
    structuredStatus: false,
    semantic: "UNKNOWN",
    statusEventAtMs: null,
    latestTimeText: h5Latest.timeText,
    latestDetail: h5Latest.detail,
  };
  return { feed, jdH5 };
}

export function timedTracks(tracks: readonly TrackNode[]): TrackNode[] {
  return tracks.filter(
    (track) =>
      typeof track.timeMs === "number" &&
      Number.isFinite(track.timeMs) &&
      Boolean(track.detail.trim()) &&
      // AGENTS §9: a forecast note is no more an event than a provider error is, so it may not
      // be counted, ranked by time, or used to prove a timeline is complete.
      !isNonEventDetail(track.detail),
  );
}

export function containsTimelineStartTrack(
  tracks: readonly TrackNode[],
): boolean {
  const isStart = (semantic: StatusSemantic) =>
    semantic === "ORDERED" || semantic === "PICKED";
  return timedTracks(tracks).some((track) => {
    const codes = [track.statusCode, track.raw.statusCode];
    return codes.some((code) =>
      isStart(semanticFromTrackCode(track, code)) ||
      isStart(semanticFromStored(String(code ?? ""), track.detail))
    ) || isStart(semanticFromText(track.detail));
  });
}

export function containsTimelinePickupTrack(
  tracks: readonly TrackNode[],
): boolean {
  return timedTracks(tracks).some((track) => {
    const codes = [track.statusCode, track.raw.statusCode];
    return codes.some((code) =>
      semanticFromTrackCode(track, code) === "PICKED" ||
      semanticFromStored(String(code ?? ""), track.detail) === "PICKED"
    ) || semanticFromText(track.detail) === "PICKED";
  });
}

function semanticFromTrackCode(
  track: TrackNode,
  code: unknown,
): StatusSemantic {
  const source = String(track.raw._pipiStatusSource || "")
    .trim()
    .toLowerCase();
  if (
    source === "account" || source === "interface5" || source === "interface6"
  ) {
    return semanticFromAccountState(code, track.detail);
  }
  return semanticFromEventCode(String(code ?? ""));
}

/** Provider/service failures are never logistics events or user-facing timeline text. */
export function isProviderErrorDetail(value: string): boolean {
  const clean = String(value || "").trim().replace(/\s+/g, "");
  const lower = clean.toLowerCase();
  return lower.startsWith("noresult")
    || lower.startsWith("mismatchingcode")
    || clean.startsWith("验证码错误")
    || clean.startsWith("查无结果")
    || clean === "暂无状态"
    || clean === "暂无物流信息"
    || clean === "暂无物流动态"
    || clean === "快递状态已更新，点击查看>>";
}

/**
 * Anything a provider boundary must drop before a row can become an event.
 *
 * Forecast notes are NOT in here, and not anywhere else (user decision 2026-09-04, revoking 裁决 A
 * outright): the row shows whatever the source returned. No wording test touches the timeline, the
 * node counts or the headline. What remains is the provider's own error placeholder.
 */
export function isNonEventDetail(value: string): boolean {
  return isProviderErrorDetail(value);
}

/**
 * The track a surface should show as the headline: simply the newest one. Mirrors Pipi's
 * TrackTimelinePolicy headline loop — no wording is filtered.
 */
export function headlineTrack(
  tracks: readonly TrackNode[],
): TrackNode | null {
  return tracks.length ? tracks[0] : null;
}

export function usableTimedTracks(
  tracks: readonly TrackNode[],
): TrackNode[] {
  return timedTracks(tracks);
}

export function latestEventEvidence(
  tracks: readonly TrackNode[],
): { semantic: StatusSemantic; eventAtMs: number | null } {
  let newestAt: number | null = null;
  let newestSemantic: StatusSemantic = "UNKNOWN";
  for (const track of tracks) {
    const hasRawStatus = Object.prototype.hasOwnProperty.call(
      track.raw,
      "statusCode",
    );
    if (
      !hasRawStatus ||
      track.timeMs == null ||
      !Number.isFinite(track.timeMs)
    ) {
      continue;
    }
    const semantic = semanticFromTrackCode(track, track.raw.statusCode);
    if (newestAt == null || track.timeMs > newestAt) {
      newestAt = track.timeMs;
      newestSemantic = semantic;
    } else if (track.timeMs === newestAt && semantic !== newestSemantic) {
      newestSemantic = "UNKNOWN";
    }
  }
  return { semantic: newestSemantic, eventAtMs: newestAt };
}

export function packageSemantic(
  summaryState: string,
  tracks: readonly TrackNode[],
): { semantic: StatusSemantic; eventAtMs: number | null } {
  const timed = usableTimedTracks(tracks).sort(
    (left, right) => (right.timeMs || 0) - (left.timeMs || 0),
  );
  const evidence = latestEventEvidence(tracks.filter(
    (track) => !track.detail.trim() || !isNonEventDetail(track.detail),
  ));
  if (timed.length && String(summaryState || "").trim() === "3") {
    return {
      semantic: "COMPLETED",
      eventAtMs: Math.max(timed[0].timeMs || 0, evidence.eventAtMs || 0) || null,
    };
  }
  if (evidence.semantic !== "UNKNOWN") return evidence;
  if (!timed.length) return { semantic: "UNKNOWN", eventAtMs: null };
  const semantic = semanticFromText(timed[0].detail);
  return {
    semantic,
    eventAtMs: semantic === "UNKNOWN" ? null : timed[0].timeMs,
  };
}

const STRUCTURED_TRACK_FIELDS = [
  "logisticsStatus",
  "logisticsStatusDesc",
  "statusCode",
  "status",
] as const;

function normalizeTrackText(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeTrackEvent(value: unknown): string {
  return normalizeTrackText(value).replace(/[\s。！!，,；;：:]+$/g, "");
}

function structuredTrackValue(track: TrackNode, field: string): string {
  const raw = field === "statusCode"
    ? track.statusCode || track.raw[field]
    : track.raw[field];
  return typeof raw === "string" || typeof raw === "number"
    ? normalizeTrackText(raw).toLowerCase()
    : "";
}

function trackBaseKey(track: TrackNode): string {
  return [
    normalizeTrackText(track.timeText),
    normalizeTrackEvent(track.detail),
  ].join("\u0000");
}

function structuredTrackKey(track: TrackNode): string {
  return [
    ...STRUCTURED_TRACK_FIELDS.map((field) =>
      structuredTrackValue(track, field)
    ),
    structuredTrackValue(track, "_pipiStatusSource"),
  ].join("\u0001");
}

function compatibleStructuredTrack(left: TrackNode, right: TrackNode): boolean {
  for (const field of STRUCTURED_TRACK_FIELDS) {
    const leftValue = structuredTrackValue(left, field);
    const rightValue = structuredTrackValue(right, field);
    if (leftValue && rightValue && leftValue !== rightValue) return false;
  }
  const leftSource = structuredTrackValue(left, "_pipiStatusSource");
  const rightSource = structuredTrackValue(right, "_pipiStatusSource");
  return !leftSource || !rightSource || leftSource === rightSource;
}

function fillMissingTrackFields(target: TrackNode, source: TrackNode): TrackNode {
  const raw: Record<string, unknown> = { ...target.raw };
  for (const [key, value] of Object.entries(source.raw)) {
    const current = raw[key];
    if (
      current !== undefined &&
      current !== null &&
      (typeof current !== "string" || current.trim())
    ) {
      continue;
    }
    raw[key] = value;
  }
  return {
    ...target,
    statusCode: target.statusCode.trim() || source.statusCode.trim(),
    raw,
  };
}

/** 同包内同文案节点的合并窗口（用户定 2026-09-06，三端同 Pipi CROSS_SOURCE_DUPLICATE_WINDOW_SECONDS）。 */
export const NEAR_DUPLICATE_WINDOW_MS = 5 * 60_000;

/** 与 Pipi TrackTimelinePolicy.fingerprint 同法：NFKC、「您的快件/订单/包裹」归一、去尾标点、去空白。 */
function trackFingerprint(detail: string): string {
  return String(detail || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^您的(?:快件|订单|包裹)\s*/, "您的物流")
    .replace(/[。.!！?？,，;；、…]+$/, "")
    .replace(/\s+/g, "");
}

/**
 * 同一个包内，文案指纹相同、相距不超过 5 分钟、结构化状态不冲突的两条节点算同一条：保留较新的那条，
 * 老的只补空字段（用户定 2026-09-06，三端统一；Pipi 早已如此，Lite 原来是相邻同文案不看时间）。
 * 京东会把同一条提示重发（4424 的两条「预计…」秒数不同）；相隔几十分钟的同文案（0822 的两条
 * 「温馨提示」）仍是两条事件。
 */
function collapseNearTimeDuplicates(sorted: readonly TrackNode[]): TrackNode[] {
  const output: TrackNode[] = [];
  for (const candidate of sorted) {
    const candidateAt = candidate.timeMs;
    const fingerprint = trackFingerprint(candidate.detail);
    let duplicateIndex = -1;
    if (candidateAt != null && fingerprint) {
      duplicateIndex = output.findIndex((existing) =>
        existing.timeMs != null &&
        trackFingerprint(existing.detail) === fingerprint &&
        Math.abs(existing.timeMs - candidateAt) <= NEAR_DUPLICATE_WINDOW_MS &&
        compatibleStructuredTrack(existing, candidate)
      );
    }
    if (duplicateIndex < 0) {
      output.push(candidate);
    } else {
      output[duplicateIndex] = fillMissingTrackFields(output[duplicateIndex], candidate);
    }
  }
  return output;
}

export function mergeTracks(
  current: readonly TrackNode[],
  incoming: readonly TrackNode[],
): TrackNode[] {
  const merged: Array<{ base: string; structured: string; track: TrackNode }> = [];
  // The latest successful response owns presentation. Its own older cache only fills
  // missing metadata, while genuinely conflicting structured states remain separate.
  for (const track of [...incoming, ...current]) {
    if (!track.timeText.trim() && !track.detail.trim()) continue;
    const base = trackBaseKey(track);
    const structured = structuredTrackKey(track);
    const existing = merged.find(
      (entry) =>
        entry.base === base &&
        (entry.structured === structured ||
          compatibleStructuredTrack(entry.track, track)),
    );
    if (!existing) {
      merged.push({
        base,
        structured,
        track: { ...track, raw: { ...track.raw } },
      });
      continue;
    }
    existing.track = fillMissingTrackFields(existing.track, track);
    existing.structured = structuredTrackKey(existing.track);
  }
  const sorted = collapseNearTimeDuplicates(
    merged.map((entry) => entry.track).sort((left, right) => {
      const time = (right.timeMs || 0) - (left.timeMs || 0);
      if (time !== 0) return time;
      return right.timeText.localeCompare(left.timeText);
    }),
  );
  if (sorted.length <= 160) return sorted;
  const retained = new Set(sorted.slice(0, 156));
  for (const track of sorted.slice(156)) {
    const semantic = semanticFromTrackCode(track, track.statusCode) === "UNKNOWN"
      ? semanticFromText(track.detail)
      : semanticFromTrackCode(track, track.statusCode);
    if (
      semantic === "ORDERED" || semantic === "PICKED" ||
      semantic === "COMPLETED" || semantic === "CANCELLED"
    ) {
      retained.add(track);
    }
  }
  return sorted.filter((track) => retained.has(track));
}

const SAME_EVENT_PROGRESS: readonly StatusSemantic[] = [
  "ORDERED",
  "SHIPPED",
  "PICKED",
  "TRANSIT",
  "DELIVERY",
  "WAITING_PICKUP",
  "COMPLETED",
];

function rejectsSameEventRegression(
  current: StatusSemantic,
  incoming: StatusSemantic,
): boolean {
  if (current === incoming) return false;
  if (current === "CANCELLED" || current === "DANGER") return true;
  if (incoming === "CANCELLED" || incoming === "DANGER") return false;
  const currentRank = SAME_EVENT_PROGRESS.indexOf(current);
  const incomingRank = SAME_EVENT_PROGRESS.indexOf(incoming);
  return currentRank >= 0 && incomingRank >= 0 && incomingRank < currentRank;
}

/**
 * Shipment status progression for a projected account order. An order-scope summary may only
 * move the status forward: a terminal state always applies, a further stage applies, and an
 * earlier stage (typically the feed's coarse ORDERED) never rewinds shipment logistics.
 */
export function statusProgressionRank(semantic: string): number {
  switch (String(semantic || "").toUpperCase()) {
    case "UNKNOWN": return 0;
    case "ORDERED": return 1;
    case "PICKED": return 2;
    case "TRANSIT": return 3;
    case "DELIVERY": return 4;
    case "WAITING_PICKUP": return 4;
    case "COMPLETED": return 6;
    case "CANCELLED": return 6;
    default: return 3;
  }
}
export function isTerminalStatusSemantic(semantic: string): boolean {
  const value = String(semantic || "").toUpperCase();
  return value === "COMPLETED" || value === "CANCELLED";
}
export function incomingStatusAdvances(base: string, incoming: string): boolean {
  if (isTerminalStatusSemantic(incoming)) return true;
  if (isTerminalStatusSemantic(base)) return false;
  return statusProgressionRank(incoming) > statusProgressionRank(base);
}

/**
 * Re-reads the headline off a track set that has just grown.
 *
 * 用户定 2026-09-04: 头条 = 最新的有效时间节点. A merge installs the union of both track lists while
 * carrying the winner's stored headline verbatim, so a same-provider refresh that brought strictly
 * newer nodes but no recognizable state (semantic UNKNOWN) left the row showing 13:53 while
 * tracks[0] was already 14:57. Pipi fixed the same symptom in
 * ExpressSourcePolicy.preserveAutomaticOwnerTimeline; this is the single iOS rule for it, shared
 * with shipment-policy's own supplement step.
 *
 * Strictly newer only: an equal-time response from an earlier stage must not take the headline
 * (mergeTracks orders the incoming copy first among equal timestamps). The merged set only ever
 * grows, so the headline can never move backwards. Status is untouched — it keeps coming from the
 * structured fields (AGENTS §9).
 */
export function withMergedHeadline(value: TimelinePackage): TimelinePackage {
  const latest = headlineTrack(timedTracks(value.tracks));
  if (!latest) return value;
  // Overtaking is a comparison, so a stored headline whose own time cannot be read is left alone:
  // this rule exists to stop a newer node from being hidden, not to repair untimed headlines.
  const retainedAt = parseProviderTime(value.latestTimeText) || 0;
  if (!retainedAt) return value;
  return (latest.timeMs || 0) > retainedAt
    ? { ...value, latestTimeText: latest.timeText, latestDetail: latest.detail }
    : value;
}

export function mergeTimelinePackage(
  current: TimelinePackage | null,
  incoming: TimelinePackage,
): TimelinePackage {
  const incomingTimed = timedTracks(incoming.tracks);
  if (!current) return incoming;
  if (current.provider.toLowerCase() !== incoming.provider.toLowerCase()) {
    return incoming;
  }
  if (!incomingTimed.length) return current;

  const tracks = mergeTracks(current.tracks, incoming.tracks);
  const finalize = (
    value: TimelinePackage,
    keepStoredHeadline = false,
  ): TimelinePackage => {
    const rawCourierCode = String(
      value.rawCourierCode || current.rawCourierCode || incoming.rawCourierCode || "",
    ).trim();
    const retainedRaw = rawCourierCode
      ? { ...value, rawCourierCode }
      : value;
    const merged = isManualTimelineProvider(value.provider)
      ? {
          ...retainedRaw,
          complete:
            manualTimelineDeclaredComplete(current) ||
            manualTimelineDeclaredComplete(incoming),
          // Structured evidence belongs to the status snapshot selected below;
          // it must not stick merely because an older refresh had an enum.
          structuredStatus: value.structuredStatus === true,
        }
      : retainedRaw;
    // Every exit installs the merged track set, so every exit re-reads the headline from it.
    return keepStoredHeadline ? merged : withMergedHeadline(merged);
  };
  const currentTimed = timedTracks(current.tracks);
  const currentCompleted = current.semantic === "COMPLETED" && currentTimed.length > 0;
  const incomingCompleted = incoming.semantic === "COMPLETED" && incomingTimed.length > 0;
  if (
    EXPRESS_POLICY.manualAuthority.completedOutranksNonTerminal &&
    currentCompleted
  ) {
    // The only exit that keeps its stored headline: a signed row stays on its 已签收 line whatever
    // the merge absorbs afterwards, which is the whole point of the terminal freeze. Both arms of
    // the former ternary were identical, so the completed row is frozen either way.
    return finalize({
      ...current,
      tracks,
      successAtMs: Math.max(current.successAtMs, incoming.successAtMs),
    }, true);
  }
  if (incomingCompleted) return finalize({ ...incoming, tracks });
  const retainedCurrent = {
    ...current,
    tracks,
    successAtMs: Math.max(current.successAtMs, incoming.successAtMs),
  };
  if (incoming.semantic === "UNKNOWN") return finalize(retainedCurrent);
  if (current.semantic === "UNKNOWN") return finalize({ ...incoming, tracks });
  const currentEvent = timelineLatestEventAt(current);
  const incomingEvent = timelineLatestEventAt(incoming);
  if (incomingEvent <= 0 && currentEvent > 0) return finalize(retainedCurrent);
  if (currentEvent > 0 && incomingEvent < currentEvent) {
    return finalize(retainedCurrent);
  }
  if (
    currentEvent > 0 && incomingEvent === currentEvent &&
    rejectsSameEventRegression(current.semantic, incoming.semantic)
  ) {
    return finalize(retainedCurrent);
  }
  return finalize({ ...incoming, tracks });
}

const MANUAL_TIMELINE_PROVIDERS = new Set([
  TIMELINE_SLOT.V5_QUERY,
  TIMELINE_SLOT.V4_QUERY,
  TIMELINE_SLOT.V6_PICKER,
  TIMELINE_SLOT.V2_QUERY,
  TIMELINE_SLOT.CN_H5,
  TIMELINE_SLOT.K100_H5,
  TIMELINE_SLOT.JD_H5,
  TIMELINE_SLOT.KDNIAO,
  TIMELINE_SLOT.K100_PAID,
]);

export type TimelineCapability =
  | "account"
  | "local"
  | "route"
  | "web"
  | "fallback"
  | "unknown";

/** Keeps legacy provider ids readable while new state and logs use capability names. */
export function timelineCapability(provider: unknown): TimelineCapability {
  const raw = String(provider || "").trim().toLowerCase();
  if (raw === "interface6" || raw === "interface5" || raw === "account") return "account";
  const value = normalizeTimelineSlot(raw);
  if (value === TIMELINE_SLOT.V5_QUERY) return "account";
  if (value === TIMELINE_SLOT.V4_QUERY) return "local";
  if (value === TIMELINE_SLOT.V6_PICKER || value === TIMELINE_SLOT.V2_QUERY) {
    return "route";
  }
  if (
    value === TIMELINE_SLOT.JD_H5 || value === TIMELINE_SLOT.CN_H5 ||
    value === TIMELINE_SLOT.K100_H5
  ) return "web";
  if (value === TIMELINE_SLOT.KDNIAO || value === TIMELINE_SLOT.K100_PAID) {
    return "fallback";
  }
  return "unknown";
}

function isManualTimelineProvider(provider: string): boolean {
  return MANUAL_TIMELINE_PROVIDERS.has(normalizeTimelineSlot(provider));
}

function manualTimelineDeclaredComplete(value: TimelinePackage): boolean {
  const provider = value.provider.trim().toLowerCase();
  return typeof value.complete === "boolean"
    ? value.complete
    : timelineCapability(provider) === "fallback";
}

/**
 * A declared-complete package still has to look like a whole timeline before it may freeze a row.
 *
 * The minimum is keyed by the provider id the package carries, so the contract lists both ids the
 * KDNiao answer can arrive under: "fallback" is what manual-query writes today, "kdniao" is the id
 * kept by older persisted rows. Keyed by "kdniao" alone the guard never ran on a real package and a
 * one-node 已签收 answer outranked a richer partial one. Capability is deliberately not used here:
 * "fallback" also covers Kuaidi100, whose completeness may only come from its own /query contract
 * (AGENTS §9), never from counting nodes.
 */
export function manualTimelineIsComplete(value: TimelinePackage): boolean {
  if (!manualTimelineDeclaredComplete(value)) return false;
  const provider = normalizeTimelineSlot(value.provider);
  const thresholds =
    EXPRESS_POLICY.manualAuthority.terminalCompleteMinTimedTracksByProvider;
  const minimum = thresholds[
    provider as keyof typeof thresholds
  ] || 0;
  if (
    minimum > 0 &&
    (value.semantic === "COMPLETED" || value.semantic === "CANCELLED") &&
    timedTracks(value.tracks).length < minimum
  ) {
    return false;
  }
  return true;
}

export function timelineLatestEventAt(value: TimelinePackage): number {
  const candidates = [
    typeof value.statusEventAtMs === "number" &&
        Number.isFinite(value.statusEventAtMs)
      ? value.statusEventAtMs
      : 0,
    parseProviderTime(value.latestTimeText) || 0,
    ...value.tracks.map((track) =>
      typeof track.timeMs === "number" && Number.isFinite(track.timeMs)
        ? track.timeMs
        : 0
    ),
  ];
  return Math.max(0, ...candidates);
}

export function mergeTimelineAuthorities(
  current: readonly TimelinePackage[],
  incoming: TimelinePackage,
): TimelinePackage[] {
  if (
    EXPRESS_POLICY.manualAuthority.requiresTimedTrack &&
    !timedTracks(incoming.tracks).length
  ) {
    return [...current];
  }
  const provider = incoming.provider.trim().toLowerCase();
  const previous = current.find(
    (item) => item.provider.trim().toLowerCase() === provider,
  ) || null;
  const merged = mergeTimelinePackage(previous, incoming);
  return [
    ...current.filter(
      (item) => item.provider.trim().toLowerCase() !== provider,
    ),
    merged,
  ];
}

export function selectTimelineAuthority(
  sourceTimeline: TimelinePackage | null,
  manualTimelines: readonly TimelinePackage[],
): TimelinePackage | null {
  const usableManual = manualTimelines.filter(
    (item) =>
      !EXPRESS_POLICY.manualAuthority.requiresTimedTrack ||
      timedTracks(item.tracks).length > 0,
  );
  if (usableManual.length) {
    return [...usableManual].sort((left, right) => {
      return compareManualTimelineAuthority(left, right);
    })[0];
  }
  return sourceTimeline;
}

export function compareManualTimelineAuthority(
  left: TimelinePackage,
  right: TimelinePackage,
): number {
  const leftComplete = manualTimelineIsComplete(left);
  const rightComplete = manualTimelineIsComplete(right);
  const completeness = Number(rightComplete) - Number(leftComplete);
  if (completeness !== 0) return completeness;
  if (leftComplete && rightComplete) {
    const freshness = timelineLatestEventAt(right) - timelineLatestEventAt(left);
    if (freshness !== 0) return freshness;
  }
  return manualProviderRank(left.provider) - manualProviderRank(right.provider);
}

/** Ranks whole detail packages without borrowing nodes from another provider. */
export function compareTimelinePackageCompleteness(
  left: TimelinePackage,
  right: TimelinePackage,
): number {
  const leftComplete = manualTimelineIsComplete(left);
  const rightComplete = manualTimelineIsComplete(right);
  const completeness = Number(rightComplete) - Number(leftComplete);
  if (completeness !== 0) return completeness;
  if (leftComplete && rightComplete) {
    const freshness = timelineLatestEventAt(right) - timelineLatestEventAt(left);
    if (freshness !== 0) return freshness;
  }
  return manualProviderRank(left.provider) - manualProviderRank(right.provider);
}

/**
 * 详情页排序的最后一把钥匙：既有 provider 次序（用户定 2026-09-04）。
 * 与 compareTimelinePackageCompleteness 的区别是这里**不看**各家自报的 `complete`，也不看谁的
 * 事件更新——那两样在详情选包上已被「完整判据 → 有效节点数」取代。
 */
export function compareTimelineProviderOrder(
  left: TimelinePackage,
  right: TimelinePackage,
): number {
  return manualProviderRank(left.provider) - manualProviderRank(right.provider);
}

function manualProviderRank(provider: string): number {
  const normalized = normalizeTimelineSlot(provider);
  const capability = timelineCapability(normalized);
  if (normalized === TIMELINE_SLOT.V6_PICKER) return 0;
  const capabilityRank = ["local", "web", "route", "fallback"].indexOf(capability);
  if (capabilityRank >= 0) return capabilityRank + 1;
  const rank = EXPRESS_POLICY.manualAuthority.tieBreakOrder.indexOf(
    normalized as typeof EXPRESS_POLICY.manualAuthority.tieBreakOrder[number],
  );
  return rank < 0
    ? EXPRESS_POLICY.manualAuthority.tieBreakOrder.length + 1
    : rank + 1;
}

function listRank(semantic: StatusSemantic): number {
  const rank = LIST_PRIORITY.indexOf(semantic);
  return rank < 0 ? LIST_PRIORITY.length : rank;
}

function isOrderCompletedFallback(shipment: Shipment): boolean {
  return Boolean(
    shipment.identity.accountOrder &&
    !normalizedProjectedWaybill(shipment.identity) &&
    shipment.statusPresentation?.scope === "ORDER" &&
    shipment.statusPresentation.semantic === "COMPLETED",
  );
}

export function sortShipments(shipments: readonly Shipment[]): Shipment[] {
  return [...shipments].sort((left, right) => {
    const leftSemantic = shipmentPresentationStatus(left).semantic;
    const rightSemantic = shipmentPresentationStatus(right).semantic;
    const rank = listRank(leftSemantic) - listRank(rightSemantic);
    if (rank !== 0) return rank;
    const completionKind = Number(isOrderCompletedFallback(left)) -
      Number(isOrderCompletedFallback(right));
    if (completionKind !== 0) return completionKind;
    const event =
      (right.timeline.statusEventAtMs || 0) -
      (left.timeline.statusEventAtMs || 0);
    if (event !== 0) return event;
    const updated = right.updatedAtMs - left.updatedAtMs;
    if (updated !== 0) return updated;
    return right.identity.id.localeCompare(left.identity.id);
  });
}

function validLifecycleTime(value: unknown, now: number): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= now + 5 * 60 * 1000
    ? value
    : 0;
}

function latestTimelineTime(shipment: Shipment, now: number): number {
  return validLifecycleTime(
    parseProviderTime(shipment.timeline.latestTimeText),
    now,
  );
}

function signedAt(shipment: Shipment, now: number): number {
  let value = Math.max(
    validLifecycleTime(shipment.timeline.statusEventAtMs, now),
    latestTimelineTime(shipment, now),
  );
  for (const track of shipment.timeline.tracks) {
    const detail = track.detail.replace(/\s+/g, "");
    if (!/签收|妥投|配送完成/.test(detail)) continue;
    value = Math.max(value, validLifecycleTime(track.timeMs, now));
  }
  // 兜底取「第一次进入终态」的时刻，不取 updatedAtMs：后者每次写入都刷新，倒计时永远归零。
  return value || validLifecycleTime(shipment.settledAtMs, now);
}

function cancelledAt(shipment: Shipment, now: number): number {
  return Math.max(
    validLifecycleTime(shipment.timeline.statusEventAtMs, now),
    latestTimelineTime(shipment, now),
  ) || validLifecycleTime(shipment.settledAtMs, now);
}

export function pruneShipments(
  shipments: readonly Shipment[],
  now = Date.now(),
): Shipment[] {
  return shipments.filter((shipment) => {
    if (shipment.timeline.semantic === "COMPLETED") {
      const eventAt = signedAt(shipment, now);
      if (!eventAt) return true;
      return now - eventAt < SIGNED_RETENTION_MS;
    }
    if (shipment.timeline.semantic === "CANCELLED") {
      const eventAt = cancelledAt(shipment, now);
      if (!eventAt) return true;
      return now - eventAt < CANCELLED_RETENTION_MS;
    }
    return true;
  });
}

export function shouldRefreshShipment(
  shipment: Shipment,
  now = Date.now(),
): boolean {
  const forcedCompletedAtMs = Number(shipment.forcedCompletedAtMs);
  if (Number.isFinite(forcedCompletedAtMs) && forcedCompletedAtMs > 0) {
    return false;
  }
  if (shipment.timeline.semantic !== "COMPLETED") return true;
  const eventAt = signedAt(shipment, now);
  return !eventAt || now - eventAt < SIGNED_REFRESH_MS;
}

export function buildWidgetSnapshot(
  shipments: readonly Shipment[],
  now = Date.now(),
): WidgetSnapshot {
  const sorted = sortShipments(pruneShipments(shipments, now));
  const presentations = sorted.map((item) => ({
    item,
    status: shipmentPresentationStatus(item),
  }));
  let headline: WidgetSnapshot["headline"] = null;
  for (const semantic of WIDGET_PRIORITY) {
    let matching = presentations.filter(
      (presentation) => presentation.status.semantic === semantic,
    );
    if (semantic === "COMPLETED") {
      const signed = matching.filter(
        (presentation) => !isOrderCompletedFallback(presentation.item),
      );
      if (signed.length) matching = signed;
    }
    const count = matching.length;
    if (count > 0) {
      const first = matching[0].status;
      headline = {
        semantic,
        label: first.text === statusLabel(semantic)
          ? widgetStatusLabel(semantic)
          : first.text,
        count,
      };
      break;
    }
  }
  return {
    version: 2,
    generatedAtMs: now,
    totalCount: sorted.length,
    activeCount: sorted.filter(
      (item) => {
        const semantic = shipmentPresentationStatus(item).semantic;
        return semantic !== "COMPLETED" && semantic !== "CANCELLED";
      },
    ).length,
    headline,
    compactIcons: sorted.slice(0, EXPRESS_POLICY.widgets.compactIconLimit).map((item) => ({
      shipmentId: item.identity.id,
      companyName: item.identity.companyName,
      courierCode: item.identity.courierCode,
      accountOrder: Boolean(
        item.identity.accountOrder && !normalizedProjectedWaybill(item.identity),
      ),
    })),
    rows: sorted.slice(0, EXPRESS_POLICY.widgets.mediumRowLimit).map((item) => {
      const presentation = shipmentPresentationStatus(item);
      return {
        shipmentId: item.identity.id,
        companyName: item.identity.companyName,
        courierCode: item.identity.courierCode,
        accountOrder: Boolean(
          item.identity.accountOrder && !normalizedProjectedWaybill(item.identity),
        ),
        waybillSuffix: waybillSuffix(
          normalizedProjectedWaybill(item.identity) || item.timeline.waybill,
        ),
        semantic: presentation.semantic,
        statusLabel: presentation.semantic === "DANGER" ? "异常件" : presentation.text,
        // 备注单独带着：4×2 拼成「状态词 · 备注」，2×2 放不下只显示状态词（用户定 2026-09-06）。
        note: String(item.note || "").trim(),
        latestDetail: item.timeline.latestDetail,
      };
    }),
  };
}
