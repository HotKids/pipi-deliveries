import type { TimelinePackage } from "../models";
import { statusProjectionFields } from "./worker-status";

/**
 * 同终态（`COMPLETED`）时钟保护与未来时钟纠偏策略（Review 29，四端统一口径）：
 * 1. 已锁定的合法非未来结构化签收时钟（`0 < t <= now`）绝不被后续缺失时钟（`<= 0`）或未来时钟（`> now`）篡改；
 * 2. 若既有签收时钟缺失或异常落入未来（`!(0 < t <= now)`），后续合法非未来的结构化签收时钟可就地纠偏；
 * 3. 冻结态京东包裹（`preserveCompletedClock = true`）在已有合法非未来签收时钟时始终固定首次签收锚点。
 */
export function isValidNonFutureStatusClock(
  eventAtMs: number | null | undefined,
  nowMs = Date.now(),
): eventAtMs is number {
  return typeof eventAtMs === "number" &&
    Number.isFinite(eventAtMs) &&
    eventAtMs > 0 &&
    eventAtMs <= nowMs;
}

export function preservesTerminalStatus(
  previous: TimelinePackage | null | undefined,
  selected: TimelinePackage,
  allowCrossProvider = false,
  preserveCompletedClock = false,
  nowMs = Date.now(),
): TimelinePackage {
  if (
    !allowCrossProvider && previous?.structuredStatus !== true &&
    previous?.provider.trim().toLowerCase() !==
      selected.provider.trim().toLowerCase()
  ) {
    return selected;
  }
  const previousTerminal = previous?.semantic === "COMPLETED" ||
    previous?.semantic === "CANCELLED";
  const selectedTerminal = selected.semantic === "COMPLETED" ||
    selected.semantic === "CANCELLED";
  if (
    previous?.semantic === "COMPLETED" &&
    selected.semantic === "COMPLETED" &&
    previous.structuredStatus === true &&
    isValidNonFutureStatusClock(previous.statusEventAtMs, nowMs) &&
    (
      preserveCompletedClock ||
      !(
        selected.structuredStatus === true &&
        isValidNonFutureStatusClock(selected.statusEventAtMs, nowMs)
      )
    )
  ) {
    return {
      ...selected,
      structuredStatus: true,
      statusEventAtMs: previous.statusEventAtMs,
      ...statusProjectionFields(previous, selected),
    };
  }
  // Matching H5 prose does not replace the structured confirmation already owned by the parcel.
  if (
    previousTerminal && selected.semantic === previous?.semantic &&
    previous.structuredStatus === true && selected.structuredStatus !== true
  ) {
    return {
      ...selected,
      structuredStatus: true,
      statusEventAtMs: previous.statusEventAtMs,
      ...statusProjectionFields(previous, selected),
    };
  }
  if (!previousTerminal || selectedTerminal) {
    return selected;
  }
  return {
    ...selected,
    semantic: previous?.semantic === "CANCELLED" ? "CANCELLED" : "COMPLETED",
    statusEventAtMs: previous?.statusEventAtMs ?? null,
    structuredStatus: previous?.structuredStatus,
    ...statusProjectionFields(previous || undefined, selected),
  };
}
