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

export function widgetStatusLabel(semantic: StatusSemantic): string {
  if (semantic === "DANGER") return "异常件";
  return statusLabel(semantic);
}

export function statusTint(semantic: StatusSemantic): string {
  switch (semantic) {
    case "WAITING_PICKUP":
      return "systemOrange";
    case "DELIVERY":
    case "COMPLETED":
      return "systemGreen";
    case "TRANSIT":
    case "PICKED":
    case "SHIPPED":
    case "ORDERED":
      return "systemBlue";
    case "DANGER":
    case "CANCELLED":
      return "systemRed";
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

export function semanticFromText(value: string): StatusSemantic {
  const text = String(value || "").replace(/\s+/g, "");
  if (!text) return "UNKNOWN";
  if (/已签收|已妥投/.test(text)) return "COMPLETED";
  if (/已取消|订单关闭/.test(text)) return "CANCELLED";
  if (/待取件|等待取件|取件码/.test(text)) return "WAITING_PICKUP";
  if (/派送中|正在派送|配送中|正在配送/.test(text)) return "DELIVERY";
  if (/已揽收|已揽件|揽收完成/.test(text)) return "PICKED";
  if (/运输中|转运|分拨|已发往|已到达/.test(text)) return "TRANSIT";
  if (/已发货|商家已发货/.test(text)) return "SHIPPED";
  if (/已下单|订单已提交|订单已完成|配送完成|等待出库|正在打包/.test(text)) {
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

export function timedTracks(tracks: readonly TrackNode[]): TrackNode[] {
  return tracks.filter(
    (track) =>
      typeof track.timeMs === "number" &&
      Number.isFinite(track.timeMs) &&
      Boolean(track.detail.trim()) &&
      !isProviderErrorDetail(track.detail),
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

export function usableTimedTracks(
  tracks: readonly TrackNode[],
): TrackNode[] {
  return timedTracks(tracks);
}

function latestEventEvidence(
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
    (track) => !track.detail.trim() || !isProviderErrorDetail(track.detail),
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
  const sorted = merged.map((entry) => entry.track).sort((left, right) => {
    const time = (right.timeMs || 0) - (left.timeMs || 0);
    if (time !== 0) return time;
    return right.timeText.localeCompare(left.timeText);
  });
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
  const finalize = (value: TimelinePackage): TimelinePackage => {
    const rawCourierCode = String(
      value.rawCourierCode || current.rawCourierCode || incoming.rawCourierCode || "",
    ).trim();
    const retainedRaw = rawCourierCode
      ? { ...value, rawCourierCode }
      : value;
    return isManualTimelineProvider(value.provider)
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
  };
  const currentTimed = timedTracks(current.tracks);
  const currentCompleted = current.semantic === "COMPLETED" && currentTimed.length > 0;
  const incomingCompleted = incoming.semantic === "COMPLETED" && incomingTimed.length > 0;
  if (
    EXPRESS_POLICY.manualAuthority.completedOutranksNonTerminal &&
    currentCompleted
  ) {
    return incomingCompleted
      ? finalize({
          ...current,
          tracks,
          successAtMs: Math.max(current.successAtMs, incoming.successAtMs),
        })
      : finalize({
          ...current,
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
  "local",
  "route",
  "web",
  "fallback",
  "cainiao_h5",
  "kuaidi100_h5",
  "moto",
  "meizu",
  "oppo",
  "kdniao",
  "kuaidi100",
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
  const value = String(provider || "").trim().toLowerCase();
  if (value === "interface5" || value === "interface6" || value === "account") {
    return "account";
  }
  if (value === "local" || value === "moto") return "local";
  if (value === "route" || value === "meizu" || value === "oppo") return "route";
  if (
    value === "web" || value === "jingdong_h5" || value === "cainiao_h5" ||
    value === "kuaidi100_h5"
  ) return "web";
  if (value === "fallback" || value === "kdniao" || value === "kuaidi100") {
    return "fallback";
  }
  return "unknown";
}

function isManualTimelineProvider(provider: string): boolean {
  return MANUAL_TIMELINE_PROVIDERS.has(provider.trim().toLowerCase());
}

function manualTimelineDeclaredComplete(value: TimelinePackage): boolean {
  const provider = value.provider.trim().toLowerCase();
  return typeof value.complete === "boolean"
    ? value.complete
    : timelineCapability(provider) === "fallback";
}

export function manualTimelineIsComplete(value: TimelinePackage): boolean {
  if (!manualTimelineDeclaredComplete(value)) return false;
  const provider = value.provider.trim().toLowerCase();
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

function manualProviderRank(provider: string): number {
  const normalized = provider.trim().toLowerCase();
  const capability = timelineCapability(normalized);
  if (normalized === "route" || normalized === "meizu") return 0;
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
  return value || validLifecycleTime(shipment.updatedAtMs, now);
}

function cancelledAt(shipment: Shipment, now: number): number {
  return Math.max(
    validLifecycleTime(shipment.timeline.statusEventAtMs, now),
    latestTimelineTime(shipment, now),
  ) || validLifecycleTime(shipment.updatedAtMs, now);
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
        statusLabel: presentation.semantic === "DANGER"
          ? "异常件"
          : presentation.text,
        latestDetail: item.timeline.latestDetail,
      };
    }),
  };
}
