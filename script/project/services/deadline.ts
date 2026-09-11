export type RequestTimeoutDetails = {
  timeoutOrigin: "timeout_signal" | "parent_signal" | "native_timeout" | "native_abort" | "deadline_after_body" | "deadline_after_error";
  requestPhase: "request" | "response_body" | "response_complete";
  requestBudgetMs: number;
  requestElapsedMs: number;
  responseHeadersAfterMs?: number;
  responseBodyAfterMs?: number;
  deadlineLagMs: number;
};

export class OperationTimeoutError extends Error {
  constructor(message = "请求超时，请稍后重试", readonly requestDetails?: RequestTimeoutDetails) {
    super(message);
    this.name = "OperationTimeoutError";
  }
}

export function deadlineAfter(
  durationMs: number,
  now = Date.now(),
): number {
  const duration = Math.max(1, Math.floor(Number(durationMs) || 0));
  return now + duration;
}

export function remainingTimeoutMs(
  deadlineAtMs: number | undefined,
  requestLimitMs: number,
  now = Date.now(),
): number {
  const requestLimit = Math.max(1, Math.floor(Number(requestLimitMs) || 0));
  if (deadlineAtMs == null) return requestLimit;
  const remaining = Math.floor(deadlineAtMs - now);
  if (remaining <= 0) throw new OperationTimeoutError();
  return Math.max(1, Math.min(requestLimit, remaining));
}

export function deadlineExpired(
  deadlineAtMs: number | undefined,
  now = Date.now(),
): boolean {
  return deadlineAtMs != null && now >= deadlineAtMs;
}

export function assertWithinDeadline(
  deadlineAtMs: number | undefined,
  now = Date.now(),
): void {
  if (deadlineExpired(deadlineAtMs, now)) throw new OperationTimeoutError();
}

/** Waiting consumers can leave without cancelling work still owned by another consumer. */
export function waitForRefresh<T>(work: Promise<T>, deadlineAtMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => finish(() => reject(new OperationTimeoutError()));
    const timer = setTimeout(abort, Math.max(0, deadlineAtMs - Date.now()));
    const finish = (complete: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      complete();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || deadlineExpired(deadlineAtMs)) abort();
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

export type LinkedTimeoutSignal = Readonly<{
  signal: AbortSignal;
  dispose: () => void;
}>;

/**
 * Propagates timeout and owner cancellation. Forwarding still needs a script
 * callback; callers must also set the native request timeout.
 */
export function linkedTimeoutSignal(
  timeoutMsInput: number,
  parent?: AbortSignal,
): LinkedTimeoutSignal {
  const timeoutMs = Math.max(1, Math.floor(Number(timeoutMsInput) || 0));
  const controller = new AbortController();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const abort = () => controller.abort();
  timeoutSignal.addEventListener("abort", abort, { once: true });
  parent?.addEventListener("abort", abort, { once: true });
  if (timeoutSignal.aborted || parent?.aborted) abort();
  return {
    signal: controller.signal,
    dispose: () => {
      timeoutSignal.removeEventListener("abort", abort);
      parent?.removeEventListener("abort", abort);
    },
  };
}
