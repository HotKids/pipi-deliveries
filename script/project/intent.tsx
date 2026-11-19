import { Intent, Script } from "scripting";
import { refreshIntentMessage } from "./services/refresh-result";
import { refreshAllShipments } from "./services/sync";
import { backgroundHostBootstrap, backgroundRefreshOptions } from "./services/background-refresh";
import { flushDiagnostics, writeDiagnostic } from "./services/logger";
import { discardShortcutDraft, notifyScreenShortcutStatus, PICKUP_SHORTCUT_SAVED, scheduleScreenShortcutStatus, stageShortcutLookup, submitScreenShortcut } from "./services/parcel-shortcut";
import { normalizeRecognizedPickupCode, recognizeParcelCodes, type ParcelLookup } from "./services/parcel-code-ocr";
import { showShortcutPickupActivities } from "./services/parcel-live-activity";
import type { ParcelActivityTarget } from "./services/parcel-pickup";
import { isParcelWaybill, parcelImageRows, parcelTextRows, type ParcelRow } from "./services/parcel-waybill-ocr";
import { saveRecognizedParcelCode } from "./services/storage";
import { ensureMealRules } from "./services/carrier-authority";
import { mealFromModel, onlineMealRequiresQR, recognizeMealImage } from "./services/meal/recognize";
import { putMealObservations, stageLuckinDraft } from "./services/meal/records";
import { mealCredentialScope } from "./services/meal/rules";
import { synchronizeMeals } from "./services/meal/cloud";
import { normalizeWaybill } from "./services/status";
import { ONLINE_BUDGET_MS, requestOnlineRecognition } from "./services/recognition/client";
import { recognitionOperation } from "./services/recognition/settings";
import { waitForRefresh } from "./services/deadline";
import { LUCKIN_RESCAN } from "./services/shortcut-capture";

function shortcutImagePath(value: string): string | undefined {
  let path = value;
  if (value.startsWith("file://")) {
    try {
      const url = new URL(value);
      if (url.hostname || url.search || url.hash) return undefined;
      path = decodeURIComponent(url.pathname);
    } catch {
      return undefined;
    }
  }
  return path.length > 1 && path.startsWith("/") && !path.startsWith("//") && !path.includes("\0")
    ? path
    : undefined;
}

type ScreenResult = {
  parcel: ReturnType<typeof recognizeParcelCodes>;
  meals?: { ids: string[]; scope: string };
  draft?: true;
  cancelled?: true;
};

async function notifyShortcutPickup(targets: readonly ParcelActivityTarget[], message: string): Promise<string> {
  return await showShortcutPickupActivities(targets) ? message : notifyScreenShortcutStatus(message);
}

function modelParcel(fields: Record<string, unknown>, capturedAtMs: number): ParcelLookup | undefined {
  const waybill = typeof fields.waybill === "string" ? normalizeWaybill(fields.waybill) : "";
  if (!isParcelWaybill(waybill)) return undefined;
  const code = typeof fields.pickupCode === "string" ? normalizeRecognizedPickupCode(fields.pickupCode) : "";
  const locationName = typeof fields.pickupLocation === "string" ? fields.pickupLocation.trim() : "";
  return { waybill, capturedAtMs, ...(code ? { pickup: { code, ...(locationName ? { locationName } : {}) } } : {}) };
}

async function recognizeShortcutImage(image: UIImage, capturedAtMs: number): Promise<ScreenResult> {
  const operation = recognitionOperation();
  const deadline = capturedAtMs + 45_000;
  const none = { parcel: {} };
  const isCurrent = () => operation.isCurrent() && Date.now() < deadline;
  const scope = mealCredentialScope();
  let onlineQR: Record<string, unknown> | undefined;
  if (operation.mode === "online") {
    const onlineDeadline = Math.min(deadline - 20_000, Date.now() + ONLINE_BUDGET_MS);
    try {
      const result = operation.config ? await requestOnlineRecognition(operation.config, image, onlineDeadline) : null;
      if (!isCurrent()) return { ...none, cancelled: true };
      if (result?.family === "express" && Date.now() < onlineDeadline) {
        const lookup = modelParcel(result.fields, capturedAtMs);
        if (lookup) return { parcel: { lookup } };
      }
      if (result?.family === "pickup" && scope && mealCredentialScope() === scope) {
        const rules = await waitForRefresh(ensureMealRules(), onlineDeadline);
        if (!isCurrent()) return { ...none, cancelled: true };
        if (rules && mealCredentialScope() === scope && Date.now() < onlineDeadline) {
          if (onlineMealRequiresQR(result.fields, rules)) onlineQR = result.fields;
          else {
            const meal = mealFromModel(result.fields, capturedAtMs, rules);
            if (meal) return { ...none, meals: { ids: putMealObservations(scope, [meal], false), scope } };
          }
        }
      }
      if (!onlineQR) writeDiagnostic("recognition.online.fallback", { result: operation.config ? "no_match" : "configuration" });
    } catch {
      writeDiagnostic("recognition.online.fallback", { result: "unavailable" });
    }
  }
  if (!isCurrent()) return { ...none, cancelled: true };
  const recognized = await waitForRefresh(Vision.recognizeText(image, {
    recognitionLanguages: ["zh-Hans", "en"],
    recognitionLevel: "accurate",
    usesLanguageCorrection: false,
  }), deadline);
  if (!isCurrent()) return { ...none, cancelled: true };
  const width = image.width * image.scale, height = image.height * image.scale;
  const rows = parcelImageRows(recognized.candidates, width, height);
  const parcel = recognizeParcelCodes(rows, capturedAtMs);
  if (parcel.lookup || parcel.independent || !recognized.candidates.length || !scope || mealCredentialScope() !== scope) return { parcel };
  const rules = await waitForRefresh(ensureMealRules(), deadline);
  if (!rules) return { parcel };
  const meal = await waitForRefresh(recognizeMealImage(image, recognized.candidates, capturedAtMs, rules, onlineQR), deadline);
  if (!isCurrent() || mealCredentialScope() !== scope) return { ...none, cancelled: true };
  if (meal.draft) {
    stageLuckinDraft(scope, meal.draft);
    return { parcel, draft: true };
  }
  if (!meal.meals.length) return { parcel };
  return { parcel, meals: { ids: putMealObservations(scope, meal.meals, true), scope } };
}

async function recognizeShortcutParcel(parameter: NonNullable<typeof Intent.shortcutParameter>, automaticRescan: boolean): Promise<string> {
  const capturedAtMs = Date.now();
  let rows: ParcelRow[] = [];
  let imageParcel: ReturnType<typeof recognizeParcelCodes> | undefined;
  if (parameter.type === "text") {
    rows = parcelTextRows(parameter.value);
  } else if (parameter.type === "fileURL") {
    const path = shortcutImagePath(parameter.value);
    const image = path ? UIImage.fromFile(path) : null;
    if (!image) {
      return notifyScreenShortcutStatus("无法读取当前屏幕的截屏，请重新运行指令。");
    }
    const { parcel, meals, draft, cancelled } = await recognizeShortcutImage(image, capturedAtMs);
    if (cancelled) return "识别已取消，请重新运行。";
    if (draft) {
      const manual = "已识别瑞幸订单，请打开取餐码再运行一次截屏识别。";
      if (!automaticRescan) return notifyScreenShortcutStatus(manual);
      const scheduled = await scheduleScreenShortcutStatus("已识别瑞幸订单，请在 3 秒内打开“取餐码”");
      return scheduled ? LUCKIN_RESCAN : manual;
    }
    if (meals?.ids.length) {
      const message = await notifyShortcutPickup(meals.ids.map(mealId => ({ mealId, mealScope: meals.scope })),
        `已添加 ${meals.ids.length} 张取餐码，可在「待取」查看。`);
      await synchronizeMeals(5_000);
      return message;
    }
    imageParcel = parcel;
  } else {
    return "请传入当前屏幕的截屏或短信正文。";
  }

  const { lookup, independent } = imageParcel ?? recognizeParcelCodes(rows, capturedAtMs);
  if (!lookup && !independent) {
    const message = "未识别到明确的运单号、取件码或寄件码。";
    return parameter.type === "fileURL" ? notifyScreenShortcutStatus("未识别到明确的取餐码、运单号、取件码或寄件码。") : message;
  }
  const token = lookup && parameter.type === "text" ? stageShortcutLookup(lookup) : "";
  const record = independent ? { ...independent, id: UUID.string() } : undefined;
  try {
    if (record) saveRecognizedParcelCode(record);
  } catch (error) {
    if (token) discardShortcutDraft(token);
    throw error;
  }
  if (parameter.type === "fileURL") {
    if (lookup) return submitScreenShortcut(lookup, showShortcutPickupActivities);
    if (record?.kind === "pickup") return notifyShortcutPickup([{ recordId: record.id }], PICKUP_SHORTCUT_SAVED);
  }
  return "已识别快递信息，打开派派助手查看。";
}

async function run() {
  const imagePaths = Intent.imagePathsParameter;
  const paths = imagePaths?.length ? imagePaths : Intent.fileURLsParameter;
  const input = Intent.shortcutParameter;
  const automaticRescan = Intent.textsParameter?.includes(LUCKIN_RESCAN) === true ||
    (input?.type === "text" && input.value === LUCKIN_RESCAN);
  const screenshot = paths?.length === 1
    ? { type: "fileURL" as const, value: paths[0] }
    : undefined;
  const parameter = automaticRescan && input?.type !== "fileURL" && screenshot ? screenshot : input ?? screenshot;
  if (parameter) {
    const screen = parameter.type === "fileURL";
    const startedAt = Date.now();
    if (screen) {
      try { writeDiagnostic("shortcut.screen.started"); } catch { /* Diagnostics are optional. */ }
    }
    let message: string;
    try {
      message = await recognizeShortcutParcel(parameter, automaticRescan);
    } catch {
      message = screen ? "处理截屏识别结果失败，请重试。" : "处理快递识别结果失败，请重试。";
      if (screen) message = await notifyScreenShortcutStatus(message);
    } finally {
      if (screen) try {
        writeDiagnostic("shortcut.screen.completed", { durationMs: Date.now() - startedAt });
        flushDiagnostics();
      } catch { /* Diagnostics are optional. */ }
    }
    Script.exit(Intent.text(message));
    return;
  }
  if (paths?.length || Intent.textsParameter?.length || Intent.urlsParameter?.length) {
    Script.exit(Intent.text("请运行截屏识别指令或短信自动化。"));
    return;
  }

  try {
    backgroundHostBootstrap();
    const summary = await refreshAllShipments(undefined, backgroundRefreshOptions());
    flushDiagnostics();
    Script.exit(Intent.text(refreshIntentMessage(summary)));
  } catch {
    flushDiagnostics();
    Script.exit(Intent.text("快递更新失败，请稍后重试。"));
  }
}

void run();
