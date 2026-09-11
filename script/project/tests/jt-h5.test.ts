import assert from "node:assert/strict";
import { jtH5JavaScript, primaryH5Provider, primaryH5Route, webPhoneTails } from "../services/jt-h5";
import { scrapeWebTimeline, webTimelineFromExtraction } from "../services/web-timeline";
import { mergeTimelineAuthorities, timelineCapability } from "../services/status";

const waybill = "JT1234567890123";
const route = primaryH5Route(waybill, "JTSD");
assert.equal(primaryH5Provider("JT"), "jt_h5");
assert.equal(primaryH5Provider("HTKY"), "k100_h5");
assert.equal(primaryH5Provider("SF"), "k100_h5");
assert.equal(new URL(route).origin, "https://jtsd.jtexpress.com.cn");
assert.deepEqual(webPhoneTails("1234", ["5678"]), ["1234"]);
assert.deepEqual(webPhoneTails("", ["5678", "5678", "12345", "abcd", "0123"]), ["5678", "0123"]);
assert.deepEqual(webPhoneTails("invalid", ["5678"]), []);

function scene(options: { url?: string; header?: string; challenge?: boolean; tails?: string[]; toast?: string } = {}) {
  const state: Record<string, unknown> = {};
  let submitted = 0;
  const input = { value: "", dispatchEvent() { submitted++; }, getClientRects: () => [1] };
  const row = (status: string, time: string, content: string) => ({ querySelector(selector: string) {
    if (selector === ".scdrl-left") return { textContent: status };
    if (selector === ".scdrlr-time") return { textContent: time };
    if (selector === ".scdrl-right") return { children: [
      { textContent: content, classList: { contains: () => false } },
      { textContent: time, classList: { contains: () => true } },
    ] };
    return null;
  } });
  const rows = [row("已签收", "2026-09-10 12:00", "Parcel delivered"), row("已揽件", "2026-09-09 10:00", "Parcel collected")];
  let toast = options.toast || "";
  let toastVisible = true;
  const document = {
    readyState: "complete",
    querySelector(selector: string) {
      if (selector === ".query-popup input.uni-input-input") return options.challenge ? input : null;
      if (selector === ".scft-left .cgsllt-right") return { textContent: options.header ?? waybill };
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === ".uni-toast__content") return [{ textContent: toast, getClientRects: () => toastVisible ? [1] : [] }];
      return selector === ".scd-route .scdr-list" ? rows : [];
    },
  };
  const read = () => new Function("window", "document", "location", "Event", jtH5JavaScript(waybill, options.tails || []))(
    state, document, new URL(options.url || route), class { constructor(_name: string, _options: unknown) {} },
  );
  return { read, input, get submitted() { return submitted; }, setToast(value: string) { toast = value; },
    showToast(visible: boolean) { toastVisible = visible; } };
}

const extracted = scene().read();
assert.equal(extracted.tracks.length, 2);
assert.equal(extracted.tracks[1].detail, "已揽件 Parcel collected");
assert.equal(scene({ header: "JT0000000000000" }).read().tracks.length, 0);
assert.equal(scene({ url: route + "&waybillNo=JT0000000000000" }).read().tracks.length, 0);
assert.equal(scene({ url: route.replace("jtexpress.com.cn", "example.invalid") }).read().tracks.length, 0);
assert.equal(scene({ challenge: true }).read().page.phoneFailure, "required");
const retry = scene({ challenge: true, tails: ["1234", "5678"] });
retry.read(); retry.read();
assert.equal(retry.submitted, 1, "polling must not resubmit an in-flight input");
retry.input.value = "";
retry.setToast("手机尾号不匹配");
retry.read();
retry.read();
assert.equal(retry.submitted, 1, "a previous warning must disappear before another candidate is submitted");
retry.showToast(false);
retry.read();
assert.equal(retry.submitted, 2);
retry.input.value = "";
assert.equal(retry.read().page.phoneFailure, undefined, "the old rejection cannot be reused");
retry.showToast(true);
assert.equal(retry.read().page.phoneFailure, "rejected");
const network = scene({ challenge: true, tails: ["1234", "5678"] });
network.read(); network.input.value = ""; network.setToast("网络异常，请稍后重试");
assert.equal(network.read().page.phoneFailure, undefined);
assert.equal(network.submitted, 1, "a service failure cannot authorize another suffix attempt");
assert.equal(JSON.stringify(retry.read()).includes("5678"), false);

const timeline = webTimelineFromExtraction(extracted, { waybill, courierCode: "JTSD", companyName: "J&T" }, 1);
assert.equal(timeline?.provider, "jt_h5");
assert.equal(timeline?.structuredStatus, false);
assert.equal(timeline?.tracks.length, 2);
assert.equal(timelineCapability("jt_h5"), "web");
assert.equal(timeline?.tracks.some(track => track.raw?._pipiKuaidi100Com), false);
assert.equal(timeline?.tracks[0].timeText, "2026-09-10 12:00:00");
const oldK100 = { ...timeline!, provider: "k100_h5", tracks: [
  { ...timeline!.tracks[0], detail: "Older K100 event" },
] };
const oldBytes = JSON.stringify(oldK100);
const packages = mergeTimelineAuthorities([oldK100], timeline!);
assert.equal(packages.length, 2);
assert.equal(JSON.stringify(packages.find(item => item.provider === "k100_h5")), oldBytes);
assert.deepEqual(packages.find(item => item.provider === "jt_h5")?.tracks, timeline!.tracks);

let disposed = false;
let attempted = false;
const page = scene();
Object.assign(globalThis, { WebViewController: class {
  constructor(options: { ephemeral: boolean }) { assert.equal(options.ephemeral, true); }
  async loadURL(url: string) { assert.equal(url, route); return true; }
  loadHTML() { assert.fail("JT must load its official page through the existing WebView lifecycle"); }
  async evaluateJavaScript(script: string) {
    assert.match(script, /scd-route/);
    return page.read();
  }
  dispose() { disposed = true; }
} });
const captured = await scrapeWebTimeline({ waybill, courierCode: "JTSD", companyName: "J&T",
  onQueryAttempted: authorized => { attempted = authorized; } });
assert.equal(captured?.provider, "jt_h5");
assert.equal(captured?.tracks.length, 2);
assert.equal(disposed, true);
assert.equal(attempted, true);
console.log("JT route, normal verification, phone outcomes and isolated package tests passed");
