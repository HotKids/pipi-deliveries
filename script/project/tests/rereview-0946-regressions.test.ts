import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { memory } from "./state-storage-mock.ts";
import type { AccountBinding, Shipment } from "../models.ts";
import type { AccountParcelDto } from "../services/account-parser.ts";

const NOW = Date.UTC(2026, 10, 27, 4, 0, 0);
const DAY = 24 * 60 * 60 * 1_000;
let clock = NOW;
const realNow = Date.now;
Date.now = () => clock;
process.on("exit", () => {
  Date.now = realNow;
});

let widgetReloadCount = 0;
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value, "utf8").digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(Data, { fromFile: () => null });
Object.assign(globalThis, {
  UUID: { string: () => randomUUID() },
  Notification: { schedule: async () => undefined },
  Widget: {
    reloadAll() {
      widgetReloadCount += 1;
    },
  },
  Device: { systemVersion: "26.0", isiPhone: true, screen: { width: 393, height: 852, scale: 3 } },
  Script: { directory: "/synthetic", name: "Pipi Deliveries", createRunSingleURLScheme: () => "scripting://pipi" },
});

const { saveGatewayToken } = await import("../services/credentials.ts");
const { GatewayError } = await import("../services/gateway.ts");
const { mealCredentialScope } = await import("../services/meal/rules.ts");
const {
  canonicalWholeRecordDigest,
  dropRejectedParcelBatch,
  isDeterministicParcelMutationRejection,
  mergeParcelCloudCodeNote,
  mergeParcelCloudMetadata,
  mergeParcelCloudPddLink,
  mergeParcelCloudWatchFeedback,
  parcelDetailRecordId,
  prepareParcelBatch,
  readParcelCloudState,
  reconcileParcelCloudRecordsWithLocal,
  resetParcelCloudDeniedBackoffForTests,
  synchronizeParcelCloudRecords,
} = await import("../services/parcel-cloud-sync.ts");
const {
  displayDeliveryEstimate,
  normalizeParcelDeliveryEstimate,
} = await import("../services/platform-parcel-data.ts");
const {
  displayedPlatformFields,
  hasPddParcelSource,
} = await import("../services/platform-parcel-merge.ts");
const {
  fetchJdParcelDetails,
  fetchPddOrders,
  missingJdDeliveryEstimate,
  resetJdEstimateCooldownsForTests,
} = await import("../services/platform-web-parcels.ts");
const { refreshPlatformParcels } = await import("../services/platform-parcel-sync.ts");
const {
  clearPlatformLogin,
  platformSession,
  savePlatformLogin,
} = await import("../services/platform-accounts.ts");
const { PlatformWireError } = await import("../services/platform-wire.ts");
const { registerProjectionViewportHost } = await import("../services/projection-viewport.ts");
const { enhanceAccountParcels } = await import("../services/enhanced-account.ts");
const {
  lastWidgetNetworkFailure,
  recordWidgetNetworkFailure,
} = await import("../services/refresh-runtime-state.ts");
const { shouldRunWidgetNetworkRefresh } = await import("../widget/runtime.ts");
const {
  requestWidgetReload,
  resetWidgetReloadCoalescingForTests,
} = await import("../services/widgets.ts");
const {
  clearDiagnostics,
  drainAppDiagnostics,
  peekRecentDiagnostics,
  readDiagnostics,
  readDiagnosticsSnapshot,
  setDiagnosticsEnabled,
  startAppDiagnosticWrites,
  writeDiagnostic,
} = await import("../services/logger.ts");
const {
  emptyState,
  forceCompleteShipment,
  loadState,
  removeShipmentWithCleanup,
  saveCloudPddParcels,
  saveState,
  setShipmentNote,
} = await import("../services/storage.ts");

const OWNER_ID = "a".repeat(64);
const ENDPOINT_ID = `scripting-parcel:${"b".repeat(64)}`;
const EPOCH = "11111111-2222-4333-8444-555555555555";
const JD_COOKIES = [
  { name: "pt_key", value: "synthetic-jd-key", domain: ".jd.com", path: "/" },
  { name: "pt_pin", value: "synthetic_pin", domain: ".jd.com", path: "/" },
];

function resetEnv(at = NOW): string {
  clock = at;
  widgetReloadCount = 0;
  memory.clear();
  resetParcelCloudDeniedBackoffForTests();
  resetJdEstimateCooldownsForTests();
  resetWidgetReloadCoalescingForTests();
  setDiagnosticsEnabled(true);
  clearDiagnostics();
  saveGatewayToken("AbCdEfGh_123-456");
  saveState(emptyState(), clock);
  const scope = mealCredentialScope();
  assert.ok(scope);
  return scope!;
}

function makeManualShipment(waybill: string, overrides: Partial<Shipment> = {}): Shipment {
  const base: Shipment = {
    identity: {
      id: `interface5:manual:${waybill}`,
      bindingSource: "interface5",
      sourceOwner: "manual",
      sourceId: waybill,
      phoneTail: "1234",
      courierCode: "zto",
      rawCourierCode: "zto",
      companyName: "中通快递",
      manuallyAdded: true,
      createdAtMs: clock - 20_000,
    },
    timeline: {
      provider: "v6",
      complete: false,
      structuredStatus: true,
      waybill,
      courierCode: "zto",
      companyName: "中通快递",
      semantic: "TRANSIT",
      statusEventAtMs: clock - 10_000,
      latestTimeText: "2026-11-27 11:50:00",
      latestDetail: "快件运输中",
      tracks: [
        {
          timeMs: clock - 10_000,
          timeText: "2026-11-27 11:50:00",
          detail: "快件运输中",
          statusCode: "TRANSIT",
          raw: {},
        },
      ],
      successAtMs: clock - 5_000,
    },
    sourceTimeline: null,
    manualTimelines: [],
    updatedAtMs: clock - 5_000,
  };
  return {
    ...base,
    ...overrides,
    identity: { ...base.identity, ...(overrides.identity ?? {}) },
    timeline: { ...base.timeline, ...(overrides.timeline ?? {}) },
  };
}

async function seedCloudRecords(records: readonly Record<string, unknown>[], cursor = 10): Promise<string> {
  const scope = mealCredentialScope()!;
  let snapshotPulled = false;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    if (url.endsWith("/session")) {
      return new Response(JSON.stringify({
        ok: true, schemaVersion: 1, enabled: true, ownerId: OWNER_ID, endpointId: ENDPOINT_ID,
        generation: 1, epoch: EPOCH, nextSequence: 1,
        expressParcelDetailsSupported: true, expressTitleClockSupported: true, expressWatchFeedbackSupported: true,
      }), { status: 200 });
    }
    if (url.endsWith("/pull")) {
      if (!snapshotPulled || body.epoch !== EPOCH) {
        snapshotPulled = true;
        return new Response(JSON.stringify({
          ok: true, schemaVersion: 1, enabled: true, ownerId: OWNER_ID, endpointId: ENDPOINT_ID,
          generation: 1, epoch: EPOCH, nextSequence: 1,
          expressParcelDetailsSupported: true, expressTitleClockSupported: true, expressWatchFeedbackSupported: true,
          mode: "snapshot", reset: true, cursor, hasMore: false, records,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        ok: true, schemaVersion: 1, enabled: true, ownerId: OWNER_ID, endpointId: ENDPOINT_ID,
        generation: 1, epoch: EPOCH, nextSequence: 1,
        expressParcelDetailsSupported: true, expressTitleClockSupported: true, expressWatchFeedbackSupported: true,
        mode: "delta", reset: false, cursor, hasMore: false, records: [],
      }), { status: 200 });
    }
    if (url.endsWith("/mutate")) {
      return new Response(JSON.stringify({ ok: false, error: "cloud_sync_disabled" }), { status: 403 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  await synchronizeParcelCloudRecords();
  resetParcelCloudDeniedBackoffForTests();
  return scope;
}

test("Task 2: JD 派送中/等待收货 estimated delivery time capture, normalization, and sync gating", async () => {
  resetEnv();
  assert.equal(normalizeParcelDeliveryEstimate("预计今天15:00-21:00送达", clock), "预计今天15:00-21:00送达");
  assert.equal(normalizeParcelDeliveryEstimate("预计11月28日21:00前送达", clock), "预计11月28日21:00前送达");
  assert.equal(displayDeliveryEstimate("预计今天15:00-21:00送达", clock - 60_000, clock), "预计今天15:00-21:00送达");
  assert.equal(displayDeliveryEstimate("预计今天15:00-21:00送达", clock - 2 * DAY, clock), "");

  const jdWaybill = "JD7700000000101";
  const jdOrder = "2900000000101";
  const rowWithTitleOnly = makeManualShipment(jdWaybill, {
    identity: {
      id: `interface5:jd:${jdWaybill}`,
      sourceOwner: "account:13800001234",
      sourceId: jdOrder,
      orderId: jdOrder,
      accountOrder: true,
      projectedWaybill: jdWaybill,
      sourceProvider: "jingdong",
      courierCode: "jd",
      rawCourierCode: "jd",
      companyName: "京东快递",
      manuallyAdded: false,
    },
    timeline: {
      waybill: jdWaybill,
      courierCode: "jd",
      companyName: "京东快递",
      semantic: "DELIVERY",
      latestDetail: "京东快递员正在为您派件",
    },
    platformFields: {
      waybill: jdWaybill,
      waybillGeneration: 0,
      title: { text: "示例自营商品", source: "jingdong" },
    },
  });
  assert.equal(missingJdDeliveryEstimate(rowWithTitleOnly, clock), true);
  assert.equal(
    missingJdDeliveryEstimate({
      ...rowWithTitleOnly,
      platformFields: {
        ...rowWithTitleOnly.platformFields!,
        estimate: { text: "预计今天15:00-21:00送达", source: "jingdong", capturedAtMs: clock },
      },
    }, clock),
    false,
  );

  saveState({ ...emptyState(), shipments: [rowWithTitleOnly] }, clock);
  savePlatformLogin("jingdong", "", { kind: "web", cookies: JD_COOKIES }, "synthetic_pin");

  const originalController = globalThis.WebViewController;
  let detailVisits = 0;
  Object.assign(globalThis, {
    WebViewController: class {
      injected = "";
      url = "";
      sandbox: Record<string, unknown> = {};
      async setCookie() { return true; }
      async getAllCookies() { return JD_COOKIES; }
      async addUserScript(opts: { source: string }) {
        this.injected = opts.source;
        return "jd-forecast-hook";
      }
      async loadURL(url: string) {
        this.url = url;
        const parsed = new URL(url);
        if (parsed.pathname.includes("deal_wuliu")) {
          detailVisits += 1;
          this.sandbox = {
            URL,
            URLSearchParams,
            location: parsed,
            document: {
              title: "订单跟踪",
              body: {
                innerText: `运单号：${jdWaybill}\n京东快递`,
                querySelectorAll: () => [{ textContent: "预计今天15:00-21:00送达" }],
              },
              querySelectorAll: () => [{ textContent: "预计今天15:00-21:00送达" }],
            },
            XMLHttpRequest: class {
              open() {}
              send() {}
              addEventListener() {}
            },
            fetch: async () => ({
              clone: () => ({
                text: async () => JSON.stringify({
                  body: { promiseText: "预计今天15:00-21:00送达", waybillCode: jdWaybill },
                }),
              }),
            }),
          };
          this.sandbox.window = this.sandbox;
          this.sandbox.top = this.sandbox;
          if (this.injected) {
            runInNewContext(this.injected, this.sandbox);
            await (this.sandbox.fetch as (u: string) => Promise<unknown>)("https://api.m.jd.com/client.action?functionId=orderTrackBusiness");
          }
          return true;
        }
        return true;
      }
      async evaluateJavaScript(script: string) {
        clock += 250;
        if (this.url.includes("orderlist")) {
          return { state: "ok", orders: [{ orderId: jdOrder, title: "示例自营商品", state: "等待收货" }] };
        }
        return runInNewContext(`(function(){${script}})()`, this.sandbox);
      }
      dispose() {}
    },
  });
  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  try {
    const syncRes = await refreshPlatformParcels(() => {}, "observe", "jingdong");
    assert.equal(syncRes.failed, 0);
    assert.equal(detailVisits, 1, "JD detail page is visited even when title is already populated because ETA is missing");
    const updated = loadState().shipments[0];
    assert.equal(displayedPlatformFields(updated, clock).estimate, "预计今天15:00-21:00送达");
  } finally {
    const session = platformSession("jingdong");
    if (session) clearPlatformLogin("jingdong", session.generation);
    globalThis.WebViewController = originalController;
    registerProjectionViewportHost(null);
  }
});

test("In7 & In10: PDD multi-parcel shipping_id isolation and JD fallback auth-error propagation", async () => {
  resetEnv();
  savePlatformLogin("pinduoduo", "", {
    kind: "web",
    cookies: [{ name: "PDDAccessToken", value: "synthetic-pdd", domain: ".yangkeduo.com", path: "/" }],
  }, "synthetic-pdd-owner");
  const pddSession = platformSession("pinduoduo")!;
  const originalController = globalThis.WebViewController;
  Object.assign(globalThis, {
    WebViewController: class {
      injected = "";
      sandbox: Record<string, unknown> = {};
      async setCookie() { return true; }
      async addUserScript(opts: { source: string }) {
        this.injected = opts.source;
        return "pdd-hook";
      }
      async loadURL(url: string) {
        const parsed = new URL(url);
        const payload = {
          orders: [
            {
              order_sn: "260101-000000000001",
              shipping_id: "73000111",
              order_goods: [{ goods_name: "分包测试商品" }],
              shipping_list: [
                { tracking_number: "YT7700000000301" },
                { tracking_number: "YT7700000000302" },
              ],
            },
            {
              order_sn: "260101-000000000002",
              shipping_id: "73000222",
              order_goods: [{ goods_name: "单包测试商品" }],
              shipping_list: [
                { tracking_number: "YT7700000000303" },
              ],
            },
          ],
        };
        this.sandbox = {
          URL,
          URLSearchParams,
          location: parsed,
          document: { body: { innerText: "" }, querySelectorAll: () => [] },
          XMLHttpRequest: class { send() {} },
          fetch: async (address: string) => ({
            ok: true,
            url: address,
            clone: () => ({ text: async () => JSON.stringify(payload) }),
          }),
        };
        this.sandbox.window = this.sandbox;
        this.sandbox.top = this.sandbox;
        runInNewContext(this.injected, this.sandbox);
        await (this.sandbox.fetch as (u: string) => Promise<unknown>)("https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4");
        await new Promise<void>((resolve) => setImmediate(resolve));
        return true;
      }
      async evaluateJavaScript(script: string) {
        clock += 250;
        return runInNewContext(`(function(){${script}})()`, this.sandbox);
      }
      dispose() {}
    },
  });
  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  try {
    const pddRows = await fetchPddOrders(pddSession);
    const byWaybill = new Map(pddRows.map((row) => [row.waybill, row]));
    assert.equal(byWaybill.get("YT7700000000301")?.shippingId, undefined, "multi-parcel child without shipping_id does not inherit order-level shipping_id");
    assert.equal(byWaybill.get("YT7700000000302")?.shippingId, undefined);
    assert.equal(byWaybill.get("YT7700000000303")?.shippingId, "73000222", "single-parcel child still inherits order-level shipping_id");
  } finally {
    clearPlatformLogin("pinduoduo", pddSession.generation);
    globalThis.WebViewController = originalController;
    registerProjectionViewportHost(null);
  }

  savePlatformLogin("jingdong", "", { kind: "web", cookies: JD_COOKIES }, "synthetic_pin");
  const jdSession = platformSession("jingdong")!;
  Object.assign(globalThis, {
    WebViewController: class {
      url = "";
      async setCookie() { return true; }
      async getAllCookies() { return JD_COOKIES; }
      async addUserScript() { return "jd-hook"; }
      async loadURL(url: string) {
        this.url = url;
        return true;
      }
      async evaluateJavaScript() {
        clock += 250;
        if (this.url.includes("deal_wuliu")) {
          return { state: "ok", waybill: "JD7700000000309", title: "" };
        }
        return { state: "expired" };
      }
      dispose() {}
    },
  });
  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  try {
    await assert.rejects(
      () => fetchJdParcelDetails(jdSession, "2900000000309", "JD7700000000309", () => true),
      (error: unknown) => error instanceof PlatformWireError && error.reason === "expired",
    );
  } finally {
    clearPlatformLogin("jingdong", jdSession.generation);
    globalThis.WebViewController = originalController;
    registerProjectionViewportHost(null);
  }
});

test("In1: local manual row never mutates/deletes cloud express record, while cloud-imported rows record tombstones", async () => {
  const scope = resetEnv();
  const localManualWaybill = "YT7700000000401";
  const cloudImportedWaybill = "YT7700000000402";
  const localManual = makeManualShipment(localManualWaybill);
  saveState({ ...emptyState(), shipments: [localManual] }, clock);

  await seedCloudRecords([
    {
      recordId: "11111111-1111-4111-8111-000000000401",
      type: "express",
      revision: 3,
      changedAt: clock - 1_000,
      editedAt: clock - 1_000,
      deleted: false,
      lifecycle: "active",
      historyAt: 0,
      payload: {
        waybill: localManualWaybill,
        carrierCode: "zto",
        carrierName: "中通快递",
        status: "TRANSIT",
        updatedAt: clock - 1_000,
      },
    },
    {
      recordId: "11111111-1111-4111-8111-000000000402",
      type: "express",
      revision: 4,
      changedAt: clock - 1_000,
      editedAt: clock - 1_000,
      deleted: false,
      lifecycle: "active",
      historyAt: 0,
      payload: {
        waybill: cloudImportedWaybill,
        carrierCode: "zto",
        carrierName: "中通快递",
        status: "TRANSIT",
        updatedAt: clock - 1_000,
      },
    },
  ]);

  const afterSeed = loadState();
  const matchedLocal = afterSeed.shipments.find((row) => row.timeline.waybill === localManualWaybill)!;
  const importedCloud = afterSeed.shipments.find((row) => row.timeline.waybill === cloudImportedWaybill)!;
  assert.equal(matchedLocal.cloudExpressOrigin, undefined, "pre-existing local manual row never acquires cloudExpressOrigin");
  assert.equal(importedCloud.cloudExpressOrigin?.waybill, cloudImportedWaybill, "cloud-created row carries cloudExpressOrigin");

  const pddNewWaybill = "YT7700000000403";
  const { state: afterPddImport } = saveCloudPddParcels([
    { waybill: localManualWaybill, anchorAt: clock - 20_000, terminalAt: 0, carrierCode: "zto", phone4: "1234" },
    { waybill: pddNewWaybill, anchorAt: clock - 20_000, terminalAt: 0, carrierCode: "zto", phone4: "1234" },
  ], loadState(), () => true, clock + 100);
  assert.equal(afterPddImport.shipments.find((row) => row.timeline.waybill === localManualWaybill)?.cloudExpressOrigin, undefined);
  assert.equal(afterPddImport.shipments.find((row) => row.timeline.waybill === pddNewWaybill)?.cloudExpressOrigin?.waybill, pddNewWaybill);
  assert.equal(hasPddParcelSource(afterPddImport.shipments.find((row) => row.timeline.waybill === localManualWaybill)!), true);

  clock += 1_000;
  removeShipmentWithCleanup(matchedLocal.identity.id, clock);
  assert.equal(
    (loadState().cloudPddTombstones ?? []).some((entry) => entry.waybill === localManualWaybill),
    false,
    "local manual removal does not write cloudPddTombstones",
  );

  reconcileParcelCloudRecordsWithLocal(scope, clock);
  assert.equal(
    readParcelCloudState(scope).edits["11111111-1111-4111-8111-000000000401"],
    undefined,
    "scripting-parcel never queues delete/put mutations on express records",
  );
  assert.equal(
    loadState().shipments.some((row) => row.timeline.waybill === localManualWaybill),
    false,
    "deleted local manual row does not resurrect at the same cloud revision",
  );

  forceCompleteShipment(importedCloud.identity.id, clock + 500);
  assert.equal(
    (loadState().cloudPddTombstones ?? []).some((entry) =>
      entry.waybill === cloudImportedWaybill && entry.action === "completed" && entry.actedAtMs >= clock + 500),
    true,
    "cloud-imported row records a tombstone on local force-completion",
  );
  reconcileParcelCloudRecordsWithLocal(scope, clock + 500);
  const cloudRowCompletionEdit = readParcelCloudState(scope).edits["11111111-1111-4111-8111-000000000402"];
  assert.equal(cloudRowCompletionEdit?.lifecycle, "history", "cloud-imported row syncs force-completion back to its cloud express record");
  assert.equal(cloudRowCompletionEdit?.payload?.status, "COMPLETED");
});

test("In6: explicit remote express_pdd_link invalidation (shippingId='' with observedAt > 1) is respected", async () => {
  const waybill = "YT7700000000501";
  const linkRecordId = parcelDetailRecordId("parcel-pdd-link:", waybill);

  // Case 1: remote invalidated at observedAt = clock + 5_000 (>= local observedAt) -> local must NOT overwrite!
  const scope1 = resetEnv();
  const row1 = makeManualShipment(waybill, {
    pddImport: {
      ownerKey: "synthetic-pdd",
      orderId: "260101-501",
      shippingId: "73000501",
    },
  });
  saveState({ ...emptyState(), shipments: [row1] }, clock);
  await seedCloudRecords([{
    recordId: linkRecordId,
    type: "express_pdd_link",
    revision: 2,
    changedAt: clock + 5_000,
    editedAt: clock + 5_000,
    deleted: false,
    lifecycle: "active",
    historyAt: 0,
    payload: {
      waybill,
      anchorAt: clock - 20_000,
      terminalAt: 0,
      shippingId: "",
      observedAt: clock + 5_000,
    },
  }]);
  assert.equal(readParcelCloudState(scope1).edits[linkRecordId], undefined, "explicit invalidation with newer remote observedAt is not overwritten");

  const completed1: Shipment = {
    ...loadState().shipments[0],
    timeline: { ...loadState().shipments[0].timeline, complete: true, semantic: "COMPLETED", statusEventAtMs: clock + 6_000 },
    settledAtMs: clock + 6_000,
  };
  saveState({ ...loadState(), shipments: [completed1] }, clock + 6_000);
  reconcileParcelCloudRecordsWithLocal(scope1, clock + 6_000);
  const terminalOnlyEdit = readParcelCloudState(scope1).edits[linkRecordId];
  if (terminalOnlyEdit) {
    assert.equal(terminalOnlyEdit.payload?.shippingId, "", "terminal advancement never resurrects an invalidated shippingId");
  }

  // Case 2: placeholder remoteObserved === 1 with shippingId === "" IS filled by local valid shippingId!
  const scope2 = resetEnv();
  saveState({ ...emptyState(), shipments: [row1] }, clock);
  await seedCloudRecords([{
    recordId: linkRecordId,
    type: "express_pdd_link",
    revision: 1,
    changedAt: 1,
    editedAt: 1,
    deleted: false,
    lifecycle: "active",
    historyAt: 0,
    payload: {
      waybill,
      anchorAt: clock - 20_000,
      terminalAt: 0,
      shippingId: "",
      observedAt: 1,
    },
  }]);
  assert.equal(readParcelCloudState(scope2).edits[linkRecordId]?.payload?.shippingId, "73000501");
});

test("I-A residual: strictly equal timestamps resolve deterministically via canonicalWholeRecordDigest without advancing clocks", async () => {
  const equalEditedAt = NOW - 3_000;
  const noteWaybill = "YT7700000000601";
  const noteRecordId = parcelDetailRecordId("parcel-note:", noteWaybill);
  const payloadAlpha = {
    subject: `waybill:${noteWaybill}`,
    waybill: noteWaybill,
    note: "放在门口鞋柜上",
    anchorAt: NOW - 20_000,
    status: "TRANSIT",
  };
  const payloadBeta = {
    subject: `waybill:${noteWaybill}`,
    waybill: noteWaybill,
    note: "放丰巢不要打电话",
    anchorAt: NOW - 20_000,
    status: "TRANSIT",
  };

  const digestAlpha = canonicalWholeRecordDigest("express_note", "active", payloadAlpha, NOW);
  const digestBeta = canonicalWholeRecordDigest("express_note", "active", payloadBeta, NOW);
  assert.notEqual(digestAlpha, digestBeta);
  const expectedWinner = digestAlpha > digestBeta ? payloadAlpha : payloadBeta;

  // Device 1 sets Alpha at equalEditedAt, then pulls Beta with identical editedAt
  const scopeA = resetEnv(equalEditedAt);
  saveState({ ...emptyState(), shipments: [makeManualShipment(noteWaybill)] }, equalEditedAt);
  setShipmentNote(loadState().shipments[0], payloadAlpha.note, equalEditedAt);
  await seedCloudRecords([{
    recordId: noteRecordId,
    type: "express_note",
    revision: 2,
    changedAt: equalEditedAt,
    editedAt: equalEditedAt,
    deleted: false,
    lifecycle: "active",
    historyAt: 0,
    payload: payloadBeta,
  }]);
  const stateA = loadState().shipments[0];
  const editA = readParcelCloudState(scopeA).edits[noteRecordId];

  // Device 2 sets Beta at equalEditedAt, then pulls Alpha with identical editedAt
  const scopeB = resetEnv(equalEditedAt);
  saveState({ ...emptyState(), shipments: [makeManualShipment(noteWaybill)] }, equalEditedAt);
  setShipmentNote(loadState().shipments[0], payloadBeta.note, equalEditedAt);
  await seedCloudRecords([{
    recordId: noteRecordId,
    type: "express_note",
    revision: 2,
    changedAt: equalEditedAt,
    editedAt: equalEditedAt,
    deleted: false,
    lifecycle: "active",
    historyAt: 0,
    payload: payloadAlpha,
  }]);
  const stateB = loadState().shipments[0];
  const editB = readParcelCloudState(scopeB).edits[noteRecordId];

  assert.equal(stateA.note, expectedWinner.note);
  assert.equal(stateB.note, expectedWinner.note);
  if (expectedWinner === payloadAlpha) {
    assert.equal(editA?.editedAt, equalEditedAt, "winner timestamp is never bumped (+1ms forbidden)");
    assert.equal(editA?.payload?.note, payloadAlpha.note);
    assert.equal(editB, undefined, "losing side adopts remote without ping-pong upload");
  } else {
    assert.equal(editB?.editedAt, equalEditedAt, "winner timestamp is never bumped (+1ms forbidden)");
    assert.equal(editB?.payload?.note, payloadBeta.note);
    assert.equal(editA, undefined, "losing side adopts remote without ping-pong upload");
  }

  // Distinct canonical digests across express, parcel_pickup, and parcel_handoff
  assert.notEqual(
    canonicalWholeRecordDigest("express", "active", { waybill: noteWaybill, carrierCode: "zto", status: "TRANSIT", updatedAt: equalEditedAt }, NOW),
    canonicalWholeRecordDigest("express", "active", { waybill: noteWaybill, carrierCode: "sf", status: "DELIVERY", updatedAt: equalEditedAt }, NOW),
  );
  assert.notEqual(
    canonicalWholeRecordDigest("parcel_pickup", "active", { code: "1-2-3001", location: "东门驿站", capturedAt: equalEditedAt }, NOW),
    canonicalWholeRecordDigest("parcel_pickup", "active", { code: "1-2-3002", location: "西门驿站", capturedAt: equalEditedAt }, NOW),
  );
  assert.notEqual(
    canonicalWholeRecordDigest("parcel_handoff", "active", { code: "8801", platform: "cainiao", capturedAt: equalEditedAt }, NOW),
    canonicalWholeRecordDigest("parcel_handoff", "active", { code: "8802", platform: "cainiao", capturedAt: equalEditedAt }, NOW),
  );
});

test("I-C residual: clock_skew / future_timestamp rejections are transient and never quarantine valid local edits", async () => {
  const scope = resetEnv();
  const waybill = "YT7700000000701";
  const noteRecordId = parcelDetailRecordId("parcel-note:", waybill);
  saveState({ ...emptyState(), shipments: [makeManualShipment(waybill)] }, clock);
  setShipmentNote(loadState().shipments[0], "待同步备注", clock);
  await seedCloudRecords([]);

  const clockSkewError = new GatewayError("clock_skew", 400, "clock_skew");
  const futureTimestampError = new GatewayError("future_timestamp", 400, "future_timestamp");
  const invalidPayloadError = new GatewayError("invalid_cloud_record_payload", 400, "invalid_cloud_record_payload");

  assert.equal(isDeterministicParcelMutationRejection(clockSkewError), false);
  assert.equal(isDeterministicParcelMutationRejection(futureTimestampError), false);
  assert.equal(isDeterministicParcelMutationRejection(invalidPayloadError), true);

  const before = readParcelCloudState(scope);
  assert.ok(before.edits[noteRecordId]);
  const frozen = prepareParcelBatch(before, clock, "22222222-2222-4222-8222-000000000701");
  assert.ok(frozen.batch);

  const afterTransientSkew = dropRejectedParcelBatch(frozen, frozen.batch!, clockSkewError);
  assert.equal(afterTransientSkew.batch, undefined);
  assert.equal(
    afterTransientSkew.quarantined?.[noteRecordId],
    undefined,
    "clock_skew must NOT write quarantined[recordId] so the edit retries once clock catches up",
  );
});

test("I-G residual: one-time cleanup clears legacy 0.9.38/0.9.39 manualTitle copied from cloudProductName while keeping user titles", async () => {
  const scope = resetEnv();
  const pollutedWaybill = "YT7700000000801";
  const userEditedWaybill = "YT7700000000802";
  const polluted = makeManualShipment(pollutedWaybill, {
    platformFields: {
      waybill: pollutedWaybill,
      waybillGeneration: 0,
      manualTitle: "云端同步商品标题",
      cloudProductName: "云端同步商品标题",
      cloudProductNameObservedAtMs: clock - 15_000,
    },
  });
  const userEdited = makeManualShipment(userEditedWaybill, {
    platformFields: {
      waybill: userEditedWaybill,
      waybillGeneration: 0,
      manualTitle: "我手动改的专属备注名",
      manualTitleEditedAtMs: clock - 5_000,
      cloudProductName: "云端原始商品名",
      cloudProductNameObservedAtMs: clock - 15_000,
    },
  });
  saveState({ ...emptyState(), shipments: [polluted, userEdited] }, clock);

  const loaded = loadState();
  assert.equal(
    loaded.shipments.find((row) => row.timeline.waybill === pollutedWaybill)?.platformFields?.manualTitle,
    undefined,
    "legacy manualTitle matching cloudProductName without manualTitleEditedAtMs is cleared",
  );
  assert.equal(
    loaded.shipments.find((row) => row.timeline.waybill === userEditedWaybill)?.platformFields?.manualTitle,
    "我手动改的专属备注名",
    "genuine user manualTitle distinct from cloudProductName is preserved",
  );

  // Also verify reconcile-time cleanup when legacy manualTitle matches remote express_metadata.productName
  const remotePollutedWaybill = "YT7700000000803";
  saveState({
    ...emptyState(),
    shipments: [makeManualShipment(remotePollutedWaybill, {
      platformFields: {
        waybill: remotePollutedWaybill,
        waybillGeneration: 0,
        manualTitle: "远端元商品名",
      },
    })],
  }, clock);
  await seedCloudRecords([{
    recordId: parcelDetailRecordId("parcel-metadata:", remotePollutedWaybill),
    type: "express_metadata",
    revision: 1,
    changedAt: clock - 5_000,
    editedAt: clock - 5_000,
    deleted: false,
    lifecycle: "active",
    historyAt: 0,
    payload: {
      waybill: remotePollutedWaybill,
      anchorAt: clock - 20_000,
      terminalAt: 0,
      productName: "远端元商品名",
      productNameObservedAt: clock - 10_000,
    },
  }]);
  assert.equal(loadState().shipments[0].platformFields?.manualTitle, undefined);
  assert.equal(readParcelCloudState(scope).legacyManualTitleCleaned, true);
});

test("I-F: iOS merge helpers match live Worker cloud_records.js merge functions byte-for-byte", () => {
  const workerPath = new URL("../../../../cloudflare/express-gateway/src/beta-source/cloud_records.js", import.meta.url);
  assert.equal(existsSync(workerPath), true, "monorepo Worker cloud_records.js exists for cross-check");
  const workerSrc = readFileSync(workerPath, "utf8");
  const start = workerSrc.indexOf("function mergeExpressMetadata(");
  const end = workerSrc.indexOf("function readOnlySubrouteInput(");
  assert.ok(start > 0 && end > start);
  const slice = workerSrc.slice(start, end);
  const workerMerges = runInNewContext(
    `${slice}\n;({ mergeExpressMetadata, mergeExpressPddLink, mergeExpressWatchFeedback });`,
    {
      URL,
      DAY,
      pddProductImageHost: (host: string) => /^img(?:-[1-4])?\.pddpic\.com$/i.test(host),
      fail: (code: string) => { throw new Error(code); },
    },
  ) as {
    mergeExpressMetadata: (prev: Record<string, unknown> | undefined, next: Record<string, unknown>) => Record<string, unknown>;
    mergeExpressPddLink: (prev: Record<string, unknown> | undefined, next: Record<string, unknown>) => Record<string, unknown>;
    mergeExpressWatchFeedback: (prev: Record<string, unknown> | undefined, next: Record<string, unknown>) => Record<string, unknown>;
  };
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

  const metadataVectors: ReadonlyArray<readonly [Record<string, unknown> | undefined, Record<string, unknown>]> = [
    [
      {
        waybill: "YT7700000000901",
        anchorAt: 2_000,
        terminalAt: 0,
        productImageUrl: "https://img-2.pddpic.com/goods.jpeg",
        productName: "旧商品名",
        productNameObservedAt: 5_000,
        deliveryEstimate: "预计明天送达",
        deliveryEstimateObservedAt: 6_000,
      },
      {
        waybill: "YT7700000000901",
        anchorAt: 1_500,
        terminalAt: 9_000,
        productImageUrl: "https://img.alicdn.com/override.jpg",
        productName: "新商品名",
        productNameObservedAt: 7_000,
        deliveryEstimate: "预计今天18:00前送达",
        deliveryEstimateObservedAt: 5_500,
      },
    ],
    [
      {
        waybill: "YT7700000000901",
        anchorAt: 1_000,
        terminalAt: 2_000,
        productName: "上一轮包裹",
        productNameObservedAt: 1_500,
      },
      {
        waybill: "YT7700000000901",
        anchorAt: 2_000 + DAY + 10,
        terminalAt: 0,
        productName: "复用单号新包裹",
        productNameObservedAt: 2_000 + DAY + 20,
      },
    ],
    [
      {
        waybill: "YT7700000000901",
        anchorAt: 1_000,
        terminalAt: 0,
        productName: "同名商品",
        productNameObservedAt: 8_000,
        deliveryEstimate: "预计明日送达",
        deliveryEstimateObservedAt: 4_000,
      },
      {
        waybill: "YT7700000000901",
        anchorAt: 1_200,
        terminalAt: 0,
        productName: "同名商品",
        productNameObservedAt: 3_000,
        deliveryEstimate: "预计明日送达",
        deliveryEstimateObservedAt: 9_000,
      },
    ],
  ];
  for (const [prev, next] of metadataVectors) {
    assert.deepEqual(plain(mergeParcelCloudMetadata(prev, next)), plain(workerMerges.mergeExpressMetadata(prev, next)));
  }

  const pddLinkVectors: ReadonlyArray<readonly [Record<string, unknown> | undefined, Record<string, unknown>]> = [
    [
      { waybill: "YT7700000000902", anchorAt: 2_000, terminalAt: 0, shippingId: "73001", observedAt: 5_000 },
      { waybill: "YT7700000000902", anchorAt: 1_500, terminalAt: 8_000, shippingId: "73002", observedAt: 5_000 },
    ],
    [
      { waybill: "YT7700000000902", anchorAt: 2_000, terminalAt: 0, shippingId: "73001", observedAt: 5_000 },
      { waybill: "YT7700000000902", anchorAt: 2_500, terminalAt: 0, shippingId: "", observedAt: 6_000 },
    ],
  ];
  for (const [prev, next] of pddLinkVectors) {
    assert.deepEqual(plain(mergeParcelCloudPddLink(prev, next)), plain(workerMerges.mergeExpressPddLink(prev, next)));
  }

  const feedbackVectors: ReadonlyArray<readonly [Record<string, unknown> | undefined, Record<string, unknown>]> = [
    [
      { waybill: "YT7700000000903", watchRecordId: "w1", action: "completed", actedAt: 5_000 },
      { waybill: "YT7700000000903", watchRecordId: "w1", action: "deleted", actedAt: 5_000 },
    ],
    [
      { waybill: "YT7700000000903", watchRecordId: "", action: "completed", actedAt: 5_000 },
      { waybill: "YT7700000000903", watchRecordId: "w2", action: "completed", actedAt: 5_000 },
    ],
  ];
  for (const [prev, next] of feedbackVectors) {
    assert.deepEqual(plain(mergeParcelCloudWatchFeedback(prev, next)), plain(workerMerges.mergeExpressWatchFeedback(prev, next)));
  }

  assert.deepEqual(
    mergeParcelCloudCodeNote({ code: "1-2-3", note: "保留取件备注" }, { code: "1-2-3" }),
    { code: "1-2-3", note: "保留取件备注" },
  );
  assert.deepEqual(
    mergeParcelCloudCodeNote({ code: "1-2-3", note: "旧备注" }, { code: "1-2-3", note: "" }),
    { code: "1-2-3", note: "" },
  );
});

test("In3 + Phase 2: DetailPage post-paint hydration runs once without self-aborting on imageScope updates", async () => {
  const rawDetailSrc = readFileSync(new URL("../pages/DetailPage.tsx", import.meta.url), "utf8");
  const effectStart = rawDetailSrc.indexOf("useEffect(() => {\n    const controller = new AbortController();\n    void finishDetailOpening(controller.signal);");
  const effectEnd = rawDetailSrc.indexOf("function refresh(forceManualRefresh = false)");
  const fnStart = rawDetailSrc.indexOf("async function finishDetailOpening(signal: AbortSignal)");
  const fnEnd = rawDetailSrc.indexOf("async function copyWaybill()");
  assert.ok(effectStart > 0 && effectEnd > effectStart && fnStart > 0 && fnEnd > fnStart, "located DetailPage post-paint hydration effect and finishDetailOpening");
  const effectBody = stripTypeScriptTypes(
    `${rawDetailSrc.slice(fnStart, fnEnd)}\n${rawDetailSrc.slice(effectStart, effectEnd)}`,
    { mode: "transform" },
  );

  const events: string[] = [];
  let effectCleanup: (() => void) | undefined;
  let lastDeps: readonly unknown[] | undefined;
  let refreshPromise: Promise<unknown> | null = null;

  function runDetailHydrationRender(params: {
    detailPostPaintReady: boolean;
    shipmentId: string;
    cloudLifecycle: string;
    imageScope: string;
  }) {
    const row = { identity: { id: params.shipmentId }, timeline: { waybill: "YT7700000001001" } };
    if (params.detailPostPaintReady && !refreshPromise) {
      refreshPromise = Promise.resolve().then(() => {
        events.push("timeline");
        return row;
      });
    }
    const sandbox = {
      detailPostPaintReady: params.detailPostPaintReady,
      props: {
        shipment: row,
        persistedShipment: true,
        onStateChange: () => events.push("stateChange"),
      },
      shipment: row,
      cloudLifecycle: params.cloudLifecycle,
      imageScope: params.imageScope,
      syncedInternational: false,
      AbortController,
      cloudAbortRef: { current: null },
      refreshInFlightRef: { current: refreshPromise },
      pullInFlightRef: { current: null },
      refreshGenerationRef: { current: 1 },
      shipmentLifecycleKey: () => params.cloudLifecycle,
      needsParcelDetailFields: () => true,
      readOwnerState: () => ({ shipments: [row] }),
      refreshCloudMetadata: async () => undefined,
      showShipment: () => {},
      synchronizeParcelCloudRecords: async () => {},
      refreshParcelDetailFields: async (_row: unknown, current: () => boolean, _readState: unknown, signal?: AbortSignal) => {
        assert.equal(current(), true);
        assert.equal(signal?.aborted, false);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(signal?.aborted, false, "in-flight detail field hydration is NOT aborted by imageScope re-render");
        events.push("platformFields");
        return { state: { shipments: [row] }, shipment: row };
      },
      setImageDownloadScope: (scope: string) => events.push(`imageScope:${scope}`),
      refreshProductImage: async () => {
        events.push("productImage");
      },
      useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => {
        const changed = !lastDeps || deps.length !== lastDeps.length || deps.some((value, idx) => !Object.is(value, lastDeps![idx]));
        if (changed) {
          effectCleanup?.();
          lastDeps = deps;
          const cleanup = fn();
          effectCleanup = typeof cleanup === "function" ? cleanup : undefined;
        }
      },
    };
    runInNewContext(effectBody, sandbox);
  }

  // Render 1: cold/widget entry before first frame (`detailPostPaintReady === false`) -> must NOT start!
  runDetailHydrationRender({
    detailPostPaintReady: false,
    shipmentId: "interface5:manual:YT7700000001001",
    cloudLifecycle: "YT7700000001001:1000",
    imageScope: "",
  });
  assert.deepEqual(events, []);

  // Render 2: first frame painted (`detailPostPaintReady === true`) -> starts single hydration pipeline!
  runDetailHydrationRender({
    detailPostPaintReady: true,
    shipmentId: "interface5:manual:YT7700000001001",
    cloudLifecycle: "YT7700000001001:1000",
    imageScope: "pdd:YT7700000001001:1000",
  });

  // Render 3: mid-flight `imageScope` changes while `refreshParcelDetailFields` is still awaiting -> must NOT re-run or abort!
  runDetailHydrationRender({
    detailPostPaintReady: true,
    shipmentId: "interface5:manual:YT7700000001001",
    cloudLifecycle: "YT7700000001001:1000",
    imageScope: "pdd:YT7700000001001:2000",
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ["timeline", "platformFields", "stateChange", "imageScope:pdd:YT7700000001001:1000", "productImage"]);
  effectCleanup?.();
});

test("0.9.46 Phase 1: v3_list enhancement budget guard, widget reload coalescing, and failure backoff", async () => {
  resetEnv();

  // 1. enhanceAccountParcels skips v3_list when remaining deadline < 2200ms
  let v3Calls = 0;
  const jdOrder = "365000000001101";
  const binding: AccountBinding = {
    source: "interface5",
    phone: "13800138000",
    boundAtMs: 100,
    enhancedMode: true,
    enhancedAtMs: 200,
  };
  const dto: AccountParcelDto = {
    source: "interface5",
    ownerId: jdOrder,
    orderId: jdOrder,
    waybill: jdOrder,
    accountOrder: true,
    courierCode: "JDKD",
    companyName: "京东商品快递",
    carrierNormalization: null,
    sourceProvider: "JingDong",
    sourceStateCode: "104",
    sourceStateText: "运输中",
    semantic: "TRANSIT",
    receiverPhone: "13800138000",
    senderPhone: "",
    latestTimeText: "2026-11-27 11:00:00",
    latestDetail: "运输中",
    tracks: [],
    routeUrl: "",
    projectionUrl: "",
  };
  const tightResult = await enhanceAccountParcels([dto], [binding], {
    deadlineAtMs: clock + 1_500,
    identity: { accountId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", androidId: "0123456789abcdef" },
    request: async () => {
      v3Calls += 1;
      return { records: [], ambiguousOrderIds: [] };
    },
  });
  assert.equal(v3Calls, 0, "v3_list is skipped when remaining budget before deadline is < 2200ms");
  assert.equal(tightResult.length, 1);
  assert.ok(readDiagnostics().some((entry) =>
    entry.event === "account.enhanced.skipped" && entry.details.skipReason === "budget_exhausted"));

  // 2. requestWidgetReload coalesces duplicate calls for the same persisted stateRef within 1500ms
  resetWidgetReloadCoalescingForTests();
  widgetReloadCount = 0;
  assert.equal(requestWidgetReload(clock), true);
  assert.equal(requestWidgetReload(clock + 200), false, "duplicate reload for same stateRef within 1500ms is coalesced");
  assert.equal(widgetReloadCount, 1);

  saveState({ ...loadState(), shipments: [makeManualShipment("YT7700000001102")] }, clock + 300);
  assert.equal(requestWidgetReload(clock + 350), true, "persisting a new stateRef allows immediate reload");
  assert.equal(widgetReloadCount, 2);
  assert.equal(requestWidgetReload(clock + 400), false, "duplicate reload for the newly persisted stateRef is coalesced");
  assert.equal(widgetReloadCount, 2);
  assert.equal(requestWidgetReload(clock + 2_500), true, "reload after coalesce window succeeds");

  // 3. shouldRunWidgetNetworkRefresh backs off recent failed attempts on same revision, allows newer revision
  recordWidgetNetworkFailure(13, clock);
  const failure = lastWidgetNetworkFailure();
  assert.deepEqual(failure, { failedAtMs: clock, stateRevision: 13 });
  const staleUpdatedAt = clock - 120_000;
  assert.equal(
    shouldRunWidgetNetworkRefresh(staleUpdatedAt, clock + 15_000, { ...failure!, currentStateRevision: 13 }),
    false,
    "back-to-back reload 15s after widget timeout/failure backs off on unchanged revision",
  );
  assert.equal(
    shouldRunWidgetNetworkRefresh(staleUpdatedAt, clock + 15_000, { ...failure!, currentStateRevision: 14 }),
    true,
    "newer persisted state revision bypasses previous revision's failure backoff",
  );
  assert.equal(
    shouldRunWidgetNetworkRefresh(staleUpdatedAt, clock + 50_000, { ...failure!, currentStateRevision: 13 }),
    true,
    "backoff expires after WIDGET_FAILURE_BACKOFF_MS (45s)",
  );
});

test("0.9.46 Phase 3 & Phase 4: foreground projection stability and cancelable non-blocking diagnostics snapshot", async () => {
  resetEnv();

  // Phase 3: slice pure-TS foreground projection helpers from index.tsx before JSX!
  const rawIndexSrc = readFileSync(new URL("../index.tsx", import.meta.url), "utf8");
  const projStart = rawIndexSrc.indexOf("function sameForegroundShipmentProjection(");
  const projEnd = rawIndexSrc.indexOf("function usePickupTabState(");
  assert.ok(projStart > 0 && projEnd > projStart);
  const projCode = stripTypeScriptTypes(rawIndexSrc.slice(projStart, projEnd), { mode: "transform" })
    .replace(/^export /gm, "");
  const projections = runInNewContext(
    `${projCode}\n;({ selectForegroundShipmentsProjection, selectForegroundPickupCardsProjection });`,
    {
      displayWaybill: (s: Shipment) => s.timeline.waybill,
      resolveShipmentTitle: (s: Shipment) => s.platformFields?.manualTitle || s.timeline.companyName,
      shipmentStatusLabel: (s: Shipment) => s.timeline.semantic,
      shipmentSubtitle: (s: Shipment) => s.timeline.latestDetail,
      displayedPlatformFields: (s: Shipment) => ({ estimate: s.platformFields?.estimate?.text || "" }),
      cainiaoParcelProductImage: () => "",
      pddParcelProductImage: () => "",
    },
  ) as {
    selectForegroundShipmentsProjection: (prev: readonly Shipment[], next: readonly Shipment[]) => readonly Shipment[];
    selectForegroundPickupCardsProjection: <T extends Record<string, unknown>>(prev: readonly T[], next: readonly T[]) => readonly T[];
  };

  const baseRow = makeManualShipment("YT7700000001201");
  const firstList = [baseRow];
  const detailOnlyUpdatedList = [{
    ...baseRow,
    updatedAtMs: clock + 5_000,
    timeline: {
      ...baseRow.timeline,
      tracks: [
        ...baseRow.timeline.tracks,
        { timeMs: clock - 30_000, timeText: "2026-11-27 11:30:00", detail: "历史节点补充", statusCode: "PICKED", raw: {} },
      ],
    },
  }];
  assert.equal(
    projections.selectForegroundShipmentsProjection(firstList, detailOnlyUpdatedList),
    firstList,
    "detail-only track history / updatedAtMs changes preserve previous shipments array reference",
  );
  const titleUpdatedList = [{
    ...baseRow,
    platformFields: { waybill: "YT7700000001201", waybillGeneration: 0, manualTitle: "新标题" },
  }];
  assert.equal(
    projections.selectForegroundShipmentsProjection(firstList, titleUpdatedList),
    titleUpdatedList,
    "visible list field changes publish the new array immediately",
  );

  const cardA = [{ kind: "parcel", code: "1-2-3001", title: "包裹", location: "驿站", note: "" }];
  const cardASame = [{ kind: "parcel", code: "1-2-3001", title: "包裹", location: "驿站", note: "" }];
  const cardAChanged = [{ kind: "parcel", code: "1-2-3001", title: "包裹", location: "驿站", note: "易碎" }];
  assert.equal(projections.selectForegroundPickupCardsProjection(cardA, cardASame), cardA);
  assert.equal(projections.selectForegroundPickupCardsProjection(cardA, cardAChanged), cardAChanged);

  // Phase 4: peekRecentDiagnostics + cancelable readDiagnosticsSnapshot
  startAppDiagnosticWrites();
  try {
    writeDiagnostic("meal.cards.loaded", { records: 1, result: "shown" });
    assert.ok(peekRecentDiagnostics().some((entry) => entry.event === "meal.cards.loaded"));

    const abortedController = new AbortController();
    abortedController.abort();
    const cancelledEntries = await readDiagnosticsSnapshot(abortedController.signal);
    assert.deepEqual(cancelledEntries, []);

    const loadedEntries = await readDiagnosticsSnapshot();
    assert.ok(loadedEntries.some((entry) => entry.event === "meal.cards.loaded"));
    assert.ok(peekRecentDiagnostics().some((entry) => entry.event === "meal.cards.loaded"));
  } finally {
    await drainAppDiagnostics();
  }
});
