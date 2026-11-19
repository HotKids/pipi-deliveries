import { Notification, Path } from "scripting";
import type { AppState, Shipment } from "../models";
import { backgroundHostBootstrap } from "./background-refresh";
import { deadlineAfter, waitForRefresh } from "./deadline";
import { EXPRESS_TOAST_COPY } from "./express-toast-copy";
import { needsManualPhoneTail } from "./jt-h5";
import { flushDiagnostics, writeDiagnostic } from "./logger";
import { detectManualCarrier } from "./manual-query";
import { shipmentNotificationPresentation } from "./notification-events";
import { scheduleShipmentNotification } from "./notifications";
import { normalizeRecognizedPickupCode, type ParcelLookup } from "./parcel-code-ocr";
import { parcelActivityContent, type ParcelActivityTarget } from "./parcel-pickup";
import { isParcelWaybill } from "./parcel-waybill-ocr";
import { displayWaybill, selectShipmentTimeline } from "./shipment-policy";
import { listHeadline, normalizeWaybill } from "./status";
import { loadState, saveRecognizedShipmentPickup, visibleShipments } from "./storage";
import { commitManualShipmentPreview, continueManualShipmentPreview, queryManualShipmentPreview } from "./sync";
import { MANUAL_QUERY_BUDGET_MS } from "./sync/shared";
import { manualQueryFailureToast } from "./ui-feedback";

export const PARCEL_SHORTCUT_PARAMETER = "parcelDraft";
export const PARCEL_SHORTCUT_RECORD_PARAMETER = "parcelCodeRecord";
export const PICKUP_SHORTCUT_SAVED = "已添加取件码，可在「待取」查看。";

export type ParcelShortcutLookup = ParcelLookup & { draftToken?: string; openOnTap?: boolean };

type ScreenShortcutShipment = { shipment: Shipment; added: boolean };
type ScreenShortcutQueryResult = ScreenShortcutShipment | { shipment: null; needsPhoneTail: boolean };
type PresentPickup = (targets: readonly ParcelActivityTarget[]) => Promise<boolean>;

const SCREEN_DRAFT_MAX_AGE_MS = 5 * 60 * 1000;
const SHORTCUT_NOTIFICATION_BUDGET_MS = 10_000;
const DRAFT_FILE = /^(?:(?:draft|screen|sms)-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.txt$/i;

function isPendingDraft(token: string): boolean {
  return token.startsWith("draft-") || token.startsWith("screen-") || token.startsWith("sms-");
}

export function preferShortcutLookup(current: ParcelShortcutLookup | undefined, next: ParcelShortcutLookup | undefined) {
  // A screen recovery draft must not keep a later SMS from its existing confirmation flow.
  if (!current || current.openOnTap && next?.draftToken !== current.draftToken) return next;
  return current;
}

function inbox(): string {
  return Path.join(FileManager.appGroupDocumentsDirectory, "pipi-deliveries", "shortcut-inbox");
}

function removeDraft(path: string): void {
  try {
    FileManager.removeSync(path);
  } catch {
    // Other hosts may already have consumed the file.
  }
}

function parseLookup(value: string): ParcelLookup | undefined {
  const lookup: Partial<ParcelLookup> = JSON.parse(value);
  if (!lookup || typeof lookup.waybill !== "string" || !isParcelWaybill(lookup.waybill) ||
      typeof lookup.capturedAtMs !== "number" || !Number.isSafeInteger(lookup.capturedAtMs) ||
      lookup.capturedAtMs <= 0) return undefined;
  const pickup = lookup.pickup;
  const code = typeof pickup?.code === "string" ? normalizeRecognizedPickupCode(pickup.code) : "";
  const locationName = typeof pickup?.locationName === "string" ? pickup.locationName : undefined;
  return { waybill: lookup.waybill, capturedAtMs: lookup.capturedAtMs, ...(code ? { pickup: { code, locationName } } : {}) };
}

export function stageShortcutLookup(lookup: ParcelLookup, origin: "draft" | "screen" = "draft"): string {
  if (!isParcelWaybill(lookup.waybill)) throw new Error("Invalid parcel shortcut draft");
  const directory = inbox();
  FileManager.createDirectorySync(directory, true);
  const token = `${origin}-${UUID.string()}.txt`;
  const path = Path.join(directory, token);
  const writing = path + ".writing";
  try {
    FileManager.writeAsStringSync(writing, JSON.stringify(lookup));
    FileManager.renameSync(writing, path);
  } finally {
    removeDraft(writing);
  }
  return token;
}

export function discardShortcutDraft(token: string): void {
  if (DRAFT_FILE.test(token)) removeDraft(Path.join(inbox(), token));
}

export function takeScreenShortcutLookup(parameters: Readonly<Record<string, unknown>>): ParcelShortcutLookup | undefined {
  const token = parameters[PARCEL_SHORTCUT_PARAMETER];
  if (typeof token !== "string" || isPendingDraft(token) || !DRAFT_FILE.test(token)) return undefined;
  const path = Path.join(inbox(), token);
  const claimed = path + ".claimed";
  try {
    // The same-directory move claims the draft before another script host can read it.
    FileManager.renameSync(path, claimed);
  } catch {
    return undefined;
  }
  try {
    const capturedAtMs = FileManager.statSync(claimed).modificationDate;
    if (Date.now() - capturedAtMs > SCREEN_DRAFT_MAX_AGE_MS) return undefined;
    const content = FileManager.readAsStringSync(claimed);
    return isParcelWaybill(content) ? { waybill: content, capturedAtMs } : parseLookup(content);
  } catch {
    return undefined;
  } finally {
    removeDraft(claimed);
  }
}

export function nextShortcutLookup(): ParcelShortcutLookup | undefined {
  const directory = inbox();
  let paths: string[];
  try {
    if (!FileManager.existsSync(directory)) return undefined;
    paths = FileManager.readDirectorySync(directory);
  } catch {
    return undefined;
  }
  let next: ParcelShortcutLookup | undefined;
  for (const path of paths) {
    const token = Path.basename(path);
    const file = Path.join(directory, token);
    if (!isPendingDraft(token)) {
      if (!DRAFT_FILE.test(token.replace(/\.(?:claimed|writing)$/, ""))) continue;
      try {
        // Only older foreground Shortcut versions wrote expiring, unprefixed tokens.
        if (Date.now() - FileManager.statSync(file).modificationDate > SCREEN_DRAFT_MAX_AGE_MS) removeDraft(file);
      } catch {
        // A foreground launch may have claimed it while listing the directory.
      }
      continue;
    }
    if (!DRAFT_FILE.test(token)) continue;
    try {
      const lookup = parseLookup(FileManager.readAsStringSync(file));
      if (!lookup) continue;
      const openOnTap = token.startsWith("screen-");
      if (!next || (next.openOnTap && !openOnTap) ||
          (Boolean(next.openOnTap) === openOnTap && lookup.capturedAtMs < next.capturedAtMs)) {
        next = { ...lookup, draftToken: token, ...(openOnTap ? { openOnTap: true } : {}) };
      }
    } catch {
      // Another host can acknowledge a draft while this one is enumerating.
    }
  }
  return next;
}

export function readScreenShortcutLookup(token: unknown): ParcelLookup | undefined {
  if (typeof token !== "string" || !token.startsWith("screen-") || !DRAFT_FILE.test(token)) return undefined;
  try {
    return parseLookup(FileManager.readAsStringSync(Path.join(inbox(), token)));
  } catch {
    return undefined;
  }
}

export async function queryScreenShortcut(lookup: ParcelLookup, phoneTail?: string): Promise<ScreenShortcutQueryResult> {
  const waybill = normalizeWaybill(lookup.waybill);
  const find = (state: AppState) => visibleShipments(state).find(shipment => displayWaybill(shipment) === waybill);
  backgroundHostBootstrap();
  const base = loadState();
  const existing = find(base);
  if (existing) {
    const shipment = lookup.pickup ? find(saveRecognizedShipmentPickup(existing, lookup)) || existing : existing;
    return { shipment, added: false };
  }

  const deadlineAtMs = deadlineAfter(MANUAL_QUERY_BUDGET_MS);
  const savedTail = base.pendingQueries.find(pending => pending.source === base.activeSource &&
    normalizeWaybill(pending.waybill) === waybill)?.phoneTail;
  const queryTail = phoneTail ?? savedTail;
  const presentation = await detectManualCarrier(waybill, { deadlineAtMs }).catch(() => null);
  const preview = await queryManualShipmentPreview({ waybill, phoneTail: queryTail, presentation, deadlineAtMs });
  let state = commitManualShipmentPreview(preview, Date.now(), lookup);
  let needsPhoneTail = !queryTail && presentation?.requiresPhoneTail === true;
  if (preview.roundComplete === false && preview.pending && preview.shipment) {
    const round = await continueManualShipmentPreview(preview, { backgroundHostSafe: true, deadlineAtMs, lookup });
    state = round.state;
    needsPhoneTail ||= round.expressToast === "manualPhoneTailRequired";
  }
  const shipment = find(state);
  return shipment ? { shipment, added: preview.commitBase?.shipment === null } : { shipment: null, needsPhoneTail };
}

async function sendScreenNotification(send: (deadlineAtMs: number) => Promise<boolean>): Promise<boolean> {
  try {
    if (await send(deadlineAfter(SHORTCUT_NOTIFICATION_BUDGET_MS))) return true;
  } catch {
    // The result is still available to the caller if the notification cannot be queued.
  }
  try { writeDiagnostic("shortcut.notification.failed", {}, "warning"); } catch { /* Diagnostics are optional. */ }
  return false;
}

export function scheduleScreenShortcutStatus(message: string, phoneTailDraft?: string): Promise<boolean> {
  return sendScreenNotification(deadlineAtMs => waitForRefresh(Notification.schedule({
    title: "截屏识别",
    body: message,
    tapAction: "none",
    ...(phoneTailDraft ? { customUI: true, userInfo: { screenShortcutDraft: phoneTailDraft } } : {}),
  }), deadlineAtMs));
}

export async function notifyScreenShortcutStatus(message: string, phoneTailDraft?: string): Promise<string> {
  await scheduleScreenShortcutStatus(message, phoneTailDraft);
  return message;
}

async function notifyScreenShipment(
  { shipment, added }: ScreenShortcutShipment,
  pickup?: { code: string; present: PresentPickup },
): Promise<string> {
  const card = pickup && parcelActivityContent(shipment);
  const target = card?.code === pickup?.code ? card?.target : undefined;
  const activityShown = Boolean(target && pickup && await pickup.present([target]));
  const latest = listHeadline(selectShipmentTimeline(shipment), true);
  if (!latest) return activityShown ? PICKUP_SHORTCUT_SAVED :
    notifyScreenShortcutStatus(target ? PICKUP_SHORTCUT_SAVED : EXPRESS_TOAST_COPY.manualQueryNoTrack);
  const event = shipmentNotificationPresentation(shipment);
  const title = added ? `已添加 ${event.title}` : event.title;
  const body = latest.detail;
  if (!activityShown) {
    await sendScreenNotification(deadlineAtMs => scheduleShipmentNotification({ ...event, title, body }, deadlineAtMs));
  }
  return `${title}\n${body}`;
}

export async function submitScreenShortcut(lookup: ParcelLookup, presentPickup: PresentPickup): Promise<string> {
  let needsPhoneTail = false;
  let message: string = EXPRESS_TOAST_COPY.manualQueryNoTrack;
  try {
    const result = await queryScreenShortcut(lookup);
    if (result.shipment) return notifyScreenShipment(result, lookup.pickup ? { code: lookup.pickup.code, present: presentPickup } : undefined);
    needsPhoneTail = result.needsPhoneTail;
  } catch (error) {
    needsPhoneTail = needsManualPhoneTail(error);
    message = manualQueryFailureToast(error);
  }
  const token = stageShortcutLookup(lookup, "screen");
  return needsPhoneTail ? notifyScreenShortcutStatus("请长按通知，输入手机号后 4 位。", token) :
    notifyScreenShortcutStatus(message);
}

export async function submitScreenShortcutPhoneTail(token: string, phoneTail: string): Promise<{
  done: boolean; message: string;
}> {
  if (!/^\d{4}$/.test(phoneTail)) return { done: false, message: "请输入 4 位手机尾号" };
  const lookup = readScreenShortcutLookup(token);
  if (!lookup) return { done: true, message: "此运单已处理。" };
  const startedAt = Date.now();
  try { writeDiagnostic("shortcut.phone_tail.started"); } catch { /* Diagnostics are optional. */ }
  try {
    const result = await queryScreenShortcut(lookup, phoneTail);
    if (!result.shipment) return { done: false, message: result.needsPhoneTail
      ? EXPRESS_TOAST_COPY.manualPhoneTailRequired : EXPRESS_TOAST_COPY.manualQueryNoTrack };
    discardShortcutDraft(token);
    return { done: true, message: await notifyScreenShipment(result) };
  } catch (error) {
    return { done: false, message: needsManualPhoneTail(error)
      ? EXPRESS_TOAST_COPY.manualPhoneTailRequired : manualQueryFailureToast(error) };
  } finally {
    try {
      writeDiagnostic("shortcut.phone_tail.completed", { durationMs: Date.now() - startedAt });
      flushDiagnostics();
    } catch { /* Diagnostics are optional. */ }
  }
}
