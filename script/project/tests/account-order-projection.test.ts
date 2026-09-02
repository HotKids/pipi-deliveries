import assert from "node:assert/strict";
import {
  projectAccountOrder,
  projectionFromUnionPayload,
} from "../services/account-order-projection";
import type { AccountParcelDto } from "../services/account-parser";

const ownerId = "1234567890123456";
const NOW = Date.UTC(2026, 7, 30, 8, 0, 0);

assert.deepEqual(
  projectionFromUnionPayload({
    data: {
      floors: [{
        element: {
          info: {
            waybillCode: "SF1234567890",
            expressCompanyName: "顺丰速运",
            traceList: [{ waybillCode: "SF1234567890" }],
          },
        },
      }],
    },
  }, ownerId),
  {
    waybill: "SF1234567890",
    courierCode: "SF",
    companyName: "顺丰速运",
  },
);

assert.deepEqual(
  projectionFromUnionPayload({
    data: {
      floors: [{
        element: {
          info: {
            waybillCode: "JD0256747737309",
            expressCompanyName: "京东物流",
          },
        },
      }],
    },
  }, ownerId),
  {
    waybill: "JD0256747737309",
    courierCode: "JD",
    companyName: "京东快递",
  },
);

assert.deepEqual(
  projectionFromUnionPayload({
    data: {
      floors: [{
        element: {
          info: {
            waybillCode: "SF0256747737309",
            expressCompanyName: "京东购物",
          },
        },
      }],
    },
  }, ownerId),
  {
    waybill: "SF0256747737309",
    courierCode: "",
    companyName: "快递",
  },
  "an order-stage label and waybill prefix are not authoritative carrier evidence",
);

assert.deepEqual(
  projectionFromUnionPayload({
    data: {
      floors: [{
        element: {
          info: {
            waybillCode: "UNKNOWN0256747737309",
            expressCompanyName: "京东购物",
          },
        },
      }],
    },
  }, ownerId),
  {
    waybill: "UNKNOWN0256747737309",
    courierCode: "",
    companyName: "快递",
  },
);

assert.deepEqual(
  projectionFromUnionPayload({
    data: {
      floors: [{
        element: {
          info: {
            waybillCode: "JD0256747737308",
            traceList: [],
          },
        },
      }],
    },
  }, ownerId),
  {
    waybill: "JD0256747737308",
    courierCode: "",
    companyName: "快递",
  },
  "a waybill prefix alone must not synthesize a carrier outside the authority table",
);

assert.deepEqual(
  projectionFromUnionPayload({
    data: {
      floors: [{
        element: {
          info: {
            waybillCode: ownerId,
            traceList: [{
              waybillCode: "ZTO9876543210",
              expressCompany: "中通快递",
            }],
          },
        },
      }],
    },
  }, ownerId),
  {
    waybill: "ZTO9876543210",
    courierCode: "ZTO",
    companyName: "中通快递",
  },
);

assert.equal(
  projectionFromUnionPayload({
    data: {
      floors: [{ element: { info: { waybillCode: ownerId } } }],
    },
  }, ownerId),
  null,
);
assert.equal(projectionFromUnionPayload({}, ownerId), null);

const timelineProjection = projectionFromUnionPayload({
  data: {
    floors: [{
      element: {
        info: {
          waybillCode: "JD0256747737308",
          expressCompanyName: "京东物流",
          traceList: [
            {
              waybillCode: "JD0256747737308",
              time: "2026-08-30 15:30:00",
              desc: "您的快件已签收",
              statusCode: "3",
            },
            {
              waybillCode: "JD0256747737308",
              time: "2026-08-30 12:00:00",
              desc: "快件运输中",
              statusCode: "0",
            },
            {
              waybillCode: "JD0256747737308",
              time: "2026-08-29 09:00:00",
              desc: "快件已揽收",
              statusCode: "0",
            },
          ],
        },
      },
    }],
  },
}, ownerId, "interface5", NOW, true);
assert.equal(timelineProjection?.timeline?.provider, "interface5");
assert.equal(timelineProjection?.timeline?.complete, true);
assert.equal(timelineProjection?.timeline?.semantic, "COMPLETED");
assert.equal(timelineProjection?.timeline?.latestDetail, "您的快件已签收");
assert.deepEqual(
  timelineProjection?.timeline?.tracks.map((track) => track.detail),
  ["您的快件已签收", "快件运输中", "快件已揽收"],
  "the JD H5 parser must retain the complete trace array rather than its latest visible row",
);
assert.equal(
  timelineProjection?.timeline?.tracks.every(
    (track) => track.raw._pipiStatusSource === "jingdong_h5",
  ),
  true,
  "every trace from the initial JD response must retain its automatic H5 origin",
);
assert.equal(timelineProjection?.timeline?.successAtMs, NOW);

assert.equal(
  projectionFromUnionPayload({
    data: {
      floors: [{
        element: {
          info: {
            waybillCode: "JD0256747737308",
            traceList: [
              {
                waybillCode: "JD0256747737308",
                time: "2026-08-30 15:30:00",
                desc: "您的快件已签收",
              },
              {
                waybillCode: "SF0000000000",
                time: "2026-08-30 16:00:00",
                desc: "另一票快件",
              },
            ],
          },
        },
      }],
    },
  }, ownerId, "interface5", NOW, true),
  null,
  "a mixed-waybill JD response must fail as one package instead of filtering foreign nodes",
);

assert.deepEqual(
  projectionFromUnionPayload({
    data: {
      floors: [{
        element: {
          info: {
            waybillCode: "UNKNOWN0256747737309",
            expressCompanyName: "顺丰同城服务",
          },
        },
      }],
    },
  }, ownerId),
  {
    waybill: "UNKNOWN0256747737309",
    courierCode: "",
    companyName: "顺丰同城服务",
  },
  "carrier names must use exact authoritative aliases rather than substrings",
);

assert.deepEqual(
  projectionFromUnionPayload(JSON.stringify({
    data: JSON.stringify({
      floors: [{
        element: {
          info: {
            waybillCode: ownerId,
            traceList: [{
              waybillCode: "SF1122334455667",
              cpName: "顺丰速运",
            }],
          },
        },
      }],
    }),
  }), ownerId),
  {
    waybill: "SF1122334455667",
    courierCode: "SF",
    companyName: "顺丰速运",
  },
);

assert.deepEqual(
  projectionFromUnionPayload({
    data: {
      orderTrack: {
        mailNo: ownerId,
        packageInfo: {
          waybillNo: "JDVA12345678901",
          logisticsCompanyName: "京东物流",
          trackList: [{
            waybillNo: "JDVA12345678901",
            time: "2026-08-30 16:00:00",
            context: "您的快件已签收",
          }],
        },
      },
    },
  }, ownerId, "interface5", NOW, true),
  {
    waybill: "JDVA12345678901",
    courierCode: "JD",
    companyName: "京东快递",
    timeline: {
      provider: "interface5",
      complete: true,
      structuredStatus: false,
      waybill: "JDVA12345678901",
      courierCode: "JD",
      companyName: "京东快递",
      semantic: "COMPLETED",
      statusEventAtMs: Date.UTC(2026, 7, 30, 8, 0, 0),
      latestTimeText: "2026-08-30 16:00:00",
      latestDetail: "您的快件已签收",
      tracks: [{
        timeText: "2026-08-30 16:00:00",
        timeMs: Date.UTC(2026, 7, 30, 8, 0, 0),
        detail: "您的快件已签收",
        statusCode: "",
        raw: { _pipiStatusSource: "jingdong_h5" },
      }],
      successAtMs: NOW,
    },
  },
  "legacy JD logistics payloads must map a nested waybill without accepting the order id",
);

const oneTrackSummary = {
  data: {
    floors: [{
      element: {
        info: {
          waybillCode: "JDVA12345678901",
          expressCompanyName: "京东物流",
          traceList: [{
            waybillCode: "JDVA12345678901",
            time: "2026-08-30 16:00:00",
            desc: "首屏摘要",
          }],
        },
      },
    }],
  },
};
assert.equal(
  projectionFromUnionPayload(
    oneTrackSummary,
    ownerId,
    "interface5",
    NOW,
    false,
  )?.timeline?.complete,
  false,
  "one pre-click summary track must remain partial",
);
assert.equal(
  projectionFromUnionPayload({
    data: {
      floors: [{
        element: {
          info: {
            waybillCode: "JDVA12345678901",
            expressCompanyName: "京东物流",
            traceList: [
              {
                waybillCode: "JDVA12345678901",
                time: "2026-08-30 16:00:00",
                desc: "首屏摘要一",
              },
              {
                waybillCode: "JDVA12345678901",
                time: "2026-08-30 15:00:00",
                desc: "首屏摘要二",
              },
            ],
          },
        },
      }],
    },
  }, ownerId, "interface5", NOW, false)?.timeline?.complete,
  false,
  "track count must not turn a pre-click response into a complete package",
);
assert.equal(
  projectionFromUnionPayload(
    oneTrackSummary,
    ownerId,
    "interface5",
    NOW,
    true,
  )?.timeline?.complete,
  true,
  "one valid track is complete when its response request started after the exact expand click",
);

function parcel(routeUrl: string): AccountParcelDto {
  return {
    source: "interface5",
    ownerId,
    waybill: ownerId,
    orderId: ownerId,
    accountOrder: true,
    courierCode: "JD",
    companyName: "京东购物",
    sourceProvider: "",
    sourceStateCode: "101",
    sourceStateText: "已下单",
    semantic: "ORDERED",
    receiverPhone: "",
    senderPhone: "",
    latestTimeText: "",
    latestDetail: "订单已创建",
    tracks: [],
    routeUrl: "",
    projectionUrl: routeUrl,
  };
}

let webViewCreations = 0;
let disposed = false;
let targetRequestAllowed: boolean | null = null;
let replayRequestAllowed: boolean | null = null;
let passiveResourceAllowed: boolean | null = null;
let activeNavigationAllowed: boolean | null = null;
let insecureResourceAllowed: boolean | null = null;
let undecodableRequestAllowed: boolean | null = null;
let evaluationCount = 0;

class DelayedProjectionWebView {
  shouldAllowRequest?: (request: {
    url: string;
    method: string;
    body?: {
      toUint8Array(): Uint8Array;
      toRawString(): string;
    } | null;
    headers: Record<string, string>;
    navigationType?: string;
  }) => Promise<boolean>;

  constructor() {
    webViewCreations++;
  }

  async loadURL(): Promise<boolean> {
    setTimeout(async () => {
      targetRequestAllowed = await this.shouldAllowRequest?.({
        url: "https://m.jd.com/client.action?payload=1",
        method: "POST",
        body: {
          toUint8Array: () => new Uint8Array([1]),
          toRawString: () => "%67%65%74%55%6E%69%6F%6E%41%63%74%69%76%69%74%79",
        },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Api-Eid-Token": "ephemeral-value",
          Cookie: "must-not-be-copied",
        },
        navigationType: "other",
      }) ?? null;
    }, 10);
    passiveResourceAllowed = await this.shouldAllowRequest?.({
      url: "https://static.example.invalid/runtime.js",
      method: "GET",
      headers: {},
      navigationType: "other",
    }) ?? null;
    activeNavigationAllowed = await this.shouldAllowRequest?.({
      url: "https://static.example.invalid/landing",
      method: "GET",
      headers: {},
      navigationType: "linkActivated",
    }) ?? null;
    insecureResourceAllowed = await this.shouldAllowRequest?.({
      url: "http://static.example.invalid/runtime.js",
      method: "GET",
      headers: {},
      navigationType: "other",
    }) ?? null;
    undecodableRequestAllowed = await this.shouldAllowRequest?.({
      url: "https://api.m.jd.com/client.action?functionId=getUnionActivity",
      method: "POST",
      body: {
        toUint8Array: () => { throw new Error("unavailable Data bridge"); },
        toRawString: () => { throw new Error("unavailable Data bridge"); },
      },
      headers: {},
      navigationType: "other",
    }) ?? null;
    return true;
  }

  async evaluateJavaScript(source: string): Promise<unknown> {
    evaluationCount++;
    // A mock return value must not hide a syntax error that the real WebView would reject before
    // executing the generated extraction program.
    new Function(source);
    if (!source.includes("getUnionActivity")) return null;
    assert.equal(source.includes("ephemeral-value"), true);
    assert.equal(source.includes("must-not-be-copied"), false);
    replayRequestAllowed = await this.shouldAllowRequest?.({
      url: "https://api.m.jd.com/client.action?functionId=getUnionActivity",
      method: "POST",
      body: {
        toUint8Array: () => new Uint8Array([1]),
        toRawString: () => "body=1",
      },
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Api-Eid-Token": "ephemeral-value",
      },
      navigationType: "other",
    }) ?? null;
    return {
      waybillCode: "SF9988776655",
      companyName: "顺丰速运",
      traceList: [{
        waybillCode: "SF9988776655",
        time: "2026-08-30 15:00:00",
        desc: "快件运输中",
      }],
      extractionSource: "probe",
      fullProgressRequestedAtStart: true,
    };
  }

  dispose(): void {
    disposed = true;
  }
}

Object.assign(globalThis, { WebViewController: DelayedProjectionWebView });

const untouched = parcel("https://example.com/detail");
assert.equal(await projectAccountOrder(untouched), untouched);
assert.equal(webViewCreations, 0);

const projected = await projectAccountOrder(parcel("https://u.jd.com/example"));
assert.equal(projected.waybill, "SF9988776655");
assert.equal(projected.courierCode, "SF");
assert.equal(projected.projectionTimeline?.tracks.length, 1);
assert.equal(projected.projectionTimeline?.latestDetail, "快件运输中");
assert.equal(targetRequestAllowed, true);
assert.equal(replayRequestAllowed, true);
assert.equal(passiveResourceAllowed, true);
assert.equal(activeNavigationAllowed, false);
assert.equal(insecureResourceAllowed, false);
assert.equal(undecodableRequestAllowed, true);
assert.equal(evaluationCount >= 2, true);
assert.equal(disposed, true);

let inPageProbeDisposed = false;
let inPageProbeEvaluationCount = 0;
const probePayload = JSON.stringify({
  data: {
    orderTrack: {
      mailNo: ownerId,
      packageInfo: {
        waybillNo: "YTO6677889900",
        expressCompanyName: "圆通速递",
        trackList: [{
          waybillNo: "YTO6677889900",
          time: "2026-08-30 16:00:00",
          context: "您的快件已签收",
        }],
      },
    },
  },
});
class ProbeXmlHttpRequest {
  open(): void {}
  send(): void {}
  addEventListener(): void {}
}
const pageWindow = {
  location: { href: "https://jingfen.jd.com/item" },
  innerWidth: 1,
  innerHeight: 1,
  performance: {
    getEntriesByType: () => [],
  },
  XMLHttpRequest: ProbeXmlHttpRequest,
  fetch: async () => ({
    ok: true,
    clone: () => ({ text: async () => probePayload }),
    text: async () => probePayload,
  }),
} as Record<string, unknown>;
const pageDocument = {
  readyState: "complete",
  visibilityState: "hidden",
  body: { innerText: "" },
  querySelector: (selector: string) => selector === ".logistics-button"
    ? {
      querySelector: (labelSelector: string) =>
        labelSelector === ".logistics-button-text"
          ? { innerText: "完整物流进度", textContent: "完整物流进度" }
          : null,
      click: () => {
        void (pageWindow.fetch as (url: string) => Promise<unknown>)(
          "https://api.m.jd.com/client.action?functionId=getUnionActivity",
        );
      },
    }
    : null,
  querySelectorAll: () => [],
};

class InPageProbeProjectionWebView {
  shouldAllowRequest?: DelayedProjectionWebView["shouldAllowRequest"];

  async loadURL(): Promise<boolean> {
    return true;
  }

  async evaluateJavaScript(source: string): Promise<unknown> {
    inPageProbeEvaluationCount++;
    return await new Function(source)();
  }

  dispose(): void {
    inPageProbeDisposed = true;
  }
}

const globalRecord = globalThis as Record<string, unknown>;
const hadWindow = Object.prototype.hasOwnProperty.call(globalRecord, "window");
const hadDocument = Object.prototype.hasOwnProperty.call(globalRecord, "document");
const originalWindow = globalRecord.window;
const originalDocument = globalRecord.document;
let probeDiagnostics: Parameters<NonNullable<Parameters<typeof projectAccountOrder>[2]>>[0] | null = null;
let inPageProjected: AccountParcelDto;
try {
  Object.assign(globalThis, {
    WebViewController: InPageProbeProjectionWebView,
    window: pageWindow,
    document: pageDocument,
  });
  inPageProjected = await projectAccountOrder(
    parcel("https://u.jd.com/in-page-probe"),
    Date.now() + 1_000,
    (diagnostics) => {
      probeDiagnostics = diagnostics;
    },
  );
} finally {
  if (hadWindow) globalRecord.window = originalWindow;
  else delete globalRecord.window;
  if (hadDocument) globalRecord.document = originalDocument;
  else delete globalRecord.document;
}
assert.equal(inPageProjected!.waybill, "YTO6677889900");
assert.equal(inPageProjected!.courierCode, "YTO");
assert.equal(inPageProjected!.projectionTimeline?.complete, true);
assert.equal(probeDiagnostics?.probeInstalled, true);
assert.equal(probeDiagnostics?.probeMatched, true);
assert.equal(probeDiagnostics?.unionSignalSeen, true);
assert.equal((probeDiagnostics?.probeRequestCount || 0) >= 1, true);
assert.equal(probeDiagnostics?.pageClass, "jd");
assert.equal(probeDiagnostics?.viewportAvailable, true);
assert.equal(inPageProbeDisposed, true);

function probeResponse(payload: string): {
  ok: true;
  headers: { get(name: string): string };
  clone(): { text(): Promise<string> };
  text(): Promise<string>;
} {
  return {
    ok: true,
    headers: {
      get: (name: string) => name.toLowerCase() === "content-type"
        ? "application/json"
        : "",
    },
    clone: () => ({ text: async () => payload }),
    text: async () => payload,
  };
}

const delayedSummaryPayload = JSON.stringify({
  data: {
    orderTrack: {
      packageInfo: {
        waybillNo: "JDVA13579246801",
        expressCompanyName: "京东物流",
        trackList: [{
          waybillNo: "JDVA13579246801",
          time: "2026-08-30 16:00:00",
          context: "延迟返回的首屏摘要",
        }],
      },
    },
  },
});
let resolveDelayedSummary: ((value: ReturnType<typeof probeResponse>) => void) | null = null;
let delayedSummaryStarted = false;
let delayedSummaryButtonClicks = 0;
let delayedSummaryEvaluations = 0;
const delayedSummaryWindow = {
  location: { href: "https://jingfen.jd.com/item" },
  innerWidth: 1,
  innerHeight: 1,
  performance: { getEntriesByType: () => [] },
  XMLHttpRequest: class {
    open(): void {}
    send(): void {}
    addEventListener(): void {}
  },
  fetch: () => new Promise<ReturnType<typeof probeResponse>>((resolve) => {
    resolveDelayedSummary = resolve;
  }),
} as Record<string, unknown>;
const delayedSummaryDocument = {
  readyState: "complete",
  visibilityState: "visible",
  body: { innerText: "" },
  querySelector: (selector: string) => {
    if (selector !== ".logistics-button") return null;
    if (!delayedSummaryStarted) {
      delayedSummaryStarted = true;
      void (delayedSummaryWindow.fetch as (url: string) => Promise<unknown>)(
        "https://api.m.jd.com/client.action?functionId=getUnionActivity",
      );
      setTimeout(() => resolveDelayedSummary?.(probeResponse(delayedSummaryPayload)), 10);
    }
    return {
      querySelector: (labelSelector: string) =>
        labelSelector === ".logistics-button-text"
          ? { innerText: "完整物流进度", textContent: "完整物流进度" }
          : null,
      click: () => {
        delayedSummaryButtonClicks++;
      },
    };
  },
  querySelectorAll: () => [],
};
class DelayedPreClickProjectionWebView {
  async loadURL(): Promise<boolean> {
    return true;
  }

  async evaluateJavaScript(source: string): Promise<unknown> {
    delayedSummaryEvaluations++;
    return await new Function(source)();
  }

  dispose(): void {}
}
let delayedPreClickProjection: AccountParcelDto;
try {
  Object.assign(globalThis, {
    WebViewController: DelayedPreClickProjectionWebView,
    window: delayedSummaryWindow,
    document: delayedSummaryDocument,
  });
  delayedPreClickProjection = await projectAccountOrder(
    parcel("https://u.jd.com/delayed-summary"),
    Date.now() + 100,
  );
} finally {
  if (hadWindow) globalRecord.window = originalWindow;
  else delete globalRecord.window;
  if (hadDocument) globalRecord.document = originalDocument;
  else delete globalRecord.document;
}
assert.equal(delayedPreClickProjection!.projectionTimeline?.complete, false);
assert.equal(
  delayedPreClickProjection!.projectionTimeline?.latestDetail,
  "延迟返回的首屏摘要",
);
assert.equal(delayedSummaryButtonClicks, 1);
assert.equal(delayedSummaryEvaluations >= 2, true);

let delayedXhrStarted = false;
class DelayedPreClickXmlHttpRequest {
  responseText = delayedSummaryPayload;
  private loadEnd: (() => void) | null = null;

  open(..._args: unknown[]): void {}

  send(..._args: unknown[]): void {
    setTimeout(() => this.loadEnd?.(), 10);
  }

  addEventListener(name: string, listener: () => void): void {
    if (name === "loadend") this.loadEnd = listener;
  }

  getResponseHeader(name: string): string {
    return name.toLowerCase() === "content-type" ? "application/json" : "";
  }
}
const delayedXhrWindow = {
  location: { href: "https://jingfen.jd.com/item" },
  innerWidth: 1,
  innerHeight: 1,
  performance: { getEntriesByType: () => [] },
  XMLHttpRequest: DelayedPreClickXmlHttpRequest,
  fetch: async () => probeResponse("{}"),
} as Record<string, unknown>;
const delayedXhrDocument = {
  readyState: "complete",
  visibilityState: "visible",
  body: { innerText: "" },
  querySelector: (selector: string) => {
    if (selector !== ".logistics-button") return null;
    if (!delayedXhrStarted) {
      delayedXhrStarted = true;
      const request = new DelayedPreClickXmlHttpRequest();
      request.open(
        "GET",
        "https://api.m.jd.com/client.action?functionId=getUnionActivity",
      );
      request.send();
    }
    return {
      querySelector: (labelSelector: string) =>
        labelSelector === ".logistics-button-text"
          ? { innerText: "完整物流进度", textContent: "完整物流进度" }
          : null,
      click: () => {},
    };
  },
  querySelectorAll: () => [],
};
class DelayedPreClickXhrProjectionWebView {
  async loadURL(): Promise<boolean> {
    return true;
  }

  async evaluateJavaScript(source: string): Promise<unknown> {
    return await new Function(source)();
  }

  dispose(): void {}
}
let delayedPreClickXhrProjection: AccountParcelDto;
try {
  Object.assign(globalThis, {
    WebViewController: DelayedPreClickXhrProjectionWebView,
    window: delayedXhrWindow,
    document: delayedXhrDocument,
  });
  delayedPreClickXhrProjection = await projectAccountOrder(
    parcel("https://u.jd.com/delayed-xhr-summary"),
    Date.now() + 100,
  );
} finally {
  if (hadWindow) globalRecord.window = originalWindow;
  else delete globalRecord.window;
  if (hadDocument) globalRecord.document = originalDocument;
  else delete globalRecord.document;
}
assert.equal(
  delayedPreClickXhrProjection!.projectionTimeline?.complete,
  false,
  "XHR must freeze the pre-click state when send starts, not when its response finishes",
);

const firstPartialPayload = JSON.stringify({
  data: {
    orderTrack: {
      packageInfo: {
        waybillNo: "JDVA24680135791",
        expressCompanyName: "京东物流",
        trackList: [{
          waybillNo: "JDVA24680135791",
          time: "2026-08-30 15:00:00",
          context: "第一份独立回包",
        }],
      },
    },
  },
});
const secondPartialPayload = JSON.stringify({
  data: {
    orderTrack: {
      packageInfo: {
        waybillNo: "JDVA24680135791",
        expressCompanyName: "京东物流",
        trackList: [{
          waybillNo: "JDVA24680135791",
          time: "2026-08-30 16:00:00",
          context: "第二份独立回包",
        }],
      },
    },
  },
});
let partialRequestsStarted = false;
let partialResponseIndex = 0;
const separateResponsesWindow = {
  location: { href: "https://jingfen.jd.com/item" },
  innerWidth: 1,
  innerHeight: 1,
  performance: { getEntriesByType: () => [] },
  XMLHttpRequest: class {
    open(): void {}
    send(): void {}
    addEventListener(): void {}
  },
  fetch: async () => probeResponse(
    partialResponseIndex++ === 0 ? firstPartialPayload : secondPartialPayload,
  ),
} as Record<string, unknown>;
const separateResponsesDocument = {
  readyState: "complete",
  visibilityState: "visible",
  body: { innerText: "" },
  querySelector: (selector: string) => {
    if (selector !== ".logistics-button") return null;
    if (!partialRequestsStarted) {
      partialRequestsStarted = true;
      void (separateResponsesWindow.fetch as (url: string) => Promise<unknown>)(
        "https://api.m.jd.com/client.action?functionId=getUnionActivity&part=1",
      );
      void (separateResponsesWindow.fetch as (url: string) => Promise<unknown>)(
        "https://api.m.jd.com/client.action?functionId=getUnionActivity&part=2",
      );
    }
    return {
      querySelector: (labelSelector: string) =>
        labelSelector === ".logistics-button-text"
          ? { innerText: "完整物流进度", textContent: "完整物流进度" }
          : null,
      click: () => {},
    };
  },
  querySelectorAll: () => [],
};
class SeparateResponsesProjectionWebView {
  async loadURL(): Promise<boolean> {
    return true;
  }

  async evaluateJavaScript(source: string): Promise<unknown> {
    return await new Function(source)();
  }

  dispose(): void {}
}
let separateResponseProjection: AccountParcelDto;
try {
  Object.assign(globalThis, {
    WebViewController: SeparateResponsesProjectionWebView,
    window: separateResponsesWindow,
    document: separateResponsesDocument,
  });
  separateResponseProjection = await projectAccountOrder(
    parcel("https://u.jd.com/separate-responses"),
    Date.now() + 100,
  );
} finally {
  if (hadWindow) globalRecord.window = originalWindow;
  else delete globalRecord.window;
  if (hadDocument) globalRecord.document = originalDocument;
  else delete globalRecord.document;
}
assert.equal(separateResponseProjection!.projectionTimeline?.complete, false);
assert.equal(separateResponseProjection!.projectionTimeline?.tracks.length, 1);
assert.deepEqual(
  separateResponseProjection!.projectionTimeline?.tracks.map((track) => track.detail),
  ["第二份独立回包"],
  "separate responses must be selected whole and never merged into a synthetic timeline",
);

let resourceReplayDisposed = false;
const resourceReplayPayload = JSON.stringify({
  data: {
    floors: [{
      element: {
        info: {
          traceList: [{
            waybillCode: "ZTO2244668800",
            cpName: "中通快递",
          }],
        },
      },
    }],
  },
});
class ResourceReplayXmlHttpRequest {
  open(): void {}
  send(): void {}
  addEventListener(): void {}
}
const resourceReplayWindow = {
  location: { href: "https://jingfen.jd.com/item" },
  innerWidth: 1,
  innerHeight: 1,
  performance: {
    getEntriesByType: () => [{
      name: "https://api.jdcloud.com/client.action?functionId=getUnionActivity",
    }],
  },
  XMLHttpRequest: ResourceReplayXmlHttpRequest,
  fetch: async () => ({
    ok: true,
    clone: () => ({ text: async () => resourceReplayPayload }),
    text: async () => resourceReplayPayload,
  }),
} as Record<string, unknown>;
class ResourceReplayProjectionWebView {
  shouldAllowRequest?: DelayedProjectionWebView["shouldAllowRequest"];

  async loadURL(): Promise<boolean> {
    return true;
  }

  async evaluateJavaScript(source: string): Promise<unknown> {
    return await new Function(source)();
  }

  dispose(): void {
    resourceReplayDisposed = true;
  }
}
let resourceReplayDiagnostics: Parameters<NonNullable<Parameters<typeof projectAccountOrder>[2]>>[0] | null = null;
let resourceReplayProjected: AccountParcelDto;
try {
  Object.assign(globalThis, {
    WebViewController: ResourceReplayProjectionWebView,
    window: resourceReplayWindow,
    document: pageDocument,
  });
  resourceReplayProjected = await projectAccountOrder(
    parcel("https://u.jd.com/resource-replay"),
    Date.now() + 1_000,
    (diagnostics) => {
      resourceReplayDiagnostics = diagnostics;
    },
  );
} finally {
  if (hadWindow) globalRecord.window = originalWindow;
  else delete globalRecord.window;
  if (hadDocument) globalRecord.document = originalDocument;
  else delete globalRecord.document;
}
assert.equal(resourceReplayProjected!.waybill, "ZTO2244668800");
assert.equal(resourceReplayDiagnostics?.unionResourceSeen, true);
assert.equal(resourceReplayDiagnostics?.replayAttempted, true);
assert.equal(resourceReplayDiagnostics?.replaySucceeded, true);
assert.equal(
  resourceReplayDiagnostics?.probeMatched,
  false,
  "a manual resource replay is not a response caused by the full-progress click",
);
assert.equal(resourceReplayDisposed, true);

let emptyDisposed = false;
class EmptyProjectionWebView {
  shouldAllowRequest?: DelayedProjectionWebView["shouldAllowRequest"];

  async loadURL(): Promise<boolean> {
    return true;
  }

  async evaluateJavaScript(): Promise<unknown> {
    return null;
  }

  dispose(): void {
    emptyDisposed = true;
  }
}

Object.assign(globalThis, { WebViewController: EmptyProjectionWebView });
let timeoutDiagnostics: Parameters<NonNullable<Parameters<typeof projectAccountOrder>[2]>>[0] | null = null;
const timeoutProjectionController = new AbortController();
await assert.rejects(
  projectAccountOrder(
    parcel("https://u.jd.com/empty"),
    Date.now() + 15,
    (diagnostics) => {
      timeoutDiagnostics = diagnostics;
    },
    timeoutProjectionController.signal,
  ),
  (error: unknown) => error instanceof Error && error.name === "OperationTimeoutError",
);
assert.equal(emptyDisposed, true);
assert.equal(timeoutDiagnostics?.loadCompleted, true);
assert.equal(timeoutDiagnostics?.captureSeen, false);

let pendingLoadDisposed = false;
let pendingLoadRequestObserved = false;
class PendingLoadProjectionWebView {
  shouldAllowRequest?: DelayedProjectionWebView["shouldAllowRequest"];

  loadURL(): Promise<boolean> {
    setTimeout(async () => {
      await this.shouldAllowRequest?.({
        url: "https://api.m.jd.com/client.action?functionId=getUnionActivity",
        method: "POST",
        body: {
          toUint8Array: () => new Uint8Array([1]),
          toRawString: () => "body=1",
        },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Api-Eid-Token": "ephemeral-value",
        },
        navigationType: "other",
      });
      pendingLoadRequestObserved = true;
    }, 10);
    return new Promise<boolean>(() => {});
  }

  async evaluateJavaScript(source: string): Promise<unknown> {
    new Function(source);
    if (!pendingLoadRequestObserved || !source.includes("getUnionActivity")) return null;
    return {
      waybillCode: "ZTO5566778899",
      companyName: "中通快递",
      extractionSource: "replay",
    };
  }

  dispose(): void {
    pendingLoadDisposed = true;
  }
}

Object.assign(globalThis, { WebViewController: PendingLoadProjectionWebView });
let pendingLoadDiagnostics: Parameters<NonNullable<Parameters<typeof projectAccountOrder>[2]>>[0] | null = null;
const projectedBeforeLoadSettled = await projectAccountOrder(
  parcel("https://u.jd.com/pending"),
  Date.now() + 1_000,
  (diagnostics) => {
    pendingLoadDiagnostics = diagnostics;
  },
);
assert.equal(projectedBeforeLoadSettled.waybill, "ZTO5566778899");
assert.equal(pendingLoadDiagnostics?.loadSettled, false);
assert.equal(pendingLoadDiagnostics?.loadCompleted, false);
assert.equal(pendingLoadDiagnostics?.captureSeen, true);
assert.equal(pendingLoadDiagnostics?.replayAttempted, true);
assert.equal(pendingLoadDiagnostics?.replaySucceeded, true);
assert.equal((pendingLoadDiagnostics?.evaluationAttempts || 0) >= 2, true);
assert.equal(pendingLoadDisposed, true);

let pendingEmptyDisposeCount = 0;
class PendingEmptyProjectionWebView {
  shouldAllowRequest?: DelayedProjectionWebView["shouldAllowRequest"];

  loadURL(): Promise<boolean> {
    return new Promise<boolean>(() => {});
  }

  async evaluateJavaScript(): Promise<unknown> {
    return null;
  }

  dispose(): void {
    pendingEmptyDisposeCount++;
  }
}

Object.assign(globalThis, { WebViewController: PendingEmptyProjectionWebView });
let pendingEmptyDiagnostics: Parameters<NonNullable<Parameters<typeof projectAccountOrder>[2]>>[0] | null = null;
await assert.rejects(
  projectAccountOrder(
    parcel("https://u.jd.com/pending-empty"),
    Date.now() + 20,
    (diagnostics) => {
      pendingEmptyDiagnostics = diagnostics;
    },
  ),
  (error: unknown) => error instanceof Error && error.name === "OperationTimeoutError",
);
assert.equal(pendingEmptyDiagnostics?.loadSettled, false);
assert.equal(pendingEmptyDiagnostics?.loadCompleted, false);
assert.equal(pendingEmptyDiagnostics?.captureSeen, false);
assert.equal((pendingEmptyDiagnostics?.evaluationAttempts || 0) >= 1, true);
assert.equal(pendingEmptyDisposeCount, 1);

let timelineRequiredEvaluations = 0;
class TimelineRequiredProjectionWebView {
  shouldAllowRequest?: DelayedProjectionWebView["shouldAllowRequest"];

  async loadURL(): Promise<boolean> {
    return true;
  }

  async evaluateJavaScript(): Promise<unknown> {
    timelineRequiredEvaluations++;
    if (timelineRequiredEvaluations === 1) {
      return {
        waybillCode: "JDVA12345678901",
        companyName: "京东物流",
        extractionSource: "script",
      };
    }
    return {
      waybillCode: "JDVA12345678901",
      companyName: "京东物流",
      traceList: [
        {
          waybillCode: "JDVA12345678901",
          time: "2026-08-30 16:00:00",
          desc: "正在派送",
        },
        {
          waybillCode: "JDVA12345678901",
          time: "2026-08-30 12:00:00",
          desc: "运输中",
        },
        {
          waybillCode: "JDVA12345678901",
          time: "2026-08-29 09:00:00",
          desc: "快件已揽收",
        },
      ],
      extractionSource: "probe",
      fullProgressRequestedAtStart: true,
    };
  }

  dispose(): void {}
}

Object.assign(globalThis, { WebViewController: TimelineRequiredProjectionWebView });
const completeH5Projection = await projectAccountOrder(
  parcel("https://u.jd.com/full-timeline"),
  Date.now() + 2_000,
);
assert.equal(timelineRequiredEvaluations, 2);
assert.deepEqual(
  completeH5Projection.projectionTimeline?.tracks.map((track) => track.detail),
  ["正在派送", "运输中", "快件已揽收"],
  "timeline mode must wait past an identity-only screen result for the full JD trace response",
);

let cancelledEvaluationCount = 0;
let cancelledDisposeCount = 0;
let cancelledDiagnosticsCount = 0;
class CancelledProjectionWebView {
  shouldAllowRequest?: DelayedProjectionWebView["shouldAllowRequest"];

  async loadURL(): Promise<boolean> {
    return true;
  }

  evaluateJavaScript(): Promise<unknown> {
    cancelledEvaluationCount++;
    return new Promise<unknown>(() => {});
  }

  dispose(): void {
    cancelledDisposeCount++;
  }
}

Object.assign(globalThis, { WebViewController: CancelledProjectionWebView });
const cancelledProjectionController = new AbortController();
const cancelledProjection = projectAccountOrder(
  parcel("https://u.jd.com/cancelled"),
  Date.now() + 10_000,
  () => {
    cancelledDiagnosticsCount++;
  },
  cancelledProjectionController.signal,
);
await Promise.resolve();
assert.equal(cancelledEvaluationCount, 1);
cancelledProjectionController.abort();
await assert.rejects(
  cancelledProjection,
  (error: unknown) => error instanceof Error && error.name === "OperationTimeoutError",
);
assert.equal(cancelledDisposeCount, 1);
assert.equal(cancelledDiagnosticsCount, 0);
await new Promise<void>((resolve) => setTimeout(resolve, 20));
assert.equal(cancelledEvaluationCount, 1);

let blockedEvaluationDisposed = 0;
let blockedEvaluationDiagnostics = 0;
class BlockingProjectionWebView {
  shouldAllowRequest?: DelayedProjectionWebView["shouldAllowRequest"];

  async loadURL(): Promise<boolean> {
    return true;
  }

  evaluateJavaScript(): Promise<unknown> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 40) {
      // Simulate a native bridge that blocks JS timers past the parent deadline.
    }
    return Promise.resolve({
      waybillCode: "SF1122334455",
      companyName: "顺丰速运",
      extractionSource: "dom",
    });
  }

  dispose(): void {
    blockedEvaluationDisposed++;
  }
}

Object.assign(globalThis, { WebViewController: BlockingProjectionWebView });
const blockedProjectionController = new AbortController();
const blockedProjectionAbort = setTimeout(
  () => blockedProjectionController.abort(),
  5,
);
await assert.rejects(
  projectAccountOrder(
    parcel("https://u.jd.com/blocked"),
    Date.now() + 5,
    () => {
      blockedEvaluationDiagnostics++;
    },
    blockedProjectionController.signal,
  ),
  (error: unknown) => error instanceof Error && error.name === "OperationTimeoutError",
);
await new Promise<void>((resolve) => setTimeout(resolve, 0));
clearTimeout(blockedProjectionAbort);
assert.equal(blockedProjectionController.signal.aborted, true);
assert.equal(blockedEvaluationDisposed, 1);
assert.equal(blockedEvaluationDiagnostics, 1);

console.log("account order projection tests passed");
