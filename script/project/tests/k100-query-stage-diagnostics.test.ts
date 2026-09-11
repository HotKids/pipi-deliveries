import { SCRIPT_CLIENT_BUILD } from "../services/build-track";
import assert from "node:assert/strict";
import { memory } from "./state-storage-mock";
import { scrapeWebTimeline } from "../services/web-timeline";
import { diagnosticText, readDiagnostics, setDiagnosticsEnabled, writeDiagnostic } from "../services/logger";

const waybill = "SF123456789012";
const withheld = "synthetic_private_page_value";
const actualNow = Date.now;
let now = actualNow();
Date.now = () => now;
try {
  for (const scene of [
    { name: "VM missing", absent: true, num: waybill, lastnum: undefined, com: "", loading: false, error: "empty", count: 0 },
    { name: "before query", num: waybill, lastnum: undefined, com: "", loading: false, error: "empty", count: 0 },
    { name: "recognition pending", num: waybill, lastnum: waybill, com: "", loading: true, error: "", count: 1 },
    { name: "query pending", num: waybill, lastnum: waybill, com: withheld, loading: true, error: "", count: 2 },
    { name: "query failed", num: waybill, lastnum: waybill, com: withheld, loading: false, error: "network", count: 2 },
    { name: "recognition failed", num: waybill, lastnum: waybill, com: "", loading: false, error: "none", count: 1 },
    { name: "wrong target and untrusted error", num: withheld, lastnum: withheld, com: "", loading: false, error: withheld, count: 101 },
  ]) {
    memory.clear();
    setDiagnosticsEnabled(true);
    const checkCode = { show: false };
    Object.defineProperty(checkCode, "value", { enumerable: true, get() { assert.fail("never inspect the phone input"); } });
    const pageVm = { num: scene.num, lastnum: scene.lastnum, com: scene.com, loading: scene.loading,
      autos: Array.from({ length: scene.count }, () => ({ comCode: withheld })),
      alllists: Array.from({ length: scene.count }, () => ({})),
      lists: Array.from({ length: scene.count }, () => ({})), errors: { type: scene.error, message: withheld }, checkCode };
    Object.assign(globalThis, { WebViewController: class {
      loadURL() { return new Promise<boolean>(() => {}); }
      async evaluateJavaScript(script: string) {
        const main = { __vue__: scene.absent ? undefined : pageVm };
        const document = { readyState: "interactive", querySelector: () => main,
          querySelectorAll: (selector: string) => selector === "script" ? [] : selector.includes("#main") ? [main] : [] };
        const result = new Function("window", "document", "location", script)(
          {}, document, { hostname: "m.kuaidi100.com", href: "https://m.kuaidi100.com/app/query/?nu=" + scene.num });
        now += 10_001;
        return result;
      }
      dispose() {}
    } });
    const timeline = await scrapeWebTimeline({ waybill, courierCode: "SF", companyName: "Carrier" },
      snapshot => writeDiagnostic("detail.refresh.stage_failed", { ...snapshot, stage: "k100_h5" }));
    assert.equal(timeline, null, scene.name);
    const details = readDiagnostics()[0]?.details;
    assert.equal(details.locationNuMatches, scene.num === waybill, scene.name);
    assert.equal(details.vmNumMatches, scene.absent ? undefined : scene.num === waybill, scene.name);
    assert.equal(details.lastQueriedNumMatches, scene.absent ? undefined : scene.lastnum === waybill, scene.name);
    assert.equal(details.vmLoading, scene.absent ? undefined : scene.loading, scene.name);
    assert.equal(details.carrierSelected, scene.absent ? undefined : Boolean(scene.com), scene.name);
    assert.equal(details.carrierCandidateCount, scene.absent ? undefined : Math.min(100, scene.count), scene.name);
    assert.equal(details.allListsCount, scene.absent ? undefined : Math.min(100, scene.count), scene.name);
    assert.equal(details.listsCount, scene.absent ? undefined : Math.min(100, scene.count), scene.name);
    assert.equal(details.queryErrorType, scene.absent || scene.error === withheld ? undefined : scene.error, scene.name);
    assert.equal(diagnosticText().includes(withheld), false);
    assert.equal(diagnosticText().includes(waybill), false);
  }
} finally {
  Date.now = actualNow;
}

for (const invalid of [-1, 0.5, 101, NaN, Infinity, "2", withheld]) {
  memory.clear();
  setDiagnosticsEnabled(true);
  writeDiagnostic("detail.refresh.stage_failed", {
    locationNuMatches: withheld, vmNumMatches: withheld, lastQueriedNumMatches: withheld,
    vmLoading: withheld, carrierSelected: withheld, carrierCandidateCount: invalid,
    allListsCount: invalid, listsCount: invalid, queryErrorType: withheld,
  } as never);
  assert.deepEqual(readDiagnostics()[0]?.details, { clientBuild: SCRIPT_CLIENT_BUILD }, "only fixed scalar metadata may enter the log");
}
console.log("K100 query-stage diagnostics and log privacy tests passed");
