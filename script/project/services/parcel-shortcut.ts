import { Path } from "scripting";
import { normalizeRecognizedPickupCode, type ParcelLookup } from "./parcel-code-ocr";
import { isParcelWaybill } from "./parcel-waybill-ocr";

export const PARCEL_SHORTCUT_PARAMETER = "parcelDraft";
export const PARCEL_SHORTCUT_RECORD_PARAMETER = "parcelCodeRecord";

export type ParcelShortcutLookup = ParcelLookup & { smsDraft?: string };

const SCREEN_DRAFT_MAX_AGE_MS = 5 * 60 * 1000;
const DRAFT_FILE = /^(?:sms-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.txt$/i;

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

export function stageShortcutLookup(lookup: ParcelLookup, origin: "screen" | "sms"): string {
  if (!isParcelWaybill(lookup.waybill)) throw new Error("Invalid parcel shortcut draft");
  const directory = inbox();
  FileManager.createDirectorySync(directory, true);
  if (origin === "screen") {
    for (const path of FileManager.readDirectorySync(directory)) {
      const name = Path.basename(path);
      if (name.startsWith("sms-") || !DRAFT_FILE.test(name.replace(/\.(?:claimed|writing)$/, ""))) continue;
      const draft = Path.join(directory, name);
      try {
        if (Date.now() - FileManager.statSync(draft).modificationDate > SCREEN_DRAFT_MAX_AGE_MS) removeDraft(draft);
      } catch {
        // Another host may have consumed the draft during the scan.
      }
    }
  }

  const token = (origin === "sms" ? "sms-" : "") + UUID.string() + ".txt";
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
  if (typeof token !== "string" || token.startsWith("sms-") || !DRAFT_FILE.test(token)) return undefined;
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

export function nextSmsShortcutLookup(): ParcelShortcutLookup | undefined {
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
    if (!token.startsWith("sms-") || !DRAFT_FILE.test(token)) continue;
    try {
      const lookup = parseLookup(FileManager.readAsStringSync(Path.join(directory, token)));
      if (lookup && (!next || lookup.capturedAtMs < next.capturedAtMs)) next = { ...lookup, smsDraft: token };
    } catch {
      // Another host can acknowledge an SMS draft while this one is enumerating.
    }
  }
  return next;
}
