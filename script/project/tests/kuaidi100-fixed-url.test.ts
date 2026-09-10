import assert from "node:assert/strict";
import "./k100-html-fetch-mock";
import { scrapeWebTimeline, type WebTimelineDiagnostics } from "../services/web-timeline";

const loaded: string[] = [];
const observations: WebTimelineDiagnostics[] = [];
let disposed = 0;
const vue = { $data: { lists: [
  { time: "2026-09-09 18:51:00", context: "Parcel arrived" },
  { time: "2026-09-08 18:59:00", context: "快件已揽收" },
] } };
let root = "#main";
Object.assign(globalThis, { WebViewController: class {
  async loadHTML(_html: string, url: string) { loaded.push(url); return true; }
  async evaluateJavaScript(script: string) {
    const document = { querySelector: (selector: string) => selector === root ? { __vue__: vue } : null,
      readyState: "complete", querySelectorAll: (selector: string) =>
      selector.split(",").includes(root) ? [{ __vue__: vue }] : [] };
    const result = new Function("window", "document", "location", script)(
      {}, document, { hostname: "m.kuaidi100.com" });
    assert.equal(result.tracks.length, 2, `the real extraction script reads the ${root} Vue data`);
    return result;
  }
  dispose() { disposed++; }
} });

const timeline = await scrapeWebTimeline({ waybill: " sf-123 456 ", courierCode: "SF", companyName: "Carrier" },
  diagnostics => observations.push(diagnostics));
assert.deepEqual(loaded, ["https://m.kuaidi100.com/app/query/?nu=SF123456"]);
assert.equal(timeline?.waybill, "SF123456");
assert.equal(timeline?.provider, "k100_h5", "changing the URL does not add or rename a provider slot");
assert.equal(timeline?.tracks.length, 2);
assert.equal(timeline?.structuredStatus, undefined, "page text does not become structured status evidence");
assert.equal(observations[0]?.exitReason, "timed_tracks");
assert.equal(disposed, 1);

assert.equal(await scrapeWebTimeline({ waybill: " - ", courierCode: "SF", companyName: "Carrier" }), null);
assert.equal(loaded.length, 1, "an empty normalized waybill must not open a page");
root = "#app";
const legacy = await scrapeWebTimeline({ waybill: "SF123456", courierCode: "SF", companyName: "Carrier" });
assert.deepEqual(legacy?.tracks, timeline?.tracks, "existing Vue page roots remain supported");
console.log("K100 fixed page URL and normalized-waybill tests passed");
