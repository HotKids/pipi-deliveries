import type {
  AccountBinding,
  AccountDetailRecord,
  BindingSource,
  Shipment,
  ShipmentRoute,
  StatusSemantic,
  TrackNode,
} from "../models";
import { AccountApi } from "./account-api";
import { loadAccountIdentity } from "./account-identity";
import type { AccountParcelDto } from "./account-parser";
import {
  matchBoundPhone,
  normalizePhoneEvidence,
  parseAccountSyncResult,
  parseAccountTimelineResponse,
} from "./account-parser";
import { postGateway } from "./gateway";
import {
  normalizeWaybill,
  normalizedProjectedWaybill,
  parseProviderTime,
  semanticFromText,
} from "./status";
import {
  assertWithinDeadline,
  remainingTimeoutMs,
} from "./deadline";
import {
  ACCOUNT_FOLLOWUP_RESERVE_MS,
  ACCOUNT_LIST_BUDGET_MS,
  accountChildDeadline,
} from "./account-sync-policy";
import {
  SCRIPT_BINDING_SOURCE,
  SCRIPT_MANUAL_QUERY_SOURCE,
  requireScriptSource,
} from "./script-source";
import { projectedCarrierPresentation } from "./carrier-presentation";

const SCRIPT_CLIENT_VERSION = "0.5";
const SCRIPT_CLIENT_BUILD = 210;

export type AccountParcelFetchResult = Readonly<{
  parcels: readonly AccountParcelDto[];
  rawRecords: number;
  rejectedRecords: number;
}>;

function accountApi(deadlineAtMs?: number): AccountApi {
  return new AccountApi((route, payload, timeoutMs) =>
    postGateway(route, payload, {
      timeoutMs: remainingTimeoutMs(deadlineAtMs, timeoutMs),
      deadlineAtMs,
    }),
  );
}

function phones(bindings: readonly AccountBinding[], source: BindingSource): string[] {
  return bindings
    .filter((binding) => binding.source === source)
    .map((binding) => binding.phone);
}

export async function sendAccountCode(
  source: BindingSource,
  phone: string,
  deadlineAtMs?: number,
): Promise<void> {
  requireScriptSource(source);
  await accountApi(deadlineAtMs).sendCode({
    source: SCRIPT_BINDING_SOURCE,
    identity: loadAccountIdentity(SCRIPT_BINDING_SOURCE),
    phone,
  });
}

export async function verifyAccountBinding(
  source: BindingSource,
  phone: string,
  code: string,
  deadlineAtMs?: number,
): Promise<void> {
  requireScriptSource(source);
  await accountApi(deadlineAtMs).bind({
    source: SCRIPT_BINDING_SOURCE,
    identity: loadAccountIdentity(SCRIPT_BINDING_SOURCE),
    phone,
    code,
  });
}

function detailRecord(
  parcel: AccountParcelDto,
  matchedPhone: string,
): AccountDetailRecord {
  return {
    waybill: parcel.ownerId,
    companyCode: parcel.courierCode,
    name: parcel.companyName,
    provider: parcel.sourceProvider,
    stateNumber: Number(parcel.sourceStateCode) || 0,
    updateTime: parcel.latestTimeText,
    phone: matchedPhone,
    channel: "1",
  };
}

export async function fetchAccountParcels(
  source: BindingSource,
  bindings: readonly AccountBinding[],
  deadlineAtMs?: number,
): Promise<AccountParcelFetchResult> {
  requireScriptSource(source);
  const listDeadlineAtMs = accountChildDeadline(
    deadlineAtMs,
    ACCOUNT_LIST_BUDGET_MS,
    ACCOUNT_FOLLOWUP_RESERVE_MS,
  );
  assertWithinDeadline(listDeadlineAtMs);
  const boundPhones = phones(bindings, source);
  if (!boundPhones.length) {
    return { parcels: [], rawRecords: 0, rejectedRecords: 0 };
  }
  const response = await accountApi(listDeadlineAtMs).sync({
    source: SCRIPT_BINDING_SOURCE,
    identity: loadAccountIdentity(SCRIPT_BINDING_SOURCE),
    phones: boundPhones,
  });
  const parsed = parseAccountSyncResult(SCRIPT_BINDING_SOURCE, response);
  return {
    parcels: parsed.parcels,
    rawRecords: parsed.rawRecords,
    rejectedRecords: parsed.rejectedRecords,
  };
}

export async function queryAccountManual(
  source: BindingSource,
  waybill: string,
  deadlineAtMs?: number,
): Promise<AccountParcelDto | null> {
  requireScriptSource(source);
  assertWithinDeadline(deadlineAtMs);
  const api = accountApi(deadlineAtMs);
  const response = await api.timeline({
    source: SCRIPT_MANUAL_QUERY_SOURCE,
    mode: "manual",
    waybill,
    clientVersion: SCRIPT_CLIENT_VERSION,
    clientBuild: SCRIPT_CLIENT_BUILD,
  });
  return parseAccountTimelineResponse(
    SCRIPT_MANUAL_QUERY_SOURCE,
    response,
    { waybill },
  );
}

export async function refreshAccountParcel(
  shipment: Shipment,
  deadlineAtMs?: number,
): Promise<AccountParcelDto | null> {
  const source = shipment.identity.bindingSource;
  if (!source || shipment.identity.manuallyAdded) return null;
  requireScriptSource(source);
  if (!shipment.accountRecord) return null;
  assertWithinDeadline(deadlineAtMs);
  const api = accountApi(deadlineAtMs);
  const response = await api.timeline({
    source: SCRIPT_BINDING_SOURCE,
    mode: "detail",
    identity: loadAccountIdentity(SCRIPT_BINDING_SOURCE),
    record: shipment.accountRecord,
  });
  return parseAccountTimelineResponse(SCRIPT_BINDING_SOURCE, response, {
    waybill: shipment.identity.sourceId,
    waybillAliases: normalizedProjectedWaybill(shipment.identity)
      ? [normalizedProjectedWaybill(shipment.identity)]
      : [],
    courierCode: shipment.identity.courierCode,
    companyName: shipment.identity.companyName,
    provider: shipment.identity.sourceProvider,
    phone: shipment.identity.phone,
  });
}

function trustedRouteKind(
  parcel: AccountParcelDto,
): ShipmentRoute["kind"] | null {
  if (!parcel.routeUrl) return null;
  try {
    const host = new URL(parcel.routeUrl).hostname.toLowerCase();
    if (
      host === "cainiao.com" ||
      host.endsWith(".cainiao.com") ||
      host === "taobao.com" ||
      host.endsWith(".taobao.com")
    ) {
      return "cainiao";
    }
  } catch {
    return null;
  }
  return null;
}

function fullPhone(
  parcel: AccountParcelDto,
  boundPhones: readonly string[],
): string {
  const matched = matchBoundPhone(parcel, boundPhones);
  if (matched) return matched;
  const hasEvidence = [parcel.receiverPhone, parcel.senderPhone]
    .map(normalizePhoneEvidence)
    .some((value) => value.length >= 4);
  return !hasEvidence && boundPhones.length === 1 ? boundPhones[0] : "";
}

export function parcelToShipment(
  parcel: AccountParcelDto,
  boundPhones: readonly string[],
  now = Date.now(),
): Shipment | null {
  const ownerId = normalizeWaybill(parcel.ownerId);
  const displayWaybill = normalizeWaybill(parcel.waybill);
  if (!ownerId || !displayWaybill) return null;
  const associatedPhone = fullPhone(parcel, boundPhones);
  if (!associatedPhone) return null;
  const tracks: TrackNode[] = parcel.tracks
    .map((track) => ({
      timeText: track.timeText,
      timeMs: parseProviderTime(track.timeText),
      detail: track.detail,
      statusCode: track.statusCode,
      raw: track.statusCode ? { statusCode: track.statusCode } : {},
    }))
    .filter((track) => Boolean(track.detail));
  const latest = tracks.find((track) => track.timeMs != null) || tracks[0];
  const unprojectedOrder = parcel.accountOrder && displayWaybill === ownerId;
  let semantic = parcel.semantic as StatusSemantic;
  if (semantic === "UNKNOWN" && latest) {
    semantic = semanticFromText(latest.detail);
  }
  const routeKind = trustedRouteKind(parcel);
  const projectedPresentation = parcel.accountOrder && !unprojectedOrder
    ? projectedCarrierPresentation(
        displayWaybill,
        parcel.courierCode,
        parcel.companyName,
      )
    : null;
  const courierCode = projectedPresentation?.courierCode || parcel.courierCode;
  const companyName = unprojectedOrder
    ? "京东购物"
    : projectedPresentation?.companyName || parcel.companyName || courierCode || "快递";
  const timeline = {
    provider: parcel.source,
    waybill: displayWaybill,
    courierCode,
    companyName,
    semantic,
    statusEventAtMs: latest?.timeMs || parseProviderTime(parcel.latestTimeText),
    latestTimeText: latest?.timeText || parcel.latestTimeText,
    latestDetail: latest?.detail || parcel.latestDetail,
    tracks,
    successAtMs: now,
  } satisfies Shipment["timeline"];
  return {
    identity: {
      id: `${parcel.source}:account:${ownerId}`,
      bindingSource: parcel.source,
      sourceOwner: parcel.accountOrder ? `${parcel.source}:order` : parcel.source,
      sourceId: ownerId,
      phoneTail: associatedPhone.slice(-4),
      phone: associatedPhone,
      courierCode,
      companyName,
      sourceProvider: parcel.sourceProvider,
      orderId: parcel.accountOrder ? parcel.orderId || ownerId : "",
      projectedWaybill: parcel.accountOrder && !unprojectedOrder
        ? displayWaybill
        : "",
      accountOrder: parcel.accountOrder,
      manuallyAdded: false,
      createdAtMs: now,
    },
    timeline,
    sourceTimeline: timeline,
    manualTimelines: [],
    route: routeKind ? { kind: routeKind, source: parcel.source } : null,
    accountRecord: detailRecord(parcel, associatedPhone),
    updatedAtMs: now,
  };
}

export function parcelToManualShipment(
  parcel: AccountParcelDto,
  phoneTail: string,
  now = Date.now(),
  bindingSource: BindingSource = SCRIPT_BINDING_SOURCE,
): Shipment | null {
  requireScriptSource(bindingSource);
  const waybill = normalizeWaybill(parcel.waybill || parcel.ownerId);
  if (!waybill) return null;
  const tracks: TrackNode[] = parcel.tracks
    .map((track) => ({
      timeText: track.timeText,
      timeMs: parseProviderTime(track.timeText),
      detail: track.detail,
      statusCode: track.statusCode,
      raw: track.statusCode ? { statusCode: track.statusCode } : {},
    }))
    .filter((track) => Boolean(track.detail));
  const latest = tracks.find((track) => track.timeMs != null) || tracks[0];
  let semantic = parcel.semantic as StatusSemantic;
  if (semantic === "UNKNOWN" && latest) semantic = semanticFromText(latest.detail);
  const companyName = parcel.companyName || parcel.courierCode || "快递";
  const routeKind = trustedRouteKind(parcel);
  const timeline = {
    provider: parcel.source,
    waybill,
    courierCode: parcel.courierCode,
    companyName,
    semantic,
    statusEventAtMs: latest?.timeMs || parseProviderTime(parcel.latestTimeText),
    latestTimeText: latest?.timeText || parcel.latestTimeText,
    latestDetail: latest?.detail || parcel.latestDetail,
    tracks,
    successAtMs: now,
  } satisfies Shipment["timeline"];
  return {
    identity: {
      id: `${bindingSource}:manual:${waybill}`,
      bindingSource,
      sourceOwner: "manual",
      sourceId: waybill,
      phoneTail: String(phoneTail || "").slice(-4),
      courierCode: parcel.courierCode,
      companyName,
      sourceProvider: parcel.sourceProvider,
      accountOrder: false,
      manuallyAdded: true,
      createdAtMs: now,
    },
    timeline,
    sourceTimeline: null,
    manualTimelines: [timeline],
    route: routeKind ? { kind: routeKind, source: bindingSource } : null,
    accountRecord: null,
    updatedAtMs: now,
  };
}
