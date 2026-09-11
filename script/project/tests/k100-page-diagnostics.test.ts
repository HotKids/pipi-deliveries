import { SCRIPT_CLIENT_BUILD } from "../services/build-track";
import assert from "node:assert/strict";
import { memory } from "./state-storage-mock";
import { scrapeWebTimeline, type WebTimelineDiagnostics } from "../services/web-timeline";
import { diagnosticText, readDiagnostics, setDiagnosticsEnabled, writeDiagnostic } from "../services/logger";

const withheld = "synthetic_private_page_value";
const actualNow = Date.now;
let now = actualNow();
Date.now = () => now;
try {
  for (const scene of [
    { name: "not loaded", main: false, ready: "loading", challenge: undefined, tracks: false, script: "", marker: "inline", vue: false, jquery: false },
    { name: "parser at ad", main: true, ready: "loading", challenge: undefined, tracks: false, script: "https://a.baidinet.com/common/hc/static/b/common/i/ubd/resource/di.js", marker: "baidinet", vue: false, jquery: false },
    { name: "parser at vue", main: true, ready: "loading", challenge: undefined, tracks: false, script: "https://cdn.kuaidi100.com/js/share/vue.js", marker: "vue", vue: false, jquery: true },
    { name: "phone challenge", main: true, ready: "complete", challenge: true, tracks: false, script: "https://cdn.kuaidi100.com/js/page/smart/query/result.js?version=2023121400001", marker: "result", vue: true, jquery: true },
    { name: "loaded empty", main: true, ready: "interactive", challenge: false, tracks: false, script: `https://example.invalid/${withheld}`, marker: "other", vue: true, jquery: true },
    { name: "timed tracks", main: true, ready: "complete", challenge: false, tracks: true, script: "https://cdn.kuaidi100.com/js/util/jquery-1.12.4.min.js", marker: "jquery", vue: true, jquery: true },
  ]) {
    const checkCode = { show: scene.challenge };
    Object.defineProperty(checkCode, "value", { enumerable: true, get() {
      assert.fail("diagnostics and extraction must not read the challenge value");
    } });
    const vue = { checkCode, $data: { lists: scene.tracks
      ? [{ time: "2026-09-09 18:51:23", context: "Parcel arrived" }] : [], checkCode } };
    const main = scene.main ? { __vue__: vue } : null;
    const snapshots: WebTimelineDiagnostics[] = [];
    let evaluations = 0;
    Object.assign(globalThis, { WebViewController: class {
      loadURL() { return new Promise<boolean>(() => {}); }
      async evaluateJavaScript(script: string) {
        evaluations++;
        const scriptNode = { src: scene.script, get textContent() { assert.fail("never read inline script text"); } };
        const document = { readyState: scene.ready,
          querySelector: (selector: string) => selector === "#main" ? main : null,
          querySelectorAll: (selector: string) => selector === "script" ? [scriptNode]
            : selector.split(",").includes("#main") && main ? [main] : [] };
        const result = new Function("window", "document", "location", script)(
          { Vue: scene.vue ? () => {} : undefined, jQuery: scene.jquery ? () => {} : undefined },
          document, { hostname: "m.kuaidi100.com", href: "https://m.kuaidi100.com/app/query/?nu=" });
        now += 10_001;
        return result;
      }
      dispose() {}
    } });
    const timeline = await scrapeWebTimeline({ waybill: "SF123456789012", courierCode: "SF", companyName: "Carrier" },
      snapshot => snapshots.push(snapshot));
    assert.equal(evaluations, 1);
    assert.equal(snapshots.length, 1, "only one final aggregate is emitted");
    assert.equal(snapshots[0]?.mainPresent, scene.main, scene.name);
    assert.equal(snapshots[0]?.phoneChallengeVisible, scene.challenge, scene.name);
    assert.equal(snapshots[0]?.readyState, scene.ready, scene.name);
    assert.equal(snapshots[0]?.timedTrackCount, scene.tracks ? 1 : 0, scene.name);
    assert.equal(snapshots[0]?.parsedScriptCount, 1, scene.name);
    assert.equal(snapshots[0]?.lastParsedScript, scene.marker, scene.name);
    assert.equal(snapshots[0]?.vuePresent, scene.vue, scene.name);
    assert.equal(snapshots[0]?.jqueryPresent, scene.jquery, scene.name);
    assert.equal(snapshots[0]?.phoneVerificationAttempted, false, "no tail means no verification attempt");
    assert.equal(snapshots[0]?.loadSettled, false, "document state is independent of the load callback");
    assert.equal(timeline?.tracks.length || 0, scene.tracks ? 1 : 0);
    assert.equal(JSON.stringify(snapshots).includes(withheld), false);
  }
} finally {
  Date.now = actualNow;
}

memory.clear();
setDiagnosticsEnabled(true);
writeDiagnostic("detail.refresh.stage_failed", { stage: "k100_h5", mainPresent: true,
  phoneChallengeVisible: true, readyState: "complete", timedTrackCount: 0,
  parsedScriptCount: 2, lastParsedScript: "baidinet", vuePresent: false, jqueryPresent: false } as never);
assert.deepEqual(readDiagnostics()[0]?.details, { clientBuild: SCRIPT_CLIENT_BUILD, stage: "k100_h5", mainPresent: true,
  phoneChallengeVisible: true, readyState: "complete", timedTrackCount: 0,
  parsedScriptCount: 2, lastParsedScript: "baidinet", vuePresent: false, jqueryPresent: false });
for (const invalidCount of [-1, 0.5, 101, NaN, Infinity, "2", withheld]) {
  memory.delete("pipi_deliveries_diagnostic_log_v1");
  writeDiagnostic("detail.refresh.stage_failed", { mainPresent: withheld, phoneChallengeVisible: withheld,
    phoneVerificationAttempted: withheld,
    parsedScriptCount: invalidCount, lastParsedScript: withheld, vuePresent: withheld, jqueryPresent: withheld,
    readyState: withheld, timedTrackCount: invalidCount,
    value: withheld, phone: withheld, url: withheld, body: withheld } as never);
  assert.deepEqual(readDiagnostics()[0]?.details, { clientBuild: SCRIPT_CLIENT_BUILD }, "page diagnostics accept only fixed scalar metadata");
  assert.equal(diagnosticText().includes(withheld), false);
}
console.log("K100 page-state extraction and diagnostic privacy tests passed");
