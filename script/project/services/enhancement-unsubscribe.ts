import type { AppState } from "../models";
import { existingEnhancementIdentity, ENHANCEMENT_ROUTE } from "./enhanced-account";
import { postGateway } from "./gateway";
import { deadlineExpired, remainingTimeoutMs } from "./deadline";
import { acquireRenewingDurableRefreshLease } from "./refresh-runtime-state";
import { acknowledgeEnhancementUnsubscribe, loadState, privateHash } from "./storage";
import { diagnosticErrorDetails, writeDiagnostic } from "./logger";

export class EnhancementUnbindUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnhancementUnbindUnavailable";
  }
}

export function enhancementIdentityFingerprint(): string {
  const identity = existingEnhancementIdentity();
  return identity ? privateHash(JSON.stringify(identity)) : "";
}

/** Replay only the original subscription identity; local removal never proves remote absence. */
export async function replayEnhancementUnsubscribes(options: {
  deadlineAtMs?: number; isCurrent?: () => boolean;
} = {}): Promise<AppState | undefined> {
  const isCurrent = options.isCurrent || (() => true);
  const deadlineAtMs = Math.min(options.deadlineAtMs ?? Infinity, Date.now() + 15_000);
  let current: AppState | undefined;
  try {
    current = loadState();
    for (const pending of current.pendingEnhancementUnsubscribes || []) {
      if (deadlineExpired(deadlineAtMs) || !isCurrent()) break;
      const lease = acquireRenewingDurableRefreshLease(`binding:${privateHash(pending.phone)}`,
        Math.max(1, deadlineAtMs - Date.now() + 1_000));
      if (!lease) continue;
      try {
        current = loadState();
        if (!current.pendingEnhancementUnsubscribes?.some(item => item.id === pending.id)) continue;
        const identity = existingEnhancementIdentity();
        if (!identity || !pending.identityFingerprint ||
            privateHash(JSON.stringify(identity)) !== pending.identityFingerprint) {
          writeDiagnostic("account.enhanced.unsubscribe_skipped", { stage: "metadata", result: "identity_unavailable" });
          continue;
        }
        const active = current.bindings.some(binding => binding.phone === pending.phone && binding.enhancedMode);
        const canSend = () => lease.isCurrent() && isCurrent() && !deadlineExpired(deadlineAtMs);
        if (!canSend()) continue;
        if (!active) {
          const result = await postGateway(ENHANCEMENT_ROUTE, { operation: "unbind", phone: pending.phone, identity }, {
            deadlineAtMs, timeoutMs: remainingTimeoutMs(deadlineAtMs, 25_000),
            beforeQuery: () => { if (!canSend()) throw new Error("增强模式退订已取消"); },
          });
          if (result.ok !== true) throw new Error("增强模式退订未完成");
        }
        if (lease.isCurrent() && isCurrent() && !deadlineExpired(deadlineAtMs)) {
          current = acknowledgeEnhancementUnsubscribe(pending.id);
        }
      } catch (error) {
        writeDiagnostic("account.enhanced.unsubscribe_failed", {
          stage: "metadata", result: "pending", ...diagnosticErrorDetails(error),
        }, "warning");
      } finally { lease.release(); }
    }
    return loadState();
  } catch {
    // Required local removal already committed; an optional replay cannot fail base account work.
    return current;
  }
}
