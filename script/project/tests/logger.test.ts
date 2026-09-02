import assert from "node:assert/strict";

const memory = new Map<string, unknown>();
let rejectWrites = false;
let rejectRemovals = false;
const DIAGNOSTIC_KEY = "pipi_deliveries_diagnostic_log_v1";

Object.assign(globalThis, {
  Storage: {
    get<T>(key: string): T | null {
      return (memory.get(key) as T | undefined) ?? null;
    },
    set(key: string, value: unknown): boolean {
      if (rejectWrites) throw new Error("synthetic storage failure");
      memory.set(key, structuredClone(value));
      return true;
    },
    remove(key: string): void {
      if (rejectRemovals) throw new Error("synthetic storage failure");
      memory.delete(key);
    },
  },
});

const {
  classifyDiagnosticError,
  clearDiagnostics,
  diagnosticErrorDetails,
  diagnosticText,
  readDiagnostics,
  writeDiagnostic,
} = await import("../services/logger");

assert.equal(
  classifyDiagnosticError(Object.assign(new Error("快递同步响应异常"), {
    name: "AccountParseError",
  })),
  "protocol",
);
assert.equal(
  classifyDiagnosticError(Object.assign(new Error("快递详情参数无效"), {
    name: "AccountApiError",
  })),
  "validation",
);
assert.equal(
  classifyDiagnosticError(Object.assign(new Error("无法打开该快递详情"), {
    name: "AccountApiError",
  })),
  "validation",
);
assert.equal(
  classifyDiagnosticError(new Error("快递详情响应与当前运单不匹配")),
  "protocol",
);
assert.equal(
  classifyDiagnosticError(
    new Error("返回的物流信息与当前运单不符，请稍后重试"),
  ),
  "protocol",
);
assert.equal(
  classifyDiagnosticError(new Error("该快递已从列表中移除")),
  "removed",
);
assert.equal(
  classifyDiagnosticError(Object.assign(new Error("暂无轨迹"), {
    name: "Kuaidi100QueryError",
  })),
  "no_result",
);
assert.equal(
  classifyDiagnosticError(Object.assign(new Error("请求失败"), { status: 429 })),
  "rate_limited",
);
assert.equal(
  classifyDiagnosticError(Object.assign(new Error("上游拒绝"), {
    code: "upstream_rejected",
  })),
  "upstream",
);
assert.equal(
  classifyDiagnosticError(Object.assign(new Error("响应不匹配"), {
    code: "invalid_upstream_response",
  })),
  "protocol",
);
assert.equal(
  classifyDiagnosticError(Object.assign(new Error("承运商不支持"), {
    code: "invalid_company_code",
  })),
  "validation",
);
assert.equal(
  classifyDiagnosticError(new Error("Access Key 格式不正确")),
  "authorization",
);
assert.deepEqual(
  diagnosticErrorDetails(Object.assign(new Error("授权失败"), {
    status: 401,
    gatewayCode: "expired_request",
  })),
  {
    errorCategory: "authorization",
    httpStatus: 401,
    failureCode: "expired_request",
  },
);
assert.deepEqual(
  diagnosticErrorDetails(Object.assign(new Error("授权失败"), {
    status: 403,
    gatewayCode: "phone_13800138000",
  })),
  {
    errorCategory: "authorization",
    httpStatus: 403,
  },
);
assert.deepEqual(
  diagnosticErrorDetails(Object.assign(new Error("上游拒绝"), {
    name: "AccountApiError",
    code: "UPSTREAM_REJECTED",
  })),
  {
    errorCategory: "upstream",
    failureCode: "upstream_rejected",
  },
);
assert.deepEqual(
  diagnosticErrorDetails(Object.assign(new Error("授权失败"), {
    status: 401,
    gatewayCode: "AbCdEfGhIjKlMnOp",
  })),
  {
    errorCategory: "authorization",
    httpStatus: 401,
  },
);

writeDiagnostic("binding.persisted", {
  source: "interface5",
  activeSource: "interface5",
  revision: 4,
  interface5Bindings: 1,
  flowId: "binding-safe",
  result: "succeeded",
  phone: "13800138000",
  token: "secret-token",
} as never);

const first = readDiagnostics();
assert.equal(first.length, 1);
assert.deepEqual(first[0]?.details, {
  source: "interface5",
  activeSource: "interface5",
  revision: 4,
  interface5Bindings: 1,
  flowId: "binding-safe",
  result: "succeeded",
});
assert.equal(diagnosticText(first).includes("13800138000"), false);
assert.equal(diagnosticText(first).includes("secret-token"), false);

writeDiagnostic("detail.refresh.stage_failed", {
  waybillTail: "9613",
  sourceProvider: "cainiao",
  carrierCode: "YTO",
  routeKind: "cainiao",
  automatic: true,
  selected: true,
  webViewAllowed: true,
  routePointerPresent: true,
  routePresent: true,
  routeTrusted: true,
  waybillPresent: true,
  loadSettled: true,
  loadCompleted: true,
  evaluationAttempts: 7,
  evaluationFailures: 2,
  extractionSource: "dom",
  rawTrackCount: 4,
  validTrackCount: 3,
  effectiveTrackCount: 3,
  persisted: false,
  timelineProvider: "interface5",
  finalTimelineProvider: "interface5",
  detailTimelineProvider: "kuaidi100_h5",
  detailEffectiveTrackCount: 5,
  scriptVersion: "0.5-beta19",
  clientBuild: 25,
  exitReason: "no_timed_tracks",
  skipReason: "deadline_exhausted",
  routeUrl: "https://page.cainiao.com/secret",
  fullWaybill: "YT12345678909613",
} as never, "warning");
const cainiaoDiagnostic = readDiagnostics()[0]!;
assert.deepEqual(cainiaoDiagnostic.details, {
  waybillTail: "9613",
  sourceProvider: "cainiao",
  carrierCode: "YTO",
  routeKind: "cainiao",
  automatic: true,
  selected: true,
  webViewAllowed: true,
  routePointerPresent: true,
  routePresent: true,
  routeTrusted: true,
  waybillPresent: true,
  loadSettled: true,
  loadCompleted: true,
  evaluationAttempts: 7,
  evaluationFailures: 2,
  extractionSource: "dom",
  rawTrackCount: 4,
  validTrackCount: 3,
  effectiveTrackCount: 3,
  persisted: false,
  timelineProvider: "interface5",
  finalTimelineProvider: "interface5",
  detailTimelineProvider: "kuaidi100_h5",
  detailEffectiveTrackCount: 5,
  scriptVersion: "0.5-beta19",
  clientBuild: 25,
  exitReason: "no_timed_tracks",
  skipReason: "deadline_exhausted",
});
assert.equal(diagnosticText([cainiaoDiagnostic]).includes("9613"), true);
assert.equal(
  diagnosticText([cainiaoDiagnostic]).includes("YT12345678909613"),
  false,
);
assert.equal(
  diagnosticText([cainiaoDiagnostic]).includes("page.cainiao.com"),
  false,
);

writeDiagnostic("detail.refresh.primary_contest.completed", {
  executionBoundary: "host_budget",
  routeCaptured: true,
  motoSupported: true,
  motoSucceeded: false,
  kuaidi100Succeeded: true,
  primarySuccessCount: 1,
  primaryReachedTimelineStart: true,
  kdniaoAttempted: false,
  kdniaoSucceeded: false,
});
assert.deepEqual(readDiagnostics()[0]?.details, {
  executionBoundary: "host_budget",
  routeCaptured: true,
  motoSupported: true,
  motoSucceeded: false,
  kuaidi100Succeeded: true,
  primarySuccessCount: 1,
  primaryReachedTimelineStart: true,
  kdniaoAttempted: false,
  kdniaoSucceeded: false,
});

writeDiagnostic("detail.refresh.stage_failed", {
  waybillTail: "YT12345678909613",
} as never, "warning");
assert.equal(readDiagnostics()[0]?.details.waybillTail, undefined);

writeDiagnostic("binding.code.failed", {
  failureCode: "phone_13800138000",
} as never, "error");
assert.equal(readDiagnostics()[0]?.details.failureCode, undefined);
assert.equal(diagnosticText().includes("phone_13800138000"), false);

writeDiagnostic("binding.code.failed", {
  failureCode: "AbCdEfGhIjKlMnOp",
} as never, "error");
assert.equal(readDiagnostics()[0]?.details.failureCode, undefined);
assert.equal(diagnosticText().includes("AbCdEfGhIjKlMnOp"), false);

for (let index = 0; index < 505; index++) {
  writeDiagnostic("refresh.succeeded", {
    revision: index,
    result: "succeeded",
  });
}
assert.equal(readDiagnostics().length, 200);

clearDiagnostics();
writeDiagnostic("refresh.stage.started", {
  flowId: "refresh-terminal-owner",
  stage: "manual_refresh",
});
writeDiagnostic("refresh.failed", {
  flowId: "refresh-terminal-owner",
  errorCategory: "timeout",
});
writeDiagnostic("refresh.stage.succeeded", {
  flowId: "refresh-terminal-owner",
  stage: "manual_refresh",
});
assert.deepEqual(
  readDiagnostics().map((entry) => entry.event),
  ["refresh.failed", "refresh.stage.started"],
  "a refresh terminal event must remain the final record for its flow",
);

rejectWrites = true;
assert.doesNotThrow(() => {
  writeDiagnostic("storage.state.failed", { result: "write_rejected" }, "error");
});

rejectWrites = false;

writeDiagnostic("account.sync.failed", {
  source: "interface5",
  stage: "account_list",
  errorCategory: "authorization",
  httpStatus: 401,
  failureCode: "unauthorized",
});
assert.equal(readDiagnostics()[0].details.httpStatus, 401);
assert.equal(readDiagnostics()[0].details.failureCode, "unauthorized");

writeDiagnostic("account.sync.parsed", {
  source: "interface5",
  rawRecords: 3,
  records: 2,
  rejectedRecords: 1,
});
assert.deepEqual(readDiagnostics()[0].details, {
  source: "interface5",
  rawRecords: 3,
  records: 2,
  rejectedRecords: 1,
});

writeDiagnostic("refresh.failed", {
  budgetMs: 30_000,
  blockedMs: 2_000,
  deadlineLagMs: 450,
});
assert.deepEqual(readDiagnostics()[0].details, {
  budgetMs: 30_000,
  blockedMs: 2_000,
  deadlineLagMs: 450,
});

writeDiagnostic("order.projection.failed", {
  source: "interface5",
  stage: "webview",
  errorCategory: "timeout",
  loadSettled: false,
  loadCompleted: false,
  captureSeen: true,
  replayAttempted: true,
  replaySucceeded: false,
  probeInstalled: true,
  probeMatched: false,
  probeRequestCount: 3,
  unionSignalSeen: false,
  unionResourceSeen: true,
  domMatched: false,
  requestCallbackCount: 7,
  evaluationAttempts: 2,
  evaluationFailures: 0,
  loadDurationMs: 9_000,
  resourceCount: 12,
  pageClass: "jd",
  readyState: "complete",
  visibilityState: "hidden",
  viewportAvailable: false,
});
assert.deepEqual(readDiagnostics()[0].details, {
  source: "interface5",
  stage: "webview",
  errorCategory: "timeout",
  loadSettled: false,
  loadCompleted: false,
  captureSeen: true,
  replayAttempted: true,
  replaySucceeded: false,
  probeInstalled: true,
  probeMatched: false,
  probeRequestCount: 3,
  unionSignalSeen: false,
  unionResourceSeen: true,
  domMatched: false,
  requestCallbackCount: 7,
  evaluationAttempts: 2,
  evaluationFailures: 0,
  loadDurationMs: 9_000,
  resourceCount: 12,
  pageClass: "jd",
  readyState: "complete",
  visibilityState: "hidden",
  viewportAvailable: false,
});
assert.equal(diagnosticText([readDiagnostics()[0]!]).includes("loadCompleted=false"), true);
assert.equal(diagnosticText([readDiagnostics()[0]!]).includes("loadDurationMs=9000"), true);
assert.equal(diagnosticText([readDiagnostics()[0]!]).includes("probeInstalled=true"), true);
assert.equal(diagnosticText([readDiagnostics()[0]!]).includes("viewportAvailable=false"), true);

memory.set(DIAGNOSTIC_KEY, [{
  id: "expired-entry",
  at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString(),
  level: "info",
  event: "refresh.succeeded",
  details: {},
}]);
assert.deepEqual(readDiagnostics(), []);
assert.equal(memory.has(DIAGNOSTIC_KEY), false);

for (let index = 0; index < 520; index++) {
  writeDiagnostic("refresh.stage.started", {
    flowId: `flow-${String(index).padStart(3, "0")}`,
    stage: "account_detail",
  });
}
const retainedDiagnostics = readDiagnostics();
assert.equal(retainedDiagnostics.length, 200);
assert.equal(retainedDiagnostics[0]?.details.flowId, "flow-519");
assert.equal(retainedDiagnostics.at(-1)?.details.flowId, "flow-320");
clearDiagnostics();

writeDiagnostic("refresh.succeeded", { result: "succeeded" });
rejectRemovals = true;
assert.throws(() => clearDiagnostics(), /诊断日志清空失败/);
rejectRemovals = false;
assert.equal(readDiagnostics().length, 1);

clearDiagnostics();
assert.deepEqual(readDiagnostics(), []);

console.log("diagnostic logger privacy and retention tests passed");
