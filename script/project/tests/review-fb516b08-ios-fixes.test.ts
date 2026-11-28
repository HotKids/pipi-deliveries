import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { memory, sha256 } from "./state-storage-mock.ts";
import type { NormalizedStatus, Shipment } from "../models.ts";

const NOW = Date.UTC(2026, 10, 28, 2, 0, 0);
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
const { createPickupRuntime } = await import("../services/meal/pickup-runtime.ts");
const { onlineMealRequiresQR, recognizeMealImage, recognizeMealText } = await import("../services/meal/recognize.ts");
const {
  PARCEL_CLOUD_QUARANTINE_TTL_MS,
  dropRejectedParcelBatch,
  isClockSkewMutationRejection,
  isDeterministicParcelMutationRejection,
  parcelDetailRecordId,
  prepareParcelBatch,
  readParcelCloudState,
  reconcileParcelCloudRecordsWithLocal,
  resetParcelCloudDeniedBackoffForTests,
  synchronizeParcelCloudRecords,
} = await import("../services/parcel-cloud-sync.ts");
const { displayedPlatformFields } = await import("../services/platform-parcel-merge.ts");
const { refreshPlatformParcels } = await import("../services/platform-parcel-sync.ts");
const { clearPlatformLogin, platformSession, savePlatformLogin } = await import("../services/platform-accounts.ts");
const { resetJdEstimateCooldownsForTests } = await import("../services/platform-web-parcels.ts");
const { registerProjectionViewportHost } = await import("../services/projection-viewport.ts");
const { displayWaybill } = await import("../services/shipment-policy.ts");
const { listHeadline, shipmentPresentationStatus, statusTextTint } = await import("../services/status.ts");
const {
  emptyState,
  forceCompleteShipment,
  loadState,
  removeShipmentWithCleanup,
  saveRecognizedParcelCode,
  saveState,
  setShipmentNote,
  upsertPendingQuery,
  upsertShipment,
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
  memory.clear();
  resetParcelCloudDeniedBackoffForTests();
  resetJdEstimateCooldownsForTests();
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
      provider: "v6_query",
      complete: false,
      structuredStatus: true,
      waybill,
      courierCode: "zto",
      companyName: "中通快递",
      semantic: "TRANSIT",
      statusEventAtMs: clock - 10_000,
      latestTimeText: "2026-11-28 09:50:00",
      latestDetail: "快件运输中",
      tracks: [
        {
          timeMs: clock - 10_000,
          timeText: "2026-11-28 09:50:00",
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

async function pullCloudSnapshot(records: readonly Record<string, unknown>[], cursor = 10): Promise<void> {
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
}

async function pullCloudDelta(records: readonly Record<string, unknown>[], cursor: number): Promise<void> {
  let deltaSent = false;
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith("/pull")) {
      const batch = deltaSent ? [] : records;
      deltaSent = true;
      return new Response(JSON.stringify({
        ok: true, schemaVersion: 1, enabled: true, ownerId: OWNER_ID, endpointId: ENDPOINT_ID,
        generation: 1, epoch: EPOCH, nextSequence: 1,
        expressParcelDetailsSupported: true, expressTitleClockSupported: true, expressWatchFeedbackSupported: true,
        mode: "delta", reset: false, cursor, hasMore: false, records: batch,
      }), { status: 200 });
    }
    if (url.endsWith("/mutate")) {
      return new Response(JSON.stringify({ ok: false, error: "cloud_sync_disabled" }), { status: 403 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  await synchronizeParcelCloudRecords();
  resetParcelCloudDeniedBackoffForTests();
}

test("I2-1: two same-timestamp or <1s Cainiao pickup/handoff codes stay distinct, and completing one never clobbers the other", async () => {
  for (const offsetMs of [0, 400]) {
    resetEnv();
    const id1 = "11111111-1111-4111-8111-000000001001";
    const id2 = "11111111-1111-4111-8111-000000002002";
    const handoffId1 = "22222222-2222-4222-8222-000000001001";
    const handoffId2 = "22222222-2222-4222-8222-000000002002";
    const capturedAt1 = clock - 5_000;
    const capturedAt2 = capturedAt1 + offsetMs;

    await pullCloudSnapshot([
      {
        recordId: id1,
        type: "parcel_pickup",
        revision: 1,
        changedAt: capturedAt1,
        editedAt: capturedAt1,
        deleted: false,
        lifecycle: "active",
        historyAt: 0,
        payload: { brandId: "cainiao", code: "1-1-1001", location: "东门菜鸟驿站", capturedAt: capturedAt1 },
      },
      {
        recordId: id2,
        type: "parcel_pickup",
        revision: 1,
        changedAt: capturedAt2,
        editedAt: capturedAt2,
        deleted: false,
        lifecycle: "active",
        historyAt: 0,
        payload: { brandId: "cainiao", code: "2-2-2002", location: "东门菜鸟驿站", capturedAt: capturedAt2 },
      },
      {
        recordId: handoffId1,
        type: "parcel_handoff",
        revision: 1,
        changedAt: capturedAt1,
        editedAt: capturedAt1,
        deleted: false,
        lifecycle: "active",
        historyAt: 0,
        payload: { platform: "cainiao", code: "8801", capturedAt: capturedAt1, expiresAt: 0 },
      },
      {
        recordId: handoffId2,
        type: "parcel_handoff",
        revision: 1,
        changedAt: capturedAt2,
        editedAt: capturedAt2,
        deleted: false,
        lifecycle: "active",
        historyAt: 0,
        payload: { platform: "cainiao", code: "8802", capturedAt: capturedAt2, expiresAt: 0 },
      },
    ], 10);

    const imported = loadState().pickupCodeRecords ?? [];
    const pickups = imported.filter((r) => r.kind === "pickup");
    const handoffs = imported.filter((r) => r.kind === "handoff");
    assert.deepEqual(
      pickups.map((r) => r.code).sort(),
      ["1-1-1001", "2-2-2002"],
      `offsetMs=${offsetMs}: both Cainiao pickup codes remain distinct`,
    );
    assert.deepEqual(
      handoffs.map((r) => r.code).sort(),
      ["8801", "8802"],
      `offsetMs=${offsetMs}: both Cainiao handoff codes remain distinct`,
    );

    // Complete ONLY 2-2-2002 and 8802 on another device
    clock += 2_000;
    await pullCloudDelta([
      {
        recordId: id2,
        type: "parcel_pickup",
        revision: 2,
        changedAt: clock,
        editedAt: clock,
        deleted: false,
        lifecycle: "history",
        historyAt: capturedAt2,
        payload: {
          brandId: "cainiao",
          code: "2-2-2002",
          location: "东门菜鸟驿站",
          capturedAt: capturedAt2,
          completedAt: clock,
        },
      },
      {
        recordId: handoffId2,
        type: "parcel_handoff",
        revision: 2,
        changedAt: clock,
        editedAt: clock,
        deleted: false,
        lifecycle: "history",
        historyAt: capturedAt2,
        payload: {
          platform: "cainiao",
          code: "8802",
          capturedAt: capturedAt2,
          expiresAt: 0,
          completedAt: clock,
        },
      },
    ], 12);

    const afterComplete = loadState().pickupCodeRecords ?? [];
    const firstPickup = afterComplete.find((r) => r.id === id1)!;
    const secondPickup = afterComplete.find((r) => r.id === id2)!;
    assert.equal(firstPickup.code, "1-1-1001", `offsetMs=${offsetMs}: 1-1-1001 stays intact`);
    assert.equal(firstPickup.completedAtMs, undefined, `offsetMs=${offsetMs}: 1-1-1001 stays active`);
    assert.equal(secondPickup.code, "2-2-2002");
    assert.equal(secondPickup.completedAtMs, clock, `offsetMs=${offsetMs}: only 2-2-2002 is completed`);

    const firstHandoff = afterComplete.find((r) => r.id === handoffId1)!;
    const secondHandoff = afterComplete.find((r) => r.id === handoffId2)!;
    assert.equal(firstHandoff.code, "8801");
    assert.equal(firstHandoff.completedAtMs, undefined);
    assert.equal(secondHandoff.code, "8802");
    assert.equal(secondHandoff.completedAtMs, clock);
  }

  // Exact ID match across entire list takes priority over an earlier unsynced same-code proximity candidate
  resetEnv();
  const exactId = "33333333-3333-4333-8333-000000003003";
  saveRecognizedParcelCode({
    id: "local-unsynced-first",
    kind: "pickup",
    platform: "cainiao",
    code: "3-3-3003",
    capturedAtMs: clock - 200,
  }, clock);
  saveRecognizedParcelCode({
    id: exactId,
    kind: "pickup",
    platform: "cainiao",
    code: "3-3-3003",
    capturedAtMs: clock - 200,
  }, clock);
  await pullCloudSnapshot([
    {
      recordId: exactId,
      type: "parcel_pickup",
      revision: 2,
      changedAt: clock,
      editedAt: clock,
      deleted: false,
      lifecycle: "history",
      historyAt: clock - 200,
      payload: {
        brandId: "cainiao",
        code: "3-3-3003",
        capturedAt: clock - 200,
        completedAt: clock,
      },
    },
  ], 10);
  const exactCheck = loadState().pickupCodeRecords ?? [];
  assert.equal(exactCheck.find((r) => r.id === "local-unsynced-first")?.completedAtMs, undefined);
  assert.equal(exactCheck.find((r) => r.id === exactId)?.completedAtMs, clock);
});

test("R1: deleting a local manual row persists local-only ignoredCloudManualWaybills so later cloud revisions never resurrect it", async () => {
  const scope = resetEnv();
  const waybill = "YT8800000001001";
  const recordId = "44444444-4444-4444-8444-000000001001";
  const anchorAt = clock - 20_000;
  saveState({ ...emptyState(), shipments: [makeManualShipment(waybill)] }, clock);

  await pullCloudSnapshot([
    {
      recordId,
      type: "express",
      revision: 2,
      changedAt: clock - 2_000,
      editedAt: clock - 2_000,
      deleted: false,
      lifecycle: "active",
      historyAt: 0,
      payload: {
        waybill,
        carrierCode: "zto",
        status: "TRANSIT",
        createdAt: anchorAt,
        updatedAt: clock - 2_000,
      },
    },
  ], 10);

  // User deletes the local manual row on iOS
  clock += 1_000;
  removeShipmentWithCleanup(`interface5:manual:${waybill}`, clock);
  const afterDelete = loadState();
  assert.equal(afterDelete.shipments.length, 0);
  assert.equal((afterDelete.cloudPddTombstones ?? []).length, 0, "never writes cloud deletion tombstone");
  assert.equal(afterDelete.ignoredCloudManualWaybills?.length, 1, "records local-only ignoredCloudManualWaybills");
  assert.equal(afterDelete.ignoredCloudManualWaybills?.[0]?.waybill, waybill);

  reconcileParcelCloudRecordsWithLocal(scope, clock);
  assert.deepEqual(readParcelCloudState(scope).edits, {}, "never sends anything to cloud for ignoredCloudManualWaybills");

  // Bot advances cloud record revision (revision 2 -> 3, status -> DELIVERY)
  clock += 5_000;
  await pullCloudDelta([
    {
      recordId,
      type: "express",
      revision: 3,
      changedAt: clock,
      editedAt: clock,
      deleted: false,
      lifecycle: "active",
      historyAt: 0,
      payload: {
        waybill,
        carrierCode: "zto",
        status: "DELIVERY",
        createdAt: anchorAt,
        updatedAt: clock,
      },
    },
  ], 15);
  assert.equal(
    loadState().shipments.some((row) => displayWaybill(row) === waybill),
    false,
    "R1: new cloud revision does NOT re-import deleted local manual row as cloudImported",
  );
  assert.deepEqual(readParcelCloudState(scope).edits, {}, "still sends nothing to cloud");

  // User later manually re-adds the waybill locally -> ignoredCloudManualWaybills is cleared
  clock += 1_000;
  upsertPendingQuery({
    id: `interface5:${waybill}`,
    source: "interface5",
    waybill,
    phoneTail: "1234",
    courierCode: "zto",
    companyName: "中通快递",
    createdAtMs: clock,
    lastAttemptAtMs: clock,
    attempts: 0,
  }, clock);
  assert.equal(
    (loadState().ignoredCloudManualWaybills ?? []).some((entry) => entry.waybill === waybill),
    false,
    "manual re-add via upsertPendingQuery clears ignoredCloudManualWaybills",
  );

  // Also verify upsertShipment clears ignoredCloudManualWaybills directly
  upsertShipment(makeManualShipment(waybill), clock + 100);
  removeShipmentWithCleanup(`interface5:manual:${waybill}`, clock + 200);
  assert.equal((loadState().ignoredCloudManualWaybills ?? []).some((entry) => entry.waybill === waybill), true);
  upsertShipment(makeManualShipment(waybill), clock + 300);
  assert.equal((loadState().ignoredCloudManualWaybills ?? []).some((entry) => entry.waybill === waybill), false);
});

test("R2: one-time idempotent migration clears legacy 0.9.40-0.9.45 cloudExpressOrigin on manual rows while preserving post-migration imports", async () => {
  resetEnv();
  const legacyWaybillA = "YT8800000002001";
  const legacyWaybillB = "YT8800000002002";
  const postMigrationCloudWaybill = "YT8800000002003";

  // Seed a pre-0.9.48 persisted state WITHOUT migratedClearManualCloudImported_0948, carrying legacy cloudExpressOrigin
  const legacyRowA = makeManualShipment(legacyWaybillA, {
    cloudExpressOrigin: { waybill: legacyWaybillA, waybillGeneration: 0 },
  });
  const legacyRowB = makeManualShipment(legacyWaybillB, {
    cloudExpressOrigin: { waybill: legacyWaybillB, waybillGeneration: 0 },
  });
  const pre0948State = {
    version: 2 as const,
    revision: 5,
    updatedAtMs: clock,
    activeSource: "interface5" as const,
    bindings: [],
    pendingQueries: [],
    shipments: [legacyRowA, legacyRowB],
    feedSlotRebuiltAtMs: clock - 10_000,
  };
  const rawPayload = JSON.stringify(pre0948State);
  const envelope = JSON.stringify({ schema: 3, checksum: sha256(rawPayload), payload: rawPayload });
  memory.clear();
  saveGatewayToken("AbCdEfGh_123-456");
  memory.set("pipi_deliveries_state_v1", envelope);
  memory.set("pipi_deliveries_state_backup_v1", envelope);

  const migrated = loadState(clock);
  assert.equal(migrated.migratedClearManualCloudImported_0948, true, "sets one-time migration guard");
  assert.equal(
    migrated.shipments.find((r) => displayWaybill(r) === legacyWaybillA)?.cloudExpressOrigin,
    undefined,
    "R2: clears legacy cloudExpressOrigin on manual row A",
  );
  assert.equal(
    migrated.shipments.find((r) => displayWaybill(r) === legacyWaybillB)?.cloudExpressOrigin,
    undefined,
    "R2: clears legacy cloudExpressOrigin on manual row B",
  );

  // Signing off legacyRowA and deleting legacyRowB stay strictly local-only (and deleting records R1 tombstone)
  forceCompleteShipment(legacyRowA.identity.id, clock + 100);
  removeShipmentWithCleanup(legacyRowB.identity.id, clock + 200);
  assert.equal((loadState().cloudPddTombstones ?? []).length, 0, "legacy manual rows no longer write cloud tombstones");
  assert.equal(
    loadState().ignoredCloudManualWaybills?.some((e) => e.waybill === legacyWaybillB),
    true,
    "deleted legacy manual row uses R1 local ignore tombstone",
  );

  // Post-migration cloud import keeps cloudExpressOrigin across subsequent loads (migration runs only once!)
  clock += 500;
  await pullCloudSnapshot([
    {
      recordId: "55555555-5555-4555-8555-000000002003",
      type: "express",
      revision: 1,
      changedAt: clock,
      editedAt: clock,
      deleted: false,
      lifecycle: "active",
      historyAt: 0,
      payload: {
        waybill: postMigrationCloudWaybill,
        carrierCode: "zto",
        status: "TRANSIT",
        createdAt: clock - 5_000,
        updatedAt: clock,
      },
    },
  ], 20);

  const reloaded = loadState(clock + 1_000);
  const postImported = reloaded.shipments.find((r) => displayWaybill(r) === postMigrationCloudWaybill);
  assert.equal(
    postImported?.cloudExpressOrigin?.waybill,
    postMigrationCloudWaybill,
    "R2: migration is idempotent and leaves newly imported post-migration rows with cloudExpressOrigin intact",
  );
  removeShipmentWithCleanup(postImported!.identity.id, clock + 1_500);
  assert.equal(
    loadState().cloudPddTombstones?.some((t) => t.waybill === postMigrationCloudWaybill && t.action === "deleted"),
    true,
    "post-migration cloud-imported row still syncs deletion to cloud",
  );
});

test("R3: Pinduoduo rows (both pre-0.9.46 cloud-imported pddCloudOrigin and iOS pddImport account rows) sync deletion and sign-off to cloud", async () => {
  const scope = resetEnv();
  const pre0946CloudPddDelete = "YT8800000003001";
  const pre0946CloudPddSign = "YT8800000003002";
  const iosPddAccountDelete = "YT8800000003003";
  const iosPddAccountSign = "YT8800000003004";
  const anchorAt = clock - 20_000;

  // Simulate pre-0.9.46 cloud-imported PDD rows (have pddCloudOrigin, NO cloudExpressOrigin) + iOS PDD account rows (pddImport)
  const rows: Shipment[] = [
    makeManualShipment(pre0946CloudPddDelete, {
      pddCloudOrigin: { waybill: pre0946CloudPddDelete, waybillGeneration: 0 },
    }),
    makeManualShipment(pre0946CloudPddSign, {
      pddCloudOrigin: { waybill: pre0946CloudPddSign, waybillGeneration: 0 },
    }),
    makeManualShipment(iosPddAccountDelete, {
      pddImport: { ownerKey: "pdd-owner", orderId: "260101-3003", shippingId: "73003003" },
    }),
    makeManualShipment(iosPddAccountSign, {
      pddImport: { ownerKey: "pdd-owner", orderId: "260101-3004", shippingId: "73003004" },
    }),
  ];
  saveState({ ...emptyState(), shipments: rows }, clock);

  const cloudRecords = [
    pre0946CloudPddDelete,
    pre0946CloudPddSign,
    iosPddAccountDelete,
    iosPddAccountSign,
  ].map((waybill, idx) => ({
    recordId: parcelDetailRecordId("parcel-express-pdd:", `${waybill}:${anchorAt}`),
    type: "express",
    revision: idx + 1,
    changedAt: clock - 1_000,
    editedAt: clock - 1_000,
    deleted: false,
    lifecycle: "active",
    historyAt: 0,
    payload: {
      waybill,
      carrierCode: "zto",
      phone4: "1234",
      importOrigin: "pdd",
      status: "TRANSIT",
      createdAt: anchorAt,
      eventAt: clock - 10_000,
      updatedAt: clock - 1_000,
    },
  }));
  await pullCloudSnapshot(cloudRecords, 10);

  clock += 2_000;
  removeShipmentWithCleanup(`interface5:manual:${pre0946CloudPddDelete}`, clock);
  forceCompleteShipment(`interface5:manual:${pre0946CloudPddSign}`, clock);
  removeShipmentWithCleanup(`interface5:manual:${iosPddAccountDelete}`, clock);
  forceCompleteShipment(`interface5:manual:${iosPddAccountSign}`, clock);

  const tombstones = loadState().cloudPddTombstones ?? [];
  assert.equal(tombstones.some((t) => t.waybill === pre0946CloudPddDelete && t.action === "deleted"), true);
  assert.equal(tombstones.some((t) => t.waybill === pre0946CloudPddSign && t.action === "completed"), true);
  assert.equal(tombstones.some((t) => t.waybill === iosPddAccountDelete && t.action === "deleted"), true);
  assert.equal(tombstones.some((t) => t.waybill === iosPddAccountSign && t.action === "completed"), true);
  assert.equal((loadState().ignoredCloudManualWaybills ?? []).length, 0, "PDD rows use cloud tombstones, not manual-only ignore list");

  reconcileParcelCloudRecordsWithLocal(scope, clock);
  const edits = readParcelCloudState(scope).edits;
  assert.equal(edits[cloudRecords[0]!.recordId]?.deleted, true, "pre-0.9.46 cloud PDD deletion syncs delete to cloud");
  assert.equal(edits[cloudRecords[1]!.recordId]?.lifecycle, "history", "pre-0.9.46 cloud PDD sign-off syncs completion to cloud");
  assert.equal(edits[cloudRecords[2]!.recordId]?.deleted, true, "iOS PDD account row deletion deletes iOS's cloud record");
  assert.equal(edits[cloudRecords[3]!.recordId]?.lifecycle, "history", "iOS PDD account row sign-off completes iOS's cloud record");
});

test("I2-3: HTTP 401 expired_request retains in-flight batch and queued edits for retry, and quarantined content expires after TTL", async () => {
  const scope = resetEnv();
  const waybill = "YT8800000004001";
  const noteRecordId = parcelDetailRecordId("parcel-note:", waybill);
  saveState({ ...emptyState(), shipments: [makeManualShipment(waybill)] }, clock);
  setShipmentNote(loadState().shipments[0]!, "需要保留重试的备注", clock);

  const expired401 = new GatewayError("expired_request", 401, "expired_request");
  assert.equal(isClockSkewMutationRejection(expired401), false, "HTTP 401 expired_request is NOT matched by clock-skew drop");
  assert.equal(isDeterministicParcelMutationRejection(expired401), false, "HTTP 401 expired_request is NOT a permanent rejection");

  // End-to-end: /mutate returns 401 expired_request once -> batch & edits remain intact -> next sync succeeds!
  let mutateAttempt = 0;
  let pulledSnapshot = false;
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith("/session")) {
      return new Response(JSON.stringify({
        ok: true, schemaVersion: 1, enabled: true, ownerId: OWNER_ID, endpointId: ENDPOINT_ID,
        generation: 1, epoch: EPOCH, nextSequence: 1,
        expressParcelDetailsSupported: true, expressTitleClockSupported: true, expressWatchFeedbackSupported: true,
      }), { status: 200 });
    }
    if (url.endsWith("/pull")) {
      const mode = pulledSnapshot ? "delta" : "snapshot";
      pulledSnapshot = true;
      return new Response(JSON.stringify({
        ok: true, schemaVersion: 1, enabled: true, ownerId: OWNER_ID, endpointId: ENDPOINT_ID,
        generation: 1, epoch: EPOCH, nextSequence: 1,
        expressParcelDetailsSupported: true, expressTitleClockSupported: true, expressWatchFeedbackSupported: true,
        mode, reset: mode === "snapshot", cursor: 5, hasMore: false, records: [],
      }), { status: 200 });
    }
    if (url.endsWith("/mutate")) {
      mutateAttempt += 1;
      if (mutateAttempt === 1) {
        return new Response(JSON.stringify({ ok: false, error: "expired_request", message: "expired_request" }), { status: 401 });
      }
      const currentBatch = readParcelCloudState(scope).batch!;
      return new Response(JSON.stringify({
        ok: true, schemaVersion: 1, enabled: true, ownerId: OWNER_ID, endpointId: ENDPOINT_ID,
        generation: 1, epoch: EPOCH, sequence: currentBatch.sequence, nextSequence: currentBatch.sequence + 1,
        results: [{
          recordId: noteRecordId,
          mutationId: currentBatch.mutations[0].mutationId,
          revision: 1,
          editedAt: clock,
          deleted: false,
        }],
      }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  await synchronizeParcelCloudRecords();
  assert.equal(mutateAttempt, 1);
  const heldState = readParcelCloudState(scope, clock);
  assert.ok(heldState.batch, "I2-3: 401 expired_request retains in-flight batch");
  assert.ok(heldState.edits[noteRecordId], "I2-3: 401 expired_request retains queued edit");

  await synchronizeParcelCloudRecords();
  assert.equal(mutateAttempt, 2, "retained batch retries on next sync");
  const syncedState = readParcelCloudState(scope, clock);
  assert.equal(syncedState.batch, undefined);
  assert.equal(syncedState.edits[noteRecordId], undefined);
  assert.equal(syncedState.synced[noteRecordId]?.revision, 1);

  // Verify quarantined shelving expires after PARCEL_CLOUD_QUARANTINE_TTL_MS (24h)
  setShipmentNote(loadState().shipments[0]!, "首次被拒备注", clock + 1_000);
  clock += 1_000;
  reconcileParcelCloudRecordsWithLocal(scope, clock);
  const withEdit = prepareParcelBatch(readParcelCloudState(scope, clock), "66666666-6666-4666-8666-000000004001");
  assert.ok(withEdit.batch);
  const dropped = dropRejectedParcelBatch(
    withEdit,
    withEdit.batch!,
    new GatewayError("invalid_cloud_record_payload", 400, "invalid_cloud_record_payload"),
    clock,
  );
  assert.equal(dropped.quarantined?.[noteRecordId]?.expiresAtMs, clock + PARCEL_CLOUD_QUARANTINE_TTL_MS);

  // Persist dropped state and check before vs after TTL expiry
  memory.set(
    "file:/group/pipi-deliveries/parcel-cloud-sync-v1.json",
    JSON.stringify({ version: 1, scopes: { [scope]: dropped } }),
  );
  resetParcelCloudDeniedBackoffForTests();
  reconcileParcelCloudRecordsWithLocal(scope, clock + 60_000);
  assert.equal(readParcelCloudState(scope, clock + 60_000).edits[noteRecordId], undefined, "shelved within 24h TTL");

  const afterTtl = clock + PARCEL_CLOUD_QUARANTINE_TTL_MS + 1_000;
  reconcileParcelCloudRecordsWithLocal(scope, afterTtl);
  assert.ok(readParcelCloudState(scope, afterTtl).edits[noteRecordId], "quarantine expires after 24h TTL so edit can retry");
  assert.equal(readParcelCloudState(scope, afterTtl).quarantined, undefined);
});

test("I2-4 / R10: root foreground projection and HomePage row equality detect structured status changes with unchanged headline and time", () => {
  const rawIndexSrc = readFileSync(new URL("../index.tsx", import.meta.url), "utf8");
  const projStart = rawIndexSrc.indexOf("function sameForegroundShipmentProjection(");
  const projEnd = rawIndexSrc.indexOf("function usePickupTabState(");
  const projCode = stripTypeScriptTypes(rawIndexSrc.slice(projStart, projEnd), { mode: "transform" })
    .replace(/^export /gm, "");
  const rootHelpers = runInNewContext(
    `${projCode}\n;({ selectForegroundShipmentsProjection });`,
    { displayWaybill, listHeadline, shipmentPresentationStatus, statusTextTint },
  ) as {
    selectForegroundShipmentsProjection: (prev: readonly Shipment[], next: readonly Shipment[]) => readonly Shipment[];
  };

  const homeSource = readFileSync(new URL("../pages/HomePage.tsx", import.meta.url), "utf8");
  const homeStart = homeSource.indexOf("type ShipmentListItem =");
  const homeEnd = homeSource.indexOf("export function HomePage(");
  const homeHelpers = runInNewContext(
    `${stripTypeScriptTypes(homeSource.slice(homeStart, homeEnd))}\n({ sameShipmentRowPresentation })`,
    { displayWaybill, listHeadline, shipmentPresentationStatus, statusTextTint },
  ) as {
    sameShipmentRowPresentation: (left: Shipment, right: Shipment) => boolean;
  };

  const withNormalized = (
    semantic: Shipment["timeline"]["semantic"],
    normalizedStatus: NormalizedStatus,
    extra: Partial<Shipment> = {},
  ): Shipment =>
    makeManualShipment("SF8800000005001", {
      ...extra,
      identity: {
        id: "interface5:auto:SF8800000005001",
        bindingSource: "interface5",
        sourceOwner: "13800138000",
        sourceId: "SF8800000005001",
        phoneTail: "8000",
        courierCode: "SF",
        companyName: "顺丰速运",
        manuallyAdded: false,
        createdAtMs: NOW - 60_000,
        ...(extra.identity ?? {}),
      },
      timeline: {
        provider: "interface5",
        waybill: "SF8800000005001",
        courierCode: "SF",
        companyName: "顺丰速运",
        semantic,
        structuredStatus: true,
        statusEventAtMs: NOW - 10_000,
        normalizedStatus,
        latestTimeText: "2026-11-28 09:50:00",
        latestDetail: "快件状态已更新",
        tracks: [],
        successAtMs: NOW,
      },
    });

  const transitions: Array<[string, Shipment, Shipment]> = [
    [
      "待派送 -> 派送中",
      withNormalized("DELIVERY", {
        version: 1, scope: "SHIPMENT", semantic: "DELIVERY", code: "STA_DELIVERING",
        text: "待派送", priority: 1, eventAtMs: NOW - 10_000, structured: true,
      }),
      withNormalized("DELIVERY", {
        version: 1, scope: "SHIPMENT", semantic: "DELIVERY", code: "DELIVERING",
        text: "派送中", priority: 0, eventAtMs: NOW - 10_000, structured: true,
      }),
    ],
    [
      "运输中 -> 清关中",
      withNormalized("TRANSIT", {
        version: 1, scope: "SHIPMENT", semantic: "TRANSIT", code: "TRANSPORT",
        text: "运输中", priority: 0, eventAtMs: NOW - 10_000, structured: true,
      }),
      withNormalized("TRANSIT", {
        version: 1, scope: "SHIPMENT", semantic: "TRANSIT", code: "CUSTOMS_CLEARANCE",
        text: "清关中", priority: 1, eventAtMs: NOW - 10_000, structured: true,
      }),
    ],
    [
      "已签收 -> 已完成",
      withNormalized("COMPLETED", {
        version: 1, scope: "SHIPMENT", semantic: "COMPLETED", code: "SIGNED",
        text: "已签收", priority: 0, eventAtMs: NOW - 10_000, structured: true,
      }),
      withNormalized("COMPLETED", {
        version: 1, scope: "ORDER", semantic: "COMPLETED", code: "ORDER_COMPLETED",
        text: "已完成", priority: 0, eventAtMs: NOW - 10_000, structured: true,
      }, {
        identity: {
          id: "interface5:auto:SF8800000005001",
          bindingSource: "interface5",
          sourceOwner: "interface5:order",
          sourceId: "2900000005001",
          orderId: "2900000005001",
          accountOrder: true,
          phoneTail: "8000",
          courierCode: "JD",
          companyName: "京东购物",
          manuallyAdded: false,
          createdAtMs: NOW - 60_000,
        },
        statusPresentation: { scope: "ORDER", semantic: "COMPLETED", text: "已完成" },
      }),
    ],
  ];

  for (const [label, before, after] of transitions) {
    assert.notEqual(shipmentPresentationStatus(before).text, shipmentPresentationStatus(after).text, label);
    assert.equal(homeHelpers.sameShipmentRowPresentation(before, after), false, `HomePage detects ${label}`);
    const prevList = [before];
    const nextList = [after];
    assert.equal(
      rootHelpers.selectForegroundShipmentsProjection(prevList, nextList),
      nextList,
      `root foreground projection publishes ${label}`,
    );
  }
});

test("I2-5: recognizeMealImage decodes QR on explicit redemption cues even when online model returns 茶颜悦色 + invented text code", async () => {
  const raw = JSON.parse(readFileSync(new URL("../../../pickup-rules.json", import.meta.url), "utf8"));
  const rules = { raw, parsed: createPickupRuntime(raw) };
  const width = 1179, height = 1050;
  const makeCandidates = (rows: readonly [string, number][]) =>
    rows.map(([content, top]) => ({
      content,
      boundingBox: { x: 30 / width, y: 1 - (top + 30) / height, width: 510 / width, height: 30 / height },
    }));

  const qrGrid = `
00000000000000000000000
01111111010001010000010
01000001000100010000110
01011101010101001101010
01011101000100010000100
01011101011010111101110
01000001001011100111000
01111111000110110110010
00000000010010100110100
01101001011101011000010
01111110001000010111100
01101101011101000100010
01000010010100011001100
01010101000110000100100
00000000001011000000000
01111111010101011111110
01000001001001010000010
01011101011001010111010
01011101000111010111010
01011101000100010111010
01000001010110010000010
01111111001000011111110
00000000000000000000000
`.trim().split("\n");
  const qrWidth = 200, qrHeight = 200, scale = 5, margin = 16;
  const rgba = new Uint8Array(qrWidth * qrHeight * 4).fill(255);
  for (const [y, row] of qrGrid.entries()) {
    for (const [x, bit] of [...row].entries()) {
      if (bit !== "1") continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const pixel = ((y * scale + margin + dy) * qrWidth + x * scale + margin + dx) * 4;
          rgba.fill(0, pixel, pixel + 3);
        }
      }
    }
  }
  let toPixelsCalls = 0;
  const fakeImage = {
    width: qrWidth,
    height: qrHeight,
    scale: 1,
    toPixels: () => {
      toPixelsCalls += 1;
      return { width: qrWidth, height: qrHeight, data: rgba };
    },
  } as unknown as UIImage;
  const modelInvented = {
    brand: "茶颜悦色",
    pickupCode: "88",
    merchantName: "深圳前海壹方城游园会店",
    productName: "幽兰拿铁",
  };
  const scanRedemptionCues = makeCandidates([
    ["请出示二维码", 60],
    ["茶颜悦色", 110],
    ["深圳前海壹方城游园会店", 210],
    ["幽兰拿铁", 400],
  ]);
  assert.equal(onlineMealRequiresQR(modelInvented, rules, scanRedemptionCues), true);
  const result = await recognizeMealImage(fakeImage, scanRedemptionCues, NOW, rules, modelInvented);
  assert.ok(toPixelsCalls >= 1, "readMealQRs decodes QR when 请出示二维码 cue is present");
  assert.equal(result.meals[0]?.payload.brandId, "chayanyuese");
  assert.equal(result.meals[0]?.payload.code, "", "invented text code 88 is NOT saved as a text pickup code");
  assert.equal(result.meals[0]?.payload.status, "待核销");
  assert.equal(result.meals[0]?.payload.qrPayload, "00-SYNTH-A");
});

test("I2-11: JD delivery-estimate network interception ignores recommendation endpoints and truncates before 可能您还想要 / 猜你喜欢 / 为你推荐", async () => {
  resetEnv();
  const jdWaybill = "JD8800000006001";
  const jdOrder = "2900000006001";
  const jdShipment = makeManualShipment(jdWaybill, {
    identity: {
      id: `interface5:jd:${jdWaybill}`,
      bindingSource: "interface5",
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
      title: { text: "自营测试商品", source: "jingdong" },
    },
  });
  saveState({ ...emptyState(), shipments: [jdShipment] }, clock);
  savePlatformLogin("jingdong", "", { kind: "web", cookies: JD_COOKIES }, "synthetic_pin");

  const originalController = globalThis.WebViewController;
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
          const bodiesByUrl: Record<string, string> = {
            // 1) Recommendation endpoint must be ignored completely
            "https://api.m.jd.com/client.action?functionId=uniformRecommend": JSON.stringify({
              data: [{ promiseText: "预计明天09:00-15:00送达" }],
            }),
            // 2) Non-logistics subdomain must be ignored completely
            "https://diviner.m.jd.com/diviner?lid=1": JSON.stringify({
              promise: "预计明天12:00前送达",
            }),
            // 3) Logistics endpoint with floor list containing 猜你喜欢 / 为你推荐 / 可能您还想要 after parcel header without ETA
            "https://api.m.jd.com/client.action?functionId=orderTrackBusiness": JSON.stringify({
              floors: [
                { mId: "summary", waybillCode: jdWaybill, statusText: "派送中" },
                { mId: "rec", title: "猜你喜欢", items: [{ promise: "预计明天18:00前送达" }] },
                { mId: "more", title: "为你推荐", items: [{ promise: "预计后天送达" }] },
              ],
              recommendList: [{ deliveryTip: "预计明天21:00前送达" }],
            }),
            // 4) Plain-text / SSR logistics snippet with recommendation block
            "https://trade.m.jd.com/order/deal_wuliu_jdm.shtml?dealId=2900000006001":
              `运单号：${jdWaybill}\n为你推荐\n预计明天10:00-12:00送达`,
          };
          this.sandbox = {
            URL,
            URLSearchParams,
            location: parsed,
            document: {
              title: "订单跟踪",
              body: {
                innerText: `运单号：${jdWaybill}\n京东快递\n猜你喜欢\n预计明天15:00-21:00送达`,
                querySelectorAll: () => [],
              },
              querySelectorAll: () => [],
            },
            XMLHttpRequest: class {
              open() {}
              send() {}
              addEventListener() {}
            },
            fetch: async (reqUrl: string) => ({
              ok: true,
              url: reqUrl,
              clone: () => ({
                text: async () => bodiesByUrl[reqUrl] ?? "{}",
              }),
            }),
          };
          this.sandbox.window = this.sandbox;
          this.sandbox.top = this.sandbox;
          if (this.injected) {
            runInNewContext(this.injected, this.sandbox);
            for (const reqUrl of Object.keys(bodiesByUrl)) {
              await (this.sandbox.fetch as (u: string) => Promise<unknown>)(reqUrl);
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          return true;
        }
        return true;
      }
      async evaluateJavaScript(script: string) {
        clock += 250;
        if (this.url.includes("orderlist")) {
          return { state: "ok", orders: [{ orderId: jdOrder, title: "自营测试商品", state: "等待收货" }] };
        }
        return runInNewContext(`(function(){${script}})()`, this.sandbox);
      }
      dispose() {}
    },
  });
  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  try {
    await refreshPlatformParcels(() => {}, "observe", "jingdong");
    const updated = loadState().shipments[0]!;
    assert.equal(
      displayedPlatformFields(updated, clock).estimate,
      "",
      "I2-11: recommendation copy never leaks into parcel delivery estimate",
    );
  } finally {
    const session = platformSession("jingdong");
    if (session) clearPlatformLogin("jingdong", session.generation);
    globalThis.WebViewController = originalController;
    registerProjectionViewportHost(null);
  }
});
