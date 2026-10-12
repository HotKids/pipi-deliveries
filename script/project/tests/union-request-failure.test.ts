import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { unionRequestFailed } from "../services/account-sync-policy";

// 空壳判定补充（2026-09-25，与 Lite 同一口径）：京粉页的 union 请求回了非 2xx 或网络失败，这一页什么都证明不了——
// 与风控一样既不算空壳也不清零（判定见 empty-union-page.test.ts）。这里验证页面里的探针把失败记下来：fetch 回非 2xx
// 记它的状态码、被拒记 0；XMLHttpRequest 出错或超时记 0；页面自己中止的请求不算回答，什么都不记。

const source = readFileSync(new URL("../services/account-order-projection.ts", import.meta.url), "utf8");
const start = source.indexOf("function extractionJavaScript(");
const end = source.indexOf("export async function projectAccountOrder(", start);
const constantsStart = source.indexOf("const MAX_CAPTURED_URL_LENGTH");
const constantsEnd = source.indexOf("function object(", constantsStart);
assert.ok(start > 0 && end > start && constantsStart >= 0 && constantsEnd > constantsStart);
const script = runInNewContext(stripTypeScriptTypes(
  source.slice(constantsStart, constantsEnd) + source.slice(start, end),
) + `\nextractionJavaScript("1234567890123456", null);`);
const UNION = "https://api.m.jd.com/client.action?functionId=getUnionActivity";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type Ending = "load" | "error" | "timeout" | "abort";
class FakeXhr {
  status = 0;
  responseText = "{}";
  private readonly listeners = new Map<string, Array<() => void>>();
  open(): void {}
  send(): void {}
  getResponseHeader(): string { return ""; }
  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) || []), listener]);
  }
  end(ending: Ending, status: number): void {
    this.status = status;
    for (const name of [ending, "loadend"]) {
      for (const listener of this.listeners.get(name) || []) listener.call(this);
    }
  }
}

type PageWindow = { fetch: (url: string) => Promise<unknown>; XMLHttpRequest: typeof FakeXhr };

/** The union statuses the probe reports after the page made one request of its own. */
async function recordedStatuses(
  pageFetch: () => Promise<unknown>,
  request: (window: PageWindow) => void,
): Promise<string> {
  const window = {
    location: { href: "https://jingfen.jd.com/item" },
    innerWidth: 390,
    innerHeight: 844,
    performance: { getEntriesByType: () => [] },
    XMLHttpRequest: class extends FakeXhr {},
    fetch: pageFetch,
  };
  const context = {
    URL, AbortController, setTimeout, clearTimeout, window,
    document: {
      readyState: "complete", visibilityState: "visible", body: { innerText: "" },
      querySelector: () => null, querySelectorAll: () => [],
    },
  };
  const run = () => runInNewContext(`(async()=>{${script}})()`, context);
  await run();
  request(window as unknown as PageWindow);
  await tick();
  const snapshot = await run();
  return String(snapshot.unionResponseStatuses);
}

const answer = (status: number) => async () => ({
  status, headers: { get: () => "" }, clone: () => ({ text: async () => "{}" }),
});
const viaFetch = (window: PageWindow) => { void window.fetch(UNION).catch(() => {}); };
const viaXhr = (ending: Ending, status: number) => (window: PageWindow) => {
  const xhr = new window.XMLHttpRequest();
  (xhr.open as (method: string, url: string) => void)("POST", UNION);
  xhr.send();
  xhr.end(ending, status);
};

for (const [label, pageFetch, request, statuses, failed] of [
  ["fetch answered 200", answer(200), viaFetch, "200", false],
  ["fetch answered 502", answer(502), viaFetch, "502", true],
  ["fetch failed on the network", () => Promise.reject(new TypeError("Load failed")), viaFetch, "0", true],
  ["XMLHttpRequest answered 200", answer(200), viaXhr("load", 200), "200", false],
  ["XMLHttpRequest answered 500", answer(200), viaXhr("load", 500), "500", true],
  ["XMLHttpRequest error", answer(200), viaXhr("error", 0), "0", true],
  ["XMLHttpRequest timeout", answer(200), viaXhr("timeout", 0), "0", true],
  ["XMLHttpRequest aborted by the page", answer(200), viaXhr("abort", 0), "", false],
] as const) {
  const recorded = await recordedStatuses(pageFetch, request);
  assert.equal(recorded, statuses, label);
  assert.equal(unionRequestFailed(recorded), failed, `${label}: failed`);
}

// The page still sees its own failed fetch.
{
  let seen: unknown = null;
  await recordedStatuses(() => Promise.reject(new TypeError("Load failed")), (window) => {
    void window.fetch(UNION).catch((error: unknown) => { seen = error; });
  });
  assert.ok(seen instanceof TypeError, "the probe passes the rejection on to the page");
}

// User decision 2026-09-26 (其余裁决 4): the probe also reports union requests the page sent that had not
// answered yet. A request answered (any status), failed on the network or aborted by the page is no
// longer pending; one still in flight when the page is read is.
async function pendingAfter(
  pageFetch: () => Promise<unknown>,
  request: (window: PageWindow) => void,
): Promise<number> {
  const window = {
    location: { href: "https://jingfen.jd.com/item" }, innerWidth: 390, innerHeight: 844,
    performance: { getEntriesByType: () => [] }, XMLHttpRequest: class extends FakeXhr {}, fetch: pageFetch,
  };
  const context = {
    URL, AbortController, setTimeout, clearTimeout, window,
    document: { readyState: "complete", visibilityState: "visible", body: { innerText: "" },
      querySelector: () => null, querySelectorAll: () => [] },
  };
  const run = () => runInNewContext(`(async()=>{${script}})()`, context);
  await run();
  request(window as unknown as PageWindow);
  await tick();
  return Number((await run()).unionPendingCount);
}
const never = () => new Promise<unknown>(() => {});
const sendXhr = (ending: Ending | null, status: number) => (window: PageWindow) => {
  const xhr = new window.XMLHttpRequest();
  (xhr.open as (method: string, url: string) => void)("POST", UNION);
  xhr.send();
  if (ending) xhr.end(ending, status);
};
for (const [label, pageFetch, request, pending] of [
  ["fetch still in flight", never, viaFetch, 1],
  ["fetch answered", answer(200), viaFetch, 0],
  ["fetch failed on the network", () => Promise.reject(new TypeError("Load failed")), viaFetch, 0],
  ["XMLHttpRequest still in flight", answer(200), sendXhr(null, 0), 1],
  ["XMLHttpRequest answered", answer(200), sendXhr("load", 200), 0],
  ["XMLHttpRequest aborted by the page", answer(200), sendXhr("abort", 0), 0],
  ["no union request at all", answer(200), () => {}, 0],
] as const) {
  assert.equal(await pendingAfter(pageFetch, request), pending, label);
}

assert.equal(unionRequestFailed(""), false, "no union answer is not a failed answer");
assert.equal(unionRequestFailed("200,204"), false);
assert.equal(unionRequestFailed("200,403"), true);

console.log("union request failure probe tests passed");
