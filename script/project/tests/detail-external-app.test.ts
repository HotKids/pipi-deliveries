import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../pages/DetailPage.tsx", import.meta.url), "utf8");
const start = page.indexOf("  async function openExternalApp() {");
const end = page.indexOf("\n  return (", start);
assert.ok(start >= 0 && end > start);
assert.match(page.slice(end), /topBarTrailing:[\s\S]*?action=\{openExternalApp\}/);
// Run the actual page action with a synthetic native opener and request boundary.
const action = new Function(
  "externalAppAbortRef", "externalAppName", "setOpeningExternalApp",
  "fetchAccountExternalAppRoutes", "shipment", "setNotice", "Safari", "writeDiagnostic",
  `return (${page.slice(start, end).trim()});`,
);

function scenario(openResult: boolean | Error | (boolean | Error)[] = true, requestFailure = false, appName = "菜鸟") {
  let resolveTargets!: (targets: { kind: string; url: string }[]) => void;
  const route = new Promise<{ kind: string; url: string }[]>((resolve) => { resolveTargets = resolve; });
  const resolveRoute = (value: string) => resolveTargets(value ? [{ kind: "cainiao", url: value }] : []);
  const diagnostics: unknown[] = [];
  const ref: { current: AbortController | null } = { current: null };
  const busy: boolean[] = [];
  const notices: string[] = [];
  const opened: string[] = [];
  let requests = 0;
  const run = action(ref, appName, (value: boolean) => busy.push(value), async () => {
    requests++;
    if (requestFailure) throw new Error("synthetic request failure");
    return route;
  }, {}, (value: string) => notices.push(value), {
    async openURL(value: string) {
      opened.push(value);
      const result = Array.isArray(openResult) ? openResult[opened.length - 1] : openResult;
      if (result instanceof Error) throw result;
      return result;
    },
  }, (event: string, details: unknown) => diagnostics.push({ event, details })) as () => Promise<void>;
  return { run, resolveRoute, resolveTargets, diagnostics, ref, busy, notices, opened, requestCount: () => requests };
}

const uri = "cainiao://startapp/logistic?fixture=synthetic";
const repeated = scenario();
const first = repeated.run();
await repeated.run();
assert.equal(repeated.requestCount(), 1);
repeated.resolveRoute(uri);
await first;
assert.deepEqual(repeated.opened, [uri]);
assert.deepEqual(repeated.busy, [true, false]);

const cancelled = scenario();
const pending = cancelled.run();
cancelled.ref.current!.abort();
cancelled.resolveRoute(uri);
await pending;
assert.deepEqual(cancelled.opened, []);
assert.deepEqual(cancelled.notices, []);

const missing = scenario();
const missingTask = missing.run();
missing.resolveRoute("");
await missingTask;
assert.deepEqual(missing.opened, []);
assert.deepEqual(missing.notices, ["来源暂未提供可用的菜鸟 App 链接"]);

const unavailable = scenario(false);
const unavailableTask = unavailable.run();
unavailable.resolveRoute(uri);
await unavailableTask;
assert.deepEqual(unavailable.notices, ["未能打开菜鸟、淘宝或支付宝，请确认已安装其中一个 App"]);

for (const failed of [scenario(true, true)]) {
  const task = failed.run();
  failed.resolveRoute(uri);
  await task;
  assert.deepEqual(failed.notices, ["打开菜鸟失败，请重试"]);
  assert.deepEqual(failed.busy, [true, false]);
}

const targets = [
  { kind: "cainiao", url: uri },
  { kind: "taobao", url: "tbopen://m.taobao.com/tbopen/index.html?fixture=synthetic" },
  { kind: "alipay", url: "alipays://platformapi/startapp?fixture=synthetic" },
];
for (const [results, count] of [
  [[true], 1], [[false, true], 2], [[false, false, true], 3],
  [[new Error("synthetic native failure"), false, true], 3],
] as const) {
  const fallback = scenario([...results]);
  const task = fallback.run();
  fallback.resolveTargets(targets);
  await task;
  assert.deepEqual(fallback.opened, targets.slice(0, count).map((target) => target.url));
  assert.deepEqual(fallback.notices, []);
  assert.deepEqual(fallback.busy, [true, false]);
  assert.ok(!JSON.stringify(fallback.diagnostics).includes("://"), "no URI enters diagnostics");
}
const exhausted = scenario(false);
const exhaustedTask = exhausted.run();
exhausted.resolveTargets(targets);
await exhaustedTask;
assert.deepEqual(exhausted.opened, targets.map((target) => target.url));
assert.equal(exhausted.notices.length, 1, "report failure only after all Apps were tried");

for (const opened of [true, false]) {
  const sf = scenario(opened, false, "顺丰");
  const task = sf.run();
  const uri = "com.sf-express://order/detail?id=synthetic%2Bopaque";
  sf.resolveTargets([{ kind: "sf", url: uri }]);
  await task;
  assert.deepEqual(sf.opened, [uri]);
  assert.deepEqual(sf.notices, opened ? [] : ["无法打开顺丰 App，请确认已安装"]);
}
