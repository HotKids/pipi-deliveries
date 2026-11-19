import type { Shipment, StatusSemantic, TrackNode } from "../models";
import { SCRIPT_BUILD_TRACK } from "./build-track";
import { gatewayCredentialForLocalCache } from "./credentials";
import { readDurableTextCandidates } from "./durable-files";
import { GatewayError, postGateway } from "./gateway";
import { asPlainObject, cleanString, positiveFiniteTime } from "./value-guards";

const CACHE = "international-shipments-v1.json";
const RECORD_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const WATCH_ICONS = new Set(["dhl", "fedex", "gls", "ups", "usps"]);
const WATCH_STATES = new Set(["ORDERED", "TRANSIT", "DELIVERY", "COMPLETED", "DANGER", "CANCELLED", "UNKNOWN"]);
export type WatchSnapshot = { scope: string; snapshot: string; observedAtMs: number; shipments: Shipment[] };
let inFlight: { scope: string; work: Promise<WatchSnapshot | undefined> } | undefined;

export function internationalShipment(shipment: Shipment | null | undefined): boolean {
  return shipment?.identity.sourceProvider === "lastscanned";
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
  const tracks: TrackNode[] = row.tracks.map((value) => {
    const scan = asPlainObject(value);
    return { timeText: cleanString(scan.time), timeMs: positiveFiniteTime(scan.at, now) || null,
      detail: cleanString(scan.detail), statusCode: "", raw: {} };
  }).sort((left, right) => (right.timeMs ?? 0) - (left.timeMs ?? 0));
  const latest = tracks[0];
  const forecast = cleanString(row.deliveryEstimate);
  const observed = positiveFiniteTime(row.deliveryEstimateObservedAt, now);
  return {
    identity: { id: `watch:${id}`, bindingSource: null, sourceId: waybill, sourceOwner: "lastscanned",
      sourceProvider: "lastscanned", phoneTail: "", courierCode, companyName, manuallyAdded: false, createdAtMs: updatedAtMs },
    timeline: { provider: "lastscanned", waybill, courierCode, companyName, semantic, structuredStatus: true,
      statusEventAtMs: latest?.timeMs ?? null,
      latestTimeText: latest?.timeMs ? new Date(latest.timeMs).toISOString() : latest?.timeText ?? "",
      latestDetail: latest?.detail ?? "", tracks, successAtMs: updatedAtMs },
    ...(forecast && observed ? { platformFields: { waybill, waybillGeneration: 0,
      estimate: { text: forecast, source: "lastscanned" as const, capturedAtMs: observed } } } : {}),
    updatedAtMs,
  };
}

export function activeWatchScope(): string {
  if (SCRIPT_BUILD_TRACK !== "formal") return "";
  const key = gatewayCredentialForLocalCache();
  return key && !key.rejected ? key.scope : "";
}

export function legacyWatchSnapshot(): WatchSnapshot | undefined {
  try {
    const candidates = readDurableTextCandidates(CACHE);
    if (!candidates.length) return;
    const scope = activeWatchScope();
    if (!scope) return;
    for (const candidate of candidates) {
      const snapshot = asPlainObject(JSON.parse(candidate));
      if (snapshot.scope !== scope) return;
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
        for (const parcel of page.parcels) {
          const shipment = internationalShipmentSnapshot(parcel, Date.now());
          if (ids.has(shipment.identity.id)) throw new Error("Duplicate international shipment");
          ids.add(shipment.identity.id);
          shipments.push(shipment);
        }
        snapshot = page.snapshot;
        after = page.nextAfter;
      } while (after);
      return { scope, snapshot, observedAtMs, shipments };
    } catch (error) {
      if (activeWatchScope() === scope && error instanceof GatewayError && error.status === 403) {
        return { scope, snapshot: "", observedAtMs, shipments: [] };
      }
    }
  })().finally(() => { if (inFlight?.work === work) inFlight = undefined; });
  inFlight = { scope, work };
  return work;
}
