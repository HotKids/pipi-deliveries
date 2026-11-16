/** Serialized H5 WebView controller and Cainiao / Kuaidi100 / JT H5 timeline capture helpers. */
import { normalizeTimelineSlot } from "../timeline-slot";
import type { Shipment } from "../../models";
import { loadOrderProjectionReference, loadShipmentRoute } from "../routes";
import { applySameSourceTimeline, displayWaybill, unprojectedAccountOrder } from "../shipment-policy";
import { timedTracks } from "../status";
import { acquireRenewingDurableRefreshLease, type DurableRefreshLease } from "../refresh-runtime-state";
import { assertWithinDeadline, deadlineAfter, waitForRefresh } from "../deadline";
import { ACCOUNT_H5_BUDGET_MS } from "../account-sync-policy";
import { scrapeCainiaoH5Timeline, type CainiaoH5Diagnostics } from "../cainiao-h5";
import { scrapeWebTimeline, type WebTimelineDiagnostics } from "../web-timeline";
import {
  assertRefreshSignal,
  createSyncRuntimeState,
  isCainiaoAutomaticShipment,
  isJingDongAutomaticShipment,
  type SyncRuntimeState,
} from "./shared";

export function storedCainiaoRoute(shipment: Shipment, now = Date.now()): string {
  if (
    !isCainiaoAutomaticShipment(shipment) ||
    shipment.route?.kind !== "cainiao"
  ) return "";
  return loadShipmentRoute(
    shipment.identity.id,
    shipment.route.source,
    now,
  );
}

const defaultH5RuntimeState = createSyncRuntimeState();

export async function withH5Controller<T>(
  runtimeState: SyncRuntimeState,
  capture: () => Promise<T>,
  deadlineAtMs = deadlineAfter(ACCOUNT_H5_BUDGET_MS),
  signal?: AbortSignal,
): Promise<T> {
  const previous = runtimeState.h5Queue;
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  runtimeState.h5Queue = previous.then(() => turn);
  let durable: DurableRefreshLease | null = null;
  try {
    await waitForRefresh(previous, deadlineAtMs, signal);
    while (!durable) {
      assertRefreshSignal(signal);
      assertWithinDeadline(deadlineAtMs);
      durable = acquireRenewingDurableRefreshLease("detail:h5", deadlineAtMs - Date.now() + 1000);
      if (!durable) await waitForRefresh(new Promise<void>(resolve => setTimeout(resolve, 100)), deadlineAtMs, signal);
    }
    return await capture();
  } finally {
    durable?.release();
    release();
  }
}

export async function refreshWebTimeline(
  shipment: Shipment,
  deadlineAtMs?: number,
  observe?: (diagnostics: WebTimelineDiagnostics) => void,
  signal?: AbortSignal,
  onQueryAttempted?: (authorized: boolean) => void,
  boundPhoneTails: readonly string[] = [],
  beforeQuery?: () => void,
  runtimeState: SyncRuntimeState = defaultH5RuntimeState,
): Promise<Shipment | null> {
  // Stage eligibility belongs to callers; an order number is never a K100 waybill.
  if (unprojectedAccountOrder(shipment)) return null;
  const now = Date.now();
  const timeline = await withH5Controller(runtimeState, () => scrapeWebTimeline({
    waybill: displayWaybill(shipment),
    courierCode: shipment.identity.courierCode,
    companyName: shipment.identity.companyName,
    phoneTail: shipment.identity.phoneTail,
    phoneTails: boundPhoneTails,
    deadlineAtMs,
    signal,
    onQueryAttempted,
    beforeQuery,
    ...(isJingDongAutomaticShipment(shipment) ? { projectedJdOrder: true as const } : {}),
  }, observe), deadlineAtMs, signal);
  if (!timeline) return null;
  const enriched = applySameSourceTimeline(shipment, timeline, now);
  const captured = enriched.manualTimelines?.find(candidate =>
    normalizeTimelineSlot(candidate.provider) === normalizeTimelineSlot(timeline.provider));
  // Provider results carry their own accumulated package, not a presentation with borrowed owner status.
  return captured ? { ...enriched, timeline: captured, sourceTimeline: null,
    manualTimelines: [captured] } : null;
}

export function storedJingDongProjectionRoute(
  shipment: Shipment,
  now = Date.now(),
): string {
  const source = shipment.identity.bindingSource;
  if (!isJingDongAutomaticShipment(shipment) || !source) return "";
  return loadOrderProjectionReference(shipment.identity.id, source, now);
}

export async function refreshCainiaoH5(
  shipment: Shipment,
  routeUrl: string,
  deadlineAtMs?: number,
  observe?: (diagnostics: CainiaoH5Diagnostics) => void,
  signal?: AbortSignal,
  onQueryAttempted?: (authorized: boolean) => void,
  beforeQuery?: () => void,
  runtimeState: SyncRuntimeState = defaultH5RuntimeState,
): Promise<Shipment | null> {
  assertRefreshSignal(signal);
  if (!isCainiaoAutomaticShipment(shipment) || !routeUrl) return null;
  const now = Date.now();
  const timeline = await withH5Controller(runtimeState, () => scrapeCainiaoH5Timeline({
    routeUrl,
    waybill: displayWaybill(shipment),
    courierCode: shipment.identity.courierCode,
    companyName: shipment.identity.companyName,
    deadlineAtMs,
    successAtMs: now,
    signal,
    onQueryAttempted,
    beforeQuery,
  }, observe), deadlineAtMs, signal);
  assertRefreshSignal(signal);
  return timeline && timedTracks(timeline.tracks).length
    ? applySameSourceTimeline(shipment, timeline, now)
    : null;
}
