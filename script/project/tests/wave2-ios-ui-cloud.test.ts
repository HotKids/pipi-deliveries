import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { memory } from "./state-storage-mock.ts";

const NOW = Date.UTC(2026, 10, 26, 2, 0, 0);
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

const { SCRIPT_BUILD_TRACK, SCRIPT_VERSION } = await import("../services/build-track.ts");
const { saveGatewayToken, gatewayCredentialForLocalCache } = await import("../services/credentials.ts");
const { mealCredentialScope } = await import("../services/meal/rules.ts");
const { synchronizeMeals } = await import("../services/meal/cloud.ts");
const {
  applyParcelPage,
  applyParcelReceipt,
  parcelDetailRecordId,
  parcelPullRequest,
  prepareParcelBatch,
  readCachedParcelCloudPddLink,
  readParcelCloudState,
  recoverParcelConflict,
  resetParcelCloudDeniedBackoffForTests,
  synchronizeParcelCloudRecords,
} = await import("../services/parcel-cloud-sync.ts");
const { readCachedCloudParcelMetadata } = await import("../services/cloud-parcel-metadata.ts");
const { legibleCodeOnDark } = await import("../services/parcel-card-appearance.ts");
const { smallWidgetLayout } = await import("../widget/layout.ts");
const { EMPTY_WIDGET_TEXT_COLOR } = await import("../widget/palette.ts");
const { rgbLuminance } = await import("../services/status.ts");
const { parcelActivityCompactText } = await import("../services/parcel-pickup.ts");
const { readMealQRs } = await import("../services/meal/qr.ts");
const {
  MEAL_RULES_RETRY_BACKOFF_MS,
  ensureMealRules,
  loadCarrierAuthorityCache,
  refreshCarrierAuthorityIfNeeded,
  resetCarrierAuthorityRuntimeForTesting,
} = await import("../services/carrier-authority.ts");
const { activeCarrierQueryRecords } = await import("../services/carrier-query.ts");
const { acquireRenewingDurableRefreshLease } = await import("../services/refresh-runtime-state.ts");
const {
  commitRefreshState,
  commitWatchSnapshot,
  completeIndependentParcelCode,
  deleteIndependentParcelCode,
  emptyState,
  forceCompleteShipment,
  loadState,
  prunePickupCodeRecords,
  removeShipmentWithCleanup,
  saveRecognizedParcelCode,
  saveState,
  setShipmentNote,
  setShipmentProductName,
} = await import("../services/storage.ts");
const { internationalShipmentSnapshot } = await import("../services/international-records.ts");
const { deferIncomingRoute, publishDeferredRoutes } = await import("../services/sync/route-publications.ts");
const { loadShipmentRoute } = await import("../services/routes.ts");

function workerUuidV5(prefix: string, waybill: string): string {
  const ns = Buffer.from("4d953a3473995d91a36bb23cccf42c49", "hex");
  const digest = createHash("sha1")
    .update(Buffer.concat([ns, Buffer.from(`${prefix}${waybill}`, "utf8")]))
    .digest()
    .subarray(0, 16);
  const id = Buffer.from(digest);
  id[6] = (id[6]! & 0x0f) | 0x50;
  id[8] = (id[8]! & 0x3f) | 0x80;
  const hex = id.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function wcagContrast(hexA: string, rgbB: number): number {
  const rgbA = Number.parseInt(hexA.replace(/^#/, ""), 16);
  const l1 = rgbLuminance(rgbA) + 0.05;
  const l2 = rgbLuminance(rgbB) + 0.05;
  return Math.max(l1, l2) / Math.min(l1, l2);
}

test("L-01: script.json and SCRIPT_VERSION are aligned at 0.9.38 on formal track", () => {
  const pkg = JSON.parse(readFileSync(new URL("../script.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(SCRIPT_BUILD_TRACK, "formal");
  assert.equal(pkg.version, "0.9.38");
  assert.equal(SCRIPT_VERSION, "0.9.38");
});

test("Task A: parcelDetailRecordId matches Worker UUIDv5 byte-for-byte", () => {
  for (const waybill of ["SF1234567890123", "YT889900112233", "JDVA0011223344", "1Z999AA10123456784", "DHL_TEST-99"]) {
    for (const prefix of ["parcel-metadata:", "parcel-pdd-link:", "parcel-watch-feedback:"]) {
      assert.equal(
        parcelDetailRecordId(prefix, waybill),
        workerUuidV5(prefix, waybill),
        `${prefix}${waybill}`,
      );
    }
  }
});

test("Task A: parcel-cloud-sync bidirectional sync, pagination, tombstones, 409 recovery, 403 backoff & cross-process lease", async () => {
  clock = NOW;
  memory.clear();
  resetParcelCloudDeniedBackoffForTests();

  const ownerId = "a".repeat(64);
  const endpointId = `scripting-parcel:${"b".repeat(64)}`;
  const epoch = "11111111-2222-4333-8444-555555555555";

  // 1. Without an Access Key, synchronizeParcelCloudRecords is a no-op and makes zero network requests.
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("unexpected network call");
  }) as typeof fetch;
  await synchronizeParcelCloudRecords();
  assert.equal(fetchCalls, 0);

  // Configure valid formal Access Key
  saveGatewayToken("AbCdEfGh_123-456");
  const scope = mealCredentialScope();
  assert.ok(scope, "formal track + valid key yields non-empty scope");

  // 2. Cross-process App Group lease prevents concurrent /mutate across processes for both parcel & meal sync
  const heldParcelLease = acquireRenewingDurableRefreshLease(`cloud:parcel:${scope}`, 30_000, clock);
  assert.ok(heldParcelLease);
  await synchronizeParcelCloudRecords();
  assert.equal(fetchCalls, 0, "parcel sync yields immediately when another runtime holds cloud:parcel lease");
  heldParcelLease.release();

  const heldMealLease = acquireRenewingDurableRefreshLease(`cloud:meal:${scope}`, 30_000, clock);
  assert.ok(heldMealLease);
  await synchronizeMeals();
  assert.equal(fetchCalls, 0, "meal sync yields immediately when another runtime holds cloud:meal lease");
  heldMealLease.release();

  // 3. 403 cloud_sync_disabled backs off cleanly for 5 minutes without throwing
  let sessionCalls = 0;
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/scripting-parcels/session")) {
      sessionCalls++;
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ ok: false, error: "cloud_sync_disabled" }),
      };
    }
    throw new Error(`unexpected route: ${path}`);
  }) as typeof fetch;
  await synchronizeParcelCloudRecords();
  await synchronizeParcelCloudRecords();
  assert.equal(sessionCalls, 1, "second call within 5-minute 403 backoff does not hit network");
  resetParcelCloudDeniedBackoffForTests();

  // 4. Seed local state + mock full Worker cloud-record DO (`session`, 2-page `snapshot` + `delta`, `mutate`)
  const localPddWaybill = "YT202611260001";
  const remotePddWaybill = "STO202611260002";
  const deletedPddWaybill = "ZTO202611260003";
  const watchWaybill = "DHL2026112609";
  const watchUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  const seededPickupRecords = [
    {
      id: "local-duoduo-1",
      kind: "pickup" as const,
      platform: "pinduoduo" as const,
      code: "DD-88-102",
      capturedAtMs: clock - 1_200_000,
      locationName: "多多买菜站点",
      note: "易碎品",
    },
    {
      id: "local-handoff-1",
      kind: "handoff" as const,
      platform: "cainiao" as const,
      code: "4821",
      capturedAtMs: clock - 1_000_000,
      windowStartAtMs: clock + 3_600_000,
      windowEndAtMs: clock + 7_200_000,
    },
  ];
  saveState({
    ...emptyState(),
    shipments: [
      {
        identity: {
          id: `interface5:manual:${localPddWaybill}`,
          bindingSource: "interface5",
          sourceOwner: "manual",
          sourceId: localPddWaybill,
          phoneTail: "8899",
          courierCode: "YTO",
          companyName: "圆通速递",
          productImageURL: "https://example.com/local-only-should-never-upload.jpg",
          manuallyAdded: true,
          createdAtMs: clock - 3_600_000,
        },
        timeline: {
          provider: "v6_query",
          waybill: localPddWaybill,
          courierCode: "YTO",
          companyName: "圆通速递",
          semantic: "TRANSIT",
          structuredStatus: true,
          statusEventAtMs: clock - 1_800_000,
          latestTimeText: "2026-11-26 09:30:00",
          latestDetail: "快件运输中",
          successAtMs: clock - 1_800_000,
          tracks: [{ timeText: "2026-11-26 09:30:00", timeMs: clock - 1_800_000, detail: "快件运输中", statusCode: "TRANSIT", raw: {} }],
        },
        pddImport: { ownerKey: "pdd-u1", orderId: "261126-0001", shippingId: "987654321" },
        platformFields: {
          waybill: localPddWaybill,
          waybillGeneration: 0,
          manualTitle: "人体工学键盘",
          manualTitleEditedAtMs: clock - 600_000,
          estimate: { text: "预计11月28日送达", source: "pinduoduo", capturedAtMs: clock - 900_000 },
        },
        note: "放丰巢柜",
        updatedAtMs: clock - 600_000,
      },
    ],
    cloudPddTombstones: [
      { waybill: deletedPddWaybill, anchorAt: clock - 5_000_000, action: "deleted", actedAtMs: clock - 100_000 },
    ],
  }, clock, { pickupCodeRecords: seededPickupRecords });

  commitWatchSnapshot({
    scope: gatewayCredentialForLocalCache()!.scope,
    snapshot: "s1",
    observedAtMs: clock - 1_000,
    shipments: [
      internationalShipmentSnapshot(
        {
          id: watchUuid,
          waybill: watchWaybill,
          carrierName: "DHL",
          icon: "dhl",
          status: "TRANSIT",
          statusText: "运输中",
          updatedAt: clock - 3_600_000,
          tracks: [{ at: clock - 3_600_000, detail: "Processed at hub" }],
        },
        clock,
      ),
    ],
  });

  // Trigger local Watch completion feedback via storage API
  forceCompleteShipment(`watch:${watchUuid}`, clock - 50_000);
  assert.equal(loadState(clock).watchFeedback?.length, 1);

  const remoteStore = new Map<string, Record<string, unknown>>();
  let serverCursor = 3;
  let serverSequence = 0;

  // Populate initial remote records across 2 snapshot pages
  const remotePddExpressId = "22222222-3333-4444-8555-666666666661";
  const deletedPddExpressId = "22222222-3333-4444-8555-666666666662";
  const remoteMetaId = parcelDetailRecordId("parcel-metadata:", remotePddWaybill);
  const remoteLinkId = parcelDetailRecordId("parcel-pdd-link:", remotePddWaybill);
  const remotePickupId = "22222222-3333-4444-8555-666666666663";

  remoteStore.set(remotePddExpressId, {
    recordId: remotePddExpressId,
    type: "express",
    revision: 1,
    changedAt: clock - 2_000_000,
    editedAt: clock - 2_000_000,
    lifecycle: "active",
    historyAt: 0,
    deleted: false,
    payload: {
      waybill: remotePddWaybill,
      carrierCode: "STO",
      phone4: "1234",
      importOrigin: "pdd",
      status: "TRANSIT",
      eventAt: clock - 2_000_000,
      createdAt: clock - 2_000_000,
      updatedAt: clock - 2_000_000,
    },
  });
  remoteStore.set(deletedPddExpressId, {
    recordId: deletedPddExpressId,
    type: "express",
    revision: 2,
    changedAt: clock - 5_000_000,
    editedAt: clock - 5_000_000,
    lifecycle: "active",
    historyAt: 0,
    deleted: false,
    payload: {
      waybill: deletedPddWaybill,
      carrierCode: "ZTO",
      phone4: "0000",
      importOrigin: "pdd",
      status: "TRANSIT",
      eventAt: clock - 5_000_000,
      createdAt: clock - 5_000_000,
      updatedAt: clock - 5_000_000,
    },
  });
  remoteStore.set(remoteMetaId, {
    recordId: remoteMetaId,
    type: "express_metadata",
    revision: 3,
    changedAt: clock - 1_500_000,
    editedAt: clock - 1_500_000,
    lifecycle: "active",
    historyAt: 0,
    deleted: false,
    payload: {
      waybill: remotePddWaybill,
      anchorAt: clock - 2_000_000,
      productName: "云端同步保温杯",
      productNameObservedAt: clock - 1_500_000,
      productImageUrl: "https://img.pddpic.com/mms-material-img/test-cup.webp",
    },
  });
  remoteStore.set(remoteLinkId, {
    recordId: remoteLinkId,
    type: "express_pdd_link",
    revision: 3,
    changedAt: clock - 1_500_000,
    editedAt: clock - 1_500_000,
    lifecycle: "active",
    historyAt: 0,
    deleted: false,
    payload: {
      waybill: remotePddWaybill,
      anchorAt: clock - 2_000_000,
      terminalAt: 0,
      shippingId: "123456789",
      observedAt: clock - 1_500_000,
    },
  });
  remoteStore.set(remotePickupId, {
    recordId: remotePickupId,
    type: "parcel_pickup",
    revision: 3,
    changedAt: clock - 800_000,
    editedAt: clock - 800_000,
    lifecycle: "active",
    historyAt: 0,
    deleted: false,
    payload: {
      brandId: "duoduo",
      code: "7-7-707",
      location: "南门多多驿站",
      capturedAt: clock - 800_000,
      note: "帮拿快递",
    },
  });

  const receivedMutations: Array<Record<string, unknown>> = [];
  const pullBodies: Array<Record<string, unknown>> = [];
  const mutateTopKeys: string[][] = [];

  const sessionMeta = () => ({
    ok: true,
    schemaVersion: 1,
    ownerId,
    endpointId,
    generation: 1,
    enabled: true,
    epoch,
    cursor: serverCursor,
    nextSequence: serverSequence + 1,
    expressParcelDetailsSupported: true,
    expressTitleClockSupported: true,
    expressWatchFeedbackSupported: true,
  });

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    if (path.endsWith("/scripting-parcels/session")) {
      return { ok: true, status: 200, text: async () => JSON.stringify(sessionMeta()) };
    }
    if (path.endsWith("/scripting-parcels/pull")) {
      pullBodies.push(body);
      const allRecords = [...remoteStore.values()];
      if (body.epoch === "") {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ...sessionMeta(),
              mode: "snapshot",
              reset: true,
              hasMore: true,
              pageToken: "page-2",
              records: allRecords.slice(0, 2),
            }),
        };
      }
      if (body.pageToken === "page-2") {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ...sessionMeta(),
              mode: "snapshot",
              reset: true,
              hasMore: false,
              pageToken: null,
              records: allRecords.slice(2),
            }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ...sessionMeta(),
            mode: "delta",
            reset: false,
            hasMore: false,
            pageToken: null,
            records: [],
          }),
      };
    }
    if (path.endsWith("/scripting-parcels/mutate")) {
      mutateTopKeys.push(Object.keys(body).sort());
      // Enforce Worker validateCloudMutations forbidden top-level keys!
      for (const forbidden of ["includeEditTime", "includeExpressNotes", "includeParcelHandoffs", "includeExpressProductImage"]) {
        assert.equal(Object.hasOwn(body, forbidden), false, `mutate must not send ${forbidden}`);
      }
      const [mutation] = body.mutations as Array<Record<string, unknown>>;
      assert.ok(mutation);
      if (mutation.type === "express_metadata") {
        assert.equal(
          Object.hasOwn((mutation.payload as Record<string, unknown>) || {}, "productImageUrl"),
          false,
          "Scripting must NEVER upload productImageUrl",
        );
      }
      receivedMutations.push(mutation);
      serverSequence = Number(body.sequence);
      serverCursor += 1;
      const rev = serverCursor;
      const recordId = String(mutation.recordId);
      const isDelete = mutation.operation === "delete";
      if (isDelete) {
        const prev = remoteStore.get(recordId) || { lifecycle: "active", historyAt: 0, type: mutation.type };
        remoteStore.set(recordId, {
          ...prev,
          recordId,
          revision: rev,
          changedAt: clock,
          editedAt: mutation.editedAt,
          deleted: true,
          reason: "user",
        });
      } else {
        remoteStore.set(recordId, {
          recordId,
          type: mutation.type,
          revision: rev,
          changedAt: clock,
          editedAt: mutation.editedAt,
          lifecycle: mutation.lifecycle,
          historyAt: mutation.historyAt,
          deleted: false,
          payload: mutation.payload,
        });
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ...sessionMeta(),
            sequence: serverSequence,
            nextSequence: serverSequence + 1,
            results: [
              {
                mutationId: mutation.mutationId,
                recordId,
                revision: rev,
                deleted: isDelete,
                cursor: rev,
                editedAt: mutation.editedAt,
              },
            ],
          }),
      };
    }
    throw new Error(`Unhandled route: ${path}`);
  }) as typeof fetch;

  await synchronizeParcelCloudRecords();

  // Verify pull capability flags
  assert.ok(pullBodies.length >= 3, "session ran 2 snapshot pages + delta pull");
  for (const flag of [
    "includeEditTime",
    "includeExpressNotes",
    "includeExpressMetadata",
    "includeExpressTitleClock",
    "includeExpressPddLink",
    "includeParcelHandoffs",
    "includeParcelCodeNotes",
    "includePdd",
    "includeVivoDouyin",
    "includeExpressWatchFeedback",
  ]) {
    assert.equal(pullBodies[0]![flag], true, `pull includes ${flag}`);
  }

  // Verify inbound records merged into AppState & shared cache while respecting tombstones
  const syncedApp = loadState(clock);
  assert.ok(
    syncedApp.shipments.some((row) => row.pddCloudOrigin?.waybill === remotePddWaybill),
    "remote PDD express parcel was imported locally",
  );
  assert.equal(
    syncedApp.shipments.some((row) => row.identity.sourceId === deletedPddWaybill),
    false,
    "tombstoned PDD parcel was NOT resurrected",
  );
  assert.ok(
    syncedApp.pickupCodeRecords?.some(
      (item) => item.kind === "pickup" && item.platform === "pinduoduo" && item.code === "7-7-707" && item.note === "帮拿快递",
    ),
    "remote duoduo standalone pickup mapped to local pinduoduo PickupCodeRecord",
  );

  const localCred = gatewayCredentialForLocalCache();
  assert.ok(localCred);
  const cachedMeta = readCachedCloudParcelMetadata(localCred.scope, remotePddWaybill);
  assert.equal(cachedMeta?.productName, "云端同步保温杯");
  assert.equal(cachedMeta?.productImageURL, "https://img.pddpic.com/mms-material-img/test-cup.webp");
  assert.equal(readCachedParcelCloudPddLink(localCred.scope, remotePddWaybill)?.shippingId, "123456789");

  // Verify outbound mutations covered all local changes with deterministic IDs & valid payloads
  const byType = new Map<string, Array<Record<string, unknown>>>();
  for (const m of receivedMutations) {
    const list = byType.get(String(m.type)) || [];
    list.push(m);
    byType.set(String(m.type), list);
  }

  // Outbound PDD express + tombstone deletion
  const expressMutations = byType.get("express") || [];
  assert.ok(
    expressMutations.some(
      (m) => m.operation === "put" && (m.payload as Record<string, unknown>)?.waybill === localPddWaybill &&
        (m.payload as Record<string, unknown>)?.importOrigin === "pdd",
    ),
    "local PDD parcel exported as express(importOrigin=pdd)",
  );
  assert.ok(
    expressMutations.some((m) => m.operation === "delete" && m.recordId === deletedPddExpressId),
    "local cloudPddTombstone deleted remote PDD express record",
  );

  // Outbound express_pdd_link
  const pddLinkMutation = (byType.get("express_pdd_link") || [])[0];
  assert.ok(pddLinkMutation);
  assert.equal(pddLinkMutation.recordId, workerUuidV5("parcel-pdd-link:", localPddWaybill));
  assert.equal((pddLinkMutation.payload as Record<string, unknown>).shippingId, "987654321");

  // Outbound express_metadata (manualTitle + deliveryEstimate, NO productImageUrl)
  const metaMutation = (byType.get("express_metadata") || [])[0];
  assert.ok(metaMutation);
  assert.equal(metaMutation.recordId, workerUuidV5("parcel-metadata:", localPddWaybill));
  assert.equal((metaMutation.payload as Record<string, unknown>).productName, "人体工学键盘");
  assert.equal((metaMutation.payload as Record<string, unknown>).productNameObservedAt, clock - 600_000);
  assert.equal((metaMutation.payload as Record<string, unknown>).deliveryEstimate, "预计11月28日送达");

  // Outbound express_note
  const noteMutation = (byType.get("express_note") || [])[0];
  assert.ok(noteMutation);
  assert.equal((noteMutation.payload as Record<string, unknown>).subject, `waybill:${localPddWaybill}`);
  assert.equal((noteMutation.payload as Record<string, unknown>).note, "放丰巢柜");

  // Outbound parcel_pickup (pinduoduo -> duoduo) & parcel_handoff (expiresAt = windowEndAt + 3_600_000)
  const pickupMutation = (byType.get("parcel_pickup") || []).find(
    (m) => (m.payload as Record<string, unknown>)?.code === "DD-88-102",
  );
  assert.ok(pickupMutation);
  assert.equal((pickupMutation.payload as Record<string, unknown>).brandId, "duoduo");
  const handoffMutation = (byType.get("parcel_handoff") || [])[0];
  assert.ok(handoffMutation);
  assert.equal(
    (handoffMutation.payload as Record<string, unknown>).expiresAt,
    clock + 7_200_000 + 3_600_000,
  );

  // Outbound express_watch_feedback
  const watchFeedbackMutation = (byType.get("express_watch_feedback") || [])[0];
  assert.ok(watchFeedbackMutation);
  assert.equal(watchFeedbackMutation.recordId, workerUuidV5("parcel-watch-feedback:", watchWaybill));
  assert.equal(watchFeedbackMutation.lifecycle, "active");
  assert.equal(watchFeedbackMutation.historyAt, 0);
  assert.equal((watchFeedbackMutation.payload as Record<string, unknown>).action, "completed");
  assert.equal((watchFeedbackMutation.payload as Record<string, unknown>).watchRecordId, watchUuid);

  // 5. Local delete of synced standalone pickup emits operation="delete", and inbound watch deletion removes watch row
  receivedMutations.length = 0;
  clock += 10_000;
  deleteIndependentParcelCode(remotePickupId, clock);
  const watchDeleteId = workerUuidV5("parcel-watch-feedback:", watchWaybill);
  serverCursor += 1;
  remoteStore.set(watchDeleteId, {
    recordId: watchDeleteId,
    type: "express_watch_feedback",
    revision: serverCursor,
    changedAt: clock,
    editedAt: clock,
    lifecycle: "active",
    historyAt: 0,
    deleted: false,
    payload: {
      waybill: watchWaybill,
      watchRecordId: watchUuid,
      action: "deleted",
      actedAt: clock,
    },
  });
  // Override delta pull to deliver the new remote watch_feedback deletion
  const baseFetch = globalThis.fetch;
  let deliveredDelta = false;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/scripting-parcels/pull") && !deliveredDelta) {
      deliveredDelta = true;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ...sessionMeta(),
            mode: "delta",
            reset: false,
            hasMore: false,
            pageToken: null,
            records: [remoteStore.get(watchDeleteId)],
          }),
      };
    }
    return baseFetch(url, init);
  }) as typeof fetch;

  await synchronizeParcelCloudRecords();
  assert.ok(
    receivedMutations.some((m) => m.recordId === remotePickupId && m.operation === "delete"),
    "deleting synced standalone pickup pushes delete tombstone to cloud",
  );
  const afterRemoteWatchDelete = loadState(clock);
  assert.equal(
    afterRemoteWatchDelete.shipments.some((row) => row.identity.id === `watch:${watchUuid}`),
    false,
    "remote express_watch_feedback(deleted) removes local watch: row",
  );
  assert.equal(
    afterRemoteWatchDelete.watchFeedback?.find((f) => f.waybill === watchWaybill)?.action,
    "deleted",
  );

  // 6. Verify 409 endpoint_generation_conflict preserves baseRevision === 0 local unsynced edits!
  const snapshotBeforeConflict = readParcelCloudState(scope);
  const newEditId = workerUuidV5("parcel-metadata:", "SF999999999999");
  const withNewEdit = prepareParcelBatch(
    {
      ...snapshotBeforeConflict,
      edits: {
        [newEditId]: {
          mutationId: "33333333-4444-4555-8666-777777777777",
          recordId: newEditId,
          type: "express_metadata",
          editedAt: clock + 1,
          lifecycle: "active",
          historyAt: 0,
          payload: { waybill: "SF999999999999", anchorAt: clock - 10_000, productName: "未上云新件", productNameObservedAt: clock },
        },
      },
    },
    "44444444-5555-4666-8777-888888888888",
  );
  assert.ok(withNewEdit.batch);
  assert.equal(withNewEdit.batch.mutations[0].baseRevision, 0);
  const recovered = recoverParcelConflict(withNewEdit, withNewEdit.batch, {
    ok: false,
    error: "endpoint_generation_conflict",
    requestId: withNewEdit.batch.requestId,
    sequence: withNewEdit.batch.sequence,
    requestGeneration: withNewEdit.batch.generation,
    ownerId,
    endpointId,
  });
  assert.equal(recovered.session, undefined);
  assert.equal(recovered.edits[newEditId]?.requiresExisting, undefined, "baseRevision=0 edit must NOT be marked requiresExisting");
});

test("Task B #14: legibleCodeOnDark lifts dark tea/coffee brand codes to WCAG >= 4.5:1 while preserving hue", () => {
  for (const [brand, hex] of [
    ["泰柯茶园", "#41200D"],
    ["JPG 咖啡", "#6E261D"],
    ["煲珠公", "#3B3ADF"],
    ["茶颜悦色", "#AB1C31"],
  ] as const) {
    const lifted = legibleCodeOnDark(hex, 0x000000);
    const ratio = wcagContrast(lifted, 0x000000);
    assert.ok(ratio >= 4.5, `${brand} (${hex} -> ${lifted}) contrast ${ratio.toFixed(2)} must be >= 4.5`);
    assert.notEqual(lifted.toLowerCase(), "#ffffff", `${brand} preserves hue instead of jumping to pure white`);
  }
  assert.equal(legibleCodeOnDark("#ffd100", 0x000000), "#ffd100", "bright gold stays unchanged");
  assert.equal(legibleCodeOnDark("#ffffff", 0x000000), "#ffffff");
});

test("Task B #4, #5, #11, #15 & §9.5 #7 ②: HIG layout & Live Activity invariants", () => {
  const fabSource = readFileSync(new URL("../components/TabFloatingActionButton.tsx", import.meta.url), "utf8");
  const cardSource = readFileSync(new URL("../components/ParcelLiveActivityCard.tsx", import.meta.url), "utf8");
  assert.match(fabSource, /export const TAB_FAB_SCROLL_INSET = 92;/);
  assert.match(fabSource, /UIGlass\.regular\(\)\.interactive\(true\)/);
  assert.doesNotMatch(fabSource, /UIGlass\.clear\(\)/);
  assert.equal(EMPTY_WIDGET_TEXT_COLOR, "secondaryLabel");

  const compactSmall = smallWidgetLayout(148, 148);
  const regularSmall = smallWidgetLayout(170, 170);
  assert.equal(compactSmall.outerPadding, 10);
  assert.equal(compactSmall.pillHeight, 30);
  assert.equal(regularSmall.outerPadding, 12);
  assert.equal(regularSmall.pillHeight, 32);

  // AGENTS.md §15: visual card & capsule height contract remains untouched
  assert.match(cardSource, /\bheight:\s*132,/);
  assert.match(cardSource, /\bcapsuleHeight:\s*35,/);
  assert.match(cardSource, /minHeight:\s*44/);

  // §9.5 #7 ②: whitespace-only meal code trims cleanly before fallback
  assert.equal(
    parcelActivityCompactText({ kind: "meal", code: "   ", title: "幽兰拿铁", mealBrandId: "chayanyuese" }),
    "幽兰拿铁",
  );
  assert.equal(
    parcelActivityCompactText({ kind: "meal", code: "   ", title: "美式咖啡", mealBrandId: "ruixing" }),
    "待取餐",
  );
});

test("Residual fixes: §9.2 #8 rebase + deferred route, §9.2 #11 QR downscale, §9.5 #1 90d/500 pruning, M-08 backoff", async () => {
  // 1. §9.5 #1: prunePickupCodeRecords keeps active items, drops >90d history, caps history at 500
  const baseNow = NOW;
  const activeItem = { id: "active-1", kind: "pickup" as const, platform: "cainiao" as const, code: "1-1-1", capturedAtMs: baseNow - 200 * 86_400_000 };
  const expired91d = { id: "old-91d", kind: "pickup" as const, platform: "cainiao" as const, code: "2-2-2", capturedAtMs: baseNow - 95 * 86_400_000, completedAtMs: baseNow - 91 * 86_400_000 };
  const history505 = Array.from({ length: 505 }, (_, i) => ({
    id: `hist-${i}`,
    kind: "pickup" as const,
    platform: "fengchao" as const,
    code: `C-${i}`,
    capturedAtMs: baseNow - (i + 1) * 1_000,
    completedAtMs: baseNow - (i + 1) * 1_000,
  }));
  const pruned = prunePickupCodeRecords([activeItem, expired91d, ...history505], baseNow)!;
  assert.equal(pruned.length, 1 + 500);
  assert.equal(pruned[0]?.id, "active-1", "active pickup code never expires by 90d history TTL");
  assert.equal(pruned.some((item) => item.id === "old-91d"), false, ">90d completed item pruned");
  assert.equal(pruned.some((item) => item.id === "hist-504"), false, "oldest beyond 500 cap pruned");

  // 2. §9.2 #8: rebaseIndependentTimelines + publishDeferredRoutes preserves carrier recognition & route when user edits note concurrently
  const shipmentId = "interface5:manual:YT777788889999";
  const initialShipment = {
    identity: {
      id: shipmentId,
      bindingSource: "interface5" as const,
      sourceOwner: "manual",
      sourceId: "YT777788889999",
      courierCode: "",
      companyName: "",
      manuallyAdded: true,
      createdAtMs: baseNow - 10_000,
    },
    timeline: {
      provider: "v6_query",
      waybill: "YT777788889999",
      courierCode: "",
      companyName: "",
      semantic: "UNKNOWN" as const,
      structuredStatus: false,
      statusEventAtMs: null,
      latestTimeText: "",
      latestDetail: "",
      successAtMs: baseNow - 10_000,
      tracks: [],
    },
    route: null,
    updatedAtMs: baseNow - 10_000,
  };
  const baseState = saveState({ ...emptyState(), shipments: [initialShipment] }, baseNow - 10_000);
  // User edits note + product name while full refresh is in flight
  setShipmentNote(baseState.shipments[0]!, "放门口地垫", baseNow - 5_000);
  setShipmentProductName(loadState(baseNow - 5_000).shipments[0]!, "咖啡豆", baseNow - 4_000);

  // Full refresh recognizes YTO carrier + stages a deferred Web route
  const routeMutations = new Map();
  const refreshedIncoming = deferIncomingRoute(
    {
      ...baseState.shipments[0]!,
      identity: {
        ...baseState.shipments[0]!.identity,
        courierCode: "YTO",
        companyName: "圆通速递",
        carrierIsBuiltIn: true,
        carrierKuaidi100Code: "yuantong",
      },
      manualTimelines: [{
        provider: "v6_query",
        waybill: "YT777788889999",
        courierCode: "YTO",
        companyName: "圆通速递",
        semantic: "TRANSIT",
        structuredStatus: true,
        statusEventAtMs: baseNow - 2_000,
        latestTimeText: "2026-11-26 09:50:00",
        latestDetail: "圆通揽收",
        successAtMs: baseNow - 2_000,
        tracks: [{ timeText: "2026-11-26 09:50:00", timeMs: baseNow - 2_000, detail: "圆通揽收", statusCode: "TRANSIT", raw: {} }],
      }],
      route: { kind: "web", source: "interface5" },
      updatedAtMs: baseNow - 1_000,
    },
    {
      ...baseState.shipments[0]!,
      route: { kind: "web", source: "interface5" },
    },
    "https://m.kuaidi100.com/result.jsp?nu=YT777788889999",
    baseNow,
    routeMutations,
  );
  const committed = commitRefreshState(
    baseState,
    { ...baseState, shipments: [refreshedIncoming] },
    "interface5",
    baseNow,
  );
  assert.equal(committed.applied, true);
  const published = publishDeferredRoutes(committed.state, routeMutations, baseNow, committed);
  const mergedRow = published.shipments.find((s) => s.identity.id === shipmentId)!;
  assert.equal(mergedRow.identity.courierCode, "YTO", "carrier recognition preserved across concurrent user note edit");
  assert.equal(mergedRow.note, "放门口地垫", "user note preserved");
  assert.equal(mergedRow.platformFields?.manualTitle, "咖啡豆", "user manualTitle preserved");
  assert.deepEqual(mergedRow.route, { kind: "web", source: "interface5" }, "deferred route pointer published despite rebase updatedAtMs bump");
  assert.equal(
    loadShipmentRoute(shipmentId, "interface5", baseNow, "web"),
    "https://m.kuaidi100.com/result.jsp?nu=YT777788889999",
  );

  // 3. §9.2 #11: readMealQRs downscales oversized 3.6MP image via preparingThumbnail before pixel decode
  let thumbnailRequested: { width: number; height: number } | undefined;
  const fakeLargeImage = {
    width: 1320,
    height: 2868,
    scale: 1,
    preparingThumbnail(size: { width: number; height: number }) {
      thumbnailRequested = size;
      return {
        width: size.width,
        height: size.height,
        scale: 1,
        toPixels: () => ({ width: size.width, height: size.height, data: new Uint8Array(size.width * size.height * 4) }),
      } as unknown as UIImage;
    },
    toPixels: () => assert.fail("full 3.6MP pixel buffer should not be decoded when preparingThumbnail succeeds"),
  } as unknown as UIImage;
  assert.deepEqual(readMealQRs(fakeLargeImage), []);
  assert.ok(thumbnailRequested && Math.max(thumbnailRequested.width, thumbnailRequested.height) <= 1440);

  // 4. M-08: cross-process mealRulesRetryNotBeforeMs survives process reset within 30s window & skips unchanged table write
  memory.clear();
  resetCarrierAuthorityRuntimeForTesting();
  saveGatewayToken("AbCdEfGh_123-456");
  const tablePayload = {
    schemaVersion: 2,
    version: "carrier-m08-test",
    source: "m08-test",
    entries: activeCarrierQueryRecords().map((r) => ({
      standardCode: r.standardCode,
      displayName: r.displayName,
      kuaidi100Code: r.kuaidi100Code,
      kuaidi100CodeAliases: r.kuaidi100CodeAliases,
      hotline: r.hotline,
      iconKey: r.iconKey,
      requiresPhoneTail: r.requiresPhoneTail,
      codeAliases: r.aliases,
      codePrefixAliases: r.codePrefixAliases,
      nameAliases: r.nameAliases,
    })),
  };
  let rulePosts = 0;
  const rulesLessPost = {
    post: async () => {
      rulePosts++;
      return tablePayload;
    },
  };
  assert.equal(await refreshCarrierAuthorityIfNeeded(clock, rulesLessPost), true);
  assert.equal(rulePosts, 1);
  // Simulate second process (Widget / Shortcut) 5 seconds later (< 30s backoff)
  clock += 5_000;
  resetCarrierAuthorityRuntimeForTesting();
  assert.equal(loadCarrierAuthorityCache(clock), true);
  assert.equal(await ensureMealRules(undefined, rulesLessPost), null);
  assert.equal(rulePosts, 1, "second process within 30s respects persisted mealRulesRetryNotBeforeMs");
  // After remaining 25s elapses, retry proceeds
  clock += MEAL_RULES_RETRY_BACKOFF_MS;
  assert.equal(await ensureMealRules(undefined, rulesLessPost), null);
  assert.equal(rulePosts, 2);
});
