import type { StatusSemantic, TrackNode } from "../models";
import {
  isProviderErrorDetail,
  packageSemantic,
  parseProviderTime,
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
    raw: { ...item, _pipiStatusSource: provider },
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
  };
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
  return Boolean(code && code !== "200");
}

export function kuaidi100NoTrackYet(root: JsonObject): boolean {
  if (text(root.returnCode) !== "500") return false;
  return !Array.isArray(root.data) || root.data.length === 0;
}

export function kuaidi100PhoneRejected(root: JsonObject): boolean {
  const message = firstText(root, "message", "msg", "reason").toLowerCase();
  return text(root.returnCode) === "408"
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
  return presentation(tracks, status.semantic, status.eventAtMs);
}
