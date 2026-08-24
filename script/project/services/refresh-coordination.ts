import { OperationTimeoutError } from "./deadline";

export type DetailRefreshEntry<Source, Result> = Readonly<{
  source: Source;
  promise: Promise<Result>;
}>;

type FullRefreshEntry<Result> = Readonly<{
  promise: Promise<Result>;
  deadlineAtMs?: number;
  generation: number;
}>;

export type FullRefreshLease = Readonly<{
  generation: number;
  deadlineAtMs?: number;
  isCurrent: (now?: number) => boolean;
  assertCurrent: (now?: number) => void;
}>;

export type FullRefreshOptions = Readonly<{
  blockerDeadlineAtMs?: number;
  operationDeadlineAtMs?: number;
}>;

type BlockerState<Result> =
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "fulfilled"; value: Result }>
  | Readonly<{ status: "rejected" }>;

/**
 * Coordinates full and per-shipment refreshes inside one Scripting runtime.
 * A full refresh only coordinates with detail calls that existed before it
 * was registered. Timed-out blockers are skipped so a suspended detail task
 * cannot hold the global refresh slot indefinitely.
 */
export class RefreshCoordinator<Source, DetailKey, DetailResult, FullResult> {
  private nextGeneration = 0;
  private readonly fullRefreshes = new Map<
    Source,
    FullRefreshEntry<FullResult>
  >();
  private readonly detailRefreshes = new Map<
    DetailKey,
    DetailRefreshEntry<Source, DetailResult>
  >();

  full(source: Source, now = Date.now()): Promise<FullResult> | undefined {
    const entry = this.fullRefreshes.get(source);
    if (!entry) return undefined;
    if (entry.deadlineAtMs != null && now >= entry.deadlineAtMs) {
      this.fullRefreshes.delete(source);
      return undefined;
    }
    return entry.promise;
  }

  detail(key: DetailKey): Promise<DetailResult> | undefined {
    return this.detailRefreshes.get(key)?.promise;
  }

  runDetail(
    key: DetailKey,
    source: Source,
    task: () => Promise<DetailResult>,
    reuseFull: (result: FullResult) => DetailResult | Promise<DetailResult>,
  ): Promise<DetailResult> {
    const existing = this.detailRefreshes.get(key);
    if (existing) return existing.promise;
    const full = this.full(source);
    let promise: Promise<DetailResult>;
    promise = (full ? full.then(reuseFull, task) : task()).finally(() => {
      if (this.detailRefreshes.get(key)?.promise === promise) {
        this.detailRefreshes.delete(key);
      }
    });
    this.detailRefreshes.set(key, { source, promise });
    return promise;
  }

  runFull(
    source: Source,
    task: (
      skipDetailKeys: ReadonlySet<DetailKey>,
      lease: FullRefreshLease,
    ) => Promise<FullResult>,
    shouldSkipDetail: (result: DetailResult) => boolean = () => true,
    options: FullRefreshOptions = {},
  ): Promise<FullResult> {
    const existing = this.full(source);
    if (existing) return existing;
    const generation = ++this.nextGeneration;
    const blockers = [...this.detailRefreshes.entries()].filter(
      ([, entry]) => entry.source === source,
    );
    const lease: FullRefreshLease = {
      generation,
      deadlineAtMs: options.operationDeadlineAtMs,
      isCurrent: (now = Date.now()) => {
        const current = this.fullRefreshes.get(source);
        return Boolean(
          current?.generation === generation &&
            (
              options.operationDeadlineAtMs == null ||
              now < options.operationDeadlineAtMs
            ),
        );
      },
      assertCurrent: (now = Date.now()) => {
        if (!lease.isCurrent(now)) throw new OperationTimeoutError();
      },
    };
    let promise: Promise<FullResult>;
    const work = Promise.resolve().then(async () => {
      const skipDetailKeys = new Set<DetailKey>();
      const blockerStates: BlockerState<DetailResult>[] = blockers.map(
        () => ({ status: "pending" }),
      );
      const blockerResults = Promise.all(
        blockers.map(([, entry], index) => entry.promise.then(
          (value) => {
            blockerStates[index] = { status: "fulfilled", value };
          },
          () => {
            blockerStates[index] = { status: "rejected" };
          },
        )),
      );
      const blockerDeadlineAtMs = options.blockerDeadlineAtMs;
      if (blockerDeadlineAtMs == null || !blockers.length) {
        await blockerResults;
      } else {
        const delayMs = Math.max(0, blockerDeadlineAtMs - Date.now());
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            blockerResults,
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, delayMs);
            }),
          ]);
        } finally {
          if (timeout != null) clearTimeout(timeout);
        }
      }
      blockerStates.forEach((result, index) => {
        if (
          result.status === "pending" ||
          (
            result.status === "fulfilled" &&
            shouldSkipDetail(result.value)
          )
        ) {
          skipDetailKeys.add(blockers[index][0]);
        }
      });
      lease.assertCurrent();
      return task(skipDetailKeys, lease);
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const guarded = options.operationDeadlineAtMs == null
      ? work
      : Promise.race([
          work,
          new Promise<FullResult>((_, reject) => {
            timeout = setTimeout(() => {
              if (this.fullRefreshes.get(source)?.generation === generation) {
                this.fullRefreshes.delete(source);
              }
              reject(new OperationTimeoutError());
            }, Math.max(0, options.operationDeadlineAtMs! - Date.now()));
          }),
        ]);
    promise = guarded.finally(() => {
      if (timeout != null) clearTimeout(timeout);
      if (this.fullRefreshes.get(source)?.promise === promise) {
        this.fullRefreshes.delete(source);
      }
    });
    this.fullRefreshes.set(source, {
      promise,
      deadlineAtMs: options.operationDeadlineAtMs,
      generation,
    });
    return promise;
  }
}
