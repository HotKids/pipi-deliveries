import type { AppState } from "../models";
import { peekStateRevision } from "./storage";
import {
  projectStoredAccountOrders,
  subscribeFullRefreshOutcome,
  type FullRefreshOutcome,
  type StoredOrderProjectionResult,
} from "./sync";

/**
 * 用户 2026-09-24 采纳：App 在屏幕上时自己抓京东订单的运单号，与 Lite 首页（onStart、每轮同步结束）同口径。
 * 只有 App 根视图创建它；它在三种时候跑一遍存盘行投影（projectStoredAccountOrders，不请求账号列表）：
 * 1. 这个运行时的全量刷新落地（自己的启动 / 恢复 / 下拉刷新），或因为别的运行时（小组件）占着租约被跳过——
 *    跳过时那一遍先等对方放租约；
 * 2. 场景回到 active；
 * 3. 在前台时发现别的运行时落了盘（持久化 revision 变新）。
 * 一次只投一单；还有别的单该投就接着下一单，同一串里每单只试一次。
 * 在屏幕上时，已完成、还没运单号的订单也取一次号（用户 2026-09-25 同意；`onScreen`）。
 */

export type ScenePhase = "active" | "inactive" | "background";

/** How often, while on screen, the persisted revision is read (one shared-defaults read). */
export const STATE_REVISION_WATCH_INTERVAL_MS = 3_000;

export type ForegroundOrderProjectionDependencies = Readonly<{
  runPass: (options: Readonly<{
    isActive: () => boolean;
    excludeOwnerIds: ReadonlySet<string>;
    /** On screen: completed orders are then projected too (2026-09-25). */
    onScreen: () => boolean;
  }>) => Promise<StoredOrderProjectionResult>;
  subscribeRefreshOutcome: (listener: (outcome: FullRefreshOutcome) => void) => () => void;
  peekRevision: () => number;
  applyState: (state: AppState) => void;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  watchIntervalMs?: number;
}>;

export type ForegroundOrderProjection = Readonly<{
  scenePhaseChanged: (phase: ScenePhase) => void;
  stop: () => void;
}>;

export function createForegroundOrderProjection(
  dependencies: ForegroundOrderProjectionDependencies,
): ForegroundOrderProjection {
  const watchIntervalMs = dependencies.watchIntervalMs ?? STATE_REVISION_WATCH_INTERVAL_MS;
  // The app root mounts while it is on screen; the first scene event may never come.
  let active = true;
  let stopped = false;
  let scheduled = false;
  let running = false;
  let rerun = false;
  let watchTimer: unknown = null;
  const onScreen = () => active && !stopped;
  const peek = () => {
    try { return dependencies.peekRevision(); } catch { return 0; }
  };
  let seenRevision = peek();

  function request(): void {
    if (!onScreen() || scheduled) return;
    if (running) {
      rerun = true;
      return;
    }
    scheduled = true;
    // Never inside the caller's stack: a refresh publishing its outcome finishes first.
    dependencies.setTimer(() => {
      scheduled = false;
      running = true;
      void runChain();
    }, 0);
  }

  async function runChain(): Promise<void> {
    const tried = new Set<string>();
    try {
      while (onScreen()) {
        const outcome = await dependencies.runPass({
          isActive: onScreen,
          excludeOwnerIds: tried,
          onScreen: () => !stopped && active,
        });
        if (outcome.state) dependencies.applyState(outcome.state);
        if (!outcome.ownerId) break;
        tried.add(outcome.ownerId);
        if (!outcome.moreDue) break;
        // A macrotask between orders lets a pull that queued behind this pass go first.
        await new Promise<void>((resolve) => { dependencies.setTimer(resolve, 0); });
      }
    } catch {
      /* the pass records its own failure; the next trigger simply tries again */
    } finally {
      running = false;
      // The chain's own commits are not another runtime's news: without this, every committing
      // pass would start the next one.
      seenRevision = peek();
      if (rerun) {
        rerun = false;
        request();
      }
    }
  }

  function watch(): void {
    watchTimer = null;
    if (!onScreen()) return;
    if (!running && !scheduled) {
      const revision = peek();
      if (revision > seenRevision) {
        seenRevision = revision;
        request();
      } else if (revision > 0 && revision < seenRevision) {
        seenRevision = revision;
      }
    }
    watchTimer = dependencies.setTimer(watch, watchIntervalMs);
  }

  function startWatching(): void {
    if (watchTimer == null && onScreen()) {
      watchTimer = dependencies.setTimer(watch, watchIntervalMs);
    }
  }

  function stopWatching(): void {
    if (watchTimer == null) return;
    dependencies.clearTimer(watchTimer);
    watchTimer = null;
  }

  const unsubscribe = dependencies.subscribeRefreshOutcome((outcome) => {
    // Background hosts never open the union page, so their refreshes never lead to a pass here.
    if (outcome.trigger === "background") return;
    request();
  });
  startWatching();

  return {
    scenePhaseChanged(phase) {
      if (stopped) return;
      active = phase === "active";
      if (!active) {
        stopWatching();
        return;
      }
      startWatching();
      request();
    },
    stop() {
      stopped = true;
      stopWatching();
      unsubscribe();
    },
  };
}

/** The app root's wiring; widget and App Intent entry points never import this module. */
export function startForegroundOrderProjection(
  host: Readonly<{ applyState: (state: AppState) => void }>,
): ForegroundOrderProjection {
  return createForegroundOrderProjection({
    runPass: (options) => projectStoredAccountOrders({ ...options, waitForOtherRuntime: true }),
    subscribeRefreshOutcome: subscribeFullRefreshOutcome,
    peekRevision: peekStateRevision,
    applyState: host.applyState,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
}
