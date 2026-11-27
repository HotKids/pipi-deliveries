/**
 * Pipi Deliveries iOS App Group 持久化状态与原子提交边界（AGENTS §9 / §11）。
 *
 * - **职责边界**：管理 `AppState` 读写、旧槽位一次性迁移、同运单占号与拆分（`waybill-ownership.ts`）、
 *   运单重用清理（`waybill-reuse.ts`）、14/21 天签收留存与 4 小时取消裁剪、通知事件队列及桌面小组件快照生成。
 * - **并发契约**：跨宿主变更一律通过 `withSharedFileTransaction` 验证前序代次后原子发布，路由与行台账按哈希侧存。
 * - **跨端对等文件**：Pipi `ExpressRepository.java`、Lite `ExpressRepository.java`、Bot `pipi-bot/bot/business_records.py`。
 */
import { Path } from "scripting";
import { statusProjectionFields } from "./worker-status";
import { replayPendingShipmentNotifications } from "./notifications";
import { sharedCommitSequence, sharedData, sharedStateText, publishSharedData, withSharedFileTransaction, SharedCommitConflict, prefetchSharedStateFiles, type PrefetchedStateFiles } from "./shared-file-transaction";
import { normalizeTimelineSlot, TIMELINE_SLOT } from "./timeline-slot";
import { activeWatchScope, internationalShipment, legacyWatchSnapshot, refreshInternationalShipments, retireLegacyWatchSnapshot, type WatchSnapshot } from "./international-records";
import type {
  AccountBinding,
  AppState,
  BindingSource,
  CloudPddParcelTombstone,
  PendingManualQuery,
  PendingEnhancementUnsubscribe,
  PickupCodeRecord,
  ParcelHandoffRecord,
  Shipment,
  ShipmentNotificationEvent,
  TimelinePackage,
  WatchFeedbackRecord,
  WidgetSnapshot,
} from "../models";
import { nextParcelHandoffDeadline, parcelHandoffDeadline } from "./parcel-handoff-expiry";
import { activePickupCards, applyRecognizedPickup, nextPickupArtwork, parcelCardKey, type ParcelActivityContent } from "./parcel-pickup";
import type { PickupArtworkChoice } from "../models";
import { acceptsPddParcelSource, adoptCloudPddParcelSource, applyCloudPddParcels, cloudPddParcelAppURL, deliveryEstimateApplies, displayedPlatformFields, enrichPlatformParcel, keepPlatformFields, matchPlatformParcel, samePlatformTarget, type CloudParcelPddLink, type CloudPddParcel } from "./platform-parcel-merge";
import type { PlatformParcel } from "./platform-parcel-data";
import type { CabinetParcel } from "./fengchao-account";
import type { ParcelLookup } from "./parcel-code-ocr";
import {
  buildWidgetSnapshot,
  isConfirmedNoItemOrder,
  isHiddenCompletedOrderPlaceholder,
  hasSavedOrderWaybill,
  isHiddenSignedShipment,
  isHiddenCancelledShipment,
  isHeldTrack,
  isNonEventDetail,
  mergeTimelineAuthorities,
  normalizedProjectedWaybill,
  normalizeWaybill,
  pruneShipments,
  signedRetentionAtMs,
  sortShipments,
  splitJingDongH5Nodes,
  terminalEvidenceAtMs,
  timedTracks,
  isJingDongOrderCompletionNode,
  jingDongAnchorEvidence,
  jingDongSignedAnchorAtMs,
  withoutJingDongOrderCompletion,
} from "./status";
import {
  mergeAutomaticSourceTimeline,
  absorbHistoricalShipment,
  applyAccountShipment,
  applyManualShipment,
  applySameSourceTimeline,
  automaticSourceOf,
  displayWaybill,
  invalidateAutomaticOwner,
  isForeignManualPackage,
  isHistoricalAccountDuplicate,
  isVerifiedKuaidi100Timeline,
  normalizeAutomaticOwnership,
  selectShipmentTimeline,
  unprojectedAccountOrder,
  withDetailSelection,
} from "./shipment-policy";
import { projectedCarrierPresentation } from "./carrier-presentation";
import { isJingDongAccountOrder } from "./account-parser";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";
import {
  changedSinceLastLogged,
  createDiagnosticFlowId,
  diagnosticErrorDetails,
  diagnosticState,
  diagnosticsEnabled,
  writeDiagnostic,
} from "./logger";
import { recordNotificationDecisions, recordRowPresentationChanges, type NotificationDecision } from "./row-diagnostics";
import {
  attachedShipmentIds,
  splitMergedOrderRows,
  withWaybillOwnership,
  type MergedOrderSplitPlan,
} from "./waybill-ownership";
import {
  loadBindingBackup,
  saveBindingBackup,
} from "./binding-backup";
import {
  SCRIPT_BINDING_SOURCE,
  requireScriptSource,
} from "./script-source";
import { accountOrderProjectionRouteHash } from "./account-sync-policy";
import {
  migrateLegacyShipmentRoutes,
  pruneOrderProjectionReferences,
  pruneShipmentRoutes,
  pruneAccountAppRoutes,
  type LegacyShipmentRouteMigration,
} from "./routes";
import {
  readDurableTextResult,
  writeDurableText,
} from "./durable-files";
import { sha256Hex } from "./scripting-data";
import {
  shipmentNotificationEvent,
  shipmentNotificationPresentation,
} from "./notification-events";
import { carrierAwaitingRecognition } from "./carrier-gate";
import { notificationEnabled } from "./notification-preferences";
import { preserveSettledShipment } from "./shipment-policy";
import { newerWaybillReuseGeneration } from "./waybill-reuse";
import { ShipmentLifecycleChangedError, shipmentLifecycleKey } from "./shipment-lifecycle";
import { pruneRowLedgerForState } from "./row-ledger";
import { cainiaoImageCacheKey, productImageCacheFiles, pruneProductImages } from "./product-image-cache";

const STATE_KEY = "pipi_deliveries_state_v1";
/** 只放一个数字：状态最近一次落盘的 revision，供投影等待轮询，不用每次全量 loadState（2026-09-06）。 */
const STATE_REVISION_KEY = "pipi_deliveries_state_revision_v1";
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
      ...(value.enhancedMode === true ? { enhancedMode: true as const,
        enhancedAtMs: Number.isFinite(value.enhancedAtMs) ? value.enhancedAtMs : value.boundAtMs,
        ...(typeof value.enhancedIdentityFingerprint === "string" && /^[a-f0-9]{64}$/.test(value.enhancedIdentityFingerprint)
          ? { enhancedIdentityFingerprint: value.enhancedIdentityFingerprint } : {}) } : {}),
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

function normalizeEnhancementUnsubscribes(values: readonly PendingEnhancementUnsubscribe[] = []): PendingEnhancementUnsubscribe[] {
  const entries = new Map<string, PendingEnhancementUnsubscribe>();
  for (const value of Array.isArray(values) ? values : []) {
    if (!value || !/^[a-f0-9]{64}$/.test(value.id) || phone(value.phone) !== value.phone ||
        !Number.isFinite(value.boundAtMs) || value.boundAtMs < 0 ||
        !Number.isFinite(value.enhancedAtMs) || value.enhancedAtMs < 0 ||
        !Number.isFinite(value.createdAtMs) || value.createdAtMs <= 0 ||
        (value.identityFingerprint !== "" && !/^[a-f0-9]{64}$/.test(value.identityFingerprint))) continue;
    entries.set(value.id, { id: value.id, phone: value.phone, boundAtMs: value.boundAtMs,
      enhancedAtMs: value.enhancedAtMs, identityFingerprint: value.identityFingerprint, createdAtMs: value.createdAtMs });
  }
  return [...entries.values()];
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
    if (shipment.emptyTimelineHiddenAtMs || !shipment.identity.manuallyAdded ||
        hasTimedShipmentAuthority(shipment)) {
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
): boolean {
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
    return true;
  } catch {
    return false;
  }
}

function pruneShipmentRoutesForState(state: AppState, now: number): boolean {
  let succeeded = true;
  try {
    pruneAccountAppRoutes(state.shipments.flatMap((shipment) => {
      const record = shipment.accountRecord;
      return shipment.identity.bindingSource === SCRIPT_BINDING_SOURCE &&
          !shipment.identity.manuallyAdded && record &&
          state.bindings.some((binding) => binding.source === SCRIPT_BINDING_SOURCE && binding.phone === record.phone)
        ? [record] : [];
    }));
  } catch (error) {
    succeeded = false;
    writeDiagnostic("detail.external.cache_failed", { stage: "prune" }, "warning");
  }
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
    succeeded = false;
  }
  return succeeded;
}

/** Run after a durable owner or route-pointer transition. */
export function pruneRoutesForState(state: AppState, now = Date.now()): boolean {
  const references = pruneOrderProjectionReferencesForState(state, now);
  const routes = pruneShipmentRoutesForState(state, now);
  return references && routes;
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
  return sha256Hex(stableJson(value));
}

function legacyChecksum(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}

function encodeState(state: AppState, verified?: DecodedStoredState): EncodedState {
  const payload = stableJson(state);
  if (verified?.payload === payload && verified.serialized) {
    return {
      serialized: verified.serialized,
      checksum: verified.envelopeChecksum,
      // This load already parsed a private clone; reuse it only after normalized byte equality.
      state: verified.state as AppState,
    };
  }
  const checksum = sha256Hex(payload);
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

const EMPTY_TIMELINE_HIDDEN_MS = 7 * 24 * 60 * 60 * 1000;

function mergeEmptyTimelineRetirements(
  previous: AppState["emptyTimelineRetirements"],
  incoming: AppState["emptyTimelineRetirements"],
  shipments: readonly Shipment[],
): NonNullable<AppState["emptyTimelineRetirements"]> {
  const entries = new Map<string, NonNullable<AppState["emptyTimelineRetirements"]>[number]>();
  for (const item of [...(Array.isArray(previous) ? previous : []),
    ...(Array.isArray(incoming) ? incoming : []), ...shipments.flatMap((shipment) => {
    const hiddenAtMs = Number(shipment.emptyTimelineHiddenAtMs);
    const source = shipment.identity.bindingSource;
    return hiddenAtMs > 0 && source ? [{ id: shipment.identity.id, source,
      waybill: displayWaybill(shipment), hiddenAtMs }] : [];
  })]) {
    if (!item || typeof item !== "object") continue;
    const waybill = normalizeWaybill(item.waybill);
    if (typeof item.id !== "string" || !item.id || item.source !== SCRIPT_BINDING_SOURCE || !waybill ||
        !Number.isFinite(item.hiddenAtMs) || item.hiddenAtMs <= 0) continue;
    const key = `${item.source}:${item.id}:${waybill}`;
    const previous = entries.get(key);
    entries.set(key, { id: item.id, source: item.source, waybill,
      hiddenAtMs: previous ? Math.min(previous.hiddenAtMs, item.hiddenAtMs) : item.hiddenAtMs });
  }
  return [...entries.values()];
}

function applyEmptyTimelineRetirements(
  shipments: readonly Shipment[],
  retirements: AppState["emptyTimelineRetirements"],
  now: number,
): Shipment[] {
  return shipments.flatMap((shipment) => {
    // This is the canonical-waybill comparison used by sameCanonicalWaybill;
    // the original owner id also catches a later unprojected order-only replay.
    const matches = (retirements || []).filter((item) =>
      item.source === shipment.identity.bindingSource && (
        item.id === shipment.identity.id || item.waybill === displayWaybill(shipment)
      ));
    if (!matches.length) return [shipment];
    const hiddenAtMs = Math.min(...matches.map((item) => item.hiddenAtMs));
    // A new manual submission is a new owner; old generations and automatic imports stay retired.
    if (shipment.identity.manuallyAdded && shipment.identity.createdAtMs <= now &&
        matches.every((item) => shipment.identity.createdAtMs > item.hiddenAtMs)) return [shipment];
    return now - hiddenAtMs >= EMPTY_TIMELINE_HIDDEN_MS ? []
      : [{ ...shipment, emptyTimelineHiddenAtMs: hiddenAtMs }];
  });
}

function hasRetiredMeizuProvider(provider: string | undefined): boolean {
  const normalized = String(provider || "").trim().toLowerCase();
  return normalized === "v6_picker" || normalized === "meizu_picker";
}

function isCanonicalMigratedState(
  value: LegacyAppState | AppState,
): boolean {
  if (
    !isCurrentState(value) ||
    value.activeSource !== SCRIPT_BINDING_SOURCE ||
    typeof value.feedSlotRebuiltAtMs !== "number" ||
    !(value.feedSlotRebuiltAtMs > 0)
  ) {
    return false;
  }
  const seenPendingIds = new Set<string>();
  for (const pending of value.pendingQueries) {
    const waybill = normalizeWaybill(pending.waybill);
    if (
      !waybill ||
      pending.source !== SCRIPT_BINDING_SOURCE ||
      pending.id !== `${SCRIPT_BINDING_SOURCE}:${waybill}` ||
      seenPendingIds.has(pending.id)
    ) {
      return false;
    }
    if (
      pending.route &&
      (
        pending.route.source !== SCRIPT_BINDING_SOURCE ||
        (pending.route.kind !== "cainiao" && pending.route.kind !== "web")
      )
    ) {
      return false;
    }
    seenPendingIds.add(pending.id);
  }
  const seenManualWaybills = new Set<string>();
  for (const shipment of value.shipments) {
    const identity = shipment.identity;
    if (!identity) return false;
    const manuallyAdded = Boolean(identity.manuallyAdded);
    const bindingSource = identity.bindingSource;
    if (manuallyAdded) {
      const canonicalWaybill = displayWaybill(shipment);
      if (
        !canonicalWaybill ||
        bindingSource !== SCRIPT_BINDING_SOURCE ||
        identity.id !== `${SCRIPT_BINDING_SOURCE}:manual:${canonicalWaybill}` ||
        identity.sourceId !== canonicalWaybill ||
        seenManualWaybills.has(canonicalWaybill)
      ) {
        return false;
      }
      seenManualWaybills.add(canonicalWaybill);
    } else {
      if (bindingSource !== SCRIPT_BINDING_SOURCE) {
        return false;
      }
      const autoSource = automaticSourceOf(shipment);
      const sourceProvider = String(identity.sourceProvider || "").trim().toLowerCase();
      if ((autoSource === "interface1" || autoSource === "vivo") && sourceProvider === "jingdong") {
        return false;
      }
      if (
        !identity.accountOrder &&
        !normalizedProjectedWaybill(identity) &&
        isJingDongAccountOrder(
          identity.sourceId,
          String(identity.sourceProvider || ""),
          shipment.statusPresentation?.scope || "",
          identity.rawCourierCode || identity.courierCode,
          identity.rawCompanyName || "",
        )
      ) {
        return false;
      }
      if (!(Number(shipment.occupiedAtMs) > 0)) {
        return false;
      }
    }
    if (
      identity.orderProjectionRetry ||
      identity.jingDongH5Retry ||
      (identity.accountOrder && normalizedProjectedWaybill(identity))
    ) {
      return false;
    }
    if (
      hasRetiredMeizuProvider(shipment.timeline?.provider) ||
      hasRetiredMeizuProvider(shipment.sourceTimeline?.provider) ||
      hasRetiredMeizuProvider(shipment.detailSelection?.provider) ||
      (shipment.manualTimelines || []).some((t) => hasRetiredMeizuProvider(t.provider)) ||
      (shipment.automaticOwnership?.observations || []).some((o) =>
        hasRetiredMeizuProvider(o?.sourceTimeline?.provider)
      )
    ) {
      return false;
    }
    if (shipment.route) {
      const allowedKind =
        shipment.route.kind === "cainiao" ||
        (manuallyAdded && shipment.route.kind === "web");
      if (!allowedKind || shipment.route.source !== SCRIPT_BINDING_SOURCE) {
        return false;
      }
    }
  }
  return true;
}

const WATCH_FEEDBACK_MAX = 256;
const CLOUD_PDD_TOMBSTONE_MAX = 256;
const CLOUD_PDD_TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PICKUP_CODE_HISTORY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PICKUP_CODE_HISTORY_MAX = 500;

export function prunePickupCodeRecords(
  records: readonly PickupCodeRecord[] | undefined,
  now: number,
): PickupCodeRecord[] | undefined {
  if (!Array.isArray(records)) return undefined;
  if (!records.length) return [];
  const historyEntries: Array<{ item: PickupCodeRecord; historyClock: number }> = [];
  for (const item of records) {
    const deadline = parcelHandoffDeadline(item);
    const expiredClock = item.kind === "handoff"
      ? (item.expiredAtMs || (deadline !== undefined && deadline <= now ? deadline : 0))
      : 0;
    const historyClock = (item.completedAtMs && item.completedAtMs > 0 ? item.completedAtMs : 0) || expiredClock;
    if (historyClock > 0) {
      if (now - historyClock <= PICKUP_CODE_HISTORY_TTL_MS) {
        historyEntries.push({ item, historyClock });
      }
    }
  }
  const retainedHistory = new Set(
    historyEntries
      .sort((left, right) => right.historyClock - left.historyClock || right.item.capturedAtMs - left.item.capturedAtMs)
      .slice(0, PICKUP_CODE_HISTORY_MAX)
      .map((entry) => entry.item),
  );
  return records.filter((item) => {
    const deadline = parcelHandoffDeadline(item);
    const expiredClock = item.kind === "handoff"
      ? (item.expiredAtMs || (deadline !== undefined && deadline <= now ? deadline : 0))
      : 0;
    const isHistory = Boolean((item.completedAtMs && item.completedAtMs > 0) || expiredClock > 0);
    return !isHistory || retainedHistory.has(item);
  });
}

function normalizeWatchFeedback(
  records: readonly WatchFeedbackRecord[] | undefined,
): WatchFeedbackRecord[] {
  if (!Array.isArray(records) || !records.length) return [];
  const byKey = new Map<string, WatchFeedbackRecord>();
  for (const item of records) {
    if (!item || typeof item !== "object") continue;
    const scope = typeof item.scope === "string" ? item.scope.trim() : "";
    const watchRecordId = typeof item.watchRecordId === "string" ? item.watchRecordId.trim() : "";
    const waybill = typeof item.waybill === "string" ? item.waybill.trim() : "";
    const action = item.action === "completed" || item.action === "deleted" ? item.action : null;
    const actedAt = Number(item.actedAt);
    const latestTrackAtMs = Math.max(0, Number(item.latestTrackAtMs) || 0);
    if (!scope || !watchRecordId || !waybill || !action || !Number.isFinite(actedAt) || actedAt <= 0) continue;
    const key = `${scope}\u0000${watchRecordId}`;
    const existing = byKey.get(key);
    if (!existing || actedAt >= existing.actedAt) {
      byKey.set(key, { scope, watchRecordId, waybill, action, actedAt, latestTrackAtMs });
    }
  }
  return [...byKey.values()]
    .sort((left, right) => right.actedAt - left.actedAt)
    .slice(0, WATCH_FEEDBACK_MAX);
}

function normalizeCloudPddTombstones(
  records: readonly CloudPddParcelTombstone[] | undefined,
  now: number,
): CloudPddParcelTombstone[] {
  if (!Array.isArray(records) || !records.length) return [];
  const byKey = new Map<string, CloudPddParcelTombstone>();
  for (const item of records) {
    if (!item || typeof item !== "object") continue;
    const waybill = normalizeWaybill(String(item.waybill || ""));
    const anchorAt = Math.max(0, Math.trunc(Number(item.anchorAt) || 0));
    const action = item.action === "completed" || item.action === "deleted" ? item.action : null;
    const actedAtMs = Number(item.actedAtMs);
    if (!waybill || !action || !Number.isFinite(actedAtMs) || actedAtMs <= 0) continue;
    if (now - actedAtMs > CLOUD_PDD_TOMBSTONE_TTL_MS) continue;
    const key = `${waybill}\u0000${anchorAt}`;
    const existing = byKey.get(key);
    if (!existing || actedAtMs >= existing.actedAtMs) {
      byKey.set(key, { waybill, anchorAt, action, actedAtMs });
    }
  }
  return [...byKey.values()]
    .sort((left, right) => right.actedAtMs - left.actedAtMs)
    .slice(0, CLOUD_PDD_TOMBSTONE_MAX);
}

function latestWatchTrackAtMs(shipment: Shipment): number {
  let latest = 0;
  for (const track of shipment.timeline.tracks) {
    if (typeof track.timeMs === "number" && Number.isFinite(track.timeMs) && track.timeMs > latest) {
      latest = track.timeMs;
    }
  }
  if (latest > 0) return latest;
  return Math.max(0, Number(shipment.timeline.statusEventAtMs) || 0, Number(shipment.updatedAtMs) || 0);
}

function upsertWatchFeedbackEntry(
  records: readonly WatchFeedbackRecord[] | undefined,
  entry: WatchFeedbackRecord,
): WatchFeedbackRecord[] {
  return normalizeWatchFeedback([...(records ?? []), entry]);
}

function upsertCloudPddTombstoneEntry(
  records: readonly CloudPddParcelTombstone[] | undefined,
  entry: CloudPddParcelTombstone,
  now: number,
): CloudPddParcelTombstone[] {
  return normalizeCloudPddTombstones([...(records ?? []), entry], now);
}

function migrate(value: LegacyAppState | AppState, now: number): AppState {
  const canonical = isCanonicalMigratedState(value);
  const base = isCurrentState(value)
    ? value
    : {
        ...emptyState(),
        revision: value.revision,
        updatedAtMs: value.updatedAtMs,
        shipments: value.shipments,
      };
  const feedSlotRebuiltAtMs = isCurrentState(value) && typeof value.feedSlotRebuiltAtMs === "number"
    ? value.feedSlotRebuiltAtMs
    : 0;
  const emptyTimelineRetirements = mergeEmptyTimelineRetirements(
    undefined, base.emptyTimelineRetirements, base.shipments || [],
  );
  // 归属-4：旧版本合并出来的行一次性拆开；只看还没有占号时间的行，下面一步给所有行记上占号时间后就不会再拆。
  const split: MergedOrderSplitPlan = canonical
    ? { shipments: [...base.shipments], splits: [], skipped: [] }
    : splitMergedOrderRows(migrateShipmentSources(base.shipments || []), now);
  if (!canonical) logMergedOrderSplits(split);
  const retainedShipments = pruneExpiredManualPlaceholders(
    retainDurableShipments(
      applyEmptyTimelineRetirements(withWaybillOwnership(
        null,
        split.shipments
          .map((shipment) => normalizeShipmentAuthorities(shipment, now))
          .map((shipment) => feedSlotRebuiltAtMs ? shipment : markFeedSlotRebuild(shipment)),
        now,
        (shipment) => normalizeShipmentAuthorities(shipment, now),
      ), emptyTimelineRetirements, now),
      now,
    ),
    now,
  );
  const watchFeedback = normalizeWatchFeedback(base.watchFeedback);
  const cloudPddTombstones = normalizeCloudPddTombstones(base.cloudPddTombstones, now);
  return {
    version: 2,
    revision: base.revision,
    updatedAtMs: base.updatedAtMs,
    activeSource: SCRIPT_BINDING_SOURCE,
    bindings: uniqueBindings(base.bindings || []),
    pendingQueries: prunePending(
      canonical ? base.pendingQueries : migratePendingSources(base.pendingQueries || []),
      now,
    ),
    shipments: sortShipments(retainedShipments),
    ...(base.watchSource ? { watchSource: base.watchSource } : {}),
    ...(watchFeedback.length ? { watchFeedback } : {}),
    ...(cloudPddTombstones.length ? { cloudPddTombstones } : {}),
    ...(Array.isArray(base.pickupCodeRecords)
      ? { pickupCodeRecords: prunePickupCodeRecords(base.pickupCodeRecords, now) ?? [] }
      : {}),
    ...(base.pickupArtworkChoices && typeof base.pickupArtworkChoices === "object" && !Array.isArray(base.pickupArtworkChoices)
      ? { pickupArtworkChoices: base.pickupArtworkChoices } : {}),
    pendingNotifications: base.pendingNotifications || [],
    ...(base.pendingEnhancementUnsubscribes?.length ? {
      pendingEnhancementUnsubscribes: normalizeEnhancementUnsubscribes(base.pendingEnhancementUnsubscribes),
    } : {}),
    feedSlotRebuiltAtMs: feedSlotRebuiltAtMs || now,
    ...(emptyTimelineRetirements.length ? { emptyTimelineRetirements } : {}),
  };
}

/**
 * 归属-4 的日志（AGENTS §10）：只记固定事件、结果、原因与计数，不带任何单号或尾号。拆开与拆不开的行各一条，外加一条汇总，
 * 同一次迁移共用一个 flowId。
 */
function logMergedOrderSplits(plan: MergedOrderSplitPlan): void {
  if (!plan.splits.length && !plan.skipped.length) return;
  const flowId = createDiagnosticFlowId("ownership");
  for (const _split of plan.splits) {
    writeDiagnostic("ownership.split.applied", { flowId, stage: "state", result: "split" });
  }
  for (const reason of plan.skipped) {
    writeDiagnostic("ownership.split.skipped", {
      flowId, stage: "state", result: "ambiguous", skipReason: reason,
    }, "warning");
  }
  writeDiagnostic("ownership.split.completed", {
    flowId,
    stage: "state",
    records: plan.splits.length + plan.skipped.length,
    succeeded: plan.splits.length,
    failed: plan.skipped.length,
  });
}

/**
 * 一次性修复（2026-09-06）：beta58 之前接口 5 按件详情被并进了 feed 槽，存着的 feed 包里混着详情
 * 节点，光改合并规则救不回来（增量缓存从不丢节点，混包节点多还会在详情页选包时压过 v5_query）。
 * 给自动件的 feed 包打上 `feedRebuildPending`，下一次列表同步整包替换；指向 feed 的粘性选包记录
 * 一并清掉，让详情页重新选。列表里已经没有的行不会再同步，保留原样（只是多显示几条）。
 */
function markFeedSlotRebuild(shipment: Shipment): Shipment {
  if (
    shipment.identity.manuallyAdded ||
    shipment.identity.bindingSource !== SCRIPT_BINDING_SOURCE ||
    !shipment.sourceTimeline ||
    !timedTracks(shipment.sourceTimeline.tracks).length
  ) return shipment;
  const selection = String(shipment.detailSelection?.provider || "").trim().toLowerCase();
  const pointsAtFeed = selection === "interface5" || selection === "account" ||
    selection === "v5_list";
  const marked: Shipment = {
    ...shipment,
    sourceTimeline: { ...shipment.sourceTimeline, feedRebuildPending: true },
  };
  // 展示包就是 feed 包本身时一起打标记，读盘两次的结果才一致（展示包会从 source 重新选出来）。
  if (
    shipment.timeline.provider.trim().toLowerCase() ===
      shipment.sourceTimeline.provider.trim().toLowerCase()
  ) {
    marked.timeline = { ...shipment.timeline, feedRebuildPending: true };
  }
  if (pointsAtFeed) delete marked.detailSelection;
  return marked;
}

function mirrorBindingBackup(state: AppState): boolean {
  const backup = loadBindingBackup();
  if (
    backup &&
    stableJson(uniqueBindings(backup.bindings)) ===
      stableJson(uniqueBindings(state.bindings))
  ) return true;
  try {
    saveBindingBackup(state.activeSource, state.bindings);
    return true;
  } catch {
    /* the durable state remains authoritative; a later load retries the mirror */
    return false;
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
        shipment.identity.rawCourierCode || shipment.identity.courierCode,
        // 上游那一行的 name（account-parser 解析时存进 rawCompanyName），不是展示用的 companyName。
        shipment.identity.rawCompanyName || "",
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
  // AGENTS §9: a risk-controlled order rests for an hour, not ten minutes. This runs on every
  // save and every load, so dropping the stamp here would silently shorten the whole window.
  const riskControlAtMs = Number(rawProjectionRetry?.riskControlAtMs);
  const validRiskControlAtMs =
    Number.isFinite(riskControlAtMs) && riskControlAtMs > 0
      ? riskControlAtMs
      : undefined;
  // 方案 A (user 2026-09-25): the empty-page strikes of a completed order live in the same record.
  const emptyShellAtMs = Number(rawProjectionRetry?.emptyShellAtMs);
  const emptyShellConfirmedAtMs = Number(rawProjectionRetry?.emptyShellConfirmedAtMs);
  const orderProjectionRetry =
    !projectedWaybill &&
      /^[a-f0-9]{64}$/.test(routeHash) &&
      (validFailedAtMs != null || (attemptId && attemptExpiresAtMs))
      ? {
          routeHash,
          ...(validFailedAtMs != null ? { failedAtMs: validFailedAtMs } : {}),
          ...(validRiskControlAtMs != null
            ? { riskControlAtMs: validRiskControlAtMs }
            : {}),
          ...(attemptId && attemptExpiresAtMs
            ? { attemptId, attemptExpiresAtMs }
            : {}),
          ...(Number.isFinite(emptyShellAtMs) && emptyShellAtMs > 0 ? { emptyShellAtMs } : {}),
          ...(Number.isFinite(emptyShellConfirmedAtMs) && emptyShellConfirmedAtMs > 0
            ? { emptyShellConfirmedAtMs }
            : {}),
        }
      : undefined;
  // D-13 裁决 (2026-09-04): the reopen cooldown belongs to an order that is already projected,
  // so it must survive exactly where `orderProjectionRetry` is cleared.
  const rawReopenRetry = shipment.identity.jingDongH5Retry;
  const reopenRouteHash = String(rawReopenRetry?.routeHash || "")
    .trim()
    .toLowerCase();
  const reopenFailedAtMs = Number(rawReopenRetry?.failedAtMs);
  const reopenRiskControlAtMs = Number(rawReopenRetry?.riskControlAtMs);
  const reopenAttemptId = String(rawReopenRetry?.attemptId || "").trim();
  const reopenAttemptExpiresAtMs = Number(rawReopenRetry?.attemptExpiresAtMs);
  const validReopenAttemptId = /^[a-z0-9-]{8,80}$/.test(reopenAttemptId)
    ? reopenAttemptId
    : undefined;
  const validReopenAttemptExpiresAtMs = validReopenAttemptId &&
      Number.isFinite(reopenAttemptExpiresAtMs) &&
      reopenAttemptExpiresAtMs > 0
    ? reopenAttemptExpiresAtMs
    : undefined;
  const jingDongH5Retry = /^[a-f0-9]{64}$/.test(reopenRouteHash)
    ? {
        routeHash: reopenRouteHash,
        ...(Number.isFinite(reopenFailedAtMs) && reopenFailedAtMs > 0
          ? { failedAtMs: reopenFailedAtMs }
          : {}),
        ...(Number.isFinite(reopenRiskControlAtMs) && reopenRiskControlAtMs > 0
          ? { riskControlAtMs: reopenRiskControlAtMs }
          : {}),
        ...(validReopenAttemptId && validReopenAttemptExpiresAtMs
          ? {
              attemptId: validReopenAttemptId,
              attemptExpiresAtMs: validReopenAttemptExpiresAtMs,
            }
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
  const rawPendingKdniaoAttemptAtMs = Number(
    shipment.pendingKdniaoAttemptAtMs,
  );
  const pendingKdniaoAttemptAtMs =
    Number.isFinite(rawPendingKdniaoAttemptAtMs) &&
      rawPendingKdniaoAttemptAtMs > 0
      ? rawPendingKdniaoAttemptAtMs
      : undefined;
  const rawCloudOrigin = shipment.cloudExpressOrigin;
  const cloudExpressOrigin = rawCloudOrigin &&
    manuallyAdded &&
    typeof rawCloudOrigin.waybill === "string" &&
    normalizeWaybill(rawCloudOrigin.waybill) &&
    Number.isFinite(rawCloudOrigin.waybillGeneration) &&
    rawCloudOrigin.waybillGeneration === (shipment.waybillReuseAtMs ?? 0)
    ? {
        waybill: normalizeWaybill(rawCloudOrigin.waybill),
        waybillGeneration: rawCloudOrigin.waybillGeneration,
      }
    : undefined;
  const rawPlatformFields = shipment.platformFields;
  const cleanedPlatformFields = rawPlatformFields &&
    manuallyAdded &&
    typeof rawPlatformFields.manualTitle === "string" &&
    typeof rawPlatformFields.cloudProductName === "string" &&
    rawPlatformFields.manualTitle === rawPlatformFields.cloudProductName &&
    (rawPlatformFields.manualTitleEditedAtMs === undefined ||
      rawPlatformFields.manualTitleEditedAtMs === rawPlatformFields.cloudProductNameObservedAtMs)
    ? (() => {
        const { manualTitle: _mt, manualTitleEditedAtMs: _mtAt, ...restFields } = rawPlatformFields;
        return restFields;
      })()
    : rawPlatformFields;
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
  const { cloudExpressOrigin: _previousCloudExpressOrigin, ...shipmentBase } = shipment;
  return {
    ...shipmentBase,
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
    ...(pendingKdniaoAttemptAtMs !== undefined ? { pendingKdniaoAttemptAtMs } : {}),
    ...(cloudExpressOrigin ? { cloudExpressOrigin } : {}),
    ...(cleanedPlatformFields !== shipment.platformFields ? { platformFields: cleanedPlatformFields } : {}),
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
      jingDongH5Retry,
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
  if (isCurrentState(value) && isCanonicalMigratedState(value)) {
    const migrations: LegacyShipmentRouteMigration[] = [];
    for (const shipment of value.shipments) {
      if (shipment.route) {
        migrations.push({ fromId: shipment.identity.id, toId: shipment.identity.id });
      }
    }
    for (const pending of value.pendingQueries) {
      if (pending.route) {
        migrations.push({ fromId: pending.id, toId: pending.id });
      }
    }
    return migrations;
  }
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
  // 归属-4：拆开旧合并行时，运单记录自己的菜鸟路由跟着重建的运单行走（与 migrate 用同一份输入，得到同一份拆分）。
  for (const split of splitMergedOrderRows(finalShipments, Date.now()).splits) {
    if (split.routeMoved) migrations.push({ fromId: split.orderId, toId: split.waybillRowId });
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

function discardRetiredMeizuTimelines(shipment: Shipment): Shipment {
  const retired = (provider: string): boolean =>
    ["v6_picker", "meizu_picker"].includes(String(provider || "").trim().toLowerCase());
  const empty = (timeline: TimelinePackage): TimelinePackage => ({
    provider: "none", waybill: timeline.waybill, courierCode: timeline.courierCode,
    rawCourierCode: timeline.rawCourierCode, companyName: timeline.companyName,
    complete: false, structuredStatus: false, semantic: "UNKNOWN", statusEventAtMs: null,
    latestTimeText: "", latestDetail: "", tracks: [], successAtMs: 0,
  });
  const clean: Shipment = {
    ...shipment,
    timeline: retired(shipment.timeline.provider) ? empty(shipment.timeline) : shipment.timeline,
    ...(shipment.sourceTimeline && retired(shipment.sourceTimeline.provider)
      ? { sourceTimeline: empty(shipment.sourceTimeline) } : {}),
    ...(shipment.manualTimelines
      ? { manualTimelines: shipment.manualTimelines.filter(timeline => !retired(timeline.provider)) } : {}),
    ...(shipment.automaticOwnership ? { automaticOwnership: {
      ...shipment.automaticOwnership,
      observations: (shipment.automaticOwnership.observations || []).map(observation =>
        observation?.sourceTimeline && retired(observation.sourceTimeline.provider)
          ? { ...observation, sourceTimeline: empty(observation.sourceTimeline) } : observation),
    } } : {}),
  };
  if (clean.detailSelection && retired(clean.detailSelection.provider)) delete clean.detailSelection;
  return clean;
}

function migrateShipmentSources(values: readonly Shipment[]): Shipment[] {
  const automatic: Shipment[] = [];
  const manual = new Map<string, Shipment>();
  const migrated = values
    // Discard before duplicate owners merge, so retired history cannot enter a current slot.
    .map(discardRetiredMeizuTimelines)
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

function repairLegacyJtLabelEncoding(timeline: TimelinePackage): TimelinePackage {
  if (normalizeTimelineSlot(timeline.provider) !== TIMELINE_SLOT.JT_H5) return timeline;
  let repaired = false;
  const tracks = timeline.tracks.map((track) => {
    if (track.raw._pipiStatusSource !== "jt_h5" || track.raw.jtStatusLabel !== "" ||
        track.raw._pipiJtLabelElementPresent === true) return track;
    // Older captures encoded an absent DOM label as empty. Keep actual empty elements
    // distinguishable, and repair provenance without deriving parcel status from prose.
    const { jtStatusLabel: _absent, ...raw } = track.raw;
    repaired = true;
    return { ...track, raw: { ...raw, _pipiStatusSource: "web" } };
  });
  return repaired ? { ...timeline, tracks } : timeline;
}

function sanitizeProviderErrorTimeline(
  timeline: TimelinePackage,
): TimelinePackage {
  // Provider errors and forecast notes (AGENTS §9, 2026-09-03) are both non-events: an older
  // cache that still carries them is repaired here without a data reset.
  const removed = timeline.tracks.filter((track) =>
    isNonEventDetail(track.detail)
  );
  if (!removed.length && !isNonEventDetail(timeline.latestDetail)) {
    return timeline;
  }
  const tracks = timeline.tracks.filter((track) =>
    !isNonEventDetail(track.detail)
  );
  // A held Watch scan never becomes the headline (isHeldTrack).
  const latest = tracks.filter((track) => !isHeldTrack(track)).sort(
    (left, right) => (right.timeMs || 0) - (left.timeMs || 0),
  )[0] || null;
  // Legacy packages did not record whether package-level metadata came from a
  // removed error node or a surviving event, so the old metadata is unusable.
  const invalidatedMetadata = removed.length > 0 ||
    isNonEventDetail(timeline.latestDetail);
  return {
    ...timeline,
    complete: tracks.length && !invalidatedMetadata
      ? timeline.complete
      : false,
    structuredStatus: invalidatedMetadata ? false : timeline.structuredStatus,
    normalizedStatus: !tracks.length || invalidatedMetadata ? undefined : timeline.normalizedStatus,
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

function isFeedProvider(provider: string): boolean {
  const raw = String(provider || "").trim().toLowerCase();
  return raw === "interface5" || raw === "account";
}

/** Preserve a stable fallback for undated signed rows and the existing cancelled lifecycle. */
function stampSettledAt(shipment: Shipment, now: number): Shipment {
  const terminal = shipment.timeline.semantic === "COMPLETED" ||
    shipment.timeline.semantic === "CANCELLED";
  if (!terminal) {
    if (shipment.settledAtMs === undefined) return shipment;
    const { settledAtMs: _dropped, ...rest } = shipment;
    return rest as Shipment;
  }
  const current = Number(shipment.settledAtMs);
  if (Number.isFinite(current) && current > 0 && current <= now) return shipment;
  return { ...shipment, settledAtMs: terminalEvidenceAtMs(shipment, now) || now };
}

function normalizeShipmentAuthorities(shipment: Shipment, now: number): Shipment {
  if (!shipment.identity.hadRealWaybill && hasSavedOrderWaybill(shipment)) {
    shipment = { ...shipment, identity: { ...shipment.identity, hadRealWaybill: true } };
  }
  const anchorAtMs = jingDongSignedAnchorAtMs(shipment);
  const normalized = normalizeShipmentAuthoritiesWithAnchor(shipment, now, anchorAtMs);
  // The save that first stamps settledAtMs cleans JD reviews with that same anchor (助手按用户 2026-09-27 规则对齐),
  // so the committed row, its pending notification and every later read agree on each review.
  const stampedAtMs = jingDongSignedAnchorAtMs(normalized);
  return stampedAtMs > 0 && stampedAtMs !== anchorAtMs && keepsJingDongReviewNode(normalized)
    ? normalizeShipmentAuthoritiesWithAnchor({ ...shipment, settledAtMs: normalized.settledAtMs }, now, stampedAtMs)
    : normalized;
}

/** Whether any package of the row still carries a JD review node the order rule covers. */
function keepsJingDongReviewNode(shipment: Shipment): boolean {
  const covers = (timeline: TimelinePackage | null | undefined, identity: Shipment["identity"]) =>
    Boolean(timeline) && [timeline!.latestDetail, ...timeline!.tracks.map((track) => track.detail)]
      .some((detail) => isJingDongOrderCompletionNode(timeline!, identity, detail));
  return [shipment.timeline, shipment.sourceTimeline, ...shipment.manualTimelines || []]
    .some((timeline) => covers(timeline, shipment.identity)) ||
    (shipment.automaticOwnership?.observations || [])
      .some((observation) => covers(observation.sourceTimeline, observation.identity));
}

function normalizeShipmentAuthoritiesWithAnchor(
  shipment: Shipment,
  now: number,
  signedAnchorAtMs: number,
): Shipment {
  // Remaining supported Meizu aliases share the current slot and sticky selection.
  const canonicalMeizu = (timeline: TimelinePackage): TimelinePackage =>
    normalizeTimelineSlot(timeline.provider) === TIMELINE_SLOT.V6_QUERY
      ? { ...timeline, provider: TIMELINE_SLOT.V6_QUERY }
      : timeline;
  shipment = {
    ...shipment,
    timeline: canonicalMeizu(shipment.timeline),
    ...(shipment.sourceTimeline ? { sourceTimeline: canonicalMeizu(shipment.sourceTimeline) } : {}),
    ...(shipment.manualTimelines ? { manualTimelines: shipment.manualTimelines.map(canonicalMeizu) } : {}),
    ...(shipment.detailSelection && normalizeTimelineSlot(shipment.detailSelection.provider) === TIMELINE_SLOT.V6_QUERY
      ? { detailSelection: { ...shipment.detailSelection, provider: TIMELINE_SLOT.V6_QUERY } } : {}),
  };
  const manuallyAdded = Boolean(shipment.identity.manuallyAdded);
  // A review kept as the first signing (its time is not after settledAtMs) leaves the timeline as it
  // was, so the settledAtMs repair below does not fire for it.
  // The row's stored packages show what its anchor was (用户 2026-09-28「修，按规则保留」).
  const anchorEvidence = jingDongAnchorEvidence(shipment);
  const repairedOrderTimeline = withoutJingDongOrderCompletion(
    shipment.timeline, shipment.identity, false, signedAnchorAtMs, anchorEvidence,
  );
  const sanitizeTimeline = (timeline: TimelinePackage): TimelinePackage =>
    withoutJingDongOrderCompletion(
      sanitizeProviderErrorTimeline(repairLegacyJtLabelEncoding({ ...timeline, ...statusProjectionFields(timeline, timeline) })), shipment.identity,
      false, signedAnchorAtMs, anchorEvidence,
    );
  const sourceTimelineRaw = manuallyAdded
    ? null
    : shipment.sourceTimeline || shipment.timeline;
  // 用户定 2026-09-05 晚：feed 增量与 query 独立。老行的 source 里混着联合页嫁接的 H5 节点，
  // 读盘时拆出去：feed 节点留在 source，完整的 H5 包归 jd_h5 槽。
  const sourceSplit = sourceTimelineRaw
    ? splitJingDongH5Nodes(sanitizeTimeline(sourceTimelineRaw))
    : null;
  // 老数据里 provider=interface5 的「手动包」是 absorbHistoricalShipment 塞进去的 feed，折回 source
  // 槽，不再改名成 v5_query（2026-09-06：那样 feed 节点会混进 query 包）。
  const strayFeeds = (Array.isArray(shipment.manualTimelines) ? shipment.manualTimelines : [])
    .filter((timeline) => isFeedProvider(timeline.provider) && timeline.tracks.length > 0)
    .map(sanitizeTimeline);
  const sourceTimeline = strayFeeds.reduce<TimelinePackage | null>(
    (current, stray) => current ? mergeAutomaticSourceTimeline(stray, current) : stray,
    sourceSplit ? sourceSplit.feed : null,
  );
  const strandedJingDongH5 = sourceSplit?.jdH5 && sourceSplit.jdH5.complete === true &&
      timedTracks(sourceSplit.jdH5.tracks).length
    ? sourceSplit.jdH5
    : null;
  const anchorShipment: Shipment = { ...shipment, sourceTimeline };
  // 槽名统一（用户定 2026-09-05）：旧行在读盘时改成统一槽名；旧 `web` 包按票据来源分到
  // cn_h5 / k100_h5。
  const legacyWebSlot = !manuallyAdded && String(shipment.identity.sourceProvider || "")
    .trim()
    .toLowerCase() === "cainiao"
    ? TIMELINE_SLOT.CN_H5
    : TIMELINE_SLOT.K100_H5;
  const manualTimelines = Array.isArray(shipment.manualTimelines)
    ? shipment.manualTimelines
      .filter((timeline) => !isFeedProvider(timeline.provider))
      .map(sanitizeTimeline)
      // 校验用旧行原来的 provider 字面量：直连抓取器的旧 id kuaidi100_h5 没有承运商标记就丢，
      // picker 那页的旧 id web 不要标记；改名要放在校验之后。
      .filter((timeline) =>
        timeline.tracks.length > 0 && (
          normalizeTimelineSlot(timeline.provider) !== TIMELINE_SLOT.K100_H5 ||
          isVerifiedKuaidi100Timeline(timeline)
        ) &&
        // R-29 cache repair: a package from another parcel is dropped on load.
        !isForeignManualPackage(anchorShipment, timeline)
      )
      .map((timeline) => ({
        ...timeline,
        provider: normalizeTimelineSlot(timeline.provider, legacyWebSlot),
      }))
      .reduce<TimelinePackage[]>((values, timeline) => timeline.provider === TIMELINE_SLOT.V6_QUERY
        ? mergeTimelineAuthorities(values, timeline) : [...values, timeline], [])
    : manuallyAdded
      ? [sanitizeTimeline(shipment.timeline)]
        .filter((timeline) => timeline.tracks.length > 0)
      : [];
  const keepsCainiaoRoute = String(shipment.identity.sourceProvider || "")
    .trim()
    .toLowerCase() === "cainiao";
  const normalized: Shipment = {
    ...shipment,
    settledAtMs: repairedOrderTimeline !== shipment.timeline &&
        shipment.settledAtMs === shipment.timeline.statusEventAtMs
      ? repairedOrderTimeline.statusEventAtMs || undefined
      : shipment.settledAtMs,
    route: shipment.route?.kind === "web" && manuallyAdded
      ? shipment.route
      : keepsCainiaoRoute && shipment.route?.kind === "cainiao"
        ? shipment.route
        : null,
    sourceTimeline,
    manualTimelines: strandedJingDongH5 &&
        !manualTimelines.some((timeline) =>
          normalizeTimelineSlot(timeline.provider) === TIMELINE_SLOT.JD_H5
        )
      ? mergeTimelineAuthorities(manualTimelines, strandedJingDongH5)
      : manualTimelines,
    // The selected package may carry a terminal status borrowed from another source.
    // Keep that evidence separate from the feed when rebuilding display authority.
    timeline: sanitizeTimeline(shipment.timeline),
  };
  const selected = { ...normalized, timeline: selectShipmentTimeline(normalized) };
  return normalizeAutomaticOwnership(stampSettledAt(selected, now), now);
}

type StatePayloadHeader = {
  version: 1 | 2;
  revision: number;
  updatedAtMs: number;
};

type StoredStateRead = {
  valid: DecodedStoredState | null;
  recoverableLegacy: DecodedStoredState | null;
  invalid: boolean;
  failed: boolean;
};

type DecodedStoredState = {
  state: LegacyAppState | AppState;
  header: StatePayloadHeader;
  payload?: string;
  fingerprint?: string;
  serialized: string | null;
  legacySchema: 1 | 2 | null;
  envelopeChecksum: string;
};

let pendingCommit: EncodedState | null = null;
let routesPruneDirty = false;
let productImagesPruneDirty = false;

function sidecarOwnersShrank(
  previous: LegacyAppState | AppState,
  next: AppState,
  reusedNumberRows?: ReadonlySet<string>,
): boolean {
  if (
    next.shipments.length === 0 ||
    Boolean(reusedNumberRows?.size) ||
    Boolean(next.emptyTimelineRetirements?.length)
  ) {
    return true;
  }
  const prevShipments = previous.shipments || [];
  if (prevShipments.length > next.shipments.length) return true;
  const nextIds = new Set(next.shipments.map((s) => s.identity.id));
  const nextRouteOwners = new Set([
    ...next.shipments.filter((s) => Boolean(s.route)).map((s) => s.identity.id),
    ...next.pendingQueries.filter((p) => Boolean(p.route)).map((p) => p.id),
  ]);
  const nextOrderOwners = new Set(
    next.shipments
      .filter((s) => s.identity.accountOrder && s.identity.bindingSource === SCRIPT_BINDING_SOURCE)
      .map((s) => s.identity.id),
  );
  const nextBoundPhones = new Set(
    next.bindings
      .filter((b) => b.source === SCRIPT_BINDING_SOURCE)
      .map((b) => b.phone),
  );
  const nextAppRouteKeys = new Set(
    next.shipments.flatMap((s) => {
      const r = s.accountRecord;
      return s.identity.bindingSource === SCRIPT_BINDING_SOURCE &&
          !s.identity.manuallyAdded && r && nextBoundPhones.has(r.phone)
        ? [`${String(r.provider || "").toLowerCase()}\u0000${r.waybill}\u0000${r.companyCode}\u0000${r.phone}`]
        : [];
    }),
  );
  const nextImageKeys = new Set(
    next.shipments.map(
      ({ identity }) =>
        `${identity.bindingSource ?? ""}\u0000${identity.id}\u0000${identity.sourceId}\u0000${identity.phone || ""}\u0000${identity.orderId || ""}`,
    ),
  );
  if (isCurrentState(previous)) {
    for (const b of previous.bindings) {
      if (b.source === SCRIPT_BINDING_SOURCE && !nextBoundPhones.has(b.phone)) return true;
    }
    for (const p of previous.pendingQueries) {
      if (p.route && !nextRouteOwners.has(p.id)) return true;
    }
  }
  const prevBoundPhones = isCurrentState(previous)
    ? new Set(previous.bindings.filter((b) => b.source === SCRIPT_BINDING_SOURCE).map((b) => b.phone))
    : nextBoundPhones;
  for (const s of prevShipments) {
    if (!nextIds.has(s.identity.id)) return true;
    if (s.route && !nextRouteOwners.has(s.identity.id)) return true;
    if (
      s.identity.accountOrder &&
      s.identity.bindingSource === SCRIPT_BINDING_SOURCE &&
      !nextOrderOwners.has(s.identity.id)
    ) {
      return true;
    }
    const r = s.accountRecord;
    if (
      s.identity.bindingSource === SCRIPT_BINDING_SOURCE &&
      !s.identity.manuallyAdded &&
      r &&
      prevBoundPhones.has(r.phone) &&
      !nextAppRouteKeys.has(
        `${String(r.provider || "").toLowerCase()}\u0000${r.waybill}\u0000${r.companyCode}\u0000${r.phone}`,
      )
    ) {
      return true;
    }
    const imageKey = `${s.identity.bindingSource ?? ""}\u0000${s.identity.id}\u0000${s.identity.sourceId}\u0000${s.identity.phone || ""}\u0000${s.identity.orderId || ""}`;
    if (!nextImageKeys.has(imageKey)) return true;
  }
  return false;
}

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
        sha256Hex(envelope.payload) !== envelope.checksum.toLowerCase()
      ) {
        return {
          valid: null,
          recoverableLegacy: null,
          invalid: true,
          failed: false,
        };
      }
      const state: unknown = JSON.parse(envelope.payload);
      if (
        !stateShape(state) || !Number.isFinite(state.revision) || !Number.isFinite(state.updatedAtMs) ||
        (state.version === 1 && (
          ("activeSource" in state && typeof state.activeSource !== "string") ||
          ("bindings" in state && !Array.isArray(state.bindings)) ||
          ("pendingQueries" in state && !Array.isArray(state.pendingQueries))
        ))
      ) {
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
          header: { version: state.version, revision: state.revision, updatedAtMs: state.updatedAtMs },
          payload: envelope.payload,
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
      header: {
        version: stored.state.version,
        revision: stored.state.revision,
        updatedAtMs: stored.state.updatedAtMs,
      },
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

function readStoredState(key: string, shared: boolean, decode = decodeStoredRaw): StoredStateRead {
  try {
    return decode(Storage.get<unknown>(
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

function readDurableState(name: string, decode = decodeStoredRaw): StoredStateRead {
  try {
    const result = readDurableTextResult(name);
    const reads = result.candidates.map(decode);
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

function recordStateRevision(revision: number): void {
  try {
    Storage.set(STATE_REVISION_KEY, revision, { shared: true });
  } catch {
    /* the marker only shortens a wait; the durable state is authoritative */
  }
}

/** 最近落盘的 revision；读不到就返回 0（调用方退回全量 loadState）。 */
export function peekStateRevision(): number {
  try {
    const value = Storage.get<unknown>(STATE_REVISION_KEY, { shared: true });
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
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

function storedStringMatches(
  key: string,
  shared: boolean,
  expected: string,
): boolean {
  try {
    return Storage.get<unknown>(key, shared ? { shared: true } : undefined) === expected;
  } catch {
    return false;
  }
}

type StoredEnvelopeHeader = Readonly<{
  header: StatePayloadHeader;
  envelopeChecksum: string;
}>;

type StoredHeaderRead = Readonly<{
  valid: StoredEnvelopeHeader | null;
  invalid: boolean;
  failed: boolean;
}>;

const STABLE_REVISION_RE = /"revision":(-?\d+(?:\.\d+)?),"shipments":\[/;
const STABLE_TAIL_RE = /,"updatedAtMs":(-?\d+(?:\.\d+)?),"version":(1|2)(?:,"watchFeedback":|,"watchSource":|\}$)/;
const PREFIX_HEADER_RE = /^\{"version":(1|2),"revision":(-?\d+(?:\.\d+)?),"updatedAtMs":(-?\d+(?:\.\d+)?),/;

/**
 * Validates the outer schema-3 envelope and SHA-256 payload checksum and extracts the top-level
 * state header without calling `JSON.parse(envelope.payload)` inside WidgetKit's 30MB limit.
 */
function decodeStoredEnvelopeHeader(raw: unknown): StoredHeaderRead {
  try {
    if (raw == null) return { valid: null, invalid: false, failed: false };
    if (raw === "") return { valid: null, invalid: true, failed: false };
    if (typeof raw === "string") {
      const envelope = JSON.parse(raw) as Partial<StoredStateEnvelope>;
      if (
        envelope.schema !== 3 ||
        typeof envelope.checksum !== "string" ||
        !/^[a-f0-9]{64}$/i.test(envelope.checksum) ||
        typeof envelope.payload !== "string" ||
        sha256Hex(envelope.payload) !== envelope.checksum.toLowerCase()
      ) {
        return { valid: null, invalid: true, failed: false };
      }
      const payload = envelope.payload;
      const envelopeChecksum = envelope.checksum.toLowerCase();
      const shipmentsOffset = payload.indexOf('"shipments":[');
      if (shipmentsOffset > 0) {
        const revMatch = STABLE_REVISION_RE.exec(payload.slice(0, shipmentsOffset + 13));
        const tailMatch = STABLE_TAIL_RE.exec(payload);
        if (revMatch && tailMatch) {
          const revision = Number(revMatch[1]);
          const updatedAtMs = Number(tailMatch[1]);
          const version = Number(tailMatch[2]) as 1 | 2;
          if (Number.isFinite(revision) && Number.isFinite(updatedAtMs)) {
            return {
              valid: { header: { version, revision, updatedAtMs }, envelopeChecksum },
              invalid: false,
              failed: false,
            };
          }
        }
        const prefixMatch = PREFIX_HEADER_RE.exec(payload);
        if (prefixMatch) {
          const version = Number(prefixMatch[1]) as 1 | 2;
          const revision = Number(prefixMatch[2]);
          const updatedAtMs = Number(prefixMatch[3]);
          if (Number.isFinite(revision) && Number.isFinite(updatedAtMs)) {
            return {
              valid: { header: { version, revision, updatedAtMs }, envelopeChecksum },
              invalid: false,
              failed: false,
            };
          }
        }
      }
    }
    const fallback = decodeStoredRaw(raw);
    return {
      valid: fallback.valid
        ? { header: fallback.valid.header, envelopeChecksum: fallback.valid.envelopeChecksum }
        : null,
      invalid: fallback.invalid,
      failed: fallback.failed,
    };
  } catch {
    return { valid: null, invalid: true, failed: false };
  }
}

function readStoredStateHeader(
  key: string,
  shared: boolean,
  decode: (raw: unknown) => StoredHeaderRead,
): StoredHeaderRead {
  try {
    return decode(Storage.get<unknown>(key, shared ? { shared: true } : undefined));
  } catch {
    return { valid: null, invalid: false, failed: true };
  }
}

function chooseStoredHeader(...reads: readonly StoredHeaderRead[]): StoredEnvelopeHeader | null {
  return reads
    .map((read) => read.valid)
    .filter((value): value is StoredEnvelopeHeader => value != null)
    .sort((left, right) =>
      right.header.revision - left.header.revision ||
      right.header.updatedAtMs - left.header.updatedAtMs
    )[0] || null;
}

function readDurableStateHeader(
  name: string,
  decode: (raw: unknown) => StoredHeaderRead,
): StoredHeaderRead {
  try {
    const result = readDurableTextResult(name);
    const reads = result.candidates.map(decode);
    return {
      valid: chooseStoredHeader(...reads),
      invalid: reads.some((read) => read.invalid),
      failed: result.failed || reads.some((read) => read.failed),
    };
  } catch {
    return { valid: null, invalid: false, failed: true };
  }
}

function orderedStoredStates(
  ...reads: readonly StoredStateRead[]
): DecodedStoredState[] {
  return reads
    .map((read) => read.valid)
    .filter((value): value is DecodedStoredState => value != null)
    .sort((left, right) =>
      right.header.revision - left.header.revision ||
      right.header.updatedAtMs - left.header.updatedAtMs
    );
}

function chooseStoredState(
  ...reads: readonly StoredStateRead[]
): DecodedStoredState | null {
  return orderedStoredStates(...reads)[0] || null;
}

/** The UI retains the last unrecoverable load failure until a successful read. */
let lastStateLoadFailure: "read_failed" | "migration_failed" | null = null;

export function stateLoadFailure(): "read_failed" | "migration_failed" | null {
  return lastStateLoadFailure;
}

function durableSlotForRevision(revision: number): string {
  return revision % 2 === 0 ? STATE_DURABLE_SLOT_A : STATE_DURABLE_SLOT_B;
}

function decodeStateReadback(stored: EncodedState) {
  // The encoder already verified these bytes. Changed bytes still take the full
  // integrity path; this comparison is scoped to one write and never cached.
  return (raw: unknown): StoredStateRead => raw === stored.serialized ? {
    valid: {
      state: stored.state,
      header: {
        version: stored.state.version,
        revision: stored.state.revision,
        updatedAtMs: stored.state.updatedAtMs,
      },
      serialized: stored.serialized,
      legacySchema: null,
      envelopeChecksum: stored.checksum,
    },
    recoverableLegacy: null, invalid: false, failed: false,
  } : decodeStoredRaw(raw);
}

// Counts this runtime's state publications; a cached result is reusable only while it is unchanged.
let stateWriteCount = 0;

function writeDurableState(stored: EncodedState): void {
  stateWriteCount += 1;
  publishSharedData({}, stored.serialized);
  // Legacy mirrors are recoverable compatibility copies, never publication authority.
  try { writeDurableText(durableSlotForRevision(stored.state.revision), stored.serialized); }
  catch { /* The immutable shared generation already owns this commit. */ }
}

const WIDGET_SNAPSHOT_SIDECAR_FILE = "widget-snapshot-v1.json";

// Version 2: WidgetRow carries `sender` (the gray 寄 tag). A version 1 sidecar predates the flag and
// is ignored, so the widget reads the shared state and rewrites the sidecar.
type WidgetSnapshotSidecar = {
  version: 2;
  stateRevision: number;
  stateChecksum: string;
  createdAtMs: number;
  localDayKey: string;
  nextVisibilityChangeAtMs: number;
  emptyShellProjectionHashes?: Record<string, string>;
  watchScope: string | null;
  snapshot: WidgetSnapshot;
};

function widgetLocalDayKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function computeNextWidgetVisibilityChangeAtMs(
  state: AppState,
  now: number,
): number {
  let nextChangeAtMs = Number.MAX_SAFE_INTEGER;
  for (const shipment of state.shipments) {
    if (Number(shipment.emptyTimelineHiddenAtMs) > 0) continue;
    if (shipment.timeline.semantic === "COMPLETED") {
      const eventAt = signedRetentionAtMs(shipment, now);
      if (eventAt > 0) {
        const hideAt = eventAt + EXPRESS_POLICY.retention.signedMs;
        if (hideAt > now && hideAt < nextChangeAtMs) nextChangeAtMs = hideAt;
      }
    } else if (shipment.timeline.semantic === "CANCELLED") {
      const eventAt = signedRetentionAtMs(shipment, now);
      if (eventAt > 0) {
        const hideAt = eventAt + EXPRESS_POLICY.retention.cancelledMs;
        if (hideAt > now && hideAt < nextChangeAtMs) nextChangeAtMs = hideAt;
      }
    }
  }
  return nextChangeAtMs;
}

function collectEmptyShellProjectionHashes(
  state: AppState,
): Record<string, string> | undefined {
  let hashes: Record<string, string> | undefined;
  for (const shipment of state.shipments) {
    if (!shipment.identity.orderProjectionRetry?.emptyShellConfirmedAtMs) continue;
    hashes ??= {};
    try {
      hashes[shipment.identity.id] = accountOrderProjectionRouteHash(
        shipment.identity.id,
      );
    } catch {
      hashes[shipment.identity.id] = "";
    }
  }
  return hashes;
}

function widgetSnapshotSidecarPath(): string {
  return Path.join(
    FileManager.appGroupDocumentsDirectory,
    "pipi-deliveries",
    WIDGET_SNAPSHOT_SIDECAR_FILE,
  );
}

function writeWidgetSnapshotSidecar(
  state: AppState,
  stateChecksum: string,
  now: number,
  precomputedSnapshot?: WidgetSnapshot,
): void {
  let tempPath = "";
  try {
    const sidecarPath = widgetSnapshotSidecarPath();
    FileManager.createDirectorySync(
      Path.join(FileManager.appGroupDocumentsDirectory, "pipi-deliveries"),
      true,
    );
    const snapshot =
      precomputedSnapshot ?? buildWidgetSnapshot(visibleShipments(state, now), now);
    const emptyShellProjectionHashes = collectEmptyShellProjectionHashes(state);
    const payload: WidgetSnapshotSidecar = {
      version: 2,
      stateRevision: state.revision,
      stateChecksum,
      createdAtMs: now,
      localDayKey: widgetLocalDayKey(now),
      nextVisibilityChangeAtMs: computeNextWidgetVisibilityChangeAtMs(
        state,
        now,
      ),
      ...(emptyShellProjectionHashes ? { emptyShellProjectionHashes } : {}),
      watchScope: state.watchSource?.scope ?? null,
      snapshot,
    };
    const serialized = JSON.stringify(payload);
    tempPath = `${sidecarPath}.tmp-${now}-${Math.random().toString(36).slice(2, 8)}`;
    FileManager.writeAsStringSync(tempPath, serialized);
    if (typeof FileManager.renameSync === "function") {
      if (FileManager.existsSync(sidecarPath)) {
        FileManager.removeSync(sidecarPath);
      }
      FileManager.renameSync(tempPath, sidecarPath);
      tempPath = "";
    } else {
      FileManager.writeAsStringSync(sidecarPath, serialized);
    }
  } catch {
    /* sidecar is an O(1) cache; loadWidgetSnapshot falls back to loadState */
  } finally {
    if (tempPath) {
      try {
        if (FileManager.existsSync(tempPath)) FileManager.removeSync(tempPath);
      } catch {
        /* ignore */
      }
    }
  }
}

function readValidWidgetSnapshotSidecar(now: number): WidgetSnapshot | null {
  try {
    if (pendingCommit || lastStateLoadFailure) return null;
    const sidecarPath = widgetSnapshotSidecarPath();
    if (!FileManager.existsSync(sidecarPath) || !FileManager.isFileSync(sidecarPath)) {
      return null;
    }
    const sidecar = JSON.parse(
      FileManager.readAsStringSync(sidecarPath),
    ) as Partial<WidgetSnapshotSidecar>;
    if (
      sidecar.version !== 2 ||
      typeof sidecar.stateRevision !== "number" ||
      typeof sidecar.stateChecksum !== "string" ||
      typeof sidecar.createdAtMs !== "number" ||
      typeof sidecar.localDayKey !== "string" ||
      typeof sidecar.nextVisibilityChangeAtMs !== "number" ||
      (sidecar.watchScope !== null && sidecar.watchScope !== activeWatchScope()) ||
      !sidecar.snapshot ||
      sidecar.localDayKey !== widgetLocalDayKey(now) ||
      !(now >= sidecar.createdAtMs && now < sidecar.nextVisibilityChangeAtMs)
    ) {
      return null;
    }
    const shared = sharedStateText();
    let winning: StoredEnvelopeHeader | null = null;
    const decodedHeaders = new Map<string, StoredHeaderRead>();
    const decodeHeader = (raw: unknown): StoredHeaderRead => {
      if (typeof raw !== "string") return decodeStoredEnvelopeHeader(raw);
      const cached = decodedHeaders.get(raw);
      if (cached) return cached;
      const result = decodeStoredEnvelopeHeader(raw);
      if (result.valid) decodedHeaders.set(raw, result);
      return result;
    };
    if (shared != null) {
      const read = decodeHeader(shared);
      if (read.invalid || read.failed || !read.valid) return null;
      winning = read.valid;
    } else {
      const primary = readStoredStateHeader(STATE_KEY, false, decodeHeader);
      const backup = readStoredStateHeader(STATE_BACKUP_KEY, true, decodeHeader);
      const durableA = readDurableStateHeader(STATE_DURABLE_SLOT_A, decodeHeader);
      const durableB = readDurableStateHeader(STATE_DURABLE_SLOT_B, decodeHeader);
      if (
        primary.invalid || backup.invalid || durableA.invalid || durableB.invalid ||
        primary.failed || backup.failed || durableA.failed || durableB.failed
      ) {
        return null;
      }
      winning = chooseStoredHeader(primary, backup, durableA, durableB);
    }
    if (
      !winning ||
      winning.header.revision !== sidecar.stateRevision ||
      winning.envelopeChecksum !== sidecar.stateChecksum
    ) {
      return null;
    }
    if (sidecar.emptyShellProjectionHashes) {
      for (const [id, expectedHash] of Object.entries(sidecar.emptyShellProjectionHashes)) {
        if (accountOrderProjectionRouteHash(id) !== expectedHash) return null;
      }
    }
    const snap = sidecar.snapshot;
    return {
      ...snap,
      generatedAtMs: now,
      headline: snap.headline ? { ...snap.headline } : null,
      compactIcons: snap.compactIcons.map((item) => ({ ...item })),
      rows: snap.rows.map((item) => ({ ...item })),
    };
  } catch {
    return null;
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
    left.header.revision !== right.header.revision ||
    left.header.updatedAtMs !== right.header.updatedAtMs ||
    left.fingerprint !== right.fingerprint ||
    stableJson(left.state) !== stableJson(right.state)
  ) return null;
  return left;
}

function pendingIsOlderThan(
  pending: EncodedState,
  durable: DecodedStoredState,
): boolean {
  return durable.header.revision > pending.state.revision ||
    (
      durable.header.revision === pending.state.revision &&
      durable.header.updatedAtMs > pending.state.updatedAtMs
    );
}

export function loadState(now = Date.now()): AppState {
  return loadStateSnapshot(now).state;
}

let appStateRead: Promise<AppState> | undefined;
let appSnapshot: LoadedStateSnapshot | undefined;

// Foreground consumers share a read-only view. The authoritative bytes and
// retention fences still decide when another runtime's write requires decoding.
export function readAppStateSnapshot(now = Date.now()): LoadedStateSnapshot {
  return appSnapshot = readStateSnapshot(now, appSnapshot);
}

export function loadAppState(): Promise<AppState> {
  return appStateRead ??= prefetchSharedStateFiles().catch(() => undefined)
    .then(files => {
      appSnapshot = readStateSnapshot(Date.now(), appSnapshot, files);
      return importLegacyWatchState(appSnapshot.state);
    })
    .finally(() => { appStateRead = undefined; });
}

/** A verified snapshot can be reused within an operation while the authoritative bytes still match. */
export type LoadedStateSnapshot = Readonly<{ state: AppState; verified?: { serialized: string; readAtMs: number } }>;

export function loadStateSnapshot(now = Date.now(), prior?: LoadedStateSnapshot): LoadedStateSnapshot {
  return readStateSnapshot(now, prior);
}

function readStateSnapshot(now: number, prior?: LoadedStateSnapshot,
  prefetched?: PrefetchedStateFiles): LoadedStateSnapshot {
  try {
  return withSharedFileTransaction(() => {
    const shared = sharedStateText(false, prefetched);
    if (prior?.verified && prior.verified.serialized === shared && now >= prior.verified.readAtMs &&
        !pendingCommit && !lastStateLoadFailure && !routesPruneDirty &&
        !productImagesPruneDirty && !stateRetentionExpired(prior.state, now)) return prior;
    // Read every physical copy, but validate identical bytes only once in this call.
    // Other hosts can advance the authoritative bytes independently of our revision.
    const decoded = new Map<string, StoredStateRead>();
    const decode = (raw: unknown): StoredStateRead => {
      if (typeof raw !== "string") return decodeStoredRaw(raw);
      const existing = decoded.get(raw);
      if (existing) return existing;
      const result = decodeStoredRaw(raw);
      if (result.valid) decoded.set(raw, result);
      return result;
    };
    const primary = readStoredState(STATE_KEY, false, decode);
    const backup = readStoredState(STATE_BACKUP_KEY, true, decode);
    const durableA = readDurableState(STATE_DURABLE_SLOT_A, decode);
    const durableB = readDurableState(STATE_DURABLE_SLOT_B, decode);
    const sharedRead = shared == null ? null : decode(shared);
    let previousSharedDecoded: StoredStateRead | undefined;
    const readPreviousShared = (): StoredStateRead =>
      previousSharedDecoded ??= decode(sharedStateText(true, prefetched));
    const candidates = sharedRead
      ? (sharedRead.valid ? [sharedRead.valid] : orderedStoredStates(sharedRead, readPreviousShared()))
      : orderedStoredStates(primary, backup, durableA, durableB);
    let chosen: DecodedStoredState | null = candidates[0] ?? null;

    if (pendingCommit && chosen && pendingIsOlderThan(pendingCommit, chosen)) {
      pendingCommit = null;
    }

    let recoveredLegacy = false;
    if (!chosen && shared == null) {
      chosen = legacyConsensus(primary, backup);
      recoveredLegacy = chosen != null;
    }

    const durableInvalid = durableA.invalid || durableB.invalid;
    const durableFailed = durableA.failed || durableB.failed;
    let rejectedDiagnosticEmitted = false;
    if (!recoveredLegacy && (primary.invalid || backup.invalid || durableInvalid)) {
      rejectedDiagnosticEmitted = true;
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
      rejectedDiagnosticEmitted = true;
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
    } else if (sharedRead?.invalid) {
      rejectedDiagnosticEmitted = true;
      writeDiagnostic("storage.state.rejected", { result: "invalid_payload" }, "warning");
    }
    if (!chosen) {
      if (shared != null || primary.invalid || backup.invalid || durableInvalid ||
          primary.failed || backup.failed || durableFailed) {
        lastStateLoadFailure = "read_failed";
        throw new Error("本地快递数据读取失败，请稍后重试");
      }
      lastStateLoadFailure = null;
      return { state: restoreInitialBindingBackup(emptyState()) };
    }

    // Try older generations before failing. An unreadable existing store must never
    // become a writable empty state: every writer and cleanup path loads here first.
    let restored: AppState | null = null;
    let chosenState: LegacyAppState | AppState | null = null;
    let legacyBindingRecoveryDurable = true;
    let healthyBindingBackup = false;
    let migrationAttempted = 0;
    const attempts = recoveredLegacy ? [...[chosen]] : [...candidates];
    let sharedFallbackAppended = !sharedRead?.valid;
    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex++) {
      const candidate = attempts[attemptIndex]!;
      const parsedState = candidate.state;
      migrationAttempted++;
      try {
        const migrated = migrate(parsedState, now);
        if (recoveredLegacy) {
          const recovery = restoreLegacyBindingBackup(migrated);
          restored = recovery.state;
          legacyBindingRecoveryDurable = recovery.durable;
        } else {
          restored = migrated;
          healthyBindingBackup = mirrorBindingBackup(restored);
        }
        chosen = candidate;
        chosenState = parsedState;
        break;
      } catch {
        writeDiagnostic(
          "storage.state.rejected",
          { result: "migration_failed", revision: candidate.header.revision },
          "warning",
        );
        if (!recoveredLegacy && !sharedFallbackAppended) {
          sharedFallbackAppended = true;
          const fallback = readPreviousShared().valid;
          if (fallback && fallback.serialized !== candidate.serialized) {
            attempts.push(fallback);
          }
        }
      }
    }
    if (!restored || !chosenState) {
      lastStateLoadFailure = "migration_failed";
      writeDiagnostic(
        "storage.state.rejected",
        { result: "migration_failed", attempted: migrationAttempted },
        "error",
      );
      throw new Error("Local delivery data migration failed; original copies were preserved.");
    }
    lastStateLoadFailure = null;
    if (recoveredLegacy) {
      writeDiagnostic(
        "storage.state.recovered",
        {
          revision: chosen.header.revision,
          result: legacyBindingRecoveryDurable
            ? "legacy_consensus"
            : "legacy_consensus_backup_pending",
        },
      );
    }
    const routeMigrations = legacyRouteMigrations(chosenState);
    try {
      migrateLegacyShipmentRoutes(routeMigrations, now);
    } catch {
      /* route migration is retried on the next load; local timelines remain available */
    }
    const shouldPruneOnLoad =
      routesPruneDirty ||
      productImagesPruneDirty ||
      !isCurrentState(chosenState) ||
      sidecarOwnersShrank(chosenState, restored);
    if (shouldPruneOnLoad) {
      routesPruneDirty = !pruneOrderProjectionReferencesForState(restored, now);
    }
    if (recoveredLegacy && !legacyBindingRecoveryDurable) return { state: restored };
    const encoded = encodeState(restored, chosen);
    const primaryMatches = matchesEncoded(primary, encoded);
    const backupMatches = matchesEncoded(backup, encoded);
    const durableMatches = shared === encoded.serialized;
    if (!durableMatches) {
      try {
        writeDurableState(encoded);
        recordStateRevision(encoded.state.revision);
        writeWidgetSnapshotSidecar(encoded.state, encoded.checksum, now);
      } catch (error) {
        if (error instanceof SharedCommitConflict) throw error;
        writeDiagnostic(
          "storage.state.failed",
          { ...diagnosticState(encoded.state), result: "durable_heal_failed" },
          "error",
        );
        return { state: encoded.state };
      }
    }
    const slot = durableSlotForRevision(encoded.state.revision);
    const readSlot = slot === STATE_DURABLE_SLOT_A ? durableA : durableB;
    const slotMatches = matchesEncoded(readSlot, encoded);
    if (!slotMatches && !matchesEncoded(readDurableState(slot, decode), encoded)) {
      try { writeDurableText(slot, encoded.serialized); }
      catch { /* A failed legacy mirror repair cannot replace the shared authority. */ }
    }
    if (!primaryMatches || !backupMatches) {
      if (!primaryMatches) mirrorStoredState(STATE_KEY, encoded, false);
      if (!backupMatches) mirrorStoredState(STATE_BACKUP_KEY, encoded, true);
      pendingCommit = encoded;
      if (
        storedStringMatches(STATE_KEY, false, encoded.serialized) &&
        storedStringMatches(STATE_BACKUP_KEY, true, encoded.serialized)
      ) {
        pendingCommit = null;
      }
    }
    if (recoveredLegacy) mirrorBindingBackup(encoded.state);
    if (encoded.state.emptyTimelineRetirements?.length) {
      if (!pruneShipmentRoutesForState(encoded.state, now)) {
        routesPruneDirty = true;
      }
    }
    if (
      productImagesPruneDirty ||
      !isCurrentState(chosenState) ||
      sidecarOwnersShrank(chosenState, encoded.state)
    ) {
      productImagesPruneDirty = !pruneProductImages(
        chosenState.shipments,
        encoded.state.shipments,
        now,
      );
    }
    const verified = durableMatches && primaryMatches && backupMatches && slotMatches && healthyBindingBackup &&
      !rejectedDiagnosticEmitted && !pendingCommit && !shouldPruneOnLoad && !routeMigrations.length &&
      !encoded.state.emptyTimelineRetirements?.length;
    return { state: encoded.state, ...(verified ? { verified: { serialized: encoded.serialized, readAtMs: now } } : {}) };
  });
  } catch (error) {
    if (!(error instanceof SharedCommitConflict) && !lastStateLoadFailure) lastStateLoadFailure = "read_failed";
    throw error;
  }
}

export function visibleShipments(
  state: AppState,
  now = Date.now(),
): Shipment[] {
  const candidates = storedShipmentsForProcessing(state, now).filter(
    (shipment) => !isHiddenCompletedOrderPlaceholder(shipment),
  );
  const occupiedAutomaticBills = new Set<string>();
  for (const shipment of candidates) {
    if (!shipment.identity.manuallyAdded && !unprojectedAccountOrder(shipment) && !internationalShipment(shipment)) {
      const bill = normalizeWaybill(displayWaybill(shipment));
      if (bill) occupiedAutomaticBills.add(bill);
    }
  }
  if (!occupiedAutomaticBills.size) return candidates;
  return candidates.filter(
    (shipment) =>
      !shipment.identity.manuallyAdded ||
      !occupiedAutomaticBills.has(normalizeWaybill(displayWaybill(shipment))),
  );
}

/** Preserve projection and alignment work for display-only hidden order placeholders. */
export function storedShipmentsForProcessing(state: AppState, now = Date.now()): Shipment[] {
  // 归属方案 T3（用户 2026-09-25）：同一运单号上挂靠在先占号那一行后面的行不进列表、小组件与搜索；行和它的数据都留着。
  const attached = attachedShipmentIds(state.shipments);
  const canReadWatches = Boolean(state.watchSource && state.watchSource.scope === activeWatchScope());
  return pruneShipments(
    state.shipments.filter(
      (shipment) =>
        (!internationalShipment(shipment) || canReadWatches) &&
        (
          shipment.identity.bindingSource == null ||
          shipment.identity.bindingSource === SCRIPT_BINDING_SOURCE
        ) &&
        (!shipment.identity.manuallyAdded || hasTimedShipmentAuthority(shipment)) &&
        // 方案 B (user 2026-09-25): a confirmed no-item JD order is hidden like a retention-hidden
        // row. Only the lists skip it; retention below still sees it, so nothing is deleted early.
        !isConfirmedNoItemOrder(shipment) &&
        !attached.has(shipment.identity.id),
    ),
    now,
  );
}

export function loadWidgetSnapshot(now = Date.now()): WidgetSnapshot {
  const cached = readValidWidgetSnapshotSidecar(now);
  if (cached) return cached;
  const state = importLegacyWatchState(loadState(now));
  const snapshot = buildWidgetSnapshot(visibleShipments(state, now), now);
  try {
    const shared = sharedStateText();
    if (shared != null) {
      const envelope = JSON.parse(shared) as Partial<StoredStateEnvelope>;
      if (envelope.schema === 3 && typeof envelope.checksum === "string") {
        writeWidgetSnapshotSidecar(
          state,
          envelope.checksum.toLowerCase(),
          now,
          snapshot,
        );
      }
    }
  } catch {
    /* best-effort sidecar refresh */
  }
  return snapshot;
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

// Non-signed account rows keep their existing hidden cache policy.
const RETIRED_ACCOUNT_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;

function retainsRetiredAccountRow(shipment: Shipment, now: number): boolean {
  if (shipment.identity.manuallyAdded) return false;
  if (shipment.identity.bindingSource !== SCRIPT_BINDING_SOURCE) return false;
  const settledAtMs = Number(shipment.settledAtMs);
  if (!Number.isFinite(settledAtMs) || settledAtMs <= 0 || settledAtMs > now) {
    return false;
  }
  return now - settledAtMs < RETIRED_ACCOUNT_MEMORY_MS;
}

function retainDurableShipments(
  shipments: readonly Shipment[],
  now: number,
): Shipment[] {
  const visibleIds = new Set(
    pruneShipments(shipments, now).map((shipment) => shipment.identity.id),
  );
  return shipments.filter((shipment) => {
    const hiddenAtMs = Number(shipment.emptyTimelineHiddenAtMs);
    if (hiddenAtMs > 0) return now - hiddenAtMs < EMPTY_TIMELINE_HIDDEN_MS;
    // Signed rows retain their history for seven hidden days. Neither an order
    // projection nor a newly created manual owner can extend the day-21 cutoff.
    if (shipment.timeline.semantic === "COMPLETED") {
      const settledAtMs = signedRetentionAtMs(shipment, now);
      return !settledAtMs || now - settledAtMs < EXPRESS_POLICY.retention.signedDeletionMs;
    }
    return visibleIds.has(shipment.identity.id) ||
    (
      shipment.identity.manuallyAdded &&
      Number.isFinite(shipment.identity.createdAtMs) &&
      shipment.identity.createdAtMs > 0 &&
      shipment.identity.createdAtMs <= now &&
      now - shipment.identity.createdAtMs < PENDING_TTL_MS
    ) ||
    retainsRetiredAccountRow(shipment, now) ||
    hasDurableOrderProjectionAuthority(shipment);
  });
}

export function isStoredShipmentRetained(shipment: Shipment, now = Date.now()): boolean {
  return pruneExpiredManualPlaceholders(retainDurableShipments([shipment], now), now).length > 0;
}

export function stateRetentionExpired(state: AppState, now = Date.now()): boolean {
  return prunePending(state.pendingQueries, now).length !== state.pendingQueries.length ||
    state.shipments.some(shipment => !isStoredShipmentRetained(shipment, now));
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

export type RefreshNotificationContext = Readonly<{
  previousById: ReadonlyMap<string, Shipment>;
  batchId: string;
  /**
   * 用户 2026-09-25（两条合起来）：订单行投影后与同一运单的已有行合并的那一轮，通知判断改用被并入的运单行当
   * 「上一次状态」，并且只有展示状态变了才推；之后各轮照旧。Surviving row id → the absorbed automatic waybill
   * row ids of this round's list merges. The first of them in `previousById` is the row's baseline; with
   * none there the row keeps its own. Either way only a change of the presented status notifies.
   */
  orderMerges?: ReadonlyMap<string, readonly string[]>;
}>;

type StateSaveOptions = {
  notifyChanges?: boolean;
  context?: RefreshNotificationContext;
  acknowledgedId?: string;
  acknowledgedIds?: ReadonlySet<string>;
  deferredId?: string;
  enhancementUnsubscribe?: PendingEnhancementUnsubscribe;
  acknowledgedEnhancementUnsubscribeId?: string;
  forceSidecarPrune?: boolean;
  pickupArtworkChoice?: { key: string; value: PickupArtworkChoice };
  pickupCodeRecords?: readonly PickupCodeRecord[];
};

export function saveState(
  candidate: AppState,
  now = Date.now(),
  notificationCommit: StateSaveOptions = {},
  previousInTransaction?: AppState,
): AppState {
  if (previousInTransaction) {
    return saveStateAndPrune(candidate, now, notificationCommit, previousInTransaction).state;
  }
  let expectedStateRef: string | undefined;
  try { expectedStateRef = sharedData().stateRef; }
  catch { throw new Error("本地快递数据保存失败"); }
  return withSharedFileTransaction(() => {
    if (sharedData().stateRef !== expectedStateRef) {
      throw new Error("Delivery state changed; reload before saving");
    }
    return saveStateAndPrune(candidate, now, notificationCommit).state;
  });
}

function ownsShipment(state: AppState, shipment: Shipment): boolean {
  return !internationalShipment(shipment) ||
    Boolean(state.watchSource && state.watchSource.scope === activeWatchScope());
}

// The last Watch page this runtime committed or confirmed unchanged, with the state it produced.
let lastWatchCommit: { scope: string; snapshot: string; writes: number; state: AppState } | undefined;

// Review item 8 (1): an unchanged Watch page leaves the shared state untouched (no write, no revision),
// so `watchSource.observedAtMs` keeps the last *changed* page. The time of the last unchanged read is
// kept here, per scope and outside AppState, for the background read throttle in `watchRefreshDue`.
const WATCH_READ_MARKER_KEY = "pipi_deliveries_watch_read_v1";

function unchangedWatchReadAtMs(scope: string): number {
  try {
    const raw = Storage.get<string>(WATCH_READ_MARKER_KEY, { shared: true });
    if (typeof raw !== "string") return 0;
    const marker = JSON.parse(raw) as { scope?: unknown; observedAtMs?: unknown };
    const observedAtMs = Number(marker.observedAtMs);
    return marker.scope === scope && Number.isFinite(observedAtMs) && observedAtMs > 0 ? observedAtMs : 0;
  } catch { return 0; }
}

function recordUnchangedWatchRead(scope: string, observedAtMs: number): void {
  // A stale read never moves the marker back.
  if (!scope || !(observedAtMs > 0) || unchangedWatchReadAtMs(scope) >= observedAtMs) return;
  try { Storage.set(WATCH_READ_MARKER_KEY, JSON.stringify({ scope, observedAtMs }), { shared: true }); }
  catch { /* The marker only throttles background reads; a lost write costs one more read. */ }
}

export function commitWatchSnapshot(input: WatchSnapshot): AppState {
  lastWatchCommit = undefined;
  const committed = commitWatchSnapshotLocked(input);
  if (committed.watchSource?.scope === input.scope && committed.watchSource.snapshot === input.snapshot &&
      input.snapshot) {
    lastWatchCommit = { scope: input.scope, snapshot: input.snapshot, writes: stateWriteCount, state: committed };
  }
  return committed;
}

function commitWatchSnapshotLocked({ shipments, ...source }: WatchSnapshot): AppState {
  return withSharedFileTransaction(() => {
    const now = Date.now();
    const state = loadState(now);
    if (stateLoadFailure() || source.scope !== activeWatchScope()) return state;
    const previousSource = state.watchSource?.scope === source.scope ? state.watchSource : undefined;
    if (previousSource && previousSource.observedAtMs > source.observedAtMs) return state;
    const existing = state.shipments.filter(internationalShipment);
    const byId = new Map((previousSource ? existing : []).map(row => [row.identity.id, row]));
    const scopedFeedback = (state.watchFeedback ?? []).filter(entry => entry.scope === source.scope);
    const feedbackByRecordId = new Map(scopedFeedback.map(entry => [entry.watchRecordId, entry]));
    const feedbackByWaybill = new Map(scopedFeedback.map(entry => [normalizeWaybill(entry.waybill), entry]));
    const revivedRecordIds = new Set<string>();
    const unchangedPage = Boolean(previousSource && source.snapshot && previousSource.snapshot === source.snapshot);
    const watches = (unchangedPage ? shipments.filter(row => byId.has(row.identity.id)) : shipments).filter(row => {
      const recordId = row.identity.id.startsWith("watch:") ? row.identity.id.slice("watch:".length) : "";
      const feedback = (recordId ? feedbackByRecordId.get(recordId) : undefined) ??
        feedbackByWaybill.get(normalizeWaybill(displayWaybill(row)));
      if (feedback?.action === "deleted") {
        const retrackedNewWatchRecord = Boolean(
          row.updatedAtMs > feedback.actedAt &&
          recordId &&
          feedback.watchRecordId &&
          recordId !== feedback.watchRecordId,
        );
        // IOS-PARITY-12 & W1: an in-flight/same-ms read or an unchanged scan timestamp on the same Watch record
        // keeps the deleted Watch hidden; resurface when a strictly newer scan arrives after deletion OR when Bot
        // creates a brand-new Watch record (recordId !== feedback.watchRecordId) with updatedAtMs > actedAt.
        if (
          retrackedNewWatchRecord ||
          (source.observedAtMs > feedback.actedAt && latestWatchTrackAtMs(row) > feedback.latestTrackAtMs)
        ) {
          revivedRecordIds.add(feedback.watchRecordId);
          return true;
        }
        return false;
      }
      return true;
    }).map(row => {
      const recordId = row.identity.id.startsWith("watch:") ? row.identity.id.slice("watch:".length) : "";
      const feedback = (recordId ? feedbackByRecordId.get(recordId) : undefined) ??
        feedbackByWaybill.get(normalizeWaybill(displayWaybill(row)));
      const staleOldRecordFeedback = Boolean(
        feedback &&
        (revivedRecordIds.has(feedback.watchRecordId) ||
          (row.updatedAtMs > feedback.actedAt &&
            recordId &&
            feedback.watchRecordId &&
            recordId !== feedback.watchRecordId)),
      );
      if (staleOldRecordFeedback && feedback) {
        revivedRecordIds.add(feedback.watchRecordId);
      }
      const completedAtMs = !staleOldRecordFeedback && feedback?.action === "completed" ? feedback.actedAt : undefined;
      const old = byId.get(row.identity.id);
      if (!old) {
        return completedAtMs && !row.forcedCompletedAtMs ? { ...row, forcedCompletedAtMs: completedAtMs } : row;
      }
      return {
        ...row,
        identity: { ...row.identity, createdAtMs: old.identity.createdAtMs },
        note: old.note,
        forcedCompletedAtMs: old.forcedCompletedAtMs ?? completedAtMs,
        detailSelection: old.detailSelection,
        updatedAtMs: Math.max(row.updatedAtMs, old.updatedAtMs + 1),
      };
    }).filter(row => isStoredShipmentRetained(row, now));
    if (previousSource?.snapshot === source.snapshot && !revivedRecordIds.size &&
        watches.length === existing.length && watches.every(row => byId.has(row.identity.id))) {
      recordUnchangedWatchRead(source.scope, source.observedAtMs);
      return state;
    }
    const nextWatchFeedback = revivedRecordIds.size
      ? scopedFeedback.filter(entry => !revivedRecordIds.has(entry.watchRecordId))
      : scopedFeedback;
    return saveState({ ...state, watchSource: source,
      watchFeedback: nextWatchFeedback,
      shipments: [...state.shipments.filter(row => !internationalShipment(row)), ...watches],
    }, now, { notifyChanges: Boolean(previousSource) }, state);
  });
}

function importLegacyWatchState(state: AppState): AppState {
  if (state.watchSource) return state;
  const legacy = legacyWatchSnapshot();
  if (!legacy) return state;
  const imported = commitWatchSnapshot(legacy);
  // The imported rows now live in the shared state; the old cache must not be read on every load.
  if (imported.watchSource?.scope === legacy.scope) retireLegacyWatchSnapshot();
  return imported;
}

/**
 * Whether a background runtime should read the Watch page: none recorded or the last is two minutes old.
 * The last read is the later of the last changed page and the last unchanged read of the same scope.
 */
export function watchRefreshDue(state: AppState, now = Date.now()): boolean {
  const source = state.watchSource;
  const observed = source ? Math.max(source.observedAtMs, unchangedWatchReadAtMs(source.scope)) : 0;
  return !(observed > 0 && now - observed >= 0 && now - observed < 120_000);
}

export async function refreshStoredWatchShipments(budgetMs?: number): Promise<AppState | undefined> {
  const startedAt = Date.now();
  const snapshot = await refreshInternationalShipments(budgetMs);
  if (!snapshot) return undefined;
  // D105: a Watch read that reached this runtime ends with one line; an unchanged page is written once per change
  // of result, so the two-minute cadence does not repeat it.
  const finish = (result: "committed" | "unchanged" | "denied", state: AppState) => {
    if (result !== "committed" && !changedSinceLastLogged("cloud.international.refresh", result)) return state;
    // D188 (D29, D251): the Watch read is one cloud.sync line of the international domain.
    writeDiagnostic("cloud.sync.completed", {
      domain: "international", stage: "watch_page", result, records: snapshot.shipments.length, durationMs: Date.now() - startedAt,
    });
    return state;
  };
  // An unchanged Watch page needs no shared-state transaction while this runtime has written nothing
  // since its previous commit. Callers keep the newer of this result and any state they already hold.
  const last = lastWatchCommit;
  if (last && snapshot.snapshot && last.scope === snapshot.scope && last.snapshot === snapshot.snapshot &&
      last.writes === stateWriteCount && snapshot.scope === activeWatchScope()) {
    recordUnchangedWatchRead(snapshot.scope, snapshot.observedAtMs);
    return finish("unchanged", last.state);
  }
  const writesBefore = stateWriteCount;
  let committed = commitWatchSnapshot(snapshot);
  const wrote = stateWriteCount > writesBefore;
  if (wrote && committed.pendingNotifications?.some((event) => !event.awaitingCarrier)) {
    try {
      const replayed = await replayPendingShipmentNotifications(undefined, {
        deadlineAtMs: budgetMs !== undefined ? startedAt + budgetMs : undefined,
      });
      if (replayed && replayed.revision > committed.revision) committed = replayed;
    } catch {
      /* Notification replay is best-effort; unacknowledged events remain queued in AppState. */
    }
  }
  return finish(!snapshot.snapshot ? "denied" : wrote ? "committed" : "unchanged", committed);
}

/**
 * A background runtime's Watch page read beside or after its domestic pass: the widget runs both concurrently inside
 * the same budget (§8.4 #6), while the App Intent and Shortcut refresh run after the domestic pass (G-HIGH-10). It
 * runs only when the stored page is due and more than two seconds of the runtime's budget are left. It returns the
 * newer state, or nothing; a failure is logged and never discards the domestic result.
 */
export async function refreshDueWatchShipments(state: AppState, budgetMs?: number): Promise<AppState | undefined> {
  if (!watchRefreshDue(state, Date.now()) || budgetMs !== undefined && budgetMs <= 2_000) return undefined;
  try {
    const watch = await refreshStoredWatchShipments(budgetMs);
    return watch && watch.revision > state.revision ? watch : undefined;
  } catch (error) {
    writeDiagnostic("cloud.sync.failed", { domain: "international", stage: "watch_page",
      ...diagnosticErrorDetails(error) }, "warning");
    return undefined;
  }
}

export function saveCloudPddParcels(parcels: readonly CloudPddParcel[], observed: AppState,
  isCurrent: () => boolean, now = Date.now()): { state: AppState; changed: boolean } {
  return withSharedFileTransaction(() => {
    const state = loadState(now);
    if (!isCurrent()) return { state, changed: false };
    const currentIds = new Set(state.shipments.map(row => row.identity.id));
    const removed = new Set(observed.shipments.filter(row => !currentIds.has(row.identity.id))
      .map(row => normalizeWaybill(displayWaybill(row))));
    const candidate = applyCloudPddParcels(state, parcels.filter(parcel => !removed.has(parcel.waybill)), now);
    if (candidate === state) return { state, changed: false };
    const saved = saveState(candidate, now, {}, state);
    return { state: saved, changed: saved.revision > state.revision };
  });
}

export function saveCloudPddParcelSource(expected: Shipment, link: CloudParcelPddLink,
  isCurrent: () => boolean, now = Date.now()): AppState | undefined {
  return withSharedFileTransaction(() => {
    if (!isCurrent()) return;
    const state = loadState(now);
    const matches = state.shipments.filter(row => !unprojectedAccountOrder(row) &&
      normalizeWaybill(displayWaybill(row)) === link.waybill);
    if (matches.length !== 1) return;
    const [current] = matches;
    if (!samePlatformTarget(expected, current) || !cloudPddParcelAppURL(current, link, now)) return;
    const adopted = adoptCloudPddParcelSource(current, link, now);
    if (adopted === current) return;
    return saveState({ ...state, shipments: state.shipments.map(row => row === current ? adopted : row) }, now, {}, state);
  });
}

export function expireDueParcelHandoffs(now = Date.now()): AppState {
  return withSharedFileTransaction(() => {
    const previous = loadState(now);
    const saved = previous.pickupCodeRecords ?? [];
    const deadline = nextParcelHandoffDeadline(saved);
    if (deadline === undefined || deadline > now) return previous;
    const records = saved.map((record) => {
      const expiredAtMs = parcelHandoffDeadline(record);
      return expiredAtMs !== undefined && expiredAtMs <= now ? { ...record, expiredAtMs } : record;
    });
    return saveStateAndPrune(previous, now, {}, previous, records).state;
  });
}

export function saveRecognizedParcelCode(record: PickupCodeRecord, now = Date.now()): AppState {
  return withSharedFileTransaction(() => {
    const previous = loadState(now);
    const saved = previous.pickupCodeRecords ?? [];
    if (saved.some((item) => item.id === record.id)) return previous;
    const deadline = parcelHandoffDeadline(record);
    const stored = deadline !== undefined && deadline <= now ? { ...record, expiredAtMs: deadline } : record;
    return saveStateAndPrune(previous, now, {}, previous, [...saved, stored]).state;
  });
}

export function deleteIndependentParcelCode(id: string, now = Date.now()): AppState {
  return withSharedFileTransaction(() => {
    const previous = loadState(now);
    const saved = previous.pickupCodeRecords ?? [];
    if (!saved.some((item) => item.id === id)) throw new ShipmentLifecycleChangedError();
    const records = saved.filter((item) => item.id !== id);
    return saveStateAndPrune(previous, now, { forceSidecarPrune: true }, previous, records).state;
  });
}

export function completeIndependentParcelCode(id: string, now = Date.now()): AppState {
  return withSharedFileTransaction(() => {
    const previous = loadState(now);
    const saved = previous.pickupCodeRecords ?? [];
    const target = saved.find((item) => item.id === id);
    if (!target || target.completedAtMs || target.kind === "handoff" && target.expiredAtMs) return previous;
    const deadline = parcelHandoffDeadline(target);
    const completed = deadline !== undefined && deadline <= now
      ? { ...target, expiredAtMs: deadline } : { ...target, completedAtMs: now };
    const records = saved.map((item) => item.id === id ? completed : item);
    return saveStateAndPrune(previous, now, {}, previous, records).state;
  });
}

export function saveRecognizedShipmentPickup(expected: Shipment, lookup: ParcelLookup, now = Date.now()): AppState {
  return withSharedFileTransaction(() => {
    const state = loadState(now);
    const current = state.shipments.find((item) => item.identity.id === expected.identity.id);
    if (!current || shipmentLifecycleKey(current) !== shipmentLifecycleKey(expected)) {
      throw new ShipmentLifecycleChangedError();
    }
    const updated = applyRecognizedPickup(current, lookup);
    if (updated === current) return state;
    return saveState({
      ...state,
      shipments: state.shipments.map((item) => item === current
        ? { ...updated, updatedAtMs: Math.max(now, current.updatedAtMs + 1) } : item),
    }, now, {}, state);
  });
}

export { parcelCardKey };

export function toggleParcelArtwork(expected: ParcelActivityContent, now = Date.now()): AppState {
  return withSharedFileTransaction(() => {
    const state = loadState(now);
    const key = parcelCardKey(expected);
    const current = activePickupCards(visibleShipments(state, now), state.pickupCodeRecords, state.pickupArtworkChoices)
      .find(card => parcelCardKey(card) === key && card.code === expected.code &&
        card.capturedAtMs === expected.capturedAtMs && card.artworkChoice === expected.artworkChoice);
    const value = current && nextPickupArtwork(current);
    if (!value || (current?.expiresAtMs !== undefined && current.expiresAtMs <= now)) {
      throw new ShipmentLifecycleChangedError();
    }
    return saveStateAndPrune(state, now, { pickupArtworkChoice: { key, value } }, state).state;
  });
}

export function completeCurrentParcelCard(expected: ParcelActivityContent, now = Date.now()): AppState {
  return withSharedFileTransaction(() => {
    const state = loadState(now);
    const current = activePickupCards(visibleShipments(state), state.pickupCodeRecords).find(
      (card) => parcelCardKey(card) === parcelCardKey(expected) && card.code === expected.code,
    );
    if (!current?.target || "mealId" in current.target) throw new ShipmentLifecycleChangedError();
    return "recordId" in current.target
      ? completeIndependentParcelCode(current.target.recordId, now)
      : forceCompleteShipment(current.target.shipmentId, now);
  });
}

export function setPickupCardNote(
  expected: ParcelActivityContent, previousNote: string, note: string, now = Date.now(),
): AppState {
  return withSharedFileTransaction(() => {
    const state = loadState(now);
    const shipments = visibleShipments(state, now);
    const records = state.pickupCodeRecords ?? [];
    const target = activePickupCards(shipments, records).find((card) =>
      parcelCardKey(card) === parcelCardKey(expected) && card.code === expected.code &&
      card.capturedAtMs === expected.capturedAtMs)?.target;
    if (!target || "mealId" in target) throw new ShipmentLifecycleChangedError();
    if ("shipmentId" in target) {
      const shipment = shipments.find((row) => row.identity.id === target.shipmentId);
      if (!shipment || (shipment.note || "") !== previousNote) throw new ShipmentLifecycleChangedError();
      return setShipmentNote(shipment, note, now);
    }
    const record = records.find((item) => item.id === target.recordId);
    const expiry = record && parcelHandoffDeadline(record);
    if (!record || (record.note || "") !== previousNote || (expiry !== undefined && expiry <= now)) {
      throw new ShipmentLifecycleChangedError();
    }
    const trimmed = note.trim();
    if (trimmed === previousNote) return state;
    const next = records.map((item) => item === record ? { ...record, note: trimmed || undefined } : item);
    return saveStateAndPrune(state, now, {}, state, next).state;
  });
}

export function setParcelHandoffWindow(
  expected: ParcelHandoffRecord, window: readonly [number, number] | undefined, now = Date.now(),
): AppState {
  return withSharedFileTransaction(() => {
    const state = loadState(now);
    const records = state.pickupCodeRecords ?? [];
    const current = records.find((record) => record.id === expected.id);
    const deadline = parcelHandoffDeadline(current);
    if (current?.kind !== "handoff" || current.completedAtMs || current.expiredAtMs ||
        deadline !== undefined && deadline <= now || current.code !== expected.code ||
        current.capturedAtMs !== expected.capturedAtMs || current.windowStartAtMs !== expected.windowStartAtMs ||
        current.windowEndAtMs !== expected.windowEndAtMs || (current.windowText || "") !== (expected.windowText || "")) {
      throw new ShipmentLifecycleChangedError();
    }
    if (window && (!window.every(time => Number.isSafeInteger(time) && time > 0) || window[1] < window[0] ||
        window[1] + 3_600_000 <= now)) throw new RangeError("Invalid active handoff window");
    const next = { ...current, windowStartAtMs: window?.[0], windowEndAtMs: window?.[1], windowText: undefined };
    if (JSON.stringify(next) === JSON.stringify(current)) return state;
    return saveStateAndPrune(state, now, {}, state, records.map(record => record === current ? next : record)).state;
  });
}

export function savePlatformParcelData(input: {
  observed: AppState;
  owner: string;
  parcels: readonly PlatformParcel[];
  handoffs?: readonly ParcelHandoffRecord[];
  sentHandoffIds?: readonly string[];
  cabinets?: readonly CabinetParcel[];
  detailTarget?: Shipment;
  cainiaoGeneration?: string;
  current: () => boolean;
}, now = Date.now()): { state: AppState; changed: boolean; cabinetLinks: { recordKey: string; parcel: CabinetParcel }[] } {
  return withSharedFileTransaction(() => {
    if (!input.current()) throw new ShipmentLifecycleChangedError();
    const state = loadState(now);
    const before = visibleShipments(input.observed, now);
    const visible = visibleShipments(state, now);
    const updated = new Map<string, Shipment>();
    const records = new Map((state.pickupCodeRecords || []).map((record) => [record.id, record]));
    const cabinetCandidates: { id: string; separate: boolean; parcel: CabinetParcel }[] = [];
    let pickupChanged = false;
    const stationKey = (parcel: PlatformParcel) =>
      "cn-station:" + privateHash(JSON.stringify([input.owner, parcel.name || parcel.address || "", parcel.code]));

    function addStandalone(parcel: PlatformParcel, id: string) {
      if (!parcel.code || (parcel.source !== "cainiao" && parcel.source !== "fengchao")) return;
      const current = records.get(id);
      if (current && (current.kind !== "pickup" || current.completedAtMs)) return;
      const next: PickupCodeRecord = {
        kind: "pickup", id, platform: parcel.source, code: parcel.code,
        capturedAtMs: current?.capturedAtMs || now,
        locationName: parcel.name || current?.locationName,
        address: parcel.address || current?.address,
        ...(current?.note ? { note: current.note } : {}),
      };
      if (stableJson(next) !== stableJson(current ?? null)) {
        records.set(id, next);
        pickupChanged = true;
      }
    }

    const parsedCabinets = (input.cabinets || []).map((cabinet): [PlatformParcel, CabinetParcel] => ([
      {
        source: "fengchao", waybill: normalizeWaybill(cabinet.expressId), code: cabinet.code,
        name: cabinet.cabinetName, address: cabinet.address,
      }, cabinet,
    ]));
    const candidates: [PlatformParcel, CabinetParcel?][] = [
      ...input.parcels.map((parcel): [PlatformParcel] => [parcel]), ...parsedCabinets,
    ];
    const takenStations = new Set<string>();
    for (const parcel of input.parcels) {
      if (parcel.source !== "cainiao" || !parcel.taken || input.detailTarget) continue;
      const completedAtMs = parcel.takenAtMs || now;
      if (parcel.unnumbered && parcel.code) {
        const id = stationKey(parcel);
        const record = records.get(id);
        if (record?.kind === "pickup" && record.platform === "cainiao" &&
            record.code === parcel.code && record.capturedAtMs <= completedAtMs) {
          takenStations.add(id);
          if (!record.completedAtMs) {
            records.set(id, { ...record, completedAtMs });
            pickupChanged = true;
          }
        }
      } else if (parcel.waybill) {
        const target = matchPlatformParcel(visible, parcel, input.owner);
        const observed = matchPlatformParcel(before, parcel, input.owner);
        const pickup = target?.pickup;
        if (target && pickup && !pickup.completedAtMs && samePlatformTarget(observed, target) &&
            pickup.waybill === parcel.waybill && pickup.waybillGeneration === (target.waybillReuseAtMs ?? 0) &&
            pickup.capturedAtMs <= completedAtMs && (!parcel.code || parcel.code === pickup.code)) {
          updated.set(target.identity.id, {
            ...target, pickup: { ...pickup, completedAtMs }, updatedAtMs: Math.max(now, target.updatedAtMs + 1),
          });
        }
      }
    }
    for (const [parcel, cabinet] of candidates) {
      if (parcel.taken) continue;
      const target = matchPlatformParcel(visible, parcel, input.owner);
      const expected = matchPlatformParcel(before, parcel, input.owner);
      if (target) {
        if (!samePlatformTarget(expected, target)) continue;
        const latest = updated.get(target.identity.id) || target;
        // Two provider parcels for one order cannot supply the missing waybill.
        if (parcel.waybill && unprojectedAccountOrder(target) &&
          candidates.some(([other]) => other !== parcel && other.waybill && other.waybill !== parcel.waybill &&
            matchPlatformParcel(visible, other, input.owner)?.identity.id === target.identity.id)) continue;
        const saved = latest.pddImport;
        const savedImage = latest.platformFields?.cainiaoImage;
        const productImageURL = parcel.source === "cainiao" && parcel.productImageURL && savedImage &&
          savedImage.generation === input.cainiaoGeneration && savedImage.url !== parcel.productImageURL &&
          latest.platformFields?.waybill === parcel.waybill &&
          latest.platformFields?.waybillGeneration === (latest.waybillReuseAtMs ?? 0) &&
          productImageCacheFiles(cainiaoImageCacheKey(latest)).length
            ? savedImage.url : parcel.productImageURL;
        let next = latest;
        if (input.detailTarget) {
          if (!samePlatformTarget(input.detailTarget, latest) ||
            input.detailTarget.forcedCompletedAtMs !== latest.forcedCompletedAtMs ||
            JSON.stringify(input.detailTarget.pddImport) !== JSON.stringify(latest.pddImport)) continue;
          const fields = displayedPlatformFields(latest, now);
          next = enrichPlatformParcel(latest, {
            source: parcel.source, waybill: parcel.waybill,
            title: fields.title ? undefined : parcel.title,
            estimate: deliveryEstimateApplies(latest) ? parcel.estimate : undefined,
            productImageURL,
            shippingId: parcel.shippingId,
          }, now, input.cainiaoGeneration);
        } else {
          next = enrichPlatformParcel(latest, { ...parcel, productImageURL }, now);
          if (parcel.source === "pinduoduo" && input.owner && parcel.waybill === displayWaybill(latest) &&
            parcel.orderIds?.length === 1 && acceptsPddParcelSource(latest)) {
            if (!saved) {
              next = {
                ...next,
                pddImport: {
                  ownerKey: input.owner,
                  orderId: parcel.orderIds[0],
                  ...(parcel.shippingId ? { shippingId: parcel.shippingId } : {}),
                },
              };
            } else if (saved.ownerKey === input.owner && !saved.shippingId && parcel.shippingId &&
              (!saved.orderId || saved.orderId === parcel.orderIds[0])) {
              next = { ...next, pddImport: { ...saved, orderId: parcel.orderIds[0], shippingId: parcel.shippingId } };
            }
          }
        }
        if (next !== latest) updated.set(target.identity.id, { ...next, updatedAtMs: Math.max(now, latest.updatedAtMs + 1) });
        if (cabinet) cabinetCandidates.push({ id: target.identity.id, separate: false, parcel: cabinet });
        continue;
      }
      if (expected) continue;
      if (parcel.source === "cainiao" && parcel.unnumbered) {
        const id = stationKey(parcel);
        if (!takenStations.has(id)) addStandalone(parcel, id);
      } else if (cabinet && ![...state.shipments, ...input.observed.shipments].some((shipment) =>
        parcel.waybill && displayWaybill(shipment) === parcel.waybill)) {
        const id = "fc-cabinet:" + privateHash(JSON.stringify([input.owner, cabinet.cabinetCode, cabinet.boxId, cabinet.expressId, cabinet.code]));
        addStandalone(parcel, id);
        cabinetCandidates.push({ id, separate: true, parcel: cabinet });
      }
    }

    const sentHandoffIds = new Set(input.sentHandoffIds);
    for (const id of sentHandoffIds) {
      const saved = records.get(id);
      if (saved?.kind !== "handoff" || saved.platform !== "cainiao" || saved.completedAtMs || saved.expiredAtMs) continue;
      records.set(id, { ...saved, completedAtMs: now });
      pickupChanged = true;
    }
    for (const record of input.handoffs || []) {
      if (sentHandoffIds.has(record.id)) continue;
      const saved = records.get(record.id);
      if (saved && (saved.kind !== "handoff" || saved.completedAtMs || saved.expiredAtMs)) continue;
      const keepsExistingWindow = saved && !record.windowEndAtMs && !record.windowText &&
        (!record.windowStartAtMs || record.windowStartAtMs === saved.windowStartAtMs);
      const preservedWindow = keepsExistingWindow
        ? { windowStartAtMs: saved.windowStartAtMs, windowEndAtMs: saved.windowEndAtMs, windowText: saved.windowText }
        : undefined;
      const next = {
        ...record, ...preservedWindow, capturedAtMs: saved?.capturedAtMs || record.capturedAtMs,
        providerTitle: record.providerTitle || saved?.providerTitle,
        ...(saved?.note ? { note: saved.note } : {}),
      };
      const deadline = parcelHandoffDeadline(next);
      const timed = deadline !== undefined && now >= deadline ? { ...next, expiredAtMs: deadline } : next;
      if (stableJson(timed) !== stableJson(saved ?? null)) {
        records.set(record.id, timed);
        pickupChanged = true;
      }
    }

    const next = updated.size || pickupChanged ? saveStateAndPrune({
      ...state, shipments: state.shipments.map((shipment) => updated.get(shipment.identity.id) || shipment),
    }, now, {}, state, [...records.values()]).state : state;
    const cards = activePickupCards(visibleShipments(next, now), next.pickupCodeRecords);
    const cabinetLinks = cabinetCandidates.flatMap(({ id, separate, parcel }) => {
      const card = cards.find((item) => item.target && item.code === parcel.code &&
        (separate ? "recordId" in item.target && item.target.recordId === id
          : "shipmentId" in item.target && item.target.shipmentId === id));
      return card ? [{ recordKey: parcelCardKey(card), parcel }] : [];
    });
    return { state: next, changed: next.revision > state.revision, cabinetLinks };
  });
}

function withCarrierHold(
  event: ShipmentNotificationEvent,
  hold: boolean,
): ShipmentNotificationEvent {
  if (Boolean(event.awaitingCarrier) === hold) return event;
  if (hold) return { ...event, awaitingCarrier: true };
  const { awaitingCarrier: _released, ...rest } = event;
  return rest;
}

/**
 * T23（用户 2026-09-26，跨端对齐裁决 #28）：挂起的通知（排队时承运商未对上）每次存盘结算一次。每行只留最早的一条；行没了、
 * 隐藏、挂靠或是空壳订单就丢；承运商仍未对上就继续挂着；对上了——这次存盘已给这行排了新事件就丢掉挂起的，否则按
 * 这一行现在的样子重新生成标题、正文、图标与状态再放行（通知开关看放行时的状态）。
 */
function settleCarrierHolds(
  events: readonly ShipmentNotificationEvent[],
  shipments: readonly Shipment[],
  revision: number,
  now: number,
  freshEventShipmentIds: ReadonlySet<string>,
): ShipmentNotificationEvent[] {
  if (!events.some((event) => event.awaitingCarrier)) return [...events];
  const byId = new Map(shipments.map((shipment) => [shipment.identity.id, shipment]));
  const attached = attachedShipmentIds(shipments);
  const held = new Set<string>();
  const settled: ShipmentNotificationEvent[] = [];
  for (const event of events) {
    if (!event.awaitingCarrier) {
      settled.push(event);
      continue;
    }
    if (held.has(event.shipmentId)) continue;
    held.add(event.shipmentId);
    const shipment = byId.get(event.shipmentId);
    if (!shipment || isHiddenSignedShipment(shipment, now) || isConfirmedNoItemOrder(shipment) ||
        isHiddenCompletedOrderPlaceholder(shipment) ||
        attached.has(event.shipmentId)) continue;
    if (carrierAwaitingRecognition(shipment)) {
      settled.push(event);
      continue;
    }
    if (freshEventShipmentIds.has(event.shipmentId)) continue;
    const released = {
      ...shipmentNotificationPresentation(shipment),
      ...(event.batchId ? { batchId: event.batchId } : {}),
    };
    if (!notificationEnabled(released.semantic)) continue;
    settled.push({ ...released, id: checksum({ revision, event: released }) });
  }
  return settled;
}

function saveStateAndPrune(
  candidate: AppState,
  now: number,
  notificationCommit: StateSaveOptions,
  previousInTransaction?: AppState,
  pickupCodeRecords?: readonly PickupCodeRecord[],
): { state: AppState; routesPruned: boolean; verified?: { serialized: string; readAtMs: number } } {
  const startedAtMs = Date.now();
  // ACK/defer read inside this transaction; its CAS retry re-reads before reusing the snapshot.
  const previous = previousInTransaction ?? loadState(now);
  const readDurationMs = Date.now() - startedAtMs;
  const emptyTimelineRetirements = mergeEmptyTimelineRetirements(
    previous.emptyTimelineRetirements, candidate.emptyTimelineRetirements, candidate.shipments,
  );
  const previousById = new Map(
    previous.shipments.map((shipment) => [shipment.identity.id, shipment]),
  );
  const normalizedShipments = withWaybillOwnership(
    previous.shipments,
    preserveDurableOrderProjections(
      previous.shipments,
      migrateShipmentSources(candidate.shipments)
        .map((shipment) => {
          // A rebuilt feed/detail row may omit the original terminal timestamp.
          // The persisted owner keeps that clock until the row is actually removed.
          // A new parcel on a reused number is not that owner (user 2026-10-02): the old clock stays behind.
          const persisted = previousById.get(shipment.identity.id);
          if (persisted?.identity.hadRealWaybill && shipment.identity.accountOrder &&
              persisted.identity.sourceId === shipment.identity.sourceId) {
            shipment = { ...shipment, identity: { ...shipment.identity, hadRealWaybill: true } };
          }
          const settledAtMs = newerWaybillReuseGeneration(persisted, shipment)
            ? undefined
            : persisted?.settledAtMs;
          const normalized = normalizeShipmentAuthorities(
            settledAtMs ? { ...shipment, settledAtMs } : shipment,
            now,
          );
          const pickup = persisted?.pickup;
          // Refreshes may replace the timeline. The code belongs to the same waybill generation.
          const withPickup = !normalized.pickup && pickup && pickup.waybill === displayWaybill(normalized) &&
            pickup.waybillGeneration === (normalized.waybillReuseAtMs ?? 0)
            ? { ...normalized, pickup } : normalized;
          return keepPlatformFields(persisted, withPickup);
        }),
      now,
    ),
    now,
    (shipment) => normalizeShipmentAuthorities(shipment, now),
  );
  // Hidden signed rows retain all source authority until their deletion cutoff.
  const retainedShipments = pruneExpiredManualPlaceholders(
    retainDurableShipments(applyEmptyTimelineRetirements(
      normalizedShipments, emptyTimelineRetirements, now), now),
    now,
  );
  // D245 (D237): the rows this commit deleted by retention and the rows kept hidden, recorded after the commit.
  const retentionRemoved = normalizedShipments.length - retainedShipments.length;
  // Counted only while recording is on, so a commit without diagnostics does no extra pass over its rows.
  const retentionHidden = diagnosticsEnabled()
    ? retainedShipments.length - pruneShipments(retainedShipments, now).length : 0;
  const reusedNumberRows = new Set(retainedShipments
    .filter((shipment) => newerWaybillReuseGeneration(previousById.get(shipment.identity.id), shipment))
    .map((shipment) => shipment.identity.id));
  // This outbox has one owner; an older refresh snapshot cannot erase or revive its obligations.
  const unsubscribes = normalizeEnhancementUnsubscribes(previous.pendingEnhancementUnsubscribes).filter(item =>
    item.id !== notificationCommit.acknowledgedEnhancementUnsubscribeId);
  if (notificationCommit.enhancementUnsubscribe) {
    const [pending] = normalizeEnhancementUnsubscribes([notificationCommit.enhancementUnsubscribe]);
    if (!pending) throw new Error("本机解绑记录保存失败");
    if (!unsubscribes.some(item => item.id === pending.id)) unsubscribes.push(pending);
  }
  const savedPickupCodes = prunePickupCodeRecords(
    pickupCodeRecords ?? notificationCommit.pickupCodeRecords ?? previous.pickupCodeRecords,
    now,
  );
  const artworkUpdate = notificationCommit.pickupArtworkChoice;
  let pickupArtworkChoices = previous.pickupArtworkChoices;
  if (pickupArtworkChoices || artworkUpdate) {
    const owned = new Set(savedPickupCodes?.map(record => parcelCardKey({ target: { recordId: record.id } })));
    for (const shipment of retainedShipments) {
      if (!shipment.pickup) continue;
      owned.add(parcelCardKey({ target: {
        shipmentId: shipment.identity.id,
        waybill: normalizeWaybill(shipment.pickup.waybill),
        waybillGeneration: shipment.pickup.waybillGeneration,
      } }));
    }
    pickupArtworkChoices = Object.fromEntries(Object.entries({
      ...pickupArtworkChoices, ...(artworkUpdate ? { [artworkUpdate.key]: artworkUpdate.value } : {}),
    }).filter(([key]) => owned.has(key)));
  }
  const savedWatchSource = candidate.watchSource ?? previous.watchSource;
  const savedWatchFeedback = normalizeWatchFeedback(candidate.watchFeedback ?? previous.watchFeedback)
    .filter(entry => !savedWatchSource || entry.scope === savedWatchSource.scope);
  const savedCloudPddTombstones = normalizeCloudPddTombstones(
    candidate.cloudPddTombstones ?? previous.cloudPddTombstones,
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
    ...(savedWatchSource ? {
      watchSource: savedWatchSource,
    } : {}),
    ...(savedWatchFeedback.length ? { watchFeedback: savedWatchFeedback } : {}),
    ...(savedCloudPddTombstones.length ? { cloudPddTombstones: savedCloudPddTombstones } : {}),
    ...(savedPickupCodes ? { pickupCodeRecords: savedPickupCodes } : {}),
    ...(pickupArtworkChoices && Object.keys(pickupArtworkChoices).length ? { pickupArtworkChoices } : {}),
    // An unsent event of the old parcel goes with it when a new parcel takes the reused number (user 2026-10-02).
    pendingNotifications: (previous.pendingNotifications || []).filter((event) =>
      event.id !== notificationCommit.acknowledgedId &&
      !notificationCommit.acknowledgedIds?.has(event.id) &&
      !reusedNumberRows.has(event.shipmentId)
    ),
    ...(unsubscribes.length ? { pendingEnhancementUnsubscribes: unsubscribes } : {}),
    // 一次性 feed 槽重建的标记跟着状态走：候选没带就沿用存着的，都没有就从现在起算（只有读盘时
    // 遇到没标记的老状态才会给包打 feedRebuildPending）。
    feedSlotRebuiltAtMs: candidate.feedSlotRebuiltAtMs || previous.feedSlotRebuiltAtMs || now,
    ...(emptyTimelineRetirements.length ? { emptyTimelineRetirements } : {}),
  };
  if (notificationCommit.deferredId) {
    const events = next.pendingNotifications || [];
    next.pendingNotifications = [
      ...events.filter((event) => event.id !== notificationCommit.deferredId),
      ...events.filter((event) => event.id === notificationCommit.deferredId),
    ];
  }
  // Rows that received a deliverable event in this save; a held event of theirs is superseded (T23).
  const freshEventShipmentIds = new Set<string>();
  // D131: the notification decisions this commit makes, for the diagnostic log only.
  const decisions: NotificationDecision[] = [];
  const recordDecisions = diagnosticsEnabled();
  if (notificationCommit.notifyChanges) {
    const context = notificationCommit.context;
    const baselineById = context?.previousById || previousById;
    const events: ShipmentNotificationEvent[] = [];
    // 归属方案 T3：挂靠行不通知（它自己的新节点也不单独推送，T7）。
    const attached = attachedShipmentIds(next.shipments);
    for (const shipment of next.shipments) {
      if (isHiddenSignedShipment(shipment, now) || isHiddenCancelledShipment(shipment, now) || isConfirmedNoItemOrder(shipment) ||
          isHiddenCompletedOrderPlaceholder(shipment) ||
          attached.has(shipment.identity.id)) {
        // A hidden or attached row whose change would otherwise have notified is recorded as suppressed.
        const baseline = baselineById.get(shipment.identity.id);
        if (recordDecisions && baseline && baseline !== shipment && shipmentNotificationEvent(baseline, shipment, {})) {
          decisions.push({ shipment, result: "suppressed", skipReason: attached.has(shipment.identity.id) ? "attached"
            : isConfirmedNoItemOrder(shipment) ? "no_item_order" : "retention_hidden" });
        }
        continue;
      }
      const merge = context?.orderMerges?.get(shipment.identity.id);
      const rule = { statusChangeOnly: merge != null };
      // Merge round: the absorbed waybill row's state in this round's snapshot is the baseline.
      const absorbedId = merge?.find((id) => baselineById.has(id));
      // 「当新件初次出现，不通知」（用户 2026-10-02）：新件拿走复用号码的那一行时，旧件不是它的上一次状态。
      const sameGeneration = (baseline: Shipment | null | undefined) =>
        baseline && !newerWaybillReuseGeneration(baseline, shipment) ? baseline : null;
      const notificationBaseline =
        (absorbedId && baselineById.get(absorbedId)) || sameGeneration(baselineById.get(shipment.identity.id));
      const event = shipmentNotificationEvent(
        notificationBaseline,
        shipment,
        rule,
      );
      if (recordDecisions && !notificationBaseline && !previousById.has(shipment.identity.id)) {
        decisions.push({ shipment, result: "suppressed", skipReason: "first_seen" });
      }
      // T23（用户 2026-09-26，跨端对齐裁决 #28）：承运商还没对上的行不带空白承运商排队，事件挂起，承运商对上时再生成标题。
      const hold = event ? carrierAwaitingRecognition(shipment) : false;
      if (recordDecisions && event && hold) decisions.push({ shipment, semantic: event.semantic, result: "held" });
      if (event && context && !shipmentNotificationEvent(
        (absorbedId && previousById.get(absorbedId)) || sameGeneration(previousById.get(shipment.identity.id)),
        shipment,
        rule,
      )) {
        // Another writer may have published and acknowledged this same transition.
        // Only retain this round's still-pending obligation; never recreate it.
        events.push(...(next.pendingNotifications || []).filter((pending) =>
          pending.batchId === context.batchId && pending.shipmentId === shipment.identity.id
        ).map((pending) => pending.title === event.title && pending.body === event.body &&
            pending.semantic === event.semantic && pending.iconName === event.iconName
          ? pending
          : { ...pending, ...event, id: checksum({ revision: next.revision, event }) })
          .map((pending) => withCarrierHold(pending, hold)));
        if (!hold) freshEventShipmentIds.add(shipment.identity.id);
        continue;
      }
      if (event) {
        events.push(withCarrierHold({
          ...event,
          ...(context ? { batchId: context.batchId } : {}),
          id: checksum({ revision: next.revision, event }),
        }, hold));
        if (!hold) freshEventShipmentIds.add(shipment.identity.id);
      }
    }
    // One refresh compares against its initial snapshot and publishes each row's final
    // state. Earlier runs' unacknowledged events remain separate recovery obligations.
    next.pendingNotifications = [
      ...(next.pendingNotifications || []).filter((event) =>
        !context || event.batchId !== context.batchId
      ),
      ...events,
    ];
  }
  next.pendingNotifications = settleCarrierHolds(
    next.pendingNotifications || [], next.shipments, next.revision, now, freshEventShipmentIds,
  );
  const stored = encodeState(next);
  try {
    writeDurableState(stored);
    recordStateRevision(stored.state.revision);
    writeWidgetSnapshotSidecar(stored.state, stored.checksum, now);
  } catch (error) {
    if (error instanceof SharedCommitConflict) throw error;
    writeDiagnostic(
      "storage.state.failed",
      { ...diagnosticState(next), result: "durable_write_failed" },
      "error",
    );
    throw new Error("本地快递数据保存失败");
  }
  const writeFinishedAtMs = Date.now();
  const backupStored = mirrorStoredState(STATE_BACKUP_KEY, stored, true);
  let primaryStored = true;
  primaryStored = mirrorStoredState(STATE_KEY, stored, false);
  pendingCommit = stored;
  if (
    storedStringMatches(STATE_KEY, false, stored.serialized) &&
    storedStringMatches(STATE_BACKUP_KEY, true, stored.serialized)
  ) {
    pendingCommit = null;
  }
  const verifyFinishedAtMs = Date.now();
  const shouldPruneSidecars =
    Boolean(notificationCommit.forceSidecarPrune) ||
    routesPruneDirty ||
    productImagesPruneDirty ||
    sidecarOwnersShrank(previous, stored.state, reusedNumberRows);
  const replacedCainiaoImage = previous.shipments.some((row) => {
    const image = row.platformFields?.cainiaoImage;
    if (!image) return false;
    const next = stored.state.shipments.find((shipment) => shipment.identity.id === row.identity.id);
    return !next || cainiaoImageCacheKey(row) !== cainiaoImageCacheKey(next);
  });
  if (shouldPruneSidecars || replacedCainiaoImage) {
    productImagesPruneDirty = !pruneProductImages(previous.shipments, stored.state.shipments, now);
  }
  let routesPruned = true;
  if (shouldPruneSidecars) {
    routesPruned = pruneRoutesForState(stored.state, now);
    routesPruneDirty = !routesPruned;
    // 用户 2026-10-03 优化 1、3、5 续：每行台账（签收后放行、状态对齐记录、第一次识别时的锚点）只随行真正删除或运单号被新件
    // 接管而清掉。
    pruneRowLedgerForState(
      previous.shipments.map((shipment) => shipment.identity.id),
      stored.state.shipments.map((shipment) => shipment.identity.id),
      reusedNumberRows,
      now,
    );
  }
  const mirrorsStored = primaryStored && backupStored;
  // D160 (plan step 5, owner 2026-11-21 「删噪声，低价值类保底降到 10（推荐）」): a healthy commit writes no line; a slow
  // commit and a commit whose mirror copy failed (D243) still do. Failures and recoveries have their own lines.
  const commitDurationMs = Date.now() - startedAtMs;
  if (!mirrorsStored || commitDurationMs >= STORAGE_SLOW_COMMIT_MS) writeDiagnostic(
    "storage.state.saved",
    {
      ...diagnosticState(stored.state),
      commitProtocol: "immutable_link",
      commitSequence: sharedCommitSequence(),
      durationMs: commitDurationMs,
      readDurationMs,
      writeDurationMs: writeFinishedAtMs - startedAtMs - readDurationMs,
      verifyDurationMs: verifyFinishedAtMs - writeFinishedAtMs,
      pruneDurationMs: Date.now() - verifyFinishedAtMs,
      result: mirrorsStored
        ? "durable_and_mirrors"
        : "durable_only",
    },
    // D243: a mirror copy that failed to write is a degraded commit the next one repairs, so it is a WARNING.
    mirrorsStored ? "info" : "warning",
  );
  try {
    const batchId = notificationCommit.context?.batchId;
    // D245: written when rows were deleted, or when a nonzero number of hidden rows changed.
    if (retentionRemoved > 0 ||
        (retentionHidden > 0 && changedSinceLastLogged("storage.retention.hidden", String(retentionHidden), now))) {
      writeDiagnostic("storage.retention.applied", {
        ...(batchId && /^\d+$/.test(batchId) ? { flowId: batchId } : {}),
        removedRecords: Math.max(0, retentionRemoved), hiddenRecords: Math.max(0, retentionHidden),
        result: retentionRemoved > 0 ? "removed" : "hidden",
      });
    }
    recordRowPresentationChanges(previous.shipments, stored.state.shipments, batchId, now);
    recordNotificationDecisions(decisions, batchId);
  } catch { /* Diagnostics never change a commit. */ }
  const verified = mirrorsStored && !pendingCommit && !lastStateLoadFailure &&
    !routesPruneDirty && !productImagesPruneDirty && !stored.state.emptyTimelineRetirements?.length
    ? { serialized: stored.serialized, readAtMs: now }
    : undefined;
  return { state: stored.state, routesPruned, ...(verified ? { verified } : {}) };
}


/** A commit at least this long is recorded even when it succeeded (D160). */
export const STORAGE_SLOW_COMMIT_MS = 1_000;

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
  return value ? stableJson(value) : "";
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

function coreIdentityWithoutEnrichment(identity: Shipment["identity"]): Record<string, unknown> {
  const {
    courierCode: _courierCode,
    rawCourierCode: _rawCourierCode,
    companyName: _companyName,
    carrierIsBuiltIn: _carrierIsBuiltIn,
    carrierKuaidi100Code: _carrierKuaidi100Code,
    carrierTableVersion: _carrierTableVersion,
    productImageURL: _productImageURL,
    ...core
  } = identity;
  return core;
}

/** Independent provider results may commit together; a newer result in the same slot wins. */
function rebaseIndependentTimelines(before: Shipment, current: Shipment, incoming: Shipment, now: number): Shipment | null {
  const digest = (value: unknown) => stableJson(value ?? null);
  const coreBefore = digest(coreIdentityWithoutEnrichment(before.identity));
  if (
    coreBefore !== digest(coreIdentityWithoutEnrichment(current.identity)) ||
    coreBefore !== digest(coreIdentityWithoutEnrichment(incoming.identity)) ||
    before.forcedCompletedAtMs !== current.forcedCompletedAtMs ||
    before.emptyTimelineHiddenAtMs !== current.emptyTimelineHiddenAtMs
  ) {
    return null;
  }
  const identityChangedOnCurrent = digest(before.identity) !== digest(current.identity);
  const identityChangedOnIncoming = digest(before.identity) !== digest(incoming.identity);
  if (identityChangedOnCurrent && identityChangedOnIncoming && digest(current.identity) !== digest(incoming.identity)) {
    return null;
  }
  if (digest(before.manualRefreshLease) !== digest(incoming.manualRefreshLease) &&
      digest(before.manualRefreshLease) !== digest(current.manualRefreshLease)) return null;
  let merged: Shipment = identityChangedOnIncoming ? { ...current, identity: incoming.identity } : current;
  if (digest(before.sourceTimeline) !== digest(incoming.sourceTimeline)) {
    if (digest(before.sourceTimeline) !== digest(current.sourceTimeline) || !incoming.sourceTimeline) return null;
    merged = applyAccountShipment(current, { ...incoming, manualTimelines: current.manualTimelines,
      detailSelection: current.detailSelection, note: current.note }, now);
  }
  const slots = (shipment: Shipment) => new Map((shipment.manualTimelines || []).map(p => [normalizeTimelineSlot(p.provider), p]));
  const baseSlots = slots(before);
  const currentSlots = slots(current);
  for (const [provider, pack] of slots(incoming)) {
    if (digest(pack) === digest(baseSlots.get(provider))) continue;
    const currentPack = currentSlots.get(provider);
    if (currentPack && refreshValueFingerprint(pack) === refreshValueFingerprint(currentPack)) continue;
    if (digest(baseSlots.get(provider)) !== digest(currentSlots.get(provider))) return null;
    merged = applySameSourceTimeline(merged, pack, now);
  }
  if (digest(before.detailSelection) !== digest(incoming.detailSelection) &&
      digest(before.detailSelection) === digest(current.detailSelection)) {
    merged = { ...merged, detailSelection: incoming.detailSelection };
  }
  for (const field of ["manualRefreshLease", "manualRefreshAttemptAtMs", "cainiaoH5FallbackActivatedAtMs", "pendingKdniaoAttemptAtMs", "route"] as const) {
    if (digest(before[field]) !== digest(incoming[field]) && digest(before[field]) === digest(current[field])) {
      merged = { ...merged, [field]: incoming[field] };
    }
  }
  return { ...merged, timeline: selectShipmentTimeline(merged), updatedAtMs: now };
}

function ownsRefreshBinding(base: AppState, latest: AppState, shipment: Shipment): boolean {
  if (shipment.identity.manuallyAdded || !shipment.identity.phone) return true;
  const matches = (binding: AccountBinding) => binding.source === shipment.identity.bindingSource &&
    binding.phone === phone(shipment.identity.phone || "");
  const original = base.bindings.find(matches);
  const current = latest.bindings.find(matches);
  return Boolean(original && current && original.boundAtMs === current.boundAtMs &&
    original.enhancedMode === current.enhancedMode && original.enhancedAtMs === current.enhancedAtMs &&
    original.enhancedIdentityFingerprint === current.enhancedIdentityFingerprint);
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
  routesPruned?: boolean;
  acceptedShipmentIds?: ReadonlySet<string>;
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

export function refreshValueFingerprint(value: unknown): string {
  return stableJson(withoutRefreshVolatility(value));
}

function refreshContentFingerprint(state: AppState): string {
  return refreshValueFingerprint({
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
  });
}

export function commitRefreshState(
  base: AppState,
  candidate: AppState,
  bindingSource: BindingSource,
  now = Date.now(),
  fence?: RefreshCommitFence,
  notificationContext?: RefreshNotificationContext,
): RefreshStateCommit {
  return withSharedFileTransaction(() => {
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
    const shipmentsById = new Map(latest.shipments.map((item) => [item.identity.id, item]));
    const acceptedShipmentIds = new Set<string>();

    for (const [id, candidateIncoming] of candidateShipments) {
      const before = baseShipments.get(id);
      const current = shipmentsById.get(id);
      if (before && !current) continue;
      let incoming = candidateIncoming;
      if (before && current && stableJson(current) !== stableJson(before)) {
        const rebased = rebaseNewAccountProjection(before, current, incoming) ||
          rebaseIndependentTimelines(before, current, incoming, now);
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
            baselineBinding.boundAtMs !== latestBinding.boundAtMs ||
            baselineBinding.enhancedMode !== latestBinding.enhancedMode ||
            baselineBinding.enhancedAtMs !== latestBinding.enhancedAtMs ||
            baselineBinding.enhancedIdentityFingerprint !== latestBinding.enhancedIdentityFingerprint
          ) {
            continue;
          }
        }
      }
      // 落库前的最后一道闸：签收之后轨迹不许变少。整行被 feed 重建时合并里的那道闸拿不到
      // `current`，根本不会执行（用户 2026-09-08 报：签收件每轮刷新之后「暂无物流动态」）。
      shipmentsById.set(id, preserveSettledShipment(current, incoming));
      acceptedShipmentIds.add(id);
    }

    for (const [id, before] of baseShipments) {
      if (candidateShipments.has(id)) continue;
      const current = shipmentsById.get(id);
      if (current && stableJson(current) === stableJson(before)) {
        shipmentsById.delete(id);
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
    const pendingById = new Map(latest.pendingQueries.map((item) => [item.id, item]));
    for (const [id, incoming] of candidatePending) {
      const before = basePending.get(id);
      const current = pendingById.get(id);
      if (before && !current) continue;
      if (before && pendingVersion(current) !== pendingVersion(before)) continue;
      pendingById.delete(id);
      pendingById.set(id, incoming);
    }
    for (const [id, before] of basePending) {
      if (candidatePending.has(id)) continue;
      const current = pendingById.get(id);
      if (pendingVersion(current) === pendingVersion(before)) {
        pendingById.delete(id);
      }
    }

    if (
      fence &&
      (
        !fence.isCurrent() ||
        (fence.acceptsState != null && !fence.acceptsState(latest))
      )
    ) {
      return { state: latest, applied: false };
    }
    const merged = { ...latest, shipments: [...shipmentsById.values()], pendingQueries: [...pendingById.values()] };
    if (
      refreshContentFingerprint(merged) === refreshContentFingerprint(latest)
    ) {
      return { state: latest, applied: true, acceptedShipmentIds };
    }
    return {
      ...saveStateAndPrune(merged, now, { notifyChanges: true, context: notificationContext }, latest),
      applied: true,
      acceptedShipmentIds,
    };
  });
}

export function acknowledgeShipmentNotification(
  eventId: string,
  now = Date.now(),
  prior?: LoadedStateSnapshot,
): AppState {
  return acknowledgeShipmentNotificationsSnapshot([eventId], now, prior).state;
}

export function acknowledgeShipmentNotificationsSnapshot(
  eventIds: readonly string[],
  now = Date.now(),
  prior?: LoadedStateSnapshot,
): LoadedStateSnapshot {
  if (!eventIds.length) return loadStateSnapshot(now, prior);
  const targetIds = new Set(eventIds);
  return withSharedFileTransaction(() => {
    const loaded = loadStateSnapshot(now, prior);
    const state = loaded.state;
    if (!state.pendingNotifications?.some((event) => targetIds.has(event.id))) return loaded;
    const saved = saveStateAndPrune(
      state,
      now,
      eventIds.length === 1 ? { acknowledgedId: eventIds[0] } : { acknowledgedIds: targetIds },
      state,
    );
    return { state: saved.state, ...(saved.verified ? { verified: saved.verified } : {}) };
  });
}

export function deferShipmentNotification(
  eventId: string,
  now = Date.now(),
  prior?: LoadedStateSnapshot,
): AppState {
  return deferShipmentNotificationSnapshot(eventId, now, prior).state;
}

export function deferShipmentNotificationSnapshot(
  eventId: string,
  now = Date.now(),
  prior?: LoadedStateSnapshot,
): LoadedStateSnapshot {
  return withSharedFileTransaction(() => {
    const loaded = loadStateSnapshot(now, prior);
    const state = loaded.state;
    if (!state.pendingNotifications?.some((event) => event.id === eventId)) return loaded;
    const saved = saveStateAndPrune(state, now, { deferredId: eventId }, state);
    return { state: saved.state, ...(saved.verified ? { verified: saved.verified } : {}) };
  });
}

export function acknowledgeEnhancementUnsubscribe(id: string, now = Date.now()): AppState {
  return withSharedFileTransaction(() => {
    const state = loadState(now);
    if (!state.pendingEnhancementUnsubscribes?.some(item => item.id === id)) return state;
    return saveState(state, now, { acknowledgedEnhancementUnsubscribeId: id }, state);
  });
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
  return withSharedFileTransaction(() => {
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
          { ...existing.find(binding => binding.phone === normalizedPhone),
            source: bindingSource, phone: normalizedPhone, boundAtMs: now },
        ],
      },
      now,
    );
  });
}

export function enableBindingEnhancement(phoneNumber: string, expectedBoundAtMs: number, now = Date.now(),
  identityFingerprint?: string): AppState {
  if (identityFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(identityFingerprint)) {
    throw new Error("增强模式身份校验失败，请重新验证绑定该手机号");
  }
  return withSharedFileTransaction(() => {
    const state = loadState(now), normalizedPhone = phone(phoneNumber);
    const current = state.bindings.find(binding => binding.source === SCRIPT_BINDING_SOURCE && binding.phone === normalizedPhone);
    if (!current || current.boundAtMs !== expectedBoundAtMs) throw new Error("手机号绑定已变更，请稍后重试");
    const mark = (identity: Shipment["identity"]): Shipment["identity"] =>
      identity.bindingSource === SCRIPT_BINDING_SOURCE && identity.phone === normalizedPhone && identity.accountOrder &&
      String(identity.sourceProvider || "").toLowerCase() === "jingdong"
        ? { ...identity, enhancedMode: true } : identity;
    return saveBindingTransition(state, { ...state, bindings: state.bindings.map(binding =>
      binding === current ? { ...binding, enhancedMode: true, enhancedAtMs: now,
        enhancedIdentityFingerprint: identityFingerprint } : binding),
      shipments: state.shipments.map(shipment => ({ ...shipment, identity: mark(shipment.identity),
        ...(shipment.automaticOwnership ? { automaticOwnership: { ...shipment.automaticOwnership,
          observations: shipment.automaticOwnership.observations.map(observation =>
            ({ ...observation, identity: mark(observation.identity) })) } } : {}) })) }, now);
  });
}

function saveBindingTransition(
  previous: AppState,
  candidate: AppState,
  now: number,
  options: StateSaveOptions = {},
): AppState {
  const saved = saveState(candidate, now, options, previous);
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
  return withSharedFileTransaction(() => {
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
      !ownsRefreshBinding(base, latest, before)
    ) {
      return { state: latest, applied: false };
    }
    if (stableJson(before) !== stableJson(current)) {
      const rebased = refreshValueFingerprint(current) === refreshValueFingerprint(incoming)
        ? current
        : rebaseIndependentTimelines(before, current, incoming, now);
      if (!rebased) return { state: latest, applied: false };
      incoming = rebased;
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
      shipments: replaceShipment(
        latest.shipments, preserveSettledShipment(current, incoming)),
    };
    if (
      refreshContentFingerprint(merged) === refreshContentFingerprint(latest)
    ) {
      return { state: latest, applied: true };
    }
    return { state: saveState(merged, now, { notifyChanges: true }, latest), applied: true };
  });
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
  return withSharedFileTransaction(() => {
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
        if (!before || !current || !after || stableJson(before) !== stableJson(current)) {
          throw new Error("快递状态已更新，请稍后重试");
        }
        continue;
      }
      const before = base.pendingQueries.find((item) => item.id === target.targetId);
      const current = latest.pendingQueries.find((item) => item.id === target.targetId);
      const after = candidate.pendingQueries.find((item) => item.id === target.targetId);
      if (!before || !current || !after || stableJson(before) !== stableJson(current)) {
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
  const merged = { ...latest, shipments, pendingQueries };
  if (refreshContentFingerprint(merged) === refreshContentFingerprint(latest)) {
    return latest;
  }
  return saveState(merged, now, {}, latest);
  });
}

export function privateHash(value: string): string {
  return sha256Hex(String(value || ""));
}

export function removeBinding(
  bindingSource: BindingSource,
  phoneNumber: string,
  now = Date.now(),
  expectedBinding?: AccountBinding,
  pendingUnsubscribe?: { identityFingerprint: string },
): AppState {
  return withSharedFileTransaction(() => {
    requireScriptSource(bindingSource);
    const state = loadState(now);
    const normalizedPhone = phone(phoneNumber);
    const sourceBindings = bindingsForSource(state, bindingSource);
    if (expectedBinding && !sourceBindings.some(binding =>
      binding.phone === normalizedPhone && binding.boundAtMs === expectedBinding.boundAtMs &&
      binding.enhancedMode === expectedBinding.enhancedMode && binding.enhancedAtMs === expectedBinding.enhancedAtMs &&
      binding.enhancedIdentityFingerprint === expectedBinding.enhancedIdentityFingerprint)) {
      throw new Error("手机号绑定已变更，请稍后重试");
    }
    const suffix = normalizedPhone.slice(-4);
    const currentBinding = sourceBindings.find(binding => binding.phone === normalizedPhone);
    const enhancementUnsubscribe: PendingEnhancementUnsubscribe | undefined = pendingUnsubscribe && currentBinding?.enhancedMode ? {
      id: privateHash(JSON.stringify([normalizedPhone, currentBinding.boundAtMs, currentBinding.enhancedAtMs || 0,
        pendingUnsubscribe.identityFingerprint])),
      phone: normalizedPhone, boundAtMs: currentBinding.boundAtMs,
      enhancedAtMs: currentBinding.enhancedAtMs || 0, identityFingerprint: pendingUnsubscribe.identityFingerprint, createdAtMs: now,
    } : undefined;
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
    { enhancementUnsubscribe, forceSidecarPrune: true },
  );
  });
}

export function upsertShipment(incoming: Shipment, now = Date.now()): AppState {
  return withSharedFileTransaction(() => {
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
    const clearedTombstones = incoming.identity.manuallyAdded && state.cloudPddTombstones?.length
      ? state.cloudPddTombstones.filter(
          entry => !(entry.action === "deleted" && entry.waybill === normalizeWaybill(displayWaybill(shipment))),
        )
      : state.cloudPddTombstones;
    return saveState(
      {
        ...state,
        ...(clearedTombstones !== state.cloudPddTombstones ? { cloudPddTombstones: clearedTombstones } : {}),
        shipments: [
          ...state.shipments.filter(
            (item) => item.identity.id !== shipment.identity.id,
          ),
          shipment,
        ],
      },
      now,
      {},
      state,
    );
  });
}

/** The parcel lifecycle owns the note. An empty value clears it. */
export function setShipmentNote(expected: Shipment, note: string, now = Date.now()): AppState {
  return withSharedFileTransaction(() => {
    const state = loadState(now);
    const trimmed = String(note || "").trim();
    const current = state.shipments.find((item) => item.identity.id === expected.identity.id);
    if (!current || !ownsShipment(state, current) || shipmentLifecycleKey(current) !== shipmentLifecycleKey(expected)) {
      throw new ShipmentLifecycleChangedError();
    }
    if ((current.note || "") === trimmed) return state;
    // 抬一下 updatedAtMs：详情页与父页面用 preferNewerShipment 挑新的那份，不抬的话父页面回传的
    // 旧对象（同一时间戳）会把刚写的备注盖掉（2026-09-05 晚 iPhone 实测「保存没生效」）。
    const updated: Shipment = { ...current, updatedAtMs: Math.max(now, current.updatedAtMs + 1) };
    if (trimmed) updated.note = trimmed;
    else delete updated.note;
    return saveState(
      {
        ...state,
        shipments: state.shipments.map((item) =>
          item.identity.id === current.identity.id ? updated : item
        ),
      },
      now,
      {},
      state,
    );
  });
}

export function setShipmentProductName(expected: Shipment, name: string, now = Date.now()): AppState {
  return withSharedFileTransaction(() => {
    const state = loadState(now);
    const current = state.shipments.find((item) => item.identity.id === expected.identity.id);
    if (!current || !ownsShipment(state, current) || shipmentLifecycleKey(current) !== shipmentLifecycleKey(expected)) {
      throw new ShipmentLifecycleChangedError();
    }
    const waybill = unprojectedAccountOrder(current) ? "" : displayWaybill(current);
    const waybillGeneration = current.waybillReuseAtMs ?? 0;
    const previous = current.platformFields;
    const fields = previous?.waybill === waybill && previous.waybillGeneration === waybillGeneration
      ? previous : undefined;
    const title = name.trim().slice(0, 512);
    if (title === (fields?.manualTitle || "")) return state;
    const platformFields = {
      ...fields, waybill, waybillGeneration, manualTitle: title || undefined,
      manualTitleEditedAtMs: Math.max(now, (fields?.manualTitleEditedAtMs ?? 0) + 1),
    };
    const updated = { ...current, platformFields, updatedAtMs: Math.max(now, current.updatedAtMs + 1) };
    return saveState({
      ...state,
      shipments: state.shipments.map((item) => item === current ? updated : item),
    }, now, {}, state);
  });
}

const DETAIL_SELECTION_STATE_CACHE_MAX = 256;
const verifiedDetailSelectionStateRefs = new Map<string, string>();

/**
 * Sticky detail selection is recorded when the detail page shows a package (audit D7, adopted
 * 2026-09-25: all three clients record it at display, Lite on every render and Pipi on every detail
 * load). iOS used to record it only when a detail refresh or entry query committed, so a package
 * delivered later by the list or a background round could replace the one the user had been looking
 * at. Only the stored row's own selection changes; returns null when nothing had to be written.
 */
export function recordShipmentDetailSelection(id: string, now = Date.now()): AppState | null {
  const currentRef = sharedData().stateRef;
  if (currentRef && verifiedDetailSelectionStateRefs.get(id) === currentRef) {
    return null;
  }
  return withSharedFileTransaction(() => {
    const innerRef = sharedData().stateRef;
    if (innerRef && verifiedDetailSelectionStateRefs.get(id) === innerRef) {
      return null;
    }
    const state = loadState(now);
    const current = state.shipments.find((item) => item.identity.id === id);
    if (!current) return null;
    const selected = withDetailSelection(current, now);
    const rememberRef = () => {
      const nextRef = sharedData().stateRef;
      if (!nextRef) return;
      if (verifiedDetailSelectionStateRefs.size >= DETAIL_SELECTION_STATE_CACHE_MAX) {
        const oldest = verifiedDetailSelectionStateRefs.keys().next().value;
        if (oldest !== undefined) verifiedDetailSelectionStateRefs.delete(oldest);
      }
      verifiedDetailSelectionStateRefs.set(id, nextRef);
    };
    if (selected === current) {
      rememberRef();
      return null;
    }
    const saved = saveState({
      ...state,
      shipments: state.shipments.map((item) => item.identity.id === id ? selected : item),
    }, now, {}, state);
    rememberRef();
    return saved;
  });
}

export function removeShipment(id: string, now = Date.now()): AppState {
  return removeShipmentWithCleanup(id, now).state;
}

export function removeShipmentWithCleanup(
  id: string,
  now = Date.now(),
): { state: AppState; routesPruned: boolean } {
  return withSharedFileTransaction(() => {
    const state = loadState(now);
    const shipment = state.shipments.find((item) => item.identity.id === id);
    if (shipment && !ownsShipment(state, shipment)) throw new ShipmentLifecycleChangedError();
    const canonical = shipment ? displayWaybill(shipment) : "";
    const watchScope = state.watchSource?.scope || activeWatchScope();
    const watchFeedback = shipment && internationalShipment(shipment) && watchScope && id.startsWith("watch:")
      ? upsertWatchFeedbackEntry(state.watchFeedback, {
          scope: watchScope,
          watchRecordId: id.slice("watch:".length),
          waybill: canonical,
          action: "deleted",
          actedAt: now,
          latestTrackAtMs: latestWatchTrackAtMs(shipment),
        })
      : state.watchFeedback;
    const cloudOriginWaybill = shipment?.identity.manuallyAdded
      ? (shipment.cloudExpressOrigin?.waybill || "")
      : "";
    const cloudPddTombstones = cloudOriginWaybill
      ? upsertCloudPddTombstoneEntry(state.cloudPddTombstones, {
          waybill: normalizeWaybill(cloudOriginWaybill || canonical),
          anchorAt: Math.max(0, Math.trunc(Number(shipment?.identity.createdAtMs) || 0)),
          action: "deleted",
          actedAtMs: now,
        }, now)
      : state.cloudPddTombstones;
    return saveStateAndPrune(
      {
        ...state,
        ...(watchFeedback !== state.watchFeedback ? { watchFeedback } : {}),
        ...(cloudPddTombstones !== state.cloudPddTombstones ? { cloudPddTombstones } : {}),
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
      { forceSidecarPrune: true },
      state,
    );
  });
}

export function forceCompleteShipment(
  id: string,
  now = Date.now(),
): AppState {
  return withSharedFileTransaction(() => {
    const state = loadState(now);
    const current = state.shipments.find((item) => item.identity.id === id);
    if (current && !ownsShipment(state, current)) throw new ShipmentLifecycleChangedError();
    if (!current || current.timeline.semantic === "COMPLETED") return state;
    const canonical = displayWaybill(current);
    const watchScope = state.watchSource?.scope || activeWatchScope();
    const watchFeedback = internationalShipment(current) && watchScope && id.startsWith("watch:")
      ? upsertWatchFeedbackEntry(state.watchFeedback, {
          scope: watchScope,
          watchRecordId: id.slice("watch:".length),
          waybill: canonical,
          action: "completed",
          actedAt: now,
          latestTrackAtMs: latestWatchTrackAtMs(current),
        })
      : state.watchFeedback;
    const cloudOriginWaybill = current.identity.manuallyAdded
      ? (current.cloudExpressOrigin?.waybill || "")
      : "";
    const cloudPddTombstones = cloudOriginWaybill
      ? upsertCloudPddTombstoneEntry(state.cloudPddTombstones, {
          waybill: normalizeWaybill(cloudOriginWaybill || canonical),
          anchorAt: Math.max(0, Math.trunc(Number(current.identity.createdAtMs) || 0)),
          action: "completed",
          actedAtMs: now,
        }, now)
      : state.cloudPddTombstones;
    return saveState(
      {
        ...state,
        ...(watchFeedback !== state.watchFeedback ? { watchFeedback } : {}),
        ...(cloudPddTombstones !== state.cloudPddTombstones ? { cloudPddTombstones } : {}),
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
      {},
      state,
    );
  });
}

export function upsertPendingQuery(
  pending: PendingManualQuery,
  now = Date.now(),
): AppState {
  return withSharedFileTransaction(() => {
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
      {},
      state,
    );
  });
}

export function removePendingQuery(id: string, now = Date.now()): AppState {
  return withSharedFileTransaction(() => {
    const state = loadState(now);
    return saveState(
      {
        ...state,
        pendingQueries: state.pendingQueries.filter((item) => item.id !== id),
      },
      now,
      {},
      state,
    );
  });
}
