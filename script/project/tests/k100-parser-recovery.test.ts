import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { k100StartupRecoveryJavaScript } from "../services/web-timeline";

const tag = '<script type="text/javascript" src="//a.baidinet.com/common/hc/static/b/common/i/ubd/resource/di.js"></script>';
const waybill = "SF123456789012";
const href = `https://m.kuaidi100.com/app/query/?nu=${waybill}`;
for (const scene of ["stalled", "healthy", "wrong-ticket", "missing-tag", "late-progress", "http-failed", "cancelled"]) {
  const window: any = {};
  let requests = 0, written = "", closed = false, pending: (() => void) | undefined;
  let loading = scene !== "healthy";
  const controller = new AbortController();
  const document = {
    get readyState() { return loading ? "loading" : "interactive"; },
    querySelector: () => ({}),
    querySelectorAll: () => [{ src: "" }, { src: "https://a.baidinet.com/common/hc/static/b/common/i/ubd/resource/di.js" }],
    open() {}, write(html: string) { written = html; }, close() { closed = true; },
  };
  const context = { window, document, location: { href: scene === "wrong-ticket" ? href + "OTHER" : href }, URL,
    AbortController: class { signal = controller.signal; abort() { controller.abort(); } },
    setTimeout, clearTimeout,
    fetch: async (url: string, options: any) => {
      assert.equal(url, href); assert.equal(options.redirect, "error"); requests++;
      if (scene === "cancelled") { await new Promise<void>(resolve => { pending = resolve; }); }
      if (scene === "late-progress") loading = false;
      return { ok: scene !== "http-failed", text: async () => `<html>${scene === "missing-tag" ? "" : tag}<script src="/query.js"></script></html>` };
    },
  };
  const script = `(function(){${k100StartupRecoveryJavaScript(waybill, 1000)}})()`;
  runInNewContext(script, context);
  if (scene === "cancelled") { controller.abort(); pending!(); }
  await new Promise(resolve => setImmediate(resolve));
  runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, scene === "healthy" || scene === "wrong-ticket" ? 0 : 1, `${scene}: one attempt per page`);
  assert.equal(closed, scene === "stalled", `${scene}: never replace a healthy, mismatched or cancelled page`);
  if (closed) {
    assert.equal(written.includes(tag), false);
    assert.ok(written.includes('<script src="/query.js"></script>'));
    assert.equal(window.__pipiK100StartupRecovery, "applied");
  }
}
console.log("K100 same-document parser recovery boundaries passed");

// Execute the actual capture loop, including its second-snapshot gate and normal phone form.
const { scrapeWebTimeline } = await import("../services/web-timeline");
let recovered = false, fetches = 0, loads = 0, disposed = 0, submitted = 0;
const window: any = {};
const vm: any = { num: waybill, checkCode: { show: true }, $data: { lists: [] }, doCheckCode() {
  submitted++; this.checkCode.show = false;
  this.$data.lists = [
    { time: "2026-09-10 11:39:00", context: "Parcel in transit" },
    { time: "2026-09-09 14:00:00", context: "顺丰速运 已收取快件" },
  ];
} };
Object.defineProperty(vm.checkCode, "value", { set(value) { assert.equal(value, "1234"); },
  get() { assert.fail("never read the entered phone value"); } });
const main: any = {};
const document = {
  get readyState() { return recovered ? "complete" : "loading"; },
  querySelector: (selector: string) => selector === "#main" ? main : null,
  querySelectorAll: (selector: string) => selector === "script"
    ? [{ src: "" }, { src: recovered ? "https://cdn.kuaidi100.com/js/page/smart/query/result.js"
      : "https://a.baidinet.com/common/hc/static/b/common/i/ubd/resource/di.js" }]
    : selector.split(",").includes("#main") ? [main] : [],
  open() {}, write(html: string) {
    assert.equal(html.includes(tag), false); recovered = true;
    main.__vue__ = vm; window.Vue = () => {}; window.jQuery = () => {};
  }, close() {},
};
Object.assign(globalThis, { WebViewController: class {
  loadURL(url: string) { loads++; assert.equal(url, href); return new Promise<boolean>(() => {}); }
  async evaluateJavaScript(script: string) {
    return runInNewContext(`(function(){${script}})()`, { window, document, location: { href, hostname: "m.kuaidi100.com" },
      URL, AbortController, setTimeout, clearTimeout,
      fetch: async (url: string) => { fetches++; assert.equal(url, href); return { ok: true, text: async () => `<html>${tag}</html>` }; },
    });
  }
  dispose() { disposed++; }
} });
let diagnostic: any;
const timeline = await scrapeWebTimeline({ waybill, courierCode: "SF", companyName: "Carrier", phoneTail: "1234", deadlineAtMs: Date.now() + 3000 },
  value => { diagnostic = value; });
assert.equal(timeline?.tracks.length, 2);
assert.equal(fetches, 1); assert.equal(loads, 1); assert.equal(disposed, 1); assert.equal(submitted, 1);
assert.equal(diagnostic.startupRecovery, "applied");
assert.equal(diagnostic.exitReason, "timed_tracks");
