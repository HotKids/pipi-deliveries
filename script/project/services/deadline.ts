export class OperationTimeoutError extends Error {
  constructor(message = "请求超时，请稍后重试") {
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

export type LinkedTimeoutSignal = Readonly<{
  signal: AbortSignal;
  dispose: () => void;
}>;

/**
 * Uses the host's native timeout signal so a stalled native request is aborted
 * even when the script event loop cannot run a JavaScript timer promptly.
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
