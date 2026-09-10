import assert from "node:assert/strict";
import { scrapeWebTimeline, type WebTimelineDiagnostics } from "../services/web-timeline";

const route = "https://m.kuaidi100.com/app/query/?nu=SF123456789012";
const ad = '<script type="text/javascript" src="//a.baidinet.com/common/hc/static/b/common/i/ubd/resource/di.js"></script>';
const before = '<!doctype html><main id="main"></main>';
const after = '<input v-model.trim="checkCode.value"><script src="//cdn.kuaidi100.com/js/util/jquery-1.12.4.min.js"></script>' +
  '<script src="//cdn.kuaidi100.com/js/share/vue.js"></script><script src="//cdn.kuaidi100.com/js/page/smart/query/result.js"></script>';
const actualNow = Date.now;
const actualFetch = globalThis.fetch;
let now = actualNow();
Date.now = () => now;
try {
  for (const tag of [ad, "", ad.replace("di.js", "di.js?different=1"),
    ad.replace("//a.", "https://a."), ad.replace("di.js", "other.js"),
    ad.replace('type="text/javascript"', 'type="text/javascript" async'),
    ad.replace("a.baidinet.com", "a.baidinet.com.example.invalid")]) {
    let requests = 0;
    let loads = 0;
    let controllers = 0;
    let disposed = false;
    let startup = false;
    let finishLoad!: () => void;
    const started = new Promise<void>(resolve => { finishLoad = resolve; });
    const snapshots: WebTimelineDiagnostics[] = [];
    Object.assign(globalThis, { fetch: async (url: string, options: Record<string, any>) => {
      requests++;
      assert.equal(url, route);
      assert.equal(options.method, "GET");
      assert.equal(options.timeout, 8, "HTML fetch shares the existing capture budget");
      assert.equal(options.headers, undefined, "no copied cookies or invented user agent");
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(await options.handleRedirect({ url: "https://example.invalid/redirect" }), null);
      return { status: 200, ok: true, url: route, mimeType: "text/html", expectedContentLength: 1000,
        get cookies() { assert.fail("never inspect or seed response cookies"); },
        async text() { return before + tag + after; } };
    }, WebViewController: class {
      shouldAllowRequest?: (request: { url: string; navigationType: string }) => Promise<boolean>;
      constructor(options: unknown) { controllers++; assert.deepEqual(options, { ephemeral: true }); }
      async loadHTML(html: string, baseURL: string) {
        loads++;
        assert.equal(baseURL, route, "the original page identity and relative query URL are preserved");
        assert.equal(html, before + (tag === ad ? "" : tag) + after,
          "only the observed exact empty synchronous ad tag changes; dependencies and verification markup are byte-identical");
        assert.equal(await this.shouldAllowRequest!({ url: "http://example.invalid/", navigationType: "other" }), false);
        assert.equal(await this.shouldAllowRequest!({ url: "https://example.invalid/", navigationType: "linkActivated" }), false);
        assert.equal(await this.shouldAllowRequest!({ url: "https://cdn.kuaidi100.com/js/share/vue.js", navigationType: "other" }), true);
        startup = tag !== ad || !html.includes(ad);
        finishLoad();
        return true;
      }
      loadURL() { finishLoad(); return new Promise<boolean>(() => {}); }
      async evaluateJavaScript(script: string) {
        await started;
        now += 8001;
        const main = { __vue__: { lists: startup ? [
          { time: "2026-09-10 01:00:00", context: "Parcel arrived at facility" },
          { time: "2026-09-09 18:00:00", context: "已揽收" },
        ] : [] } };
        return new Function("window", "document", "location", script)({}, {
          readyState: startup ? "complete" : "loading",
          querySelector: () => main,
          querySelectorAll: (selector: string) => selector.includes("#main") ? [main] : [],
        }, new URL(route));
      }
      dispose() { disposed = true; }
    } });
    const timeline = await scrapeWebTimeline({ waybill: "sf123456789012", courierCode: "SF", companyName: "Carrier",
      deadlineAtMs: now + 8000 }, value => snapshots.push(value));
    assert.equal(requests, 1, "fetch the canonical HTML before WebView parser startup");
    assert.equal(loads, 1);
    assert.equal(controllers, 1);
    assert.equal(disposed, true);
    assert.equal(timeline?.tracks.length, 2, "the original extractor receives tracks after startup");
    assert.equal(snapshots[0]?.adScriptRemoved, tag === ad);
    assert.equal(snapshots[0]?.htmlFetchCompleted, true);
    assert.equal(JSON.stringify(snapshots).includes(route), false);
    assert.equal("adScriptBlocked" in snapshots[0]!, false, "retire the ineffective callback claim");
  }

  for (const scene of ["HTTP failure", "foreign URL", "wrong waybill", "wrong MIME", "large declared body",
    "large actual body", "late body", "body rejected", "parent abort", "stalled body"] as const) {
    let loads = 0;
    let evaluations = 0;
    let bodyReads = 0;
    let fetchSignal: AbortSignal | undefined;
    let disposed = false;
    const controller = new AbortController();
    const snapshots: WebTimelineDiagnostics[] = [];
    const bodyDeadline = now + (scene === "stalled body" ? 20 : 8000);
    Object.assign(globalThis, { fetch: async (_url: string, options: { signal: AbortSignal }) => {
      fetchSignal = options.signal;
      return {
        status: scene === "HTTP failure" ? 403 : 200,
        url: scene === "foreign URL" ? "https://example.invalid/" : scene === "wrong waybill" ? route + "0" : route,
        mimeType: scene === "wrong MIME" ? "application/json" : "text/html",
        expectedContentLength: scene === "large declared body" ? 65_537 : undefined,
        async text() {
          bodyReads++;
          if (scene === "late body") now = bodyDeadline + 1;
          if (scene === "body rejected") throw new Error("synthetic response content must not leak");
          if (scene === "parent abort") controller.abort();
          if (scene === "stalled body") return new Promise<string>(() => {});
          return scene === "large actual body" ? "x".repeat(65_537) : before + ad + after;
        },
      };
    }, WebViewController: class {
      async loadHTML() { loads++; return true; }
      async evaluateJavaScript() { evaluations++; return { tracks: [] }; }
      dispose() { disposed = true; }
    } });
    const pending = scrapeWebTimeline({ waybill: "SF123456789012", courierCode: "SF", companyName: "Carrier",
      deadlineAtMs: bodyDeadline, signal: controller.signal }, value => snapshots.push(value));
    if (scene === "parent abort") await assert.rejects(pending, { name: "OperationTimeoutError" });
    else assert.equal(await pending, null, scene);
    assert.equal(loads, 0, `${scene}: invalid or expired HTML never reaches WebKit`);
    assert.equal(evaluations, 0);
    assert.equal(disposed, true);
    assert.equal(fetchSignal?.aborted, true, "fetch and body work terminate at the boundary");
    assert.equal(snapshots[0]?.htmlFetchCompleted, false);
    assert.equal(snapshots[0]?.adScriptRemoved, false);
    assert.equal(JSON.stringify(snapshots).includes("synthetic response content"), false);
    if (["HTTP failure", "foreign URL", "wrong waybill", "wrong MIME", "large declared body"].includes(scene)) {
      assert.equal(bodyReads, 0, "invalid response metadata is rejected before body access");
    }
  }
} finally { Date.now = actualNow; globalThis.fetch = actualFetch; }
console.log("K100 bounded HTML startup tests passed");
