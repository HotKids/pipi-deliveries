import type { AbortSignal } from "scripting";
import { postGateway } from "./gateway";
import type { CloudPddParcel } from "./platform-parcel-merge";
import { asPlainObject, cleanString, cloudRecordTime } from "./value-guards";

const WAYBILL = /^[A-Z0-9]{6,64}$/;
const RECORD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/**
 * A page anchor on this device's clock (fourth external review R4-NEW-06, owner 2026-11-23「报告里的都直接做」). The
 * Worker lists only anchors at or before its own clock, so one up to the tolerance ahead of this clock reads as now;
 * `null` skips an entry further ahead, and 0 is an invalid anchor (`cloudRecordTime`, shared with parcel metadata).
 */
const cloudAnchorAt = cloudRecordTime;

/**
 * A terminal time on this device's clock, read with the same `cloudRecordTime` (fifth review follow-up, owner 2026-11-25
 * 「也用同一个函数（推荐）」): up to the tolerance ahead reads as now; further ahead, missing or non-positive is 0.
 */
function cloudTerminalAt(value: unknown, now: number): number {
  return cloudRecordTime(value, now) ?? 0;
}

export async function readCloudPddParcels(signal: AbortSignal, deadlineAtMs: number): Promise<CloudPddParcel[]> {
  const parcels: CloudPddParcel[] = [];
  let after: string | null = null;
  do {
    const page: Record<string, unknown> = await postGateway("/api/cloud-records/pdd-shipments",
      { schemaVersion: 1, ...(after ? { after } : {}) }, { signal, deadlineAtMs });
    const read = parseCloudPddShipmentPage(page, after, Date.now());
    parcels.push(...read.parcels);
    after = read.nextAfter;
  } while (after);
  return parcels;
}

/**
 * One page of `pdd-shipments`. Its `parcels` are PDD express records (imports); its optional `pddLinks` (third
 * external review C-03, owner 2026-11-23) are the PDD links Pipi exports for automatic rows, read as `markOnly`
 * entries: a source mark for an existing same-lifecycle row, never an import.
 */
export function parseCloudPddShipmentPage(page: Record<string, unknown>, after: string | null, now: number):
  { parcels: CloudPddParcel[]; nextAfter: string | null } {
  if (page.ok !== true || !Array.isArray(page.parcels) || page.parcels.length > 100 ||
    Object.hasOwn(page, "pddLinks") && (!Array.isArray(page.pddLinks) || page.pddLinks.length > 100) ||
    !(page.nextAfter === null || typeof page.nextAfter === "string" && RECORD_ID.test(page.nextAfter) &&
      (!after || page.nextAfter > after))) throw new Error("Invalid cloud PDD shipment page");
  const parcels: CloudPddParcel[] = [];
  for (const value of page.parcels) {
    const parcel = asPlainObject(value);
    const waybill = cleanString(parcel.waybill);
    const anchorAt = cloudAnchorAt(parcel.anchorAt, now);
    if (!WAYBILL.test(waybill) || anchorAt === 0) throw new Error("Invalid cloud PDD shipment");
    if (anchorAt === null) continue;
    const phone = cleanString(parcel.phone4);
    parcels.push({ waybill, anchorAt, terminalAt: cloudTerminalAt(parcel.terminalAt, now),
      carrierCode: cleanString(parcel.carrierCode), phone4: /^\d{4}$/.test(phone) ? phone : "" });
  }
  for (const value of Array.isArray(page.pddLinks) ? page.pddLinks : []) {
    const link = asPlainObject(value);
    const waybill = cleanString(link.waybill);
    const anchorAt = cloudAnchorAt(link.anchorAt, now);
    if (!WAYBILL.test(waybill) || anchorAt === 0) throw new Error("Invalid cloud PDD shipment");
    if (anchorAt === null) continue;
    parcels.push({ waybill, anchorAt, terminalAt: cloudTerminalAt(link.terminalAt, now),
      carrierCode: "", phone4: "", markOnly: true });
  }
  return { parcels, nextAfter: page.nextAfter as string | null };
}
