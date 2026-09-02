import type { AccountParcelDto } from "./account-parser";
import {
  recognizeNonSyncCarrier,
  type CarrierRecognitionResult,
} from "./carrier-recognition";
import {
  activeCarrierTableVersion,
  resolveCarrierCpCode,
  resolveCarrierQuery,
} from "./carrier-query";
import {
  builtInCarrierPresentation,
  projectedCarrierPresentation,
} from "./carrier-presentation";
import { normalizeWaybill } from "./status";

type Recognizer = typeof recognizeNonSyncCarrier;

export type AccountCarrierNormalizationOptions = Readonly<{
  deadlineAtMs?: number;
  signal?: AbortSignal;
  recognize?: Recognizer;
}>;

export function hasBuiltInAccountCarrierName(value: string): boolean {
  return builtInCarrierPresentation(value) != null;
}

function realWaybill(parcel: AccountParcelDto): string {
  const waybill = normalizeWaybill(parcel.waybill || parcel.ownerId);
  const ownerId = normalizeWaybill(parcel.ownerId);
  if (!waybill || (parcel.accountOrder && waybill === ownerId)) return "";
  return waybill;
}

function directPresentation(parcel: AccountParcelDto): AccountParcelDto | null {
  const rawCode = parcel.rawCourierCode
    ? resolveCarrierCpCode(parcel.rawCourierCode)
    : null;
  if (!rawCode && parcel.carrierNormalization?.isBuiltIn) return parcel;
  const code = rawCode || resolveCarrierQuery(parcel.courierCode);
  const name = builtInCarrierPresentation(parcel.companyName);
  const carrier = code || (name ? resolveCarrierQuery(name.courierCode) : null);
  if (!carrier) return null;
  const presentation = projectedCarrierPresentation(
    parcel.waybill,
    carrier.standardCode,
    parcel.companyName || carrier.displayName,
  );
  const displayName = presentation.companyName || carrier.displayName;
  return {
    ...parcel,
    courierCode: carrier.standardCode,
    companyName: displayName,
    carrierNormalization: {
      standardCode: carrier.standardCode,
      displayName,
      kuaidi100Code: carrier.kuaidi100Code,
      isBuiltIn: true,
      tableVersion: activeCarrierTableVersion(),
    },
  };
}

function applyRecognition(
  parcel: AccountParcelDto,
  recognition: CarrierRecognitionResult,
): AccountParcelDto {
  const carrier = recognition.normalization;
  return carrier?.isBuiltIn
    ? {
        ...parcel,
        courierCode: carrier.standardCode,
        companyName: carrier.displayName,
        carrierNormalization: carrier,
      }
    : parcel;
}

/** Resolves display-only carrier identity without changing source or raw fields. */
export async function normalizeAccountParcelCarrier(
  parcel: AccountParcelDto,
  options: AccountCarrierNormalizationOptions = {},
): Promise<AccountParcelDto> {
  const waybill = realWaybill(parcel);
  if (!waybill) return parcel;
  const direct = directPresentation(parcel);
  if (direct) return direct;
  const recognition = await (options.recognize || recognizeNonSyncCarrier)(
    waybill,
    { deadlineAtMs: options.deadlineAtMs, signal: options.signal },
  );
  return applyRecognition(parcel, recognition);
}

export const normalizeNonSyncAccountParcel = normalizeAccountParcelCarrier;
