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
  let staged: ParcelLookup | undefined;
  const saved: string[] = [];
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
    discardShortcutDraft: (token: string) => discarded.push(token),
    backgroundHostBootstrap: () => assert.fail("Recognition must not invoke the refresh action"),
  });
  assert.equal(staged?.waybill ?? "", expected);
  if (expected && !record) assert.equal(staged?.pickup?.code, "A1-2345");
  assert.deepEqual(saved, record && !failedSave ? [record] : []);
  assert.equal(foregroundCalls, 0, "recognition never opens the main app");
  assert.deepEqual(decodedFiles, fileRead ? [fileRead] : []);
  assert.deepEqual(discarded, failedSave ? ["draft-token"] : []);
  if (failedSave) assert.match(String(result), /处理快递识别结果失败/);
  else if (expected || record) assert.match(String(result), /已识别快递信息/);
  else assert.match(String(result), /未识别|无法读取|请传入|请运行/);
}

console.log("background host entrypoint tests passed");
