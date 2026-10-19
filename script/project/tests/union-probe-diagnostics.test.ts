import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../services/account-order-projection.ts", import.meta.url), "utf8");
const start = source.indexOf("function extractionJavaScript(");
const end = source.indexOf("export async function projectAccountOrder(", start);
const constantsStart = source.indexOf("const MAX_CAPTURED_URL_LENGTH");
const constantsEnd = source.indexOf("function object(", constantsStart);
const script = runInNewContext(stripTypeScriptTypes(
  source.slice(constantsStart, constantsEnd) + source.slice(start, end),
) + '\nextractionJavaScript("1234567890123456", null);');
const UNION = "https://api.m.jd.com/client.action?functionId=getUnionActivity";
const BODY = JSON.stringify({ data: { waybillCode: "JD1234567890", traceList: [] } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function page(options: {
  body?: string; mime?: string; length?: string; readFails?: boolean;
  xhr?: boolean; xhrJson?: boolean; responseTypeThrows?: boolean;
  unrelated?: boolean; control?: boolean; earlierResource?: boolean;
} = {}) {
  class Xhr {
    status = 200;
    get responseType() {
      if (options.responseTypeThrows) throw new Error("synthetic metadata failure");
      return options.xhrJson ? "json" : "";
    }
    response = JSON.parse(BODY);
    get responseText() {
      if (options.xhrJson) throw new Error("InvalidStateError");
      return options.body ?? BODY;
    }
    private listeners: Record<string, Array<() => void>> = {};
    open(_method: string, _url: string) {}
    send() { for (const listener of this.listeners.loadend || []) listener.call(this); }
    addEventListener(name: string, listener: () => void) {
      (this.listeners[name] ||= []).push(listener);
    }
    getResponseHeader() { return options.mime ?? "application/json"; }
  }
  const originalResponse = {
    status: 200,
    headers: { get: (name: string) => name === "content-type"
      ? options.mime ?? "application/json" : options.length ?? "" },
    clone: () => ({ text: async () => {
      if (options.readFails) throw new Error("synthetic read failure");
      return options.body ?? BODY;
    } }),
  };
  const window = {
    location: { href: "https://jingfen.jd.com/item" },
    innerWidth: 390, innerHeight: 844, XMLHttpRequest: Xhr,
    performance: { getEntriesByType: () => options.earlierResource ? [{ name: UNION }] : [] },
    fetch: async (_url: string) => originalResponse,
  };
  const context = {
    URL, AbortController, setTimeout, clearTimeout, window,
    document: {
      readyState: "complete", visibilityState: "visible", body: { innerText: "" },
      querySelector: (selector: string) => options.control && selector === ".logistics-button"
        ? { querySelector: () => ({ innerText: "完整物流进度 >" }), click: () => {} }
        : null,
      querySelectorAll: () => [],
    },
  };
  const run = () => runInNewContext(`(async()=>{${script}})()`, context);
  await run();
  const url = options.unrelated ? "https://api.m.jd.com/unrelated" : UNION;
  if (options.xhr || options.xhrJson) {
    const xhr = new window.XMLHttpRequest();
    xhr.open("POST", url);
    xhr.send();
  } else {
    assert.equal(await window.fetch(url), originalResponse, "the page keeps its original response");
  }
  await tick();
  const result = await run();
  await tick();
  return { result, snapshot: await run() };
}

const success = await page();
assert.equal(success.snapshot.projectionProbeRevision, 3);
assert.equal(success.snapshot.unionFetchResponseCount, 1);
assert.equal(success.snapshot.unionBodyReadCount, 1);
assert.equal(success.snapshot.unionBodyAcceptedCount, 1,
  "accepted captures remain counted after the queue is drained");
assert.equal(success.result.waybillCode, "JD1234567890");

for (const [options, field] of [
  [{ body: "not JSON" }, "unionBodyParseFailureCount"],
  [{ body: '{"data":{}}' }, "unionBodyNoIdentityCount"],
  [{ readFails: true }, "unionBodyReadFailureCount"],
  [{ mime: "image/png" }, "unionBodyTypeRejectedCount"],
  [{ length: "1500001" }, "unionBodySizeRejectedCount"],
  [{ body: "x".repeat(1500001) }, "unionBodySizeRejectedCount"],
] as const) {
  const { snapshot } = await page(options);
  assert.equal(snapshot[field], 1, field);
  assert.equal(snapshot.unionBodyAcceptedCount, 0, `${field}: no accepted identity`);
  assert.equal(snapshot.unionResponseStatuses, "200", `${field}: HTTP success is independent`);
}
for (const body of ["null", "[]", "{}", "0", "false", '""', "callback(null)"]) {
  const { snapshot } = await page({ body });
  assert.equal(snapshot.unionBodyParseFailureCount, 0, "valid JSON/JSONP without an identity is not a parse failure");
  assert.equal(snapshot.unionBodyNoIdentityCount, 1);
}

const json = await page({ xhrJson: true });
assert.equal(json.snapshot.unionXhrResponseCount, 1);
assert.equal(json.snapshot.unionXhrJsonResponseCount, 1);
assert.equal(json.snapshot.unionBodyReadFailureCount, 1);
assert.equal(json.snapshot.unionBodyAcceptedCount, 0,
  "diagnostics do not substitute a new XHR reading path");
assert.equal(json.snapshot.unionResponseStatuses, "200");
const textXhr = await page({ xhr: true });
assert.equal(textXhr.snapshot.unionXhrResponseCount, 1);
assert.equal(textXhr.snapshot.unionXhrJsonResponseCount, 0);
assert.equal(textXhr.snapshot.unionBodyReadCount, 1);
assert.equal(textXhr.snapshot.unionBodyAcceptedCount, 1);
assert.equal(textXhr.result.waybillCode, "JD1234567890");
const metadataFailure = await page({ xhr: true, responseTypeThrows: true });
assert.equal(metadataFailure.result.waybillCode, "JD1234567890",
  "optional diagnostic metadata cannot interrupt the existing body reader");
assert.equal(metadataFailure.snapshot.unionBodyAcceptedCount, 1);

const unrelated = await page({ unrelated: true });
assert.equal(unrelated.snapshot.unionFetchResponseCount, 0);
assert.equal(unrelated.snapshot.unionBodyAcceptedCount, 0,
  "unrelated response captures do not become union response evidence");
const clicked = await page({ control: true, earlierResource: true });
assert.equal(clicked.snapshot.fullProgressControlSeen, true);
assert.equal(clicked.snapshot.fullProgressClicked, true);
assert.equal(clicked.snapshot.unionResourceBeforeProbe, true);
assert.equal(clicked.snapshot.domModalItemCount, 0);
assert.equal(clicked.snapshot.domModalHeaderPresent, false);
assert.equal(clicked.snapshot.domModalWaybillPresent, false);

const reported = JSON.stringify(json.snapshot);
for (const privateValue of ["InvalidStateError", UNION, BODY, "1234567890123456", "JD1234567890"]) {
  assert.equal(reported.includes(privateValue), false, "diagnostics contain no body, URL, identity or error text");
}
