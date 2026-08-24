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
