import type { Shipment } from "../models";
import { currentPlatformSession, platformSession, type ExpressPlatform, type PlatformSession } from "./platform-accounts";
import { writeDiagnostic } from "./logger";
import { cainiaoParcelDetails, type PlatformParcel } from "./platform-parcel-data";
import { deliveryEstimateApplies, displayedPlatformFields, samePlatformTarget } from "./platform-parcel-merge";
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

function needsFields(shipment: Shipment) {
  const fields = displayedPlatformFields(shipment);
  return !fields.title || (!fields.estimate && deliveryEstimateApplies(shipment));
}

function jdOrderFor(owner: Shipment, shipments: readonly Shipment[]): string {
  const candidates = [owner, ...attachedProjectedOrders(shipments, owner)]
    .filter((row) => row.identity.accountOrder && row.identity.sourceProvider?.toLowerCase() === "jingdong")
    .map(({ identity }) => identity.orderId || identity.sourceId)
    .filter((id) => /^\d{8,32}$/.test(id));
  const orders = [...new Set(candidates)];
  return orders.length === 1 ? orders[0] : "";
}

export async function refreshParcelDetailFields(expected: Shipment, active: () => boolean) {
  const waybill = unprojectedAccountOrder(expected) ? "" : normalizeWaybill(displayWaybill(expected));
  if (!projectionSceneActive() || !active() || !/^[A-Z0-9]{6,64}$/.test(waybill)) return undefined;
  let observed = loadState();
  function ownerIn(state: typeof observed) {
    const matches = visibleShipments(state).filter((row) => !unprojectedAccountOrder(row) &&
      normalizeWaybill(displayWaybill(row)) === waybill);
    const row = matches[0];
    return matches.length === 1 && samePlatformTarget(expected, row) &&
      expected.forcedCompletedAtMs === row.forcedCompletedAtMs ? row : undefined;
  }
  const owner = ownerIn(observed);
  if (!owner || !needsFields(owner)) return undefined;
  const nativeSource = owner.identity.sourceProvider?.trim().toLowerCase();
  const pdd = owner.pddImport;
  const cainiao = !pdd && (nativeSource === "cainiao" || nativeSource === "taobao") ? platformSession("cainiao") : null;
  const pddSession = pdd?.orderId && /^[1-9][0-9]{0,19}$/.test(pdd.shippingId || "") ? platformSession("pinduoduo") : null;
  const jdOrder = jdOrderFor(owner, observed.shipments);
  const jd = jdOrder ? platformSession("jingdong") : null;
  if (!cainiao && !(pddSession && pddSession.ownerKey === pdd?.ownerKey) && !jd) return undefined;
  // Empty and failed reads consume the same per-waybill interval as a successful read.
  const reservation = acquireDurableRefreshLease("parcel-detail-fields:" + privateHash(waybill), DETAIL_FIELDS_INTERVAL_MS);
  if (!reservation) return undefined;
  let changed = false;
  async function read(platform: ExpressPlatform, session: PlatformSession, fetch: (eligible: () => boolean) => Promise<PlatformParcel | undefined>) {
    const current = () => projectionSceneActive() && !!currentPlatformSession(platform, session.generation);
    const eligible = () => {
      if (!active() || !current() || !reservation?.isCurrent()) return false;
      const state = loadState();
      const row = ownerIn(state);
      if (!row || !needsFields(row)) return false;
      return platform === "jingdong" ? jdOrderFor(row, state.shipments) === jdOrder :
        platform === "pinduoduo" ? JSON.stringify(row.pddImport) === JSON.stringify(pdd) :
          !row.pddImport && row.identity.sourceProvider?.trim().toLowerCase() === nativeSource;
    };
    try {
      if (!eligible()) return;
      const parcel = await fetch(eligible);
      if (parcel?.waybill !== waybill || !(parcel.title || parcel.estimate) || !eligible()) return;
      const saved = savePlatformParcelData({ observed, owner: session.ownerKey, detailTarget: owner,
        parcels: [parcel], current: eligible }).state;
      if (saved.revision !== observed.revision) changed = true;
      observed = saved;
    } catch {
      if (active() && current()) writeDiagnostic("platform.parcel_detail.unavailable", { sourceProvider: platform }, "warning");
    }
  }
  if (cainiao) await read("cainiao", cainiao, async () =>
    cainiaoParcelDetails(await readCainiao(cainiao, CAINIAO_PARCEL_DETAIL, { mailNo: waybill }), waybill, Date.now()));
  if (pddSession && pddSession.ownerKey === pdd?.ownerKey && pdd.shippingId) {
    const shippingId = pdd.shippingId;
    const fields = displayedPlatformFields(owner);
    const estimate = !fields.estimate && deliveryEstimateApplies(owner);
    await read("pinduoduo", pddSession, (eligible) => fetchPddParcelDetails(pddSession, shippingId, waybill, !fields.title, estimate, eligible));
  }
  if (jd) await read("jingdong", jd, (eligible) => fetchJdParcelDetails(jd, jdOrder, waybill, eligible));
  const shipment = changed ? ownerIn(observed) : undefined;
  return shipment ? { state: observed, shipment } : undefined;
}
