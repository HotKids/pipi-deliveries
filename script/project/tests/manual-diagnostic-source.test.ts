import assert from "node:assert/strict";

const memory = new Map<string, unknown>();

Object.assign(globalThis, {
  Storage: {
    get<T>(key: string): T | null {
      return (memory.get(key) as T | undefined) ?? null;
    },
    set(key: string, value: unknown): boolean {
      memory.set(key, structuredClone(value));
      return true;
    },
    remove(key: string): void {
      memory.delete(key);
    },
  },
});

const { queryManualForSource } = await import("../services/manual-query");
const { clearDiagnostics, readDiagnostics } = await import("../services/logger");

clearDiagnostics();
await queryManualForSource({
  source: "interface5",
  bindings: [],
  waybill: "ZT1234567890",
  phoneTail: "1515",
  rawCourierCode: "ZTO",
  sourceProvider: "CaiNiao",
  diagnosticFlowId: "manual-source-diagnostic",
  dependencies: {
    post: async (path) => {
      assert.equal(path, "/api/express/timeline/public");
      return {
        status: 0,
        data: {
          cpCode: "ZTO",
          cpName: "中通快递",
          logisticsStatus: "TRANSPORT",
          fullTraceDetail: [{
            time: "2026-08-31 12:50:00",
            desc: "快件运输中",
          }],
        },
      };
    },
  },
});

const entries = readDiagnostics().filter(
  (entry) => entry.details.flowId === "manual-source-diagnostic",
);
for (const event of [
  "manual.source.started",
  "manual.source.succeeded",
  "manual.query.completed",
]) {
  const entry = entries.find((candidate) => candidate.event === event);
  assert.ok(entry, `missing ${event}`);
  assert.equal(entry.details.timelineProvider, "moto");
  if (event !== "manual.source.started") {
    assert.equal(typeof entry.details.durationMs, "number");
  }
}

clearDiagnostics();
await queryManualForSource({
  source: "interface5",
  bindings: [],
  waybill: "SF1234567890",
  rawCourierCode: "SF",
  sourceProvider: "ShunFeng",
  diagnosticFlowId: "manual-source-failure",
  dependencies: {
    post: async (path) => {
      assert.equal(path, "/api/express/timeline/source");
      throw Object.assign(new Error("request rejected"), {
        status: 400,
        gatewayCode: "invalid_timeline_query",
      });
    },
  },
});
const failed = readDiagnostics().find(
  (entry) => entry.event === "manual.source.failed",
);
assert.ok(failed);
assert.equal(failed.details.timelineProvider, "meizu");
assert.equal(typeof failed.details.durationMs, "number");

clearDiagnostics();
await queryManualForSource({
  source: "interface5",
  bindings: [],
  waybill: "ZT1234567890",
  phoneTail: "1515",
  rawCourierCode: "ZTO",
  includeKdniaoFallback: true,
  fallbackOnly: true,
  diagnosticFlowId: "manual-source-fallback",
  dependencies: {
    post: async (path) => {
      assert.equal(path, "/api/express/timeline/fallback");
      return {
        success: true,
        state: "2",
        logisticCode: "ZT1234567890",
        shipperCode: "ZTO",
        traces: [{
          acceptTime: "2026-08-31 12:51:00",
          acceptStation: "快件运输中",
          action: "2",
        }],
      };
    },
  },
});
const fallbackEntries = readDiagnostics();
assert.equal(
  fallbackEntries.find((entry) => entry.event === "manual.source.started")
    ?.details.timelineProvider,
  "kdniao",
);
assert.equal(
  fallbackEntries.find((entry) => entry.event === "manual.query.completed")
    ?.details.timelineProvider,
  "kdniao",
);

clearDiagnostics();
await queryManualForSource({
  source: "interface5",
  bindings: [],
  waybill: "ZT1234567890",
  rawCourierCode: "ZTO",
  sourceProvider: "CaiNiao",
  diagnosticFlowId: "manual-source-empty",
  dependencies: {
    post: async (path) => {
      assert.equal(path, "/api/express/timeline/public");
      return {
        status: 0,
        data: {
          cpCode: "ZTO",
          cpName: "中通快递",
          logisticsStatus: "TRANSPORT",
          fullTraceDetail: [],
        },
      };
    },
  },
});
const emptyEntries = readDiagnostics();
assert.equal(
  emptyEntries.find((entry) => entry.event === "manual.source.skipped")
    ?.details.timelineProvider,
  "moto",
);
const emptyCompleted = emptyEntries.find(
  (entry) => entry.event === "manual.query.completed",
);
assert.equal(emptyCompleted?.details.selected, false);
assert.equal(emptyCompleted?.details.timelineProvider, "none");

console.log("manual diagnostic source tests passed");
