import assert from "node:assert/strict";
import {
  CAINIAO_H5_ASSET_BASELINE_VERSION,
  scrapeCainiaoH5Timeline,
  trustedCainiaoH5Route,
} from "../services/cainiao-h5";

const ROUTE =
  "https://page.cainiao.com/guoguo/app-myexpress-taobao/ld.html?secretKey=test-only";
const WAYBILL = "SF1234567890123";
const SUCCESS_AT_MS = Date.UTC(2026, 7, 30, 12, 0, 0);

assert.equal(CAINIAO_H5_ASSET_BASELINE_VERSION, "0.0.8");

assert.equal(trustedCainiaoH5Route(ROUTE), true);
assert.equal(
  trustedCainiaoH5Route("https://detail.taobao.com/express?id=1"),
  true,
);
assert.equal(trustedCainiaoH5Route("http://page.cainiao.com/detail"), false);
assert.equal(
  trustedCainiaoH5Route("https://page.cainiao.com.attacker.invalid/detail"),
  false,
);
assert.equal(trustedCainiaoH5Route("not-a-route"), false);
assert.equal(
  trustedCainiaoH5Route(`https://page.cainiao.com/detail?x=${"a".repeat(20_000)}`),
  false,
);

type RequestGuard = (request: {
  url: string;
  navigationType?: string;
}) => Promise<boolean>;

const body = {} as Record<string, unknown>;
const emptyDocument = {
  body,
  querySelector(selector: string): unknown {
    if (selector === ".package-status") return null;
    return null;
  },
  querySelectorAll(): unknown[] {
    return [];
  },
};

Object.assign(globalThis, {
  window: { location: { href: ROUTE } },
  document: emptyDocument,
});

let vueCreationOptions: unknown = null;
let vueDisposed = 0;
let vueEvaluations = 0;
let passiveHttpsAllowed: boolean | null = null;
let insecureRequestAllowed: boolean | null = null;
let activeUntrustedAllowed: boolean | null = null;
let activeTrustedAllowed: boolean | null = null;

class VueCainiaoWebView {
  shouldAllowRequest?: RequestGuard;

  constructor(options: unknown) {
    vueCreationOptions = options;
  }

  async loadURL(url: string): Promise<boolean> {
    assert.equal(url, ROUTE);
    passiveHttpsAllowed = await this.shouldAllowRequest?.({
      url: "https://cn.alicdn.com/cainiao/runtime.js",
      navigationType: "other",
    }) ?? null;
    insecureRequestAllowed = await this.shouldAllowRequest?.({
      url: "http://cn.alicdn.com/cainiao/runtime.js",
      navigationType: "other",
    }) ?? null;
    activeUntrustedAllowed = await this.shouldAllowRequest?.({
      url: "https://attacker.invalid/landing",
      navigationType: "linkActivated",
    }) ?? null;
    activeTrustedAllowed = await this.shouldAllowRequest?.({
      url: "https://detail.taobao.com/express",
      navigationType: "linkActivated",
    }) ?? null;
    return true;
  }

  async evaluateJavaScript<T>(source: string): Promise<T> {
    vueEvaluations++;
    new Function(source);
    assert.equal(source.includes(ROUTE), false);
    assert.equal(source.includes(WAYBILL), false);
    assert.equal(source.includes("secretKey"), false);
    if (vueEvaluations === 2) {
      body.__vue__ = {
        _data: {
          cpInfo: { statusDesc: "已签收" },
          feed: [{
            time: "2026-08-29 10:20:00",
            standerdDesc: "您的包裹已签收",
          }, {
            time: "2026-08-30 11:30:00",
            standerdDesc: "  快件已由本人签收  ",
          }, {
            time: "invalid",
            standerdDesc: "无效时间不会进入时间线",
          }],
        },
      };
    }
    return new Function(source)() as T;
  }

  dispose(): void {
    vueDisposed++;
  }
}

Object.assign(globalThis, { WebViewController: VueCainiaoWebView });
let vueDiagnostics: Parameters<NonNullable<Parameters<
  typeof scrapeCainiaoH5Timeline
>[1]>>[0] | null = null;
const vueTimeline = await scrapeCainiaoH5Timeline({
  routeUrl: ROUTE,
  waybill: WAYBILL,
  courierCode: "SF",
  companyName: "顺丰速运",
  successAtMs: SUCCESS_AT_MS,
  deadlineAtMs: Date.now() + 2_000,
}, (diagnostics) => {
  vueDiagnostics = diagnostics;
});

assert.deepEqual(vueCreationOptions, { ephemeral: true });
assert.equal(passiveHttpsAllowed, true);
assert.equal(insecureRequestAllowed, false);
assert.equal(activeUntrustedAllowed, false);
assert.equal(activeTrustedAllowed, true);
assert.equal(vueDisposed, 1);
assert.equal(vueTimeline?.provider, "web");
assert.equal(vueTimeline?.waybill, WAYBILL);
assert.equal(vueTimeline?.courierCode, "SF");
assert.equal(vueTimeline?.companyName, "顺丰速运");
assert.equal(vueTimeline?.semantic, "COMPLETED");
assert.equal(vueTimeline?.latestTimeText, "2026-08-30 11:30:00");
assert.equal(vueTimeline?.latestDetail, "快件已由本人签收");
assert.equal(vueTimeline?.tracks.length, 2);
assert.equal(vueTimeline?.successAtMs, SUCCESS_AT_MS);
assert.deepEqual(vueTimeline?.tracks[0]?.raw, {
  _pipiStatusSource: "web",
});
assert.equal(vueDiagnostics?.extractionSource, "vue");
assert.equal(vueDiagnostics?.routePresent, true);
assert.equal(vueDiagnostics?.routeTrusted, true);
assert.equal(vueDiagnostics?.waybillPresent, true);
assert.equal(vueDiagnostics?.rawTrackCount, 3);
assert.equal(vueDiagnostics?.validTrackCount, 2);
assert.equal(vueDiagnostics?.trackCount, 2);
assert.equal(vueDiagnostics?.exitReason, "timed_tracks");
assert.equal(vueDiagnostics?.evaluationAttempts, 2);
assert.equal(vueDiagnostics?.evaluationFailures, 0);

function domNode(values: Record<string, string>) {
  return {
    querySelector(selector: string): { textContent: string } | null {
      return selector in values ? { textContent: values[selector] } : null;
    },
  };
}

const statusNode = { textContent: "运输中" };
const domDocument = {
  body: {},
  querySelector(selector: string): unknown {
    if (selector === ".package-status") return statusNode;
    return null;
  },
  querySelectorAll(selector: string): unknown[] {
    if (selector !== ".feed-item") return [];
    return [domNode({
      ".feed-item_time": "08:09",
      ".feed-item_date": "2026-08-28",
      ".feed-item_content": "快件到达深圳转运中心",
    })];
  },
};
Object.assign(globalThis, { document: domDocument });

let domDisposed = 0;
class DomCainiaoWebView {
  shouldAllowRequest?: RequestGuard;

  async loadURL(): Promise<boolean> {
    return true;
  }

  async evaluateJavaScript<T>(source: string): Promise<T> {
    new Function(source);
    return new Function(source)() as T;
  }

  dispose(): void {
    domDisposed++;
  }
}

Object.assign(globalThis, { WebViewController: DomCainiaoWebView });
const domTimeline = await scrapeCainiaoH5Timeline({
  routeUrl: ROUTE,
  waybill: WAYBILL,
  courierCode: "SF",
  companyName: "顺丰速运",
  deadlineAtMs: Date.now() + 1_000,
});
assert.equal(domTimeline?.semantic, "TRANSIT");
assert.equal(domTimeline?.latestTimeText, "2026-08-28 08:09:00");
assert.equal(domTimeline?.latestDetail, "快件到达深圳转运中心");
assert.equal(domDisposed, 1);

let untrustedCreations = 0;
class MustNotCreateWebView {
  constructor() {
    untrustedCreations++;
  }
}
Object.assign(globalThis, { WebViewController: MustNotCreateWebView });
let rejectedRouteDiagnostics: Parameters<NonNullable<Parameters<
  typeof scrapeCainiaoH5Timeline
>[1]>>[0] | null = null;
assert.equal(await scrapeCainiaoH5Timeline({
  routeUrl: "https://cainiao.com.attacker.invalid/detail",
  waybill: WAYBILL,
  courierCode: "SF",
  companyName: "顺丰速运",
}, (diagnostics) => {
  rejectedRouteDiagnostics = diagnostics;
}), null);
assert.equal(untrustedCreations, 0);
assert.equal(rejectedRouteDiagnostics?.routePresent, true);
assert.equal(rejectedRouteDiagnostics?.routeTrusted, false);
assert.equal(rejectedRouteDiagnostics?.evaluationAttempts, 0);
assert.equal(rejectedRouteDiagnostics?.exitReason, "route_untrusted");

let failedLoadDisposed = 0;
class FailedLoadCainiaoWebView {
  shouldAllowRequest?: RequestGuard;

  loadURL(): Promise<boolean> {
    throw new Error("synthetic load failure");
  }

  async evaluateJavaScript<T>(): Promise<T> {
    throw new Error("evaluation must not run after a synchronous load failure");
  }

  dispose(): void {
    failedLoadDisposed++;
  }
}
Object.assign(globalThis, { WebViewController: FailedLoadCainiaoWebView });
assert.equal(await scrapeCainiaoH5Timeline({
  routeUrl: ROUTE,
  waybill: WAYBILL,
  courierCode: "SF",
  companyName: "顺丰速运",
}), null);
assert.equal(failedLoadDisposed, 1);

let timedOutDisposed = 0;
class TimedOutCainiaoWebView {
  shouldAllowRequest?: RequestGuard;

  loadURL(): Promise<boolean> {
    return new Promise<boolean>(() => {});
  }

  async evaluateJavaScript<T>(): Promise<T> {
    throw new Error("synthetic page-not-ready failure");
  }

  dispose(): void {
    timedOutDisposed++;
  }
}
Object.assign(globalThis, { WebViewController: TimedOutCainiaoWebView });
let timeoutDiagnostics: Parameters<NonNullable<Parameters<
  typeof scrapeCainiaoH5Timeline
>[1]>>[0] | null = null;
assert.equal(await scrapeCainiaoH5Timeline({
  routeUrl: ROUTE,
  waybill: WAYBILL,
  courierCode: "SF",
  companyName: "顺丰速运",
  deadlineAtMs: Date.now() + 20,
}, (diagnostics) => {
  timeoutDiagnostics = diagnostics;
}), null);
assert.equal((timeoutDiagnostics?.evaluationAttempts || 0) >= 1, true);
assert.equal((timeoutDiagnostics?.evaluationFailures || 0) >= 1, true);
assert.equal(timeoutDiagnostics?.rawTrackCount, 0);
assert.equal(timeoutDiagnostics?.validTrackCount, 0);
assert.equal(timeoutDiagnostics?.trackCount, 0);
assert.equal(timeoutDiagnostics?.exitReason, "deadline_exhausted");
assert.equal(timedOutDisposed, 1);

let cancelledEvaluations = 0;
let cancelledDisposed = 0;
let cancelledDiagnostics = 0;
class CancelledCainiaoWebView {
  shouldAllowRequest?: RequestGuard;

  async loadURL(): Promise<boolean> {
    return true;
  }

  evaluateJavaScript<T>(): Promise<T> {
    cancelledEvaluations++;
    return new Promise<T>(() => {});
  }

  dispose(): void {
    cancelledDisposed++;
  }
}

Object.assign(globalThis, { WebViewController: CancelledCainiaoWebView });
const cancelledController = new AbortController();
const cancelledTimeline = scrapeCainiaoH5Timeline({
  routeUrl: ROUTE,
  waybill: WAYBILL,
  courierCode: "SF",
  companyName: "顺丰速运",
  deadlineAtMs: Date.now() + 10_000,
  signal: cancelledController.signal,
}, () => {
  cancelledDiagnostics++;
});
await Promise.resolve();
assert.equal(cancelledEvaluations, 1);
cancelledController.abort();
await assert.rejects(
  cancelledTimeline,
  (error: unknown) => error instanceof Error && error.name === "OperationTimeoutError",
);
assert.equal(cancelledDisposed, 1);
assert.equal(cancelledDiagnostics, 0);
await new Promise<void>((resolve) => setTimeout(resolve, 20));
assert.equal(cancelledEvaluations, 1);

let blockedEvaluationDisposed = 0;
let blockedEvaluationDiagnostics = 0;
class BlockingCainiaoWebView {
  shouldAllowRequest?: RequestGuard;

  async loadURL(): Promise<boolean> {
    return true;
  }

  evaluateJavaScript<T>(): Promise<T> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 40) {
      // Simulate a native bridge that blocks JS timers past the parent deadline.
    }
    return Promise.resolve({
      extractionSource: "dom",
      statusText: "运输中",
      tracks: [{
        timeText: "2026-08-30 12:00:00",
        detail: "快件运输中",
      }],
    } as T);
  }

  dispose(): void {
    blockedEvaluationDisposed++;
  }
}

Object.assign(globalThis, { WebViewController: BlockingCainiaoWebView });
const blockedCainiaoController = new AbortController();
const blockedCainiaoAbort = setTimeout(
  () => blockedCainiaoController.abort(),
  5,
);
await assert.rejects(
  scrapeCainiaoH5Timeline({
    routeUrl: ROUTE,
    waybill: WAYBILL,
    courierCode: "SF",
    companyName: "顺丰速运",
    deadlineAtMs: Date.now() + 5,
    signal: blockedCainiaoController.signal,
  }, () => {
    blockedEvaluationDiagnostics++;
  }),
  (error: unknown) => error instanceof Error && error.name === "OperationTimeoutError",
);
await new Promise<void>((resolve) => setTimeout(resolve, 0));
clearTimeout(blockedCainiaoAbort);
assert.equal(blockedCainiaoController.signal.aborted, true);
assert.equal(blockedEvaluationDisposed, 1);
assert.equal(blockedEvaluationDiagnostics, 0);

console.log("Cainiao H5 timeline tests passed");
