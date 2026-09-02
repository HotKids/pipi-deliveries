import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import type { AppState, Shipment, TimelinePackage } from "../models";

type FakeData = { value: string };
type FakeFetchInit = {
  body?: string;
  signal?: AbortSignal;
};

const files = new Map<string, string>();
const keychain = new Map<string, string>();
const storage = new Map<string, unknown>();
const fetchStages: string[] = [];
let accountListFailure: "timeout" | "unauthorized" = "timeout";

function providerTime(value: number): string {
  const date = new Date(value);
  const part = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${
    part(date.getHours())
  }:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

const detailEventAtMs = Date.now() - 1_000;
const detailTimeText = providerTime(detailEventAtMs);

function dataValue(value: FakeData | string): string {
  return typeof value === "string" ? value : value.value;
}

function jsonResponse(value: unknown) {
  const text = JSON.stringify(value);
  return {
    ok: true,
    status: 200,
    expectedContentLength: text.length,
    text: async () => text,
  };
}

Object.assign(globalThis, {
  Data: {
    fromFile: () => ({ value: "" }),
    fromIntArray: (value: number[]) => ({
      value: Buffer.from(value).toString("utf8"),
    }),
    fromRawString: (value: string) => ({ value }),
  },
  Crypto: {
    sha256: (value: FakeData | string) => ({
      toHexString: () => createHash("sha256")
        .update(dataValue(value))
        .digest("hex"),
    }),
    hmacSHA256: (value: FakeData, key: FakeData) => ({
      toHexString: () => createHmac("sha256", key.value)
        .update(value.value)
        .digest("hex"),
    }),
    generateSymmetricKey: () => ({
      toHexString: () => "0123456789abcdef0123456789abcdef",
    }),
  },
  Path: {
    join(...parts: string[]) {
      return parts.join("/").replace(/\/{2,}/g, "/");
    },
  },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    createDirectorySync() {},
    existsSync(path: string) {
      return files.has(path);
    },
    isFileSync(path: string) {
      return files.has(path);
    },
    readAsStringSync(path: string) {
      const value = files.get(path);
      if (value == null) throw new Error("missing synthetic file");
      return value;
    },
    removeSync(path: string) {
      files.delete(path);
    },
    renameSync(path: string, newPath: string) {
      const value = files.get(path);
      if (value == null || files.has(newPath)) {
        throw new Error("synthetic rename rejected");
      }
      files.set(newPath, value);
      files.delete(path);
    },
    writeAsStringSync(path: string, value: string) {
      files.set(path, value);
    },
  },
  Keychain: {
    get(key: string): string | null {
      return keychain.get(key) ?? null;
    },
    set(key: string, value: string): boolean {
      keychain.set(key, value);
      return true;
    },
    remove(key: string): boolean {
      return keychain.delete(key);
    },
  },
  Storage: {
    get<T>(key: string): T | null {
      return (storage.get(key) as T | undefined) ?? null;
    },
    set(key: string, value: unknown): boolean {
      storage.set(key, structuredClone(value));
      return true;
    },
    remove(key: string): void {
      storage.delete(key);
    },
  },
  Notification: {
    schedule: async () => {},
  },
  Widget: {
    reloadAll() {},
  },
  Script: {
    directory: "/script",
    name: "Pipi Deliveries Test",
    createRunSingleURLScheme: () => "pipi-test://shipment",
  },
  fetch: async (url: string, init?: FakeFetchInit) => {
    const route = new URL(url).pathname;
    if (route === "/api/express/accounts/sync") {
      fetchStages.push("account_list");
      if (accountListFailure === "unauthorized") {
        const text = JSON.stringify({ error: "unauthorized" });
        return {
          ok: false,
          status: 401,
          expectedContentLength: text.length,
          text: async () => text,
        };
      }
      const timeout = new Error("synthetic account-list timeout");
      timeout.name = "TimeoutError";
      throw timeout;
    }
    if (route === "/api/express/timeline/source") {
      const body = JSON.parse(String(init?.body || "{}")) as {
        mode?: string;
      };
      assert.equal(body.mode, "detail");
      fetchStages.push("account_detail");
      return jsonResponse({
        code: 0,
        data: {
          stateNum: 104,
          details: [{
            time: detailTimeText,
            desc: "cached detail refreshed after list timeout",
            stateNum: 104,
          }],
        },
      });
    }
    throw new Error(`unexpected synthetic route: ${route}`);
  },
});

const { saveGatewayToken } = await import("../services/credentials");
const { clearDiagnostics, readDiagnostics } = await import("../services/logger");
const { saveState } = await import("../services/storage");
const { refreshAllShipments } = await import("../services/sync");

const PHONE = "13800138000";
const WAYBILL = "ZTCACHED5900";

function timeline(detail: string, successAtMs: number): TimelinePackage {
  const timeText = providerTime(successAtMs);
  return {
    provider: "interface5",
    waybill: WAYBILL,
    courierCode: "ZTO",
    companyName: "中通快递",
    semantic: "TRANSIT",
    statusEventAtMs: null,
    latestTimeText: timeText,
    latestDetail: detail,
    tracks: [{
      timeText,
      timeMs: null,
      detail,
      statusCode: "104",
      raw: {},
    }],
    successAtMs,
  };
}

function cachedShipment(now: number): Shipment {
  const sourceTimeline = timeline(
    "cached detail before refresh",
    now - 60_000,
  );
  return {
    identity: {
      id: `interface5:account:${WAYBILL}`,
      bindingSource: "interface5",
      sourceOwner: "interface5",
      sourceId: WAYBILL,
      phoneTail: PHONE.slice(-4),
      phone: PHONE,
      courierCode: "ZTO",
      rawCourierCode: "ZTO",
      companyName: "中通快递",
      sourceProvider: "CaiNiao",
      accountOrder: false,
      manuallyAdded: false,
      createdAtMs: now - 120_000,
    },
    timeline: sourceTimeline,
    sourceTimeline,
    manualTimelines: [],
    route: null,
    accountRecord: {
      waybill: WAYBILL,
      companyCode: "ZTO",
      name: "中通快递",
      provider: "CaiNiao",
      stateNumber: 104,
      updateTime: providerTime(now - 60_000),
      phone: PHONE,
      channel: "1",
    },
    updatedAtMs: now - 60_000,
  };
}

function state(shipments: readonly Shipment[]): AppState {
  const now = Date.now();
  return {
    version: 2,
    revision: 0,
    updatedAtMs: now,
    activeSource: "interface5",
    bindings: [{
      source: "interface5",
      phone: PHONE,
      boundAtMs: now - 120_000,
    }],
    pendingQueries: [],
    shipments,
  };
}

saveGatewayToken("AbCdEfGh_123-456");

const now = Date.now();
const initial = saveState(state([cachedShipment(now)]), now);
const initialId = initial.shipments[0]?.identity.id;
clearDiagnostics();
fetchStages.length = 0;

const fallback = await refreshAllShipments("interface5", {
  budgetMs: 30_000,
  accountOrderProjection: false,
});

assert.deepEqual(fetchStages, ["account_list", "account_detail"]);
assert.deepEqual(
  {
    attempted: fallback.attempted,
    succeeded: fallback.succeeded,
    failed: fallback.failed,
  },
  { attempted: 2, succeeded: 1, failed: 1 },
  "cached same-owner account detail may continue, but a Cainiao shipment must not enter cross-provider manual polling",
);
assert.equal(fallback.state.shipments.length, 1);
assert.equal(fallback.state.shipments[0]?.identity.id, initialId);
assert.equal(
  fallback.state.shipments[0]?.timeline.latestDetail,
  "cached detail refreshed after list timeout",
  "the production full-refresh path must run cached account followups",
);
assert.equal(
  readDiagnostics().find((entry) => entry.event === "account.sync.failed")
    ?.details.result,
  "cached_fallback",
);
assert.equal(
  readDiagnostics().find((entry) => entry.event === "refresh.succeeded")
    ?.details.result,
  "partial",
);

saveState(state([]), Date.now());
clearDiagnostics();
fetchStages.length = 0;
const empty = await refreshAllShipments("interface5", {
  budgetMs: 30_000,
  accountOrderProjection: false,
});

assert.deepEqual(fetchStages, ["account_list"]);
assert.deepEqual(
  { attempted: empty.attempted, succeeded: empty.succeeded, failed: empty.failed },
  { attempted: 1, succeeded: 0, failed: 1 },
  "without persisted source state, an account-list failure must remain fail-closed",
);
assert.equal(empty.state.shipments.length, 0);
assert.equal(
  readDiagnostics().find((entry) => entry.event === "account.sync.failed")
    ?.details.result,
  "failed",
);

saveState(state([cachedShipment(Date.now())]), Date.now());
clearDiagnostics();
fetchStages.length = 0;
accountListFailure = "unauthorized";
await assert.rejects(
  refreshAllShipments("interface5", {
    budgetMs: 30_000,
    accountOrderProjection: false,
  }),
  /访问授权无效/,
  "credential recovery must remain fatal even when cached state exists",
);
assert.deepEqual(fetchStages, ["account_list"]);
assert.equal(
  readDiagnostics().find((entry) => entry.event === "account.sync.failed")
    ?.details.result,
  "failed",
);

console.log("account-list cached fallback production-path tests passed");
