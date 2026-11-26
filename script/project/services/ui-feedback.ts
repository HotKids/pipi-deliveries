import { EXPRESS_TOAST_COPY } from "./express-toast-copy";
import { OperationTimeoutError } from "./deadline";
import { ShipmentLifecycleChangedError } from "./shipment-lifecycle";

export const SAVE_FAILED_TOAST = "保存失败，请稍后重试";

// Every page that reports a failed operation needs the same two-step choice: show what the
// source actually said, and fall back to that page's own copy when the throw carries no usable
// message. HomePage, PhoneManagerPage and PhoneBindingPage each held a byte-identical private
// copy of this, which let one gesture report two different outcomes (HomePage's pull-to-refresh
// answered 刷新失败 through refreshSummaryToast but 查询失败 through its own hard-coded fallback).
// The fallback stays a parameter so each call site still names its own operation.
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function transientToast(
  message: string,
  setMessage: (message: string | ((current: string) => string)) => void,
) {
  return {
    isPresented: Boolean(message),
    onChanged: (isPresented: boolean) => {
      if (!isPresented) setMessage((current) => current === message ? "" : current);
    },
    message,
    duration: 2,
    position: "bottom" as const,
  };
}

export function noteSavedToast(note: string): string {
  return note.trim() ? EXPRESS_TOAST_COPY.userNoteSaved : EXPRESS_TOAST_COPY.userNoteDeleted;
}

export function noteSaveFailedToast(error: unknown): string {
  return error instanceof ShipmentLifecycleChangedError
    ? EXPRESS_TOAST_COPY.userNoteChanged : SAVE_FAILED_TOAST;
}

/** What a list pull's international Watch page read did (G-HIGH-10): changed rows, nothing new, failed, or not run. */
export type WatchPullOutcome = "refreshed" | "unchanged" | "failed" | "skipped";

/**
 * A list pull counts its Watch page read as one more refresh when the read changed rows or failed (G-HIGH-10, 2026-11-20
 * review), so the toast answers for the international rows too. An unchanged or skipped read adds nothing.
 */
export function withWatchPullOutcome<T extends Readonly<{ attempted: number; succeeded: number; failed: number }>>(
  summary: T, outcome: WatchPullOutcome | undefined,
): T {
  if (outcome === "refreshed") return { ...summary, attempted: summary.attempted + 1, succeeded: summary.succeeded + 1 };
  if (outcome === "failed") return { ...summary, attempted: summary.attempted + 1, failed: summary.failed + 1 };
  return summary;
}

/** 列表下拉的四种结果（三端同一张表，AGENTS §11）。 */
export function refreshSummaryToast(summary: Readonly<{
  attempted: number;
  succeeded: number;
  failed: number;
  accountListUpdated?: boolean;
  skipReason?: "active_cross_runtime_refresh";
  /** E1: the pull was answered after the account part; per-waybill work goes on in the background. */
  continuing?: boolean;
}>): string {
  if (summary.skipReason) return EXPRESS_TOAST_COPY.refreshFailed;
  if (summary.failed > 0 && summary.succeeded > 0) {
    return EXPRESS_TOAST_COPY.listUpdated;
  }
  if (summary.failed > 0) return EXPRESS_TOAST_COPY.refreshFailed;
  if (summary.continuing) return EXPRESS_TOAST_COPY.refreshContinuing;
  if (summary.attempted === 0) return EXPRESS_TOAST_COPY.refreshUpToDate;
  return EXPRESS_TOAST_COPY.refreshDone;
}

/** 手动查件提交后详情页的结果 toast。 */
export function manualDetailRefreshToast(
  refreshed: boolean,
  hasUsableDetail: boolean,
): string {
  if (refreshed && hasUsableDetail) return EXPRESS_TOAST_COPY.manualQuerySucceeded;
  return hasUsableDetail ? "" : EXPRESS_TOAST_COPY.manualQueryNoTrack;
}

/** 详情下拉的三种结果；抛错那一种由页面按「有没有轨迹可看」决定。 */
export function detailPullToast(
  refreshed: boolean,
  hasUsableDetail: boolean,
): string {
  if (refreshed && hasUsableDetail) return EXPRESS_TOAST_COPY.detailRefreshed;
  return hasUsableDetail
    ? EXPRESS_TOAST_COPY.detailUpToDate
    : EXPRESS_TOAST_COPY.detailNoTrack;
}

/**
 * 手动查件失败的 toast：超时一种、其余一种，上游文案不外露（表格 2026-09-05）。校验类的
 * 「请输入有效的快递单号 / 请输入 4 位手机尾号 / 手机尾号不正确」不是 toast，由页面内联显示，
 * 调用方先用 isManualQueryValidationMessage 分流。
 */
export function manualQueryFailureToast(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof OperationTimeoutError || message.includes("超时")) {
    return EXPRESS_TOAST_COPY.manualQueryTimeout;
  }
  return EXPRESS_TOAST_COPY.manualQueryFailed;
}

export function isManualQueryValidationMessage(message: string): boolean {
  return message.includes("快递单号") || message.includes("手机尾号");
}
