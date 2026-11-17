import { Intent, Script } from "scripting";
import { refreshIntentMessage } from "./services/refresh-result";
import { refreshAllShipments } from "./services/sync";
import { backgroundHostBootstrap, backgroundRefreshOptions } from "./services/background-refresh";
import { flushDiagnostics } from "./services/logger";
import {
  PARCEL_SHORTCUT_PARAMETER,
  PARCEL_SHORTCUT_RECORD_PARAMETER,
  discardShortcutDraft,
  stageShortcutLookup,
} from "./services/parcel-shortcut";
import { recognizeParcelCodes } from "./services/parcel-code-ocr";
import { parcelImageRows, parcelTextRows, type ParcelRow } from "./services/parcel-waybill-ocr";
import { saveRecognizedParcelCode } from "./services/storage";

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

async function recognizeShortcutParcel(parameter: NonNullable<typeof Intent.shortcutParameter>): Promise<void> {
  const capturedAtMs = Date.now();
  let rows: ParcelRow[];
  if (parameter.type === "text") {
    rows = parcelTextRows(parameter.value);
  } else if (parameter.type === "fileURL") {
    const path = shortcutImagePath(parameter.value);
    const image = path ? UIImage.fromFile(path) : null;
    if (!image) {
      Script.exit(Intent.text("无法读取当前屏幕的截屏，请重新运行指令。"));
      return;
    }
    const recognized = await Vision.recognizeText(image, {
      recognitionLanguages: ["zh-Hans", "en"],
      recognitionLevel: "accurate",
      usesLanguageCorrection: false,
    });
    rows = parcelImageRows(recognized.candidates, image.width * image.scale, image.height * image.scale);
  } else {
    Script.exit(Intent.text("请传入当前屏幕的截屏或短信正文。"));
    return;
  }

  const { lookup, independent } = recognizeParcelCodes(rows, capturedAtMs);
  if (!lookup && !independent) {
    Script.exit(Intent.text("未识别到明确的运单号、取件码或寄件码。"));
    return;
  }
  const sms = parameter.type === "text";
  const token = lookup ? stageShortcutLookup(lookup, sms ? "sms" : "screen") : "";
  const recordId = independent ? UUID.string() : "";
  try {
    if (independent) saveRecognizedParcelCode({ ...independent, id: recordId });
  } catch (error) {
    if (token) discardShortcutDraft(token);
    throw error;
  }
  if (sms) {
    Script.exit(Intent.text("已识别快递信息，打开派派助手查看。"));
    return;
  }

  const parameters: Record<string, string> = token ? { [PARCEL_SHORTCUT_PARAMETER]: token } :
    { [PARCEL_SHORTCUT_RECORD_PARAMETER]: recordId };
  let opened = false;
  try {
    opened = await Safari.openURL(Script.createRunSingleURLScheme(Script.name, parameters));
  } finally {
    if (!opened && token) discardShortcutDraft(token);
  }
  Script.exit(opened ? undefined : Intent.text("无法打开派派助手，请重新运行指令。"));
}

async function run() {
  const parameter = Intent.shortcutParameter;
  if (parameter) {
    try {
      await recognizeShortcutParcel(parameter);
    } catch {
      Script.exit(Intent.text("处理快递识别结果失败，请重试。"));
    }
    return;
  }
  if (Intent.textsParameter?.length || Intent.imagesParameter?.length ||
      Intent.urlsParameter?.length || Intent.fileURLsParameter?.length) {
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
