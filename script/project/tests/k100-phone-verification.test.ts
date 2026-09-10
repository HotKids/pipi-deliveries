import assert from "node:assert/strict";
import "./k100-html-fetch-mock";
import { scrapeWebTimeline, type WebTimelineDiagnostics } from "../services/web-timeline";

const waybill = "SF123456789012";
const tail = "7319";
const fixed = `https://m.kuaidi100.com/app/query/?nu=${waybill}`;
const actualNow = Date.now;
let now = actualNow();
Date.now = () => now;
try {
  for (const scene of [
    { name: "accepted", phoneTail: tail, url: fixed, show: true, accepted: true, calls: 1 },
    { name: "preview still challenged", phoneTail: tail, url: fixed, show: true, accepted: true, preview: true, calls: 1 },
    { name: "rejected", phoneTail: tail, url: fixed, show: true, accepted: false, calls: 1 },
    { name: "missing", phoneTail: "", url: fixed, show: true, calls: 0 },
    { name: "invalid", phoneTail: "12345", url: fixed, show: true, calls: 0 },
    { name: "non-numeric", phoneTail: "abcd", url: fixed, show: true, calls: 0 },
    { name: "no challenge", phoneTail: tail, url: fixed, show: false, calls: 0 },
    { name: "wrong host", phoneTail: tail, url: fixed.replace("m.kuaidi100.com", "example.invalid"), show: true, calls: 0 },
    { name: "wrong waybill", phoneTail: tail, url: fixed.replace(waybill, "SF000000000000"), show: true, calls: 0 },
    { name: "wrong page", phoneTail: tail, url: fixed.replace("/app/query/", "/result.jsp"), show: true, calls: 0 },
    { name: "insecure page", phoneTail: tail, url: fixed.replace("https:", "http:"), show: true, calls: 0 },
    { name: "ambiguous waybill", phoneTail: tail, url: fixed + "&nu=SF000000000000", show: true, calls: 0 },
    { name: "wrong Vue waybill", phoneTail: tail, url: fixed, show: true, vueWaybill: "SF000000000000", calls: 0 },
    { name: "missing Vue waybill", phoneTail: tail, url: fixed, show: true, vueWaybill: "", calls: 0 },
    { name: "submission throws", phoneTail: tail, url: fixed, show: true, throws: true, calls: 1 },
  ]) {
    let calls = 0;
    let writes = 0;
    let evaluations = 0;
    const checkCode = { show: scene.show };
    Object.defineProperty(checkCode, "value", { enumerable: true,
      get() { assert.fail("client code must not read back the verification input"); },
      set(value) { assert.equal(value, tail); writes++; },
    });
    const vue = { num: scene.vueWaybill ?? waybill, checkCode, $data: { lists: (scene.preview
      ? [{ time: "2026-09-08 18:59:00", context: "Partial preview" }] : []) as object[], checkCode }, doCheckCode() {
      calls++;
      if (scene.throws) throw new Error(tail);
      if (scene.accepted) this.$data.lists = [
        { time: "2026-09-09 18:51:23", context: "Parcel arrived" },
        { time: "2026-09-08 18:59:00", context: "快件已揽收" },
      ];
    } };
    const main = { __vue__: vue };
    const snapshots: WebTimelineDiagnostics[] = [];
    Object.assign(globalThis, { WebViewController: class {
      loadHTML(_html: string, url: string) { assert.equal(url, fixed); assert.equal(url.includes(tail), false); return new Promise<boolean>(() => {}); }
      async evaluateJavaScript(script: string) {
        evaluations++;
        now += evaluations >= 4 ? 10_001 : 1;
        const document = { readyState: "complete", querySelector: (selector: string) => selector === "#main" ? main : null,
          querySelectorAll: (selector: string) => selector.split(",").includes("#main") ? [main] : [] };
        const result = new Function("window", "document", "location", script)(
          {}, document, { hostname: new URL(scene.url).hostname, href: scene.url });
        assert.equal(JSON.stringify(result)?.includes(tail) || false, false, "evaluation results never contain the phone tail");
        return result;
      }
      dispose() {}
    } });
    const result = await scrapeWebTimeline({ waybill, courierCode: "SF", companyName: "Carrier", phoneTail: scene.phoneTail } as never,
      snapshot => snapshots.push(snapshot));
    assert.equal(calls, scene.calls, `${scene.name}: only the eligible normal page action is called, at most once`);
    assert.equal(writes, scene.calls, `${scene.name}: no input is written unless it can be submitted`);
    assert.equal(result?.tracks.length || 0, scene.accepted ? 2 : 0, scene.name);
    if (scene.calls) assert.equal(snapshots[0]?.phoneVerificationAttempted, true,
      "an attempt flag does not claim that the page accepted the tail");
    assert.equal(JSON.stringify(snapshots).includes(tail), false);
    assert.equal(JSON.stringify(result)?.includes(tail) || false, false);
  }
} finally {
  Date.now = actualNow;
}
console.log("K100 same-waybill normal phone verification tests passed");
