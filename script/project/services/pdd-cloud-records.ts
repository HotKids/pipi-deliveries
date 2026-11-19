import type { AbortSignal } from "scripting";
import { postGateway } from "./gateway";
import { beginDiagnosticOperation } from "./logger";
import type { CloudPddParcel } from "./platform-parcel-merge";
import { asPlainObject, cleanString, positiveFiniteTime } from "./value-guards";

const WAYBILL = /^[A-Z0-9]{6,64}$/;
const RECORD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export async function readCloudPddParcels(signal: AbortSignal, deadlineAtMs: number): Promise<CloudPddParcel[]> {
  const finish = beginDiagnosticOperation("cloud.pdd", { sourceProvider: "pinduoduo", stage: "pull" });
  try {
    const parcels = await readCloudPddPages(signal, deadlineAtMs);
    finish("succeeded", { records: parcels.length });
    return parcels;
  } catch (error) {
    if (signal.aborted) finish("cancelled");
    else finish("failed", {}, "warning");
    throw error;
  }
}

async function readCloudPddPages(signal: AbortSignal, deadlineAtMs: number): Promise<CloudPddParcel[]> {
  const parcels: CloudPddParcel[] = [];
  let after: string | null = null;
  do {
    const page: Record<string, unknown> = await postGateway("/api/cloud-records/pdd-shipments",
      { schemaVersion: 1, ...(after ? { after } : {}) }, { signal, deadlineAtMs });
    if (page.ok !== true || !Array.isArray(page.parcels) || page.parcels.length > 100 ||
      !(page.nextAfter === null || typeof page.nextAfter === "string" && RECORD_ID.test(page.nextAfter) &&
        (!after || page.nextAfter > after))) throw new Error("Invalid cloud PDD shipment page");
    const now = Date.now();
    for (const value of page.parcels) {
      const parcel = asPlainObject(value);
      const waybill = cleanString(parcel.waybill);
      const anchorAt = positiveFiniteTime(parcel.anchorAt, now);
      if (!WAYBILL.test(waybill) || !anchorAt) throw new Error("Invalid cloud PDD shipment");
      const phone = cleanString(parcel.phone4);
      parcels.push({ waybill, anchorAt, terminalAt: positiveFiniteTime(parcel.terminalAt, now),
        carrierCode: cleanString(parcel.carrierCode), phone4: /^\d{4}$/.test(phone) ? phone : "" });
    }
    after = page.nextAfter;
  } while (after);
  return parcels;
}
