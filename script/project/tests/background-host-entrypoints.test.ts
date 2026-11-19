import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { posix as Path } from "node:path";
import { runInNewContext } from "node:vm";
import { normalizeRecognizedPickupCode, recognizeParcelCodes, type ParcelLookup } from "../services/parcel-code-ocr";
import { isParcelWaybill, parcelImageRows, parcelTextRows } from "../services/parcel-waybill-ocr";
import { listHeadline, normalizeWaybill } from "../services/status";
import { EXPRESS_TOAST_COPY } from "../services/express-toast-copy";
import type { ParcelActivityCompletion } from "../services/parcel-activity-action";

function executable(name: string): string {
  return stripTypeScriptTypes(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"), { mode: "transform" })
    .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, "");
}

const source = executable("intent.tsx");
const manifest = JSON.parse(readFileSync(new URL("../script.json", import.meta.url), "utf8"));
assert.deepEqual(manifest.intentInputTypes, [], "parcel recognition must stay out of the system Share Sheet");
assert.equal(manifest.runInApp, false, "the Shortcut can finish without opening the main app");
const events: string[] = [];
let exited: unknown;
await runInNewContext(source.replace(/void run\(\);\s*$/, "run();"), {
  backgroundHostBootstrap: () => events.push("cache"),
  backgroundRefreshOptions: () => ({ budgetMs: 120_000, accountOrderProjection: true, backgroundHostSafe: true }),
  refreshAllShipments: async (_source: unknown, options: unknown) => {
    assert.deepEqual(JSON.parse(JSON.stringify(options)), {
      budgetMs: 120_000, accountOrderProjection: true, backgroundHostSafe: true,
    });
    events.push("refresh");
    return { attempted: 1, succeeded: 1, failed: 0 };
  },
  refreshIntentMessage: () => "completed",
  flushDiagnostics: () => events.push("flush"),
  Script: { exit: (value: unknown) => { events.push("exit"); exited = value; } },
  Intent: { text: (value: string) => value },
});
assert.equal(exited, "completed");
assert.equal(events[0], "cache", "Shortcuts must bootstrap the last-good carrier cache before refreshing");
assert.ok(events.indexOf("flush") < events.indexOf("exit"), "Shortcuts flush before the host exits");

const app = executable("app_intents.tsx");
const AppIntentProtocol = { AppIntent: 0, LiveActivityIntent: 3 };
type RegisteredIntent = {
  name: string;
  protocol: number;
  perform: (params?: ParcelActivityCompletion) => Promise<void>;
};
function runAppIntents(bindings: Record<string, unknown>): Map<string, RegisteredIntent> {
  const intents = new Map<string, RegisteredIntent>();
  runInNewContext(app, {
    AppIntentProtocol,
    AppIntentManager: { register: (intent: RegisteredIntent) => intents.set(intent.name, intent) },
    ...bindings,
  });
  return intents;
}

for (const failingStage of ["cache", "refresh"] as const) {
  const calls: string[] = [];
  const intents = runAppIntents({
    loadCarrierAuthorityCache: () => { calls.push("cache"); if (failingStage === "cache") throw new Error("synthetic upstream error"); },
    backgroundHostBootstrap: () => { calls.push("cache"); if (failingStage === "cache") throw new Error("synthetic upstream error"); },
    backgroundRefreshOptions: () => ({ budgetMs: 120_000, accountOrderProjection: true, backgroundHostSafe: true }),
    refreshAllShipments: async () => { calls.push("refresh"); throw new Error("synthetic upstream error"); },
    flushDiagnostics: () => calls.push("flush"),
  });
  const refresh = intents.get("RefreshPipiDeliveriesIntent");
  assert.ok(refresh);
  await assert.rejects(refresh.perform(), { message: "快递更新失败，请稍后重试。" });
  assert.equal(calls.at(-1), "flush");
  assert.equal(calls.includes("refresh"), failingStage === "refresh");
}

const successCalls: string[] = [];
const intents = runAppIntents({
  backgroundHostBootstrap: () => successCalls.push("cache"),
  backgroundRefreshOptions: () => ({ budgetMs: 120_000, accountOrderProjection: true, backgroundHostSafe: true }),
  refreshAllShipments: async () => { successCalls.push("refresh"); },
  completeParcelActivity: async ({ linkId, kind }: ParcelActivityCompletion) => { successCalls.push(linkId, kind); },
  flushDiagnostics: () => successCalls.push("flush"),
});
const refresh = intents.get("RefreshPipiDeliveriesIntent");
assert.equal(refresh?.protocol, AppIntentProtocol.AppIntent);
assert.equal(await refresh.perform(), undefined, "the App Intent keeps its supported void result contract");
assert.deepEqual(successCalls, ["cache", "refresh", "flush"]);

successCalls.length = 0;
const complete = intents.get("CompleteParcelActivityIntent");
assert.equal(complete?.protocol, AppIntentProtocol.LiveActivityIntent);
assert.equal(await complete.perform({ linkId: "synthetic-shipment-link", kind: "pickup" }), undefined);
assert.deepEqual(successCalls, ["synthetic-shipment-link", "pickup", "flush"]);

for (const failingStage of ["cache", "refresh"] as const) {
  const calls: string[] = [];
  let result: unknown;
  await runInNewContext(source.replace(/void run\(\);\s*$/, "run();"), {
    backgroundHostBootstrap: () => { calls.push("cache"); if (failingStage === "cache") throw new Error("synthetic upstream error"); },
    backgroundRefreshOptions: () => ({ budgetMs: 120_000, accountOrderProjection: true, backgroundHostSafe: true }),
    refreshAllShipments: async () => { calls.push("refresh"); throw new Error("synthetic upstream error"); },
    refreshIntentMessage: () => assert.fail("a failed refresh has no success message"),
    flushDiagnostics: () => calls.push("flush"),
    Script: { exit: (value: unknown) => { calls.push("exit"); result = value; } },
    Intent: { text: (value: string) => value },
  });
  assert.equal(result, "快递更新失败，请稍后重试。");
  assert.deepEqual(calls.slice(-2), ["flush", "exit"]);
}

const track = "TEST81234567";
const text = (value: string) => ({ shortcutParameter: { type: "text", value } });
const file = (value: string) => ({ shortcutParameter: { type: "fileURL", value } });
for (const [intent, expected, fileRead, record, failedSave] of [
  [text("快递单号：" + track + " 取件码 A1-2345"), track],
  [text("菜鸟驿站\n取件码 A1-2345"), "", undefined, "pickup"],
  [text("菜鸟\n待上门取件\n寄件码 ABC123"), "", undefined, "handoff"],
  [file("file:///synthetic/Photo%201.png"), track, "/synthetic/Photo 1.png"],
  [file("/synthetic/Photo 1.png"), track, "/synthetic/Photo 1.png"],
  [{ imagePathsParameter: ["/synthetic/Photo 1.png"] }, track, "/synthetic/Photo 1.png"],
  [{ fileURLsParameter: ["file:///synthetic/Photo%201.png"] }, track, "/synthetic/Photo 1.png"],
  [{ imagePathsParameter: ["/synthetic/standalone.png"] }, "", "/synthetic/standalone.png", "pickup"],
  [{ imagePathsParameter: ["/synthetic/one.png", "/synthetic/two.png"] }, ""],
  [file("file://remote.invalid/screenshot.png"), ""],
  [file("https://remote.invalid/screenshot.png"), ""],
  [{ shortcutParameter: { type: "json", value: { parcel: "快递单号：" + track } } }, ""],
  [text(""), ""],
  [{ textsParameter: ["快递单号：" + track] }, ""],
  [text("运单号 TEST81234567\n运单号 TEST91234567"), ""],
  [file("file:///synthetic/unreadable.png"), "", "/synthetic/unreadable.png"],
  [text("菜鸟\n待上门取件\n寄件码 ABC123\n快递单号：" + track), track, undefined, "handoff", true],
] as const) {
  const screenSubmission = Boolean(expected && fileRead);
  let staged: ParcelLookup | undefined;
  let queried: ParcelLookup | undefined;
  const saved: string[] = [];
  const activityRecords: string[] = [];
  const discarded: string[] = [];
  const decodedFiles: string[] = [];
  let foregroundCalls = 0;
  let result: unknown;
  await runInNewContext(source.replace(/void run\(\);\s*$/, "run();"), {
    Intent: { ...intent, text: (value: string) => value,
      get imagesParameter() { assert.fail("recognition only decodes the selected local path"); } },
    URL,
    UIImage: {
      fromFile: (path: string) => {
        decodedFiles.push(path);
        return path === "/synthetic/unreadable.png" ? null : { path, width: 1000, height: 1600, scale: 1 };
      },
    },
    Script: {
      createRunSingleURLScheme: () => { foregroundCalls++; return "synthetic:open-draft"; },
      exit: (value: unknown) => { result = value; },
    },
    Safari: { openURL: async () => { foregroundCalls++; return true; } },
    Vision: {
      recognizeText: async ({ path }: { path: string }) => ({
        candidates: (path.endsWith("standalone.png") ? [
          ["丰巢", 0.1, 0.8], ["取件码 1-23-456", 0.1, 0.7],
        ] as const : [
          ["快递单号", 0.1, 0.8], [track, 0.5, 0.8], ["取件码 A1-2345", 0.1, 0.7],
        ] as const).map(([content, x, y]) => ({ content, boundingBox: { x, y, width: 0.18, height: 0.03 } })),
      }),
    },
    UUID: { string: () => "synthetic-record" },
    recognitionOperation: () => ({ mode: "local", isCurrent: () => true }),
    mealCredentialScope: () => "",
    waitForRefresh: (work: unknown) => work,
    parcelImageRows,
    parcelTextRows,
    recognizeParcelCodes,
    stageShortcutLookup: (lookup: ParcelLookup) => {
      staged = lookup;
      return "draft-token";
    },
    saveRecognizedParcelCode: (value: { kind: string; id: string }) => {
      assert.equal(value.id, "synthetic-record");
      if (failedSave) throw new Error("synthetic write failure");
      saved.push(value.kind);
    },
    submitScreenShortcut: async (lookup: ParcelLookup) => { queried = lookup; return "已添加 测试快递"; },
    showShortcutPickupActivities: async (targets: { recordId: string }[]) => {
      assert.deepEqual(saved, ["pickup"], "the record must already be saved");
      activityRecords.push(...targets.map(target => target.recordId));
      return true;
    },
    PICKUP_SHORTCUT_SAVED: "已添加取件码，可在「待取」查看。",
    notifyScreenShortcutStatus: async (message: string) => message,
    writeDiagnostic() {},
    flushDiagnostics() {},
    discardShortcutDraft: (token: string) => discarded.push(token),
    backgroundHostBootstrap: () => assert.fail("Recognition must not invoke the refresh action"),
  });
  assert.equal(staged?.waybill ?? "", screenSubmission ? "" : expected);
  assert.equal(queried?.waybill ?? "", screenSubmission ? expected : "");
  if (expected && !record) assert.equal((queried ?? staged)?.pickup?.code, "A1-2345");
  assert.deepEqual(saved, record && !failedSave ? [record] : []);
  assert.deepEqual(activityRecords, record === "pickup" && fileRead ? ["synthetic-record"] : []);
  assert.equal(foregroundCalls, 0, "recognition never opens the main app");
  assert.deepEqual(decodedFiles, fileRead ? [fileRead] : []);
  assert.deepEqual(discarded, failedSave ? ["draft-token"] : []);
  if (failedSave) assert.match(String(result), /处理快递识别结果失败/);
  else if (screenSubmission) assert.match(String(result), /已添加 测试快递/);
  else if (activityRecords.length) assert.match(String(result), /取件码/);
  else if (expected || record) assert.match(String(result), /已识别快递信息/);
  else assert.match(String(result), /未识别|无法读取|请传入|请运行/);
}

// Exercise the same production shortcut with the selected provider conclusive, unavailable or unable to match.
for (const phase of ["local", "online-express", "online-empty", "online-error", "cancelled"] as const) {
  const calls: string[] = [];
  let final = "";
  await runInNewContext(source.replace(/void run\(\);\s*$/, "run();"), {
    Intent: { ...file("/synthetic/image.png"), text: (value: string) => value },
    Script: { exit: (value: string) => { final = value; } },
    UIImage: { fromFile: () => ({ width: 800, height: 1100, scale: 1 }) },
    Vision: { recognizeText: async () => { calls.push("local"); return { candidates: [] }; } },
    recognitionOperation: () => ({ mode: phase === "local" ? "local" : "online", config: {},
      isCurrent: () => phase !== "cancelled" || calls.length === 0 }),
    ONLINE_BUDGET_MS: 25000,
    mealCredentialScope: () => "",
    requestOnlineRecognition: async () => {
      calls.push("provider");
      if (phase === "online-error") throw new Error("synthetic offline");
      return phase === "online-express" || phase === "cancelled"
        ? { family: "express", fields: { waybill: track, pickupCode: "A1-2345" } } : null;
    },
    waitForRefresh: (work: unknown) => work,
    recognizeParcelCodes: () => ({}),
    parcelImageRows, parcelTextRows, normalizeWaybill, isParcelWaybill, normalizeRecognizedPickupCode,
    submitScreenShortcut: (lookup: ParcelLookup) => {
      assert.equal(lookup.waybill, track);
      calls.push("query");
      return "已添加";
    },
    showShortcutPickupActivities: async () => true,
    notifyScreenShortcutStatus: (message: string) => message,
    writeDiagnostic() {}, flushDiagnostics() {},
  });
  assert.deepEqual(calls, phase === "local" ? ["local"] :
    phase === "online-express" ? ["provider", "query"] :
    phase === "cancelled" ? ["provider"] : ["provider", "local"]);
  if (phase === "cancelled") assert.match(final, /识别已取消/);
}

for (const phase of ["local-meal", "online-meal", "luckin-draft", "local-meal-no-activity"] as const) {
  const calls: string[] = [];
  const scope = "synthetic-scope";
  const observation = { payload: { code: "0123", brandId: "ruixing" } };
  let final = "";
  await runInNewContext(source.replace(/void run\(\);\s*$/, "run();"), {
    Intent: { ...file("/synthetic/meal.png"), text: (value: string) => value },
    Script: { exit: (value: string) => { final = value; } },
    UIImage: { fromFile: () => ({ width: 800, height: 1100, scale: 1 }) },
    Vision: { recognizeText: async () => ({ candidates: [{ content: "取餐码" }] }) },
    recognitionOperation: () => ({ mode: phase === "online-meal" ? "online" : "local", config: {}, isCurrent: () => true }),
    ONLINE_BUDGET_MS: 25_000,
    mealCredentialScope: () => scope,
    requestOnlineRecognition: async () => ({ family: "pickup", fields: {} }),
    ensureMealRules: async () => ({}),
    onlineMealRequiresQR: () => false,
    mealFromModel: () => observation,
    recognizeMealImage: async () => phase === "luckin-draft" ? { meals: [], draft: observation } : { meals: [observation] },
    putMealObservations: (account: string, entries: unknown[]) => {
      assert.equal(account, scope);
      assert.equal(entries[0], observation);
      calls.push("save");
      return ["meal-id"];
    },
    stageLuckinDraft: () => calls.push("draft"),
    showShortcutPickupActivities: async (targets: { mealId: string; mealScope: string }[]) => {
      assert.equal(targets[0].mealId, "meal-id");
      assert.equal(targets[0].mealScope, scope);
      calls.push("activity");
      return phase !== "local-meal-no-activity";
    },
    notifyScreenShortcutStatus: (message: string) => { calls.push("notification"); return message; },
    synchronizeMeals: async () => { calls.push("sync"); },
    waitForRefresh: (work: unknown) => work,
    recognizeParcelCodes: () => ({}),
    parcelImageRows: () => [],
    writeDiagnostic() {}, flushDiagnostics() {},
  });
  assert.match(final, phase === "luckin-draft" ? /再运行一次截屏识别/ : /已添加 1 张取餐码/);
  assert.deepEqual(calls, phase === "luckin-draft" ? ["draft", "notification"] :
    ["save", "activity", ...(phase === "local-meal-no-activity" ? ["notification"] : []), "sync"]);
}

const shortcutService = executable("services/parcel-shortcut.ts");
const screenshotLookup: ParcelLookup = { waybill: track, capturedAtMs: Date.now(), pickup: { code: "A1-2345" } };
const nativeTitle = "中通快递 4567 · 运输中";
const latestBody = "快件到达示例分拨中心";
const savedShipment = { identity: { id: "synthetic-shipment", waybill: track }, timeline: {
  provider: "v6_query", tracks: [
    { timeMs: 1000, detail: "快件已揽收" },
    { timeMs: 3000, detail: "快递状态已更新" },
    { timeMs: 2000, detail: latestBody },
  ],
} };

function screenshotRuntime(mode: "new" | "known" | "partial" | "phone" | "empty" | "noBanner", activity?: boolean) {
  const calls: string[] = [];
  const banners: Record<string, unknown>[] = [];
  const files = new Map<string, string>();
  let shipments = mode === "known" ? [savedShipment] : [];
  let expectedLookup = screenshotLookup;
  const currentState = () => ({ shipments, pendingQueries: [], activeSource: "v5" });
  const host = runInNewContext(`${shortcutService}\n({ submitScreenShortcut, submitScreenShortcutPhoneTail });`, {
    Path, isParcelWaybill, normalizeRecognizedPickupCode, listHeadline, normalizeWaybill,
    EXPRESS_TOAST_COPY, MANUAL_QUERY_BUDGET_MS: 30_000,
    backgroundHostBootstrap() {},
    deadlineAfter: (budgetMs: number) => NOW_FOR_SHORTCUT + budgetMs,
    loadState: currentState,
    visibleShipments: (state: ReturnType<typeof currentState>) => state.shipments,
    displayWaybill: (shipment: typeof savedShipment) => shipment.identity.waybill,
    selectShipmentTimeline: (shipment: typeof savedShipment) => shipment.timeline,
    parcelActivityContent: (shipment: typeof savedShipment) => activity === undefined ? null : {
      target: { shipmentId: shipment.identity.id, waybill: track, waybillGeneration: 0 }, code: screenshotLookup.pickup!.code,
    },
    saveRecognizedShipmentPickup: (_shipment: unknown, lookup: ParcelLookup) => {
      assert.equal(lookup.pickup?.code, expectedLookup.pickup?.code);
      calls.push("attach existing");
      return currentState();
    },
    detectManualCarrier: async () => { calls.push("carrier"); return { requiresPhoneTail: mode === "phone" }; },
    queryManualShipmentPreview: async (input: { waybill: string; phoneTail?: string; deadlineAtMs: number }) => {
      assert.equal(input.waybill, track);
      assert.equal(input.deadlineAtMs, NOW_FOR_SHORTCUT + 30_000);
      calls.push("picker");
      if (mode === "phone" && input.phoneTail !== "0007") throw { needsPhoneTail: true };
      return { shipment: savedShipment, roundComplete: mode !== "partial" && mode !== "empty",
        pending: {}, commitBase: { shipment: null } };
    },
    commitManualShipmentPreview: (preview: { roundComplete: boolean }, _now: number, lookup: ParcelLookup) => {
      assert.equal(lookup.pickup?.code, expectedLookup.pickup?.code);
      calls.push("commit");
      if (preview.roundComplete) shipments = [savedShipment];
      return currentState();
    },
    continueManualShipmentPreview: async (_preview: unknown, options: { backgroundHostSafe: boolean; deadlineAtMs: number; lookup: ParcelLookup }) => {
      assert.equal(options.backgroundHostSafe, true);
      assert.equal(options.deadlineAtMs, NOW_FOR_SHORTCUT + 30_000);
      assert.equal(options.lookup.pickup?.code, expectedLookup.pickup?.code);
      calls.push("continue");
      if (mode !== "empty") shipments = [savedShipment];
      return { state: currentState() };
    },
    shipmentNotificationPresentation: () => ({ title: nativeTitle, body: "old headline", shipmentId: "synthetic-shipment", iconName: "zto" }),
    scheduleShipmentNotification: async (event: Record<string, unknown>) => {
      assert.equal(shipments.length, 1, "the notification follows the durable shipment commit");
      calls.push("tracking notification");
      banners.push(event);
      return mode !== "noBanner";
    },
    Notification: { schedule: async (request: Record<string, unknown>) => { banners.push(request); return true; } },
    waitForRefresh: (work: Promise<unknown>) => work,
    needsManualPhoneTail: (error: { needsPhoneTail?: boolean }) => error.needsPhoneTail === true,
    manualQueryFailureToast: () => EXPRESS_TOAST_COPY.manualQueryFailed,
    UUID: { string: () => "aaaaaaaa-aaaa-4aaa-8aaa-000000000001" },
    FileManager: {
      appGroupDocumentsDirectory: "/synthetic",
      createDirectorySync() {},
      writeAsStringSync: (path: string, value: string) => { files.set(path, value); },
      renameSync: (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
      readAsStringSync: (path: string) => files.get(path),
      removeSync: (path: string) => files.delete(path),
    },
    writeDiagnostic: (name: string) => { if (name === "shortcut.notification.failed") calls.push("notification unavailable"); },
    flushDiagnostics() {},
  }) as {
    submitScreenShortcut: (lookup: ParcelLookup, present: (targets: { shipmentId: string }[]) => Promise<boolean>) => Promise<string>;
    submitScreenShortcutPhoneTail: (token: string, tail: string) => Promise<{ done: boolean; message: string }>;
  };
  return { ...host, calls, banners, files,
    submitScreenShortcut: (lookup: ParcelLookup) => {
      expectedLookup = lookup;
      return host.submitScreenShortcut(lookup, async targets => {
        assert.equal(shipments.length, 1, "the activity follows the durable shipment commit");
        assert.equal(targets[0].shipmentId, savedShipment.identity.id);
        calls.push("activity");
        return activity === true;
      });
    },
  };
}

const NOW_FOR_SHORTCUT = 1_790_000_000_000;
for (const mode of ["new", "known", "partial", "noBanner"] as const) {
  const host = screenshotRuntime(mode);
  const title = mode === "known" ? nativeTitle : `已添加 ${nativeTitle}`;
  assert.equal(await host.submitScreenShortcut(screenshotLookup), `${title}\n${latestBody}`);
  assert.deepEqual(host.calls, mode === "known" ? ["attach existing", "tracking notification"] : [
    "carrier", "picker", "commit", ...(mode === "partial" ? ["continue"] : []), "tracking notification",
    ...(mode === "noBanner" ? ["notification unavailable"] : []),
  ]);
  assert.equal(host.banners.length, 1);
  assert.equal(host.banners[0].title, title);
  assert.equal(host.banners[0].body, latestBody);
  assert.equal(host.banners[0].iconName, "zto");
  assert.equal(host.files.size, 0, "a successful query must not create a foreground search draft");
}

for (const accepted of [true, false]) {
  const host = screenshotRuntime("new", accepted);
  assert.equal(await host.submitScreenShortcut(screenshotLookup), `已添加 ${nativeTitle}\n${latestBody}`);
  assert.deepEqual(host.calls.slice(3), accepted ? ["activity"] : ["activity", "tracking notification"]);
  assert.equal(host.banners.length, accepted ? 0 : 1);
}
const trackingOnly = screenshotRuntime("new", true);
await trackingOnly.submitScreenShortcut({ ...screenshotLookup, pickup: undefined });
assert.ok(!trackingOnly.calls.includes("activity"));
assert.equal(trackingOnly.banners[0].body, latestBody);

const needsTail = screenshotRuntime("phone");
assert.equal(await needsTail.submitScreenShortcut(screenshotLookup), "请长按通知，输入手机号后 4 位。");
assert.equal(needsTail.banners[0].customUI, true);
assert.equal(needsTail.banners[0].tapAction, "none");
assert.equal(needsTail.banners[0].actions, undefined);
const { screenShortcutDraft } = needsTail.banners[0].userInfo as { screenShortcutDraft: string };
assert.match(screenShortcutDraft, /^screen-/);
assert.deepEqual(Object.keys(needsTail.banners[0].userInfo as object), ["screenShortcutDraft"]);
assert.equal((await needsTail.submitScreenShortcutPhoneTail(screenShortcutDraft, "007")).done, false);
assert.deepEqual(needsTail.calls, ["carrier", "picker"]);
assert.equal((await needsTail.submitScreenShortcutPhoneTail(screenShortcutDraft, "0008")).done, false);
assert.equal(needsTail.files.size, 1, "a rejected tail leaves its exact draft available for retry");
assert.equal((await needsTail.submitScreenShortcutPhoneTail(screenShortcutDraft, "0007")).done, true);
assert.equal(needsTail.files.size, 0);
assert.equal(needsTail.banners[1].body, latestBody);
assert.equal((await needsTail.submitScreenShortcutPhoneTail(screenShortcutDraft, "0007")).done, true);
assert.equal(needsTail.banners.length, 2, "a consumed prompt cannot repeat the query or notification");

const noTracks = screenshotRuntime("empty");
assert.equal(await noTracks.submitScreenShortcut(screenshotLookup), EXPRESS_TOAST_COPY.manualQueryNoTrack);
assert.equal(noTracks.files.size, 1);
assert.equal(noTracks.banners[0].tapAction, "none");
assert.equal(noTracks.banners[0].customUI, undefined);
assert.ok(!noTracks.calls.includes("tracking notification"));

console.log("background host entrypoint tests passed");
