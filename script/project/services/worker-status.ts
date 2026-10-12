import type { NormalizedStatus, TimelinePackage } from "../models";

const SEMANTICS = new Set([
  "CANCELLED", "DANGER", "ORDERED", "SHIPPED", "PICKED", "TRANSIT",
  "DELIVERY", "WAITING_PICKUP", "COMPLETED", "UNKNOWN",
]);

/** Validate the wire shape only; enum interpretation belongs to the Worker. */
export function parseNormalizedStatus(value: unknown): NormalizedStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const status = value as NormalizedStatus;
  if (status.version !== 1 || !["ORDER", "SHIPMENT"].includes(status.scope) ||
      !SEMANTICS.has(status.semantic) || typeof status.code !== "string" ||
      typeof status.text !== "string" || (status.semantic !== "UNKNOWN" && !status.text.trim()) ||
      !Number.isSafeInteger(status.priority) || status.priority < 0 ||
      !Number.isSafeInteger(status.eventAtMs) || status.eventAtMs < 0 ||
      typeof status.structured !== "boolean") return undefined;
  return { version: 1, scope: status.scope, semantic: status.semantic, code: status.code,
    text: status.text, priority: status.priority, eventAtMs: status.eventAtMs,
    structured: status.structured };
}

export function responseNormalizedStatus(value: unknown): NormalizedStatus | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? parseNormalizedStatus((value as Record<string, unknown>).normalizedStatus)
    : undefined;
}

/**
 * A timeline node's own projection (用户定 2026-10-01「两边都改」, the reader Pipi's
 * ExpressWorkerStatus.nodeEvidence and Lite's WorkerStatusProjection.nodeEvidence share): an
 * unstructured projection with an empty code says the node carried no enum, so it is absent and the
 * node's raw fields decide. An unrecognised code (non-empty) stays an explicit UNKNOWN.
 */
export function nodeNormalizedStatus(value: unknown): NormalizedStatus | undefined {
  const status = responseNormalizedStatus(value);
  return status && !status.structured && !status.code ? undefined : status;
}

/** History selection cannot transfer display metadata to a different status event. */
export function timelineNormalizedStatus(timeline: TimelinePackage): NormalizedStatus | undefined {
  const status = parseNormalizedStatus(timeline.normalizedStatus);
  return status && status.semantic === timeline.semantic &&
      status.eventAtMs === (timeline.statusEventAtMs || 0) &&
      status.structured === (timeline.structuredStatus === true)
    ? status : undefined;
}

export function statusPriority(timeline: TimelinePackage): number {
  return timelineNormalizedStatus(timeline)?.priority || 0;
}

/** Transfer status metadata without changing the shape of legacy packets. */
export function statusProjectionFields(donor: TimelinePackage | undefined,
  target?: TimelinePackage): Pick<TimelinePackage, "normalizedStatus"> {
  const projection = donor ? timelineNormalizedStatus(donor) : undefined;
  return projection || target?.normalizedStatus ? { normalizedStatus: projection } : {};
}
