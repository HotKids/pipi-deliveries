import { nodeNormalizedStatus, responseNormalizedStatus, timelineNormalizedStatus, statusPriority, statusProjectionFields } from "./worker-status";
import { normalizeTimelineSlot, TIMELINE_SLOT } from "./timeline-slot";
import {
  accountOrderPageConfirmedEmpty,
  accountOrderProjectionRouteHash,
} from "./account-sync-policy";
import { accountOrderTextIdentity } from "./account-order-text-identity";
import type {
  Shipment,
  ShipmentIdentity,
  StatusSemantic,
  TimelinePackage,
  TrackNode,
  WidgetSnapshot,
} from "../models";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";
import { activeStatusLabelTable, statusDisplay } from "./status-labels";

export const SIGNED_RETENTION_MS = EXPRESS_POLICY.retention.signedMs;
export const CANCELLED_RETENTION_MS = EXPRESS_POLICY.retention.cancelledMs;

export const STATUS_LABELS: Readonly<Record<StatusSemantic, string>> =
  EXPRESS_POLICY.status.labels;

export const LIST_PRIORITY: readonly StatusSemantic[] =
  EXPRESS_POLICY.status.listPriority;

export const WIDGET_PRIORITY: readonly StatusSemantic[] =
  EXPRESS_POLICY.status.widgetPriority;

export function statusLabel(semantic: StatusSemantic): string {
  const table = activeStatusLabelTable();
  return table.labels[semantic] || table.labels.UNKNOWN;
}

/**
 * The one presentation of a status (audits L5/L1, user default #2, 2026-09-25): the shown semantic and
 * its label come from the status label table (bundled, replaced by the Worker snapshot's statusLabels),
 * never from the Worker's normalizedStatus.text. `orderScope` marks an order row without a real
 * waybill: its PICKED and SHIPPED show as 已下单 and its completion / cancellation use the order labels.
 * A Worker subtype code (STA_DELIVERING → 待派送) picks the subtype label.
 */
function presentStatus(
  semantic: StatusSemantic,
  orderScope: boolean,
  code = "",
): Readonly<{ semantic: StatusSemantic; text: string }> {
  const shown = statusDisplay({ scope: orderScope ? "ORDER" : "SHIPMENT", semantic, code });
  return { semantic: shown.semantic, text: shown.label };
}

/**
 * UNKNOWN is left as it was: a Worker UNKNOWN shows the Worker's own text (an older Worker sends none).
 * User default #2 would read 暂无状态 everywhere, but on 2026-09-09 the user ruled that the Home list
 * must not show 暂无状态; that conflict is reported back for a decision instead of being settled here.
 */
function workerUnknownPresentation(
  projection: ReturnType<typeof timelineNormalizedStatus>,
): Readonly<{ semantic: StatusSemantic; text: string }> | null {
  return projection?.semantic === "UNKNOWN" ? { semantic: "UNKNOWN", text: projection.text } : null;
}

function timelinePresentation(
  timeline: TimelinePackage,
  semantic: StatusSemantic,
  orderScope: boolean,
): Readonly<{ semantic: StatusSemantic; text: string }> {
  const projection = timelineNormalizedStatus(timeline);
  if (projection?.semantic === semantic) {
    const unknown = workerUnknownPresentation(projection);
    if (unknown) return unknown;
  }
  return presentStatus(semantic, orderScope, projection?.semantic === semantic ? projection.code : "");
}

function timelinePresentationSemantic(
  timeline: TimelinePackage,
): StatusSemantic {
  if (timelineNormalizedStatus(timeline) || timeline.semantic !== "UNKNOWN") return timeline.semantic;
  const tracks = timedTracks(timeline.tracks);
  if (!tracks.length) return "UNKNOWN";
  const inferred = packageSemantic("", tracks).semantic;
  if (tracks.some(track => jtNodeSemantic(track) !== undefined)) return inferred;
  return inferred === "UNKNOWN" ? "TRANSIT" : inferred;
}

export function shipmentPresentationStatus(
  shipment: Shipment,
): Readonly<{ semantic: StatusSemantic; text: string }> {
  const unprojectedOrder = Boolean(
    shipment.identity.accountOrder &&
    !normalizedProjectedWaybill(shipment.identity),
  );
  const projection = timelineNormalizedStatus(shipment.timeline);
  // A projected JD waybill's structured order completion reads as a signing (2026-09-14): only an
  // order row without a real waybill uses the order scope.
  if (projection) {
    return workerUnknownPresentation(projection) ||
      presentStatus(projection.semantic, unprojectedOrder, projection.code);
  }
  const presentation = shipment.statusPresentation;
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
    return presentStatus(shipment.timeline.semantic, true);
  }
  if (
    usesOrderPresentation && presentation &&
    (
      presentation.semantic === "PICKED" ||
      semanticFromText(text) === "PICKED"
    )
  ) {
    return presentStatus("ORDERED", true);
  }
  if (
    presentation &&
    usesOrderPresentation &&
    Object.prototype.hasOwnProperty.call(STATUS_LABELS, presentation.semantic) &&
    text
  ) {
    return presentStatus(presentation.semantic, true);
  }
  const semantic = shipment.identity.manuallyAdded
    ? timelinePresentationSemantic(shipment.timeline)
    : shipment.timeline.semantic;
  // A richer timeline must never cost the row its status. The JD H5 and KDNiao packages carry no
  // per-node structured status at all, so once the 2026-09-04 node-count rule made them complete
  // they replaced the feed package and two signed-for rows fell to 暂无状态 with their delivery
  // text unchanged. The account record's own structured status is the fallback — structured to
  // structured, never inferred from the node text (AGENTS §9 forbids reading status from prose).
  if (semantic === "UNKNOWN" && presentation && presentation.semantic !== "UNKNOWN") {
    return presentStatus(presentation.semantic, unprojectedOrder);
  }
  return timelinePresentation(shipment.timeline, semantic, unprojectedOrder);
}

export function shipmentDetailPresentationStatus(
  shipment: Shipment,
  detailTimeline: TimelinePackage,
): Readonly<{ semantic: StatusSemantic; text: string }> {
  if (!shipment.identity.manuallyAdded) {
    const ownerStatus = shipmentPresentationStatus(shipment);
    const unprojectedOrder = Boolean(
      shipment.identity.accountOrder && !normalizedProjectedWaybill(shipment.identity),
    );
    return ownerStatus.semantic === "UNKNOWN" && detailTimeline.structuredStatus &&
        detailTimeline.semantic !== "UNKNOWN"
      ? timelinePresentation(detailTimeline, detailTimeline.semantic, unprojectedOrder)
      : ownerStatus;
  }
  const semantic = timelinePresentationSemantic(detailTimeline);
  return timelinePresentation(detailTimeline, semantic, false);
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

/** The list label and retention must interpret the same raw logistics timestamp. */
export function parseListEventTime(value: string): number | null {
  const match = String(value || "").trim().match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?(\.\d{3})?(Z|[+-]\d{2}:\d{2})?$/,
  );
  if (!match) return null;
  const local = `${match[1]} ${match[2]}${match[3] || ":00"}`;
  const chinaTime = parseProviderTime(local);
  if (chinaTime == null) return null;
  const epoch = match[5]
    ? Date.parse(`${local.replace(" ", "T")}${match[4] || ""}${match[5]}`)
    : chinaTime + Number(match[4] || 0) * 1000;
  return Number.isFinite(epoch) ? epoch : null;
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
  if (/已取消|订单关闭/.test(text)) return "CANCELLED";
  // Collection context precedes completion prose; callers keep valid returned states authoritative.
  if (/待取件|代取件|等待取件|待领取|取件码/.test(text) ||
    /已(?:派送|送达|放在|将快件送达)[^，,。；;！？!?]*(?:驿站|快递柜|代收点)/.test(text)) {
    return "WAITING_PICKUP";
  }
  if (/已(?:签收|妥投|完成签收|确认收货|完成配送|送货上门)|已由[^，,。；;！？!?]+签收/.test(text) ||
    /已(?:派送|送达|将快件送达)(?:至)?【?(?:本人|收件人|家门口)|已放在【?(?:家门口|门口)/.test(text) ||
    /已(?:送达|将快件送达)(?:[，,。；;！？!?]|$)/.test(text)) {
    return "COMPLETED";
  }
  if (/派送中|正在派送|配送中|正在配送/.test(text)) return "DELIVERY";
  // 顺丰的揽收节点写「顺丰速运 已收取快件」(2026-09-05 三端同补)，否则那包永远判不完整。
  if (/已揽收|已揽件|揽收完成|揽件成功|揽收成功|已收寄|收取快件/.test(text)) return "PICKED";
  if (/运输中|转运|分拨|已发往|已到达/.test(text)) return "TRANSIT";
  if (/已发货|商家已发货/.test(text)) return "SHIPPED";
  if (/已下单|已经下单|订单已创建|订单已提交|提交了订单|等待出库|正在打包|拣货/.test(text)) {
    return "ORDERED";
  }
  // 「订单已完成配送」「配送完成」是送完了，不是刚下单（Fold7 2026-09-02 实测那行的结构化字段就是
  // 签收 / 订单完成）。2026-09-08 从上面那支挪到这里：位置不动，所以「已放至驿站请及时领取」这类
  // 复合文案照旧先落在待取件支上，只是这两个词不再冒充「已下单」。
  if (/订单.*已完成|订单完成|配送完成/.test(text)) return "COMPLETED";
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
    normalizedStatus: undefined,
    latestTimeText: h5Latest.timeText,
    latestDetail: h5Latest.detail,
  };
  return { feed, jdH5 };
}

/**
 * The JD order-level completion / shopping-review sentence of order `orderId` (normalized): the
 * numbered 「您的订单<单号>已完成…期待您对本次购物进行评价」 or the 「您的订单[商品]已完成…京豆…」 review ad.
 */
export function isJingDongOrderCompletionText(detail: string, orderId: string): boolean {
  const text = String(detail || "").replace(/\s+/g, "")
    .replace(/[，。！!]/g, (value) => value === "，" ? "," : value === "。" ? "." : "!");
  const numbered = text.match(/^您的订单(\d+)已完成,感谢您对京东的支持,欢迎再次光临\.期待您对本次购物进行评价\.?$/);
  return numbered ? !orderId || numbered[1] === orderId
    : /^您的订单\[[^\]]+\]已完成,\d+京豆等您拿,完成评价即有机会获得,不要错过呦!?$/.test(text);
}

/**
 * The stored row's first-completion anchor (`settledAtMs`, stamped once by storage when the row turns
 * terminal) as earlier signed evidence for `withoutJingDongOrderCompletion`. The same stamp also owns
 * the cancelled four-hour window, so it only counts while the row shows COMPLETED.
 */
export function jingDongSignedAnchorAtMs(
  shipment: Pick<Shipment, "timeline" | "settledAtMs"> | null | undefined,
): number {
  const value = Number(shipment?.settledAtMs);
  return shipment?.timeline.semantic === "COMPLETED" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The row's stored packages, which show what its `settledAtMs` anchor was (用户 2026-09-28「修，按规则保留」):
 * `withoutJingDongOrderCompletion` reads what sits at the anchor's second in them.
 */
export function jingDongAnchorEvidence(
  shipment: Pick<Shipment, "timeline" | "sourceTimeline" | "manualTimelines"> | null | undefined,
): TimelinePackage[] {
  if (!shipment) return [];
  return [shipment.timeline, shipment.sourceTimeline, ...shipment.manualTimelines || []]
    .filter((timeline): timeline is TimelinePackage => Boolean(timeline));
}

/**
 * 用户 2026-09-28「修，按规则保留」：a stored completion anchor that is itself a near-duplicate copy of the review
 * being judged is no earlier signing. It is one when the review is shown no more than five minutes after it and
 * what sits at that second, in the judged package or the row's stored packages, is a copy of the review: the same
 * fingerprint and no conflicting structured status, the collapse's own criteria. A different node there, nothing
 * there, or the review more than five minutes later keeps it earlier signing evidence.
 */
function anchorCounts(
  review: TrackNode,
  reviewAtMs: number | null,
  anchorAtMs: number,
  packages: readonly TimelinePackage[],
): boolean {
  if (!(anchorAtMs > 0)) return false;
  if (typeof reviewAtMs !== "number" || !Number.isFinite(reviewAtMs) || reviewAtMs <= 0 ||
      reviewAtMs < anchorAtMs || reviewAtMs - anchorAtMs > NEAR_DUPLICATE_WINDOW_MS) return true;
  const second = Math.floor(anchorAtMs / 1000);
  const fingerprint = trackFingerprint(review.detail);
  let copy = false;
  for (const timeline of packages) {
    const headlineAt = parseProviderTime(timeline.latestTimeText || "");
    const nodes: TrackNode[] = [...timeline.tracks];
    if (timeline.latestDetail?.trim() && headlineAt != null) {
      nodes.push({ timeText: timeline.latestTimeText, timeMs: headlineAt, detail: timeline.latestDetail,
        statusCode: "", raw: {} });
    }
    for (const node of nodes) {
      if (typeof node.timeMs !== "number" || Math.floor(node.timeMs / 1000) !== second) continue;
      if (!node.detail.trim()) continue;
      if (!fingerprint || trackFingerprint(node.detail) !== fingerprint || !nearDuplicateCompatible(node, review)) {
        return true;
      }
      copy = true;
    }
  }
  return !copy;
}

/**
 * A node's own structured signing: a structured Worker projection of COMPLETED (at its clock, else the
 * node's), or, when the projection is absent or unstructured, the node's raw status enum read without its
 * prose (at the node's time), as Pipi and Lite read it. Never the text.
 */
function trackSigning(track: TrackNode): { signed: boolean; atMs: number } {
  const projection = responseNormalizedStatus(track.raw);
  let signed = false;
  let at = Number(track.timeMs);
  if (projection?.structured) {
    signed = projection.semantic === "COMPLETED";
    if (projection.eventAtMs > 0) at = projection.eventAtMs;
  } else if (track.raw && Object.prototype.hasOwnProperty.call(track.raw, "statusCode")) {
    const { normalizedStatus: _unstructured, ...raw } = track.raw;
    signed = semanticFromTrackCode({ ...track, detail: "", raw }, track.raw.statusCode) === "COMPLETED";
  }
  return { signed, atMs: signed && Number.isFinite(at) && at > 0 ? at : 0 };
}

function trackSignedAtMs(track: TrackNode): number {
  return trackSigning(track).atMs;
}

/**
 * 用户 2026-09-27「要求」：评价只有在它自己的包报了结构化签收（包的结构化 COMPLETED，或某个节点自己的结构化签收）
 * 时才可能是第一次签收；否则照旧拦掉。
 */
function packageReportsStructuredSigning(timeline: TimelinePackage): boolean {
  return (timeline.structuredStatus === true && timeline.semantic === "COMPLETED") ||
    timeline.tracks.some((track) => trackSigning(track).signed);
}

/**
 * Earliest structured signing of one package: the stored anchor and every node's own structured
 * COMPLETED (trackSignedAtMs). The package-level statusEventAtMs is no evidence here: for Xiaomi
 * interface 5 it is the newest node's time, possibly the review's own.
 */
function earliestSignedAtMs(tracks: readonly TrackNode[], anchorAtMs: number): number {
  let earliest = Number.isFinite(anchorAtMs) && anchorAtMs > 0 ? anchorAtMs : 0;
  // Measured on the K15-collapsed timeline: a copy folded into a newer twin signs at the newer copy's time,
  // so it never counts as an earlier signing against its own twin.
  const collapsedAt = collapsedTrackTimes(tracks);
  for (const track of tracks) {
    let at = trackSignedAtMs(track);
    const shownAt = collapsedAt.get(track);
    if (at > 0 && typeof shownAt === "number" && typeof track.timeMs === "number" && shownAt > track.timeMs) {
      at = Math.max(at, shownAt);
    }
    if (at > 0 && (!earliest || at < earliest)) earliest = at;
  }
  return earliest;
}

/**
 * K15 (用户 2026-09-06)：同一个包里同文案、相距不超过 5 分钟、结构化不冲突的两条是一条，较新的那条拥有展示。重复推送的
 * 评价按折叠后的那一条判（助手按用户 2026-09-27 规则对齐），签收证据也按折叠后的时间量（earliestSignedAtMs）：每条的
 * 时间取它并入的那条较新节点的时间，分组与 mergeTracks 的 collapseNearTimeDuplicates 相同。
 */
function collapsedTrackTimes(tracks: readonly TrackNode[]): Map<TrackNode, number | null> {
  const owners: TrackNode[] = [];
  const times = new Map<TrackNode, number | null>();
  const sorted = [...tracks].sort((left, right) =>
    (right.timeMs || 0) - (left.timeMs || 0) || right.timeText.localeCompare(left.timeText));
  for (const track of sorted) {
    const fingerprint = trackFingerprint(track.detail);
    const owner = track.timeMs != null && fingerprint
      ? owners.find((existing) => existing.timeMs != null &&
        trackFingerprint(existing.detail) === fingerprint &&
        Math.abs(existing.timeMs - track.timeMs!) <= NEAR_DUPLICATE_WINDOW_MS &&
        nearDuplicateCompatible(existing, track))
      : undefined;
    if (!owner) owners.push(track);
    times.set(track, owner ? owner.timeMs : track.timeMs);
  }
  return times;
}

type OrderCompletionIdentity = Pick<ShipmentIdentity,
  "accountOrder" | "manuallyAdded" | "sourceId" | "orderId" | "projectedWaybill" |
  "sourceProvider" | "bindingSource">;

/** The review-template test for this package, or null when the JD order rule does not cover it. */
function jingDongOrderCompletionMatcher(
  timeline: TimelinePackage,
  identity: OrderCompletionIdentity,
): ((detail: string) => boolean) | null {
  if (!identity) return null;
  const projectedOrder = identity.accountOrder && normalizedProjectedWaybill(identity);
  const directJingDongWaybill = !identity.accountOrder &&
    identity.bindingSource === "interface5" &&
    String(identity.sourceProvider || "").trim().toLowerCase() === "jingdong" &&
    Boolean(normalizeWaybill(identity.sourceId)) &&
    normalizeWaybill(timeline.waybill) === normalizeWaybill(identity.sourceId);
  if (identity.manuallyAdded || (!projectedOrder && !directJingDongWaybill)) return null;
  const orderId = normalizeWaybill(identity.orderId || (identity.accountOrder ? identity.sourceId : ""));
  return (detail: string): boolean => isJingDongOrderCompletionText(detail, orderId);
}

/**
 * Whether `detail` is a review-template node the JD order rule covers in this package. Read on an
 * already cleaned package it names a review kept as the first signing: a temporary node (用户
 * 2026-09-27) that a later signing trace may replace as the list headline.
 */
export function isJingDongOrderCompletionNode(
  timeline: TimelinePackage,
  identity: OrderCompletionIdentity,
  detail: string,
): boolean {
  return jingDongOrderCompletionMatcher(timeline, identity)?.(detail) === true;
}

/**
 * Hide JD shopping-review prose without erasing the packet's structured completion.
 * 用户定 2026-09-27（四端同口径）：只有这一票更早就有结构化签收时才拦——`signedAnchorAtMs`
 * （存盘行的 settledAtMs，见 jingDongSignedAnchorAtMs）或同包内节点自己的结构化签收（trackSignedAtMs），
 * 严格早于这条评价才算；否则它就是第一条签收证据，照普通节点留下，状态与时间照来源给的。没有时间的评价只要有更早
 * 的签收就拦。同日「要求」：它自己的包没报结构化签收时，照旧拦掉（含 orderScopedStatus 失效）。身份从不取自这句文案。
 */
export function withoutJingDongOrderCompletion(
  timeline: TimelinePackage,
  identity: OrderCompletionIdentity,
  orderScopedStatus = false,
  signedAnchorAtMs = 0,
  anchorEvidence: readonly TimelinePackage[] = [],
): TimelinePackage {
  const isCompletion = jingDongOrderCompletionMatcher(timeline, identity);
  if (!isCompletion) return timeline;
  if (!timeline.tracks.some((track) => isCompletion(track.detail)) &&
      !isCompletion(timeline.latestDetail)) return timeline;
  const signingPackage = packageReportsStructuredSigning(timeline);
  const nodesSince = earliestSignedAtMs(timeline.tracks, 0);
  const evidencePackages = [timeline, ...anchorEvidence];
  const signedBefore = (review: TrackNode, atMs: number | null): boolean => {
    if (!signingPackage) return true;
    const signedSince = anchorCounts(review, atMs, signedAnchorAtMs, evidencePackages)
      ? nodesSince > 0 ? Math.min(nodesSince, signedAnchorAtMs) : signedAnchorAtMs
      : nodesSince;
    return signedSince > 0 &&
      (typeof atMs !== "number" || !Number.isFinite(atMs) || atMs <= 0 || atMs > signedSince);
  };
  const collapsedAt = collapsedTrackTimes(timeline.tracks.filter((track) => isCompletion(track.detail)));
  const isRemoved = (track: TrackNode): boolean => isCompletion(track.detail) &&
    signedBefore(track, collapsedAt.has(track) ? collapsedAt.get(track)! : track.timeMs);
  const removed = timeline.tracks.filter(isRemoved);
  const headlineAt = parseProviderTime(timeline.latestTimeText);
  const removesHeadline = isCompletion(timeline.latestDetail) &&
    signedBefore({ timeText: timeline.latestTimeText, timeMs: headlineAt, detail: timeline.latestDetail,
      statusCode: "", raw: {} }, headlineAt);
  if (!removed.length && !removesHeadline) return timeline;
  const tracks = timeline.tracks.filter((track) => !isRemoved(track));
  const latest = [...timedTracks(tracks)].sort(
    (left, right) => (right.timeMs || 0) - (left.timeMs || 0),
  )[0] || tracks[0];
  // The source owns its signed enum and clock, even when the review is its only node.
  // Unknown node projections cannot revoke that packet-level confirmation.
  if (timeline.semantic === "COMPLETED" && timeline.structuredStatus === true) {
    return { ...timeline, tracks, latestDetail: latest?.detail || "",
      latestTimeText: latest?.timeText || "", complete: tracks.length ? timeline.complete : false };
  }
  // Blank prose while reading the existing enum map: a surviving delivery sentence
  // alone cannot replace the removed order event's status timestamp.
  const evidence = latestEventEvidence(tracks.map((track) => ({ ...track, detail: "" })));
  const removesStatusTime = removed.some((track) =>
    track.timeMs != null && track.timeMs === timeline.statusEventAtMs
  ) || (removesHeadline && parseProviderTime(timeline.latestTimeText) === timeline.statusEventAtMs);
  const invalidatesStatus = removesStatusTime || orderScopedStatus;
  const semantic = !tracks.length ? "UNKNOWN"
    : invalidatesStatus ? evidence.semantic : timeline.semantic;
  return {
    ...timeline,
    tracks,
    latestDetail: latest?.detail || "",
    latestTimeText: latest?.timeText || "",
    semantic,
    normalizedStatus: !tracks.length || invalidatesStatus ? undefined : timelineNormalizedStatus(timeline),
    statusEventAtMs: !tracks.length || invalidatesStatus
      ? evidence.semantic === semantic && semantic !== "UNKNOWN" ? evidence.eventAtMs : null
      : timeline.statusEventAtMs,
    structuredStatus: invalidatesStatus ? evidence.semantic !== "UNKNOWN"
      : tracks.length ? timeline.structuredStatus : false,
    complete: tracks.length ? timeline.complete : false,
  };
}

export function timedTracks(tracks: readonly TrackNode[]): TrackNode[] {
  return tracks.filter(
    (track) =>
      typeof track.timeMs === "number" &&
      Number.isFinite(track.timeMs) &&
      Boolean(track.detail.trim()) &&
      !isNonEventDetail(track.detail),
  );
}

/**
 * 终点文案：京东那句原文是「订单已完成配送，感谢您选择京东购物」，说的是送完了，不是刚下单。
 * 2026-09-08 从 semanticFromText 的下单支挪进完成支；起点闸门照旧认它（这一票已经走完，没有更早的
 * 历史值得再抓），所以这里单独留一条，闸门的真值表跟以前一字不差。
 */
const ORDER_COMPLETION_TEXT = /订单已完成|配送完成/;

/**
 * The start gate's own reading of a prose node (AGENTS §9 起点词表): the pickup words, then the order
 * words, never 待揽/等待揽. A node counts when it contains one of them, the way Pipi
 * (`StatusSemantic.startSemanticFromText`) and Lite read it; the display table above first sorts
 * out pickup, signing and delivery prose, so a mixed 「已揽收，正在派送」 node was no start here only
 * (audit D11, adopted 2026-09-25).
 */
export function startSemanticFromText(value: string): StatusSemantic {
  const text = String(value || "").replace(/\s+/g, "");
  if (!text || /待揽|等待揽/.test(text)) return "UNKNOWN";
  if (/已揽收|已揽件|揽收完成|揽件成功|揽收成功|已收寄|收取快件/.test(text)) return "PICKED";
  if (/已下单|已经下单|订单已提交|订单已创建|提交了订单|等待出库|正在打包|拣货/.test(text)) return "ORDERED";
  return "UNKNOWN";
}

/** The node's own structured statuses, read from its codes and Worker projection without its prose. */
function trackStructuredSemantics(track: TrackNode): StatusSemantic[] {
  const jt = jtNodeSemantic(track);
  if (jt !== undefined) return [jt];
  const codeOnly = { ...track, detail: "" };
  return [track.statusCode, track.raw?.statusCode].flatMap((code) => [
    semanticFromTrackCode(codeOnly, code),
    semanticFromStored(String(code ?? ""), ""),
  ]).filter((semantic) => semantic !== "UNKNOWN");
}

/**
 * A node's start evidence (user 2026-10-02 「三端统一改成结构化优先」, the order of Pipi's
 * `ExpressDetailTimelinePolicy.hasStartSemantic`): a node with a structured status is decided by it;
 * the start words count only for a node without one. A no-enum placeholder is no structured status.
 */
function trackStartSemantics(track: TrackNode): StatusSemantic[] {
  const structured = trackStructuredSemantics(track);
  return structured.length ? structured : [startSemanticFromText(track.detail)];
}

export function containsTimelineStartTrack(
  tracks: readonly TrackNode[],
): boolean {
  return containsTimelineOriginTrack(tracks) || timedTracks(tracks).some((track) =>
    !trackStructuredSemantics(track).length &&
    ORDER_COMPLETION_TEXT.test(track.detail.replace(/\s+/g, ""))
  );
}

/** Query completion is not evidence of the parcel's historical origin. */
export function containsTimelineOriginTrack(tracks: readonly TrackNode[]): boolean {
  const isStart = (semantic: StatusSemantic) =>
    semantic === "ORDERED" || semantic === "PICKED";
  return timedTracks(tracks).some((track) => trackStartSemantics(track).some(isStart));
}

export function containsTimelinePickupTrack(
  tracks: readonly TrackNode[],
): boolean {
  return timedTracks(tracks).some((track) => trackStartSemantics(track).includes("PICKED"));
}

/** Only the latest nodes' own enums can contradict the presented status; prose is unverified. */
export function latestTimelineTrackStatuses(tracks: readonly TrackNode[]): StatusSemantic[] {
  const timed = timedTracks(tracks);
  if (!timed.length) return [];
  const latestAt = Math.max(...timed.map(track => track.timeMs!));
  return timed.filter(track => track.timeMs === latestAt).map(track => {
    const jt = jtNodeSemantic(track);
    if (jt !== undefined) return jt;
    const projection = nodeNormalizedStatus(track.raw);
    if (projection) return projection.structured ? projection.semantic : "UNKNOWN";
    for (const code of [track.raw?.statusCode, track.statusCode]) {
      const structured = semanticFromTrackCode({ ...track, detail: "" }, code);
      if (structured !== "UNKNOWN") return structured;
      const stored = semanticFromStored(String(code ?? ""), "");
      if (stored !== "UNKNOWN") return stored;
    }
    return "UNKNOWN";
  });
}

export function latestTimelineTrackSemantic(tracks: readonly TrackNode[]): StatusSemantic {
  const latest = latestTimelineTrackStatuses(tracks);
  return latest.length && latest.every(semantic => semantic === latest[0]) ? latest[0] : "UNKNOWN";
}

function semanticFromTrackCode(
  track: TrackNode,
  code: unknown,
): StatusSemantic {
  const projection = nodeNormalizedStatus(track.raw);
  if (projection) return projection.structured ? projection.semantic : "UNKNOWN";
  const jt = jtNodeSemantic(track);
  if (jt !== undefined) return jt;
  const source = String(track.raw?._pipiStatusSource || "")
    .trim()
    .toLowerCase();
  if (
    source === "account" || source === "interface5" || source === "interface6"
  ) {
    return semanticFromAccountState(code, track.detail);
  }
  return semanticFromEventCode(String(code ?? ""));
}

/** Only the separate JT DOM label is an enum; an unknown label never authorizes reading its body. */
function jtNodeSemantic(track: TrackNode): StatusSemantic | undefined {
  if (track.raw?._pipiStatusSource !== "jt_h5" ||
      !Object.prototype.hasOwnProperty.call(track.raw, "jtStatusLabel")) return undefined;
  switch (typeof track.raw.jtStatusLabel === "string" ? track.raw.jtStatusLabel.trim() : "") {
    case "取消": case "已取消": case "订单取消": case "取消订单": return "CANCELLED";
    case "问题件": case "异常件": case "异常": case "运输异常": return "DANGER";
    case "已下单": return "ORDERED";
    case "已发货": return "SHIPPED";
    case "揽件": case "已揽件": case "已揽收": return "PICKED";
    case "在途": case "运输中": return "TRANSIT";
    case "派件": case "派送中": return "DELIVERY";
    case "待取": case "待取件": case "代取件": case "待领取": return "WAITING_PICKUP";
    case "签收": case "已签收": return "COMPLETED";
    default: return "UNKNOWN";
  }
}

export function trackDisplayDetail(provider: string, track: TrackNode): string {
  return normalizeTimelineSlot(provider) === TIMELINE_SLOT.JT_H5 &&
    typeof track.displayContext === "string" && track.displayContext.trim()
    ? track.displayContext : track.detail;
}

/** A different source's headline must not borrow the selected history's display text. */
export function timelineDisplayDetail(timeline: TimelinePackage): string {
  const hint = timeline.headlineDisplay;
  if (hint) return hint.timeText === timeline.latestTimeText && hint.detail === timeline.latestDetail &&
    normalizeTimelineSlot(hint.provider) === TIMELINE_SLOT.JT_H5 &&
    typeof hint.displayContext === "string" && hint.displayContext.trim()
    ? hint.displayContext : timeline.latestDetail;
  const headline = timeline.tracks.find(track => track.timeText === timeline.latestTimeText &&
    track.detail === timeline.latestDetail);
  return headline ? trackDisplayDetail(timeline.provider, headline) : timeline.latestDetail;
}

/**
 * The provider's placeholder for an update it did not show: 「快递状态已更新」, with or without
 * 「，点击查看」 (full-width or ASCII comma) and the trailing >> (the shared vocabulary's
 * updateSummaryPattern, compared after removing all whitespace). It is kept in the data, but no
 * client shows it as a timeline node or a list headline; the real nodes are shown instead (user
 * instruction 2026-09-12, restated 2026-09-26; audit X4).
 */
const UPDATE_SUMMARY = /^快递状态已更新(?:[，,]点击查看(?:>>)?)?$/;
/**
 * 「您有包裹运输时效变化，请留意取件安排」, either comma, with or without the trailing >>: handled exactly like
 * the update placeholder (user 2026-09-28「加进占位清单」; Pipi, Lite and kdbot match the same sentence). Only
 * this sentence family. Same pattern as the shared vocabulary's transitTimeReminderPattern (user 2026-10-01,
 * item 6; exported for that check only), compared after removing all whitespace.
 */
export const TRANSIT_TIME_REMINDER = /^您有包裹运输时效变化[，,]请留意取件安排(?:>>)?$/;

export function isAccountUpdateSummary(value: string): boolean {
  const line = String(value || "").replace(/\s+/g, "");
  return UPDATE_SUMMARY.test(line) || TRANSIT_TIME_REMINDER.test(line);
}

/** Update summaries carry valid event times; only provider failures are discarded. */
export function isProviderErrorDetail(value: string): boolean {
  const clean = String(value || "").trim().replace(/\s+/g, "");
  const lower = clean.toLowerCase();
  return lower.startsWith("noresult")
    || lower.startsWith("mismatchingcode")
    || clean.startsWith("验证码错误")
    || clean.startsWith("查无结果")
    || clean === "暂无状态"
    || clean === "暂无物流信息"
    || clean === "暂无物流动态";
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
    const projection = nodeNormalizedStatus(track.raw);
    const hasRawStatus = Boolean(projection) || jtNodeSemantic(track) !== undefined || Object.prototype.hasOwnProperty.call(
      track.raw,
      "statusCode",
    );
    const eventAtMs = projection ? projection.eventAtMs || null : track.timeMs;
    if (!hasRawStatus || eventAtMs == null || !Number.isFinite(eventAtMs)) continue;
    const semantic = projection
      ? projection.structured ? projection.semantic : "UNKNOWN"
      : semanticFromTrackCode(track, track.raw.statusCode);
    if (newestAt == null || eventAtMs > newestAt) {
      newestAt = eventAtMs;
      newestSemantic = semantic;
    } else if (eventAtMs === newestAt && semantic !== newestSemantic) {
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
  if (tracks.some(track => jtNodeSemantic(track) !== undefined)) return { semantic: "UNKNOWN", eventAtMs: null };
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
    nodeNormalizedStatus(track.raw)?.semantic || "",
    jtNodeSemantic(track) !== undefined ? normalizeTrackText(track.raw.jtStatusLabel) : "",
    ...STRUCTURED_TRACK_FIELDS.map((field) =>
      structuredTrackValue(track, field)
    ),
    structuredTrackValue(track, "_pipiStatusSource"),
  ].join("\u0001");
}

function compatibleStructuredTrack(left: TrackNode, right: TrackNode): boolean {
  if (conflictingTrackStates(left, right)) return false;
  const leftSource = structuredTrackValue(left, "_pipiStatusSource");
  const rightSource = structuredTrackValue(right, "_pipiStatusSource");
  return !leftSource || !rightSource || leftSource === rightSource;
}

function carriesStatusCode(track: TrackNode): boolean {
  if (jtNodeSemantic(track) !== undefined) return true;
  const projection = nodeNormalizedStatus(track.raw);
  return projection ? projection.structured && projection.semantic !== "UNKNOWN"
    : STRUCTURED_TRACK_FIELDS.some((field) => Boolean(structuredTrackValue(track, field)));
}

function conflictingTrackStates(left: TrackNode, right: TrackNode): boolean {
  if (jtNodeSemantic(left) !== undefined && jtNodeSemantic(right) !== undefined &&
      normalizeTrackText(left.raw.jtStatusLabel) !== normalizeTrackText(right.raw.jtStatusLabel)) return true;
  if (nodeNormalizedStatus(left.raw) || nodeNormalizedStatus(right.raw)) {
    const semantic = (track: TrackNode) => {
      const projection = nodeNormalizedStatus(track.raw);
      return projection ? projection.structured ? projection.semantic : "UNKNOWN"
        : trackStructuredSemantics(track)[0] || "UNKNOWN";
    };
    const leftSemantic = semantic(left);
    const rightSemantic = semantic(right);
    return leftSemantic !== "UNKNOWN" && rightSemantic !== "UNKNOWN" && leftSemantic !== rightSemantic;
  }
  return STRUCTURED_TRACK_FIELDS.some(field => {
    const leftValue = structuredTrackValue(left, field);
    const rightValue = structuredTrackValue(right, field);
    return Boolean(leftValue && rightValue && leftValue !== rightValue);
  });
}

/**
 * Near-time duplicates (the 5-minute rule below) conflict only on genuinely different structured
 * states. An origin tag on a node without any status code is provenance, not a conflicting state
 * (2026-09-09 approved parity correction; audit D11, adopted 2026-09-25, Pipi's rule).
 */
function nearDuplicateCompatible(left: TrackNode, right: TrackNode): boolean {
  if (conflictingTrackStates(left, right)) return false;
  if (!carriesStatusCode(left) || !carriesStatusCode(right)) return true;
  const leftSource = structuredTrackValue(left, "_pipiStatusSource");
  const rightSource = structuredTrackValue(right, "_pipiStatusSource");
  return !leftSource || !rightSource || leftSource === rightSource;
}

function fillMissingTrackFields(target: TrackNode, source: TrackNode): TrackNode {
  const raw: Record<string, unknown> = { ...target.raw };
  const sameEventTime = target.timeMs != null && source.timeMs != null
    ? target.timeMs === source.timeMs : target.timeText === source.timeText;
  for (const [key, value] of Object.entries(source.raw)) {
    // Near-time deduplication may retain a later clock; JT label evidence belongs to its own event.
    if (!sameEventTime && (key === "jtStatusLabel" || (key === "_pipiStatusSource" && value === "jt_h5"))) continue;
    if (key === "jtStatusLabel" && jtNodeSemantic(target) !== undefined) continue;
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
  // An older web response for this same event may omit both pieces of the captured JT label evidence.
  if (sameEventTime && target.raw._pipiStatusSource === "web" && !carriesStatusCode(target) &&
      !Object.prototype.hasOwnProperty.call(target.raw, "jtStatusLabel") && jtNodeSemantic(source) !== undefined) {
    raw._pipiStatusSource = "jt_h5";
  }
  return {
    ...target,
    ...(typeof target.displayContext === "string" && target.displayContext.trim()
      ? {} : sameEventTime && typeof source.displayContext === "string" && source.displayContext.trim()
        ? { displayContext: source.displayContext } : {}),
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
        nearDuplicateCompatible(existing, candidate)
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
  return sorted;
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
  if (base === incoming) return false;
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

export function accountListOriginAtMs(timeline: TimelinePackage | null): number {
  if (!timeline) return 0;
  const times = [timeline.listOriginAtMs || 0,
    ...(containsTimelineOriginTrack(timeline.tracks)
      ? timedTracks(timeline.tracks).map(track => track.timeMs || 0) : []),
  ].filter(value => Number.isFinite(value) && value > 0);
  return times.length ? Math.min(...times) : 0;
}

export function withAccountListOrigin(current: TimelinePackage | null, incoming: TimelinePackage): TimelinePackage {
  const times = [accountListOriginAtMs(current), accountListOriginAtMs(incoming)].filter(value => value > 0);
  return times.length ? { ...incoming, listOriginAtMs: Math.min(...times) } : incoming;
}

export function mergeTimelinePackage(
  current: TimelinePackage | null,
  incoming: TimelinePackage,
  accumulateAccountTracks = true,
): TimelinePackage {
  if (!accumulateAccountTracks && timelineCapability(incoming.provider) === "account") {
    incoming = withAccountListOrigin(current, incoming);
  }
  const incomingTimed = timedTracks(incoming.tracks);
  if (!current) return incoming;
  if (current.provider.toLowerCase() !== incoming.provider.toLowerCase()) {
    return incoming;
  }
  if (timelineCapability(incoming.provider) === "account") {
    const currentAt = current.statusEventAtMs || 0;
    const incomingAt = incoming.statusEventAtMs || 0;
    const frozen = isTerminalStatusSemantic(current.semantic) && currentAt > 0;
    // List responses replace their own snapshot; account detail queries still accumulate history.
    const tracks = accumulateAccountTracks ? mergeTracks(current.tracks, incoming.tracks)
      : !frozen && timelineLatestEventAt(incoming) >= timelineLatestEventAt(current)
        ? incoming.tracks : current.tracks;
    const sameStatus = current.semantic === incoming.semantic;
    const higherPriority = sameStatus && statusPriority(incoming) > statusPriority(current);
    const lowerPriority = sameStatus && statusPriority(incoming) < statusPriority(current);
    const acceptsStatus = incoming.semantic !== "UNKNOWN" && !frozen && !lowerPriority &&
      (incoming.structuredStatus === true || current.structuredStatus !== true) &&
      (higherPriority || current.semantic === "UNKNOWN" ||
        (incomingAt > 0 && incomingAt >= currentAt &&
          (incomingAt !== currentAt || !rejectsSameEventRegression(current.semantic, incoming.semantic))) ||
        (!currentAt && !incomingAt && timelineLatestEventAt(incoming) >= timelineLatestEventAt(current)));
    const confirmsStatus = current.semantic === incoming.semantic &&
      current.structuredStatus !== true && incoming.structuredStatus === true && incomingAt > 0;
    const status = acceptsStatus || confirmsStatus ? incoming : current;
    const currentHeadlineAt = parseProviderTime(current.latestTimeText) || 0;
    const incomingHeadlineAt = parseProviderTime(incoming.latestTimeText) || 0;
    const headline = !frozen && incoming.latestDetail && !isNonEventDetail(incoming.latestDetail) &&
      (incomingHeadlineAt > currentHeadlineAt ||
        (incomingHeadlineAt === currentHeadlineAt && acceptsStatus) || !current.latestDetail) ? incoming : current;
    const merged = {
      ...current,
      waybill: incoming.waybill || current.waybill,
      courierCode: incoming.courierCode || current.courierCode,
      companyName: incoming.companyName || current.companyName,
      ...(incoming.rawCourierCode || current.rawCourierCode
        ? { rawCourierCode: incoming.rawCourierCode || current.rawCourierCode } : {}),
      tracks,
      ...(!accumulateAccountTracks && incoming.listOriginAtMs
        ? { listOriginAtMs: incoming.listOriginAtMs } : {}),
      semantic: status.semantic,
      structuredStatus: status.structuredStatus,
      statusEventAtMs: status.statusEventAtMs,
      ...statusProjectionFields(status, current),
      latestDetail: headline.latestDetail,
      latestTimeText: headline.latestTimeText,
      successAtMs: Math.max(current.successAtMs, incoming.successAtMs),
      ...(current.complete !== undefined || incoming.complete !== undefined
        ? { complete: current.complete === true || incoming.complete === true } : {}),
    };
    // A terminal freeze keeps the status; the headline still follows the newest node (user
    // 2026-09-25, audit D6: after signing, a later node takes the headline on all clients).
    return withMergedHeadline(merged);
  }
  const confirmsUnstructuredCompletion = current.semantic === "COMPLETED" &&
    current.structuredStatus !== true && incoming.semantic === "COMPLETED" &&
    incoming.structuredStatus === true;
  if (!incomingTimed.length) {
    // A structured status-only reply can fill the same provider's cached status gap.
    // Its absent history must not erase the tracks and headline already stored.
    return (current.semantic === "UNKNOWN" || confirmsUnstructuredCompletion) && incoming.structuredStatus === true &&
        incoming.semantic !== "UNKNOWN"
      ? { ...current, semantic: incoming.semantic,
          statusEventAtMs: incoming.statusEventAtMs, structuredStatus: true,
          ...statusProjectionFields(incoming, current) }
      : current;
  }

  const tracks = mergeTracks(current.tracks, incoming.tracks);
  const finalize = (
    value: TimelinePackage,
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
    return withMergedHeadline(merged);
  };
  const currentTimed = timedTracks(current.tracks);
  const currentCompleted = current.semantic === "COMPLETED" && currentTimed.length > 0;
  const incomingCompleted = incoming.semantic === "COMPLETED" && incomingTimed.length > 0;
  if (
    EXPRESS_POLICY.manualAuthority.completedOutranksNonTerminal &&
    currentCompleted
  ) {
    // Terminal freeze preserves the signed state (the headline follows the newest node, user
    // 2026-09-25, audit D6), but a legacy text-derived completion must still accept the same
    // provider's structured confirmation and event time.
    return finalize({
      ...current,
      ...(confirmsUnstructuredCompletion
        ? { structuredStatus: true, statusEventAtMs: incoming.statusEventAtMs,
            ...statusProjectionFields(incoming, current) }
        : {}),
      tracks,
      successAtMs: Math.max(current.successAtMs, incoming.successAtMs),
    });
  }
  if (incomingCompleted) return finalize({ ...incoming, tracks });
  const retainedCurrent = {
    ...current,
    tracks,
    successAtMs: Math.max(current.successAtMs, incoming.successAtMs),
  };
  if (incoming.semantic === "UNKNOWN") return finalize(retainedCurrent);
  if (current.semantic === "UNKNOWN") return finalize({ ...incoming, tracks });
  if (current.semantic === incoming.semantic) {
    const priorityDifference = statusPriority(incoming) - statusPriority(current);
    if (priorityDifference) return finalize(priorityDifference > 0 ? { ...incoming, tracks } : retainedCurrent);
  }
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
  TIMELINE_SLOT.V6_QUERY,
  TIMELINE_SLOT.V2_QUERY,
  TIMELINE_SLOT.CN_H5,
  TIMELINE_SLOT.K100_H5,
  TIMELINE_SLOT.JT_H5,
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
  if (value === TIMELINE_SLOT.V6_QUERY || value === TIMELINE_SLOT.V2_QUERY) {
    return "route";
  }
  if (
    value === TIMELINE_SLOT.JD_H5 || value === TIMELINE_SLOT.CN_H5 ||
    value === TIMELINE_SLOT.K100_H5 || value === TIMELINE_SLOT.JT_H5
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

/** History freshness never inherits the separately selected headline or status clock. */
export function timelineLatestTrackAt(value: TimelinePackage): number {
  return Math.max(0, ...timedTracks(value.tracks).map(track => track.timeMs!));
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
    !timedTracks(incoming.tracks).length &&
    !(incoming.structuredStatus === true && incoming.semantic !== "UNKNOWN")
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
  return compareManualTimelineAuthority(left, right);
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
  const leftProvider = normalizeTimelineSlot(left.provider);
  const rightProvider = normalizeTimelineSlot(right.provider);
  const order: readonly string[] = EXPRESS_POLICY.manualAuthority.tieBreakOrder;
  const fixedRank = (provider: string) => {
    const index = order.indexOf(provider);
    return index < 0 ? order.length : index;
  };
  return manualProviderRank(leftProvider) - manualProviderRank(rightProvider) ||
    fixedRank(leftProvider) - fixedRank(rightProvider) || leftProvider.localeCompare(rightProvider);
}

function manualProviderRank(provider: string): number {
  const normalized = normalizeTimelineSlot(provider);
  const capability = timelineCapability(normalized);
  if (normalized === TIMELINE_SLOT.V6_QUERY) return 0;
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
  return shipments.map((shipment) => ({
    shipment,
    rank: listRank(shipmentPresentationStatus(shipment).semantic),
    completionKind: Number(isOrderCompletedFallback(shipment)),
    // The row displays the headline time even when structured status is older.
    eventAt: parseProviderTime(shipment.timeline.latestTimeText) ?? shipment.timeline.statusEventAtMs ?? 0,
  })).sort((left, right) =>
    left.rank - right.rank || left.completionKind - right.completionKind ||
    right.eventAt - left.eventAt ||
    right.shipment.identity.id.localeCompare(left.shipment.identity.id)
  ).map(({ shipment }) => shipment);
}

function validLifecycleTime(value: unknown, now: number): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= now
    ? value
    : 0;
}

/** Only a provider's terminal enum/time pair can freeze automatic refresh. */
export function terminalEvidenceAtMs(shipment: Shipment, now = Date.now()): number {
  const timeline = shipment.timeline;
  if (timeline.structuredStatus !== true ||
      (timeline.semantic !== "COMPLETED" && timeline.semantic !== "CANCELLED")) return 0;
  return validLifecycleTime(timeline.statusEventAtMs, now);
}

function signedAt(shipment: Shipment, now: number): number {
  return validLifecycleTime(shipment.settledAtMs, now) || terminalEvidenceAtMs(shipment, now);
}

/** Local completion is only a fallback when the displayed logistics date is unavailable. */
export function signedRetentionAtMs(shipment: Shipment, now = Date.now()): number {
  return validLifecycleTime(parseListEventTime(shipment.timeline.latestTimeText), now) ||
    signedAt(shipment, now);
}

export function isHiddenSignedShipment(shipment: Shipment, now = Date.now()): boolean {
  if (Number(shipment.emptyTimelineHiddenAtMs) > 0) return true;
  if (shipment.timeline.semantic !== "COMPLETED") return false;
  const eventAt = signedRetentionAtMs(shipment, now);
  return eventAt > 0 && now - eventAt >= SIGNED_RETENTION_MS;
}

/**
 * 用户 2026-09-25 同意（方案 B，iOS 与 Lite；Pipi、kdbot 不做——三星数据里赠品单与真实订单分不开）：确认没有
 * 商品物流的京东订单行（赠品单之类）像留存期到了的行一样隐藏：不上首页列表与小组件，隐藏期间不通知；存盘行、
 * 缓存与留存／删除时间表都不动。三条同时成立才隐藏，任何一条不再成立就自动重新显示：
 * (i) 接口 5 的京东账号订单，已完成，从未有过真实运单号（没有投影，feed 文案也没点名运单号）；
 * (ii) 它自己的 feed 历史只有订单级的完成／评价节点，没有物流节点；
 * (iii) 方案 A 已确认它的京粉页是空壳（两次，见 accountOrderPageConfirmedEmpty）。
 */
export function isConfirmedNoItemOrder(shipment: Shipment): boolean {
  const identity = shipment.identity;
  if (
    identity.manuallyAdded ||
    !identity.accountOrder ||
    identity.bindingSource !== "interface5" ||
    String(identity.sourceProvider || "").trim().toLowerCase() !== "jingdong" ||
    normalizedProjectedWaybill(identity) ||
    (shipment.automaticOwnership?.observations || []).some((observation) =>
      normalizedProjectedWaybill(observation?.identity)) ||
    shipmentPresentationStatus(shipment).semantic !== "COMPLETED"
  ) return false;
  const tracks = (shipment.sourceTimeline || shipment.timeline).tracks;
  const orderId = normalizeWaybill(identity.orderId || identity.sourceId);
  if (
    !tracks.length ||
    accountOrderTextIdentity(tracks) ||
    !tracks.every((track) => isJingDongOrderCompletionText(track.detail, orderId))
  ) return false;
  const retry = identity.orderProjectionRetry;
  if (!retry?.emptyShellConfirmedAtMs) return false;
  try {
    return accountOrderPageConfirmedEmpty(retry, accountOrderProjectionRouteHash(identity.id));
  } catch {
    return false;
  }
}

export function pruneShipments(
  shipments: readonly Shipment[],
  now = Date.now(),
): Shipment[] {
  return shipments.filter((shipment) => {
    if (Number(shipment.emptyTimelineHiddenAtMs) > 0) return false;
    if (shipment.timeline.semantic === "COMPLETED") {
      return !isHiddenSignedShipment(shipment, now);
    }
    if (isHiddenCancelledShipment(shipment, now)) return false;
    return true;
  });
}

export function isHiddenCancelledShipment(shipment: Shipment, now = Date.now()): boolean {
  if (shipment.timeline.semantic !== "CANCELLED") return false;
  // Cancellation uses the displayed logistics date, with the existing stable terminal fallback.
  const eventAt = signedRetentionAtMs(shipment, now);
  return eventAt > 0 && now - eventAt >= CANCELLED_RETENTION_MS;
}

export function shouldRefreshShipment(
  shipment: Shipment,
  now = Date.now(),
): boolean {
  if (Number(shipment.emptyTimelineHiddenAtMs) > 0) return false;
  const forcedCompletedAtMs = Number(shipment.forcedCompletedAtMs);
  if (Number.isFinite(forcedCompletedAtMs) && forcedCompletedAtMs > 0) {
    return false;
  }
  if (shipment.timeline.semantic !== "COMPLETED") return true;
  // Empty history is repaired through explicit detail refresh, never by thawing background work.
  const eventAt = terminalEvidenceAtMs(shipment, now);
  return !eventAt;
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
        latestDetail: timelineDisplayDetail(item.timeline),
      };
    }),
  };
}
