import type { Shipment } from "../models";
import {
  compareManualTimelineAuthority,
  containsTimelineStartTrack,
  timedTracks,
} from "./status";
import {
  assertWithinDeadline,
  deadlineExpired,
  OperationTimeoutError,
} from "./deadline";

export type ManualSource = "local" | "route" | "fallback";

export const MANUAL_SOURCE_ORDER: readonly ManualSource[] = [
  "local",
  "route",
  "fallback",
];

export type ManualSourceResult = Readonly<{
  shipment: Shipment | null;
  routeUrl?: string;
  skipReason?: string;
}>;

export type ManualSourceAdapter = Readonly<{
  source: ManualSource;
  enabled: boolean;
  query: () => Promise<ManualSourceResult>;
}>;

export type ManualSourceObservation = Readonly<{
  source: ManualSource;
  phase: "started" | "settled";
  durationMs?: number;
  result?: ManualSourceResult;
  error?: unknown;
}>;

export type ManualQuerySelection = Readonly<{
  selected: Shipment | null;
  selectedRouteUrl: string;
  successes: readonly Shipment[];
  errors: Readonly<Partial<Record<ManualSource, unknown>>>;
}>;

export function hasPersistentTracking(shipment: Shipment | null): boolean {
  return Boolean(shipment && timedTracks(shipment.timeline.tracks).length);
}

/**
 * Queries independent local capabilities first. The explicitly enabled final
 * fallback runs once only when no earlier capability reached the order or
 * pickup stage. Providers stay separate so each cache can merge incrementally.
 */
export async function queryManualSourceChain(
  adapters: readonly ManualSourceAdapter[],
  deadlineAtMs?: number,
  observe?: (observation: ManualSourceObservation) => void,
  signal?: AbortSignal,
  hasAccumulatedTimelineStart?: (shipments: readonly Shipment[]) => boolean,
  preferRouteFirst = false,
): Promise<ManualQuerySelection> {
  const assertNotCancelled = () => {
    if (signal?.aborted) throw new OperationTimeoutError();
  };
  const assertCanStart = () => {
    assertNotCancelled();
    assertWithinDeadline(deadlineAtMs);
  };
  assertCanStart();
  const active = MANUAL_SOURCE_ORDER.flatMap((source) => {
    const adapter = adapters.find((candidate) => candidate.source === source);
    return adapter?.enabled ? [adapter] : [];
  });
  const errors: Partial<Record<ManualSource, unknown>> = {};
  const candidates: Array<{ shipment: Shipment; routeUrl: string }> = [];
  const successes: Array<{ shipment: Shipment; routeUrl: string }> = [];
  const routes: string[] = [];
  const run = async (batch: readonly ManualSourceAdapter[]) => {
    const settled = await Promise.all(batch.map(async (adapter) => {
      assertCanStart();
      const startedAt = Date.now();
      observe?.({ source: adapter.source, phase: "started" });
      try {
        const result = await adapter.query();
        assertNotCancelled();
        // A result that arrived after its own deadline is not accepted. Results
        // that completed earlier remain available when a peer later times out.
        if (deadlineExpired(deadlineAtMs)) throw new OperationTimeoutError();
        const item = {
          source: adapter.source,
          result,
          error: null,
        } as const;
        observe?.({
          source: adapter.source,
          phase: "settled",
          durationMs: Date.now() - startedAt,
          result: item.result,
        });
        return item;
      } catch (error) {
        assertNotCancelled();
        const settledError = error instanceof OperationTimeoutError ||
            deadlineExpired(deadlineAtMs)
          ? new OperationTimeoutError()
          : error;
        observe?.({
          source: adapter.source,
          phase: "settled",
          durationMs: Date.now() - startedAt,
          error: settledError,
        });
        return {
          source: adapter.source,
          result: null,
          error: settledError,
        } as const;
      }
    }));
    for (const item of settled) {
      if (item.error) {
        errors[item.source] = item.error;
        continue;
      }
      const shipment = item.result?.shipment || null;
      const routeUrl = String(item.result?.routeUrl || "").trim();
      if (routeUrl) routes.push(routeUrl);
      if (shipment) candidates.push({ shipment, routeUrl });
      if (!hasPersistentTracking(shipment)) continue;
      successes.push({
        shipment: shipment as Shipment,
        routeUrl,
      });
    }
  };

  const fallback = active.find((adapter) => adapter.source === "fallback");
  const primary = active.filter((adapter) => adapter.source !== "fallback");
  if (preferRouteFirst) {
    await run(primary.filter((adapter) => adapter.source === "route"));
    const routeReachedStart = hasAccumulatedTimelineStart
      ? hasAccumulatedTimelineStart(successes.map((item) => item.shipment))
      : successes.some((item) =>
          containsTimelineStartTrack(item.shipment.timeline.tracks)
        );
    if (!routeReachedStart) {
      await run(primary.filter((adapter) => adapter.source !== "route"));
    }
  } else {
    await run(primary);
  }
  assertNotCancelled();
  if (
    !(hasAccumulatedTimelineStart
      ? hasAccumulatedTimelineStart(
          successes.map((item) => item.shipment),
        )
      : successes.some((item) =>
          containsTimelineStartTrack(item.shipment.timeline.tracks)
        )) &&
    fallback &&
    !deadlineExpired(deadlineAtMs)
  ) {
    await run([fallback]);
  }
  assertNotCancelled();

  const timedOut = Object.values(errors).some(
    (error) => error instanceof OperationTimeoutError,
  );
  if (!candidates.length && (deadlineExpired(deadlineAtMs) || timedOut)) {
    throw new OperationTimeoutError();
  }

  const byAuthority = (
    left: { shipment: Shipment },
    right: { shipment: Shipment },
  ) => {
    return compareManualTimelineAuthority(
      left.shipment.timeline,
      right.shipment.timeline,
    );
  };
  successes.sort(byAuthority);
  candidates.sort(byAuthority);
  const selected = successes[0] || candidates[0] || null;
  return {
    selected: selected?.shipment || null,
    selectedRouteUrl: routes[0] || "",
    successes: successes.map((item) => item.shipment),
    errors,
  };
}
