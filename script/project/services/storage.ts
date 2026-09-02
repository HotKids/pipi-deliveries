import type {
  AccountBinding,
  AppState,
  BindingSource,
  PendingManualQuery,
  Shipment,
  TimelinePackage,
  WidgetSnapshot,
} from "../models";
import {
  buildWidgetSnapshot,
  isProviderErrorDetail,
  normalizeWaybill,
  normalizedProjectedWaybill,
  pruneShipments,
  sortShipments,
  timedTracks,
} from "./status";
import {
  absorbHistoricalShipment,
  applyAccountShipment,
  applyManualShipment,
  automaticSourceOf,
  displayWaybill,
  invalidateAutomaticOwner,
  isHistoricalAccountDuplicate,
  isVerifiedKuaidi100Timeline,
  normalizeAutomaticOwnership,
  selectShipmentTimeline,
} from "./shipment-policy";
import { projectedCarrierPresentation } from "./carrier-presentation";
import { isJingDongAccountOrder } from "./account-parser";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";
import {
  diagnosticState,
  writeDiagnostic,
} from "./logger";
import {
  loadBindingBackup,
  saveBindingBackup,
} from "./binding-backup";
import {
  SCRIPT_BINDING_SOURCE,
  requireScriptSource,
} from "./script-source";
import {
  migrateLegacyShipmentRoutes,
  pruneOrderProjectionReferences,
  pruneShipmentRoutes,
  type LegacyShipmentRouteMigration,
} from "./routes";
import {
  readDurableTextResult,
  writeDurableText,
} from "./durable-files";
import { utf8Data } from "./scripting-data";

const STATE_KEY = "pipi_deliveries_state_v1";
const STATE_BACKUP_KEY = "pipi_deliveries_state_backup_v1";
const STATE_DURABLE_SLOT_A = "state-v3-a.json";
const STATE_DURABLE_SLOT_B = "state-v3-b.json";
const PENDING_TTL_MS = EXPRESS_POLICY.pendingQueries.ttlMs;

type LegacyAppState = {
  version: 1;
  revision: number;
  updatedAtMs: number;
  shipments: readonly Shipment[];
};

type LegacyStoredState = {
  schema: 1 | 2;
  checksum: string;
  state: LegacyAppState | AppState;
};

type StoredStateEnvelope = {
  schema: 3;
  checksum: string;
  payload: string;
};

type EncodedState = {
  serialized: string;
  checksum: string;
  state: AppState;
};

function phone(value: unknown): string {
  const digits = String(value || "").replace(/\D/g, "");
  return /^1[3-9]\d{9}$/.test(digits) ? digits : "";
}

function uniqueBindings(values: readonly AccountBinding[]): AccountBinding[] {
  const result = new Map<string, AccountBinding>();
  for (const value of values) {
    const normalizedPhone = phone(value?.phone);
    if (!normalizedPhone || value?.source !== SCRIPT_BINDING_SOURCE) continue;
    result.set(normalizedPhone, {
      source: SCRIPT_BINDING_SOURCE,
      phone: normalizedPhone,
      boundAtMs:
        typeof value.boundAtMs === "number" && Number.isFinite(value.boundAtMs)
          ? value.boundAtMs
          : 0,
    });
  }
  return [...result.values()];
}

function prunePending(
  values: readonly PendingManualQuery[],
  now: number,
): PendingManualQuery[] {
  return values.filter(
    (value) =>
      Boolean(value?.id && value.waybill) &&
      value.createdAtMs > 0 &&
      value.createdAtMs <= now &&
      now - value.createdAtMs < PENDING_TTL_MS,
  );
}

function hasTimedShipmentAuthority(shipment: Shipment): boolean {
  return [
    shipment.timeline,
    ...(shipment.sourceTimeline ? [shipment.sourceTimeline] : []),
    ...(shipment.manualTimelines || []),
  ].some((timeline) => timedTracks(timeline.tracks).length > 0);
}

function pruneExpiredManualPlaceholders(
  shipments: readonly Shipment[],
  now: number,
): Shipment[] {
  return shipments.filter((shipment) => {
    if (!shipment.identity.manuallyAdded || hasTimedShipmentAuthority(shipment)) {
      return true;
    }
    const createdAtMs = Number(shipment.identity.createdAtMs);
    return !Number.isFinite(createdAtMs) || createdAtMs <= 0 ||
      now - createdAtMs < PENDING_TTL_MS;
  });
}

function pruneOrderProjectionReferencesForState(
  state: AppState,
  now: number,
): void {
  try {
    pruneOrderProjectionReferences(
      state.shipments.flatMap((shipment) => {
        const source = shipment.identity.bindingSource;
        return shipment.identity.accountOrder &&
            source === SCRIPT_BINDING_SOURCE
          ? [{ ownerId: shipment.identity.id, source }]
          : [];
      }),
      now,
    );
  } catch {
    /* encrypted projection references remain unavailable and expire automatically */
  }
}

function pruneShipmentRoutesForState(state: AppState, now: number): void {
  try {
    pruneShipmentRoutes([
      ...state.shipments
        .filter((shipment) => Boolean(shipment.route))
        .map((shipment) => shipment.identity.id),
      ...state.pendingQueries
        .filter((pending) => Boolean(pending.route))
        .map((pending) => pending.id),
    ], now);
  } catch {
    /* encrypted routes remain unavailable and expire automatically */
  }
}

export function emptyState(): AppState {
  return {
    version: 2,
    revision: 0,
    updatedAtMs: 0,
    activeSource: SCRIPT_BINDING_SOURCE,
    bindings: [],
    pendingQueries: [],
    shipments: [],
  };
}

function hashText(value: string): string {
  return Crypto.sha256(utf8Data(value)).toHexString().toLowerCase();
}

function stableJson(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(item as Record<string, unknown>).sort()) {
      sorted[key] = (item as Record<string, unknown>)[key];
    }
    return sorted;
  });
  if (typeof serialized !== "string") throw new Error("状态数据无法序列化");
  return serialized;
}

function checksum(value: unknown): string {
  return hashText(stableJson(value));
}

function legacyChecksum(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function encodeState(state: AppState): EncodedState {
  const payload = stableJson(state);
  const checksum = hashText(payload);
  const envelope: StoredStateEnvelope = { schema: 3, checksum, payload };
  return {
    serialized: JSON.stringify(envelope),
    checksum,
    state: JSON.parse(payload) as AppState,
  };
}

function isLegacyState(value: unknown): value is LegacyAppState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<LegacyAppState>;
  return (
    state.version === 1 &&
    typeof state.revision === "number" &&
    typeof state.updatedAtMs === "number" &&
    Array.isArray(state.shipments)
  );
}

function isCurrentState(value: unknown): value is AppState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<AppState>;
  return (
    state.version === 2 &&
    typeof state.revision === "number" &&
    typeof state.updatedAtMs === "number" &&
    (state.activeSource === "interface5" || state.activeSource === "interface6") &&
    Array.isArray(state.bindings) &&
    Array.isArray(state.pendingQueries) &&
    Array.isArray(state.shipments)
  );
}

function migrate(value: LegacyAppState | AppState, now: number): AppState {
  const base = isCurrentState(value)
    ? value
    : {
        ...emptyState(),
        revision: value.revision,
        updatedAtMs: value.updatedAtMs,
        shipments: value.shipments,
      };
  const retainedShipments = pruneExpiredManualPlaceholders(
    retainDurableShipments(
      migrateShipmentSources(base.shipments || []).map(normalizeShipmentAuthorities),
      now,
    ),
    now,
  );
  return {
    version: 2,
    revision: base.revision,
    updatedAtMs: base.updatedAtMs,
    activeSource: SCRIPT_BINDING_SOURCE,
    bindings: uniqueBindings(base.bindings || []),
    pendingQueries: prunePending(
      migratePendingSources(base.pendingQueries || []),
      now,
    ),
    shipments: sortShipments(retainedShipments),
  };
}

function mirrorBindingBackup(state: AppState): void {
  const backup = loadBindingBackup();
  if (
    backup &&
    stableJson(uniqueBindings(backup.bindings)) ===
      stableJson(uniqueBindings(state.bindings))
  ) return;
  try {
    saveBindingBackup(state.activeSource, state.bindings);
  } catch {
    /* the durable state remains authoritative; a later load retries the mirror */
  }
}

function restoreInitialBindingBackup(state: AppState): AppState {
  const backup = loadBindingBackup();
  if (!backup) return state;
  return {
    ...state,
    activeSource: SCRIPT_BINDING_SOURCE,
    bindings: uniqueBindings(backup.bindings),
  };
}

type LegacyBindingRecovery = {
  state: AppState;
  durable: boolean;
};

function restoreLegacyBindingBackup(state: AppState): LegacyBindingRecovery {
  const backup = loadBindingBackup();
  const bindings = uniqueBindings([
    ...(backup?.bindings || []),
    ...state.bindings,
  ]);
  if (!backup || stableJson(bindings) !== stableJson(backup.bindings)) {
    try {
      saveBindingBackup(SCRIPT_BINDING_SOURCE, bindings);
    } catch {
      return {
        state: {
          ...state,
          activeSource: SCRIPT_BINDING_SOURCE,
          bindings,
        },
        durable: false,
      };
    }
  }
  return {
    state: {
      ...state,
      activeSource: SCRIPT_BINDING_SOURCE,
      bindings,
    },
    durable: true,
  };
}

function migrateShipmentSource(shipment: Shipment): Shipment | null {
  const bindingSource = shipment.identity?.bindingSource;
  const manuallyAdded = Boolean(shipment.identity?.manuallyAdded);
  if (
    !manuallyAdded &&
    bindingSource !== SCRIPT_BINDING_SOURCE &&
    bindingSource !== "interface6" &&
    bindingSource != null
  ) return null;

  const migrateManual = manuallyAdded && bindingSource !== SCRIPT_BINDING_SOURCE;
  const migrateHistoricalAccount = !manuallyAdded &&
    bindingSource !== SCRIPT_BINDING_SOURCE;
  const canonicalWaybill = manuallyAdded
    ? displayWaybill(shipment)
    : "";
  if (manuallyAdded && !canonicalWaybill) return null;
  const canonicalId = manuallyAdded
    ? `${SCRIPT_BINDING_SOURCE}:manual:${canonicalWaybill}`
    : shipment.identity.id;
  const existingProjectedWaybill = normalizedProjectedWaybill(shipment.identity);
  const repairsJingDongOrder = Boolean(
    !manuallyAdded &&
      !shipment.identity.accountOrder &&
      !existingProjectedWaybill &&
      isJingDongAccountOrder(
        shipment.identity.sourceId,
        String(shipment.identity.sourceProvider || ""),
        shipment.statusPresentation?.scope || "",
        [
          shipment.timeline.latestDetail,
          ...(shipment.sourceTimeline?.tracks || shipment.timeline.tracks)
            .map((track) => track.detail),
        ],
      ),
  );
  const projectedWaybill = repairsJingDongOrder
    ? ""
    : existingProjectedWaybill;
  const rawProjectionRetry = shipment.identity.orderProjectionRetry;
  const routeHash = String(rawProjectionRetry?.routeHash || "")
    .trim()
    .toLowerCase();
  const failedAtMs = Number(rawProjectionRetry?.failedAtMs);
  const rawAttemptId = String(rawProjectionRetry?.attemptId || "").trim();
  const rawAttemptExpiresAtMs = Number(
    rawProjectionRetry?.attemptExpiresAtMs,
  );
  const attemptId = /^[a-z0-9-]{8,80}$/.test(rawAttemptId)
    ? rawAttemptId
    : undefined;
  const attemptExpiresAtMs = attemptId &&
      Number.isFinite(rawAttemptExpiresAtMs) &&
      rawAttemptExpiresAtMs > 0
    ? rawAttemptExpiresAtMs
    : undefined;
  const validFailedAtMs = Number.isFinite(failedAtMs) && failedAtMs > 0
    ? failedAtMs
    : undefined;
  const orderProjectionRetry =
    !projectedWaybill &&
      /^[a-f0-9]{64}$/.test(routeHash) &&
      (validFailedAtMs != null || (attemptId && attemptExpiresAtMs))
      ? {
          routeHash,
          ...(validFailedAtMs != null ? { failedAtMs: validFailedAtMs } : {}),
          ...(attemptId && attemptExpiresAtMs
            ? { attemptId, attemptExpiresAtMs }
            : {}),
        }
      : undefined;
  const projectedPresentation = projectedWaybill
    ? projectedCarrierPresentation(
        projectedWaybill,
        shipment.identity.courierCode,
        shipment.identity.companyName,
      )
    : null;
  const rawForcedCompletedAtMs = Number(shipment.forcedCompletedAtMs);
  const forcedCompletedAtMs =
    Number.isFinite(rawForcedCompletedAtMs) && rawForcedCompletedAtMs > 0
      ? rawForcedCompletedAtMs
      : undefined;
  const rawManualRefreshAttemptAtMs = Number(
    shipment.manualRefreshAttemptAtMs,
  );
  const manualRefreshAttemptAtMs =
    Number.isFinite(rawManualRefreshAttemptAtMs) &&
      rawManualRefreshAttemptAtMs > 0
      ? rawManualRefreshAttemptAtMs
      : undefined;
  const rawCainiaoH5FallbackActivatedAtMs = Number(
    shipment.cainiaoH5FallbackActivatedAtMs,
  );
  const cainiaoH5FallbackActivatedAtMs =
    Number.isFinite(rawCainiaoH5FallbackActivatedAtMs) &&
      rawCainiaoH5FallbackActivatedAtMs > 0
      ? rawCainiaoH5FallbackActivatedAtMs
      : undefined;
  const rawManualRefreshLease = shipment.manualRefreshLease;
  const manualRefreshLeaseAttemptId = String(
    rawManualRefreshLease?.attemptId || "",
  ).trim();
  const manualRefreshLeaseStartedAtMs = Number(
    rawManualRefreshLease?.startedAtMs,
  );
  const manualRefreshLeaseExpiresAtMs = Number(
    rawManualRefreshLease?.expiresAtMs,
  );
  const manualRefreshLease = manualRefreshLeaseAttemptId &&
      Number.isFinite(manualRefreshLeaseStartedAtMs) &&
      manualRefreshLeaseStartedAtMs > 0 &&
      Number.isFinite(manualRefreshLeaseExpiresAtMs) &&
      manualRefreshLeaseExpiresAtMs > manualRefreshLeaseStartedAtMs
    ? {
        attemptId: manualRefreshLeaseAttemptId,
        startedAtMs: manualRefreshLeaseStartedAtMs,
        expiresAtMs: manualRefreshLeaseExpiresAtMs,
      }
    : undefined;
  return {
    ...shipment,
    statusPresentation: repairsJingDongOrder
      ? shipment.statusPresentation ||
        (shipment.timeline.semantic === "COMPLETED"
          ? { scope: "ORDER", semantic: "COMPLETED", text: "已完成" }
          : undefined)
      : shipment.statusPresentation,
    sourceTimeline: repairsJingDongOrder
      ? {
          ...(shipment.sourceTimeline || shipment.timeline),
          companyName: "京东购物",
        }
      : shipment.sourceTimeline,
    manualTimelines: repairsJingDongOrder
      ? []
      : shipment.manualTimelines,
    forcedCompletedAtMs,
    cainiaoH5FallbackActivatedAtMs,
    manualRefreshAttemptAtMs,
    manualRefreshLease,
    identity: {
      ...shipment.identity,
      id: canonicalId,
      bindingSource: migrateManual
        ? SCRIPT_BINDING_SOURCE
        : migrateHistoricalAccount
          ? null
          : bindingSource,
      sourceId: manuallyAdded ? canonicalWaybill : shipment.identity.sourceId,
      sourceOwner: repairsJingDongOrder
        ? `${SCRIPT_BINDING_SOURCE}:order`
        : shipment.identity.sourceOwner,
      projectedWaybill,
      orderProjectionRetry,
      orderId: repairsJingDongOrder
        ? shipment.identity.sourceId
        : shipment.identity.orderId,
      accountOrder: repairsJingDongOrder || shipment.identity.accountOrder,
      courierCode: projectedPresentation
        ? projectedPresentation.courierCode
        : shipment.identity.courierCode,
      companyName: projectedPresentation
        ? projectedPresentation.companyName
        : repairsJingDongOrder
          ? "京东购物"
        : shipment.identity.companyName,
    },
    route: shipment.route && (
        shipment.route.kind === "cainiao" ||
        (manuallyAdded && shipment.route.kind === "web")
      )
      ? { kind: shipment.route.kind, source: SCRIPT_BINDING_SOURCE }
      : null,
  };
}

function legacyRouteMigrations(
  value: LegacyAppState | AppState,
): LegacyShipmentRouteMigration[] {
  const migrations: LegacyShipmentRouteMigration[] = [];
  const finalShipments = migrateShipmentSources(value.shipments || []);
  const finalById = new Map(
    finalShipments.map((shipment) => [shipment.identity.id, shipment]),
  );
  for (const shipment of value.shipments || []) {
    if (!shipment.route) continue;
    const migrated = migrateShipmentSource(shipment);
    if (!migrated) continue;
    const target = finalById.get(migrated.identity.id) ||
      finalShipments.find((candidate) =>
        isHistoricalAccountDuplicate(migrated, candidate)
      );
    if (!target) continue;
    migrations.push({
      fromId: shipment.identity.id,
      toId: target.identity.id,
    });
  }
  if (isCurrentState(value)) {
    for (const pending of value.pendingQueries || []) {
      if (!pending.route) continue;
      const migrated = migratePendingSource(pending);
      if (!migrated) continue;
      migrations.push({ fromId: pending.id, toId: migrated.id });
    }
  }
  return migrations;
}

function migrateShipmentSources(values: readonly Shipment[]): Shipment[] {
  const automatic: Shipment[] = [];
  const manual = new Map<string, Shipment>();
  const migrated = values
    .filter((shipment) => {
      if (shipment.identity.manuallyAdded) return true;
      const source = automaticSourceOf(shipment);
      const provider = String(shipment.identity.sourceProvider || "")
        .trim()
        .toLowerCase();
      return !(
        (source === "interface1" || source === "vivo") &&
        provider === "jingdong"
      );
    })
    .map(migrateShipmentSource)
    .filter((shipment): shipment is Shipment => shipment != null)
    .sort((left, right) =>
      left.updatedAtMs - right.updatedAtMs ||
      left.identity.id.localeCompare(right.identity.id)
    );
  for (const shipment of migrated) {
    if (!shipment.identity.manuallyAdded) {
      automatic.push(shipment);
      continue;
    }
    const waybill = displayWaybill(shipment);
    const current = manual.get(waybill);
    const merged = current
      ? applyManualShipment(
          current,
          shipment,
          Math.max(current.updatedAtMs, shipment.updatedAtMs),
        )
      : shipment;
    manual.set(
      waybill,
      current
        ? { ...merged, route: current.route || shipment.route || null }
        : merged,
    );
  }
  const accountByWaybill = new Map<string, number>();
  for (let index = 0; index < automatic.length; index++) {
    const shipment = automatic[index];
    if (shipment.identity.bindingSource !== SCRIPT_BINDING_SOURCE) continue;
    const waybill = displayWaybill(shipment);
    if (waybill) accountByWaybill.set(waybill, index);
  }
  const absorbedHistory = new Set<number>();
  for (let index = 0; index < automatic.length; index++) {
    const historical = automatic[index];
    if (historical.identity.bindingSource != null) continue;
    const targetIndex = accountByWaybill.get(displayWaybill(historical));
    if (targetIndex == null || targetIndex === index) continue;
    const target = automatic[targetIndex];
    if (!isHistoricalAccountDuplicate(historical, target)) continue;
    const merged = absorbHistoricalShipment(
      target,
      historical,
      Math.max(target.updatedAtMs, historical.updatedAtMs),
    );
    automatic[targetIndex] = {
      ...merged,
      route: target.route || historical.route || null,
    };
    absorbedHistory.add(index);
  }
  return [
    ...automatic.filter((_, index) => !absorbedHistory.has(index)),
    ...manual.values(),
  ];
}

function migratePendingSource(pending: PendingManualQuery): PendingManualQuery | null {
  const waybill = normalizeWaybill(pending.waybill);
  if (!waybill) return null;
  const canonicalId = `${SCRIPT_BINDING_SOURCE}:${waybill}`;
  return {
    ...pending,
    id: canonicalId,
    source: SCRIPT_BINDING_SOURCE,
    waybill,
    route: pending.route && (
        pending.route.kind === "cainiao" || pending.route.kind === "web"
      )
      ? { kind: pending.route.kind, source: SCRIPT_BINDING_SOURCE }
      : null,
  };
}

function migratePendingSources(
  values: readonly PendingManualQuery[],
): PendingManualQuery[] {
  const result = new Map<string, PendingManualQuery>();
  for (const raw of values) {
    const pending = migratePendingSource(raw);
    if (!pending) continue;
    const previous = result.get(pending.id);
    if (!previous) {
      result.set(pending.id, pending);
      continue;
    }
    const newer = pending.lastAttemptAtMs >= previous.lastAttemptAtMs
      ? pending
      : previous;
    result.set(pending.id, {
      ...newer,
      createdAtMs: Math.min(previous.createdAtMs, pending.createdAtMs),
      lastAttemptAtMs: Math.max(
        previous.lastAttemptAtMs,
        pending.lastAttemptAtMs,
      ),
      attempts: Math.max(previous.attempts, pending.attempts),
      phoneTail: newer.phoneTail || previous.phoneTail || pending.phoneTail,
      courierCode:
        newer.courierCode || previous.courierCode || pending.courierCode,
      companyName:
        newer.companyName || previous.companyName || pending.companyName,
      route: previous.route || pending.route || null,
    });
  }
  return [...result.values()];
}

function sanitizeProviderErrorTimeline(
  timeline: TimelinePackage,
): TimelinePackage {
  const removed = timeline.tracks.filter((track) =>
    isProviderErrorDetail(track.detail)
  );
  if (!removed.length && !isProviderErrorDetail(timeline.latestDetail)) {
    return timeline;
  }
  const tracks = timeline.tracks.filter((track) =>
    !isProviderErrorDetail(track.detail)
  );
  const latest = [...tracks].sort(
    (left, right) => (right.timeMs || 0) - (left.timeMs || 0),
  )[0] || null;
  // Legacy packages did not record whether package-level metadata came from a
  // removed error node or a surviving event, so the old metadata is unusable.
  const invalidatedMetadata = removed.length > 0 ||
    isProviderErrorDetail(timeline.latestDetail);
  return {
    ...timeline,
    complete: tracks.length && !invalidatedMetadata
      ? timeline.complete
      : false,
    structuredStatus: invalidatedMetadata ? false : timeline.structuredStatus,
    semantic: !tracks.length || invalidatedMetadata
      ? "UNKNOWN"
      : timeline.semantic,
    statusEventAtMs: !tracks.length || invalidatedMetadata
      ? null
      : timeline.statusEventAtMs,
    latestTimeText: latest?.timeText || "",
    latestDetail: latest?.detail || "",
    tracks,
  };
}

function normalizeShipmentAuthorities(shipment: Shipment): Shipment {
  const manuallyAdded = Boolean(shipment.identity.manuallyAdded);
  const sourceTimelineRaw = manuallyAdded
    ? null
    : shipment.sourceTimeline || shipment.timeline;
  const sourceTimeline = sourceTimelineRaw
    ? sanitizeProviderErrorTimeline(sourceTimelineRaw)
    : null;
  const manualTimelines = Array.isArray(shipment.manualTimelines)
    ? shipment.manualTimelines
      .map(sanitizeProviderErrorTimeline)
      .filter((timeline) =>
        timeline.tracks.length > 0 && (
          timeline.provider.trim().toLowerCase() !== "kuaidi100_h5" ||
          isVerifiedKuaidi100Timeline(timeline)
        )
      )
    : manuallyAdded
      ? [sanitizeProviderErrorTimeline(shipment.timeline)]
        .filter((timeline) => timeline.tracks.length > 0)
      : [];
  const keepsCainiaoRoute = String(shipment.identity.sourceProvider || "")
    .trim()
    .toLowerCase() === "cainiao";
  const normalized: Shipment = {
    ...shipment,
    route: shipment.route?.kind === "web" && manuallyAdded
      ? shipment.route
      : keepsCainiaoRoute && shipment.route?.kind === "cainiao"
        ? shipment.route
        : null,
    sourceTimeline,
    manualTimelines,
    timeline: sourceTimeline || sanitizeProviderErrorTimeline(shipment.timeline),
  };
  const selected = { ...normalized, timeline: selectShipmentTimeline(normalized) };
  return normalizeAutomaticOwnership(selected);
}

type StoredStateRead = {
  valid: DecodedStoredState | null;
  recoverableLegacy: DecodedStoredState | null;
  invalid: boolean;
  failed: boolean;
};

type DecodedStoredState = {
  state: LegacyAppState | AppState;
  fingerprint: string;
  serialized: string | null;
  legacySchema: 1 | 2 | null;
  envelopeChecksum: string;
};

let pendingCommit: EncodedState | null = null;

function stateShape(value: unknown): value is LegacyAppState | AppState {
  return isLegacyState(value) || isCurrentState(value);
}

function decodeStoredRaw(raw: unknown): StoredStateRead {
  try {
    if (raw == null) {
      return {
        valid: null,
        recoverableLegacy: null,
        invalid: false,
        failed: false,
      };
    }
    if (raw === "") {
      return {
        valid: null,
        recoverableLegacy: null,
        invalid: true,
        failed: false,
      };
    }
    if (typeof raw === "string") {
      const envelope = JSON.parse(raw) as Partial<StoredStateEnvelope>;
      if (
        envelope.schema !== 3 ||
        typeof envelope.checksum !== "string" ||
        !/^[a-f0-9]{64}$/i.test(envelope.checksum) ||
        typeof envelope.payload !== "string" ||
        hashText(envelope.payload) !== envelope.checksum.toLowerCase()
      ) {
        return {
          valid: null,
          recoverableLegacy: null,
          invalid: true,
          failed: false,
        };
      }
      const state = JSON.parse(envelope.payload) as unknown;
      if (!stateShape(state)) {
        return {
          valid: null,
          recoverableLegacy: null,
          invalid: true,
          failed: false,
        };
      }
      return {
        valid: {
          state,
          fingerprint: checksum(state),
          serialized: raw,
          legacySchema: null,
          envelopeChecksum: envelope.checksum.toLowerCase(),
        },
        recoverableLegacy: null,
        invalid: false,
        failed: false,
      };
    }

    if (!raw || typeof raw !== "object") {
      return {
        valid: null,
        recoverableLegacy: null,
        invalid: true,
        failed: false,
      };
    }
    const stored = raw as Partial<LegacyStoredState>;
    if (
      (stored.schema !== 1 && stored.schema !== 2) ||
      typeof stored.checksum !== "string" ||
      !/^[a-f0-9]{64}$/i.test(stored.checksum) ||
      !stateShape(stored.state)
    ) {
      return {
        valid: null,
        recoverableLegacy: null,
        invalid: true,
        failed: false,
      };
    }
    const decoded: DecodedStoredState = {
      state: stored.state,
      fingerprint: checksum(stored.state),
      serialized: null,
      legacySchema: stored.schema,
      envelopeChecksum: stored.checksum.toLowerCase(),
    };
    const valid = stored.checksum.toLowerCase() === legacyChecksum(stored.state);
    return {
      valid: valid ? decoded : null,
      recoverableLegacy: valid ? null : decoded,
      invalid: !valid,
      failed: false,
    };
  } catch {
    return {
      valid: null,
      recoverableLegacy: null,
      invalid: true,
      failed: false,
    };
  }
}

function readStoredState(key: string, shared: boolean): StoredStateRead {
  try {
    return decodeStoredRaw(Storage.get<unknown>(
      key,
      shared ? { shared: true } : undefined,
    ));
  } catch {
    return {
      valid: null,
      recoverableLegacy: null,
      invalid: false,
      failed: true,
    };
  }
}

function readDurableState(name: string): StoredStateRead {
  try {
    const result = readDurableTextResult(name);
    const reads = result.candidates.map(decodeStoredRaw);
    return {
      valid: chooseStoredState(...reads),
      recoverableLegacy: null,
      invalid: reads.some((read) => read.invalid),
      failed: result.failed || reads.some((read) => read.failed),
    };
  } catch {
    return {
      valid: null,
      recoverableLegacy: null,
      invalid: false,
      failed: true,
    };
  }
}

function mirrorStoredState(
  key: string,
  stored: EncodedState,
  shared: boolean,
): boolean {
  try {
    return Storage.set(
      key,
      stored.serialized,
      shared ? { shared: true } : undefined,
    ) !== false;
  } catch {
    return false;
  }
}

function matchesEncoded(
  read: StoredStateRead,
  encoded: EncodedState,
): boolean {
  return !read.invalid && !read.failed &&
    read.valid?.serialized === encoded.serialized;
}

function chooseStoredState(
  ...reads: readonly StoredStateRead[]
): DecodedStoredState | null {
  return reads
    .map((read) => read.valid)
    .filter((value): value is DecodedStoredState => value != null)
    .sort((left, right) =>
      right.state.revision - left.state.revision ||
      right.state.updatedAtMs - left.state.updatedAtMs
    )[0] || null;
}

function durableSlotForRevision(revision: number): string {
  return revision % 2 === 0 ? STATE_DURABLE_SLOT_A : STATE_DURABLE_SLOT_B;
}

function writeDurableState(stored: EncodedState): void {
  const slot = durableSlotForRevision(stored.state.revision);
  writeDurableText(slot, stored.serialized);
  if (!matchesEncoded(readDurableState(slot), stored)) {
    throw new Error("durable state verification failed");
  }
}

function legacyConsensus(
  primary: StoredStateRead,
  backup: StoredStateRead,
): DecodedStoredState | null {
  const left = primary.recoverableLegacy;
  const right = backup.recoverableLegacy;
  if (!left || !right) return null;
  if (
    left.legacySchema !== right.legacySchema ||
    left.envelopeChecksum !== right.envelopeChecksum ||
    left.state.revision !== right.state.revision ||
    left.state.updatedAtMs !== right.state.updatedAtMs ||
    left.fingerprint !== right.fingerprint ||
    stableJson(left.state) !== stableJson(right.state)
  ) return null;
  return left;
}

function pendingIsOlderThan(
  pending: EncodedState,
  durable: DecodedStoredState,
): boolean {
  return durable.state.revision > pending.state.revision ||
    (
      durable.state.revision === pending.state.revision &&
      durable.state.updatedAtMs > pending.state.updatedAtMs
    );
}

export function loadState(now = Date.now()): AppState {
  const primary = readStoredState(STATE_KEY, false);
  const backup = readStoredState(STATE_BACKUP_KEY, true);
  const durableA = readDurableState(STATE_DURABLE_SLOT_A);
  const durableB = readDurableState(STATE_DURABLE_SLOT_B);
  let chosen = chooseStoredState(primary, backup, durableA, durableB);

  if (pendingCommit && chosen && pendingIsOlderThan(pendingCommit, chosen)) {
    pendingCommit = null;
  }

  let recoveredLegacy = false;
  if (!chosen) {
    chosen = legacyConsensus(primary, backup);
    recoveredLegacy = chosen != null;
  }

  const durableInvalid = durableA.invalid || durableB.invalid;
  const durableFailed = durableA.failed || durableB.failed;
  if (!recoveredLegacy && (primary.invalid || backup.invalid || durableInvalid)) {
    writeDiagnostic(
      "storage.state.rejected",
      {
        result: durableInvalid
          ? "invalid_durable"
          : primary.invalid
            ? backup.invalid ? "invalid_both" : "invalid_primary"
            : "invalid_backup",
      },
      "warning",
    );
  } else if (!recoveredLegacy && (primary.failed || backup.failed || durableFailed)) {
    writeDiagnostic(
      "storage.state.rejected",
      {
        result: durableFailed
          ? "read_failed_durable"
          : primary.failed
            ? backup.failed ? "read_failed_both" : "read_failed_primary"
            : "read_failed_backup",
      },
      primary.failed && backup.failed && durableFailed ? "error" : "warning",
    );
  }
  if (!chosen) {
    if (durableFailed) {
      throw new Error("本地快递数据读取失败");
    }
    return restoreInitialBindingBackup(emptyState());
  }

  let restored: AppState;
  let legacyBindingRecoveryDurable = true;
  try {
    const migrated = migrate(chosen.state, now);
    if (recoveredLegacy) {
      const recovery = restoreLegacyBindingBackup(migrated);
      restored = recovery.state;
      legacyBindingRecoveryDurable = recovery.durable;
    } else {
      restored = migrated;
      mirrorBindingBackup(restored);
    }
  } catch {
    writeDiagnostic(
      "storage.state.rejected",
      { result: "migration_failed" },
      "error",
    );
    return restoreInitialBindingBackup(emptyState());
  }
  if (recoveredLegacy) {
    writeDiagnostic(
      "storage.state.recovered",
      {
        revision: chosen.state.revision,
        result: legacyBindingRecoveryDurable
          ? "legacy_consensus"
          : "legacy_consensus_backup_pending",
      },
    );
  }
  try {
    migrateLegacyShipmentRoutes(legacyRouteMigrations(chosen.state), now);
  } catch {
    /* route migration is retried on the next load; local timelines remain available */
  }
  pruneOrderProjectionReferencesForState(restored, now);
  if (recoveredLegacy && !legacyBindingRecoveryDurable) return restored;
  const encoded = encodeState(restored);
  const primaryMatches = matchesEncoded(primary, encoded);
  const backupMatches = matchesEncoded(backup, encoded);
  const durableMatches = matchesEncoded(
    readDurableState(durableSlotForRevision(encoded.state.revision)),
    encoded,
  );
  if (!durableMatches) {
    try {
      writeDurableState(encoded);
    } catch {
      writeDiagnostic(
        "storage.state.failed",
        { ...diagnosticState(encoded.state), result: "durable_heal_failed" },
        "error",
      );
      return encoded.state;
    }
  }
  if (!primaryMatches || !backupMatches) {
    if (!primaryMatches) mirrorStoredState(STATE_KEY, encoded, false);
    if (!backupMatches) mirrorStoredState(STATE_BACKUP_KEY, encoded, true);
    pendingCommit = encoded;
    const refreshedPrimary = readStoredState(STATE_KEY, false);
    const refreshedBackup = readStoredState(STATE_BACKUP_KEY, true);
    if (
      matchesEncoded(refreshedPrimary, encoded) &&
      matchesEncoded(refreshedBackup, encoded)
    ) {
      pendingCommit = null;
    }
  }
  mirrorBindingBackup(encoded.state);
  return encoded.state;
}

export function visibleShipments(
  state: AppState,
  now = Date.now(),
): Shipment[] {
  return pruneShipments(
    state.shipments.filter(
      (shipment) =>
        (
          shipment.identity.bindingSource == null ||
          shipment.identity.bindingSource === SCRIPT_BINDING_SOURCE
        ) &&
        (!shipment.identity.manuallyAdded || hasTimedShipmentAuthority(shipment)),
    ),
    now,
  );
}

export function loadWidgetSnapshot(now = Date.now()): WidgetSnapshot {
  const state = loadState(now);
  return buildWidgetSnapshot(visibleShipments(state, now), now);
}

function hasDurableOrderProjectionAuthority(shipment: Shipment): boolean {
  if (
    shipment.identity.bindingSource === SCRIPT_BINDING_SOURCE &&
    shipment.identity.accountOrder &&
    normalizedProjectedWaybill(shipment.identity)
  ) {
    return true;
  }
  return Boolean(
    shipment.automaticOwnership?.observations.some((observation) =>
      observation.bindingValid !== false &&
      observation.source === SCRIPT_BINDING_SOURCE &&
      observation.identity.bindingSource === SCRIPT_BINDING_SOURCE &&
      observation.identity.accountOrder &&
      normalizedProjectedWaybill(observation.identity)
    ),
  );
}

function retainDurableShipments(
  shipments: readonly Shipment[],
  now: number,
): Shipment[] {
  const visibleIds = new Set(
    pruneShipments(shipments, now).map((shipment) => shipment.identity.id),
  );
  return shipments.filter((shipment) =>
    visibleIds.has(shipment.identity.id) ||
    (
      shipment.identity.manuallyAdded &&
      Number.isFinite(shipment.identity.createdAtMs) &&
      shipment.identity.createdAtMs > 0 &&
      shipment.identity.createdAtMs <= now &&
      now - shipment.identity.createdAtMs < PENDING_TTL_MS
    ) ||
    hasDurableOrderProjectionAuthority(shipment)
  );
}

function preserveDurableOrderProjections(
  previousShipments: readonly Shipment[],
  candidateShipments: readonly Shipment[],
  now: number,
): Shipment[] {
  const previousById = new Map(
    previousShipments.map((shipment) => [shipment.identity.id, shipment]),
  );
  return candidateShipments.map((candidate) => {
    const previous = previousById.get(candidate.identity.id);
    if (
      !previous?.identity.accountOrder ||
      !candidate.identity.accountOrder ||
      !normalizedProjectedWaybill(previous.identity) ||
      normalizedProjectedWaybill(candidate.identity)
    ) {
      return candidate;
    }
    const restored = applyAccountShipment(candidate, previous, now);
    return {
      ...restored,
      accountRecord: candidate.accountRecord || restored.accountRecord,
      updatedAtMs: Math.max(candidate.updatedAtMs, restored.updatedAtMs),
    };
  });
}

export function saveState(
  candidate: AppState,
  now = Date.now(),
): AppState {
  const previous = loadState(now);
  const normalizedShipments = preserveDurableOrderProjections(
    previous.shipments,
    migrateShipmentSources(candidate.shipments)
      .map(normalizeShipmentAuthorities),
    now,
  );
  // UI retention may hide an old signed shipment, but its confirmed
  // order-to-waybill projection remains source authority. Dropping that row
  // would let the next account summary recreate the order number and trigger
  // the same hidden WebView capture again.
  const retainedShipments = pruneExpiredManualPlaceholders(
    retainDurableShipments(normalizedShipments, now),
    now,
  );
  const next: AppState = {
    version: 2,
    revision: Math.max(previous.revision, candidate.revision) + 1,
    updatedAtMs: now,
    activeSource: SCRIPT_BINDING_SOURCE,
    bindings: uniqueBindings(candidate.bindings),
    pendingQueries: prunePending(
      migratePendingSources(candidate.pendingQueries),
      now,
    ),
    shipments: sortShipments(retainedShipments),
  };
  const stored = encodeState(next);
  try {
    writeDurableState(stored);
  } catch {
    writeDiagnostic(
      "storage.state.failed",
      { ...diagnosticState(next), result: "durable_write_failed" },
      "error",
    );
    throw new Error("本地快递数据保存失败");
  }
  const backupStored = mirrorStoredState(STATE_BACKUP_KEY, stored, true);
  let primaryStored = true;
  primaryStored = mirrorStoredState(STATE_KEY, stored, false);
  pendingCommit = stored;
  const writtenPrimary = readStoredState(STATE_KEY, false);
  const writtenBackup = readStoredState(STATE_BACKUP_KEY, true);
  if (
    matchesEncoded(writtenPrimary, stored) &&
    matchesEncoded(writtenBackup, stored)
  ) {
    pendingCommit = null;
  }
  writeDiagnostic(
    "storage.state.saved",
    {
      ...diagnosticState(stored.state),
      result: primaryStored && backupStored
        ? "durable_and_mirrors"
        : "durable_only",
    },
    "info",
  );
  pruneOrderProjectionReferencesForState(stored.state, now);
  // Cleanup belongs after a durable transition: route publication writes the sidecar first.
  pruneShipmentRoutesForState(stored.state, now);
  return stored.state;
}

function replaceShipment(
  shipments: readonly Shipment[],
  incoming: Shipment,
): Shipment[] {
  return [
    ...shipments.filter((item) => item.identity.id !== incoming.identity.id),
    incoming,
  ];
}

function pendingVersion(value: PendingManualQuery | undefined): string {
  return value ? checksum(value) : "";
}

function rebaseNewAccountProjection(
  before: Shipment,
  current: Shipment,
  incoming: Shipment,
): Shipment | null {
  const projected = normalizedProjectedWaybill(incoming.identity);
  if (
    !before.identity.accountOrder ||
    !current.identity.accountOrder ||
    !incoming.identity.accountOrder ||
    normalizedProjectedWaybill(before.identity) ||
    normalizedProjectedWaybill(current.identity) ||
    !projected ||
    current.identity.bindingSource !== incoming.identity.bindingSource ||
    normalizeWaybill(current.identity.sourceId) !==
      normalizeWaybill(incoming.identity.sourceId)
  ) {
    return null;
  }
  const rebased = applyAccountShipment(
    current,
    incoming,
    current.updatedAtMs,
  );
  return {
    ...rebased,
    statusPresentation: rebased.statusPresentation?.scope === "ORDER"
      ? undefined
      : rebased.statusPresentation,
    updatedAtMs: current.updatedAtMs,
  };
}

/**
 * Rebases one source refresh onto the latest user-owned state. Network work may take tens of
 * seconds, so deletion, unbinding, and manual edits always win over an older refresh snapshot.
 */
export type RefreshCommitFence = Readonly<{
  isCurrent: () => boolean;
  acceptsState?: (state: AppState) => boolean;
}>;

export type RefreshStateCommit = Readonly<{
  state: AppState;
  applied: boolean;
}>;

const REFRESH_VOLATILE_FIELDS = new Set([
  "updatedAtMs",
  "successAtMs",
  "observedAtMs",
]);

function withoutRefreshVolatility(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRefreshVolatility);
  if (!value || typeof value !== "object") return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (REFRESH_VOLATILE_FIELDS.has(key)) continue;
    normalized[key] = withoutRefreshVolatility(item);
  }
  return normalized;
}

function refreshContentFingerprint(state: AppState): string {
  return checksum(withoutRefreshVolatility({
    version: state.version,
    activeSource: state.activeSource,
    bindings: [...state.bindings].sort((left, right) =>
      `${left.source}:${left.phone}`.localeCompare(`${right.source}:${right.phone}`)
    ),
    pendingQueries: [...state.pendingQueries].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    shipments: [...state.shipments].sort((left, right) =>
      left.identity.id.localeCompare(right.identity.id)
    ),
  }));
}

export function commitRefreshState(
  base: AppState,
  candidate: AppState,
  bindingSource: BindingSource,
  now = Date.now(),
  fence?: RefreshCommitFence,
): RefreshStateCommit {
  requireScriptSource(bindingSource);
  if (fence && !fence.isCurrent()) {
    return { state: loadState(now), applied: false };
  }
  const latest = loadState(now);
  if (fence?.acceptsState && !fence.acceptsState(latest)) {
    return { state: latest, applied: false };
  }
  const baseShipments = new Map(
    base.shipments
      .filter((item) => item.identity.bindingSource === bindingSource)
      .map((item) => [item.identity.id, item]),
  );
  const candidateShipments = new Map(
    candidate.shipments
      .filter((item) => item.identity.bindingSource === bindingSource)
      .map((item) => [item.identity.id, item]),
  );
  let shipments = [...latest.shipments];

  for (const [id, candidateIncoming] of candidateShipments) {
    const before = baseShipments.get(id);
    const current = shipments.find((item) => item.identity.id === id);
    if (before && !current) continue;
    let incoming = candidateIncoming;
    if (before && current && checksum(current) !== checksum(before)) {
      const rebased = rebaseNewAccountProjection(before, current, incoming);
      if (!rebased) continue;
      incoming = rebased;
    }
    if (!before && incoming.identity.manuallyAdded) {
      const canonical = displayWaybill(incoming);
      const causalPending = base.pendingQueries.find(
        (pending) =>
          pending.source === bindingSource &&
          normalizeWaybill(pending.waybill) === canonical,
      );
      if (causalPending) {
        const currentPending = latest.pendingQueries.find(
          (pending) => pending.id === causalPending.id,
        );
        // A newer submit may reuse the same canonical id. Only the exact
        // pending generation that caused this network round may create its
        // first owner; deletion or replacement invalidates the late result.
        if (
          pendingVersion(currentPending) !== pendingVersion(causalPending)
        ) continue;
      }
    }
    if (!incoming.identity.manuallyAdded) {
      const associatedPhone = phone(incoming.identity.phone || "");
      if (associatedPhone) {
        const baselineBinding = base.bindings.find(
          (binding) =>
            binding.source === bindingSource &&
            binding.phone === associatedPhone,
        );
        const latestBinding = latest.bindings.find(
          (binding) =>
            binding.source === bindingSource &&
            binding.phone === associatedPhone,
        );
        if (
          !baselineBinding ||
          !latestBinding ||
          baselineBinding.boundAtMs !== latestBinding.boundAtMs
        ) {
          continue;
        }
      }
    }
    shipments = replaceShipment(shipments, incoming);
  }

  for (const [id, before] of baseShipments) {
    if (candidateShipments.has(id)) continue;
    const current = shipments.find((item) => item.identity.id === id);
    if (current && checksum(current) === checksum(before)) {
      shipments = shipments.filter((item) => item.identity.id !== id);
    }
  }

  const basePending = new Map(
    base.pendingQueries
      .filter((item) => item.source === bindingSource)
      .map((item) => [item.id, item]),
  );
  const candidatePending = new Map(
    candidate.pendingQueries
      .filter((item) => item.source === bindingSource)
      .map((item) => [item.id, item]),
  );
  let pendingQueries = [...latest.pendingQueries];
  for (const [id, incoming] of candidatePending) {
    const before = basePending.get(id);
    const current = pendingQueries.find((item) => item.id === id);
    if (before && !current) continue;
    if (before && pendingVersion(current) !== pendingVersion(before)) continue;
    pendingQueries = [
      ...pendingQueries.filter((item) => item.id !== id),
      incoming,
    ];
  }
  for (const [id, before] of basePending) {
    if (candidatePending.has(id)) continue;
    const current = pendingQueries.find((item) => item.id === id);
    if (pendingVersion(current) === pendingVersion(before)) {
      pendingQueries = pendingQueries.filter((item) => item.id !== id);
    }
  }

  if (
    fence &&
    (
      !fence.isCurrent() ||
      (fence.acceptsState != null && !fence.acceptsState(latest))
    )
  ) {
    return { state: loadState(now), applied: false };
  }
  const merged = { ...latest, shipments, pendingQueries };
  if (
    refreshContentFingerprint(merged) === refreshContentFingerprint(latest)
  ) {
    return { state: latest, applied: true };
  }
  return { state: saveState(merged, now), applied: true };
}

export function bindingsForSource(
  state: AppState,
  bindingSource: BindingSource = SCRIPT_BINDING_SOURCE,
): AccountBinding[] {
  requireScriptSource(bindingSource);
  return state.bindings.filter((binding) => binding.source === bindingSource);
}

export function addBinding(
  bindingSource: BindingSource,
  phoneNumber: string,
  now = Date.now(),
): AppState {
  requireScriptSource(bindingSource);
  const state = loadState(now);
  const normalizedPhone = phone(phoneNumber);
  if (!normalizedPhone) throw new Error("请输入正确的手机号");
  const existing = bindingsForSource(state, bindingSource);
  if (
    !existing.some((binding) => binding.phone === normalizedPhone) &&
    existing.length >= EXPRESS_POLICY.sources.maxBindingsPerSource
  ) {
    throw new Error(`最多可绑定 ${EXPRESS_POLICY.sources.maxBindingsPerSource} 个手机号`);
  }
  return saveBindingTransition(
    state,
    {
      ...state,
      activeSource: bindingSource,
      bindings: [
        ...state.bindings.filter(
          (binding) =>
            binding.source !== bindingSource || binding.phone !== normalizedPhone,
        ),
        { source: bindingSource, phone: normalizedPhone, boundAtMs: now },
      ],
    },
    now,
  );
}

function saveBindingTransition(
  _previous: AppState,
  candidate: AppState,
  now: number,
): AppState {
  const saved = saveState(candidate, now);
  mirrorBindingBackup(saved);
  return saved;
}

export type TargetShipmentRefreshCommit = {
  state: AppState;
  applied: boolean;
};

/**
 * Applies one detail refresh only when that shipment still matches the snapshot used by the
 * request. User-owned state is always taken from the latest durable value.
 */
export function commitTargetShipmentRefresh(
  base: AppState,
  incoming: Shipment,
  now = Date.now(),
  fence?: RefreshCommitFence,
): TargetShipmentRefreshCommit {
  if (fence && !fence.isCurrent()) {
    return { state: loadState(now), applied: false };
  }
  const latest = loadState(now);
  if (fence?.acceptsState && !fence.acceptsState(latest)) {
    return { state: latest, applied: false };
  }
  const before = base.shipments.find(
    (item) => item.identity.id === incoming.identity.id,
  );
  const current = latest.shipments.find(
    (item) => item.identity.id === incoming.identity.id,
  );
  if (
    (fence && !fence.isCurrent()) ||
    (fence?.acceptsState != null && !fence.acceptsState(latest)) ||
    !before ||
    !current ||
    checksum(before) !== checksum(current)
  ) {
    return { state: latest, applied: false };
  }
  const incomingWaybill = displayWaybill(incoming);
  const pendingQueries = hasTimedShipmentAuthority(incoming)
    ? latest.pendingQueries.filter(
        (pending) =>
          pending.source !== incoming.identity.bindingSource ||
          normalizeWaybill(pending.waybill) !== incomingWaybill,
      )
    : latest.pendingQueries;
  const merged = {
    ...latest,
    pendingQueries,
    shipments: replaceShipment(latest.shipments, incoming),
  };
  if (
    refreshContentFingerprint(merged) === refreshContentFingerprint(latest)
  ) {
    return { state: latest, applied: true };
  }
  return { state: saveState(merged, now), applied: true };
}

export type RoutePointerTarget = {
  owner: "shipment" | "pending";
  targetId: string;
};

/**
 * Publishes route pointers onto the latest state. Every target must still match the state that
 * authorized the Keychain mutation, otherwise the caller rolls the whole route transaction back.
 */
export function commitRoutePointers(
  base: AppState,
  candidate: AppState,
  targets: readonly RoutePointerTarget[],
  now = Date.now(),
): AppState {
  const latest = loadState(now);
  const uniqueTargets = new Map(
    targets.map((target) => [`${target.owner}:${target.targetId}`, target]),
  );

  for (const target of uniqueTargets.values()) {
    if (target.owner === "shipment") {
      const before = base.shipments.find(
        (item) => item.identity.id === target.targetId,
      );
      const current = latest.shipments.find(
        (item) => item.identity.id === target.targetId,
      );
      const after = candidate.shipments.find(
        (item) => item.identity.id === target.targetId,
      );
      if (!before || !current || !after || checksum(before) !== checksum(current)) {
        throw new Error("快递状态已更新，请稍后重试");
      }
      continue;
    }
    const before = base.pendingQueries.find((item) => item.id === target.targetId);
    const current = latest.pendingQueries.find((item) => item.id === target.targetId);
    const after = candidate.pendingQueries.find((item) => item.id === target.targetId);
    if (!before || !current || !after || checksum(before) !== checksum(current)) {
      throw new Error("快递状态已更新，请稍后重试");
    }
  }

  const shipments = latest.shipments.map((current) => {
    const target = uniqueTargets.get(`shipment:${current.identity.id}`);
    if (!target) return current;
    const after = candidate.shipments.find(
      (item) => item.identity.id === current.identity.id,
    );
    return after ? { ...current, route: after.route || null } : current;
  });
  const pendingQueries = latest.pendingQueries.map((current) => {
    const target = uniqueTargets.get(`pending:${current.id}`);
    if (!target) return current;
    const after = candidate.pendingQueries.find((item) => item.id === current.id);
    return after ? { ...current, route: after.route || null } : current;
  });
  return saveState({ ...latest, shipments, pendingQueries }, now);
}

export function privateHash(value: string): string {
  return Crypto.sha256(utf8Data(String(value || "")))
    .toHexString()
    .toLowerCase();
}

export function removeBinding(
  bindingSource: BindingSource,
  phoneNumber: string,
  now = Date.now(),
): AppState {
  requireScriptSource(bindingSource);
  const state = loadState(now);
  const normalizedPhone = phone(phoneNumber);
  const sourceBindings = bindingsForSource(state, bindingSource);
  const suffix = normalizedPhone.slice(-4);
  const uniquelyMatchesTail = (tail: string): boolean =>
    Boolean(tail) &&
    tail === suffix &&
    sourceBindings.filter((binding) => binding.phone.endsWith(tail)).length === 1;
  const matching = state.shipments.filter((shipment) => {
    if (shipment.identity.bindingSource !== bindingSource) return false;
    const ownerPhone = phone(shipment.identity.phone || "");
    if (ownerPhone) return ownerPhone === normalizedPhone;
    const tail = shipment.identity.phoneTail || "";
    if (uniquelyMatchesTail(tail)) return true;
    return !shipment.identity.manuallyAdded && sourceBindings.length === 1;
  });
  const matchingIds = new Set(matching.map((shipment) => shipment.identity.id));
  const bindingIdentity = `phone:${normalizedPhone}`;
  const tailBindingIdentity = `tail:${suffix}`;
  return saveBindingTransition(
    state,
    {
      ...state,
      bindings: state.bindings.filter(
        (binding) =>
          binding.source !== bindingSource || binding.phone !== normalizedPhone,
      ),
      pendingQueries: state.pendingQueries.filter(
        (pending) =>
          pending.source !== bindingSource ||
          !uniquelyMatchesTail(pending.phoneTail),
      ),
      shipments: state.shipments.map((shipment) => {
        if (shipment.identity.manuallyAdded) return shipment;
        const matchingObservation = shipment.automaticOwnership?.observations
          .find((observation) =>
            observation.source === bindingSource &&
            (
              observation.bindingIdentity === bindingIdentity ||
              (
                uniquelyMatchesTail(suffix) &&
                observation.bindingIdentity === tailBindingIdentity
              )
            ) &&
            observation.bindingValid !== false
          );
        if (!matchingIds.has(shipment.identity.id) && !matchingObservation) {
          return shipment;
        }
        const hasBindingEvidence = Boolean(
          phone(shipment.identity.phone || "") ||
          uniquelyMatchesTail(shipment.identity.phoneTail || ""),
        );
        return invalidateAutomaticOwner(
          shipment,
          bindingSource,
          now,
          matchingObservation?.bindingIdentity ||
            (hasBindingEvidence ? normalizedPhone : ""),
        );
      }),
    },
    now,
  );
}

export function upsertShipment(incoming: Shipment, now = Date.now()): AppState {
  if (incoming.identity.bindingSource != null) {
    requireScriptSource(incoming.identity.bindingSource);
  }
  const state = loadState(now);
  const current = state.shipments.find(
    (item) => item.identity.id === incoming.identity.id,
  );
  const shipment: Shipment = current
    ? incoming.identity.manuallyAdded
      ? applyManualShipment(current, incoming, now)
      : applyAccountShipment(current, incoming, now)
    : incoming.identity.manuallyAdded
      ? applyManualShipment(undefined, incoming, now)
      : applyAccountShipment(undefined, incoming, now);
  return saveState(
    {
      ...state,
      shipments: [
        ...state.shipments.filter(
          (item) => item.identity.id !== shipment.identity.id,
        ),
        shipment,
      ],
    },
    now,
  );
}

export function removeShipment(id: string, now = Date.now()): AppState {
  const state = loadState(now);
  const shipment = state.shipments.find((item) => item.identity.id === id);
  const canonical = shipment ? displayWaybill(shipment) : "";
  return saveState(
    {
      ...state,
      pendingQueries: shipment
        ? state.pendingQueries.filter(
            (pending) =>
              normalizeWaybill(pending.waybill) !== canonical,
          )
        : state.pendingQueries,
      shipments: state.shipments.filter(
        (item) => item.identity.id !== id,
      ),
    },
    now,
  );
}

export function forceCompleteShipment(
  id: string,
  now = Date.now(),
): AppState {
  const state = loadState(now);
  const current = state.shipments.find((item) => item.identity.id === id);
  if (!current || current.timeline.semantic === "COMPLETED") return state;
  return saveState(
    {
      ...state,
      shipments: state.shipments.map((item) =>
        item.identity.id === id
          ? {
              ...item,
              forcedCompletedAtMs: now,
              updatedAtMs: now,
            }
          : item
      ),
    },
    now,
  );
}

export function upsertPendingQuery(
  pending: PendingManualQuery,
  now = Date.now(),
): AppState {
  requireScriptSource(pending.source);
  const state = loadState(now);
  return saveState(
    {
      ...state,
      pendingQueries: [
        ...state.pendingQueries.filter((item) => item.id !== pending.id),
        pending,
      ],
    },
    now,
  );
}

export function removePendingQuery(id: string, now = Date.now()): AppState {
  const state = loadState(now);
  return saveState(
    {
      ...state,
      pendingQueries: state.pendingQueries.filter((item) => item.id !== id),
    },
    now,
  );
}
