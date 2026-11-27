import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { memory, sha256 } from "./state-storage-mock.ts";
import type { Shipment } from "../models.ts";

const NOW = Date.UTC(2026, 10, 26, 4, 0, 0);
const DAY = 24 * 60 * 60 * 1_000;
let clock = NOW;
const realNow = Date.now;
Date.now = () => clock;
process.on("exit", () => {
  Date.now = realNow;
});

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
  Widget: { reloadAll() {} },
  Device: { systemVersion: "26.0", isiPhone: true, screen: { width: 393, height: 852, scale: 3 } },
  Script: { directory: "/synthetic", name: "Pipi Deliveries", createRunSingleURLScheme: () => "scripting://pipi" },
});

const { saveGatewayToken } = await import("../services/credentials.ts");
const { GatewayError } = await import("../services/gateway.ts");
const { mealCredentialScope } = await import("../services/meal/rules.ts");
const {
  applyParcelPage,
  applyParcelReceipt,
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
const { displayedPlatformFields } = await import("../services/platform-parcel-merge.ts");
const { needsParcelDetailFields } = await import("../services/parcel-detail-fields.ts");
const { refreshOnlineShipment } = await import("../services/sync/manual-chain-runner.ts");
const { saveNotificationStatuses } = await import("../services/notification-preferences.ts");
const { replayPendingShipmentNotifications } = await import("../services/notifications.ts");
const { setDiagnosticsEnabled, readDiagnostics } = await import("../services/logger.ts");
const { loadRowLedger } = await import("../services/row-ledger.ts");
const {
  emptyState,
  forceCompleteShipment,
  loadState,
  removeShipmentWithCleanup,
  saveState,
  setShipmentNote,
} = await import("../services/storage.ts");

const OWNER_ID = "a".repeat(64);
const ENDPOINT_ID = `scripting-parcel:${"b".repeat(64)}`;
const EPOCH = "11111111-2222-4333-8444-555555555555";

function resetEnv(at = NOW): string {
  clock = at;
  memory.clear();
  resetParcelCloudDeniedBackoffForTests();
  setDiagnosticsEnabled(true);
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
      latestTimeText: "2026-11-26 11:50:00",
      latestDetail: "快件运输中",
      tracks: [
        {
          timeMs: clock - 10_000,
          timeText: "2026-11-26 11:50:00",
          detail: "快件运输中",
          statusCode: "TRANSIT",
          raw: {},
        },
        {
          timeMs: clock - 20_000,
          timeText: "2026-11-26 11:40:00",
          detail: "已揽收",
          statusCode: "PICKED",
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

function makeAutomaticShipment(waybill: string, overrides: Partial<Shipment> = {}): Shipment {
  const base = makeManualShipment(waybill, overrides);
  return {
    ...base,
    ...overrides,
    identity: {
      ...base.identity,
      id: `interface5:cainiao:${waybill}`,
      sourceOwner: "account:13800001234",
      sourceProvider: "cainiao",
      phone: "13800001234",
      manuallyAdded: false,
      ...(overrides.identity ?? {}),
    },
  };
}

async function seedCloudSessionAndRemote(
  records: readonly Record<string, unknown>[],
  cursor = 10,
): Promise<string> {
  const scope = mealCredentialScope()!;
  let snapshotPulled = false;
  let deltaPulled = false;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    if (url.endsWith("/session")) {
      return new Response(
        JSON.stringify({
          ok: true,
          schemaVersion: 1,
          enabled: true,
          ownerId: OWNER_ID,
          endpointId: ENDPOINT_ID,
          generation: 1,
          epoch: EPOCH,
          nextSequence: 1,
          expressParcelDetailsSupported: true,
          expressTitleClockSupported: true,
          expressWatchFeedbackSupported: true,
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/pull")) {
      if (!snapshotPulled || body.epoch !== EPOCH) {
        snapshotPulled = true;
        return new Response(
          JSON.stringify({
            ok: true,
            schemaVersion: 1,
            enabled: true,
            ownerId: OWNER_ID,
            endpointId: ENDPOINT_ID,
            generation: 1,
            epoch: EPOCH,
            nextSequence: 1,
            expressParcelDetailsSupported: true,
            expressTitleClockSupported: true,
            expressWatchFeedbackSupported: true,
            mode: "snapshot",
            reset: true,
            cursor,
            hasMore: false,
            records,
          }),
          { status: 200 },
        );
      }
      deltaPulled = true;
      return new Response(
        JSON.stringify({
          ok: true,
          schemaVersion: 1,
          enabled: true,
          ownerId: OWNER_ID,
          endpointId: ENDPOINT_ID,
          generation: 1,
          epoch: EPOCH,
          nextSequence: 1,
          expressParcelDetailsSupported: true,
          expressTitleClockSupported: true,
          expressWatchFeedbackSupported: true,
          mode: "delta",
          reset: false,
          cursor,
          hasMore: false,
          records: [],
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/mutate")) {
      // Stop right after seeding + reconciling so callers can inspect queued edits directly.
      return new Response(JSON.stringify({ ok: false, error: "cloud_sync_disabled" }), { status: 403 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  await synchronizeParcelCloudRecords();
  assert.equal(snapshotPulled && deltaPulled, true);
  resetParcelCloudDeniedBackoffForTests();
  const snap = readParcelCloudState(scope);
  assert.equal(snap.cursor, cursor);
  return scope;
}

test("I-F: Worker merge rules (express_metadata, express_pdd_link, express_watch_feedback, parcel_pickup note)", () => {
  // 1. mergeParcelCloudMetadata: preserves pddpic image, merges anchorAt=min/terminalAt=max, title & estimate clocks
  const mergedMeta = mergeParcelCloudMetadata(
    {
      waybill: "YT7700000000101",
      anchorAt: 1_000,
      terminalAt: 0,
      productImageUrl: "https://img.pddpic.com/mms-material-img/goods.jpeg",
      productName: "保温杯",
      productNameObservedAt: 1_500,
      deliveryEstimate: "预计11月28日送达",
      deliveryEstimateObservedAt: 2_000,
    },
    {
      waybill: "YT7700000000101",
      anchorAt: 1_200,
      terminalAt: 5_000,
      productName: "保温杯",
      productNameObservedAt: 1_800,
      deliveryEstimate: "预计11月27日送达",
      deliveryEstimateObservedAt: 2_000, // tie on different estimate -> previous wins!
    },
  );
  assert.deepEqual(mergedMeta, {
    waybill: "YT7700000000101",
    anchorAt: 1_000,
    terminalAt: 5_000,
    productImageUrl: "https://img.pddpic.com/mms-material-img/goods.jpeg",
    productName: "保温杯",
    productNameObservedAt: 1_500,
    deliveryEstimate: "预计11月28日送达",
    deliveryEstimateObservedAt: 2_000,
  });

  // Strict newer observation replaces title & estimate while keeping pddpic image
  const newerMeta = mergeParcelCloudMetadata(mergedMeta, {
    waybill: "YT7700000000101",
    anchorAt: 1_100,
    productName: "不锈钢保温杯",
    productNameObservedAt: 3_000,
    deliveryEstimate: "预计今日送达",
    deliveryEstimateObservedAt: 3_500,
  });
  assert.equal(newerMeta.productImageUrl, "https://img.pddpic.com/mms-material-img/goods.jpeg");
  assert.equal(newerMeta.productName, "不锈钢保温杯");
  assert.equal(newerMeta.productNameObservedAt, 3_000);
  assert.equal(newerMeta.deliveryEstimate, "预计今日送达");
  assert.equal(newerMeta.deliveryEstimateObservedAt, 3_500);

  // Waybill reuse >= 24h replaces old terminal metadata
  const reusedMeta = mergeParcelCloudMetadata(
    { waybill: "YT7700000000101", anchorAt: 1_000, terminalAt: 2_000, productName: "旧包裹", productNameObservedAt: 1_500 },
    { waybill: "YT7700000000101", anchorAt: 2_000 + DAY, terminalAt: 0, productName: "新包裹", productNameObservedAt: 2_000 + DAY },
  );
  assert.equal(reusedMeta.productName, "新包裹");
  assert.equal(reusedMeta.anchorAt, 2_000 + DAY);

  // 2. mergeParcelCloudPddLink: mark-only observedAt=1 upgraded by real shippingId; tie with different ID clears to ""
  const upgradedLink = mergeParcelCloudPddLink(
    { waybill: "YT7700000000102", anchorAt: 900, terminalAt: 0, shippingId: "", observedAt: 1 },
    { waybill: "YT7700000000102", anchorAt: 1_000, terminalAt: 4_000, shippingId: "987654321", observedAt: 1_200 },
  );
  assert.deepEqual(upgradedLink, {
    waybill: "YT7700000000102",
    anchorAt: 900,
    terminalAt: 4_000,
    shippingId: "987654321",
    observedAt: 1_200,
  });
  const tiedConflictLink = mergeParcelCloudPddLink(
    upgradedLink,
    { waybill: "YT7700000000102", anchorAt: 950, terminalAt: 0, shippingId: "111222333", observedAt: 1_200 },
  );
  assert.equal(tiedConflictLink.shippingId, "");
  assert.equal(tiedConflictLink.anchorAt, 900);
  assert.equal(tiedConflictLink.terminalAt, 4_000);

  // 3. mergeParcelCloudWatchFeedback: higher actedAt wins; tie "deleted" beats "completed"; tie prefers watchRecordId
  const watchId = "12345678-1234-4234-8234-123456789abc";
  assert.equal(
    mergeParcelCloudWatchFeedback(
      { waybill: "DHL100", action: "completed", actedAt: 2_000 },
      { waybill: "DHL100", action: "deleted", actedAt: 2_000 },
    ).action,
    "deleted",
  );
  assert.equal(
    mergeParcelCloudWatchFeedback(
      { waybill: "DHL100", action: "completed", actedAt: 2_000 },
      { waybill: "DHL100", action: "completed", actedAt: 2_000, watchRecordId: watchId },
    ).watchRecordId,
    watchId,
  );

  // 4. mergeParcelCloudCodeNote: omission preserves note, explicit "" clears note
  assert.equal(
    mergeParcelCloudCodeNote({ code: "1-2-3", note: "放门口" }, { code: "1-2-3" }).note,
    "放门口",
  );
  assert.equal(
    mergeParcelCloudCodeNote({ code: "1-2-3", note: "放门口" }, { code: "1-2-3", note: "" }).note,
    "",
  );
});

test("I-A & I-G: upload convergence on Worker-merged records & cloud productName stored in cloudProductName without overriding platform title", async () => {
  const scope = resetEnv();
  const waybill = "YT7700000000201";
  const metaId = parcelDetailRecordId("parcel-metadata:", waybill);
  const linkId = parcelDetailRecordId("parcel-pdd-link:", waybill);

  // Local automatic Cainiao row confirmed as PDD, with its own platform-fetched title and older estimate
  const autoRow = makeAutomaticShipment(waybill, {
    pddImport: { ownerKey: "pdd-owner", orderId: "order-1", shippingId: "5566778899" },
    platformFields: {
      waybill,
      waybillGeneration: 0,
      title: { text: "淘宝原装数据线", source: "cainiao" },
      estimate: { text: "预计11月28日送达", source: "cainiao", capturedAtMs: clock - 15_000 },
    },
  });
  // Second parcel without local platform title: should display cloudProductName fallback
  const fallbackWaybill = "YT7700000000202";
  const fallbackMetaId = parcelDetailRecordId("parcel-metadata:", fallbackWaybill);
  const manualNoTitle = makeManualShipment(fallbackWaybill);
  saveState({ ...emptyState(), shipments: [autoRow, manualNoTitle] }, clock);

  await seedCloudSessionAndRemote([
    {
      recordId: metaId,
      type: "express_metadata",
      revision: 3,
      changedAt: clock - 1_000,
      editedAt: clock - 1_000,
      lifecycle: "active",
      historyAt: 0,
      deleted: false,
      payload: {
        waybill,
        // Worker-merged earlier anchorAt + unowned pddpic image + newer remote title & estimate!
        anchorAt: clock - 25_000,
        terminalAt: 0,
        productImageUrl: "https://img.pddpic.com/mms-material-img/cable.jpeg",
        productName: "拼多多快充线",
        productNameObservedAt: clock - 2_000,
        deliveryEstimate: "预计11月27日送达",
        deliveryEstimateObservedAt: clock - 1_000,
      },
    },
    {
      recordId: linkId,
      type: "express_pdd_link",
      revision: 4,
      changedAt: clock - 1_000,
      editedAt: clock - 1_000,
      lifecycle: "active",
      historyAt: 0,
      deleted: false,
      payload: {
        waybill,
        anchorAt: clock - 25_000,
        terminalAt: 0,
        shippingId: "5566778899",
        observedAt: clock - 500,
      },
    },
    {
      recordId: fallbackMetaId,
      type: "express_metadata",
      revision: 2,
      changedAt: clock - 1_000,
      editedAt: clock - 1_000,
      lifecycle: "active",
      historyAt: 0,
      deleted: false,
      payload: {
        waybill: fallbackWaybill,
        anchorAt: clock - 20_000,
        terminalAt: 0,
        productName: "云端兜底商品名",
        productNameObservedAt: clock - 3_000,
      },
    },
  ]);

  // Advance local updatedAtMs (simulating a routine tracking poll) and run reconcile again
  clock += 10_000;
  const current = loadState(clock);
  saveState(
    {
      ...current,
      shipments: current.shipments.map((s) => ({ ...s, updatedAtMs: clock })),
    },
    clock,
  );
  reconcileParcelCloudRecordsWithLocal(scope, clock);

  const afterState = loadState(clock);
  const updatedAuto = afterState.shipments.find((s) => s.identity.sourceId === waybill)!;
  const updatedFallback = afterState.shipments.find((s) => s.identity.sourceId === fallbackWaybill)!;

  // I-G: incoming cloud productName must NOT be written into manualTitle!
  assert.equal(updatedAuto.platformFields?.manualTitle, undefined);
  assert.equal(updatedAuto.platformFields?.cloudProductName, "拼多多快充线");
  assert.equal(
    displayedPlatformFields(updatedAuto, clock).title,
    "淘宝原装数据线",
    "local platform-fetched title takes precedence over cloudProductName",
  );
  assert.equal(updatedFallback.platformFields?.manualTitle, undefined);
  assert.equal(updatedFallback.platformFields?.cloudProductName, "云端兜底商品名");
  assert.equal(
    displayedPlatformFields(updatedFallback, clock).title,
    "云端兜底商品名",
    "cloudProductName serves as fallback when neither manualTitle nor platform title exists",
  );
  assert.equal(
    needsParcelDetailFields(updatedFallback),
    true,
    "cloudProductName fallback does not suppress fetching local platform parcel details",
  );

  // I-A: ZERO outbound edits queued because remote timestamps >= local observations and Worker-merged anchorAt/observedAt + unowned productImageUrl are converged!
  const cloudSnap = readParcelCloudState(scope);
  assert.deepEqual(Object.keys(cloudSnap.edits), []);
});

test("I-B: clearing waybill-backed pickup code note sends explicit note: \"\" and converges after receipt", async () => {
  const scope = resetEnv();
  const waybill = "ZTO7700000000301";
  const capturedAt = clock - 15_000;
  const pickupId = parcelDetailRecordId("parcel-waybill-pickup:", `${waybill}:${capturedAt}`);
  const noteId = parcelDetailRecordId("parcel-note:", waybill);

  const shipment = makeManualShipment(waybill, {
    note: "放丰巢3号柜",
    pickup: {
      platform: "fengchao",
      waybill,
      waybillGeneration: 0,
      capturedAtMs: capturedAt,
      code: "88-2-109",
      locationName: "丰巢快递柜",
    },
  });
  saveState({ ...emptyState(), shipments: [shipment] }, clock);

  await seedCloudSessionAndRemote([
    {
      recordId: pickupId,
      type: "parcel_pickup",
      revision: 2,
      changedAt: clock - 2_000,
      editedAt: clock - 2_000,
      lifecycle: "active",
      historyAt: 0,
      deleted: false,
      payload: {
        waybill,
        brandId: "fengchao",
        code: "88-2-109",
        location: "丰巢快递柜",
        capturedAt,
        note: "放丰巢3号柜",
      },
    },
    {
      recordId: noteId,
      type: "express_note",
      revision: 2,
      changedAt: clock - 2_000,
      editedAt: clock - 2_000,
      lifecycle: "active",
      historyAt: 0,
      deleted: false,
      payload: {
        subject: `waybill:${waybill}`,
        waybill,
        note: "放丰巢3号柜",
        anchorAt: clock - 20_000,
        status: "TRANSIT",
      },
    },
  ]);

  // Initially converged
  assert.deepEqual(Object.keys(readParcelCloudState(scope).edits), []);

  // User clears shipment note locally
  clock += 5_000;
  setShipmentNote(loadState(clock).shipments[0]!, "", clock);
  reconcileParcelCloudRecordsWithLocal(scope, clock);

  const editsAfterClear = readParcelCloudState(scope).edits;
  assert.equal(editsAfterClear[noteId]?.deleted, true, "express_note queued for deletion");
  assert.ok(editsAfterClear[pickupId], "waybill parcel_pickup queued to clear note");
  assert.equal(
    editsAfterClear[pickupId]!.payload?.note,
    "",
    "I-B: cleared waybill pickup note must send explicit empty string note: \"\"",
  );

  // Simulate Worker applying both mutations and verify convergence on next reconcile
  const mutatedBodies: Record<string, unknown>[] = [];
  let seq = 1;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    if (url.endsWith("/pull")) {
      return new Response(
        JSON.stringify({
          ok: true,
          schemaVersion: 1,
          enabled: true,
          ownerId: OWNER_ID,
          endpointId: ENDPOINT_ID,
          generation: 1,
          epoch: EPOCH,
          nextSequence: seq,
          expressParcelDetailsSupported: true,
          expressTitleClockSupported: true,
          expressWatchFeedbackSupported: true,
          mode: "delta",
          reset: false,
          cursor: 10,
          hasMore: false,
          records: [],
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/mutate")) {
      mutatedBodies.push(body);
      const mut = (body.mutations as Array<Record<string, unknown>>)[0]!;
      const currentSeq = seq++;
      return new Response(
        JSON.stringify({
          ok: true,
          schemaVersion: 1,
          enabled: true,
          ownerId: OWNER_ID,
          endpointId: ENDPOINT_ID,
          generation: 1,
          epoch: EPOCH,
          sequence: currentSeq,
          nextSequence: currentSeq + 1,
          expressParcelDetailsSupported: true,
          expressTitleClockSupported: true,
          expressWatchFeedbackSupported: true,
          results: [
            {
              recordId: mut.recordId,
              mutationId: mut.mutationId,
              revision: 3,
              deleted: mut.operation === "delete",
              editedAt: mut.editedAt,
            },
          ],
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  await synchronizeParcelCloudRecords();
  assert.equal(mutatedBodies.length, 2);
  reconcileParcelCloudRecordsWithLocal(scope, clock + 1_000);
  assert.deepEqual(Object.keys(readParcelCloudState(scope).edits), [], "converged after clearing note");
});

test("I-C: deterministic 4xx mutation rejection drops & quarantines invalid batch without blocking pulls or valid uploads", async () => {
  const scope = resetEnv();
  const badWaybill = "ZTO7700000000401";
  const goodWaybill = "ZTO7700000000402";
  const pulledWaybill = "ZTO7700000000403";
  const badNoteId = parcelDetailRecordId("parcel-note:", badWaybill);
  const goodNoteId = parcelDetailRecordId("parcel-note:", goodWaybill);

  assert.equal(isDeterministicParcelMutationRejection(new GatewayError("bad", 400, "invalid_cloud_record_payload")), true);
  assert.equal(isDeterministicParcelMutationRejection(new GatewayError("big", 413, "cloud_record_payload_too_large")), true);
  assert.equal(isDeterministicParcelMutationRejection(new GatewayError("id", 403, "invalid_cloud_record_identity")), true);
  assert.equal(isDeterministicParcelMutationRejection(new GatewayError("off", 403, "cloud_sync_disabled")), false);
  assert.equal(isDeterministicParcelMutationRejection(new GatewayError("conflict", 409, "revision_conflict")), false);
  assert.equal(isDeterministicParcelMutationRejection(new GatewayError("slow", 429, "rate_limited")), false);
  assert.equal(isDeterministicParcelMutationRejection(new GatewayError("down", 503, "unavailable")), false);

  await seedCloudSessionAndRemote([]);

  saveState(
    {
      ...emptyState(),
      shipments: [
        makeManualShipment(badWaybill, { note: "INVALID_SERVER_REJECTED_NOTE", updatedAtMs: clock - 2_000 }),
        makeManualShipment(goodWaybill, { note: "正常备注", updatedAtMs: clock - 1_000 }),
      ],
    },
    clock,
  );

  let mutateCalls = 0;
  let seq = 1;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    if (url.endsWith("/pull")) {
      return new Response(
        JSON.stringify({
          ok: true,
          schemaVersion: 1,
          enabled: true,
          ownerId: OWNER_ID,
          endpointId: ENDPOINT_ID,
          generation: 1,
          epoch: EPOCH,
          nextSequence: seq,
          expressParcelDetailsSupported: true,
          expressTitleClockSupported: true,
          expressWatchFeedbackSupported: true,
          mode: "delta",
          reset: false,
          cursor: 11,
          hasMore: false,
          records: [
            {
              recordId: "22222222-3333-4444-8555-666666666666",
              type: "express",
              revision: 11,
              changedAt: clock,
              editedAt: clock,
              lifecycle: "active",
              historyAt: 0,
              deleted: false,
              payload: {
                waybill: pulledWaybill,
                carrierCode: "zto",
                phone4: "5678",
                status: "TRANSIT",
                createdAt: clock - 5_000,
                eventAt: clock - 5_000,
                updatedAt: clock - 5_000,
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/mutate")) {
      mutateCalls++;
      const mut = (body.mutations as Array<Record<string, unknown>>)[0]!;
      if (mut.recordId === badNoteId) {
        return new Response(
          JSON.stringify({ ok: false, error: "invalid_cloud_record_payload" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const currentSeq = seq++;
      return new Response(
        JSON.stringify({
          ok: true,
          schemaVersion: 1,
          enabled: true,
          ownerId: OWNER_ID,
          endpointId: ENDPOINT_ID,
          generation: 1,
          epoch: EPOCH,
          sequence: currentSeq,
          nextSequence: currentSeq + 1,
          expressParcelDetailsSupported: true,
          expressTitleClockSupported: true,
          expressWatchFeedbackSupported: true,
          results: [
            {
              recordId: mut.recordId,
              mutationId: mut.mutationId,
              revision: 12,
              deleted: false,
              editedAt: mut.editedAt,
            },
          ],
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  await synchronizeParcelCloudRecords();

  // Bad batch was rejected once, quarantined, and goodNoteId + pulledWaybill both succeeded!
  assert.equal(mutateCalls, 2);
  const cloudAfter = readParcelCloudState(scope);
  assert.equal(cloudAfter.batch, undefined);
  assert.ok(cloudAfter.quarantined?.[badNoteId], "rejected record digest is quarantined");
  assert.ok(cloudAfter.synced[goodNoteId], "subsequent valid mutation succeeded");
  assert.ok(
    loadState(clock).shipments.some((s) => s.identity.sourceId === pulledWaybill),
    "inbound pull was not blocked",
  );
  const rejectDiag = readDiagnostics().find((entry) => entry.event === "cloud.sync.failed");
  assert.ok(rejectDiag, "logged warning diagnostic");
  assert.equal(rejectDiag!.details.stage, "cloud_record_sync");
  assert.equal(rejectDiag!.details.rejectedRecords, 1);

  // Running another sync pass must NOT re-send the quarantined invalid mutation
  mutateCalls = 0;
  await synchronizeParcelCloudRecords();
  assert.equal(mutateCalls, 0, "quarantined invalid payload is not re-enqueued on subsequent sync");

  // Verify dropRejectedParcelBatch unit behavior directly
  const sampleSnap = prepareParcelBatch(
    {
      ...cloudAfter,
      edits: {
        [goodNoteId]: {
          mutationId: "33333333-4444-4555-8666-777777777777",
          recordId: goodNoteId,
          type: "express_note",
          editedAt: clock,
          lifecycle: "active",
          historyAt: 0,
          payload: { waybill: goodWaybill, subject: `waybill:${goodWaybill}`, note: "bad2", anchorAt: clock - 1_000, status: "TRANSIT" },
        },
      },
    },
    "44444444-5555-4666-8777-888888888888",
  );
  assert.ok(sampleSnap.batch);
  const dropped = dropRejectedParcelBatch(sampleSnap, sampleSnap.batch!);
  assert.equal(dropped.batch, undefined);
  assert.equal(dropped.edits[goodNoteId], undefined);
});

test("I-E(1) & I-E(2): cloud COMPLETED express never force-completes automatic or reused-lifecycle rows; non-PDD cloud imports record tombstones", async () => {
  const scope = resetEnv();
  const autoWaybill = "ZTO7700000000501";
  const reusedWaybill = "ZTO7700000000502";
  const nonPddImportWaybill = "ZTO7700000000503";
  const nonPddCompleteWaybill = "ZTO7700000000504";

  const autoRow = makeAutomaticShipment(autoWaybill);
  const newLifecycleManualRow = makeManualShipment(reusedWaybill, {
    identity: {
      ...makeManualShipment(reusedWaybill).identity,
      createdAtMs: clock - 3_600_000,
    },
    timeline: {
      ...makeManualShipment(reusedWaybill).timeline,
      statusEventAtMs: clock - 1_800_000,
      tracks: [
        {
          timeMs: clock - 3_600_000,
          timeText: "2026-11-26 11:00:00",
          detail: "新包裹揽收",
          statusCode: "PICKED",
          raw: {},
        },
      ],
    },
  });
  saveState({ ...emptyState(), shipments: [autoRow, newLifecycleManualRow] }, clock);

  const importRecordId = "55555555-6666-4777-8888-999999999901";
  const completeRecordId = "55555555-6666-4777-8888-999999999902";

  await seedCloudSessionAndRemote([
    // Cloud COMPLETED express for the same waybill as local automatic row -> MUST NOT forceComplete automatic row!
    {
      recordId: "55555555-6666-4777-8888-999999999903",
      type: "express",
      revision: 2,
      changedAt: clock - 1_000,
      editedAt: clock - 1_000,
      lifecycle: "history",
      historyAt: clock - 1_000,
      deleted: false,
      payload: {
        waybill: autoWaybill,
        carrierCode: "zto",
        status: "COMPLETED",
        createdAt: clock - 20_000,
        eventAt: clock - 1_000,
        updatedAt: clock - 1_000,
        completedAt: clock - 1_000,
      },
    },
    // Cloud COMPLETED express from an older parcel lifecycle (>= 24h earlier) -> MUST NOT forceComplete new lifecycle row!
    {
      recordId: "55555555-6666-4777-8888-999999999904",
      type: "express",
      revision: 2,
      changedAt: clock - 2 * DAY,
      editedAt: clock - 2 * DAY,
      lifecycle: "history",
      historyAt: clock - 2 * DAY,
      deleted: false,
      payload: {
        waybill: reusedWaybill,
        carrierCode: "zto",
        status: "COMPLETED",
        createdAt: clock - 3 * DAY,
        eventAt: clock - 2 * DAY,
        updatedAt: clock - 2 * DAY,
        completedAt: clock - 2 * DAY,
      },
    },
    // Non-PDD cloud-imported manual parcels (vivo_douyin & plain manual)
    {
      recordId: importRecordId,
      type: "express",
      revision: 1,
      changedAt: clock - 5_000,
      editedAt: clock - 5_000,
      lifecycle: "active",
      historyAt: 0,
      deleted: false,
      payload: {
        waybill: nonPddImportWaybill,
        carrierCode: "zto",
        importOrigin: "vivo_douyin",
        status: "TRANSIT",
        createdAt: clock - 15_000,
        eventAt: clock - 5_000,
        updatedAt: clock - 5_000,
      },
    },
    {
      recordId: completeRecordId,
      type: "express",
      revision: 1,
      changedAt: clock - 5_000,
      editedAt: clock - 5_000,
      lifecycle: "active",
      historyAt: 0,
      deleted: false,
      payload: {
        waybill: nonPddCompleteWaybill,
        carrierCode: "zto",
        status: "TRANSIT",
        createdAt: clock - 15_000,
        eventAt: clock - 5_000,
        updatedAt: clock - 5_000,
      },
    },
  ]);

  const afterImport = loadState(clock);
  assert.equal(
    afterImport.shipments.find((s) => s.identity.id === autoRow.identity.id)?.forcedCompletedAtMs,
    undefined,
    "I-E(1): automatic shipment is never force-completed by cloud express record",
  );
  assert.equal(
    afterImport.shipments.find((s) => s.identity.id === newLifecycleManualRow.identity.id)?.forcedCompletedAtMs,
    undefined,
    "I-E(1): newer-lifecycle manual shipment is never force-completed by old-lifecycle cloud express record",
  );

  const importedDouyin = afterImport.shipments.find((s) => s.identity.sourceId === nonPddImportWaybill);
  const importedPlain = afterImport.shipments.find((s) => s.identity.sourceId === nonPddCompleteWaybill);
  assert.ok(importedDouyin?.cloudExpressOrigin, "I-E(2): non-PDD cloud import carries cloudExpressOrigin");
  assert.ok(importedPlain?.cloudExpressOrigin, "I-E(2): plain cloud import carries cloudExpressOrigin");

  // Delete nonPddImportWaybill and force-complete nonPddCompleteWaybill on iOS
  clock += 2_000;
  removeShipmentWithCleanup(importedDouyin!.identity.id, clock);
  forceCompleteShipment(importedPlain!.identity.id, clock);

  const stateWithTombstones = loadState(clock);
  assert.ok(
    stateWithTombstones.cloudPddTombstones?.some((t) => t.waybill === nonPddImportWaybill && t.action === "deleted"),
    "I-E(2): deleting non-PDD cloud import records deleted tombstone",
  );
  assert.ok(
    stateWithTombstones.cloudPddTombstones?.some((t) => t.waybill === nonPddCompleteWaybill && t.action === "completed"),
    "I-E(2): completing non-PDD cloud import records completed tombstone",
  );

  reconcileParcelCloudRecordsWithLocal(scope, clock);
  const edits = readParcelCloudState(scope).edits;
  assert.equal(edits[importRecordId]?.deleted, true, "I-E(2): queues delete for non-PDD cloud express record");
  assert.equal(edits[completeRecordId]?.lifecycle, "history", "I-E(2): queues COMPLETED history for non-PDD cloud express record");

  // Simulate origin device updating status on nonPddImportWaybill (revision 1 -> 2, WAITING_PICKUP) BEFORE our delete is pushed:
  // Tombstone must prevent resurrection!
  await seedCloudSessionAndRemote(
    [
      {
        recordId: importRecordId,
        type: "express",
        revision: 2,
        changedAt: clock + 500,
        editedAt: clock + 500,
        lifecycle: "active",
        historyAt: 0,
        deleted: false,
        payload: {
          waybill: nonPddImportWaybill,
          carrierCode: "zto",
          importOrigin: "vivo_douyin",
          status: "WAITING_PICKUP",
          createdAt: clock - 15_000,
          eventAt: clock + 500,
          updatedAt: clock + 500,
        },
      },
    ],
    20,
  );
  assert.equal(
    loadState(clock + 1_000).shipments.some((s) => s.identity.sourceId === nonPddImportWaybill),
    false,
    "I-E(2): deleted non-PDD cloud parcel never resurrects when origin device updates status",
  );
});

test("I-D: unresolved pending manual / cloud-imported parcel spends at most ONE durable paid KDNiao attempt per lifecycle while free sources keep polling", async () => {
  resetEnv();
  const waybill = "ZTO7700000000601";
  const pendingRow: Shipment = {
    ...makeManualShipment(waybill),
    timeline: {
      provider: "pending",
      complete: false,
      structuredStatus: false,
      waybill,
      courierCode: "zto",
      companyName: "中通快递",
      semantic: "UNKNOWN",
      statusEventAtMs: null,
      latestTimeText: "",
      latestDetail: "",
      tracks: [],
      successAtMs: clock - 60_000,
    },
  };
  let working = saveState({ ...emptyState(), shipments: [pendingRow] }, clock);

  const calls: Array<{ pickerOnly?: boolean; motoOnly?: boolean; fallbackOnly?: boolean; includeKdniaoFallback?: boolean }> = [];
  const fakeQuery = (async (opts: Record<string, unknown>) => {
    calls.push({
      pickerOnly: Boolean(opts.pickerOnly),
      motoOnly: Boolean(opts.motoOnly),
      fallbackOnly: Boolean(opts.fallbackOnly),
      includeKdniaoFallback: Boolean(opts.includeKdniaoFallback),
    });
    return { shipment: null, pending: null, routeUrl: "", result: "empty" };
  }) as unknown as Parameters<typeof refreshOnlineShipment>[8];

  const checkpoint = Object.assign(
    (candidate: ReturnType<typeof emptyState>) => {
      working = saveState(candidate, clock);
      return working;
    },
    { transientManualLease: true as const },
  );
  const controller = new AbortController();

  // Pass 1: runs Picker (free) -> Moto (free) -> KDNiao (paid, 1st & only background attempt!)
  await refreshOnlineShipment(
    working,
    "interface5",
    "flow-1",
    checkpoint,
    { id: pendingRow.identity.id },
    clock + 20_000,
    false,
    controller.signal,
    fakeQuery,
    undefined,
    true,
  );

  assert.equal(calls.filter((c) => c.pickerOnly).length, 1);
  assert.equal(calls.filter((c) => c.motoOnly).length, 1);
  assert.equal(calls.filter((c) => c.includeKdniaoFallback).length, 1, "spent 1 paid KDNiao attempt on Pass 1");

  const reloaded = loadState(clock);
  const persisted = reloaded.shipments.find((s) => s.identity.id === pendingRow.identity.id)!;
  assert.ok(
    (persisted.pendingKdniaoAttemptAtMs ?? 0) > 0,
    "pendingKdniaoAttemptAtMs persisted durably in AppState",
  );

  // Simulate process restart + cooldown expiry (30 minutes later): free Picker & Moto STILL poll, paid KDNiao is NOT called again!
  clock += 35 * 60_000;
  calls.length = 0;
  working = loadState(clock);

  await refreshOnlineShipment(
    working,
    "interface5",
    "flow-2",
    checkpoint,
    { id: pendingRow.identity.id },
    clock + 20_000,
    false,
    controller.signal,
    fakeQuery,
    undefined,
    true,
  );

  assert.equal(calls.filter((c) => c.pickerOnly).length, 1, "free Picker continues polling");
  assert.equal(calls.filter((c) => c.motoOnly).length, 1, "free Moto continues polling");
  assert.equal(calls.filter((c) => c.includeKdniaoFallback).length, 0, "paid KDNiao is capped at 1 background attempt per lifecycle");
});

test("I-4: suppressed notification diagnostic counters are recorded only after batch ACK/commit succeeds", async () => {
  resetEnv();
  const waybill = "ZTO7700000000701";
  const shipment = makeManualShipment(waybill);
  memory.clear();
  setDiagnosticsEnabled(true);
  saveNotificationStatuses(["WAITING_PICKUP"], clock);
  const seededState = {
    ...emptyState(),
    revision: 1,
    updatedAtMs: clock,
    shipments: [shipment],
    pendingNotifications: [
      {
        id: "notif-suppressed-1",
        shipmentId: shipment.identity.id,
        semantic: "TRANSIT" as const,
        title: "中通快递",
        body: "快件运输中",
        iconName: null,
      },
    ],
  };
  const statePayload = JSON.stringify(seededState);
  memory.set("pipi_deliveries_state_v1", JSON.stringify({ schema: 3, checksum: sha256(statePayload), payload: statePayload }));

  // Pass 1: lose schedule ownership right after reading state so flushSuppressedAcks() aborts BEFORE commitAckIds!
  let checks = 0;
  await replayPendingShipmentNotifications(
    () => {
      checks++;
      // 1st check (entry) = true, 2nd check (loop) = true, 3rd check (inside flushSuppressedAcks) = false!
      return checks <= 2;
    },
    { deadlineAtMs: clock + 10_000, flowId: "notif-abort-before-ack" },
  );

  assert.equal(
    loadState(clock).pendingNotifications?.length,
    1,
    "uncommitted suppressed notification remains in pendingNotifications",
  );
  const abortDiag = readDiagnostics().find(
    (entry) => entry.event === "notification.replay.completed" && entry.details.flowId === "notif-abort-before-ack",
  );
  assert.ok(abortDiag);
  assert.equal(
    abortDiag!.details.succeeded,
    0,
    "I-4: succeeded counter stays 0 when suppressed ACK batch did not commit",
  );
  assert.equal(
    Object.keys(loadRowLedger()).length,
    0,
    "I-4: suppressed decision ledger is not recorded before ACK commit",
  );
  assert.equal(
    readDiagnostics().filter((entry) => entry.event === "express.row.notification").length,
    0,
    "I-4: express.row.notification diagnostic is not emitted before ACK commit",
  );

  // Pass 2: allow commitAckIds to succeed -> succeeded=1 and pendingNotifications drained!
  await replayPendingShipmentNotifications(() => true, {
    deadlineAtMs: clock + 10_000,
    flowId: "notif-commit-ok",
  });
  assert.equal(loadState(clock).pendingNotifications?.length ?? 0, 0);
  const commitDiag = readDiagnostics().find(
    (entry) => entry.event === "notification.replay.completed" && entry.details.flowId === "notif-commit-ok",
  );
  assert.ok(commitDiag);
  assert.equal(
    commitDiag!.details.succeeded,
    1,
    "succeeded counter increments to 1 after suppressed ACK batch commits",
  );
});
