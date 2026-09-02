import type { StatusSemantic, TrackNode } from "../models";
import {
  isProviderErrorDetail,
  packageSemantic,
  parseProviderTime,
  semanticFromStored,
  usableTimedTracks,
} from "./status";

export type JsonObject = Record<string, unknown>;

export type ParsedManualTimeline = {
  tracks: TrackNode[];
  semantic: StatusSemantic;
  statusEventAtMs: number | null;
  latestTimeText: string;
  latestDetail: string;
  hasRealTracking: boolean;
  hasTimedTracking: boolean;
  hasStructuredStatus: boolean;
};

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function firstText(value: JsonObject, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = text(value[key]);
    if (candidate) return candidate;
  }
  return "";
}

const RETAINED_TRACK_RAW_FIELDS = [
  "statusCode",
  "status",
  "state",
  "logisticsStatus",
  "logisticsStatusDesc",
  "action",
  "areaCode",
  "location",
  "_pipiKuaidi100Com",
] as const;

function compactTrackRaw(
  item: JsonObject,
  provider: string,
): Readonly<Record<string, unknown>> {
  const raw: Record<string, unknown> = { _pipiStatusSource: provider };
  for (const field of RETAINED_TRACK_RAW_FIELDS) {
    const value = item[field];
    if (value !== undefined && value !== null && value !== "") raw[field] = value;
  }
  return raw;
}

function trackFrom(value: unknown, provider: string): TrackNode | null {
  const item = object(value);
  const timeText = firstText(item, "time", "ftime", "date");
  const detail = firstText(item, "context", "desc", "detail");
  const statusCode = firstText(item, "statusCode");
  if (!Object.keys(item).length) return null;
  return {
    timeText,
    timeMs: parseProviderTime(timeText),
    detail,
    statusCode,
    raw: compactTrackRaw(item, provider),
  };
}

function sortedTracks(values: readonly TrackNode[]): TrackNode[] {
  return [...values].sort(
    (left, right) => (right.timeMs || 0) - (left.timeMs || 0),
  );
}

function presentation(
  tracks: TrackNode[],
  semantic: StatusSemantic,
  statusEventAtMs: number | null,
  hasStructuredStatus: boolean,
): ParsedManualTimeline {
  const timed = sortedTracks(usableTimedTracks(tracks));
  const meaningful = sortedTracks(tracks.filter(
    (track) => Boolean(track.detail.trim()) && !isProviderErrorDetail(track.detail),
  ));
  const latest = timed[0] || meaningful[0] || null;
  return {
    tracks: sortedTracks(tracks),
    semantic,
    statusEventAtMs,
    latestTimeText: latest?.timeText || "",
    latestDetail: latest?.detail || "",
    hasRealTracking: Boolean(timed.length || meaningful.length),
    hasTimedTracking: Boolean(timed.length),
    hasStructuredStatus,
  };
}

function statusEventAt(
  semantic: StatusSemantic,
  tracks: readonly TrackNode[],
): number | null {
  if (semantic === "UNKNOWN") return null;
  return sortedTracks(tracks).find((track) => track.timeMs != null)?.timeMs || null;
}

function kdniaoSemantic(value: string): StatusSemantic {
  switch (value.trim().toUpperCase()) {
    case "1": return "PICKED";
    case "2":
    case "201":
    case "204": return "TRANSIT";
    case "202": return "DELIVERY";
    case "211":
    case "412": return "WAITING_PICKUP";
    case "3":
    case "301":
    case "302":
    case "304":
    case "311":
    case "406": return "COMPLETED";
    case "4":
    case "401":
    case "402":
    case "403":
    case "404":
    case "405":
    case "407": return "DANGER";
    default: return "UNKNOWN";
  }
}

function semanticRank(value: StatusSemantic): number {
  switch (value) {
    case "ORDERED": return 0;
    case "SHIPPED": return 1;
    case "PICKED": return 2;
    case "TRANSIT": return 3;
    case "DELIVERY": return 4;
    case "WAITING_PICKUP": return 5;
    case "COMPLETED": return 6;
    case "DANGER": return 7;
    case "CANCELLED": return 8;
    default: return -1;
  }
}

function laterSemantic(
  top: StatusSemantic,
  trace: StatusSemantic,
): StatusSemantic {
  if (top === "UNKNOWN") return trace;
  if (trace === "UNKNOWN") return top;
  return semanticRank(trace) >= semanticRank(top) ? trace : top;
}

export function explicitKuaidi100Failure(root: JsonObject): boolean {
  if (
    Object.prototype.hasOwnProperty.call(root, "result") &&
    root.result !== true &&
    String(root.result).trim().toLowerCase() !== "true"
  ) {
    return true;
  }
  const code = text(root.returnCode);
  if (code && code !== "200") return true;
  const status = text(root.status);
  return Boolean(status && status !== "0" && status !== "200");
}

export function kuaidi100NoTrackYet(root: JsonObject): boolean {
  if (text(root.returnCode) !== "500") return false;
  return !Array.isArray(root.data) || root.data.length === 0;
}

export function kuaidi100PhoneRejected(root: JsonObject): boolean {
  const message = firstText(root, "message", "msg", "reason").toLowerCase();
  return text(root.returnCode) === "408"
    || text(root.status) === "408"
    || /手机号|手机尾号|电话|尾号|phone/.test(message);
}

export function rejectKuaidi100Response(root: JsonObject): boolean {
  return explicitKuaidi100Failure(root) && (
    kuaidi100PhoneRejected(root) || !kuaidi100NoTrackYet(root)
  );
}

export function parseKuaidi100Timeline(root: JsonObject): ParsedManualTimeline {
  const source = Array.isArray(root.data) ? root.data : [];
  const tracks = source
    .map((value) => trackFrom(value, "kuaidi100"))
    .filter((track): track is TrackNode => track != null);
  const status = packageSemantic(text(root.state), tracks);
  return presentation(tracks, status.semantic, status.eventAtMs, false);
}

/** Parses Lenovo/Moto's verified pubquery response contract. */
export function parseMotoTimeline(root: JsonObject): ParsedManualTimeline {
  const data = object(root.data);
  const source = Array.isArray(data.fullTraceDetail) ? data.fullTraceDetail : [];
  let tracks = source
    .map((value) => trackFrom(value, "moto"))
    .filter((track): track is TrackNode => track != null);
  const rawStatus = firstText(data, "logisticsStatus");
  const statusDescription = firstText(data, "logisticsStatusDesc");
  const semantic = semanticFromStored(rawStatus, statusDescription);
  const newest = sortedTracks(tracks)[0];
  if (newest && (rawStatus || statusDescription)) {
    tracks = tracks.map((track) => track === newest
      ? {
          ...track,
          statusCode: rawStatus || track.statusCode,
          raw: {
            ...track.raw,
            ...(rawStatus ? { logisticsStatus: rawStatus } : {}),
            ...(statusDescription
              ? { logisticsStatusDesc: statusDescription }
              : {}),
          },
        }
      : track);
  }
  return presentation(
    tracks,
    semantic,
    statusEventAt(semantic, tracks),
    Boolean(rawStatus),
  );
}

const MEIZU_STRUCTURED_STATUS_FIELDS = [
  "status",
  "state",
  "logsiticsStatus",
] as const;
const MEIZU_CONTAINER_FIELDS = ["value", "data", "manual"] as const;
const MEIZU_MAX_ENVELOPE_DEPTH = 12;

type CollectedMeizuTimeline = {
  nodes: JsonObject[];
  newestStatus: StatusSemantic;
  newestStatusAtMs: number;
  ambiguousNewestStatus: boolean;
};

function decodeMeizuEnvelope(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const candidate = value.trim();
  const structured = (
    candidate.startsWith("{") && candidate.endsWith("}")
  ) || (
    candidate.startsWith("[") && candidate.endsWith("]")
  );
  if (!structured) return value;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return value;
  }
}

function exactMeizuSemantic(value: unknown): StatusSemantic {
  if (typeof value !== "string" || value !== value.trim().toUpperCase()) {
    return "UNKNOWN";
  }
  return semanticFromStored(value, "");
}

function structuredMeizuSemantic(value: JsonObject): StatusSemantic {
  let semantic: StatusSemantic = "UNKNOWN";
  for (const field of MEIZU_STRUCTURED_STATUS_FIELDS) {
    const candidate = exactMeizuSemantic(value[field]);
    if (candidate === "UNKNOWN") continue;
    if (semantic !== "UNKNOWN" && semantic !== candidate) return "UNKNOWN";
    semantic = candidate;
  }
  return semantic;
}

function hasMeizuContainer(value: JsonObject): boolean {
  if (Array.isArray(value.tracks) || Array.isArray(value.traces)) return true;
  return MEIZU_CONTAINER_FIELDS.some((field) => {
    const candidate = decodeMeizuEnvelope(value[field]);
    return Boolean(candidate && typeof candidate === "object");
  });
}

function meizuPresentation(value: JsonObject): string {
  return firstText(
    value,
    "context",
    "message",
    "stateName",
    "logisticsStatusDesc",
  );
}

function considerMeizuStatus(
  collected: CollectedMeizuTimeline,
  semantic: StatusSemantic,
  eventAtMs: number | null,
): void {
  if (semantic === "UNKNOWN" || eventAtMs == null) return;
  if (eventAtMs > collected.newestStatusAtMs) {
    collected.newestStatus = semantic;
    collected.newestStatusAtMs = eventAtMs;
    collected.ambiguousNewestStatus = false;
  } else if (
    eventAtMs === collected.newestStatusAtMs &&
    semantic !== collected.newestStatus
  ) {
    collected.ambiguousNewestStatus = true;
  }
}

function collectMeizuTimeline(
  raw: unknown,
  collected: CollectedMeizuTimeline,
  depth: number,
  arrayEntry: boolean,
): void {
  if (raw == null || depth > MEIZU_MAX_ENVELOPE_DEPTH) return;
  const decoded = decodeMeizuEnvelope(raw);
  if (Array.isArray(decoded)) {
    for (const value of decoded) {
      collectMeizuTimeline(value, collected, depth + 1, true);
    }
    return;
  }
  if (!decoded || typeof decoded !== "object") return;

  const item = decoded as JsonObject;
  const structured = structuredMeizuSemantic(item);
  const eventAtMs = parseProviderTime(firstText(item, "time"));
  const detail = meizuPresentation(item);
  const providerError = isProviderErrorDetail(detail);
  if (!providerError) {
    considerMeizuStatus(collected, structured, eventAtMs);
  }
  if (
    !providerError && (
      arrayEntry ||
      structured !== "UNKNOWN" ||
      eventAtMs != null ||
      (!hasMeizuContainer(item) && Boolean(detail))
    )
  ) {
    collected.nodes.push(
      detail && !firstText(item, "context")
        ? { ...item, context: detail }
        : item,
    );
  }

  collectMeizuTimeline(item.tracks, collected, depth + 1, true);
  collectMeizuTimeline(item.traces, collected, depth + 1, true);
  for (const field of MEIZU_CONTAINER_FIELDS) {
    collectMeizuTimeline(item[field], collected, depth + 1, false);
  }
}

/** Parses Meizu Picker's latest-event response as an independent partial package. */
export function parseMeizuTimeline(root: JsonObject): ParsedManualTimeline {
  const collected: CollectedMeizuTimeline = {
    nodes: [],
    newestStatus: "UNKNOWN",
    newestStatusAtMs: 0,
    ambiguousNewestStatus: false,
  };
  collectMeizuTimeline(root, collected, 0, false);
  const seen = new Set<string>();
  const tracks = collected.nodes
    .map((value) => trackFrom(value, "meizu"))
    .filter((track): track is TrackNode => {
      if (
        !track || !track.timeText || !track.detail ||
        isProviderErrorDetail(track.detail)
      ) return false;
      const identity = `${track.timeText}\u0000${track.detail}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  const fallbackSemantic = isProviderErrorDetail(meizuPresentation(root))
    ? "UNKNOWN"
    : semanticFromStored(
      firstText(root, "status", "state", "logisticsStatus"),
      firstText(root, "stateName", "logisticsStatusDesc"),
    );
  const semantic = collected.ambiguousNewestStatus
    ? "UNKNOWN"
    : collected.newestStatus !== "UNKNOWN"
      ? collected.newestStatus
      : fallbackSemantic;
  const eventAtMs = semantic === collected.newestStatus
    ? collected.newestStatusAtMs || null
    : statusEventAt(semantic, tracks);
  return presentation(
    tracks,
    semantic,
    eventAtMs,
    false,
  );
}

/** Parses KDNiao 8001's normalized Worker response without mixing providers. */
export function parseKdniaoTimeline(root: JsonObject): ParsedManualTimeline {
  const source = Array.isArray(root.traces) ? root.traces : [];
  let latestTraceSemantic: StatusSemantic = "UNKNOWN";
  let latestTraceStatusAt = 0;
  let ambiguousLatest = false;
  const tracks = source
    .map((value) => {
      const item = object(value);
      const timeText = firstText(item, "acceptTime");
      const detail = firstText(
        item,
        "acceptStation",
        "remark",
        "location",
      );
      const action = firstText(item, "action");
      if (!timeText || !detail) return null;
      const timeMs = parseProviderTime(timeText);
      const semantic = kdniaoSemantic(action);
      if (timeMs != null && timeMs > latestTraceStatusAt) {
        latestTraceStatusAt = timeMs;
        latestTraceSemantic = semantic;
        ambiguousLatest = false;
      } else if (
        timeMs != null &&
        timeMs === latestTraceStatusAt &&
        semantic !== latestTraceSemantic
      ) {
        ambiguousLatest = true;
      }
      return {
        timeText,
        timeMs,
        detail,
        statusCode: action,
        raw: compactTrackRaw(item, "kdniao"),
      } satisfies TrackNode;
    })
    .filter((track): track is TrackNode => track != null);
  if (ambiguousLatest) latestTraceSemantic = "UNKNOWN";
  const stateEx = firstText(root, "stateEx");
  const state = firstText(root, "state");
  const topSemantic = kdniaoSemantic(stateEx) !== "UNKNOWN"
    ? kdniaoSemantic(stateEx)
    : kdniaoSemantic(state);
  const semantic = laterSemantic(topSemantic, latestTraceSemantic);
  const eventAtMs = semantic === latestTraceSemantic && semantic !== "UNKNOWN"
    ? latestTraceStatusAt || null
    : null;
  return presentation(
    tracks,
    semantic,
    eventAtMs,
    Boolean(stateEx || latestTraceSemantic !== "UNKNOWN"),
  );
}
