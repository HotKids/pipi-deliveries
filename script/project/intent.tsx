import { Intent, Script } from "scripting";
import { refreshIntentMessage } from "./services/refresh-result";
import { refreshAllShipments } from "./services/sync";
import { backgroundHostBootstrap, backgroundRefreshOptions } from "./services/background-refresh";
import {
  beginDiagnosticOperation, diagnosticErrorDetails, flushDiagnostics, writeDiagnostic, writeRuntimeCapabilities,
} from "./services/logger";
import { discardShortcutDraft, MEAL_SHORTCUT_RECORD_PARAMETER, notifyScreenPickupSaved, notifyScreenShortcutStatus, PARCEL_SHORTCUT_RECORD_PARAMETER, scheduleScreenShortcutStatus, stageShortcutLookup, submitScreenShortcut } from "./services/parcel-shortcut";
import { normalizeRecognizedPickupCode, recognizeParcelCodes, type ParcelLookup } from "./services/parcel-code-ocr";
import { retireCompletedParcelActivities, showShortcutPickupActivities } from "./services/parcel-live-activity";
import { parcelCardArtwork } from "./services/parcel-card-appearance";
import { independentPickupContent, PLATFORM_ACCOUNT_NAMES } from "./services/parcel-pickup";
import { isParcelWaybill, parcelImageRows, parcelTextRows, type ParcelRow } from "./services/parcel-waybill-ocr";
import { refreshDueWatchShipments, saveRecognizedParcelCode } from "./services/storage";
import { ensureMealRules } from "./services/carrier-authority";
import { mealFromModel, onlineMealRequiresQR, recognizeMealImage } from "./services/meal/recognize";
import { currentMeal, putMealObservations, readMeals, stageLuckinDraft } from "./services/meal/records";
import { mealCredentialScope } from "./services/meal/rules";
import { synchronizeMeals } from "./services/meal/cloud";
import { synchronizeParcelCloudRecords } from "./services/parcel-cloud-sync";
import { normalizeWaybill } from "./services/status";
import { ONLINE_BUDGET_MS, onlineRecognitionIdentity, requestOnlineRecognition } from "./services/recognition/client";
import { recognitionOperation } from "./services/recognition/settings";
import { waitForRefresh } from "./services/deadline";
import { LUCKIN_RESCAN, SCREEN_SHORTCUT_INSTALL_URL, SCREEN_SHORTCUT_VERSION, screenShortcutVersion } from "./services/shortcut-capture";

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

/** Diagnostics only (D119): how far an image recognition got, and why it stopped early. */
type ScreenNote = {
  stage?: "online_recognition" | "vision_ocr" | "meal_recognition";
  cancelReason?: "settings_saved" | "deadline";
  skipReason?: "no_meal_rules";
};

async function notifyShortcutMeals(ids: readonly string[], scope: string): Promise<void> {
  if (scope !== mealCredentialScope()) return;
  const saved = readMeals(scope);
  for (const id of ids) {
    const meal = currentMeal(saved, id);
    if (!meal || scope !== mealCredentialScope()) continue;
    await notifyScreenPickupSaved({
      name: meal.brandName, code: meal.code, details: [meal.productName, meal.merchantName],
      iconPath: parcelCardArtwork({ kind: "meal", mealBrandId: meal.brandId }).mark?.path,
      parameters: { [MEAL_SHORTCUT_RECORD_PARAMETER]: id },
    });
  }
  await showShortcutPickupActivities(ids.map(mealId => ({ mealId, mealScope: scope })));
}

function modelParcel(fields: Record<string, unknown>, capturedAtMs: number): ParcelLookup | undefined {
  const waybill = typeof fields.waybill === "string" ? normalizeWaybill(fields.waybill) : "";
  if (!isParcelWaybill(waybill)) return undefined;
  const code = typeof fields.pickupCode === "string" ? normalizeRecognizedPickupCode(fields.pickupCode) : "";
  const locationName = typeof fields.pickupLocation === "string" ? fields.pickupLocation.trim() : "";
  return { waybill, capturedAtMs, ...(code ? { pickup: { code, ...(locationName ? { locationName } : {}) } } : {}) };
}

function cropStatusBarStrip(image: UIImage): UIImage {
  if (!image || typeof image.croppedTo !== "function") return image;
  const width = image.width;
  const height = image.height;
  if (!(width > 0) || !(height > 200) || height <= width) return image;
  let inset = 0;
  try {
    const safeTop = typeof Device !== "undefined" ? Number(Device.safeAreaInsets?.top) || 0 : 0;
    inset = safeTop > 0 ? safeTop : Math.round(height * 0.062);
  } catch {
    inset = Math.round(height * 0.062);
  }
  const cropY = Math.min(Math.max(0, inset), Math.floor(height * 0.12));
  if (!(cropY >= 16 && height - cropY > 100)) return image;
  try {
    return image.croppedTo({ x: 0, y: cropY, width, height: height - cropY }) ?? image;
  } catch {
    return image;
  }
}

async function recognizeShortcutImage(rawImage: UIImage, capturedAtMs: number, note: ScreenNote = {}): Promise<ScreenResult> {
  const image = cropStatusBarStrip(rawImage);
  const operation = recognitionOperation();
  const deadline = capturedAtMs + 45_000;
  const none = { parcel: {} };
  const isCurrent = () => {
    if (!operation.isCurrent()) note.cancelReason = "settings_saved";
    else if (Date.now() >= deadline) note.cancelReason = "deadline";
    else return true;
    return false;
  };
  const scope = mealCredentialScope();
  let onlineQR: Record<string, unknown> | undefined;
  let pendingOnlineMeal: ReturnType<typeof mealFromModel> = null;
  let onlineFallbackNotice = "";
  if (operation.mode === "online") {
    note.stage = "online_recognition";
    const onlineDeadline = Math.min(deadline - 20_000, Date.now() + ONLINE_BUDGET_MS);
    try {
      const result = operation.config ? await requestOnlineRecognition(operation.config, image, onlineDeadline, undefined, "shortcut") : null;
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
            if (meal) {
              const rawBrand = typeof result.fields.brand === "string" ? result.fields.brand.trim() : "";
              if (!rawBrand && rules.parsed && meal.payload.brandId === rules.parsed.genericBrandId) {
                onlineQR = result.fields;
                pendingOnlineMeal = meal;
              } else {
                return { ...none, meals: { ids: putMealObservations(scope, [meal], true), scope } };
              }
            }
          }
        }
      }
      if (!onlineQR) {
        writeDiagnostic("recognition.online.fallback", operation.config
          ? { ...onlineRecognitionIdentity(operation.config), result: "no_match" } : { result: "configuration" });
        onlineFallbackNotice = operation.config
          ? "在线识别未成功，正在本地识别"
          : "在线识别配置不可用，正在本地识别";
      }
    } catch {
      writeDiagnostic("recognition.online.fallback", {
        ...(operation.config ? onlineRecognitionIdentity(operation.config) : {}), result: "unavailable",
      });
      onlineFallbackNotice = "在线识别未成功，正在本地识别";
    }
  }
  if (!isCurrent()) return { ...none, cancelled: true };
  if (onlineFallbackNotice && typeof scheduleScreenShortcutStatus === "function") {
    try { await scheduleScreenShortcutStatus(onlineFallbackNotice); } catch { /* Best-effort fallback toast */ }
  }
  note.stage = "vision_ocr";
  const recognized = await waitForRefresh(Vision.recognizeText(image, {
    recognitionLanguages: ["zh-Hans", "en"],
    recognitionLevel: "accurate",
    usesLanguageCorrection: false,
  }), deadline);
  if (!isCurrent()) return { ...none, cancelled: true };
  const width = image.width * image.scale, height = image.height * image.scale;
  const rows = parcelImageRows(recognized.candidates, width, height);
  const parcel = recognizeParcelCodes(rows, capturedAtMs);
  if (!recognized.candidates.length && pendingOnlineMeal && scope && mealCredentialScope() === scope) {
    return { parcel, meals: { ids: putMealObservations(scope, [pendingOnlineMeal], true), scope } };
  }
  if (!onlineQR && (parcel.lookup || parcel.independent) || !recognized.candidates.length || !scope || mealCredentialScope() !== scope) {
    return { parcel };
  }
  note.stage = "meal_recognition";
  const rules = await waitForRefresh(ensureMealRules(), deadline);
  if (!rules) {
    note.skipReason = "no_meal_rules";
    return { parcel };
  }
  const meal = await waitForRefresh(recognizeMealImage(image, recognized.candidates, capturedAtMs, rules, onlineQR), deadline);
  if (!isCurrent() || mealCredentialScope() !== scope) return { ...none, cancelled: true };
  if (meal.draft) {
    stageLuckinDraft(scope, meal.draft);
    return { parcel, draft: true };
  }
  if (!meal.meals.length) return { parcel };
  return { parcel, meals: { ids: putMealObservations(scope, meal.meals, true), scope } };
}

async function recognizeShortcutParcel(parameter: NonNullable<typeof Intent.shortcutParameter>, automaticRescan: boolean,
  report: (outcome: string, records?: number) => void, note: ScreenNote = {}): Promise<string> {
  const capturedAtMs = Date.now();
  let rows: ParcelRow[] = [];
  let imageParcel: ReturnType<typeof recognizeParcelCodes> | undefined;
  if (parameter.type === "text") {
    rows = parcelTextRows(parameter.value);
  } else if (parameter.type === "fileURL") {
    const path = shortcutImagePath(parameter.value);
    const image = path ? UIImage.fromFile(path) : null;
    if (!image) {
      report("input_unavailable");
      return notifyScreenShortcutStatus("无法读取当前屏幕的截屏，请重新运行指令。");
    }
    const { parcel, meals, draft, cancelled } = await recognizeShortcutImage(image, capturedAtMs, note);
    if (cancelled) {
      report("cancelled");
      return "识别已取消，请重新运行。";
    }
    if (draft) {
      const manual = "已识别瑞幸订单，请打开取餐码再运行一次截屏识别。";
      if (!automaticRescan) {
        report("manual_rescan_required");
        return notifyScreenShortcutStatus(manual);
      }
      const scheduled = await scheduleScreenShortcutStatus("请在 3 秒内打开取餐码，等待自动二次识别");
      report(scheduled ? "automatic_rescan_requested" : "manual_rescan_required");
      return scheduled ? LUCKIN_RESCAN : manual;
    }
    if (meals?.ids.length) {
      report("meal_saved", meals.ids.length);
      await notifyShortcutMeals(meals.ids, meals.scope);
      await synchronizeMeals(5_000);
      return `已添加 ${meals.ids.length} 张取餐码，可在「待取」查看。`;
    }
    imageParcel = parcel;
  } else {
    report("invalid_input");
    return "请传入当前屏幕的截屏或短信正文。";
  }

  const { lookup, independent } = imageParcel ?? recognizeParcelCodes(rows, capturedAtMs);
  if (!lookup && !independent) {
    report("no_result");
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
  report(record ? record.kind === "handoff" ? "handoff_saved" : "pickup_saved"
    : lookup && parameter.type === "text" ? "lookup_staged" : "waybill_recognized", record ? 1 : 0);
  if (parameter.type === "fileURL") {
    if (lookup) {
      const msg = await submitScreenShortcut(lookup, showShortcutPickupActivities);
      if (typeof synchronizeParcelCloudRecords === "function" && mealCredentialScope()) {
        await synchronizeParcelCloudRecords(4_000).catch(() => undefined);
      }
      return msg;
    }
    if (record?.kind === "pickup" || record?.kind === "handoff") {
      const card = independentPickupContent(record);
      if (card?.target) {
        const message = await notifyScreenPickupSaved({
          name: PLATFORM_ACCOUNT_NAMES[record.platform], code: card.code,
          details: [record.note, card.location],
          iconPath: parcelCardArtwork(card).mark?.path,
          parameters: { [PARCEL_SHORTCUT_RECORD_PARAMETER]: record.id },
        });
        await showShortcutPickupActivities([card.target]);
        if (typeof synchronizeParcelCloudRecords === "function" && mealCredentialScope()) {
          await synchronizeParcelCloudRecords(4_000).catch(() => undefined);
        }
        return message;
      }
    }
  }
  if (record && typeof synchronizeParcelCloudRecords === "function" && mealCredentialScope()) {
    await synchronizeParcelCloudRecords(4_000).catch(() => undefined);
  }
  return "已识别快递信息，打开派派助手查看。";
}

async function run() {
  // D103: this host names itself on its lines and reports what an earlier runtime left unfinished (D4).
  writeRuntimeCapabilities("shortcut");
  const imagePaths = Intent.imagePathsParameter;
  const paths = imagePaths?.length ? imagePaths : Intent.fileURLsParameter;
  const input = Intent.shortcutParameter;
  const texts = [...(Intent.textsParameter ?? []), ...(input?.type === "text" ? [input.value] : [])];
  const installedShortcutVersion = screenShortcutVersion(texts);
  const automaticRescan = installedShortcutVersion !== undefined || texts.includes(LUCKIN_RESCAN);
  const screenshot = paths?.length === 1
    ? { type: "fileURL" as const, value: paths[0] }
    : undefined;
  const parameter = automaticRescan && input?.type !== "fileURL" && screenshot ? screenshot : input ?? screenshot;
  if (parameter) {
    const screen = parameter.type === "fileURL";
    const finish = beginDiagnosticOperation("shortcut.screen", {
      stage: screen ? "screenshot" : "text", trigger: automaticRescan ? "luckin_rescan" : "shortcut",
    });
    if (screen && installedShortcutVersion !== undefined &&
        installedShortcutVersion < SCREEN_SHORTCUT_VERSION) {
      // D119: an outdated installed Shortcut is sent to the install page; its run ends with that result.
      finish("outdated_shortcut");
      flushDiagnostics();
      Script.exit(Intent.text(SCREEN_SHORTCUT_INSTALL_URL));
      return;
    }
    let outcome = "failed";
    let records = 0;
    let failure: unknown;
    const note: ScreenNote = {};
    let message: string;
    try {
      message = await recognizeShortcutParcel(parameter, automaticRescan, (result, count = 0) => {
        outcome = result;
        records = count;
      }, note);
    } catch (error) {
      outcome = "failed";
      failure = error;
      message = screen ? "处理截屏识别结果失败，请重试。" : "处理快递识别结果失败，请重试。";
      if (screen) message = await notifyScreenShortcutStatus(message);
    } finally {
      // D119: the recognition stage reached, why it stopped early, and a failure's category.
      finish(outcome, {
        records,
        ...(note.stage ? { stage: note.stage } : {}),
        ...(outcome === "cancelled" && note.cancelReason ? { cancelReason: note.cancelReason } : {}),
        ...(note.skipReason ? { skipReason: note.skipReason } : {}),
        ...(failure !== undefined ? diagnosticErrorDetails(failure) : {}),
      }, outcome === "failed" ? "warning" : "info");
      flushDiagnostics();
    }
    Script.exit(Intent.text(message));
    return;
  }
  if (paths?.length || Intent.textsParameter?.length || Intent.urlsParameter?.length) {
    Script.exit(Intent.text("请运行截屏识别指令或短信自动化。"));
    return;
  }

  const startedAt = Date.now();
  try {
    backgroundHostBootstrap();
    const summary = await refreshAllShipments(undefined, backgroundRefreshOptions());
    // The international Watch rows follow the domestic pass, as on the widget (G-HIGH-10).
    let latest = !summary.skipReason ? summary.state : undefined;
    if (latest) {
      const watch = await refreshDueWatchShipments(latest);
      if (watch) latest = watch;
    }
    await Promise.all([
      typeof synchronizeParcelCloudRecords === "function" && typeof mealCredentialScope === "function" && mealCredentialScope()
        ? synchronizeParcelCloudRecords(5_000).catch(() => undefined)
        : Promise.resolve(),
      typeof synchronizeMeals === "function"
        ? (async () => {
            if (typeof ensureMealRules === "function") {
              const ready = await ensureMealRules("meal_sync").catch(() => null);
              if (!ready) return;
            }
            await synchronizeMeals(5_000).catch(() => undefined);
          })()
        : Promise.resolve(),
    ]);
    if (typeof retireCompletedParcelActivities === "function" && latest) {
      await retireCompletedParcelActivities(latest);
    }
    // D103: the host's own line for its refresh, beside the refresh flow's lines.
    writeDiagnostic("intent.run.completed", { runtimeHost: "shortcut", stage: "refresh",
      result: summary.skipReason ? "skipped" : "completed", durationMs: Date.now() - startedAt });
    flushDiagnostics();
    Script.exit(Intent.text(refreshIntentMessage(summary)));
  } catch (error) {
    writeDiagnostic("intent.run.completed", { runtimeHost: "shortcut", stage: "refresh", result: "failed",
      durationMs: Date.now() - startedAt, ...diagnosticErrorDetails(error) }, "warning");
    flushDiagnostics();
    Script.exit(Intent.text("快递更新失败，请稍后重试。"));
  }
}

void run();
