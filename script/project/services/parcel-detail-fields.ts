import type { AbortSignal } from "scripting";
import type { Shipment } from "../models";
import { currentPlatformSession, platformSession, type ExpressPlatform, type PlatformSession } from "./platform-accounts";
import { diagnosticErrorDetails, writeDiagnostic } from "./logger";
import { cainiaoParcelDetails, type PlatformParcel } from "./platform-parcel-data";
import { deliveryEstimateApplies, displayedPlatformFields, pddParcelProductImage, samePlatformTarget } from "./platform-parcel-merge";
import { fetchJdParcelDetails, fetchPddParcelDetails } from "./platform-web-parcels";
import { readCainiao } from "./platform-wire";
import { projectionSceneActive } from "./projection-viewport";
import { acquireDurableRefreshLease } from "./refresh-runtime-state";
import { displayWaybill, unprojectedAccountOrder } from "./shipment-policy";
import { normalizeWaybill } from "./status";
import { loadState, privateHash, savePlatformParcelData, visibleShipments } from "./storage";
import { attachedProjectedOrders } from "./waybill-ownership";

const CAINIAO_PARCEL_DETAIL = "mtop.cainiao.logisticsdetail.packages.pid.orderCode.mailNo.get";
const DETAIL_FIELDS_INTERVAL_MS = 3_600_000;

function isCainiaoParcel(shipment: Shipment): boolean {
  return !shipment.pddImport && /^(?:cainiao|taobao)$/i.test(shipment.identity.sourceProvider?.trim() || "");
}

function hasLocalParcelTitle(shipment: Shipment): boolean {
  const fields = shipment.platformFields;
  if (!fields || fields.waybillGeneration !== (shipment.waybillReuseAtMs ?? 0)) return false;
  const waybill = unprojectedAccountOrder(shipment) ? "" : displayWaybill(shipment);
  if (fields.waybill !== waybill) return false;
  return Boolean(fields.manualTitle || fields.title?.text);
}

export function needsParcelDetailFields(shipment: Shipment, refreshEstimate = false): boolean {
  const fields = displayedPlatformFields(shipment);
  if (!hasLocalParcelTitle(shipment) || ((refreshEstimate || !fields.estimate) && deliveryEstimateApplies(shipment))) return true;
  if (shipment.pddImport?.orderId && shipment.pddImport.shippingId) {
    return !shipment.identity.productImageURL && !pddParcelProductImage(shipment);
  }
  if (!isCainiaoParcel(shipment) || shipment.identity.productImageURL || shipment.identity.enhancedMode) return false;
  try {
    const active = platformSession("cainiao")?.generation;
    return Boolean(active && shipment.platformFields?.cainiaoImage?.generation !== active);
  } catch {
    return false;
  }
}

function jdOrderFor(owner: Shipment, shipments: readonly Shipment[]): string {
  const candidates = [owner, ...attachedProjectedOrders(shipments, owner)]
    .filter((row) => row.identity.accountOrder && row.identity.sourceProvider?.toLowerCase() === "jingdong")
    .map(({ identity }) => identity.orderId || identity.sourceId)
    .filter((id) => /^\d{8,32}$/.test(id));
  const orders = [...new Set(candidates)];
  return orders.length === 1 ? orders[0] : "";
}

export async function refreshParcelDetailFields(expected: Shipment, active: () => boolean,
  readState = loadState, signal?: AbortSignal) {
  const waybill = unprojectedAccountOrder(expected) ? "" : normalizeWaybill(displayWaybill(expected));
  if (!projectionSceneActive() || !active() || !/^[A-Z0-9]{6,64}$/.test(waybill) ||
    !needsParcelDetailFields(expected, true)) return undefined;
  let observed = readState();
  function ownerIn(state: typeof observed) {
    const matches = visibleShipments(state).filter((row) => !unprojectedAccountOrder(row) &&
      normalizeWaybill(displayWaybill(row)) === waybill);
    const row = matches[0];
    return matches.length === 1 && samePlatformTarget(expected, row) &&
      expected.forcedCompletedAtMs === row.forcedCompletedAtMs ? row : undefined;
  }
  const owner = ownerIn(observed);
  if (!owner || !needsParcelDetailFields(owner, true)) return undefined;
  const nativeSource = owner.identity.sourceProvider?.trim().toLowerCase();
  const pdd = owner.pddImport;
  const cainiao = !pdd && (nativeSource === "cainiao" || nativeSource === "taobao") ? platformSession("cainiao") : null;
  const pddSession = pdd?.orderId && /^[1-9][0-9]{0,19}$/.test(pdd.shippingId || "") ? platformSession("pinduoduo") : null;
  const jdOrder = jdOrderFor(owner, observed.shipments);
  const jd = jdOrder ? platformSession("jingdong") : null;
  if (!cainiao && !(pddSession && pddSession.ownerKey === pdd?.ownerKey) && !jd) return undefined;
  const sessionKey = [cainiao?.generation, pddSession?.generation, jd?.generation].filter(Boolean).join("|");
  // Cainiao keeps the existing image-selector lease across successful captures; include session generations
  // so re-authenticating an account can retry immediately, and release the lease if every attempt aborts/throws.
  const lease = cainiao ? "parcel-detail-fields:cainiao-goods-v2:" : "parcel-detail-fields:";
  const reservation = acquireDurableRefreshLease(lease + privateHash(`${waybill}\u0000${sessionKey}`), DETAIL_FIELDS_INTERVAL_MS);
  if (!reservation) return undefined;
  let changed = false;
  let settledRead = false;
  async function read(platform: ExpressPlatform, session: PlatformSession, fetch: (eligible: () => boolean) => Promise<PlatformParcel | undefined>) {
    const current = () => projectionSceneActive() && !!currentPlatformSession(platform, session.generation);
    const eligible = () => {
      if (!active() || !current() || !reservation?.isCurrent()) return false;
      const state = readState();
      const row = ownerIn(state);
      if (!row || !needsParcelDetailFields(row, true)) return false;
      return platform === "jingdong" ? jdOrderFor(row, state.shipments) === jdOrder :
        platform === "pinduoduo" ? JSON.stringify(row.pddImport) === JSON.stringify(pdd) :
          !row.pddImport && row.identity.sourceProvider?.trim().toLowerCase() === nativeSource;
    };
    // D128: each platform read that runs ends with one line (committed, unchanged or empty); a failure keeps its
    // unavailable line with its category. A read that does not start (no longer eligible) writes nothing.
    const startedAt = Date.now();
    const end = (result: "committed" | "unchanged" | "empty") => writeDiagnostic("platform.parcel_detail.completed", {
      sourceProvider: platform, result, durationMs: Date.now() - startedAt,
    });
    try {
      if (!eligible()) return;
      const parcel = await fetch(eligible);
      if (parcel?.waybill !== waybill || !(parcel.title || parcel.estimate || parcel.productImageURL)) {
        if (eligible()) {
          settledRead = true;
          end("empty");
        }
        return;
      }
      if (!eligible()) return;
      const saved = savePlatformParcelData({ observed, owner: session.ownerKey, detailTarget: owner,
        cainiaoGeneration: platform === "cainiao" ? session.generation : undefined, parcels: [parcel], current: eligible }).state;
      settledRead = true;
      if (saved.revision !== observed.revision) changed = true;
      end(saved.revision !== observed.revision ? "committed" : "unchanged");
      observed = saved;
    } catch (error) {
      if (active() && current()) {
        writeDiagnostic("platform.parcel_detail.unavailable", {
          sourceProvider: platform, durationMs: Date.now() - startedAt, ...diagnosticErrorDetails(error),
        }, "warning");
      }
    }
  }
  try {
    if (cainiao) await read("cainiao", cainiao, async () =>
      cainiaoParcelDetails(await readCainiao(cainiao, CAINIAO_PARCEL_DETAIL, { mailNo: waybill }, signal), waybill, Date.now()));
    if (pddSession && pddSession.ownerKey === pdd?.ownerKey && pdd.shippingId) {
      const shippingId = pdd.shippingId;
      const estimate = deliveryEstimateApplies(owner);
      const image = !owner.identity.productImageURL && !pddParcelProductImage(owner);
      await read("pinduoduo", pddSession, (eligible) =>
        fetchPddParcelDetails(pddSession, shippingId, waybill, !hasLocalParcelTitle(owner), estimate, image, eligible, signal));
    }
    if (jd) await read("jingdong", jd, (eligible) => fetchJdParcelDetails(jd, jdOrder, waybill, eligible, signal));
  } finally {
    if (!settledRead) {
      try { reservation.release(); } catch { /* Best-effort lease rollback on transient error or exit. */ }
    }
  }
  const shipment = changed ? ownerIn(observed) : undefined;
  return shipment ? { state: observed, shipment } : undefined;
}
