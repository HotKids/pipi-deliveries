import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { recognizeParcelCodes, type ParcelLookup } from "../services/parcel-code-ocr";
import { parcelImageRows, parcelTextRows } from "../services/parcel-waybill-ocr";
import type { ParcelActivityCompletion } from "../services/parcel-activity-action";

function executable(name: string): string {
  return stripTypeScriptTypes(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"), { mode: "transform" })
    .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, "");
}

const source = executable("intent.tsx");
const manifest = JSON.parse(readFileSync(new URL("../script.json", import.meta.url), "utf8"));
assert.deepEqual(manifest.intentInputTypes, [], "parcel recognition must stay out of the system Share Sheet");
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
for (const [intent, expected, destination, openFailure, fileRead, record] of [
  [text("快递单号：" + track + " 取件码 A1-2345"), track, "sms"],
  [text("菜鸟驿站\n取件码 A1-2345"), "", "", undefined, undefined, "pickup"],
  [text("菜鸟\n待上门取件\n寄件码 ABC123"), "", "", undefined, undefined, "handoff"],
  [file("file:///synthetic/Photo%201.png"), track, "screen", undefined, "/synthetic/Photo 1.png"],
  [file("/synthetic/Photo 1.png"), track, "screen", undefined, "/synthetic/Photo 1.png"],
  [file("/synthetic/standalone.png"), "", "record", undefined, "/synthetic/standalone.png", "pickup"],
  [file("file://remote.invalid/screenshot.png"), "", ""],
  [file("https://remote.invalid/screenshot.png"), "", ""],
  [{ shortcutParameter: { type: "json", value: { parcel: "快递单号：" + track } } }, "", ""],
  [text(""), "", ""],
  [{ textsParameter: ["快递单号：" + track] }, "", ""],
  [{ imagesParameter: [{ synthetic: true }] }, "", ""],
  [text("运单号 TEST81234567\n运单号 TEST91234567"), "", ""],
  [file("/synthetic/Photo 1.png"), track, "screen", "rejected", "/synthetic/Photo 1.png"],
  [file("/synthetic/Photo 1.png"), track, "screen", "error", "/synthetic/Photo 1.png"],
  [file("file:///synthetic/unreadable.png"), "", "", undefined, "/synthetic/unreadable.png"],
] as const) {
  let staged: ParcelLookup | undefined;
  let stagedOrigin = "";
  const saved: string[] = [];
  let opened = false;
  const discarded: string[] = [];
  const decodedFiles: string[] = [];
  let result: unknown;
  await runInNewContext(source.replace(/void run\(\);\s*$/, "run();"), {
    Intent: { ...intent, text: (value: string) => value },
    URL,
    UIImage: {
      fromFile: (path: string) => {
        decodedFiles.push(path);
        return path === "/synthetic/unreadable.png" ? null : { path, width: 1000, height: 1600, scale: 1 };
      },
    },
    Script: {
      name: "Synthetic project",
      createRunSingleURLScheme: (_name: string, parameters: Record<string, string>) => {
        assert.deepEqual({ ...parameters }, destination === "record"
          ? { parcelCodeRecord: "synthetic-record" } : { parcelDraft: "draft-token" });
        return "synthetic:open-draft";
      },
      exit: (value: unknown) => { result = value; },
    },
    Safari: {
      openURL: async (url: string) => {
        assert.equal(url, "synthetic:open-draft");
        if (openFailure === "rejected") return false;
        if (openFailure === "error") throw new Error("synthetic open failure");
        opened = true;
        return true;
      },
    },
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
    PARCEL_SHORTCUT_PARAMETER: "parcelDraft",
    PARCEL_SHORTCUT_RECORD_PARAMETER: "parcelCodeRecord",
    parcelImageRows,
    parcelTextRows,
    recognizeParcelCodes,
    stageShortcutLookup: (lookup: ParcelLookup, origin: string) => {
      staged = lookup;
      stagedOrigin = origin;
      return "draft-token";
    },
    saveRecognizedParcelCode: (value: { kind: string; id: string }) => {
      assert.equal(value.id, "synthetic-record");
      saved.push(value.kind);
    },
    discardShortcutDraft: (token: string) => discarded.push(token),
    backgroundHostBootstrap: () => assert.fail("Recognition must not invoke the refresh action"),
  });
  assert.equal(staged?.waybill ?? "", expected);
  assert.equal(stagedOrigin, expected ? destination : "");
  if (expected) assert.equal(staged?.pickup?.code, "A1-2345");
  assert.deepEqual(saved, record ? [record] : []);
  assert.equal(opened, Boolean((destination === "screen" || destination === "record") && !openFailure));
  assert.deepEqual(decodedFiles, fileRead ? [fileRead] : []);
  assert.deepEqual(discarded, openFailure ? ["draft-token"] : []);
  if (openFailure === "rejected") assert.match(String(result), /无法打开派派助手/);
  if (openFailure === "error") assert.match(String(result), /处理快递识别结果失败/);
  if (destination === "sms" || record && !opened) assert.match(String(result), /已识别快递信息/);
  if (!expected && !record) assert.match(String(result), /未识别|无法读取|请传入|请运行/);
}

console.log("background host entrypoint tests passed");
