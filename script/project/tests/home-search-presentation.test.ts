import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PendingManualQuery } from "../models";
import {
  ManualCarrierDetectionCoordinator,
  refreshPendingCarrierPresentation,
} from "../services/manual-query";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const homeSource = await readFile(
  resolve(projectDir, "pages/HomePage.tsx"),
  "utf8",
);
const manualQuerySource = await readFile(
  resolve(projectDir, "services/manual-query.ts"),
  "utf8",
);
const carrierRecognitionSource = await readFile(
  resolve(projectDir, "services/carrier-recognition.ts"),
  "utf8",
);

assert.match(homeSource, /ManualCarrierDetectionCoordinator/);
assert.match(
  homeSource,
  /const \[detectedCarrier, setDetectedCarrier\] = useState</,
);
assert.match(
  homeSource,
  /function scheduleCarrierDetection\(value: string\)[\s\S]*?carrierDetectionCoordinatorRef\.current!\.resolve\(normalized\)[\s\S]*?setDetectedCarrier/,
  "typing must start the same durable recognition operation used by submission",
);
assert.match(
  homeSource,
  /onChanged=\{\(value\) => \{[\s\S]*?scheduleCarrierDetection\(value\)[\s\S]*?\{detectedCarrier \? \([\s\S]*?<Button[\s\S]*?\{detectedCarrier\.companyName\}/,
  "typing must automatically resolve a carrier and expose it as the query action",
);
assert.match(
  homeSource,
  /submittedCarrier = await carrierDetectionCoordinatorRef\.current!\.resolve\([\s\S]*?queryManualShipmentPreview\(\{[\s\S]*?presentation: submittedCarrier/,
  "submission must await or reuse recognition and pass it only as presentation",
);
assert.match(
  homeSource,
  /const committed = commitManualShipmentPreview\(preview\)[\s\S]*?props\.onStateChange\(committed\)[\s\S]*?manualPreviewNavigationTarget\(preview, committed\)/,
  "every accepted Home query must open the canonical shipment produced by its commit",
);
assert.match(
  homeSource,
  /manualPreviewNeedsDetailRefresh\(selected\)[\s\S]*?\? "manual_submit"[\s\S]*?: false/,
  "a submitted query with order or pickup history must open without redundant detail enrichment",
);
assert.match(
  homeSource,
  /function clearQueryInputs\(\)[\s\S]*?setWaybill\(""\)[\s\S]*?setPhoneTail\(""\)[\s\S]*?setDetectedCarrier\(null\)[\s\S]*?Keyboard\.hide\(\)/,
  "a submitted query must clear both inputs and stale carrier recognition",
);
assert.doesNotMatch(
  homeSource,
  /setManualPreview\(|setSelectedId\(/,
  "manual preview and selected shipment must not be split across independent renders",
);
assert.match(
  homeSource,
  /consumeShipmentNavigationTarget\([\s\S]*?setShipmentNavigationTarget\(consumed\.nextTarget\)/,
  "dismissal must consume the one-shot target",
);
assert.doesNotMatch(
  homeSource,
  /if \(consumed\.preview\)[\s\S]*?commitManualShipmentPreview\(consumed\.preview\)/,
  "dismissal must not commit a manual preview for a second time",
);
assert.match(
  homeSource,
  /promotedPendingShipmentNavigationTarget\([\s\S]*?summary,[\s\S]*?shipmentNavigationTargetRef\.current[\s\S]*?props\.onStateChange\(summary\.state\)[\s\S]*?setShipmentNavigationTarget\(promotedTarget\)/,
  "a Home-owned foreground refresh must open its committed pending promotion",
);
assert.match(
  homeSource,
  /async function refresh\(\)[\s\S]*?applyInteractiveRefreshSummary\(summary\)/,
  "only the explicit pull-to-refresh handler may consume a pending promotion",
);
const launchRefresh = homeSource.match(
  /useEffect\(\(\) => \{[\s\S]*?refreshAllShipments\(\)[\s\S]*?\}, \[\]\);/,
)?.[0] || "";
assert.match(launchRefresh, /props\.onStateChange\(summary\.state\)/);
assert.doesNotMatch(
  launchRefresh,
  /promotedPendingShipmentNavigationTarget|applyInteractiveRefreshSummary/,
  "the automatic launch refresh must apply state without opening a promotion",
);
assert.doesNotMatch(
  homeSource,
  /rawCourierCode:\s*submittedCarrier/,
  "display recognition must never become an upstream query code",
);
assert.doesNotMatch(homeSource, />\s*查询\s*<\/Text>/);
assert.doesNotMatch(homeSource, /自动识别|识别中…|无法识别/);
assert.match(homeSource, /submitLabel="search"/);
assert.match(
  homeSource,
  /onSubmit=\{\{[\s\S]*?triggers: "text"[\s\S]*?action: \(\) => \{[\s\S]*?void query\(\)/,
  "the keyboard search key must use the explicit text submit trigger",
);
assert.doesNotMatch(
  homeSource,
  /onSubmit=\{[\s\S]{0,180}?if \(canQuery\)/,
  "submission must not be dropped by a stale rendered canQuery value",
);
assert.match(
  homeSource,
  /prompt=\{phoneTailValidation[\s\S]*?: "请输入 4 位手机尾号"\}[\s\S]*?submitLabel="search"[\s\S]*?onSubmit=\{\{[\s\S]*?triggers: "text"/,
  "the inline phone-tail field must submit the same query from the keyboard",
);
assert.match(
  homeSource,
  /prompt=\{phoneTailValidation[\s\S]*?: "请输入 4 位手机尾号"\}[\s\S]*?<Button[\s\S]*?title=\{querying \? "查询中…" : "查询"\}[\s\S]*?void query\(\)/,
  "the phone-tail input must contain a stable trailing query action",
);
assert.match(
  homeSource,
  /systemName="phone"/,
  "the phone-tail field must use the telephone symbol",
);
assert.doesNotMatch(
  homeSource,
  /\{phoneTail\.length\}\/4/,
  "the phone-tail field must not show a character counter",
);
assert.doesNotMatch(
  homeSource,
  /keyboard:\s*\(/,
  "the query action must not float with the number-pad toolbar",
);
assert.match(
  homeSource,
  /const phoneTailValidation = validationNotice\.includes\("手机尾号"\)/,
  "phone-tail validation must be rendered by the phone-tail input",
);
assert.match(
  homeSource,
  /validationNotice && !phoneTailValidation/,
  "phone-tail validation must not render as a separate list footer",
);
assert.match(
  homeSource,
  /phoneTailValidation && phoneTail[\s\S]*?foregroundStyle="systemRed"[\s\S]*?\{validationNotice\}/,
  "a partially entered invalid phone tail must keep its validation inside the input capsule",
);

assert.match(
  manualQuerySource,
  /export async function detectManualCarrier[\s\S]*?recognizeNonSyncCarrier/,
  "manual carrier detection must use the durable non-sync recognition service",
);
assert.match(
  carrierRecognitionSource,
  /detectKuaidi100CarrierCandidates[\s\S]*?firstStageCompleted:\s*true/,
  "non-sync recognition must run local autoComNum before the Worker second level",
);
assert.match(
  carrierRecognitionSource,
  /route:\s*"\/api\/express\/classify"[\s\S]*?firstStageCompleted:\s*true/,
  "the Worker classifier must be called only as the explicit second level",
);

let detectionCalls = 0;
let releaseDetection!: (value: {
  courierCode: string;
  companyName: string;
  requiresPhoneTail: boolean;
}) => void;
const detectionGate = new Promise<{
  courierCode: string;
  companyName: string;
  requiresPhoneTail: boolean;
}>((resolve) => {
  releaseDetection = resolve;
});
const coordinator = new ManualCarrierDetectionCoordinator(async () => {
  detectionCalls++;
  return detectionGate;
});
const debouncedDetection = coordinator.resolve(" sf123456 ");
const quickSubmission = coordinator.resolve("SF123456");
assert.equal(detectionCalls, 1, "quick submit must reuse the in-flight recognition");
releaseDetection({
  courierCode: "SF",
  companyName: "顺丰速运",
  requiresPhoneTail: true,
});
assert.deepEqual(await quickSubmission, await debouncedDetection);
const resolvedSubmission = await coordinator.resolve("SF123456");
assert.equal(
  detectionCalls,
  1,
  "submit after typing recognition settles must reuse the resolved carrier",
);
assert.deepEqual(resolvedSubmission, await debouncedDetection);

const blankPending: PendingManualQuery = {
  id: "interface5:SF123456",
  source: "interface5",
  waybill: "SF123456",
  phoneTail: "",
  courierCode: "",
  rawCourierCode: "upstream-raw-code",
  companyName: "",
  createdAtMs: 1,
  lastAttemptAtMs: 1,
  attempts: 1,
  route: null,
};
const healedPending = await refreshPendingCarrierPresentation(blankPending, {
  detect: async () => ({
    courierCode: "SF",
    companyName: "顺丰速运",
    requiresPhoneTail: false,
  }),
});
assert.equal(healedPending.courierCode, "SF");
assert.equal(healedPending.companyName, "顺丰速运");
assert.equal(
  healedPending.rawCourierCode,
  "upstream-raw-code",
  "pending presentation repair must not replace the upstream query code",
);
const dispatchablePending = await refreshPendingCarrierPresentation({
  ...blankPending,
  rawCourierCode: "",
}, {
  detect: async () => ({
    courierCode: "SF",
    companyName: "顺丰速运",
    requiresPhoneTail: false,
  }),
});
assert.equal(
  dispatchablePending.rawCourierCode,
  "SF",
  "an exact built-in recognition must unlock carrier-dependent pending sources",
);
assert.equal(
  await refreshPendingCarrierPresentation(blankPending, {
    detect: async () => {
      throw new Error("offline");
    },
  }),
  blankPending,
  "recognition failure must leave the hidden pending retryable",
);
assert.match(
  await readFile(resolve(projectDir, "services/sync.ts"), "utf8"),
  /const\s+([A-Za-z_$][\w$]*)\s*=\s*await refreshPendingCarrierPresentation\([\s\S]*?queryManualForSource\(\{[\s\S]*?rawCourierCode:\s*\1\.rawCourierCode/,
  "background pending refresh must retry presentation separately from query routing",
);

console.log("home search carrier presentation tests passed");
