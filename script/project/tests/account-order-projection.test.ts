import assert from "node:assert/strict";
import {
  projectAccountOrder,
  projectionFromUnionPayload,
} from "../services/account-order-projection";
import type { AccountParcelDto } from "../services/account-parser";

const ownerId = "1234567890123456";

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
      extractionSource: "replay",
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
    floors: [{
      element: {
        info: {
          waybillCode: "YTO6677889900",
          expressCompanyName: "圆通速递",
        },
      },
    }],
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
  querySelectorAll: () => [],
};

class InPageProbeProjectionWebView {
  shouldAllowRequest?: DelayedProjectionWebView["shouldAllowRequest"];

  async loadURL(): Promise<boolean> {
    return true;
  }

  async evaluateJavaScript(source: string): Promise<unknown> {
    inPageProbeEvaluationCount++;
    const result = await new Function(source)();
    if (inPageProbeEvaluationCount === 1) {
      await (pageWindow.fetch as (url: string) => Promise<unknown>)(
        "https://api.m.jd.com/client.action?functionId=getUnionActivity",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return result;
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
assert.equal(probeDiagnostics?.probeInstalled, true);
assert.equal(probeDiagnostics?.probeMatched, true);
assert.equal(probeDiagnostics?.unionSignalSeen, true);
assert.equal((probeDiagnostics?.probeRequestCount || 0) >= 1, true);
assert.equal(probeDiagnostics?.pageClass, "jd");
assert.equal(probeDiagnostics?.viewportAvailable, true);
assert.equal(inPageProbeDisposed, true);

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
      name: "https://api.m.jd.com/client.action?functionId=getUnionActivity",
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
assert.equal(resourceReplayDiagnostics?.probeMatched, false);
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
await assert.rejects(
  projectAccountOrder(
    parcel("https://u.jd.com/empty"),
    Date.now() + 15,
    (diagnostics) => {
      timeoutDiagnostics = diagnostics;
    },
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

console.log("account order projection tests passed");
