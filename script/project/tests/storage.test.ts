import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type {
  AppState,
  BindingSource,
  PendingManualQuery,
  Shipment,
  StatusSemantic,
} from "../models";
import type { AccountParcelDto } from "../services/account-parser";

const NOW = Date.UTC(2026, 7, 26, 6, 0, 0);
const STATE_KEY = "pipi_deliveries_state_v1";
const ROUTES_KEY = "keychain:pipi_deliveries_routes_v1";
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const memory = new Map<string, unknown>();
let storageSetReturnsVoid = false;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

Object.assign(globalThis, {
  Path: {
    join(...parts: string[]) {
      return parts.join("/").replace(/\/{2,}/g, "/");
    },
  },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    createDirectorySync() {},
    existsSync(path: string) {
      return memory.has(`file:${path}`);
    },
    isFileSync(path: string) {
      return memory.has(`file:${path}`);
    },
    readAsStringSync(path: string) {
      const value = memory.get(`file:${path}`);
      if (typeof value !== "string") throw new Error("missing file");
      return value;
    },
    removeSync(path: string) {
      memory.delete(`file:${path}`);
    },
    renameSync(path: string, newPath: string) {
      const key = `file:${path}`;
      const destination = `file:${newPath}`;
      const value = memory.get(key);
      if (typeof value !== "string" || memory.has(destination)) {
        throw new Error("rename rejected");
      }
      memory.set(destination, value);
      memory.delete(key);
    },
    writeAsStringSync(path: string, value: string) {
      memory.set(`file:${path}`, value);
    },
  },
  Data: {
    fromIntArray(value: number[]) {
      return String.fromCharCode(...value);
    },
    fromString(value: string) {
      return value;
    },
    fromRawString(value: string) {
      return value;
    },
  },
  Crypto: {
    sha256(value: string) {
      const hex = sha256(value);
      return { toHexString: () => hex };
    },
  },
  Storage: {
    get<T>(key: string): T | null {
      return (memory.get(key) as T | undefined) ?? null;
    },
    set(key: string, value: unknown): boolean | void {
      memory.set(key, structuredClone(value));
      if (storageSetReturnsVoid) return;
      return true;
    },
  },
  Keychain: {
    get(key: string): string | null {
      return (memory.get(`keychain:${key}`) as string | undefined) ?? null;
    },
    set(key: string, value: string): boolean {
      memory.set(`keychain:${key}`, value);
      return true;
    },
    remove(key: string): void {
      memory.delete(`keychain:${key}`);
    },
  },
});

const {
  addBinding,
  emptyState,
  forceCompleteShipment,
  commitRefreshState,
  commitRoutePointers,
  commitTargetShipmentRefresh,
  loadState,
  loadWidgetSnapshot,
  removeBinding,
  removePendingQuery,
  removeShipment,
  saveState,
  upsertPendingQuery,
  upsertShipment,
  visibleShipments,
} = await import("../services/storage");
const {
  commitShipmentRouteMutations,
  loadShipmentRoute,
  saveShipmentRoute,
} = await import("../services/routes");
const { prepareManualPreview } = await import("../services/manual-preview");
const {
  shipmentPresentationStatus,
  shouldRefreshShipment,
} = await import("../services/status");
const {
  applyAccountShipment,
  applyManualShipment,
  observeQualifiedAutomaticShipment,
  releaseManualRefreshLease,
  selectShipmentDetailTimeline,
  shouldScheduleManualRefresh,
} = await import("../services/shipment-policy");
const {
  applyAccountOrderProjectionToOwner,
  commitManualShipmentPreview,
  continueManualShipmentPreview,
  mergeAccountParcel,
  queryManualShipmentPreview,
} = await import("../services/sync");

function shipment(input: {
  id: string;
  source: BindingSource | null;
  phone?: string;
  manuallyAdded?: boolean;
  semantic?: StatusSemantic;
}): Shipment {
  const semantic = input.semantic || "TRANSIT";
  return {
    identity: {
      id: input.id,
      bindingSource: input.source,
      sourceOwner: input.manuallyAdded ? "manual" : "account",
      sourceId: `owner:${input.id}`,
      phoneTail: input.phone?.slice(-4) || "",
      phone: input.phone,
      courierCode: "TEST",
      rawCourierCode: "TEST",
      companyName: `Carrier ${input.id}`,
      manuallyAdded: Boolean(input.manuallyAdded),
      createdAtMs: NOW - 60_000,
    },
    timeline: {
      provider: "test",
      waybill: `WB${input.id}`,
      courierCode: "TEST",
      companyName: `Carrier ${input.id}`,
      semantic,
      statusEventAtMs: NOW - 60_000,
      latestTimeText: "2026-08-26 13:59:00",
      latestDetail: semantic,
      tracks: [{
        timeText: "2026-08-26 13:59:00",
        timeMs: NOW - 60_000,
        detail: semantic,
        statusCode: "",
        raw: {},
      }],
      successAtMs: NOW,
    },
    updatedAtMs: NOW,
  };
}

function pending(input: {
  id: string;
  source?: BindingSource;
  waybill?: string;
  phoneTail?: string;
  createdAtMs?: number;
  attempts?: number;
}): PendingManualQuery {
  return {
    id: input.id,
    source: input.source || "interface5",
    waybill: input.waybill || `WB${input.id}`,
    phoneTail: input.phoneTail || "",
    courierCode: "TEST",
    rawCourierCode: "TEST_RAW",
    companyName: "Carrier",
    createdAtMs: input.createdAtMs ?? NOW - 1,
    lastAttemptAtMs: 0,
    attempts: input.attempts ?? 0,
  };
}

function storedState(state: unknown, schema: 1 | 2): unknown {
  return {
    schema,
    checksum: sha256(JSON.stringify(state)),
    state,
  };
}

// A route-bearing account row can arrive before its timeline qualifies for ownership. The route
// sidecar and state pointer still have to enter the same deferred publication transaction.
memory.clear();
const unclaimedRouteMutations = new Map();
const unclaimedRouteParcel = {
  source: "interface5",
  ownerId: "ROUTEFIRST123456",
  waybill: "ROUTEFIRST123456",
  orderId: "",
  accountOrder: false,
  courierCode: "ZTO",
  rawCourierCode: "ZTO",
  rawCompanyName: "中通快递",
  companyName: "中通快递",
  sourceProvider: "CaiNiao",
  sourceStateCode: "104",
  sourceStateText: "运输中",
  semantic: "TRANSIT",
  receiverPhone: "13800138000",
  senderPhone: "",
  latestTimeText: "",
  latestDetail: "",
  tracks: [],
  routeUrl: "https://page.cainiao.com/detail?opaque=route-first",
  projectionUrl: "",
} satisfies AccountParcelDto;
const unclaimedRouteShipments = mergeAccountParcel(
  emptyState(),
  [],
  unclaimedRouteParcel,
  ["13800138000"],
  "interface5",
  NOW,
  unclaimedRouteMutations,
);
assert.equal(
  unclaimedRouteShipments[0]?.automaticOwnership?.ownerSource,
  null,
);
assert.equal(
  unclaimedRouteMutations.size,
  1,
  "an unclaimed row must still queue its own trusted route sidecar",
);
assert.equal(
  unclaimedRouteShipments[0]?.route,
  null,
  "the route pointer must remain unpublished until its sidecar commits",
);
assert.deepEqual(
  [...unclaimedRouteMutations.values()].map((mutation) => ({
    kind: mutation.kind,
    targetId: mutation.targetId,
    source: mutation.source,
  })),
  [{
    kind: "save",
    targetId: "interface5:account:ROUTEFIRST123456",
    source: "interface5",
  }],
);

const unclaimedWithoutRouteMutations = new Map();
const unclaimedWithoutRoute = mergeAccountParcel(
  emptyState(),
  [],
  { ...unclaimedRouteParcel, routeUrl: "" },
  ["13800138000"],
  "interface5",
  NOW,
  unclaimedWithoutRouteMutations,
);
assert.equal(unclaimedWithoutRouteMutations.size, 0);
assert.equal(unclaimedWithoutRoute[0]?.route, null);

const establishedParcel = {
  ...unclaimedRouteParcel,
  routeUrl: "",
  latestTimeText: "2026-08-26 14:00:00",
  latestDetail: "owner timeline",
  tracks: [{
    timeText: "2026-08-26 14:00:00",
    detail: "owner timeline",
    statusCode: "104",
  }],
};
const establishedOwner = mergeAccountParcel(
  emptyState(),
  [],
  establishedParcel,
  ["13800138000"],
  "interface5",
  NOW,
  new Map(),
)[0]!;
assert.equal(
  establishedOwner.automaticOwnership?.ownerBindingIdentity,
  "phone:13800138000",
);
const candidateRouteMutations = new Map();
const afterDifferentBindingCandidate = mergeAccountParcel(
  emptyState(),
  [establishedOwner],
  {
    ...establishedParcel,
    receiverPhone: "13900139000",
    routeUrl: "https://page.cainiao.com/detail?opaque=other-binding",
  },
  ["13800138000", "13900139000"],
  "interface5",
  NOW + 1,
  candidateRouteMutations,
);
assert.equal(candidateRouteMutations.size, 0);
assert.equal(
  afterDifferentBindingCandidate[0]?.automaticOwnership?.ownerBindingIdentity,
  "phone:13800138000",
  "a different binding candidate must not publish over the established owner",
);

// A v1 manual-only state must migrate in memory without losing shipments.
const legacyShipment = shipment({ id: "legacy", source: null, manuallyAdded: true });
delete (legacyShipment.identity as { bindingSource?: BindingSource | null })
  .bindingSource;
const legacyState = {
  version: 1,
  revision: 7,
  updatedAtMs: NOW - 5_000,
  shipments: [legacyShipment],
};
memory.set(STATE_KEY, storedState(legacyState, 1));
const migrated = loadState(NOW);
assert.equal(migrated.version, 2);
assert.equal(migrated.revision, 7);
assert.equal(migrated.activeSource, "interface5");
assert.deepEqual(migrated.bindings, []);
assert.deepEqual(migrated.pendingQueries, []);
assert.equal(migrated.shipments[0]?.identity.id, "interface5:manual:WBLEGACY");
assert.equal(visibleShipments(migrated).length, 1);

// Ownership migration first drops the retired vivo JingDong-source row, then
// freezes surviving automatic rows without assigning an owner to pure manual rows.
memory.clear();
const retiredVivoJingDong = shipment({ id: "vivo-jd", source: null });
retiredVivoJingDong.identity.sourceOwner = "vivo:parcel";
retiredVivoJingDong.identity.sourceProvider = "JingDong";
retiredVivoJingDong.timeline.provider = "vivo";
retiredVivoJingDong.sourceTimeline = retiredVivoJingDong.timeline;
const legacyAutomatic = shipment({ id: "legacy-auto", source: "interface5" });
legacyAutomatic.timeline.provider = "interface5";
legacyAutomatic.sourceTimeline = legacyAutomatic.timeline;
const migrationManual = shipment({
  id: "migration-manual",
  source: "interface5",
  manuallyAdded: true,
});
const ownershipMigrated = saveState({
  ...emptyState(),
  shipments: [retiredVivoJingDong, legacyAutomatic, migrationManual],
}, NOW);
assert.equal(
  ownershipMigrated.shipments.some(
    (item) => item.identity.sourceOwner === "vivo:parcel",
  ),
  false,
);
assert.equal(
  ownershipMigrated.shipments.find(
    (item) => item.identity.id === "legacy-auto",
  )?.automaticOwnership?.ownerSource,
  "interface5",
);
assert.equal(
  ownershipMigrated.shipments.find((item) => item.identity.manuallyAdded)
    ?.automaticOwnership,
  undefined,
);

// Per-source qualified observations survive durable save/load unchanged.
const persistedA = shipment({ id: "owner-persist-a", source: null });
persistedA.identity.sourceOwner = "synthetic-a:parcel";
persistedA.identity.rawCourierCode = "TEST";
persistedA.timeline.provider = "synthetic-a";
persistedA.sourceTimeline = persistedA.timeline;
const persistedB = shipment({ id: "owner-persist-b", source: null });
persistedB.identity.sourceOwner = "synthetic-b:parcel";
persistedB.identity.rawCourierCode = "TEST";
persistedB.timeline = {
  ...persistedB.timeline,
  provider: "synthetic-b",
  waybill: persistedA.timeline.waybill,
};
persistedB.sourceTimeline = persistedB.timeline;
const persistedOwner = observeQualifiedAutomaticShipment(
  undefined,
  persistedA,
  "synthetic-a",
  NOW + 1,
);
const persistedCandidate = observeQualifiedAutomaticShipment(
  persistedOwner,
  persistedB,
  "synthetic-b",
  NOW + 2,
);
saveState({ ...emptyState(), shipments: [persistedCandidate] }, NOW + 2);
memory.delete(STATE_KEY);
const restoredOwnership = loadState(NOW + 3).shipments[0]?.automaticOwnership;
assert.equal(restoredOwnership?.ownerSource, "synthetic-a");
assert.deepEqual(
  new Set(restoredOwnership?.observations.map((item) => item.source)),
  new Set(["synthetic-a", "synthetic-b"]),
);

// Script upgrades reuse the same durable state. Each local provider keeps its
// own authority, and a later response merges into that provider without
// discarding cached observations from the other local sources.
memory.clear();
const cachedLocal = shipment({
  id: "local-cache-upgrade",
  source: "interface5",
  manuallyAdded: true,
});
cachedLocal.identity.sourceId = "LOCALCACHE123456";
cachedLocal.timeline = {
  ...cachedLocal.timeline,
  provider: "moto",
  waybill: "LOCALCACHE123456",
  latestDetail: "moto older",
  tracks: [{
    ...cachedLocal.timeline.tracks[0]!,
    detail: "moto older",
  }],
};
cachedLocal.sourceTimeline = null;
cachedLocal.manualTimelines = [
  cachedLocal.timeline,
  {
    ...cachedLocal.timeline,
    provider: "meizu",
    latestDetail: "meizu cached",
    tracks: [{
      ...cachedLocal.timeline.tracks[0]!,
      detail: "meizu cached",
    }],
  },
  {
    ...cachedLocal.timeline,
    provider: "oppo",
    latestDetail: "oppo cached",
    tracks: [{
      ...cachedLocal.timeline.tracks[0]!,
      detail: "oppo cached",
    }],
  },
];
const incomingMotoTimeline: Shipment["timeline"] = {
  ...cachedLocal.timeline,
  latestTimeText: "2026-08-26 14:00:00",
  latestDetail: "moto newer",
  tracks: [{
    timeText: "2026-08-26 14:00:00",
    timeMs: NOW,
    detail: "moto newer",
    statusCode: "",
    raw: {},
  }],
  successAtMs: NOW + 1,
};
const mergedLocal = applyManualShipment(cachedLocal, {
  ...cachedLocal,
  timeline: incomingMotoTimeline,
  manualTimelines: [incomingMotoTimeline],
}, NOW + 1);
saveState({ ...emptyState(), shipments: [mergedLocal] }, NOW + 1);
memory.delete(STATE_KEY);
const restoredLocal = loadState(NOW + 2).shipments[0]!;
assert.deepEqual(
  new Set(restoredLocal.manualTimelines?.map((item) => item.provider)),
  new Set(["moto", "meizu", "oppo"]),
);
const restoredMoto = restoredLocal.manualTimelines?.find(
  (item) => item.provider === "moto",
);
assert.deepEqual(
  new Set(restoredMoto?.tracks.map((track) => track.detail)),
  new Set(["moto older", "moto newer"]),
);

// Every manual provider owns its raw carrier/protocol code independently. The
// selected package must not erase losing providers, and none may rewrite the
// automatic owner's source cpCode across a durable reload.
memory.clear();
const automaticRawOwner = shipment({
  id: "automatic-owner-raw-sidecars",
  source: "interface5",
});
automaticRawOwner.identity.rawCourierCode = "OWNER_SOURCE_CP";
automaticRawOwner.sourceTimeline = automaticRawOwner.timeline;
const rawSidecarIdentities = [
  {
    provider: "route",
    rawCourierCode: "KYE",
    courierCode: "KYSY",
    companyName: "跨越速运",
  },
  {
    provider: "local",
    rawCourierCode: "JDVD",
    courierCode: "JD",
    companyName: "京东快递",
  },
  {
    provider: "kuaidi100_h5",
    rawCourierCode: "debangwuliu",
    courierCode: "DBL",
    companyName: "德邦快递",
  },
  {
    provider: "fallback",
    rawCourierCode: "ZMKM",
    courierCode: "DANNIAO",
    companyName: "丹鸟速递",
  },
] as const;
const rawSidecarCodes = new Map(
  rawSidecarIdentities.map(({ provider, rawCourierCode }) => [provider, rawCourierCode]),
);
const rawSidecars = rawSidecarIdentities.map((identity, index) => ({
  ...automaticRawOwner.timeline,
  ...identity,
  complete: identity.provider === "kuaidi100_h5" || identity.provider === "fallback",
  latestTimeText: `2026-08-26 ${String(10 + index).padStart(2, "0")}:00:00`,
  latestDetail: `${identity.provider} raw sidecar`,
  tracks: [{
    timeText: `2026-08-26 ${String(10 + index).padStart(2, "0")}:00:00`,
    timeMs: NOW + index,
    detail: `${identity.provider} raw sidecar`,
    statusCode: "",
    raw: identity.provider === "kuaidi100_h5"
      ? { _pipiKuaidi100Com: identity.rawCourierCode }
      : {},
  }],
  successAtMs: NOW + index,
}));
const ownerWithRawSidecars = applyManualShipment(automaticRawOwner, {
  ...automaticRawOwner,
  identity: {
    ...automaticRawOwner.identity,
    rawCourierCode: "WINNING_PROVIDER_MUST_NOT_REPLACE_OWNER",
  },
  timeline: rawSidecars[2]!,
  manualTimelines: rawSidecars,
}, NOW + 10);
saveState({ ...emptyState(), shipments: [ownerWithRawSidecars] }, NOW + 10);
memory.delete(STATE_KEY);
const restoredRawSidecars = loadState(NOW + 11).shipments[0]!;
assert.equal(restoredRawSidecars.identity.rawCourierCode, "OWNER_SOURCE_CP");
assert.deepEqual(
  new Map(restoredRawSidecars.manualTimelines?.map((timeline) => [
    timeline.provider,
    timeline.rawCourierCode,
  ])),
  rawSidecarCodes,
);

// A JingDong order may project after another automatic source already owns the
// real waybill. Projection converges both rows under that existing owner while
// retaining the projected package as its own source observation.
const projectedWaybill = "JDPROJECTEDREAL001";
const projectedPhone = "13800138000";
const existingRealOwner = shipment({
  id: "interface6:account:JDPROJECTEDREAL001",
  source: "interface6",
  phone: projectedPhone,
});
existingRealOwner.identity.rawCourierCode = "JD";
existingRealOwner.identity.courierCode = "JD";
existingRealOwner.identity.companyName = "京东快递";
existingRealOwner.timeline = {
  ...existingRealOwner.timeline,
  provider: "interface6",
  waybill: projectedWaybill,
  courierCode: "JD",
  companyName: "京东快递",
};
existingRealOwner.sourceTimeline = existingRealOwner.timeline;
const orderOwnerId = "ORDERPROJECT001";
const existingOrderOwner = shipment({
  id: `interface5:account:${orderOwnerId}`,
  source: "interface5",
  phone: projectedPhone,
});
existingOrderOwner.identity.sourceOwner = "interface5:order";
existingOrderOwner.identity.sourceId = orderOwnerId;
existingOrderOwner.identity.orderId = orderOwnerId;
existingOrderOwner.identity.accountOrder = true;
existingOrderOwner.identity.sourceProvider = "JingDong";
existingOrderOwner.identity.rawCourierCode = "JD";
existingOrderOwner.identity.courierCode = "JD";
existingOrderOwner.identity.companyName = "京东购物";
existingOrderOwner.timeline = {
  ...existingOrderOwner.timeline,
  provider: "interface5",
  waybill: orderOwnerId,
  courierCode: "JD",
  companyName: "京东购物",
  semantic: "ORDERED",
};
existingOrderOwner.sourceTimeline = existingOrderOwner.timeline;
const projectionParcel = {
  source: "interface5",
  ownerId: orderOwnerId,
  waybill: projectedWaybill,
  orderId: orderOwnerId,
  accountOrder: true,
  courierCode: "JD",
  rawCourierCode: "JD",
  companyName: "京东快递",
  sourceProvider: "JingDong",
  sourceStateCode: "104",
  sourceStateText: "运输中",
  semantic: "TRANSIT",
  receiverPhone: projectedPhone,
  senderPhone: "",
  latestTimeText: "2026-08-30 16:00:00",
  latestDetail: "projection package",
  tracks: [{
    timeText: "2026-08-30 16:00:00",
    detail: "projection package",
    statusCode: "104",
  }],
  routeUrl: "",
  projectionUrl: "",
} satisfies AccountParcelDto;
const completedOrderBesideCanonicalPeer = structuredClone(existingOrderOwner);
completedOrderBesideCanonicalPeer.statusPresentation = {
  scope: "ORDER",
  semantic: "COMPLETED",
  text: "已完成",
};
const targetedProjection = applyAccountOrderProjectionToOwner(
  [structuredClone(existingRealOwner), structuredClone(existingOrderOwner)],
  projectionParcel,
  [projectedPhone],
  NOW + 2,
  new Map(),
);
assert.equal(
  targetedProjection.length,
  2,
  "the projection commit must keep the exact order owner until its mapping is durable",
);
assert.equal(
  targetedProjection.find((item) => item.identity.id === existingOrderOwner.identity.id)
    ?.identity.projectedWaybill,
  projectedWaybill,
  "the captured waybill must be written onto the order owner instead of only an absorbable peer",
);
const memoryBeforeProjectionPersistence = new Map(memory);
memory.clear();
const persistedTargetedProjection = saveState({
  ...emptyState(),
  bindings: [{
    source: "interface5",
    phone: projectedPhone,
    boundAtMs: NOW,
  }],
  shipments: targetedProjection,
}, NOW + 2);
assert.equal(
  persistedTargetedProjection.shipments.find(
    (item) => item.identity.id === existingOrderOwner.identity.id,
  )?.identity.projectedWaybill,
  projectedWaybill,
  "the captured waybill must survive the durable state normalization boundary",
);
memory.clear();
const projectionReservationSeed = structuredClone(existingOrderOwner);
projectionReservationSeed.identity.orderProjectionRetry = {
  routeHash: "a".repeat(64),
  attemptId: "projection-test-attempt",
  attemptExpiresAtMs: NOW + 60_000,
};
const projectionReservationState = saveState({
  ...emptyState(),
  bindings: [{
    source: "interface5",
    phone: projectedPhone,
    boundAtMs: NOW,
  }],
  shipments: [projectionReservationSeed],
}, NOW + 3);
const projectionCommitCandidate = {
  ...projectionReservationState,
  shipments: applyAccountOrderProjectionToOwner(
    projectionReservationState.shipments,
    projectionParcel,
    [projectedPhone],
    NOW + 4,
    new Map(),
  ),
};
const committedTargetedProjection = commitRefreshState(
  projectionReservationState,
  projectionCommitCandidate,
  "interface5",
  NOW + 4,
  { isCurrent: () => true, acceptsState: () => true },
);
assert.equal(committedTargetedProjection.applied, true);
assert.equal(
  committedTargetedProjection.state.shipments.find(
    (item) => item.identity.id === existingOrderOwner.identity.id,
  )?.identity.projectedWaybill,
  projectedWaybill,
  "the projection-specific refresh commit must durably advance the reserved order owner",
);

// Signed-row retention and projection retention are different lifecycles. The
// UI may hide an old signed shipment, but the durable order mapping must remain
// available so a later account summary cannot recreate the order number or
// schedule another projection WebView.
memory.clear();
const oldSignedAt = NOW - 8 * 24 * 60 * 60 * 1_000;
const oldSignedProjection = structuredClone(existingOrderOwner);
oldSignedProjection.identity.projectedWaybill = projectedWaybill;
oldSignedProjection.identity.courierCode = "JD";
oldSignedProjection.identity.companyName = "京东快递";
oldSignedProjection.timeline = {
  ...oldSignedProjection.timeline,
  provider: "interface5",
  complete: true,
  structuredStatus: true,
  waybill: projectedWaybill,
  courierCode: "JD",
  companyName: "京东快递",
  semantic: "COMPLETED",
  statusEventAtMs: oldSignedAt,
  latestTimeText: "2026-08-18 14:00:00",
  latestDetail: "真实运单已签收",
  tracks: [{
    timeText: "2026-08-18 14:00:00",
    timeMs: oldSignedAt,
    detail: "真实运单已签收",
    statusCode: "107",
    raw: {},
  }],
  successAtMs: oldSignedAt,
};
oldSignedProjection.sourceTimeline = oldSignedProjection.timeline;
oldSignedProjection.updatedAtMs = oldSignedAt;
const archivedProjectionState = saveState({
  ...emptyState(),
  bindings: [{
    source: "interface5",
    phone: projectedPhone,
    boundAtMs: NOW - 30 * 24 * 60 * 60 * 1_000,
  }],
  shipments: [oldSignedProjection],
}, NOW);
assert.equal(
  archivedProjectionState.shipments[0]?.identity.projectedWaybill,
  projectedWaybill,
  "an old signed row must retain its durable order-to-waybill authority",
);
assert.equal(
  visibleShipments(archivedProjectionState, NOW).length,
  0,
  "an old signed projection must remain outside the visible delivery list",
);
assert.equal(
  loadWidgetSnapshot(NOW).totalCount,
  0,
  "an archived projection authority must not count as a current delivery",
);
const completedOrderSummary = {
  ...projectionParcel,
  waybill: orderOwnerId,
  semantic: "ORDERED",
  sourceStateCode: "101",
  sourceStateText: "订单已完成",
  normalizedStatusScope: "ORDER",
  normalizedStatusSemantic: "COMPLETED",
  normalizedStatusText: "已完成",
  latestTimeText: "2026-08-26 14:00:00",
  latestDetail: "订单已完成",
  tracks: [{
    timeText: "2026-08-26 14:00:00",
    detail: "订单已完成",
    statusCode: "101",
  }],
} satisfies AccountParcelDto;
const afterArchivedOrderSummary = saveState({
  ...archivedProjectionState,
  shipments: mergeAccountParcel(
    archivedProjectionState,
    archivedProjectionState.shipments,
    completedOrderSummary,
    [projectedPhone],
    "interface5",
    NOW + 1,
    new Map(),
  ),
}, NOW + 1);
assert.equal(
  afterArchivedOrderSummary.shipments[0]?.identity.projectedWaybill,
  projectedWaybill,
  "a later completed-order summary must never roll a durable projection back to its order id",
);
assert.equal(afterArchivedOrderSummary.shipments[0]?.statusPresentation, undefined);
assert.equal(afterArchivedOrderSummary.shipments[0]?.timeline.semantic, "COMPLETED");
assert.equal(visibleShipments(afterArchivedOrderSummary, NOW + 1).length, 0);
const rawCompletedRollback = structuredClone(existingOrderOwner);
rawCompletedRollback.statusPresentation = {
  scope: "ORDER",
  semantic: "COMPLETED",
  text: "已完成",
};
rawCompletedRollback.updatedAtMs = NOW + 2;
const screenedRawRollback = saveState({
  ...afterArchivedOrderSummary,
  shipments: [rawCompletedRollback],
}, NOW + 2);
assert.equal(
  screenedRawRollback.shipments[0]?.identity.projectedWaybill,
  projectedWaybill,
  "the durable write boundary must reject a direct projected-waybill rollback",
);
assert.equal(screenedRawRollback.shipments[0]?.statusPresentation, undefined);
assert.equal(screenedRawRollback.shipments[0]?.timeline.semantic, "COMPLETED");
memory.clear();
for (const [key, value] of memoryBeforeProjectionPersistence) {
  memory.set(key, value);
}
const screenedCanonicalPeerProjection = mergeAccountParcel(
  emptyState(),
  [existingRealOwner, completedOrderBesideCanonicalPeer],
  projectionParcel,
  [projectedPhone],
  "interface5",
  NOW + 3,
  new Map(),
);
assert.equal(screenedCanonicalPeerProjection.length, 1);
assert.equal(
  screenedCanonicalPeerProjection[0]?.automaticOwnership?.observations.find(
    (observation) => observation.source === "interface5",
  )?.identity.projectedWaybill,
  projectedWaybill,
  "a completed order fallback must still converge on its real waybill",
);
assert.equal(
  screenedCanonicalPeerProjection[0]?.timeline.provider,
  "interface6",
  "the established canonical owner remains authoritative",
);
const projectionWithoutRawCarrier = {
  ...projectionParcel,
  rawCourierCode: "",
  rawCompanyName: "",
} satisfies AccountParcelDto;
const retainedProjectionWithoutRawCarrier = mergeAccountParcel(
  emptyState(),
  [structuredClone(existingRealOwner), structuredClone(existingOrderOwner)],
  projectionWithoutRawCarrier,
  [projectedPhone],
  "interface5",
  NOW + 3,
  new Map(),
);
assert.equal(
  retainedProjectionWithoutRawCarrier[0]?.automaticOwnership?.observations.find(
    (observation) => observation.source === "interface5",
  )?.identity.projectedWaybill,
  projectedWaybill,
  "a captured JD projection must survive when the account snapshot omits raw carrier fields",
);
const convergedProjection = mergeAccountParcel(
  emptyState(),
  [existingRealOwner, existingOrderOwner],
  projectionParcel,
  [projectedPhone],
  "interface5",
  NOW + 4,
  new Map(),
);
assert.equal(convergedProjection.length, 1);
assert.equal(
  convergedProjection[0]?.automaticOwnership?.ownerSource,
  "interface6",
);
assert.equal(convergedProjection[0]?.identity.id, existingRealOwner.identity.id);
assert.equal(convergedProjection[0]?.timeline.provider, "interface6");
assert.deepEqual(
  new Set(
    convergedProjection[0]?.automaticOwnership?.observations.map(
      (observation) => observation.source,
    ),
  ),
  new Set(["interface5", "interface6"]),
);
assert.equal(
  convergedProjection[0]?.automaticOwnership?.observations.find(
    (observation) => observation.source === "interface5",
  )?.identity.projectedWaybill,
  projectedWaybill,
);

// Once an order projection is absorbed under the real-waybill owner, the next
// account-list summary must resolve that durable observation instead of adding
// the 16-digit order placeholder again.
const orderSummaryAfterProjection = {
  ...projectionParcel,
  waybill: orderOwnerId,
  courierCode: "JD",
  companyName: "京东购物",
  sourceStateCode: "101",
  sourceStateText: "订单已完成",
  semantic: "ORDERED",
  latestDetail: "订单已完成",
} satisfies AccountParcelDto;
const afterProjectedOrderSummary = mergeAccountParcel(
  emptyState(),
  convergedProjection,
  orderSummaryAfterProjection,
  [projectedPhone],
  "interface5",
  NOW + 5,
  new Map(),
);
assert.equal(
  afterProjectedOrderSummary.length,
  1,
  "the next account sync must not recreate the order-number row",
);
assert.equal(
  afterProjectedOrderSummary[0]?.automaticOwnership?.observations.find(
    (observation) => observation.source === "interface5",
  )?.identity.projectedWaybill,
  projectedWaybill,
  "the confirmed projection must remain the interface5 identity",
);
assert.equal(
  afterProjectedOrderSummary[0]?.automaticOwnership?.observations.find(
    (observation) => observation.source === "interface5",
  )?.sourceTimeline.semantic,
  "TRANSIT",
  "an order summary must not overwrite the absorbed source observation",
);
assert.equal(
  afterProjectedOrderSummary[0]?.automaticOwnership?.observations.find(
    (observation) => observation.source === "interface5",
  )?.sourceTimeline.latestDetail,
  "projection package",
);

for (const semantic of ["DELIVERY", "COMPLETED"] as const) {
  const shipmentTimeline = {
    ...existingOrderOwner.timeline,
    waybill: projectedWaybill,
    courierCode: "JD",
    companyName: "京东快递",
    semantic,
    statusEventAtMs: NOW + 5_000,
    latestTimeText: "2026-08-30 16:05:00",
    latestDetail: semantic,
    tracks: [{
      timeText: "2026-08-30 16:05:00",
      timeMs: NOW + 5_000,
      detail: semantic,
      statusCode: semantic === "COMPLETED" ? "111" : "107",
      raw: {},
    }],
    successAtMs: NOW + 5_000,
  } satisfies Shipment["timeline"];
  const projectedJingDongOwner: Shipment = {
    ...existingOrderOwner,
    identity: {
      ...existingOrderOwner.identity,
      projectedWaybill,
      courierCode: "JD",
      companyName: "京东快递",
      sourceProvider: "JingDong",
    },
    timeline: shipmentTimeline,
    sourceTimeline: shipmentTimeline,
    updatedAtMs: NOW + 5_000,
  };
  const newerOrderSummary = {
    ...orderSummaryAfterProjection,
    latestTimeText: "2026-08-30 16:10:00",
    tracks: [{
      timeText: "2026-08-30 16:10:00",
      detail: "订单已完成",
      statusCode: "101",
    }],
  } satisfies AccountParcelDto;
  const afterNewerOrderSummary = mergeAccountParcel(
    emptyState(),
    [projectedJingDongOwner],
    newerOrderSummary,
    [projectedPhone],
    "interface5",
    NOW + 10_000,
    new Map(),
  );
  assert.equal(afterNewerOrderSummary.length, 1);
  assert.equal(afterNewerOrderSummary[0]?.identity.projectedWaybill, projectedWaybill);
  assert.equal(
    afterNewerOrderSummary[0]?.timeline.semantic,
    semantic,
    `a newer ORDER summary must not overwrite projected ${semantic} logistics`,
  );
}

// A damaged primary envelope must never be exposed; the independently checked shared copy wins.
memory.clear();
memory.set(STATE_KEY, storedState(legacyState, 1));
loadState(NOW);
memory.set(STATE_KEY, { ...storedState(legacyState, 1), checksum: "bad" });
const recoveredLegacy = loadState(NOW);
assert.equal(recoveredLegacy.revision, 7);
assert.equal(
  recoveredLegacy.shipments[0]?.identity.id,
  "interface5:manual:WBLEGACY",
);

// Legacy mixed-source state converges once into the script's account namespace. Matching account
// rows absorb retired-source history, unmatched rows remain local history, and user-created rows,
// pending queries, provider authority, and valid route pointers remain intact.
memory.clear();
const source6 = shipment({ id: "source6", source: "interface6" });
const source5 = shipment({ id: "source5", source: "interface5" });
const source6Only = shipment({ id: "source6-only", source: "interface6" });
const manual6 = shipment({ id: "manual6", source: "interface6", manuallyAdded: true });
const manual5 = shipment({ id: "manual5", source: "interface5", manuallyAdded: true });
for (const value of [source6, source5, source6Only, manual6, manual5]) {
  value.identity.sourceProvider = "CaiNiao";
}
source6.timeline.provider = "interface6";
source6.timeline.waybill = "SHAREDACCOUNT123";
source6.sourceTimeline = source6.timeline;
source6.manualTimelines = [{
  ...source6.timeline,
  provider: "kuaidi100",
  latestDetail: "Cached fallback detail",
}];
source5.timeline.provider = "interface5";
source5.timeline.waybill = "SHAREDACCOUNT123";
source6Only.timeline.provider = "interface6";
source6Only.route = { kind: "cainiao", source: "interface6" };
manual6.timeline.provider = "interface6";
manual5.timeline.provider = "kuaidi100";
source6.route = { kind: "cainiao", source: "interface6" };
manual6.timeline.waybill = "SAMEWAYBILL123";
manual6.identity.sourceId = "SAMEWAYBILL123";
manual6.route = { kind: "cainiao", source: "interface6" };
manual5.timeline.waybill = "SAMEWAYBILL123";
manual5.identity.sourceId = "SAMEWAYBILL123";
const mixedState: AppState = {
  ...emptyState(),
  activeSource: "interface6",
  bindings: [
    { source: "interface5", phone: "13800138000", boundAtMs: NOW - 3 },
    { source: "interface6", phone: "13900139000", boundAtMs: NOW - 2 },
  ],
  pendingQueries: [
    {
      ...pending({
        id: "interface6:SAMEPENDING123",
        source: "interface6",
        waybill: "SAMEPENDING123",
        attempts: 2,
      }),
      createdAtMs: NOW - 20,
      lastAttemptAtMs: NOW - 5,
      route: { kind: "cainiao", source: "interface6" },
    },
    {
      ...pending({
        id: "interface5:SAMEPENDING123",
        source: "interface5",
        waybill: "SAMEPENDING123",
        attempts: 4,
      }),
      createdAtMs: NOW - 10,
      lastAttemptAtMs: NOW - 2,
    },
  ],
  shipments: [source5, source6, source6Only, manual5, manual6],
};
memory.set(STATE_KEY, storedState(mixedState, 2));
memory.set(ROUTES_KEY, JSON.stringify({
  source6: {
    url: "https://page.cainiao.com/source6",
    source: "interface6",
    updatedAtMs: NOW - 1,
  },
  "source6-only": {
    url: "https://page.cainiao.com/source6-only",
    source: "interface6",
    updatedAtMs: NOW - 1,
  },
  manual6: {
    url: "https://page.cainiao.com/manual6",
    source: "interface6",
    updatedAtMs: NOW - 1,
  },
  "interface6:SAMEPENDING123": {
    url: "https://page.cainiao.com/pending6",
    source: "interface6",
    updatedAtMs: NOW - 1,
  },
}));
const isolated = loadState(NOW);
assert.equal(isolated.activeSource, "interface5");
assert.deepEqual(isolated.bindings, [
  { source: "interface5", phone: "13800138000", boundAtMs: NOW - 3 },
]);
assert.deepEqual(
  new Set(visibleShipments(isolated).map((item) => item.identity.id)),
  new Set(["source5", "source6-only", "interface5:manual:SAMEWAYBILL123"]),
);
assert.deepEqual(
  new Set(loadWidgetSnapshot(NOW).rows.map((row) => row.shipmentId)),
  new Set(["source5", "source6-only", "interface5:manual:SAMEWAYBILL123"]),
);
assert.equal(
  isolated.shipments.find((item) => item.identity.id === "source6-only")
    ?.identity.bindingSource,
  null,
);
const migratedAccount = isolated.shipments.find(
  (item) => item.identity.id === "source5",
);
assert.equal(migratedAccount?.sourceTimeline?.provider, "interface5");
assert.deepEqual(
  new Set(migratedAccount?.manualTimelines?.map((timeline) => timeline.provider)),
  new Set(["interface6", "kuaidi100"]),
);
assert.deepEqual(migratedAccount?.route, {
  kind: "cainiao",
  source: "interface5",
});
assert.deepEqual(
  isolated.shipments.find((item) => item.identity.id === "source6-only")?.route,
  { kind: "cainiao", source: "interface5" },
);
assert.deepEqual(
  isolated.shipments.find((item) => item.identity.manuallyAdded)?.route,
  { kind: "cainiao", source: "interface5" },
);
assert.deepEqual(
  new Set(
    isolated.shipments
      .find((item) => item.identity.manuallyAdded)
      ?.manualTimelines
      ?.map((timeline) => timeline.provider),
  ),
  new Set(["interface6", "kuaidi100"]),
);
assert.deepEqual(isolated.pendingQueries.map((item) => item.id), [
  "interface5:SAMEPENDING123",
]);
assert.equal(isolated.pendingQueries[0]?.createdAtMs, NOW - 20);
assert.equal(isolated.pendingQueries[0]?.lastAttemptAtMs, NOW - 2);
assert.equal(isolated.pendingQueries[0]?.attempts, 4);
assert.deepEqual(isolated.pendingQueries[0]?.route, {
  kind: "cainiao",
  source: "interface5",
});
const migratedRoutes = JSON.parse(String(memory.get(ROUTES_KEY))) as Record<
  string,
  { url: string; source: BindingSource; updatedAtMs: number }
>;
assert.equal(migratedRoutes.source5?.source, "interface5");
assert.equal(migratedRoutes["source6-only"]?.source, "interface5");
assert.equal(
  migratedRoutes["interface5:manual:SAMEWAYBILL123"]?.source,
  "interface5",
);
assert.equal(
  migratedRoutes["interface5:SAMEPENDING123"]?.source,
  "interface5",
);
assert.equal("manual6" in migratedRoutes, false);
assert.equal("source6" in migratedRoutes, false);
assert.equal("interface6:SAMEPENDING123" in migratedRoutes, false);
assert.deepEqual(loadState(NOW), isolated);
const reboundMigratedBinding = addBinding(
  "interface5",
  "13800138000",
  NOW + 1,
);
assert.equal(reboundMigratedBinding.bindings.length, 1);

// Scripting Storage.set may be a void API; a successful immediate readback is authoritative.
memory.clear();
storageSetReturnsVoid = true;
const voidWrite = addBinding("interface5", "13700137000", NOW + 2);
storageSetReturnsVoid = false;
assert.equal(voidWrite.activeSource, "interface5");
assert.equal(loadState(NOW + 2).bindings.length, 1);

memory.clear();
const bindingLimitPhones = [
  "13800138000",
  "13900139000",
  "13700137000",
  "13600136000",
  "13500135000",
];
bindingLimitPhones.forEach((value, index) => {
  addBinding("interface5", value, NOW + index + 1);
});
assert.equal(loadState(NOW + 6).bindings.length, 5);
assert.throws(
  () => addBinding("interface5", "13400134000", NOW + 7),
  /最多可绑定 5 个手机号/,
);

// Re-importing a script may replace ordinary Storage. The shared state backup and stable Keychain
// binding backup restore the complete local model without reviving retired account-source rows.
memory.clear();
const importedPhone = "13800138000";
addBinding("interface5", importedPhone, NOW + 1);
const importedShipment = shipment({
  id: "imported-cache",
  source: null,
  manuallyAdded: true,
});
upsertShipment(importedShipment, NOW + 2);
upsertPendingQuery(
  pending({ id: "imported-pending", source: "interface5" }),
  NOW + 3,
);
const importedBeforeReload = loadState(NOW + 3);
saveState(importedBeforeReload, NOW + 3);
memory.delete(STATE_KEY);
const restoredAfterImport = loadState(NOW + 4);
assert.equal(restoredAfterImport.activeSource, "interface5");
assert.deepEqual(restoredAfterImport.bindings, [
  { source: "interface5", phone: importedPhone, boundAtMs: NOW + 1 },
]);
assert.equal(
  restoredAfterImport.shipments[0]?.identity.id,
  "interface5:manual:WBIMPORTEDCACHE",
);
assert.equal(
  restoredAfterImport.pendingQueries[0]?.id,
  "interface5:WBIMPORTEDPENDING",
);
assert.equal(restoredAfterImport.shipments[0]?.timeline.tracks.length, 1);

// Unbinding invalidates only the matching automatic owner. The row and its
// last package stay visible, manual rows remain independent, and an unrelated
// automatic owner is unaffected.
memory.clear();
const phoneA = "13800138000";
const phoneB = "13900139000";
const ownerA = shipment({ id: "owner-a", source: "interface5", phone: phoneA });
const ownerB = shipment({ id: "owner-b", source: "interface5", phone: phoneB });
const manualA = shipment({
  id: "manual-a",
  source: "interface5",
  phone: phoneA,
  manuallyAdded: true,
});
saveState({
  ...emptyState(),
  bindings: [
    { source: "interface5", phone: phoneA, boundAtMs: NOW },
    { source: "interface5", phone: phoneB, boundAtMs: NOW },
  ],
  shipments: [ownerA, ownerB, manualA],
  pendingQueries: [
    pending({ id: "pending-no-tail", source: "interface5" }),
    pending({ id: "pending-tail", source: "interface5", phoneTail: "8000" }),
  ],
}, NOW);
const unbound = removeBinding("interface5", phoneA, NOW + 1);
assert.deepEqual(
  new Set(unbound.shipments.map((item) => item.identity.id)),
  new Set(["owner-a", "owner-b", "interface5:manual:WBMANUALA"]),
);
assert.equal(
  unbound.shipments.find((item) => item.identity.id === "owner-a")
    ?.automaticOwnership?.ownerSource,
  null,
);
assert.equal(
  unbound.shipments.find((item) => item.identity.id === "owner-b")
    ?.automaticOwnership?.ownerSource,
  "interface5",
);
assert.equal(
  unbound.bindings.some(
    (binding) => binding.source === "interface5" && binding.phone === phoneA,
  ),
  false,
);
assert.deepEqual(
  new Set(unbound.pendingQueries.map((item) => item.waybill)),
  new Set(["WBPENDINGNOTAIL"]),
);

// Removing the only binding leaves an automatic row unowned when there is no
// other qualified source observation to take over.
memory.clear();
const noPhone = shipment({ id: "no-phone", source: "interface5" });
saveState({
  ...emptyState(),
  bindings: [{ source: "interface5", phone: phoneA, boundAtMs: NOW }],
  shipments: [noPhone],
}, NOW);
const noPhoneUnbound = removeBinding("interface5", phoneA, NOW + 1);
assert.equal(noPhoneUnbound.shipments.length, 1);
assert.equal(noPhoneUnbound.shipments[0]?.automaticOwnership?.ownerSource, null);

// Legacy rows may only retain a four-digit tail. Unbinding the unique matching
// phone invalidates the observation's actual tail identity, not a synthesized
// full-phone identity that the legacy observation never had.
memory.clear();
const tailOnlyOwner = shipment({ id: "tail-only", source: "interface5" });
tailOnlyOwner.identity.phoneTail = "8000";
const tailOnlyState = saveState({
  ...emptyState(),
  bindings: [{ source: "interface5", phone: phoneA, boundAtMs: NOW }],
  shipments: [tailOnlyOwner],
}, NOW);
assert.equal(
  tailOnlyState.shipments[0]?.automaticOwnership?.ownerBindingIdentity,
  "tail:8000",
);
const tailOnlyUnbound = removeBinding("interface5", phoneA, NOW + 1);
assert.equal(tailOnlyUnbound.shipments[0]?.automaticOwnership?.ownerSource, null);
assert.equal(
  tailOnlyUnbound.shipments[0]?.automaticOwnership?.observations.find(
    (observation) => observation.bindingIdentity === "tail:8000",
  )?.bindingValid,
  false,
);

// Two bindings on the same automatic source retain separate observations.
// Unbinding one account invalidates only that binding and immediately selects
// the other account's newer qualified package for the same waybill.
memory.clear();
const multiBindingA = shipment({
  id: "multi-binding-a",
  source: "interface5",
  phone: phoneA,
});
multiBindingA.timeline.provider = "interface5";
multiBindingA.sourceTimeline = multiBindingA.timeline;
const multiBindingB = shipment({
  id: "multi-binding-b",
  source: "interface5",
  phone: phoneB,
});
multiBindingB.timeline = {
  ...multiBindingB.timeline,
  provider: "interface5",
  waybill: multiBindingA.timeline.waybill,
  latestDetail: "second binding package",
  successAtMs: NOW + 1,
};
multiBindingB.sourceTimeline = multiBindingB.timeline;
const multiBindingOwner = observeQualifiedAutomaticShipment(
  undefined,
  multiBindingA,
  "interface5",
  NOW,
);
const multiBindingCandidate = observeQualifiedAutomaticShipment(
  multiBindingOwner,
  multiBindingB,
  "interface5",
  NOW + 1,
);
saveState({
  ...emptyState(),
  bindings: [
    { source: "interface5", phone: phoneA, boundAtMs: NOW },
    { source: "interface5", phone: phoneB, boundAtMs: NOW },
  ],
  shipments: [multiBindingCandidate],
}, NOW + 1);
const afterFirstAccountUnbound = removeBinding("interface5", phoneA, NOW + 2);
assert.equal(afterFirstAccountUnbound.shipments.length, 1);
assert.equal(afterFirstAccountUnbound.shipments[0]?.identity.phone, phoneB);
assert.equal(
  afterFirstAccountUnbound.shipments[0]?.automaticOwnership?.ownerBindingIdentity,
  `phone:${phoneB}`,
);
assert.equal(
  afterFirstAccountUnbound.shipments[0]?.automaticOwnership?.observations.find(
    (observation) => observation.bindingIdentity === `phone:${phoneA}`,
  )?.bindingValid,
  false,
);

// A refresh begun under an older binding generation cannot publish after the
// same phone is explicitly unbound and then rebound.
memory.clear();
const generationBase = saveState({
  ...emptyState(),
  bindings: [{ source: "interface5", phone: phoneA, boundAtMs: NOW }],
}, NOW);
const generationIncoming = shipment({
  id: "old-generation-row",
  source: "interface5",
  phone: phoneA,
});
generationIncoming.timeline.provider = "interface5";
generationIncoming.sourceTimeline = generationIncoming.timeline;
const generationCandidate = {
  ...generationBase,
  shipments: [generationIncoming],
};
removeBinding("interface5", phoneA, NOW + 1);
addBinding("interface5", phoneA, NOW + 2);
const generationCommit = commitRefreshState(
  generationBase,
  generationCandidate,
  "interface5",
  NOW + 3,
);
assert.equal(generationCommit.state.shipments.length, 0);

// A refresh that began before an unbind or deletion cannot undo the user action.
memory.clear();
const raceOwnerSeed = shipment({ id: "race-owner", source: "interface5", phone: phoneA });
const raceManualSeed = shipment({
  id: "race-manual",
  source: "interface5",
  manuallyAdded: true,
});
const raceBase = saveState({
  ...emptyState(),
  bindings: [{ source: "interface5", phone: phoneA, boundAtMs: NOW }],
  shipments: [raceOwnerSeed, raceManualSeed],
}, NOW);
const raceOwner = raceBase.shipments.find((item) => !item.identity.manuallyAdded)!;
const raceManual = raceBase.shipments.find((item) => item.identity.manuallyAdded)!;
const refreshedOwner = {
  ...raceOwner,
  timeline: { ...raceOwner.timeline, semantic: "DELIVERY" as const },
  updatedAtMs: NOW + 10,
};
const refreshedManual = {
  ...raceManual,
  timeline: { ...raceManual.timeline, semantic: "DELIVERY" as const },
  updatedAtMs: NOW + 10,
};
const staleManualCandidate = {
  ...raceBase,
  shipments: [refreshedOwner, refreshedManual],
};
removeBinding("interface5", phoneA, NOW + 2);
removeShipment(raceManual.identity.id, NOW + 3);
const rebased = commitRefreshState(
  raceBase,
  staleManualCandidate,
  "interface5",
  NOW + 5,
).state;
assert.equal(rebased.activeSource, "interface5");
assert.equal(rebased.bindings.length, 0);
assert.equal(rebased.shipments.some((item) => item.identity.id === "race-owner"), true);
assert.equal(
  rebased.shipments.find((item) => item.identity.id === "race-owner")
    ?.automaticOwnership?.ownerSource,
  null,
);
assert.equal(
  rebased.shipments.find((item) => item.identity.id === "race-owner")
    ?.timeline.semantic,
  "TRANSIT",
);
assert.equal(rebased.shipments.some((item) => item.identity.id === "race-manual"), false);

// An expired refresh lease cannot publish a candidate even when the row itself is unchanged.
memory.clear();
const fencedSeed = shipment({ id: "fenced-refresh", source: "interface5" });
const fencedBase = saveState({
  ...emptyState(),
  shipments: [fencedSeed],
}, NOW);
const fencedCandidate = structuredClone(fencedBase);
fencedCandidate.shipments[0].timeline.semantic = "DELIVERY";
const fencedRevision = loadState(NOW + 1).revision;
const fencedCommit = commitRefreshState(
  fencedBase,
  fencedCandidate,
  "interface5",
  NOW + 2,
  { isCurrent: () => false },
);
assert.equal(fencedCommit.applied, false);
assert.equal(fencedCommit.state.revision, fencedRevision);
assert.equal(fencedCommit.state.shipments[0].timeline.semantic, "TRANSIT");

// A projection result may commit only while the exact durable reservation still owns the row.
const ownershipGuardCommit = commitRefreshState(
  fencedBase,
  fencedCandidate,
  "interface5",
  NOW + 3,
  {
    isCurrent: () => true,
    acceptsState: () => false,
  },
);
assert.equal(ownershipGuardCommit.applied, false);
assert.equal(ownershipGuardCommit.state.revision, fencedRevision);
assert.equal(ownershipGuardCommit.state.shipments[0].timeline.semantic, "TRANSIT");

// A concurrent detail refresh may update the same order while the hidden WebView discovers its
// carrier waybill. The current row remains authoritative while its empty projection advances once.
memory.clear();
const projectionSeed = shipment({ id: "projection-race", source: "interface5" });
projectionSeed.identity.sourceId = "ORDER20260826002";
projectionSeed.identity.orderId = "ORDER20260826002";
projectionSeed.identity.accountOrder = true;
projectionSeed.identity.companyName = "京东购物";
projectionSeed.identity.sourceProvider = "JingDong";
projectionSeed.timeline.provider = "interface5";
projectionSeed.timeline.waybill = "ORDER20260826002";
projectionSeed.sourceTimeline = projectionSeed.timeline;
projectionSeed.identity.projectedWaybill = "ORDER20260826002";
const projectionBase = saveState({
  ...emptyState(),
  shipments: [projectionSeed],
}, NOW);
assert.equal(projectionBase.shipments[0].identity.projectedWaybill, "");
const projectedCandidate = structuredClone(projectionBase);
projectedCandidate.shipments[0].identity.projectedWaybill = "SF9876543210123";
projectedCandidate.shipments[0].identity.courierCode = "SF";
projectedCandidate.shipments[0].identity.companyName = "顺丰速运";
projectedCandidate.shipments[0].updatedAtMs = NOW + 10;
const concurrentDetail = structuredClone(projectionBase.shipments[0]);
concurrentDetail.timeline.provider = "interface5";
concurrentDetail.sourceTimeline = concurrentDetail.timeline;
concurrentDetail.updatedAtMs = NOW + 5;
upsertShipment(concurrentDetail, NOW + 5);
const projectionRebased = commitRefreshState(
  projectionBase,
  projectedCandidate,
  "interface5",
  NOW + 11,
).state;
const projectionResult = projectionRebased.shipments[0];
assert.equal(projectionResult.identity.projectedWaybill, "SF9876543210123");
assert.equal(projectionResult.identity.courierCode, "SF");
assert.equal(projectionResult.updatedAtMs, NOW + 5);

// Order completion is presentation-only, so a concurrent WebView result may still
// advance the durable order identity to its real carrier waybill.
memory.clear();
const completedProjectionBase = saveState({
  ...emptyState(),
  shipments: [projectionSeed],
}, NOW + 20);
const staleCompletedProjection = structuredClone(completedProjectionBase);
staleCompletedProjection.shipments[0].identity.projectedWaybill =
  "SF9876543210123";
staleCompletedProjection.shipments[0].identity.courierCode = "SF";
staleCompletedProjection.shipments[0].identity.companyName = "顺丰速运";
const projectedSignedTimeline = {
  ...staleCompletedProjection.shipments[0].timeline,
  provider: "interface5",
  complete: true,
  structuredStatus: true,
  waybill: "SF9876543210123",
  courierCode: "SF",
  companyName: "顺丰速运",
  semantic: "COMPLETED" as const,
  statusEventAtMs: NOW + 24,
  latestTimeText: "2026-08-26 14:00:24",
  latestDetail: "真实运单已签收",
  tracks: [{
    timeText: "2026-08-26 14:00:24",
    timeMs: NOW + 24,
    detail: "真实运单已签收",
    statusCode: "3",
    raw: {},
  }],
  successAtMs: NOW + 24,
};
const projectedManualTimeline = {
  ...projectedSignedTimeline,
  provider: "kdniao",
  complete: true,
  latestDetail: "手动源完整签收轨迹",
  tracks: [
    {
      ...projectedSignedTimeline.tracks[0],
      detail: "手动源完整签收轨迹",
    },
    {
      timeText: "2026-08-26 13:00:00",
      timeMs: NOW - 60 * 60 * 1_000,
      detail: "手动源揽收轨迹",
      statusCode: "1",
      raw: {},
    },
  ],
};
staleCompletedProjection.shipments[0].timeline = projectedSignedTimeline;
staleCompletedProjection.shipments[0].sourceTimeline = projectedSignedTimeline;
staleCompletedProjection.shipments[0].manualTimelines = [projectedManualTimeline];
const completedDuringProjection = structuredClone(
  completedProjectionBase.shipments[0],
);
const concurrentOrderSummary = {
  ...completedDuringProjection.timeline,
  semantic: "ORDERED" as const,
  latestDetail: "订单已完成",
  tracks: [{
    ...completedDuringProjection.timeline.tracks[0],
    detail: "订单已完成",
  }],
};
completedDuringProjection.timeline = concurrentOrderSummary;
completedDuringProjection.sourceTimeline = concurrentOrderSummary;
completedDuringProjection.statusPresentation = {
  scope: "ORDER",
  semantic: "COMPLETED",
  text: "已完成",
};
completedDuringProjection.updatedAtMs = NOW + 25;
upsertShipment(completedDuringProjection, NOW + 25);
const screenedProjection = commitRefreshState(
  completedProjectionBase,
  staleCompletedProjection,
  "interface5",
  NOW + 30,
).state.shipments[0];
assert.equal(screenedProjection.identity.projectedWaybill, "SF9876543210123");
assert.equal(screenedProjection.statusPresentation, undefined);
assert.equal(screenedProjection.timeline.semantic, "COMPLETED");
assert.equal(screenedProjection.timeline.latestDetail, "手动源完整签收轨迹");
assert.equal(screenedProjection.sourceTimeline?.latestDetail, "真实运单已签收");
assert.equal(
  screenedProjection.manualTimelines?.some(
    (timeline) => timeline.latestDetail === "手动源完整签收轨迹",
  ),
  true,
);
assert.equal(
  screenedProjection.automaticOwnership?.observations.find(
    (observation) => observation.source === "interface5",
  )?.sourceTimeline.latestDetail,
  "真实运单已签收",
);

// A JD H5 response is one atomic package, including after the automatic
// observation has passed through durable state.
memory.clear();
const atomicJdH5Seed = shipment({
  id: "jd-h5-atomic",
  source: "interface5",
  phone: "13800001515",
});
atomicJdH5Seed.identity = {
  ...atomicJdH5Seed.identity,
  sourceOwner: "interface5:parcel",
  sourceId: "ORDER20260826004",
  rawCourierCode: "JD",
  courierCode: "JD",
  companyName: "京东快递",
  sourceProvider: "JingDong",
  projectedWaybill: "JD9988776655",
  accountOrder: true,
};
const partialAtomicJdH5Timeline: Shipment["timeline"] = {
  ...atomicJdH5Seed.timeline,
  provider: "interface5",
  waybill: "JD9988776655",
  courierCode: "JD",
  companyName: "京东快递",
  semantic: "PICKED",
  complete: false,
  latestDetail: "点击前响应",
  tracks: [{
    ...atomicJdH5Seed.timeline.tracks[0],
    detail: "点击前响应",
    raw: { _pipiStatusSource: "jingdong_h5" },
  }],
  successAtMs: NOW + 40,
};
atomicJdH5Seed.timeline = partialAtomicJdH5Timeline;
atomicJdH5Seed.sourceTimeline = partialAtomicJdH5Timeline;
const completeAtomicJdH5Timeline: Shipment["timeline"] = {
  ...partialAtomicJdH5Timeline,
  semantic: "DELIVERY",
  complete: true,
  latestDetail: "完整物流进度响应",
  tracks: [{
    ...partialAtomicJdH5Timeline.tracks[0],
    detail: "完整物流进度响应",
  }],
  successAtMs: NOW + 41,
};
const atomicJdH5Merged = applyAccountShipment(
  atomicJdH5Seed,
  {
    ...atomicJdH5Seed,
    timeline: completeAtomicJdH5Timeline,
    sourceTimeline: completeAtomicJdH5Timeline,
    updatedAtMs: NOW + 41,
  },
  NOW + 41,
);
saveState({
  ...emptyState(),
  shipments: [atomicJdH5Merged],
}, NOW + 41);
const restoredAtomicJdH5 = loadState(NOW + 42).shipments[0];
assert.deepEqual(
  restoredAtomicJdH5.sourceTimeline?.tracks.map((track) => track.detail),
  ["完整物流进度响应"],
  "durable JD H5 source state must retain exactly one response package",
);
assert.deepEqual(
  restoredAtomicJdH5.automaticOwnership?.observations.find(
    (observation) =>
      observation.source === "interface5" &&
      observation.bindingIdentity === "phone:13800001515",
  )?.sourceTimeline.tracks.map((track) => track.detail),
  ["完整物流进度响应"],
  "durable JD H5 observations must not combine separate responses",
);

// Older script builds persisted the order-stage label after a waybill had been projected.
// Loading or saving that state must discard the non-authoritative order-stage presentation;
// the exact carrier alias from a later source response may populate it again.
memory.clear();
const legacyProjectedJd = shipment({ id: "legacy-projected-jd", source: "interface5" });
legacyProjectedJd.identity.sourceId = "ORDER20260826003";
legacyProjectedJd.identity.orderId = "ORDER20260826003";
legacyProjectedJd.identity.accountOrder = true;
legacyProjectedJd.identity.projectedWaybill = "JD0256747737308";
legacyProjectedJd.identity.courierCode = "JD";
legacyProjectedJd.identity.companyName = "京东购物";
legacyProjectedJd.timeline.waybill = "ORDER20260826003";
const healedProjectedJd = saveState({
  ...emptyState(),
  shipments: [legacyProjectedJd],
}, NOW).shipments[0];
assert.equal(healedProjectedJd.identity.projectedWaybill, "JD0256747737308");
assert.equal(healedProjectedJd.identity.courierCode, "");
assert.equal(healedProjectedJd.identity.companyName, "快递");

// A short numeric JD order was previously stored as a carrier parcel because
// older builds only recognized 16-digit order identities.
memory.clear();
const legacyShortJdOrder = shipment({
  id: "interface5:account:350365030147",
  source: "interface5",
});
legacyShortJdOrder.identity.sourceId = "350365030147";
legacyShortJdOrder.identity.sourceOwner = "interface5";
legacyShortJdOrder.identity.sourceProvider = "JingDong";
legacyShortJdOrder.identity.courierCode = "JD";
legacyShortJdOrder.identity.companyName = "京东快递";
legacyShortJdOrder.identity.orderId = "";
legacyShortJdOrder.identity.accountOrder = false;
legacyShortJdOrder.timeline.waybill = "350365030147";
legacyShortJdOrder.timeline.semantic = "COMPLETED";
legacyShortJdOrder.timeline.latestDetail = "您的订单350365030147已完成";
legacyShortJdOrder.timeline.tracks[0] = {
  ...legacyShortJdOrder.timeline.tracks[0],
  detail: "您的订单350365030147已完成",
};
legacyShortJdOrder.sourceTimeline = legacyShortJdOrder.timeline;
legacyShortJdOrder.manualTimelines = [{
  ...legacyShortJdOrder.timeline,
  provider: "kdniao",
}];
const healedShortJdOrder = saveState({
  ...emptyState(),
  shipments: [legacyShortJdOrder],
}, NOW).shipments[0];
assert.equal(healedShortJdOrder.identity.accountOrder, true);
assert.equal(healedShortJdOrder.identity.orderId, "350365030147");
assert.equal(healedShortJdOrder.identity.sourceOwner, "interface5:order");
assert.equal(healedShortJdOrder.identity.companyName, "京东购物");
assert.equal(healedShortJdOrder.timeline.semantic, "COMPLETED");
assert.deepEqual(healedShortJdOrder.manualTimelines, []);
assert.deepEqual(healedShortJdOrder.statusPresentation, {
  scope: "ORDER",
  semantic: "COMPLETED",
  text: "已完成",
});

// Projection retry metadata is durable only for an unprojected order and only when its route
// fingerprint and failure timestamp are valid.
memory.clear();
const retryHash = "d".repeat(64);
const retrySeed = shipment({ id: "projection-retry", source: "interface5" });
retrySeed.identity.sourceId = "ORDER20260826004";
retrySeed.identity.orderId = "ORDER20260826004";
retrySeed.identity.accountOrder = true;
retrySeed.identity.companyName = "京东购物";
retrySeed.timeline.waybill = "ORDER20260826004";
retrySeed.identity.orderProjectionRetry = {
  routeHash: retryHash.toUpperCase(),
  failedAtMs: NOW - 1,
};
saveState({ ...emptyState(), shipments: [retrySeed] }, NOW);
assert.deepEqual(loadState(NOW).shipments[0]?.identity.orderProjectionRetry, {
  routeHash: retryHash,
  failedAtMs: NOW - 1,
});

memory.clear();
const reservationSeed = structuredClone(retrySeed);
reservationSeed.identity.orderProjectionRetry = {
  routeHash: retryHash,
  attemptId: "projection-reservation-1",
  attemptExpiresAtMs: NOW + 12_000,
};
assert.deepEqual(
  saveState({ ...emptyState(), shipments: [reservationSeed] }, NOW)
    .shipments[0]?.identity.orderProjectionRetry,
  {
    routeHash: retryHash,
    attemptId: "projection-reservation-1",
    attemptExpiresAtMs: NOW + 12_000,
  },
);

memory.clear();
const invalidRetry = structuredClone(retrySeed);
invalidRetry.identity.orderProjectionRetry = {
  routeHash: "not-a-route-hash",
  failedAtMs: NOW - 1,
};
assert.equal(
  saveState({ ...emptyState(), shipments: [invalidRetry] }, NOW)
    .shipments[0]?.identity.orderProjectionRetry,
  undefined,
);

memory.clear();
const projectedWithRetry = structuredClone(retrySeed);
projectedWithRetry.identity.projectedWaybill = "JD0256747737308";
assert.equal(
  saveState({ ...emptyState(), shipments: [projectedWithRetry] }, NOW)
    .shipments[0]?.identity.orderProjectionRetry,
  undefined,
);

// Removing a visible shipment also removes its matching invisible pending retry.
memory.clear();
const deletedWithPending = shipment({
  id: "deleted-with-pending",
  source: "interface5",
  manuallyAdded: true,
});
const deletionBase = saveState({
  ...emptyState(),
  shipments: [deletedWithPending],
  pendingQueries: [
    pending({
      id: "matching-pending",
      source: "interface5",
      waybill: deletedWithPending.timeline.waybill,
    }),
    pending({
      id: "duplicate-pending",
      source: "interface5",
      waybill: deletedWithPending.timeline.waybill,
    }),
    pending({ id: "other-waybill", source: "interface5" }),
  ],
}, NOW);
const deletionTarget = deletionBase.shipments[0]!;
const afterDelete = removeShipment(deletionTarget.identity.id, NOW + 1);
assert.deepEqual(
  new Set(afterDelete.pendingQueries.map((item) => item.waybill)),
  new Set(["WBOTHERWAYBILL"]),
);
const staleCandidate = {
  ...deletionBase,
  shipments: [{ ...deletionTarget, updatedAtMs: NOW + 2 }],
};
const staleCommit = commitRefreshState(
  deletionBase,
  staleCandidate,
  "interface5",
  NOW + 2,
);
assert.equal(staleCommit.applied, true);
assert.equal(staleCommit.state.shipments.length, 0);

memory.clear();
const automaticDeleteTarget = shipment({
  id: "automatic-delete",
  source: "interface5",
  manuallyAdded: false,
});
saveState({
  ...emptyState(),
  bindings: [{ source: "interface5", phone: phoneA, boundAtMs: NOW }],
  shipments: [automaticDeleteTarget],
}, NOW);
removeShipment(automaticDeleteTarget.identity.id, NOW + 1);
assert.equal(loadState(NOW + 1).shipments.length, 0);
upsertShipment({ ...automaticDeleteTarget, updatedAtMs: NOW + 2 }, NOW + 2);
assert.equal(
  loadState(NOW + 2).shipments.some(
    (item) => item.identity.id === automaticDeleteTarget.identity.id,
  ),
  true,
);

// Deleting a projected account order does not block its extracted carrier waybill.
memory.clear();
const projectedOrder = shipment({ id: "projected-order", source: "interface5" });
projectedOrder.identity.sourceId = "ORDER20260826001";
projectedOrder.identity.orderId = "ORDER20260826001";
projectedOrder.identity.projectedWaybill = "SF1234567890123";
projectedOrder.identity.accountOrder = true;
projectedOrder.timeline.waybill = "ORDER20260826001";
saveState({ ...emptyState(), shipments: [projectedOrder] }, NOW);
const deletedOrder = removeShipment(projectedOrder.identity.id, NOW + 1);
assert.equal(deletedOrder.shipments.length, 0);
const independentProjectedWaybill = shipment({
  id: "independent-projected-waybill",
  source: null,
  manuallyAdded: true,
});
independentProjectedWaybill.identity.sourceId = "SF1234567890123";
independentProjectedWaybill.timeline.waybill = "SF1234567890123";
upsertShipment(independentProjectedWaybill, NOW + 2);
assert.equal(
  loadState(NOW + 2).shipments.some(
    (item) => item.timeline.waybill === "SF1234567890123",
  ),
  true,
);

// Retention pruning does not create a durable block; a later fresh automatic feed may re-add it.
memory.clear();
const expiredSigned = shipment({
  id: "expired-signed",
  source: "interface5",
  semantic: "COMPLETED",
});
const signedAt = NOW - 8 * 24 * 60 * 60 * 1000;
expiredSigned.timeline.statusEventAtMs = signedAt;
expiredSigned.timeline.latestTimeText = "2026-08-18 14:00:00";
expiredSigned.timeline.tracks = [{
  ...expiredSigned.timeline.tracks[0],
  timeText: "2026-08-18 14:00:00",
  timeMs: signedAt,
}];
const expiredState = saveState(
  { ...emptyState(), shipments: [expiredSigned] },
  NOW,
);
assert.equal(expiredState.shipments.length, 0);
const refreshedExpired = structuredClone(expiredSigned);
refreshedExpired.timeline.statusEventAtMs = NOW + 1;
refreshedExpired.timeline.latestTimeText = "2026-08-26 14:00:01";
refreshedExpired.timeline.tracks = [{
  ...refreshedExpired.timeline.tracks[0],
  timeText: "2026-08-26 14:00:01",
  timeMs: NOW + 1,
}];
upsertShipment({ ...refreshedExpired, updatedAtMs: NOW + 1 }, NOW + 1);
assert.equal(loadState(NOW + 1).shipments.length, 1);

// A pending promotion cannot commit after the user removed its causal queue row.
memory.clear();
const queued = pending({
  id: "pending-promotion",
  source: "interface5",
  waybill: "WBQUEUED123",
});
const promotionBase = saveState(
  { ...emptyState(), pendingQueries: [queued] },
  NOW,
);
const promoted = shipment({
  id: "promoted-manual",
  source: "interface5",
  manuallyAdded: true,
});
promoted.timeline.waybill = queued.waybill;
promoted.identity.sourceId = queued.waybill;
const promotionCandidate = {
  ...promotionBase,
  pendingQueries: [],
  shipments: [promoted],
};
removePendingQuery(promotionBase.pendingQueries[0]!.id, NOW + 1);
const promotionRace = commitRefreshState(
  promotionBase,
  promotionCandidate,
  "interface5",
  NOW + 2,
).state;
assert.equal(promotionRace.shipments.length, 0);

// An untimed preview must durably enqueue its retry before the caller opens another screen.
memory.clear();
const previewShipment = shipment({
  id: "interface5:manual:WBUNTIMED123",
  source: "interface5",
  manuallyAdded: true,
});
previewShipment.timeline.tracks = [{
  timeText: "",
  timeMs: null,
  detail: "订单已创建",
  statusCode: "",
  raw: {},
}];
previewShipment.timeline.statusEventAtMs = null;
const previewPending = pending({
  id: "interface5:WBUNTIMED123",
  source: "interface5",
  waybill: "WBUNTIMED123",
  createdAtMs: Date.now() - 1,
});
previewShipment.identity.createdAtMs = previewPending.createdAtMs;
previewShipment.timeline.waybill = previewPending.waybill;
previewShipment.identity.sourceId = previewPending.waybill;
const preview = prepareManualPreview({
  shipment: previewShipment,
  pending: previewPending,
  routeUrl: "",
});
assert.equal(preview.hasTimedResult, false);
assert.equal(
  loadState().pendingQueries.some((item) => item.id === previewPending.id),
  false,
  "preparing a preview must not mutate durable pending state",
);
const manualPreviewNow = Date.now();
const committedUntimedPreview = commitManualShipmentPreview(
  preview,
  manualPreviewNow,
);
assert.equal(
  committedUntimedPreview.shipments.some(
    (item) => item.identity.id === previewShipment.identity.id,
  ),
  false,
  "an untimed manual preview must remain outside the shipment collection",
);
assert.equal(
  committedUntimedPreview.pendingQueries.some(
    (item) => item.id === previewPending.id,
  ),
  true,
  "the committed pending query owns polling until a timed timeline is available",
);
assert.equal(
  visibleShipments(committedUntimedPreview, manualPreviewNow).some(
    (item) => item.identity.id === previewShipment.identity.id,
  ),
  false,
  "an untimed manual preview must not enter the delivery list",
);

// A timed Picker fragment is useful as a detail-only preview, but the first
// manual owner cannot exist until the remaining primary/fallback round settles.
memory.clear();
const partialPickerTimeline = {
  ...previewShipment.timeline,
  provider: "route",
  complete: false,
  semantic: "TRANSIT" as const,
  statusEventAtMs: manualPreviewNow,
  latestTimeText: "2026-09-01 13:00:00",
  latestDetail: "快件运输中",
  tracks: [{
    timeText: "2026-09-01 13:00:00",
    timeMs: manualPreviewNow,
    detail: "快件运输中",
    statusCode: "TRANSIT",
    raw: { status: "TRANSIT" },
  }],
  successAtMs: manualPreviewNow,
};
const partialPickerShipment: Shipment = {
  ...previewShipment,
  timeline: partialPickerTimeline,
  manualTimelines: [partialPickerTimeline],
  updatedAtMs: manualPreviewNow,
};
const partialPickerPending = {
  ...previewPending,
  id: "interface5:WBPICKERPARTIAL123",
  waybill: "WBPICKERPARTIAL123",
  createdAtMs: manualPreviewNow,
  lastAttemptAtMs: manualPreviewNow,
};
partialPickerShipment.identity.id = "interface5:manual:WBPICKERPARTIAL123";
partialPickerShipment.identity.sourceId = partialPickerPending.waybill;
partialPickerShipment.identity.createdAtMs = manualPreviewNow;
partialPickerShipment.timeline.waybill = partialPickerPending.waybill;
const committedPartialPicker = commitManualShipmentPreview({
  shipment: partialPickerShipment,
  pending: partialPickerPending,
  routeUrl: "",
  hasTimedResult: true,
  roundComplete: false,
}, manualPreviewNow);
assert.equal(
  committedPartialPicker.shipments.length,
  0,
  "a partial Picker preview must not create the first manual owner",
);
assert.equal(
  committedPartialPicker.pendingQueries[0]?.id,
  partialPickerPending.id,
  "the exact pending generation must own continuation of the unfinished round",
);
assert.equal(visibleShipments(committedPartialPicker, manualPreviewNow).length, 0);
assert.equal(loadWidgetSnapshot(manualPreviewNow)?.rows.length, 0);
assert.equal(
  JSON.stringify(committedPartialPicker).includes("快件运输中"),
  false,
  "the Picker payload must remain only in the current detail preview, not pending/business state",
);

function manualProviderShipment(
  provider: string,
  complete: boolean,
  eventAtMs: number,
  detail: string,
): Shipment {
  const timeline = {
    ...partialPickerTimeline,
    provider,
    courierCode: provider === "kuaidi100_h5" ? "ZTO" : "TEST",
    companyName: provider === "kuaidi100_h5" ? "中通快递" : "Carrier",
    complete,
    statusEventAtMs: eventAtMs,
    latestTimeText: "2026-09-01 14:30:00",
    latestDetail: detail,
    tracks: [{
      timeText: "2026-09-01 14:30:00",
      timeMs: eventAtMs,
      detail,
      statusCode: "TRANSIT",
      raw: provider === "kuaidi100_h5"
        ? { _pipiKuaidi100Com: "zhongtong" }
        : {},
    }],
    successAtMs: eventAtMs,
  };
  return {
    ...partialPickerShipment,
    timeline,
    manualTimelines: [timeline],
    updatedAtMs: eventAtMs,
  };
}

let motoStarted = false;
let kuaidi100StartedAfterMoto = false;
let kdniaoCalls = 0;
const revisionBeforeContinuation = committedPartialPicker.revision;
const continuedPartialPicker = await continueManualShipmentPreview({
  shipment: partialPickerShipment,
  pending: partialPickerPending,
  routeUrl: "",
  hasTimedResult: true,
  roundComplete: false,
}, {
  dependencies: {
    now: () => manualPreviewNow + 10,
    queryMoto: async () => {
      motoStarted = true;
      return manualProviderShipment(
        "local",
        false,
        manualPreviewNow + 1,
        "Moto 运输中",
      );
    },
    queryKuaidi100: async () => {
      kuaidi100StartedAfterMoto = motoStarted;
      return manualProviderShipment(
        "kuaidi100_h5",
        true,
        manualPreviewNow + 3,
        "K100 运输中",
      );
    },
    queryKdniao: async () => {
      kdniaoCalls++;
      return manualProviderShipment(
        "fallback",
        true,
        manualPreviewNow + 2,
        "快递鸟运输中",
      );
    },
  },
});
assert.equal(kuaidi100StartedAfterMoto, true);
assert.equal(kdniaoCalls, 1, "KDNiao runs when accumulated primary packages lack start evidence");
assert.equal(continuedPartialPicker.state.pendingQueries.length, 0);
assert.equal(continuedPartialPicker.state.shipments.length, 1);
assert.equal(
  continuedPartialPicker.state.revision,
  revisionBeforeContinuation + 1,
  "the owner and every provider sidecar must enter state in one transaction",
);
assert.deepEqual(
  continuedPartialPicker.shipment.manualTimelines?.map(
    (timeline) => timeline.provider,
  ).sort(),
  ["fallback", "kuaidi100_h5", "local", "route"],
);
assert.equal(
  selectShipmentDetailTimeline(continuedPartialPicker.shipment).provider,
  "kuaidi100_h5",
);

// A newer submit reuses the canonical pending id but owns a distinct
// generation. The older network round must not recreate or replace its row.
memory.clear();
commitManualShipmentPreview({
  shipment: partialPickerShipment,
  pending: partialPickerPending,
  routeUrl: "",
  hasTimedResult: true,
  roundComplete: false,
}, manualPreviewNow);
const replacementPending = {
  ...partialPickerPending,
  createdAtMs: partialPickerPending.createdAtMs + 1,
  lastAttemptAtMs: partialPickerPending.lastAttemptAtMs + 1,
  attempts: partialPickerPending.attempts + 1,
};
commitManualShipmentPreview({
  shipment: {
    ...partialPickerShipment,
    identity: {
      ...partialPickerShipment.identity,
      createdAtMs: replacementPending.createdAtMs,
    },
  },
  pending: replacementPending,
  routeUrl: "",
  hasTimedResult: true,
  roundComplete: false,
}, manualPreviewNow + 1);
await assert.rejects(
  continueManualShipmentPreview({
    shipment: partialPickerShipment,
    pending: partialPickerPending,
    routeUrl: "",
    hasTimedResult: true,
    roundComplete: false,
  }, {
    dependencies: {
      now: () => manualPreviewNow + 2,
      queryMoto: async () => manualProviderShipment(
        "local",
        false,
        manualPreviewNow + 2,
        "过期 Moto",
      ),
      queryKuaidi100: async () => null,
      queryKdniao: async () => null,
    },
  }),
  /已被移除或更新/,
);
const afterStaleContinuation = loadState(manualPreviewNow + 2);
assert.equal(afterStaleContinuation.shipments.length, 0);
assert.equal(
  afterStaleContinuation.pendingQueries[0]?.createdAtMs,
  replacementPending.createdAtMs,
);

memory.clear();
commitManualShipmentPreview(preview, manualPreviewNow);
const fallbackTimeline = {
  ...previewShipment.timeline,
  provider: "fallback",
  complete: true,
  semantic: "TRANSIT" as const,
  statusEventAtMs: manualPreviewNow,
  latestTimeText: "2026-09-01 14:00:00",
  latestDetail: "快件运输中",
  tracks: [{
    timeText: "2026-09-01 14:00:00",
    timeMs: manualPreviewNow,
    detail: "快件运输中",
    statusCode: "2",
    raw: {},
  }],
  successAtMs: manualPreviewNow,
};
const fallbackShipment: Shipment = {
  ...previewShipment,
  timeline: fallbackTimeline,
  manualTimelines: [fallbackTimeline],
  updatedAtMs: manualPreviewNow,
};
const promotedManualPreviewState = commitManualShipmentPreview({
  shipment: applyManualShipment(
    previewShipment,
    fallbackShipment,
    manualPreviewNow,
  ),
  pending: previewPending,
  routeUrl: "",
  hasTimedResult: true,
}, manualPreviewNow);
assert.equal(promotedManualPreviewState.pendingQueries.length, 0);
assert.equal(
  visibleShipments(promotedManualPreviewState, manualPreviewNow).length,
  1,
);
assert.equal(
  visibleShipments(
    promotedManualPreviewState,
    manualPreviewNow,
  )[0]?.timeline.tracks.length,
  1,
);
assert.equal(
  shipmentPresentationStatus(
    visibleShipments(promotedManualPreviewState, manualPreviewNow)[0]!,
  ).semantic,
  "TRANSIT",
  "a promoted manual timeline must retain its track-derived status",
);
const retainedAfterEmptyPreview = commitManualShipmentPreview(
  preview,
  manualPreviewNow + 1,
);
assert.equal(retainedAfterEmptyPreview.pendingQueries.length, 0);
assert.equal(
  visibleShipments(retainedAfterEmptyPreview, manualPreviewNow + 1)[0]
    ?.timeline.tracks.length,
  1,
  "a later empty Picker result must not replace a promoted manual timeline",
);

memory.clear();
const expiredHiddenPreview = saveState({
  ...emptyState(),
  pendingQueries: [previewPending],
  shipments: [previewShipment],
}, manualPreviewNow + PENDING_TTL_MS);
assert.equal(expiredHiddenPreview.pendingQueries.length, 0);
assert.equal(expiredHiddenPreview.shipments.length, 0);

// A freshly queried, already-old signed shipment stays available to its detail
// refresh without reappearing in the seven-day Home list. The internal owner
// expires on the same bounded window as a pending manual query.
memory.clear();
const oldSignedPreview = shipment({
  id: "interface5:manual:WBOLDSIGNED123",
  source: "interface5",
  manuallyAdded: true,
  semantic: "COMPLETED",
});
const oldSignedEventAtMs = manualPreviewNow - 8 * 24 * 60 * 60 * 1000;
oldSignedPreview.identity.createdAtMs = manualPreviewNow;
oldSignedPreview.timeline.statusEventAtMs = oldSignedEventAtMs;
oldSignedPreview.timeline.latestTimeText = "2026-08-24 08:42:00";
oldSignedPreview.timeline.latestDetail = "快件已签收";
oldSignedPreview.timeline.tracks = [{
  timeText: "2026-08-24 08:42:00",
  timeMs: oldSignedEventAtMs,
  detail: "快件已签收",
  statusCode: "3",
  raw: {},
}];
oldSignedPreview.manualTimelines = [oldSignedPreview.timeline];
const retainedOldSignedPreview = saveState({
  ...emptyState(),
  shipments: [oldSignedPreview],
}, manualPreviewNow);
assert.equal(retainedOldSignedPreview.shipments.length, 1);
assert.equal(visibleShipments(retainedOldSignedPreview, manualPreviewNow).length, 0);
const expiredOldSignedPreview = saveState(
  retainedOldSignedPreview,
  manualPreviewNow + PENDING_TTL_MS,
);
assert.equal(expiredOldSignedPreview.shipments.length, 0);

// A brand-new Home query may have no source-owned carrier code. An exact built-in
// recognition result dispatches the Picker preview adapter and remains available
// to the durable retry if that provider is temporarily unavailable.
memory.clear();
const unavailableRoutes: string[] = [];
const pendingOnlyPreview = await queryManualShipmentPreview({
  waybill: "PENDINGONLY123456",
  presentation: {
    courierCode: "YTO",
    companyName: "圆通速递",
    requiresPhoneTail: false,
  },
}, {
  post: async (route, payload) => {
    unavailableRoutes.push(route);
    assert.equal(typeof payload, "object");
    throw new Error("route unavailable");
  },
});
assert.equal(pendingOnlyPreview.shipment?.identity.manuallyAdded, true);
assert.equal(pendingOnlyPreview.shipment?.timeline.provider, "pending");
assert.equal(pendingOnlyPreview.shipment?.timeline.tracks.length, 0);
assert.equal(pendingOnlyPreview.pending?.courierCode, "YTO");
assert.equal(pendingOnlyPreview.pending?.companyName, "圆通速递");
assert.equal(pendingOnlyPreview.pending?.rawCourierCode, "YTO");
assert.equal(pendingOnlyPreview.roundComplete, false);
assert.equal(pendingOnlyPreview.pending?.awaitingRoundCompletion, true);
assert.deepEqual(new Set(unavailableRoutes), new Set([
  "/api/express/timeline/source",
]));
const pendingOnlyState = commitManualShipmentPreview(pendingOnlyPreview);
assert.equal(pendingOnlyState.shipments.length, 0);
assert.equal(visibleShipments(pendingOnlyState).length, 0);
assert.equal(pendingOnlyState.pendingQueries.length, 1);
assert.equal(pendingOnlyState.pendingQueries[0]?.rawCourierCode, "YTO");
assert.equal(
  pendingOnlyState.pendingQueries[0]?.awaitingRoundCompletion,
  true,
  "a foreground restart must resume an unfinished first round without waiting for retry cooldown",
);

memory.clear();
const recognitionFailurePreview = await queryManualShipmentPreview({
  waybill: "RECOGNITIONFAILED123",
  presentation: null,
}, {
  post: async () => {
    throw new Error("route unavailable");
  },
});
assert.equal(recognitionFailurePreview.shipment?.timeline.provider, "pending");
assert.equal(recognitionFailurePreview.pending?.courierCode, "");
assert.equal(recognitionFailurePreview.pending?.companyName, "");
assert.equal(
  commitManualShipmentPreview(recognitionFailurePreview).pendingQueries.length,
  1,
  "display recognition failure must still create a durable pending retry",
);
// Pending entries expire after 24 hours or when timestamped ahead.
memory.clear();
const pendingState: AppState = {
  ...emptyState(),
  pendingQueries: [
    pending({ id: "fresh" }),
    pending({ id: "attempt47", attempts: 47 }),
    pending({ id: "attempt48", attempts: 48 }),
    pending({ id: "expired", createdAtMs: NOW - PENDING_TTL_MS }),
    pending({ id: "future", createdAtMs: NOW + 1 }),
  ],
};
const pruned = saveState(pendingState, NOW);
assert.deepEqual(
  new Set(pruned.pendingQueries.map((item) => item.id)),
  new Set([
    "interface5:WBFRESH",
    "interface5:WBATTEMPT47",
    "interface5:WBATTEMPT48",
  ]),
);

// A widget execution must re-evaluate lifecycle retention instead of trusting an old snapshot.
memory.clear();
saveState({
  ...emptyState(),
  shipments: [shipment({
    id: "signed-widget",
    source: "interface5",
    semantic: "COMPLETED",
  })],
}, NOW);
assert.equal(loadWidgetSnapshot(NOW).rows.length, 1);
assert.equal(
  loadWidgetSnapshot(NOW + 7 * 24 * 60 * 60 * 1000).rows.length,
  0,
);

// A stale detail response may update only its target shipment. Source selection and a binding
// completed while the request was in flight must remain authoritative.
memory.clear();
const detailSeed = shipment({
  id: "detail-race",
  source: null,
  manuallyAdded: true,
});
const detailBase = saveState({
  ...emptyState(),
  shipments: [detailSeed],
}, NOW);
const detailOriginal = detailBase.shipments[0]!;
addBinding("interface5", phoneA, NOW + 2);
const detailIncomingTimeline: Shipment["timeline"] = {
  ...detailOriginal.timeline,
  semantic: "DELIVERY" as const,
  latestDetail: "DELIVERY",
  successAtMs: NOW + 3,
};
const detailIncoming: Shipment = {
  ...detailOriginal,
  timeline: detailIncomingTimeline,
  manualTimelines: [detailIncomingTimeline],
  updatedAtMs: NOW + 3,
};
const detailCommit = commitTargetShipmentRefresh(
  detailBase,
  detailIncoming,
  NOW + 3,
);
assert.equal(detailCommit.applied, true);
assert.equal(detailCommit.state.activeSource, "interface5");
assert.equal(
  detailCommit.state.bindings.some(
    (binding) => binding.source === "interface5" && binding.phone === phoneA,
  ),
  true,
);
assert.equal(
  detailCommit.state.shipments[0]?.timeline.semantic,
  "DELIVERY",
);

// A manual refresh attempt is durable before its network result exists, so a failed request is
// still throttled across subsequent script runtimes.
memory.clear();
const attemptBase = saveState({
  ...emptyState(),
  shipments: [detailOriginal],
}, NOW);
const attemptCommit = commitTargetShipmentRefresh(
  attemptBase,
  {
    ...attemptBase.shipments[0]!,
    cainiaoH5FallbackActivatedAtMs: NOW + 1,
    manualRefreshAttemptAtMs: NOW + 1,
    manualRefreshLease: {
      attemptId: "manual-failed-attempt",
      startedAtMs: NOW + 1,
      expiresAtMs: NOW + 10_001,
    },
  },
  NOW + 1,
);
assert.equal(attemptCommit.applied, true);
assert.equal(
  loadState(NOW + 2).shipments[0]?.cainiaoH5FallbackActivatedAtMs,
  NOW + 1,
);
assert.equal(
  loadState(NOW + 2).shipments[0]?.manualRefreshAttemptAtMs,
  NOW + 1,
);
assert.equal(
  loadState(NOW + 2).shipments[0]?.manualRefreshLease?.attemptId,
  "manual-failed-attempt",
);
const competingAttempt = commitTargetShipmentRefresh(
  attemptBase,
  {
    ...attemptBase.shipments[0]!,
    manualRefreshAttemptAtMs: NOW + 2,
    manualRefreshLease: {
      attemptId: "manual-competing-attempt",
      startedAtMs: NOW + 2,
      expiresAtMs: NOW + 10_002,
    },
  },
  NOW + 2,
);
assert.equal(competingAttempt.applied, false);
assert.equal(
  competingAttempt.state.shipments[0]?.manualRefreshLease?.attemptId,
  "manual-failed-attempt",
);
const failedAttempt = loadState(NOW + 2).shipments[0]!;
const releaseCommit = commitTargetShipmentRefresh(
  attemptCommit.state,
  releaseManualRefreshLease(failedAttempt, "manual-failed-attempt"),
  NOW + 3,
);
assert.equal(releaseCommit.applied, true);
const releasedFailedAttempt = loadState(NOW + 4).shipments[0]!;
assert.equal(releasedFailedAttempt.manualRefreshLease, undefined);
assert.equal(releasedFailedAttempt.manualRefreshAttemptAtMs, NOW + 1);
assert.equal(
  shouldScheduleManualRefresh(releasedFailedAttempt, NOW + 30_000),
  false,
);
assert.equal(
  shouldScheduleManualRefresh(releasedFailedAttempt, NOW + 30_001),
  true,
);

// A stale detail response cannot revive a removed shipment or overwrite a newer same-row update,
// even if the newer row accidentally reuses the same millisecond timestamp.
memory.clear();
const deletedBase = saveState({
  ...emptyState(),
  shipments: [detailOriginal],
}, NOW);
removeShipment(detailOriginal.identity.id, NOW + 1);
const deletedCommit = commitTargetShipmentRefresh(
  deletedBase,
  detailIncoming,
  NOW + 2,
);
assert.equal(deletedCommit.applied, false);
assert.equal(deletedCommit.state.shipments.length, 0);

memory.clear();
const changedBase = saveState({
  ...emptyState(),
  shipments: [detailOriginal],
}, NOW);
const concurrent = {
  ...detailOriginal,
  timeline: { ...detailOriginal.timeline, latestDetail: "NEWER" },
  updatedAtMs: detailOriginal.updatedAtMs,
};
upsertShipment(concurrent, NOW + 1);
const changedCommit = commitTargetShipmentRefresh(
  changedBase,
  detailIncoming,
  NOW + 2,
);
assert.equal(changedCommit.applied, false);
assert.equal(changedCommit.state.shipments[0]?.timeline.latestDetail, "NEWER");

// A user-forced completion is durable, stops refreshes, survives later source updates, and does
// not fabricate or rewrite provider timeline nodes.
memory.clear();
const forcedSeed = shipment({
  id: "force-complete",
  source: "interface5",
  semantic: "TRANSIT",
});
const forcedTracks = structuredClone(forcedSeed.timeline.tracks);
const forceBase = saveState({
  ...emptyState(),
  shipments: [forcedSeed],
}, NOW);
const forced = forceCompleteShipment(forcedSeed.identity.id, NOW + 1);
assert.equal(forced.shipments[0]?.forcedCompletedAtMs, NOW + 1);
assert.equal(forced.shipments[0]?.timeline.semantic, "COMPLETED");
assert.equal(forced.shipments[0]?.timeline.statusEventAtMs, NOW + 1);
assert.deepEqual(forced.shipments[0]?.timeline.tracks, forcedTracks);
assert.equal(shouldRefreshShipment(forced.shipments[0]!, NOW + 2), false);
const repeatedForce = forceCompleteShipment(forcedSeed.identity.id, NOW + 2);
assert.equal(repeatedForce.revision, forced.revision);

const sourceUpdate = {
  ...forceBase.shipments[0]!,
  timeline: {
    ...forceBase.shipments[0]!.timeline,
    provider: "interface5",
    semantic: "DELIVERY" as const,
    latestDetail: "正在派送",
    successAtMs: NOW + 3,
  },
  sourceTimeline: {
    ...forceBase.shipments[0]!.timeline,
    provider: "interface5",
    semantic: "DELIVERY" as const,
    latestDetail: "正在派送",
    successAtMs: NOW + 3,
  },
  updatedAtMs: NOW + 3,
};
const afterSourceUpdate = upsertShipment(sourceUpdate, NOW + 3);
assert.equal(afterSourceUpdate.shipments[0]?.forcedCompletedAtMs, NOW + 1);
assert.equal(afterSourceUpdate.shipments[0]?.timeline.semantic, "COMPLETED");
assert.equal(afterSourceUpdate.shipments[0]?.timeline.latestDetail, "正在派送");

// Publishing a route pointer rebases onto the latest user state instead of restoring the stale
// source and binding snapshot captured before the Keychain transaction.
memory.clear();
const routeBase = saveState({
  ...emptyState(),
  shipments: [{
    ...detailOriginal,
    identity: { ...detailOriginal.identity, sourceProvider: "CaiNiao" },
  }],
}, NOW);
addBinding("interface5", phoneA, NOW + 2);
const routeCandidate = {
  ...routeBase,
  shipments: routeBase.shipments.map((item) => ({
    ...item,
    route: { kind: "cainiao" as const, source: "interface5" as const },
  })),
};
const routeCommit = commitRoutePointers(
  routeBase,
  routeCandidate,
  [{ owner: "shipment", targetId: detailOriginal.identity.id }],
  NOW + 3,
);
assert.equal(routeCommit.activeSource, "interface5");
assert.equal(routeCommit.bindings.length, 1);
assert.deepEqual(routeCommit.shipments[0]?.route, {
  kind: "cainiao",
  source: "interface5",
});

// The route sidecar must survive the old-state reads required to publish its pointer.
memory.clear();
const routeTransactionBase = saveState({
  ...emptyState(),
  shipments: [{
    ...detailOriginal,
    identity: { ...detailOriginal.identity, sourceProvider: "CaiNiao" },
  }],
}, NOW);
const routeTransactionCandidate = {
  ...routeTransactionBase,
  shipments: routeTransactionBase.shipments.map((item) => ({
    ...item,
    route: { kind: "cainiao" as const, source: "interface5" as const },
  })),
};
const routeTransactionCommit = commitShipmentRouteMutations(
  [{
    key: `shipment:${detailOriginal.identity.id}`,
    kind: "save",
    targetId: detailOriginal.identity.id,
    source: "interface5",
    url: "https://page.cainiao.com/detail?mailNo=TRANSACTION",
  }],
  (publications) => commitRoutePointers(
    routeTransactionBase,
    routeTransactionCandidate,
    publications.map((publication) => ({
      owner: "shipment" as const,
      targetId: publication.targetId,
    })),
    NOW + 1,
  ),
  NOW + 1,
);
assert.deepEqual(routeTransactionCommit?.shipments[0]?.route, {
  kind: "cainiao",
  source: "interface5",
});
assert.equal(
  loadShipmentRoute(detailOriginal.identity.id, "interface5", NOW + 1),
  "https://page.cainiao.com/detail?mailNo=TRANSACTION",
);

upsertShipment(
  {
    ...routeCommit.shipments[0]!,
    timeline: { ...routeCommit.shipments[0]!.timeline, latestDetail: "CHANGED" },
  },
  NOW + 4,
);
assert.throws(
  () => commitRoutePointers(
    routeCommit,
    {
      ...routeCommit,
      shipments: routeCommit.shipments.map((item) => ({
        ...item,
        route: null,
      })),
    },
    [{ owner: "shipment", targetId: detailOriginal.identity.id }],
    NOW + 5,
  ),
  /快递状态已更新/,
);

// A provider transition first removes the durable pointer, then prunes its encrypted route.
memory.clear();
const providerRouteSeed = shipment({ id: "provider-route", source: "interface5" });
providerRouteSeed.identity.sourceProvider = "CaiNiao";
providerRouteSeed.route = { kind: "cainiao", source: "interface5" };
assert.equal(
  saveShipmentRoute(
    providerRouteSeed.identity.id,
    "interface5",
    "https://page.cainiao.com/detail?mailNo=TEST",
    NOW,
  ),
  true,
);
saveState({ ...emptyState(), shipments: [providerRouteSeed] }, NOW);
assert.notEqual(
  loadShipmentRoute(providerRouteSeed.identity.id, "interface5", NOW),
  "",
);
const afterProviderTransition = upsertShipment({
  ...providerRouteSeed,
  identity: { ...providerRouteSeed.identity, sourceProvider: "ShunFeng" },
  timeline: { ...providerRouteSeed.timeline, provider: "interface5" },
  sourceTimeline: { ...providerRouteSeed.timeline, provider: "interface5" },
  updatedAtMs: NOW + 1,
}, NOW + 1);
assert.equal(afterProviderTransition.shipments[0]?.route, null);
assert.equal(
  loadShipmentRoute(providerRouteSeed.identity.id, "interface5", NOW + 1),
  "",
);

// Automatic K100 caches created before response-carrier validation must not
// survive state normalization or replace the Xiaomi account timeline.
memory.clear();
const legacyK100Seed = shipment({ id: "legacy-k100", source: "interface5" });
legacyK100Seed.identity.sourceProvider = "JingDong";
legacyK100Seed.identity.accountOrder = true;
legacyK100Seed.identity.projectedWaybill = "JDLEGACY123456";
legacyK100Seed.sourceTimeline = {
  ...legacyK100Seed.timeline,
  provider: "interface5",
  waybill: "JDLEGACY123456",
  courierCode: "JD",
  companyName: "京东快递",
};
const legacyK100Timeline = {
  ...legacyK100Seed.timeline,
  provider: "kuaidi100_h5",
  waybill: "JDLEGACY123456",
  courierCode: "JD",
  companyName: "京东快递",
};
legacyK100Seed.timeline = legacyK100Timeline;
legacyK100Seed.manualTimelines = [legacyK100Timeline];
saveState({ ...emptyState(), shipments: [legacyK100Seed] }, NOW);
const normalizedLegacyK100 = loadState(NOW).shipments[0]!;
assert.equal(normalizedLegacyK100.timeline.provider, "interface5");
assert.equal(normalizedLegacyK100.manualTimelines?.length, 0);

// Historical Meizu provider errors are removed during every state load while
// legitimate sibling events remain available in the same provider package.
memory.clear();
const legacyMeizuSeed = shipment({ id: "legacy-meizu-error", source: "interface5" });
const legacyMeizuTimeline = {
  ...legacyMeizuSeed.timeline,
  provider: "route",
  complete: true,
  structuredStatus: true,
  semantic: "COMPLETED" as const,
  statusEventAtMs: NOW - 1_000,
  tracks: [
    {
      timeText: "2026-09-02 10:45:00",
      timeMs: NOW - 2_000,
      detail: "验证码错误，请重试",
      statusCode: "SIGN",
      raw: { _pipiStatusSource: "meizu" },
    },
    {
      timeText: "2026-09-02 10:46:00",
      timeMs: NOW - 1_000,
      detail: "快件运输中",
      statusCode: "TRANSIT",
      raw: { _pipiStatusSource: "meizu" },
    },
  ],
  latestTimeText: "2026-09-02 10:46:00",
  latestDetail: "快件运输中",
};
legacyMeizuSeed.manualTimelines = [legacyMeizuTimeline];
memory.set(STATE_KEY, storedState({
  ...emptyState(),
  revision: 7,
  updatedAtMs: NOW - 1,
  shipments: [legacyMeizuSeed],
}, 2));
const healedMeizu = loadState(NOW).shipments[0]!;
const healedMeizuTimeline = healedMeizu.manualTimelines?.find(
  (timeline) => timeline.provider === "route",
)!;
assert.deepEqual(
  healedMeizuTimeline.tracks.map((track) => track.detail),
  ["快件运输中"],
);
assert.equal(healedMeizuTimeline.complete, false);
assert.equal(healedMeizuTimeline.structuredStatus, false);
assert.equal(healedMeizuTimeline.semantic, "UNKNOWN");
assert.equal(healedMeizuTimeline.statusEventAtMs, null);
const healedMeizuAgain = loadState(NOW).shipments[0]!.manualTimelines?.find(
  (timeline) => timeline.provider === "route",
)!;
assert.deepEqual(
  healedMeizuAgain.tracks.map((track) => track.detail),
  ["快件运输中"],
);
assert.equal(healedMeizuAgain.semantic, "UNKNOWN");
assert.equal(healedMeizuAgain.statusEventAtMs, null);

// Refresh metadata alone must not create a new durable revision. A real
// timeline change still commits normally.
memory.clear();
const deltaSeedShipment = shipment({ id: "delta-aware", source: "interface5" });
const deltaBase = saveState({
  ...emptyState(),
  shipments: [deltaSeedShipment],
}, NOW);
const volatileOnly = structuredClone(deltaBase.shipments[0]);
volatileOnly.updatedAtMs = NOW + 10;
volatileOnly.timeline.successAtMs = NOW + 10;
if (volatileOnly.sourceTimeline) {
  volatileOnly.sourceTimeline.successAtMs = NOW + 10;
}
const volatileTargetCommit = commitTargetShipmentRefresh(
  deltaBase,
  volatileOnly,
  NOW + 10,
);
assert.equal(volatileTargetCommit.applied, true);
assert.equal(volatileTargetCommit.state.revision, deltaBase.revision);

const volatileRefreshCandidate = structuredClone(deltaBase);
volatileRefreshCandidate.shipments[0] = volatileOnly;
const volatileFullCommit = commitRefreshState(
  deltaBase,
  volatileRefreshCandidate,
  "interface5",
  NOW + 11,
);
assert.equal(volatileFullCommit.applied, true);
assert.equal(volatileFullCommit.state.revision, deltaBase.revision);

const changedTimeline = structuredClone(deltaBase.shipments[0]);
changedTimeline.timeline.latestDetail = "运输状态发生变化";
changedTimeline.timeline.tracks[0].detail = "运输状态发生变化";
if (changedTimeline.sourceTimeline) {
  changedTimeline.sourceTimeline.latestDetail = "运输状态发生变化";
  changedTimeline.sourceTimeline.tracks[0].detail = "运输状态发生变化";
}
const changedTargetCommit = commitTargetShipmentRefresh(
  deltaBase,
  changedTimeline,
  NOW + 12,
);
assert.equal(changedTargetCommit.applied, true);
assert.equal(changedTargetCommit.state.revision, deltaBase.revision + 1);

console.log("storage migration and isolation tests passed");
