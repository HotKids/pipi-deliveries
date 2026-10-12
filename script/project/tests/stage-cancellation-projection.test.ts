import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { memory, NOW } from "./state-storage-mock";

import type { Shipment } from "../models";
import { parseAccountSyncResponse } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { saveGatewayToken } from "../services/credentials";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import {
  registerProjectionViewportHost,
  setProjectionSceneActive,
} from "../services/projection-viewport";
import { saveOrderProjectionReferences } from "../services/routes";
import { applyAccountShipment } from "../services/shipment-policy";
import { emptyState, loadState, saveState } from "../services/storage";
import { refreshAllShipments, runShipmentRefreshForTesting, synchronizeAccountListForTesting } from "../services/sync";
import type { AccountParcelDto } from "../services/account-parser";

// 用户 2026-09-28（「都修」第 1 条）：父刷新被取消时，已经记了开始的 account.sync 与 order.projection（列表京粉页
// webview、详情京粉页 detail_webview）照样记它们自己的 .failed，errorCategory=cancelled，然后取消照旧往外抛。
// The harness is refresh-union-page-foreground.test.ts's; identities and node texts are synthetic.

const PHONE = "13800009996";
const ORDER = "3999999000000006";
const OWNER_ID = `interface5:account:${ORDER}`;
const REFERENCE = "https://u.jd.com/forward?synthetic=cancelled-stage";
const WAYBILL = "JD9990000000006";

let clock = NOW;
const realNow = Date.now;
Date.now = () => clock;
process.on("exit", () => { Date.now = realNow; });
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(Data, { fromFile: () => null });

const providerTime = (at: number) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
const loadedUrls: string[] = [];
Object.assign(globalThis, {
  Notification: { schedule: async () => undefined },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class {
    async loadURL(url: string) { loadedUrls.push(url); return true; }
    async evaluateJavaScript() {
      return { extractionSource: "probe", waybillCode: WAYBILL, companyName: "京东快递", traceList: [
        { time: providerTime(NOW - 3600000), desc: "快件已到达【深圳万丰站】" },
        { time: providerTime(NOW - 86400000), desc: "快件已揽收" },
      ] };
    }
    dispose() {}
  },
});

// The app root's slot. A held mount stands for the page waiting for its viewport.
let holdMount = false;
let mountWaiting = false;
let releaseMount = () => {};
registerProjectionViewportHost({
  mount: () => new Promise<boolean>((resolve) => {
    if (!holdMount) {
      resolve(true);
      return;
    }
    mountWaiting = true;
    releaseMount = () => {
      mountWaiting = false;
      resolve(true);
    };
  }),
  unmount: () => {},
});

// Raw 103: past pickup, so every refresh flow that may open the page opens it.
const record = {
  mailNo: ORDER, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE, stateNum: 103,
  details: [{ time: providerTime(NOW - 3600000), desc: "您的订单已出库" }],
  jumpList: [{ type: "h5", link: REFERENCE }],
};
const requests: string[] = [];
globalThis.fetch = (async (url: string) => {
  const path = new URL(url).pathname;
  requests.push(path);
  if (path !== "/api/express/accounts/sync") {
    return { ok: false, status: 503, text: async () => "Synthetic offline" };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { expressList: [record] } }) };
}) as typeof fetch;

function storedOrder(): Shipment {
  const parcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [record] } })[0]!;
  return applyAccountShipment(undefined, parcelToShipment(parcel, [PHONE], NOW - 3600000)!, NOW - 3600000);
}

function seed() {
  clock = NOW;
  memory.clear();
  setDiagnosticsEnabled(true);
  saveState({
    ...emptyState(),
    shipments: [storedOrder()],
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 }],
    feedSlotRebuiltAtMs: NOW - 86400000,
  }, NOW);
  saveOrderProjectionReferences([{ ownerId: OWNER_ID, source: "interface5", url: REFERENCE }], NOW);
  saveGatewayToken("AbCdEfGh_123-456");
  loadedUrls.length = 0;
  requests.length = 0;
  holdMount = false;
  setProjectionSceneActive(true);
}

async function until(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = realNow() + timeoutMs;
  while (!condition()) {
    if (realNow() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const owner = () => loadState().shipments.find((shipment) => shipment.identity.id === OWNER_ID)!;
const events = (event: string) => readDiagnostics().filter((entry) => entry.event === event);


function cancelledEnds(event: string, stage: string) {
  return events(event).filter((entry) => entry.details.stage === stage);
}

test("a list union page cut off when the flow loses its lease ends its projection stage as cancelled", async () => {
  seed();
  holdMount = true;
  const refresh = refreshAllShipments();
  await until(() => mountWaiting);
  clock += 57 * 60_000;
  releaseMount();
  await assert.rejects(refresh);
  assert.equal(cancelledEnds("order.projection.started", "webview").length, 1);
  const ended = cancelledEnds("order.projection.failed", "webview");
  assert.equal(ended.length, 1, JSON.stringify(readDiagnostics().map((e) => [e.event, e.details.stage])));
  assert.equal(ended[0]!.details.errorCategory, "cancelled");
});

test("an account list request cut off by the parent refresh ends its stage as cancelled", async () => {
  seed();
  const controller = new AbortController();
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path !== "/api/express/accounts/sync") return { ok: false, status: 503, text: async () => "Synthetic offline" };
    controller.abort();
    throw new Error("Synthetic request cut off");
  }) as unknown as typeof fetch;
  await assert.rejects(synchronizeAccountListForTesting(loadState(), "interface5", NOW, new Map(), "cancelled-list",
    NOW + 30_000, undefined, controller.signal), (error: unknown) => error instanceof Error && error.name === "OperationTimeoutError");
  assert.equal(cancelledEnds("account.sync.started", "v5_list").length, 1);
  const ended = cancelledEnds("account.sync.failed", "v5_list");
  assert.equal(ended.length, 1, JSON.stringify(readDiagnostics().map((e) => [e.event, e.details.stage])));
  assert.equal(ended[0]!.details.errorCategory, "cancelled");
});

test("a detail union page cut off by the parent refresh ends its projection stage as cancelled", async () => {
  seed();
  const controller = new AbortController();
  let pages = 0;
  await assert.rejects(runShipmentRefreshForTesting(OWNER_ID,
    { isCurrent: () => true, deadlineAtMs: clock + 30_000, signal: controller.signal },
    { trigger: "detail_pull", forceManualRefresh: true }, {
      refreshAccountParcel: async (): Promise<AccountParcelDto | null> => null,
      projectAccountOrderWithCarrier: async () => {
        pages++;
        controller.abort();
        throw new Error("Synthetic page cut off");
      },
      refreshWebTimeline: async () => null,
      queryManualForSource: async () => ({ result: "empty_response" as const, shipment: null, pending: null, routeUrl: "" }),
    }), (error: unknown) => error instanceof Error && error.name === "OperationTimeoutError");
  assert.equal(pages, 1);
  assert.equal(cancelledEnds("order.projection.started", "detail_webview").length, 1);
  const ended = cancelledEnds("order.projection.failed", "detail_webview");
  assert.equal(ended.length, 1, JSON.stringify(readDiagnostics().map((e) => [e.event, e.details.stage])));
  assert.equal(ended[0]!.details.errorCategory, "cancelled");
});
