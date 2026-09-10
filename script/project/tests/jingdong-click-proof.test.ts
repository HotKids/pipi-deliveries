import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { projectAccountOrder, projectionFromUnionPayload } from "../services/account-order-projection";

const source = readFileSync(new URL("../services/account-order-projection.ts", import.meta.url), "utf8");
const start = source.indexOf("function extractionJavaScript(");
const end = source.indexOf("export async function projectAccountOrder(", start);
const constantsStart = source.indexOf("const MAX_CAPTURED_URL_LENGTH");
const constantsEnd = source.indexOf("function object(", constantsStart);
assert.ok(start > 0 && end > start && constantsStart >= 0 && constantsEnd > constantsStart);
const owner = "1234567890123456";
const script = runInNewContext(stripTypeScriptTypes(
  source.slice(constantsStart, constantsEnd) + source.slice(start, end),
) + `\nextractionJavaScript("${owner}", null);`);
const payload = JSON.stringify({ data: { floors: [{ element: { info: {
  waybillCode: "JD123456789012", expressCompanyName: "京东快递",
  traceList: [{ operateTime: "2026-09-08 12:00:00", operateMessage: "Synthetic transit" }],
} } }] } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function replay(transport: "fetch" | "xhr", synchronous: boolean, retry: boolean) {
  const pending: Array<() => void> = [];
  let failClick = true;
  let buttonVisible = false;
  class Xhr {
    responseText = payload;
    status = 200;
    complete = () => {};
    open() {}
    getResponseHeader() { return ""; }
    addEventListener(_name: string, listener: () => void) { this.complete = listener; }
    send() {
      if (synchronous) this.complete();
      else pending.push(() => this.complete());
    }
  }
  const window = {
    location: { href: "https://jd.com/synthetic" },
    performance: { getEntriesByType: () => [] },
    XMLHttpRequest: Xhr,
    fetch: () => new Promise((resolve) => pending.push(() => resolve({
      status: 200, headers: { get: () => "" }, clone: () => ({ text: async () => payload }),
    }))),
  };
  const context = { URL, window, document: {
    body: { innerText: "" }, querySelectorAll: () => [],
    querySelector: (selector: string) => selector === ".logistics-button" && buttonVisible ? {
      querySelector: () => ({ innerText: "完整物流进度 >" }),
      click: () => {
        if (transport === "fetch") (window.fetch as Function)("https://api.m.jd.com?functionId=getUnionActivity");
        else {
          const xhr = new window.XMLHttpRequest();
          (xhr.open as Function)("GET", "https://api.m.jd.com?functionId=getUnionActivity");
          xhr.send();
        }
        if (failClick) throw new Error("Synthetic click failure after request start");
      },
    } : null,
  } };
  const run = () => runInNewContext(`(async()=>{${script}})()`, context);
  await run();
  buttonVisible = true;
  const records = [await run()];
  if (retry) { failClick = false; records.push(await run()); }
  buttonVisible = false;
  for (const finish of pending) finish();
  await tick();
  records.push(await run(), await run());
  const packets = records.filter((record) => record.extractionSource === "probe");
  return packets.map((packet) => projectionFromUnionPayload({ data: { floors: [{ element: { info: {
    waybillCode: packet.waybillCode, expressCompanyName: packet.companyName, traceList: packet.traceList,
  } } }] } }, owner, "interface5", Date.now(), packet.fullProgressRequestedAtStart === true)?.timeline?.complete);
}

for (const transport of ["fetch", "xhr"] as const) {
  assert.deepEqual(await replay(transport, false, false), [false], `${transport}: failed click`);
  assert.deepEqual(await replay(transport, false, true), [false, true], `${transport}: later success cannot upgrade an earlier failed attempt`);
}
assert.deepEqual(await replay("xhr", true, false), [false], "synchronous XHR must await the click outcome");
assert.deepEqual(await replay("xhr", true, true), [false, true], "synchronous XHR from a successful click remains complete");
console.log("JingDong click proof: 6 request/click partitions passed");

// A synchronous network response must be considered before a shorter modal can end capture.
{
  const waybill = "JD123456789012";
  const networkPayload = JSON.stringify({ data: { floors: [{ element: { info: {
    waybillCode: waybill, expressCompanyName: "京东快递",
    traceList: [1, 2, 3].map((index) => ({
      operateTime: `2026-09-08 12:0${index}:00`, operateMessage: `Synthetic network ${index}`,
    })),
  } } }] } });
  let mounted = false;
  class Xhr {
    responseText = networkPayload;
    status = 200;
    complete = () => {};
    open() {}
    getResponseHeader() { return ""; }
    addEventListener(_name: string, listener: () => void) { this.complete = listener; }
    send() { this.complete(); }
  }
  const window = {
    location: { href: "https://jd.com/synthetic" },
    performance: { getEntriesByType: () => [] }, XMLHttpRequest: Xhr,
  };
  const row = { querySelector: (selector: string) => ({ innerText:
    selector === ".status-time" ? "2026-09-08 12:03:00"
      : selector === ".status-msg" ? "Synthetic modal one" : "",
  }) };
  const document = {
    body: { innerText: "" },
    querySelectorAll: (selector: string) => selector === ".logistics-status-info.child-status" && mounted ? [row] : [],
    querySelector: (selector: string) => {
      if (selector === ".logistics-button") return {
        querySelector: () => ({ innerText: "完整物流进度 >" }),
        click: () => {
          const xhr = new window.XMLHttpRequest();
          (xhr.open as Function)("GET", "https://api.m.jd.com?functionId=getUnionActivity");
          xhr.send();
          mounted = true;
        },
      };
      return selector === ".logistics-top-narrow" && mounted ? { innerText: "京东快递 " + waybill } : null;
    },
  };
  const context = { URL, window, document };
  const globals = globalThis as Record<string, unknown>;
  const originalController = globals.WebViewController;
  globals.WebViewController = class {
    async loadURL() { return true; }
    async evaluateJavaScript(source: string) {
      return await runInNewContext(`(async()=>{${source}})()`, context);
    }
    dispose() {}
  };
  try {
    const result = await projectAccountOrder({
      source: "interface5", ownerId: owner, waybill: owner, orderId: owner, accountOrder: true,
      courierCode: "JD", companyName: "京东购物", sourceProvider: "", sourceStateCode: "101",
      sourceStateText: "已下单", semantic: "ORDERED", receiverPhone: "", senderPhone: "",
      latestTimeText: "", latestDetail: "订单已创建", tracks: [], routeUrl: "",
      projectionUrl: "https://u.jd.com/synthetic",
    }, Date.now() + 1000);
    assert.equal(result.projectionTimeline?.tracks.length, 3,
      "A shorter modal cannot finish capture ahead of the already received network package");
    assert.equal(result.projectionTimeline?.complete, true);
  } finally {
    if (originalController === undefined) delete globals.WebViewController;
    else globals.WebViewController = originalController;
  }
}
console.log("JingDong synchronous network/modal selection passed");
