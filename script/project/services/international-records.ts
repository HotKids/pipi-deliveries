import type { Shipment, StatusSemantic, TrackNode } from "../models";
import { SCRIPT_BUILD_TRACK } from "./build-track";
import { gatewayCredentialForLocalCache } from "./credentials";
import { readDurableTextCandidates, removeDurableText } from "./durable-files";
import { GatewayError, postGateway } from "./gateway";
import { asPlainObject, cleanString, positiveFiniteTime } from "./value-guards";
import { diagnosticErrorDetails, writeDiagnostic } from "./logger";
import { headlineTrack } from "./status";
import { formatListTime } from "./time-presentation";

const CACHE = "international-shipments-v1.json";
const RECORD_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const WATCH_ICONS = new Set(["dhl", "fedex", "gls", "ups", "usps"]);
const WATCH_STATES = new Set([
  "ORDERED", "SHIPPED", "PICKED", "TRANSIT", "DELIVERY", "WAITING_PICKUP", "COMPLETED", "DANGER", "CANCELLED", "UNKNOWN",
]);
export type WatchSnapshot = { scope: string; snapshot: string; observedAtMs: number; shipments: Shipment[] };
let inFlight: { scope: string; work: Promise<WatchSnapshot | undefined> } | undefined;

export function internationalShipment(shipment: Shipment | null | undefined): boolean {
  return shipment?.identity.sourceProvider === "lastscanned";
}

/**
 * Whether opening this Watch parcel's detail reads the Watch page (G-MED-02, 2026-11-20 review). A parcel the Bot
 * reports as signed or cancelled that already shows its scans opens from what is stored; one still under way, or
 * without scans, reads the page on open as before. A detail pull always reads it. The source status decides, so a
 * local manual sign-off keeps the source's refresh.
 */
export function watchDetailOpenRefreshes(shipment: Shipment): boolean {
  const semantic = shipment.timeline.semantic;
  return !((semantic === "COMPLETED" || semantic === "CANCELLED") && shipment.timeline.tracks.length > 0);
}

/**
 * How many leading tracks of the record (newest first) the Bot holds (R5 follow-up, owner 2026-11-25 「所有展示面都跳过
 * （推荐）」): while a lagging LastScanned summary has not caught up with the newest delivered, exception or returned
 * scans, `heldTracks` counts them. A non-negative integer; absent or invalid reads as 0, so an older Bot record keeps
 * its headline, and a terminal status holds nothing. The status itself is the record's, unchanged.
 */
function heldTrackCount(value: unknown, semantic: StatusSemantic, trackCount: number): number {
  if (semantic === "COMPLETED" || semantic === "CANCELLED") return 0;
  return Number.isSafeInteger(value) && (value as number) > 0 ? Math.min(value as number, trackCount) : 0;
}

export function internationalShipmentSnapshot(value: unknown, now: number): Shipment {
  const row = asPlainObject(value);
  const id = cleanString(row.id), waybill = cleanString(row.waybill);
  const updatedAtMs = positiveFiniteTime(row.updatedAt, now);
  const companyName = cleanString(row.carrierName), semantic = cleanString(row.status) as StatusSemantic;
  const statusText = cleanString(row.statusText);
  const courierCode = WATCH_ICONS.has(cleanString(row.icon)) ? `watch-${row.icon}` : "watch";
  if (!RECORD_ID.test(id) || !/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(waybill) ||
      !updatedAtMs || !companyName || !statusText || !WATCH_STATES.has(semantic) ||
      !Array.isArray(row.tracks) || row.tracks.length > 100) throw new Error("Invalid international shipment");
  const held = heldTrackCount(row.heldTracks, semantic, row.tracks.length);
  const tracks: TrackNode[] = row.tracks.map((value, index) => {
    const scan = asPlainObject(value);
    const timeMs = positiveFiniteTime(scan.at, now) || null;
    // A timed scan reads in Beijing time like the list row (2026-11-20 review, part 3 rule 1);
    // an untimed scan keeps the scan's local time.
    return { timeText: timeMs ? formatListTime(new Date(timeMs).toISOString()) : cleanString(scan.time), timeMs,
      detail: cleanString(scan.detail), ...(index < held ? { held: true as const } : {}), statusCode: "", raw: {} };
  }).sort((left, right) => (right.timeMs ?? 0) - (left.timeMs ?? 0));
  // The headline, and the row's time (its sort and retention read it in place of the headline's text), start after
  // the held scans; with every scan held the headline is the status text, as the Bot's notice card shows it.
  const latest = headlineTrack(tracks);
  const forecast = cleanString(row.deliveryEstimate);
  const observed = positiveFiniteTime(row.deliveryEstimateObservedAt, now);
  const completedAt = positiveFiniteTime(row.completed, now)
    || positiveFiniteTime(row.completedAt, now)
    || positiveFiniteTime(row.forcedCompletedAtMs, now)
    || (row.completed === true || row.action === "completed" ? positiveFiniteTime(row.actedAt, now) || updatedAtMs : 0);
  return {
    identity: { id: `watch:${id}`, bindingSource: null, sourceId: waybill, sourceOwner: "lastscanned",
      sourceProvider: "lastscanned", phoneTail: "", courierCode, companyName, manuallyAdded: false, createdAtMs: updatedAtMs },
    timeline: { provider: "lastscanned", waybill, courierCode, companyName, semantic, structuredStatus: true,
      statusEventAtMs: latest?.timeMs ?? null,
      latestTimeText: latest?.timeText ?? "",
      latestDetail: latest?.detail || statusText, tracks, successAtMs: updatedAtMs },
    ...(forecast && observed ? { platformFields: { waybill, waybillGeneration: 0,
      estimate: { text: forecast, source: "lastscanned" as const, capturedAtMs: observed } } } : {}),
    ...(completedAt > 0 ? { forcedCompletedAtMs: completedAt } : {}),
    updatedAtMs,
  };
}

export function activeWatchScope(): string {
  if (SCRIPT_BUILD_TRACK !== "formal") return "";
  const key = gatewayCredentialForLocalCache();
  return key && !key.rejected ? key.scope : "";
}

/** The pre-import Watch cache is read only until it is imported or proven to belong to another key. */
export function retireLegacyWatchSnapshot(): void {
  removeDurableText(CACHE);
}

export function legacyWatchSnapshot(): WatchSnapshot | undefined {
  try {
    const scope = activeWatchScope();
    if (!scope) return;
    const candidates = readDurableTextCandidates(CACHE);
    if (!candidates.length) return;
    for (const candidate of candidates) {
      const snapshot = asPlainObject(JSON.parse(candidate));
      if (snapshot.scope !== scope) {
        retireLegacyWatchSnapshot();
        return;
      }
      if (Array.isArray(snapshot.parcels)) {
        const now = Date.now();
        return { scope, snapshot: "", observedAtMs: 0,
          shipments: snapshot.parcels.map(parcel => internationalShipmentSnapshot(parcel, now)) };
      }
    }
  } catch { /* The optional view must never block the shipment list. */ }
}

export function refreshInternationalShipments(budgetMs = 20_000): Promise<WatchSnapshot | undefined> {
  const scope = activeWatchScope();
  if (!scope) return Promise.resolve(undefined);
  if (inFlight?.scope === scope) return inFlight.work;
  const work = (async () => {
    const shipments: Shipment[] = [];
    const ids = new Set<string>();
    const observedAtMs = Date.now();
    const deadlineAtMs = observedAtMs + budgetMs;
    let after: string | null = null;
    let snapshot = "";
    try {
      do {
        const page: Record<string, unknown> = await postGateway("/api/cloud-records/international-shipments",
          { schemaVersion: 1, ...(after ? { after, snapshot } : {}) }, { deadlineAtMs });
        if (activeWatchScope() !== scope) return;
        if (page.ok !== true || typeof page.snapshot !== "string" || !/^[a-f0-9]{64}$/.test(page.snapshot) ||
            (after && page.snapshot !== snapshot) || !Array.isArray(page.parcels) || page.parcels.length > 100 ||
            !(page.nextAfter === null || typeof page.nextAfter === "string" && RECORD_ID.test(page.nextAfter)
              && (!after || page.nextAfter > after))) throw new Error("Invalid international shipment page");
        const pageNow = Date.now();
        for (const parcel of page.parcels) {
          const raw = asPlainObject(parcel);
          if (
            raw.deleted === true ||
            positiveFiniteTime(raw.deleted, pageNow) > 0 ||
            positiveFiniteTime(raw.deletedAt, pageNow) > 0 ||
            raw.action === "deleted" ||
            cleanString(raw.status) === "DELETED"
          ) continue;
          const normalized = internationalShipmentSnapshot(parcel, pageNow);
          if (ids.has(normalized.identity.id)) throw new Error("Duplicate international shipment");
          ids.add(normalized.identity.id);
          shipments.push(normalized);
        }
        snapshot = page.snapshot;
        after = page.nextAfter;
      } while (after);
      return { scope, snapshot, observedAtMs, shipments };
    } catch (error) {
      // D105: a failed Watch page read (including HTTP 403) preserves stored local Watch rows and notes.
      if (activeWatchScope() === scope) {
        writeDiagnostic("cloud.sync.failed", {
          domain: "international", stage: "watch_page", durationMs: Date.now() - observedAtMs, records: shipments.length,
          ...diagnosticErrorDetails(error),
        }, "warning");
      }
    }
  })().finally(() => { if (inFlight?.work === work) inFlight = undefined; });
  inFlight = { scope, work };
  return work;
}
