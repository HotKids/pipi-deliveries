import { LiveActivity } from "scripting";
import type { AppState } from "../models";
import { independentPickupContent, parcelActivityContent, withPickupArtwork, type ParcelActivityContent, type ParcelActivityTarget } from "./parcel-pickup";
import { mealCard } from "./meal/cards";
import { completeMeal, readMeals } from "./meal/records";
import { mealCredentialScope } from "./meal/rules";
import { synchronizeMeals } from "./meal/cloud";
import type { ParcelLockScreenStyle } from "./parcel-card-appearance";
import { withSharedFileTransaction } from "./shared-file-transaction";
import { completeCurrentParcelCard, loadState, stateLoadFailure, visibleShipments } from "./storage";

export const PARCEL_ACTIVITY_NAME = "PipiDeliveriesParcelPickup";
const REGISTRY_KEY = "pipi-deliveries.parcel-activity.v1";
export const EMPTY_CONTENT: ParcelActivityContent = { title: "快递实时活动", location: "", code: "" };

export type Receipt = Readonly<{ id: string; linkId?: string; target?: ParcelActivityTarget }>;
export type ParcelActivityRegistry = Readonly<{
  showAll: boolean;
  receipts: Receipt[];
  dismissed: string[];
  lockScreenStyle: ParcelLockScreenStyle;
}>;
export type ParcelActivityState = Omit<ParcelActivityContent, "target" | "expiresAtMs" | "capturedAtMs" | "businessDateKey"> & {
  linkId?: string;
  lockScreenStyle?: ParcelLockScreenStyle;
};
export type ParcelActivityCompletion = { linkId: string; kind: "pickup" | "handoff" | "meal" };

export function parcelActivityRegistry(): ParcelActivityRegistry {
  const saved = Storage.get<ParcelActivityRegistry | Receipt>(REGISTRY_KEY);
  if (saved && "receipts" in saved) {
    const { lockScreenStyle } = saved;
    return { ...saved, lockScreenStyle: lockScreenStyle === "black" || lockScreenStyle === "white" ? lockScreenStyle : "dynamic" };
  }
  return { showAll: false, receipts: saved ? [saved] : [], dismissed: [], lockScreenStyle: "dynamic" };
}

export function saveParcelActivityRegistry(registry: ParcelActivityRegistry): void {
  if (!Storage.set(REGISTRY_KEY, registry)) {
    throw new Error("无法保存实时活动，请稍后重试。");
  }
}

export function parcelForTarget(state: AppState, target: ParcelActivityTarget): ParcelActivityContent | null {
  if ("mealId" in target) {
    const scope = mealCredentialScope();
    return scope === target.mealScope ? mealCard(scope, target.mealId, readMeals(scope), Date.now()) : null;
  }
  if ("recordId" in target) {
    const record = state.pickupCodeRecords?.find((item) => item?.id === target.recordId);
    const card = record && independentPickupContent(record);
    return card ? withPickupArtwork(card, state.pickupArtworkChoices) : null;
  }
  const shipment = visibleShipments(state).find((row) => row.identity.id === target.shipmentId);
  const content = shipment ? parcelActivityContent(shipment) : null;
  if (!content?.target || !("waybill" in content.target)) return null;
  return content.target.waybill === target.waybill &&
    content.target.waybillGeneration === target.waybillGeneration ? withPickupArtwork(content, state.pickupArtworkChoices) : null;
}

export async function endActivity(id: string): Promise<void> {
  const activity = await LiveActivity.from<ParcelActivityState>(id, PARCEL_ACTIVITY_NAME);
  if (await activity?.end(EMPTY_CONTENT, { dismissTimeInterval: 0 })) return;
  const state = await LiveActivity.getActivityState(id);
  if (state === "active" || state === "stale") {
    throw new Error("实时活动结束失败，请稍后重试。");
  }
}

export async function completeParcelActivity(params: ParcelActivityCompletion): Promise<void> {
  if (typeof params?.linkId !== "string" || !params.linkId ||
    (params.kind !== "pickup" && params.kind !== "handoff" && params.kind !== "meal")) return;
  const { linkId, kind } = params;
  const receipt = parcelActivityRegistry().receipts.find((item) => item.linkId === linkId);
  if (!receipt?.target) return;
  const target = receipt.target;
  const activityState = await LiveActivity.getActivityState(receipt.id);
  if (activityState !== "active" && activityState !== "stale") return;
  const committed = withSharedFileTransaction(() => {
    if (!parcelActivityRegistry().receipts.some((item) => item.id === receipt.id && item.linkId === linkId)) return false;
    const state = loadState();
    if (stateLoadFailure()) throw new Error("本地数据暂不可用，请稍后重试。");
    const card = parcelForTarget(state, target);
    if (card) {
      if ((card.kind ?? "pickup") !== kind) return false;
      if ("mealId" in target) completeMeal(target.mealScope, target.mealId);
      else completeCurrentParcelCard(card);
    }
    return true;
  });
  // The app retires the receipt after observing the end of this activity.
  if (committed) {
    await endActivity(receipt.id);
    if (kind === "meal") await synchronizeMeals(5_000);
  }
}
