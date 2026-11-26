import { LiveActivity } from "scripting";
import type { AppState } from "../models";
import { activePickupCards, independentPickupContent, parcelActivityContent, withPickupArtwork, type ParcelActivityContent, type ParcelActivityTarget } from "./parcel-pickup";
import { activeMealCards, mealCard } from "./meal/cards";
import { completeMeal, readMeals } from "./meal/records";
import { mealCredentialScope } from "./meal/rules";
import { synchronizeMeals } from "./meal/cloud";
import type { ParcelLockScreenStyle } from "./parcel-card-appearance";
import { publishSharedData, sharedData, withSharedFileTransaction } from "./shared-file-transaction";
import { completeCurrentParcelCard, loadState, stateLoadFailure, visibleShipments } from "./storage";
import { beginDiagnosticOperation, writeDiagnostic } from "./logger";

export const PARCEL_ACTIVITY_NAME = "PipiDeliveriesParcelPickup";

/**
 * A failure whose message is written for the user. The Live Activity settings page shows only these messages; a host
 * or storage error keeps its own text out of the page and shows the page's fallback (G-HIGH-18).
 */
export class ParcelActivityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParcelActivityError";
  }
}
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
  previewLinkId?: string;
  lockScreenStyle?: ParcelLockScreenStyle;
};
export type ParcelActivityCompletion = { linkId: string; kind: "pickup" | "handoff" | "meal" | "preview" };

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
    throw new ParcelActivityError("无法保存实时活动，请稍后重试。");
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
    throw new ParcelActivityError("实时活动结束失败，请稍后重试。");
  }
}

export function nativePickupTabCloseId(): string | undefined {
  try {
    const { nativePickupTabClose, stateRef, mealStateRef } = sharedData();
    if (nativePickupTabClose && nativePickupTabClose.stateRef === stateRef &&
        nativePickupTabClose.mealStateRef === mealStateRef) return nativePickupTabClose.activityId;
  } catch { /* A missing hint leaves the app's ordinary grace period in place. */ }
  return undefined;
}

function rememberNativePickupTabClose(id: string, state: AppState, inactivePreviews: ReadonlySet<string>): void {
  if (stateLoadFailure() || activePickupCards(visibleShipments(state), state.pickupCodeRecords).length ||
      activeMealCards().length || parcelActivityRegistry().receipts.some(
        receipt => !receipt.target && receipt.id !== id && !inactivePreviews.has(receipt.id),
      )) return;
  const { stateRef, mealStateRef } = sharedData();
  publishSharedData({ nativePickupTabClose: { activityId: id, stateRef, mealStateRef } });
}

function reportPickupTabHintFailure(): void {
  writeDiagnostic("activity.parcel.tab_close_hint.failed", {}, "warning");
}

export async function completeParcelActivity(params: ParcelActivityCompletion): Promise<void> {
  if (typeof params?.linkId !== "string" || !params.linkId ||
    (params.kind !== "pickup" && params.kind !== "handoff" && params.kind !== "meal" && params.kind !== "preview")) return;
  const finish = beginDiagnosticOperation("activity.parcel.operation", { stage: "action", trigger: params.kind });
  try {
    const outcome = await applyParcelActivityAction(params);
    finish(outcome);
  } catch (error) {
    finish("failed", {}, "warning");
    throw error;
  }
}

async function applyParcelActivityAction(params: ParcelActivityCompletion) {
  const { linkId, kind } = params;
  const receipt = parcelActivityRegistry().receipts.find((item) => item.linkId === linkId);
  if (!receipt) return "stale";
  const activityState = await LiveActivity.getActivityState(receipt.id);
  if (activityState !== "active" && activityState !== "stale") return "not_active";
  const target = receipt.target;
  if (kind === "preview" ? target : !target) return "rejected";
  const inactivePreviews = new Set<string>();
  for (const preview of parcelActivityRegistry().receipts) {
    if (preview.target || preview.id === receipt.id) continue;
    // A preview can end while the app is suspended, leaving its receipt behind.
    const status = await LiveActivity.getActivityState(preview.id).catch(() => "active" as const);
    if (status !== "active" && status !== "stale") inactivePreviews.add(preview.id);
  }
  if (kind === "preview") {
    try {
      withSharedFileTransaction(() => rememberNativePickupTabClose(receipt.id, loadState(), inactivePreviews));
    } catch { reportPickupTabHintFailure(); }
    try {
      await endActivity(receipt.id);
    } catch (error) {
      try {
        withSharedFileTransaction(() => {
          if (sharedData().nativePickupTabClose?.activityId === receipt.id) {
            publishSharedData({ nativePickupTabClose: undefined });
          }
        });
      } catch { reportPickupTabHintFailure(); }
      throw error;
    }
    return "preview_ended";
  }
  if (!target) return "rejected";
  let savedRecord = false;
  const committed = withSharedFileTransaction(() => {
    if (!parcelActivityRegistry().receipts.some((item) => item.id === receipt.id && item.linkId === linkId)) return false;
    const state = loadState();
    if (stateLoadFailure()) throw new ParcelActivityError("本地数据暂不可用，请稍后重试。");
    const card = parcelForTarget(state, target);
    if (card) {
      if ((card.kind ?? "pickup") !== kind) return false;
      const after = "mealId" in target
        ? completeMeal(target.mealScope, target.mealId) ? state : undefined
        : completeCurrentParcelCard(card);
      savedRecord = after !== undefined;
      try {
        if (after) rememberNativePickupTabClose(receipt.id, after, inactivePreviews);
      } catch { reportPickupTabHintFailure(); }
    }
    return true;
  });
  // The app retires the receipt after observing the end of this activity.
  if (committed) {
    await endActivity(receipt.id);
    if (kind === "meal") await synchronizeMeals(5_000);
  }
  return savedRecord ? "committed" : committed ? "dismissed" : "rejected";
}
