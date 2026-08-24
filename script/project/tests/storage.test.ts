import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type {
  AppState,
  BindingSource,
  PendingManualQuery,
  Shipment,
  StatusSemantic,
} from "../models";

const NOW = Date.UTC(2026, 7, 26, 6, 0, 0);
const STATE_KEY = "pipi_deliveries_state_v1";
const ROUTES_KEY = "keychain:pipi_deliveries_routes_v1";
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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
  isImportSuppressed,
  isWaybillTombstoned,
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
const { prepareManualPreview } = await import("../services/manual-preview");
const { shouldRefreshShipment } = await import("../services/status");
const {
  releaseManualRefreshLease,
  shouldScheduleManualRefresh,
} = await import("../services/shipment-policy");

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

// A damaged primary envelope must never be exposed; the independently checked shared copy wins.
memory.set(STATE_KEY, { ...storedState(legacyState, 1), checksum: "bad" });
const recoveredLegacy = loadState(NOW);
assert.equal(recoveredLegacy.revision, 7);
assert.equal(
  recoveredLegacy.shipments[0]?.identity.id,
  "interface5:manual:WBLEGACY",
);

// Legacy mixed-source state converges once into the script's account namespace. Matching account
// rows absorb retired-source history, unmatched rows remain local history, and user-created rows,
// pending queries, provider authority, suppressions, and valid route pointers remain intact.
memory.clear();
const source6 = shipment({ id: "source6", source: "interface6" });
const source5 = shipment({ id: "source5", source: "interface5" });
const source6Only = shipment({ id: "source6-only", source: "interface6" });
const manual6 = shipment({ id: "manual6", source: "interface6", manuallyAdded: true });
const manual5 = shipment({ id: "manual5", source: "interface5", manuallyAdded: true });
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
const retainedTombstone = {
  waybillHash: "a".repeat(64),
  reason: "manual_delete" as const,
  createdAtMs: NOW - 10,
};
const mixedState: AppState = {
  ...emptyState(),
  activeSource: "interface6",
  bindings: [
    { source: "interface5", phone: "13800138000", boundAtMs: NOW - 3 },
    { source: "interface6", phone: "13900139000", boundAtMs: NOW - 2 },
  ],
  suppressions: [
    {
      kind: "deleted",
      source: "interface5",
      sourceIdHash: sha256("legacy-owner"),
      phoneHash: sha256("13800138000"),
      createdAtMs: NOW - 3,
    },
    {
      kind: "deleted",
      source: "interface6",
      sourceIdHash: sha256("legacy-owner"),
      phoneHash: sha256("13800138000"),
      createdAtMs: NOW - 2,
    },
    {
      kind: "deleted",
      source: "interface6",
      sourceIdHash: "d".repeat(64),
      phoneHash: "e".repeat(64),
      createdAtMs: NOW - 1,
    },
  ],
  tombstones: [retainedTombstone],
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
assert.equal(isolated.suppressions.length, 2);
assert.equal(
  isolated.suppressions.every((item) => item.source === "interface5"),
  true,
);
assert.equal(
  isImportSuppressed(
  isolated,
  "interface5",
  "legacy-owner",
  "13800138000",
  ),
  true,
);
assert.equal(
  isolated.suppressions.find(
    (item) => item.sourceIdHash === sha256("legacy-owner"),
  )?.createdAtMs,
  NOW - 3,
);
assert.deepEqual(isolated.tombstones, [retainedTombstone]);
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
const reboundMigratedSuppression = addBinding(
  "interface5",
  "13800138000",
  NOW + 1,
);
assert.equal(isImportSuppressed(
  reboundMigratedSuppression,
  "interface5",
  "legacy-owner",
  "13800138000",
), false);

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
const importedSuppression = {
  kind: "deleted" as const,
  source: "interface5" as const,
  sourceIdHash: "6".repeat(64),
  phoneHash: "7".repeat(64),
  createdAtMs: NOW + 2,
};
const importedTombstone = {
  waybillHash: "8".repeat(64),
  reason: "manual_delete" as const,
  createdAtMs: NOW + 2,
};
saveState({
  ...importedBeforeReload,
  suppressions: [...importedBeforeReload.suppressions, importedSuppression],
  tombstones: [...importedBeforeReload.tombstones, importedTombstone],
}, NOW + 3);
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
assert.deepEqual(restoredAfterImport.suppressions, [importedSuppression]);
assert.deepEqual(restoredAfterImport.tombstones, [importedTombstone]);

// Unbinding removes every row with matching phone evidence in that source,
// preserves unrelated/manual rows without evidence, and suppresses only automatic owners.
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
  new Set(["owner-b"]),
);
assert.equal(
  unbound.bindings.some(
    (binding) => binding.source === "interface5" && binding.phone === phoneA,
  ),
  false,
);
assert.equal(isImportSuppressed(
  unbound,
  "interface5",
  ownerA.identity.sourceId,
  phoneA,
), true);
assert.deepEqual(
  new Set(unbound.pendingQueries.map((item) => item.waybill)),
  new Set(["WBPENDINGNOTAIL"]),
);

// A suppression without phone evidence is a source-scoped wildcard for the same owner.
memory.clear();
const noPhone = shipment({ id: "no-phone", source: "interface5" });
saveState({
  ...emptyState(),
  bindings: [{ source: "interface5", phone: phoneA, boundAtMs: NOW }],
  shipments: [noPhone],
}, NOW);
const noPhoneUnbound = removeBinding("interface5", phoneA, NOW + 1);
assert.equal(isImportSuppressed(
  noPhoneUnbound,
  "interface5",
  noPhone.identity.sourceId,
  phoneB,
), true);

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
const staleCandidate = {
  ...raceBase,
  shipments: [refreshedOwner, refreshedManual],
};
removeBinding("interface5", phoneA, NOW + 2);
removeShipment(raceManual.identity.id, NOW + 3);
const rebased = commitRefreshState(
  raceBase,
  staleCandidate,
  "interface5",
  NOW + 5,
).state;
assert.equal(rebased.activeSource, "interface5");
assert.equal(rebased.bindings.length, 0);
assert.equal(rebased.shipments.some((item) => item.identity.id === "race-owner"), false);
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
projectionSeed.timeline.waybill = "ORDER20260826002";
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

// Older script builds persisted the order-stage label after a JD waybill had been projected.
// Loading or saving that state must heal every presentation surface to the carrier identity.
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
assert.equal(healedProjectedJd.identity.courierCode, "JD");
assert.equal(healedProjectedJd.identity.companyName, "京东快递");

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

// Removing a visible shipment must also remove its matching invisible pending
// retry, otherwise a later retry can recreate the deleted row.
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
assert.equal(
  isWaybillTombstoned(afterDelete, deletionTarget.timeline.waybill),
  true,
);
upsertShipment({ ...deletionTarget, updatedAtMs: NOW + 2 }, NOW + 2);
upsertPendingQuery(pending({
  id: "cross-source-retry",
  source: "interface5",
  waybill: deletionTarget.timeline.waybill,
}), NOW + 3);
const afterResurrectionAttempts = loadState(NOW + 3);
assert.equal(
  afterResurrectionAttempts.shipments.some(
    (item) => item.timeline.waybill === deletionTarget.timeline.waybill,
  ),
  false,
);
assert.equal(
  afterResurrectionAttempts.pendingQueries.some(
    (item) => item.waybill === deletionTarget.timeline.waybill,
  ),
  false,
);

// Projected account orders tombstone only their owner identity. The extracted carrier waybill
// remains available as an independent manual shipment, matching Android's row ownership.
memory.clear();
const projectedOrder = shipment({ id: "projected-order", source: "interface5" });
projectedOrder.identity.sourceId = "ORDER20260826001";
projectedOrder.identity.orderId = "ORDER20260826001";
projectedOrder.identity.projectedWaybill = "SF1234567890123";
projectedOrder.identity.accountOrder = true;
projectedOrder.timeline.waybill = "ORDER20260826001";
saveState({ ...emptyState(), shipments: [projectedOrder] }, NOW);
const deletedOrder = removeShipment(projectedOrder.identity.id, NOW + 1);
assert.equal(isWaybillTombstoned(deletedOrder, "ORDER20260826001"), true);
assert.equal(isWaybillTombstoned(deletedOrder, "SF1234567890123"), false);
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

// A signed row crossing retention creates the same durable tombstone as manual deletion.
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
assert.equal(isWaybillTombstoned(expiredState, expiredSigned.identity.sourceId), true);
upsertShipment({ ...expiredSigned, updatedAtMs: NOW + 1 }, NOW + 1);
assert.equal(loadState(NOW + 1).shipments.length, 0);

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
  id: "untimed-preview",
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
});
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
  true,
);
// Pending entries expire only at seven days or when timestamped ahead.
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
    semantic: "DELIVERY" as const,
    latestDetail: "正在派送",
    successAtMs: NOW + 3,
  },
  sourceTimeline: {
    ...forceBase.shipments[0]!.timeline,
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
  shipments: [detailOriginal],
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

console.log("storage migration and isolation tests passed");
