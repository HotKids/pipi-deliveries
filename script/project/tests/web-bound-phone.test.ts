import assert from "node:assert/strict";
import { scrapeWebTimeline } from "../services/web-timeline";
import { WebTimelinePhoneError } from "../services/jt-h5";

const waybill = "SF123456789012";
const actualNow = Date.now;
let now = actualNow();
Date.now = () => now;
try {
  for (const kind of ["retry", "explicit", "network", "unacknowledged"] as const) {
    let calls = 0, reads = 0, pending = false, disposed = false;
    const writes: string[] = [];
    const checkCode = { show: true };
    Object.defineProperty(checkCode, "value", {
      get() { assert.fail("verification input must not be read back"); },
      set(value: string) { writes.push(value); },
    });
    const vm = { num: waybill, checkCode, loading: false, errors: {type: ""},
      $data: {lists: [] as object[]},
      doCheckCode() { calls++; this.loading = kind !== "unacknowledged"; pending = true; },
    };
    const main = {__vue__: vm};
    Object.assign(globalThis, {WebViewController: class {
      async loadURL() { return true; }
      async evaluateJavaScript(script: string) {
        if (!script.includes("vm.doCheckCode();")) {
          reads++;
          now += reads > 5 ? 10_001 : 1;
          if (pending) {
            pending = false;
            vm.loading = false;
            if (kind === "network") vm.errors.type = "network";
            if (kind === "retry" && calls === 2) {
              checkCode.show = false;
              vm.$data.lists = [
                {time: "2026-09-10 12:00:00", context: "Parcel arrived"},
                {time: "2026-09-09 10:00:00", context: "快件已揽收"},
              ];
            }
          }
        }
        return new Function("window", "document", "location", script)({}, {
          readyState: "complete",
          querySelector: (selector: string) => selector === "#main" ? main : null,
          querySelectorAll: (selector: string) => selector.split(",").includes("#main") ? [main] : [],
        }, {hostname: "m.kuaidi100.com", href: `https://m.kuaidi100.com/app/query/?nu=${waybill}`});
      }
      dispose() { disposed = true; }
    }});
    let error: unknown;
    const result = await scrapeWebTimeline({waybill, courierCode: "SF", companyName: "Carrier",
      phoneTail: kind === "explicit" ? "1234" : "", phoneTails: ["1234", "5678"]})
      .catch(value => { error = value; return null; });
    assert.equal(calls, kind === "retry" ? 2 : 1, kind);
    assert.deepEqual(writes, kind === "retry" ? ["1234", "5678"] : ["1234"]);
    assert.equal(result?.tracks.length || 0, kind === "retry" ? 2 : 0);
    assert.equal(error instanceof WebTimelinePhoneError, kind === "explicit");
    assert.equal(disposed, true);
  }
} finally { Date.now = actualNow; }
console.log("Bound phone retries require a later confirmed K100 rejection; explicit input stays exclusive");
