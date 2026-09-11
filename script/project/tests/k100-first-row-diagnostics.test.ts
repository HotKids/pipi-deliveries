import { SCRIPT_CLIENT_BUILD } from "../services/build-track";
import assert from "node:assert/strict";
import { memory } from "./state-storage-mock";
import { scrapeWebTimeline } from "../services/web-timeline";
import { diagnosticText, readDiagnostics, setDiagnosticsEnabled, writeDiagnostic } from "../services/logger";

const time = "2026-09-10 12:34:56";
const withheld = "synthetic_private_row_detail";
const actualNow = Date.now;
let now = actualNow();
Date.now = () => now;
try {
  const unreadableRow = {};
  Object.defineProperty(unreadableRow, "time", { get() { throw new Error("synthetic diagnostic getter failure"); } });
  for (const scene of [
    { name: "diagnostic getter fails", row: unreadableRow, hidden: true, raw: 0, present: [undefined, undefined, undefined] },
    { name: "missing_time", row: { context: withheld }, raw: 0, present: [false, false, true] },
    { name: "missing_detail", row: { time }, raw: 0, present: [true, false, false] },
    { name: "same_text", row: { time, context: time }, raw: 0, present: [true, false, true] },
    { name: "not_extracted", row: { time, context: withheld }, hidden: true, raw: 0, present: [true, false, true] },
    { name: "invalid_time", row: { time: "invalid", ftime: time, context: withheld }, raw: 1, present: [true, true, true] },
    { name: "provider_error", row: { time, context: "查无结果" }, raw: 1, present: [true, false, true] },
    { name: "valid", row: { ftime: time, context: withheld }, raw: 1, present: [false, true, true] },
    { name: "not_object", row: null, raw: 0, present: [false, false, false] },
  ]) {
    memory.clear();
    setDiagnosticsEnabled(true);
    const checkCode = { show: false };
    Object.defineProperty(checkCode, "value", { enumerable: true, get() { assert.fail("never read the private verification input"); } });
    const pageVm = { checkCode };
    Object.defineProperty(pageVm, "alllists", { value: [scene.row], enumerable: !scene.hidden });
    Object.assign(globalThis, { WebViewController: class {
      loadURL() { return new Promise<boolean>(() => {}); }
      async evaluateJavaScript(script: string) {
        const main = { __vue__: pageVm };
        const document = { readyState: "interactive", querySelector: () => main,
          querySelectorAll: (selector: string) => selector.includes("#main") ? [main] : [] };
        const result = new Function("window", "document", "location", script)(
          {}, document, { hostname: "m.kuaidi100.com", href: "https://m.kuaidi100.com/app/query/" });
        now += 10_001;
        return result;
      }
      dispose() {}
    } });
    const timeline = await scrapeWebTimeline({ waybill: "SF123456789012", courierCode: "SF", companyName: "Carrier" },
      snapshot => writeDiagnostic("detail.refresh.stage_failed", { ...snapshot, stage: "k100_h5" }));
    const details = readDiagnostics()[0]?.details;
    assert.equal(details.firstRowOutcome, scene.name === "diagnostic getter fails" ? undefined : scene.name);
    assert.equal(details.rawExtractedCount, scene.raw, scene.name);
    assert.deepEqual([details.firstTimePresent, details.firstFtimePresent, details.firstContextPresent], scene.present, scene.name);
    assert.equal(Boolean(timeline), scene.name === "valid", "diagnostics must preserve the existing filter result");
    assert.equal(diagnosticText().includes(withheld), false);
    assert.equal(diagnosticText().includes(time), false);
  }
} finally {
  Date.now = actualNow;
}

for (const invalid of [-1, 0.5, 101, NaN, Infinity, "2", withheld]) {
  memory.clear();
  setDiagnosticsEnabled(true);
  writeDiagnostic("detail.refresh.stage_failed", { rawExtractedCount: invalid, firstRowOutcome: withheld,
    firstTimePresent: withheld, firstFtimePresent: withheld, firstContextPresent: withheld,
    firstRowTrackIndex: 0, firstRow: { time, context: withheld } } as never);
  assert.deepEqual(readDiagnostics()[0]?.details, { clientBuild: SCRIPT_CLIENT_BUILD });
}
console.log("K100 first-row extraction outcomes and privacy tests passed");
