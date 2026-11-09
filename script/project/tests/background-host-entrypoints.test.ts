import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

function executable(name: string): string {
  return stripTypeScriptTypes(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"), { mode: "transform" })
    .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, "");
}

const source = executable("intent.tsx");
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
for (const failingStage of ["cache", "refresh"] as const) {
  let perform: () => Promise<void> = async () => {};
  const calls: string[] = [];
  runInNewContext(app, {
    AppIntentManager: { register: (options: { perform: typeof perform }) => { perform = options.perform; } },
    AppIntentProtocol: { AppIntent: 0 },
    loadCarrierAuthorityCache: () => { calls.push("cache"); if (failingStage === "cache") throw new Error("synthetic upstream error"); },
    backgroundHostBootstrap: () => { calls.push("cache"); if (failingStage === "cache") throw new Error("synthetic upstream error"); },
    backgroundRefreshOptions: () => ({ budgetMs: 120_000, accountOrderProjection: true, backgroundHostSafe: true }),
    refreshAllShipments: async () => { calls.push("refresh"); throw new Error("synthetic upstream error"); },
    flushDiagnostics: () => calls.push("flush"),
  });
  await assert.rejects(perform(), { message: "快递更新失败，请稍后重试。" });
  assert.equal(calls.at(-1), "flush");
  assert.equal(calls.includes("refresh"), failingStage === "refresh");
}

let successfulPerform: () => Promise<void> = async () => {};
const successCalls: string[] = [];
runInNewContext(app, {
  AppIntentManager: { register: (options: { perform: typeof successfulPerform }) => { successfulPerform = options.perform; } },
  AppIntentProtocol: { AppIntent: 0 },
  backgroundHostBootstrap: () => successCalls.push("cache"),
  backgroundRefreshOptions: () => ({ budgetMs: 120_000, accountOrderProjection: true, backgroundHostSafe: true }),
  refreshAllShipments: async () => { successCalls.push("refresh"); },
  flushDiagnostics: () => successCalls.push("flush"),
});
assert.equal(await successfulPerform(), undefined, "the App Intent keeps its supported void result contract");
assert.deepEqual(successCalls, ["cache", "refresh", "flush"]);

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

console.log("background host entrypoint tests passed");
