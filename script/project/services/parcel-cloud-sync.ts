import type {
  AppState,
  IgnoredCloudManualWaybill,
  ParcelHandoffRecord,
  PickupCodeRecord,
  PickupPlatform,
  Shipment,
  StandaloneParcelPickup,
  StatusSemantic,
  WatchFeedbackRecord,
} from "../models";
import { projectedCarrierPresentation } from "./carrier-presentation";
import { gatewayCredentialForLocalCache } from "./credentials";
import { readDurableTextResult, writeDurableText } from "./durable-files";
import { GatewayError, postGateway } from "./gateway";
import { activeWatchScope, internationalShipment } from "./international-records";
import {
  beginDiagnosticOperation,
  changedSinceLastLogged,
  diagnosticErrorDetails,
  writeDiagnostic,
} from "./logger";
import { pendingManualPreviewShipment } from "./manual-preview";
import { MEAL_UUID } from "./meal/records";
import { mealCredentialScope } from "./meal/rules";
import { parcelHandoffDeadline } from "./parcel-handoff-expiry";
import { productTitle } from "./platform-parcel-data";
import {
  applyCloudPddParcels,
  deliveryEstimateApplies,
  matchingCloudPddTombstone,
  type CloudParcelMetadata,
  type CloudParcelPddLink,
  type CloudPddParcel,
} from "./platform-parcel-merge";
import { cloudProductImageURL } from "./product-image-url";
import { acquireRenewingDurableRefreshLease } from "./refresh-runtime-state";
import { publishSharedData, sharedData, withSharedFileTransaction } from "./shared-file-transaction";
import { shipmentLifecycleKey } from "./shipment-lifecycle";
import { displayWaybill, unprojectedAccountOrder } from "./shipment-policy";
import {
  normalizeWaybill,
  shipmentDetailPhoneTail,
  shipmentPresentationStatus,
  timelineLatestEventAt,
  timelineLatestTrackAt,
} from "./status";
import { loadState, saveState } from "./storage";
import { asPlainObject, cleanString, cloudRecordTime, isPlainObject } from "./value-guards";
import {
  matchesParcelMetadataLifecycle,
  shipmentReuseAnchorAtMs,
  WAYBILL_REUSE_MIN_GAP_MS,
} from "./waybill-reuse";
import { requestWidgetReload } from "./widgets";

const CLOUD_ROOT = "/api/cloud-records/scripting-parcels/";
const PARCEL_CLOUD_FILE = "parcel-cloud-sync-v1.json";
const MAX_STEPS = 32;
const BUDGET_MS = 18_000;
const REQUEST_TIMEOUT_MS = 6_000;
const CLOUD_DENIED_BACKOFF_MS = 5 * 60_000;
const RETENTION_CUTOFF_MS = 90 * 86_400_000;
const EXPRESS_SIGN_RETENTION_MS = 21 * 86_400_000;
const CLOUD_TITLE_CACHE_LIMIT = 64;
const ESTIMATE_MAX_CHARS = 80;
export const PARCEL_CLOUD_QUARANTINE_TTL_MS = 24 * 60 * 60 * 1_000;
export const PARCEL_CLOUD_QUARANTINE_MAX_REJECTIONS = 2;

const WAYBILL_PATTERN = /^[A-Z0-9]{6,64}$/;
const WATCH_WAYBILL_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;
const SHIPPING_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const ESTIMATE_WIRE_PATTERN = /^预计[^\r\n。；;]+送达。?$/;

const ALLOWED_TYPES = new Set<ParcelCloudRecordType>([
  "express",
  "express_metadata",
  "express_pdd_link",
  "express_note",
  "parcel_pickup",
  "parcel_handoff",
  "express_watch_feedback",
]);

const ALLOWED_STATUSES = new Set<StatusSemantic>([
  "CANCELLED",
  "DANGER",
  "ORDERED",
  "SHIPPED",
  "PICKED",
  "TRANSIT",
  "DELIVERY",
  "WAITING_PICKUP",
  "COMPLETED",
  "UNKNOWN",
]);

export type ParcelCloudRecordType =
  | "express"
  | "express_metadata"
  | "express_pdd_link"
  | "express_note"
  | "parcel_pickup"
  | "parcel_handoff"
  | "express_watch_feedback";

export type ParcelCloudSession = Readonly<{
  ownerId: string;
  endpointId: string;
  generation: number;
  epoch: string;
  nextSequence: number;
  expressParcelDetailsSupported?: true;
  expressTitleClockSupported?: true;
  expressWatchFeedbackSupported?: true;
}>;

export type ParcelCloudEnvelope = Readonly<{
  recordId: string;
  type: ParcelCloudRecordType;
  revision: number;
  changedAt: number;
  editedAt: number;
  lifecycle: "active" | "history";
  historyAt: number;
  deleted: boolean;
  reason?: "user" | "retention";
  payload?: Record<string, unknown>;
}>;

export type ParcelCloudEdit = Readonly<{
  mutationId: string;
  recordId: string;
  type: ParcelCloudRecordType;
  editedAt: number;
  deleted?: true;
  requiresExisting?: true;
  lifecycle: "active" | "history";
  historyAt: number;
  payload?: Record<string, unknown>;
}>;

export type ParcelCloudMutation = Readonly<{
  mutationId: string;
  recordId: string;
  baseRevision: number;
  type: ParcelCloudRecordType;
  operation: "put" | "delete" | "restore";
  lifecycle?: "active" | "history";
  historyAt?: number;
  editedAt: number;
  payload?: Record<string, unknown>;
}>;

export type ParcelCloudBatch = Readonly<{
  schemaVersion: 1;
  generation: number;
  epoch: string;
  sequence: number;
  requestId: string;
  includeExpressMetadata: true;
  includeExpressTitleClock?: true;
  includeExpressPddLink: true;
  includeParcelCodeNotes: true;
  includePdd: true;
  includeVivoDouyin: true;
  includeExpressWatchFeedback?: true;
  mutations: readonly [ParcelCloudMutation];
}>;

export type ParcelSyncedBaseline = Readonly<{
  revision: number;
  type: ParcelCloudRecordType;
  localKey: string;
  editedAt: number;
  noteText?: string;
  localDigest?: string;
}>;

export type ParcelQuarantinedRecord = Readonly<{
  digest: string;
  expiresAtMs?: number;
  permanent?: true;
}>;

export type ParcelQuarantineHistoryEntry = Readonly<{
  digest: string;
  rejections: number;
}>;

export type ParcelCloudSnapshot = Readonly<{
  schemaVersion: 1;
  session?: ParcelCloudSession;
  cursor: number | null;
  snapshot?: Readonly<{
    epoch: string;
    cursor: number;
    token: string;
    records: Readonly<Record<string, ParcelCloudEnvelope>>;
  }>;
  remote: Readonly<Record<string, ParcelCloudEnvelope>>;
  synced: Readonly<Record<string, ParcelSyncedBaseline>>;
  edits: Readonly<Record<string, ParcelCloudEdit>>;
  pddLinks?: Readonly<Record<string, CloudParcelPddLink>>;
  quarantined?: Readonly<Record<string, ParcelQuarantinedRecord>>;
  quarantineHistory?: Readonly<Record<string, ParcelQuarantineHistoryEntry>>;
  legacyManualTitleCleaned?: true;
  batch?: ParcelCloudBatch;
}>;

type ParcelCloudStoreFile = Readonly<{
  version: 1;
  scopes: Readonly<Record<string, ParcelCloudSnapshot>>;
}>;

const PARCEL_DETAIL_NAMESPACE_BYTES = new Uint8Array([
  0x4d, 0x95, 0x3a, 0x34, 0x73, 0x99, 0x5d, 0x91,
  0xa3, 0x6b, 0xb2, 0x3c, 0xcc, 0xf4, 0x2c, 0x49,
]);

function utf8Bytes(input: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

/** Pure RFC 3174 SHA-1 so deterministic UUIDv5 record IDs work identically in Scripting and Node tests. */
function sha1Bytes(message: Uint8Array): Uint8Array {
  const bitLenHi = Math.floor(message.length / 0x20000000);
  const bitLenLo = (message.length << 3) >>> 0;
  const totalWords = (((message.length + 9 + 63) >> 6) << 4);
  const words = new Uint32Array(totalWords);
  for (let i = 0; i < message.length; i++) {
    words[i >> 2] |= message[i]! << (24 - ((i & 3) << 3));
  }
  words[message.length >> 2] |= 0x80 << (24 - ((message.length & 3) << 3));
  words[totalWords - 2] = bitLenHi >>> 0;
  words[totalWords - 1] = bitLenLo;

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  const rotl = (value: number, shift: number) => ((value << shift) | (value >>> (32 - shift))) >>> 0;

  for (let offset = 0; offset < totalWords; offset += 16) {
    for (let i = 0; i < 16; i++) w[i] = words[offset + i]!;
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20
        ? ((b & c) | ((~b) & d)) >>> 0
        : i < 40
          ? (b ^ c ^ d) >>> 0
          : i < 60
            ? ((b & c) | (b & d) | (c & d)) >>> 0
            : (b ^ c ^ d) >>> 0;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const temp = (rotl(a, 5) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const writeWord = (pos: number, word: number) => {
    out[pos] = (word >>> 24) & 0xff;
    out[pos + 1] = (word >>> 16) & 0xff;
    out[pos + 2] = (word >>> 8) & 0xff;
    out[pos + 3] = word & 0xff;
  };
  writeWord(0, h0);
  writeWord(4, h1);
  writeWord(8, h2);
  writeWord(12, h3);
  writeWord(16, h4);
  return out;
}

/** Matches Worker `parcelDetailRecordId(prefix, waybill)` (UUIDv5 over PARCEL_DETAIL_NAMESPACE). */
export function parcelDetailRecordId(prefix: string, waybill: string): string {
  const suffix = utf8Bytes(`${prefix}${waybill}`);
  const combined = new Uint8Array(PARCEL_DETAIL_NAMESPACE_BYTES.length + suffix.length);
  combined.set(PARCEL_DETAIL_NAMESPACE_BYTES, 0);
  combined.set(suffix, PARCEL_DETAIL_NAMESPACE_BYTES.length);
  const digest = sha1Bytes(combined).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && MEAL_UUID.test(value);
}

function newUuid(): string {
  try {
    const generated = UUID.string().toLowerCase();
    if (MEAL_UUID.test(generated)) return generated;
  } catch {
    // Fallback for lightweight test environments without host UUID.
  }
  return parcelDetailRecordId("parcel-random:", `${Date.now()}:${Math.random()}`);
}

function emptyParcelCloudSnapshot(): ParcelCloudSnapshot {
  return {
    schemaVersion: 1,
    cursor: null,
    remote: {},
    synced: {},
    edits: {},
  };
}

let memoryFallbackStore: ParcelCloudStoreFile = { version: 1, scopes: {} };

function readStoreFile(): ParcelCloudStoreFile {
  const candidates = readDurableTextResult(PARCEL_CLOUD_FILE).candidates;
  for (const rawText of candidates) {
    if (!rawText) continue;
    try {
      const parsed = JSON.parse(rawText) as Partial<ParcelCloudStoreFile>;
      if (parsed && parsed.version === 1 && isPlainObject(parsed.scopes)) {
        memoryFallbackStore = { version: 1, scopes: parsed.scopes as Record<string, ParcelCloudSnapshot> };
        return memoryFallbackStore;
      }
    } catch {
      // Try next durable candidate or fall back to in-memory store.
    }
  }
  return memoryFallbackStore;
}

function writeStoreFile(store: ParcelCloudStoreFile): void {
  memoryFallbackStore = store;
  writeDurableText(PARCEL_CLOUD_FILE, JSON.stringify(store));
}

function normalizeQuarantinedEntries(
  raw: unknown,
  now = Date.now(),
): Record<string, ParcelQuarantinedRecord> {
  if (!isPlainObject(raw)) return {};
  const result: Record<string, ParcelQuarantinedRecord> = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (typeof entry === "string") {
      if (entry) result[id] = { digest: entry, permanent: true };
      continue;
    }
    if (entry === true || (entry && typeof entry !== "object")) {
      result[id] = { digest: "*", permanent: true };
      continue;
    }
    if (!isPlainObject(entry)) continue;
    const digest = typeof entry.digest === "string" ? entry.digest : "";
    if (!digest) continue;
    if (entry.permanent === true) {
      result[id] = { digest, permanent: true };
      continue;
    }
    const expiresAtMs = typeof entry.expiresAtMs === "number" ? entry.expiresAtMs : 0;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) continue;
    result[id] = { digest, expiresAtMs: Math.trunc(expiresAtMs) };
  }
  return result;
}

function normalizeQuarantineHistoryEntries(
  raw: unknown,
): Record<string, ParcelQuarantineHistoryEntry> {
  if (!isPlainObject(raw)) return {};
  const result: Record<string, ParcelQuarantineHistoryEntry> = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (!isPlainObject(entry)) continue;
    const digest = typeof entry.digest === "string" ? entry.digest : "";
    const rejections = typeof entry.rejections === "number" ? Math.trunc(entry.rejections) : 0;
    if (!digest || !Number.isFinite(rejections) || rejections <= 0) continue;
    result[id] = { digest, rejections };
  }
  return result;
}

export function readParcelCloudState(scope: string, now = Date.now()): ParcelCloudSnapshot {
  if (!scope) return emptyParcelCloudSnapshot();
  const raw = readStoreFile().scopes[scope];
  if (!raw || raw.schemaVersion !== 1) return emptyParcelCloudSnapshot();
  const quarantined = normalizeQuarantinedEntries(raw.quarantined, now);
  const quarantineHistory = normalizeQuarantineHistoryEntries(raw.quarantineHistory);
  return {
    schemaVersion: 1,
    ...(raw.session ? { session: raw.session } : {}),
    cursor: integer(raw.cursor) ? raw.cursor : null,
    ...(raw.snapshot ? { snapshot: raw.snapshot } : {}),
    remote: isPlainObject(raw.remote) ? raw.remote : {},
    synced: isPlainObject(raw.synced) ? raw.synced : {},
    edits: isPlainObject(raw.edits) ? raw.edits : {},
    ...(isPlainObject(raw.pddLinks) ? { pddLinks: raw.pddLinks } : {}),
    ...(Object.keys(quarantined).length ? { quarantined } : {}),
    ...(Object.keys(quarantineHistory).length ? { quarantineHistory } : {}),
    ...(raw.legacyManualTitleCleaned === true ? { legacyManualTitleCleaned: true as const } : {}),
    ...(raw.batch ? { batch: raw.batch } : {}),
  };
}

function updateParcelCloudState(
  scope: string,
  updater: (current: ParcelCloudSnapshot) => ParcelCloudSnapshot,
): ParcelCloudSnapshot {
  return withSharedFileTransaction(() => {
    const store = readStoreFile();
    const current = readParcelCloudState(scope);
    const next = updater(current);
    if (next !== current) {
      writeStoreFile({
        version: 1,
        scopes: { ...store.scopes, [scope]: next },
      });
    }
    return next;
  });
}

export function readCachedParcelCloudPddLink(credential: string, waybill: string): CloudParcelPddLink | undefined {
  const scope = mealCredentialScope();
  const localCred = gatewayCredentialForLocalCache();
  if (!scope || !credential || !localCred || localCred.rejected || localCred.scope !== credential) return undefined;
  const canonical = normalizeWaybill(waybill);
  if (!WAYBILL_PATTERN.test(canonical)) return undefined;
  return readParcelCloudState(scope).pddLinks?.[canonical];
}

export function sessionFromParcelResponse(value: Record<string, unknown>): ParcelCloudSession {
  if (
    value.ok !== true ||
    value.schemaVersion !== 1 ||
    value.enabled !== true ||
    typeof value.ownerId !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.ownerId) ||
    typeof value.endpointId !== "string" ||
    !/^scripting-parcel:[0-9a-f]{64}$/.test(value.endpointId) ||
    !integer(value.generation, 1) ||
    !uuid(value.epoch) ||
    !integer(value.nextSequence, 1)
  ) {
    throw new Error("Invalid parcel cloud sync session");
  }
  return {
    ownerId: value.ownerId,
    endpointId: value.endpointId,
    generation: value.generation,
    epoch: value.epoch,
    nextSequence: value.nextSequence,
    ...(value.expressParcelDetailsSupported === true ? { expressParcelDetailsSupported: true as const } : {}),
    ...(value.expressTitleClockSupported === true ? { expressTitleClockSupported: true as const } : {}),
    ...(value.expressWatchFeedbackSupported === true ? { expressWatchFeedbackSupported: true as const } : {}),
  };
}

function sameEndpoint(a: ParcelCloudSession, b: ParcelCloudSession): boolean {
  return (
    a.ownerId === b.ownerId &&
    a.endpointId === b.endpointId &&
    a.generation === b.generation
  );
}

function parseEnvelope(raw: unknown): ParcelCloudEnvelope | null {
  const record = asPlainObject(raw);
  if (
    !record ||
    !uuid(record.recordId) ||
    typeof record.type !== "string" ||
    !ALLOWED_TYPES.has(record.type as ParcelCloudRecordType) ||
    !integer(record.revision, 1) ||
    !integer(record.changedAt) ||
    (record.lifecycle !== "active" && record.lifecycle !== "history") ||
    !integer(record.historyAt) ||
    typeof record.deleted !== "boolean"
  ) {
    return null;
  }
  const editedAt = integer(record.editedAt) ? record.editedAt : record.changedAt;
  if (record.deleted) {
    const reason = record.reason === "user" || record.reason === "retention" ? record.reason : "retention";
    return {
      recordId: record.recordId,
      type: record.type as ParcelCloudRecordType,
      revision: record.revision,
      changedAt: record.changedAt,
      editedAt,
      lifecycle: record.lifecycle,
      historyAt: record.historyAt,
      deleted: true,
      reason,
    };
  }
  if (!isPlainObject(record.payload)) return null;
  return {
    recordId: record.recordId,
    type: record.type as ParcelCloudRecordType,
    revision: record.revision,
    changedAt: record.changedAt,
    editedAt,
    lifecycle: record.lifecycle,
    historyAt: record.historyAt,
    deleted: false,
    payload: record.payload as Record<string, unknown>,
  };
}

export function parcelPullRequest(state: ParcelCloudSnapshot): Record<string, unknown> {
  if (!state.session) throw new Error("Missing parcel cloud sync session");
  const { session, snapshot } = state;
  return {
    schemaVersion: 1,
    generation: session.generation,
    epoch: snapshot?.epoch ?? (state.cursor !== null ? session.epoch : ""),
    cursor: snapshot?.cursor ?? (state.cursor ?? 0),
    ...(snapshot ? { pageToken: snapshot.token } : {}),
    includeEditTime: true,
    includeExpressNotes: true,
    includeExpressMetadata: true,
    ...(session.expressTitleClockSupported ? { includeExpressTitleClock: true } : {}),
    includeExpressPddLink: true,
    includeParcelHandoffs: true,
    includeParcelCodeNotes: true,
    includePdd: true,
    includeVivoDouyin: true,
    ...(session.expressWatchFeedbackSupported ? { includeExpressWatchFeedback: true } : {}),
  };
}

function isWholeRecordType(type: ParcelCloudRecordType): boolean {
  return (
    type === "express" ||
    type === "express_note" ||
    type === "parcel_pickup" ||
    type === "parcel_handoff"
  );
}

/**
 * Deterministic canonical JSON digest over normalized record fields so devices break strictly equal
 * (`===`) timestamp ties identically without advancing timestamps.
 */
export function canonicalWholeRecordDigest(
  type: ParcelCloudRecordType,
  lifecycle: "active" | "history",
  payload: Record<string, unknown>,
  now: number,
): string {
  if (type === "express") {
    return stablePayloadDigest({
      lifecycle,
      waybill: normalizeWaybill(cleanString(payload.waybill)),
      importOrigin: cleanString(payload.importOrigin),
      carrierCode: cleanString(payload.carrierCode),
      phone4: cleanString(payload.phone4),
      status: cleanString(payload.status) || "UNKNOWN",
      createdAt: cloudTime(payload.createdAt, now),
      eventAt: cloudTime(payload.eventAt, now),
      updatedAt: cloudTime(payload.updatedAt, now),
      completedAt: cloudTime(payload.completedAt, now),
      pickupCode: cleanString(payload.pickupCode),
      pickupLocation: cleanString(payload.pickupLocation),
      pickupCapturedAt: cloudTime(payload.pickupCapturedAt, now),
    });
  }
  if (type === "express_note") {
    return stablePayloadDigest({
      lifecycle: "active",
      waybill: normalizeWaybill(cleanString(payload.waybill)),
      note: cleanString(payload.note),
    });
  }
  if (type === "parcel_pickup") {
    return stablePayloadDigest({
      lifecycle,
      waybill: normalizeWaybill(cleanString(payload.waybill)),
      brandId: cleanString(payload.brandId),
      code: cleanString(payload.code),
      location: cleanString(payload.location),
      capturedAt: cloudTime(payload.capturedAt, now),
      completedAt: cloudTime(payload.completedAt, now),
      note: cleanString(payload.note),
    });
  }
  if (type === "parcel_handoff") {
    const futureBound = now + 366 * 86_400_000;
    return stablePayloadDigest({
      lifecycle,
      platform: cleanString(payload.platform),
      code: cleanString(payload.code),
      capturedAt: cloudTime(payload.capturedAt, now),
      windowStartAt: cloudTime(payload.windowStartAt, futureBound),
      windowEndAt: cloudTime(payload.windowEndAt, futureBound),
      windowText: cleanString(payload.windowText),
      expiresAt: cloudTime(payload.expiresAt, futureBound),
      completedAt: cloudTime(payload.completedAt, now),
      note: cleanString(payload.note),
    });
  }
  return `${lifecycle}:${stablePayloadDigest(payload)}`;
}

function localWinsWholeRecordTie(
  type: ParcelCloudRecordType,
  lifecycle: "active" | "history",
  localPayload: Record<string, unknown>,
  cloud: ParcelCloudEnvelope,
  now: number,
): boolean {
  if (cloud.deleted || cloud.type !== type || !isWholeRecordType(type)) return false;
  const localDigest = canonicalWholeRecordDigest(type, lifecycle, localPayload, now);
  const remoteDigest = canonicalWholeRecordDigest(cloud.type, cloud.lifecycle, cloud.payload ?? {}, now);
  return localDigest > remoteDigest;
}

function reconcileQueuedEdits(state: ParcelCloudSnapshot, completeSnapshot = false): ParcelCloudSnapshot {
  const edits: Record<string, ParcelCloudEdit> = {};
  const currentBatchId = state.batch?.mutations[0].mutationId;
  for (const [id, edit] of Object.entries(state.edits)) {
    if (edit.mutationId === currentBatchId) {
      edits[id] = edit;
      continue;
    }
    const cloud = state.remote[id];
    if (!cloud) {
      if (!edit.deleted && !(completeSnapshot && edit.requiresExisting)) edits[id] = edit;
      continue;
    }
    if (cloud.type !== edit.type) continue;
    if (cloud.deleted && (cloud.reason === "retention" || Boolean(edit.deleted))) {
      continue;
    }
    if (cloud.editedAt > edit.editedAt) {
      continue;
    }
    if (cloud.editedAt === edit.editedAt) {
      const tieNow = Math.max(Date.now(), edit.editedAt);
      if (
        cloud.deleted ||
        edit.deleted ||
        !edit.payload ||
        !isWholeRecordType(edit.type) ||
        isCloudRecordSemanticallyConverged(cloud, edit.type, edit.lifecycle, edit.payload, edit.editedAt, tieNow) ||
        !localWinsWholeRecordTie(edit.type, edit.lifecycle, edit.payload, cloud, tieNow)
      ) {
        continue;
      }
    }
    edits[id] = edit.requiresExisting ? { ...edit, requiresExisting: undefined } : edit;
  }
  return { ...state, edits };
}

export function applyParcelPage(
  state: ParcelCloudSnapshot,
  requested: ParcelCloudSnapshot,
  page: Record<string, unknown>,
): ParcelCloudSnapshot {
  const previous = requested.session;
  if (
    !state.session ||
    !previous ||
    !sameEndpoint(state.session, previous) ||
    state.cursor !== requested.cursor ||
    state.session.epoch !== previous.epoch ||
    state.snapshot?.token !== requested.snapshot?.token
  ) {
    return state;
  }
  const session = sessionFromParcelResponse(page);
  if (
    !sameEndpoint(session, previous) ||
    !integer(page.cursor) ||
    typeof page.hasMore !== "boolean" ||
    !Array.isArray(page.records) ||
    page.records.length > 100
  ) {
    throw new Error("Invalid parcel cloud pull page");
  }
  const isSnapshot = page.mode === "snapshot" && page.reset === true;
  if (
    !isSnapshot &&
    (page.mode !== "delta" ||
      page.reset !== false ||
      previous.epoch !== session.epoch ||
      Boolean(requested.snapshot) ||
      page.cursor < (requested.cursor ?? 0) ||
      (page.hasMore && page.cursor === requested.cursor))
  ) {
    throw new Error("Invalid parcel cloud cursor");
  }
  const continuation = isSnapshot && requested.snapshot?.epoch === session.epoch ? requested.snapshot : undefined;
  if (continuation && (continuation.cursor !== page.cursor || continuation.token === page.pageToken)) {
    throw new Error("Invalid parcel snapshot continuation");
  }
  const remote: Record<string, ParcelCloudEnvelope> = {
    ...(isSnapshot ? (continuation?.records ?? {}) : state.remote),
  };
  for (const item of page.records) {
    const parsed = parseEnvelope(item);
    if (!parsed) continue;
    if (!isSnapshot && parsed.revision > page.cursor) {
      throw new Error("Invalid parcel cloud revision");
    }
    if (!remote[parsed.recordId] || parsed.revision >= remote[parsed.recordId]!.revision) {
      remote[parsed.recordId] = parsed;
    }
  }
  const nextSession: ParcelCloudSession = {
    ...session,
    nextSequence: Math.max(state.session.nextSequence, session.nextSequence),
  };
  if (isSnapshot && page.hasMore) {
    if (typeof page.pageToken !== "string" || !page.pageToken || page.pageToken.length > 2048) {
      throw new Error("Missing parcel snapshot continuation");
    }
    return {
      ...state,
      session: nextSession,
      snapshot: {
        epoch: session.epoch,
        cursor: page.cursor,
        token: page.pageToken,
        records: remote,
      },
    };
  }
  if (page.pageToken != null) {
    throw new Error("Unexpected parcel continuation");
  }
  return reconcileQueuedEdits(
    {
      ...state,
      session: nextSession,
      cursor: page.cursor,
      snapshot: undefined,
      remote,
    },
    isSnapshot,
  );
}

export function prepareParcelBatch(
  state: ParcelCloudSnapshot,
  requestId: string,
): ParcelCloudSnapshot {
  if (!state.session || state.batch || state.snapshot || state.cursor === null) return state;
  const entries = Object.values(state.edits).sort((left, right) =>
    left.editedAt - right.editedAt || left.recordId.localeCompare(right.recordId),
  );
  for (const edit of entries) {
    const cloud = state.remote[edit.recordId];
    if (edit.deleted) {
      if (!cloud || cloud.deleted) continue;
      const batch: ParcelCloudBatch = {
        schemaVersion: 1,
        generation: state.session.generation,
        epoch: state.session.epoch,
        sequence: state.session.nextSequence,
        requestId,
        includeExpressMetadata: true,
        ...(state.session.expressTitleClockSupported ? { includeExpressTitleClock: true } : {}),
        includeExpressPddLink: true,
        includeParcelCodeNotes: true,
        includePdd: true,
        includeVivoDouyin: true,
        ...(state.session.expressWatchFeedbackSupported ? { includeExpressWatchFeedback: true } : {}),
        mutations: [{
          mutationId: edit.mutationId,
          recordId: edit.recordId,
          baseRevision: cloud.revision,
          type: edit.type,
          operation: "delete",
          editedAt: edit.editedAt,
        }],
      };
      return { ...state, batch };
    }
    if (!edit.payload) continue;
    const operation: "put" | "restore" = cloud?.deleted ? "restore" : "put";
    const batch: ParcelCloudBatch = {
      schemaVersion: 1,
      generation: state.session.generation,
      epoch: state.session.epoch,
      sequence: state.session.nextSequence,
      requestId,
      includeExpressMetadata: true,
      ...(state.session.expressTitleClockSupported ? { includeExpressTitleClock: true } : {}),
      includeExpressPddLink: true,
      includeParcelCodeNotes: true,
      includePdd: true,
      includeVivoDouyin: true,
      ...(state.session.expressWatchFeedbackSupported ? { includeExpressWatchFeedback: true } : {}),
      mutations: [{
        mutationId: edit.mutationId,
        recordId: edit.recordId,
        baseRevision: cloud?.revision ?? 0,
        type: edit.type,
        operation,
        lifecycle: edit.lifecycle,
        historyAt: edit.historyAt,
        editedAt: edit.editedAt,
        payload: edit.payload,
      }],
    };
    return { ...state, batch };
  }
  return state;
}

export function applyParcelReceipt(
  state: ParcelCloudSnapshot,
  batch: ParcelCloudBatch,
  response: Record<string, unknown>,
  now = Date.now(),
): ParcelCloudSnapshot {
  if (state.batch?.requestId !== batch.requestId || !state.session) return state;
  const session = sessionFromParcelResponse(response);
  const mutation = batch.mutations[0];
  const receipt = Array.isArray(response.results) && response.results.length === 1
    ? asPlainObject(response.results[0])
    : null;
  if (
    !receipt ||
    !sameEndpoint(session, state.session) ||
    response.sequence !== batch.sequence ||
    session.nextSequence !== batch.sequence + 1 ||
    receipt.recordId !== mutation.recordId ||
    receipt.mutationId !== mutation.mutationId ||
    !integer(receipt.revision, 1) ||
    typeof receipt.deleted !== "boolean"
  ) {
    throw new Error("Invalid parcel cloud sync receipt");
  }
  const editedAt = integer(receipt.editedAt) ? receipt.editedAt : mutation.editedAt;
  const id = mutation.recordId;
  const remote: Record<string, ParcelCloudEnvelope> = { ...state.remote };
  if (!remote[id] || remote[id]!.revision <= receipt.revision) {
    if (mutation.operation === "delete" || receipt.deleted) {
      remote[id] = {
        recordId: id,
        type: mutation.type,
        revision: receipt.revision,
        changedAt: now,
        editedAt,
        lifecycle: mutation.lifecycle ?? remote[id]?.lifecycle ?? "active",
        historyAt: mutation.historyAt ?? remote[id]?.historyAt ?? 0,
        deleted: true,
        reason: mutation.operation === "delete" ? "user" : "retention",
      };
    } else {
      const prevPayload = remote[id] && !remote[id]!.deleted && remote[id]!.type === mutation.type
        ? remote[id]!.payload
        : undefined;
      const incomingPayload = mutation.payload ?? {};
      const mergedPayload = mutation.type === "express_metadata"
        ? mergeParcelCloudMetadata(prevPayload, incomingPayload)
        : mutation.type === "express_pdd_link"
          ? mergeParcelCloudPddLink(prevPayload, incomingPayload)
          : mutation.type === "express_watch_feedback"
            ? mergeParcelCloudWatchFeedback(prevPayload, incomingPayload)
            : mutation.type === "parcel_pickup" || mutation.type === "parcel_handoff"
              ? mergeParcelCloudCodeNote(prevPayload, incomingPayload)
              : incomingPayload;
      remote[id] = {
        recordId: id,
        type: mutation.type,
        revision: receipt.revision,
        changedAt: now,
        editedAt,
        lifecycle: mutation.lifecycle ?? "active",
        historyAt: mutation.historyAt ?? 0,
        deleted: false,
        payload: mergedPayload,
      };
    }
  }
  const synced: Record<string, ParcelSyncedBaseline> = { ...state.synced };
  if (mutation.operation === "delete" || receipt.deleted) {
    delete synced[id];
  } else {
    const existingLocalKey = synced[id]?.localKey || defaultLocalKeyForMutation(mutation);
    const effectiveReceiptPayload = remote[id] && !remote[id]!.deleted ? remote[id]!.payload : mutation.payload;
    const syncedLifecycle =
      mutation.type === "parcel_handoff"
        ? (cloudTime(effectiveReceiptPayload?.completedAt, Math.max(now, editedAt)) > 0 ? "history" : "active")
        : (mutation.lifecycle ?? "active");
    synced[id] = {
      revision: receipt.revision,
      type: mutation.type,
      localKey: existingLocalKey,
      editedAt,
      ...((mutation.type === "express_note" || mutation.type === "parcel_pickup" || mutation.type === "parcel_handoff") &&
        typeof effectiveReceiptPayload?.note === "string"
        ? { noteText: effectiveReceiptPayload.note.trim() }
        : (mutation.type === "parcel_pickup" || mutation.type === "parcel_handoff")
          ? { noteText: "" }
          : {}),
      ...(isWholeRecordType(mutation.type) && effectiveReceiptPayload
        ? {
            localDigest: canonicalWholeRecordDigest(
              mutation.type,
              syncedLifecycle,
              effectiveReceiptPayload,
              Math.max(now, editedAt),
            ),
          }
        : {}),
    };
  }
  const edits: Record<string, ParcelCloudEdit> = { ...state.edits };
  if (edits[id]?.mutationId === mutation.mutationId) delete edits[id];
  const quarantined = state.quarantined ? { ...state.quarantined } : undefined;
  if (quarantined) delete quarantined[id];
  const quarantineHistory = state.quarantineHistory ? { ...state.quarantineHistory } : undefined;
  if (quarantineHistory) delete quarantineHistory[id];
  return {
    ...state,
    remote,
    synced,
    edits,
    ...(quarantined && Object.keys(quarantined).length ? { quarantined } : { quarantined: undefined }),
    ...(quarantineHistory && Object.keys(quarantineHistory).length ? { quarantineHistory } : { quarantineHistory: undefined }),
    session: { ...state.session, nextSequence: session.nextSequence },
    batch: undefined,
  };
}

/** Matches Worker `mergeExpressMetadata` (`cloud_records.js:340-382`). */
export function mergeParcelCloudMetadata(
  previous: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (!previous) return { ...incoming };
  if (previous.waybill !== incoming.waybill) {
    throw new Error("invalid_cloud_record_payload");
  }
  const prevTerminal = integer(previous.terminalAt, 1) ? previous.terminalAt : 0;
  const nextTerminal = integer(incoming.terminalAt, 1) ? incoming.terminalAt : 0;
  const prevAnchor = integer(previous.anchorAt, 1) ? previous.anchorAt : 0;
  const nextAnchor = integer(incoming.anchorAt, 1) ? incoming.anchorAt : 0;
  if (prevTerminal > 0 && nextAnchor >= prevTerminal + WAYBILL_REUSE_MIN_GAP_MS) {
    return { ...incoming };
  }
  if (nextTerminal > 0 && prevAnchor >= nextTerminal + WAYBILL_REUSE_MIN_GAP_MS) {
    return { ...previous };
  }
  const merged: Record<string, unknown> = {
    ...previous,
    ...incoming,
    anchorAt: prevAnchor > 0 && nextAnchor > 0 ? Math.min(prevAnchor, nextAnchor) : (prevAnchor || nextAnchor),
    terminalAt: Math.max(prevTerminal, nextTerminal),
  };
  if (typeof previous.productImageUrl === "string") {
    try {
      const host = new URL(previous.productImageUrl).hostname.toLowerCase();
      if (/^img(?:-[1-4])?\.pddpic\.com$/.test(host)) {
        merged.productImageUrl = previous.productImageUrl;
      }
    } catch {
      // Ignore malformed URLs.
    }
  }
  const prevTitle = typeof previous.productName === "string" ? previous.productName : "";
  const nextTitle = typeof incoming.productName === "string" ? incoming.productName : "";
  const prevTitleAt = integer(previous.productNameObservedAt, 1) ? previous.productNameObservedAt : 0;
  const nextTitleAt = integer(incoming.productNameObservedAt, 1) ? incoming.productNameObservedAt : 0;
  if (prevTitle && !nextTitle) {
    merged.productName = prevTitle;
    if (prevTitleAt > 0) merged.productNameObservedAt = prevTitleAt;
    else delete merged.productNameObservedAt;
  } else if (prevTitle && nextTitle) {
    if (prevTitle === nextTitle) {
      merged.productName = prevTitle;
      const chosenAt = prevTitleAt && nextTitleAt ? Math.min(prevTitleAt, nextTitleAt) : (prevTitleAt || nextTitleAt);
      if (chosenAt > 0) merged.productNameObservedAt = chosenAt;
      else delete merged.productNameObservedAt;
    } else if (prevTitleAt > nextTitleAt) {
      merged.productName = prevTitle;
      merged.productNameObservedAt = prevTitleAt;
    } else {
      merged.productName = nextTitle;
      if (nextTitleAt > 0) merged.productNameObservedAt = nextTitleAt;
      else delete merged.productNameObservedAt;
    }
  }
  const before = integer(previous.deliveryEstimateObservedAt, 1) ? previous.deliveryEstimateObservedAt : 0;
  const after = integer(incoming.deliveryEstimateObservedAt, 1) ? incoming.deliveryEstimateObservedAt : 0;
  const same = previous.deliveryEstimate === incoming.deliveryEstimate;
  if (before && (!after || (same ? before <= after : before >= after))) {
    merged.deliveryEstimate = previous.deliveryEstimate;
    merged.deliveryEstimateObservedAt = before;
  }
  return merged;
}

/** Matches Worker `mergeExpressPddLink` (`cloud_records.js:397-409`). */
export function mergeParcelCloudPddLink(
  previous: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (!previous) return { ...incoming };
  if (previous.waybill !== incoming.waybill) {
    throw new Error("invalid_cloud_record_payload");
  }
  const prevTerminal = integer(previous.terminalAt, 1) ? previous.terminalAt : 0;
  const nextTerminal = integer(incoming.terminalAt, 1) ? incoming.terminalAt : 0;
  const prevAnchor = integer(previous.anchorAt, 1) ? previous.anchorAt : 0;
  const nextAnchor = integer(incoming.anchorAt, 1) ? incoming.anchorAt : 0;
  if (prevTerminal > 0 && nextAnchor >= prevTerminal + WAYBILL_REUSE_MIN_GAP_MS) {
    return { ...incoming };
  }
  if (nextTerminal > 0 && prevAnchor >= nextTerminal + WAYBILL_REUSE_MIN_GAP_MS) {
    return { ...previous };
  }
  const prevObserved = integer(previous.observedAt, 1) ? previous.observedAt : 0;
  const nextObserved = integer(incoming.observedAt, 1) ? incoming.observedAt : 0;
  const latest = nextObserved > prevObserved ? incoming : previous;
  return {
    waybill: latest.waybill,
    anchorAt: prevAnchor > 0 && nextAnchor > 0 ? Math.min(prevAnchor, nextAnchor) : (prevAnchor || nextAnchor),
    terminalAt: Math.max(prevTerminal, nextTerminal),
    observedAt: Math.max(prevObserved, nextObserved),
    shippingId: prevObserved === nextObserved && previous.shippingId !== incoming.shippingId
      ? ""
      : latest.shippingId,
  };
}

/** Matches Worker `mergeExpressWatchFeedback` (`cloud_records.js:383-392`). */
export function mergeParcelCloudWatchFeedback(
  previous: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (!previous) return { ...incoming };
  if (previous.waybill !== incoming.waybill) {
    throw new Error("invalid_cloud_record_payload");
  }
  const prevActed = integer(previous.actedAt, 1) ? previous.actedAt : 0;
  const nextActed = integer(incoming.actedAt, 1) ? incoming.actedAt : 0;
  if (nextActed > prevActed) return { ...incoming };
  if (nextActed < prevActed) return { ...previous };
  if (incoming.action !== previous.action) {
    return incoming.action === "deleted" ? { ...incoming } : { ...previous };
  }
  return incoming.watchRecordId ? { ...incoming } : { ...previous };
}

/** Matches Worker omission-preservation rule on `parcel_pickup` / `parcel_handoff` (`cloud_records.js:1190-1192`). */
export function mergeParcelCloudCodeNote(
  previous: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (previous && Object.hasOwn(previous, "note") && !Object.hasOwn(incoming, "note")) {
    return { ...incoming, note: previous.note };
  }
  return { ...incoming };
}

function parcelEditQuarantineDigest(
  type: ParcelCloudRecordType,
  deleted: boolean,
  lifecycle: "active" | "history",
  historyAt: number,
  payload: Record<string, unknown> | undefined,
): string {
  if (deleted) return `${type}:delete`;
  return `${type}:${lifecycle}:${historyAt}:${stablePayloadDigest(payload ?? {})}`;
}

/**
 * Returns true when a non-retryable 4xx payload rejection code indicates transient clock skew or
 * future timestamp bounds rather than a permanent schema/content defect.
 * HTTP 401 (`expired_request` auth skew), 408, 409, and 429 are excluded first so in-flight batches
 * and queued mutations are retained and retried rather than dropped.
 */
export function isClockSkewMutationRejection(error: unknown): boolean {
  if (!(error instanceof GatewayError)) return false;
  if (error.status < 400 || error.status >= 500) return false;
  if (error.status === 401 || error.status === 408 || error.status === 409 || error.status === 429) {
    return false;
  }
  const code = String(error.gatewayCode || "");
  const message = String(error.message || "");
  const pattern = /clock_skew|future_timestamp|future_time|future_clock|timestamp_skew|timestamp_out_of_bounds|edit_clock_skew/i;
  return pattern.test(code) || pattern.test(message);
}

/**
 * Returns true for deterministic non-409 4xx validation rejections (schema error, oversized note/estimate,
 * disallowed record identity) that will never succeed on retry and must not block the batch queue.
 * Transient clock-skew rejections are excluded so valid payloads are never permanently quarantined.
 */
export function isDeterministicParcelMutationRejection(error: unknown): boolean {
  if (!(error instanceof GatewayError)) return false;
  if (error.status < 400 || error.status >= 500) return false;
  if (error.status === 401 || error.status === 408 || error.status === 409 || error.status === 429) {
    return false;
  }
  if (isClockSkewMutationRejection(error)) {
    return false;
  }
  if (error.status === 403) {
    return error.gatewayCode === "invalid_cloud_record_identity";
  }
  return true;
}

/**
 * Drops a rejected mutation batch. Genuine schema/content rejections quarantine the exact payload digest
 * with a bounded TTL (`PARCEL_CLOUD_QUARANTINE_TTL_MS`), while transient clock-skew rejections drop only
 * the skewed in-flight batch without quarantining.
 */
export function dropRejectedParcelBatch(
  state: ParcelCloudSnapshot,
  batch: ParcelCloudBatch,
  error?: unknown,
  now = Date.now(),
): ParcelCloudSnapshot {
  if (state.batch?.requestId !== batch.requestId) return state;
  const mutation = batch.mutations[0];
  const id = mutation.recordId;
  const edits: Record<string, ParcelCloudEdit> = { ...state.edits };
  if (edits[id]?.mutationId === mutation.mutationId) {
    delete edits[id];
  }
  if (error !== undefined && isClockSkewMutationRejection(error)) {
    return {
      ...state,
      edits,
      batch: undefined,
    };
  }
  const digest = parcelEditQuarantineDigest(
    mutation.type,
    mutation.operation === "delete",
    mutation.lifecycle ?? "active",
    mutation.historyAt ?? 0,
    mutation.payload,
  );
  const priorHistory = normalizeQuarantineHistoryEntries(state.quarantineHistory);
  const activeQuarantine = normalizeQuarantinedEntries(state.quarantined, now);
  const priorQuarantine = activeQuarantine[id];
  const priorCount = priorHistory[id]?.digest === digest
    ? priorHistory[id]!.rejections
    : priorQuarantine && (priorQuarantine.digest === digest || priorQuarantine.digest === "*")
      ? (priorQuarantine.permanent ? PARCEL_CLOUD_QUARANTINE_MAX_REJECTIONS : 1)
      : 0;
  const rejections = priorCount + 1;
  const permanent = rejections >= PARCEL_CLOUD_QUARANTINE_MAX_REJECTIONS;
  const quarantined: Record<string, ParcelQuarantinedRecord> = {
    ...activeQuarantine,
    [id]: permanent
      ? { digest, permanent: true }
      : { digest, expiresAtMs: Math.trunc(now) + PARCEL_CLOUD_QUARANTINE_TTL_MS },
  };
  const quarantineHistory: Record<string, ParcelQuarantineHistoryEntry> = {
    ...priorHistory,
    [id]: { digest, rejections },
  };
  return {
    ...state,
    edits,
    quarantined,
    quarantineHistory,
    batch: undefined,
  };
}

function defaultLocalKeyForMutation(mutation: ParcelCloudMutation): string {
  const payload = mutation.payload ?? {};
  const waybill = typeof payload.waybill === "string" ? payload.waybill : "";
  if (mutation.type === "express") return `express:${waybill}`;
  if (mutation.type === "express_pdd_link") return `pdd_link:${waybill}`;
  if (mutation.type === "express_metadata") return `metadata:${waybill}`;
  if (mutation.type === "express_note") return `note:${waybill}`;
  if (mutation.type === "express_watch_feedback") return `watch_feedback:${waybill}`;
  return mutation.recordId;
}

export function recoverParcelConflict(
  state: ParcelCloudSnapshot,
  batch: ParcelCloudBatch,
  conflict: Record<string, unknown>,
): ParcelCloudSnapshot {
  if (
    state.batch?.requestId !== batch.requestId ||
    !state.session ||
    conflict.requestId !== batch.requestId ||
    conflict.sequence !== batch.sequence ||
    conflict.requestGeneration !== batch.generation ||
    conflict.ownerId !== state.session.ownerId ||
    conflict.endpointId !== state.session.endpointId
  ) {
    return state;
  }
  const mutation = batch.mutations[0];
  const id = mutation.recordId;
  if (
    conflict.error === "revision_conflict" &&
    conflict.mutationOutcome === "not_committed" &&
    Array.isArray(conflict.conflicts) &&
    conflict.conflicts.length >= 1
  ) {
    const item = asPlainObject(conflict.conflicts[0]);
    if (item?.recordId !== id) return state;
    const remote: Record<string, ParcelCloudEnvelope> = { ...state.remote };
    let edits: Record<string, ParcelCloudEdit> = state.edits;
    if (item.current === null) {
      delete remote[id];
      if (mutation.baseRevision > 0 || state.edits[id]?.requiresExisting) {
        edits = { ...edits };
        delete edits[id];
      }
    } else {
      const cloud = parseEnvelope(item.current);
      if (!cloud || cloud.recordId !== id) return state;
      if (!remote[id] || cloud.revision >= remote[id]!.revision) remote[id] = cloud;
      // For deterministic metadata/link/watch_feedback records, keep our newer local observation queued
      // on top of the newly learned remote revision so the next batch merges cleanly.
      if (
        (mutation.type === "express_metadata" ||
          mutation.type === "express_pdd_link" ||
          mutation.type === "express_watch_feedback") &&
        edits[id] &&
        edits[id]!.editedAt <= cloud.editedAt
      ) {
        edits = { ...edits, [id]: { ...edits[id]!, editedAt: cloud.editedAt + 1 } };
      }
    }
    return reconcileQueuedEdits({ ...state, remote, edits, batch: undefined });
  }
  if (
    ![
      "reset_required",
      "endpoint_generation_conflict",
      "mutation_receipt_expired",
      "mutation_replay_conflict",
      "mutation_sequence_conflict",
    ].includes(String(conflict.error))
  ) {
    return state;
  }
  const edits: Record<string, ParcelCloudEdit> = { ...state.edits };
  if (edits[id] && mutation.baseRevision > 0) {
    edits[id] = { ...edits[id]!, requiresExisting: true };
  }
  return {
    ...state,
    session: undefined,
    cursor: null,
    snapshot: undefined,
    batch: undefined,
    edits,
  };
}

function cloudTime(value: unknown, now: number): number {
  return cloudRecordTime(value, now) ?? 0;
}

function shipmentTerminalAtMs(shipment: Shipment, anchorAt: number, now: number): number {
  if (shipment.forcedCompletedAtMs && shipment.forcedCompletedAtMs >= anchorAt) {
    return Math.min(now, shipment.forcedCompletedAtMs);
  }
  const semantic = shipmentPresentationStatus(shipment).semantic;
  if (semantic !== "COMPLETED" && semantic !== "CANCELLED") return 0;
  const candidate = Math.max(
    shipment.settledAtMs ?? 0,
    timelineLatestEventAt(shipment.timeline) ?? 0,
    shipment.timeline.statusEventAtMs ?? 0,
  );
  return candidate >= anchorAt ? Math.min(now, candidate) : 0;
}

function shipmentAnchorAtMs(shipment: Shipment, now: number): number {
  const anchor = shipmentReuseAnchorAtMs(shipment, now) || shipment.identity.createdAtMs || shipment.updatedAtMs;
  return anchor > 0 ? Math.min(now, Math.trunc(anchor)) : 0;
}

function matchesCloudShipmentLifecycle(
  shipment: Shipment,
  anchorAt: number,
  terminalAt: number,
  now: number,
): boolean {
  if (shipmentReuseAnchorAtMs(shipment, now) > 0) {
    return matchesParcelMetadataLifecycle(shipment, anchorAt, terminalAt, now);
  }
  const localAnchor = shipmentAnchorAtMs(shipment, now);
  const localTerminal = shipmentTerminalAtMs(shipment, localAnchor, now);
  const remoteAnchor = cloudTime(anchorAt, now);
  const remoteTerminal = cloudTime(terminalAt, now);
  if (localAnchor <= 0 || remoteAnchor <= 0) return false;
  if (remoteTerminal > 0 && localAnchor - remoteTerminal >= WAYBILL_REUSE_MIN_GAP_MS) return false;
  if (localTerminal > 0 && remoteAnchor - localTerminal >= WAYBILL_REUSE_MIN_GAP_MS) return false;
  return true;
}

function matchingIgnoredCloudManualWaybill(
  records: readonly IgnoredCloudManualWaybill[] | undefined,
  waybill: string,
  anchorAt: number,
  terminalAt: number,
): IgnoredCloudManualWaybill | undefined {
  if (!records?.length) return undefined;
  const canonical = normalizeWaybill(waybill);
  if (!canonical) return undefined;
  return records.find((entry) => {
    if (normalizeWaybill(entry.waybill) !== canonical) return false;
    if (
      anchorAt > 0 &&
      entry.anchorAt > 0 &&
      anchorAt >= Math.max(entry.anchorAt, entry.ignoredAtMs) + WAYBILL_REUSE_MIN_GAP_MS
    ) {
      return false;
    }
    if (terminalAt > 0 && entry.anchorAt > 0 && terminalAt + WAYBILL_REUSE_MIN_GAP_MS <= entry.anchorAt) {
      return false;
    }
    return true;
  });
}

function normalizedEstimateForWire(text: string | undefined): string {
  const cleaned = cleanString(text);
  if (!cleaned) return "";
  if (ESTIMATE_WIRE_PATTERN.test(cleaned)) {
    return [...cleaned].length <= ESTIMATE_MAX_CHARS ? cleaned : "";
  }
  const candidate = cleaned.startsWith("预计") ? cleaned : `预计${cleaned}`;
  const suffixed = candidate.endsWith("送达") || candidate.endsWith("送达。") ? candidate : `${candidate}送达`;
  return ESTIMATE_WIRE_PATTERN.test(suffixed) && [...suffixed].length <= ESTIMATE_MAX_CHARS ? suffixed : "";
}

function isCloudRecordSemanticallyConverged(
  cloud: ParcelCloudEnvelope,
  type: ParcelCloudRecordType,
  lifecycle: "active" | "history",
  payload: Record<string, unknown>,
  editedAt: number,
  now: number,
): boolean {
  if (cloud.deleted || cloud.type !== type) return false;
  const cp = cloud.payload ?? {};

  if (type === "express_metadata") {
    if (cloud.lifecycle !== "active") return false;
    if (normalizeWaybill(cleanString(cp.waybill)) !== normalizeWaybill(cleanString(payload.waybill))) {
      return false;
    }
    const remoteAnchor = cloudTime(cp.anchorAt, now);
    const remoteTerminal = cloudTime(cp.terminalAt, now);
    const localAnchor = cloudTime(payload.anchorAt, now);
    const localTerminal = cloudTime(payload.terminalAt, now);
    if (localTerminal > 0 && remoteAnchor >= localTerminal + WAYBILL_REUSE_MIN_GAP_MS) {
      // Remote belongs to a newer parcel lifecycle on a reused waybill; never overwrite it.
      return true;
    }
    if (remoteTerminal > 0 && localAnchor >= remoteTerminal + WAYBILL_REUSE_MIN_GAP_MS) {
      return false;
    }
    if (remoteAnchor <= 0) return false;
    const localName = productTitle(payload.productName);
    const localNameAt = cloudTime(payload.productNameObservedAt, now);
    const remoteName = productTitle(cp.productName);
    const remoteNameAt = cloudTime(cp.productNameObservedAt, now);
    const titleConverged =
      !localName ||
      (remoteName === localName && (!Object.hasOwn(payload, "productNameObservedAt") || remoteNameAt > 0)) ||
      (Boolean(remoteName) && localNameAt > 0 && remoteNameAt >= localNameAt);

    const localEst = normalizedEstimateForWire(cleanString(payload.deliveryEstimate));
    const localEstAt = cloudTime(payload.deliveryEstimateObservedAt, now);
    const remoteEst = normalizedEstimateForWire(cleanString(cp.deliveryEstimate));
    const remoteEstAt = cloudTime(cp.deliveryEstimateObservedAt, now);
    const estimateConverged =
      !localEst ||
      (remoteEst === localEst && remoteEstAt > 0) ||
      (Boolean(remoteEst) && localEstAt > 0 && remoteEstAt >= localEstAt);

    return titleConverged && estimateConverged;
  }

  if (type === "express_pdd_link") {
    if (cloud.lifecycle !== "active") return false;
    if (normalizeWaybill(cleanString(cp.waybill)) !== normalizeWaybill(cleanString(payload.waybill))) {
      return false;
    }
    const remoteAnchor = cloudTime(cp.anchorAt, now);
    const remoteTerminal = cloudTime(cp.terminalAt, now);
    const localAnchor = cloudTime(payload.anchorAt, now);
    const localTerminal = cloudTime(payload.terminalAt, now);
    if (localTerminal > 0 && remoteAnchor >= localTerminal + WAYBILL_REUSE_MIN_GAP_MS) {
      return true;
    }
    if (remoteTerminal > 0 && localAnchor >= remoteTerminal + WAYBILL_REUSE_MIN_GAP_MS) {
      return false;
    }
    if (remoteAnchor <= 0) return false;
    const localShip = cleanString(payload.shippingId);
    const remoteShip = cleanString(cp.shippingId);
    const localObs = cloudTime(payload.observedAt, now);
    const remoteObs = cloudTime(cp.observedAt, now);
    const shippingConverged =
      !localShip ||
      remoteShip === localShip ||
      (remoteObs >= localObs && (Boolean(remoteShip) || remoteObs > 1));
    const terminalConverged = localTerminal === 0 || remoteTerminal >= localTerminal;
    return shippingConverged && terminalConverged;
  }

  if (type === "express") {
    if (normalizeWaybill(cleanString(cp.waybill)) !== normalizeWaybill(cleanString(payload.waybill))) {
      return false;
    }
    const remoteAnchor = cloudTime(cp.createdAt, now) || cloudTime(cp.eventAt, now);
    const remoteCompleted = cloudTime(cp.completedAt, now);
    const localAnchor = cloudTime(payload.createdAt, now) || cloudTime(payload.eventAt, now);
    const localCompleted = cloudTime(payload.completedAt, now);
    if (localCompleted > 0 && remoteAnchor >= localCompleted + WAYBILL_REUSE_MIN_GAP_MS) {
      return true;
    }
    if (remoteCompleted > 0 && localAnchor >= remoteCompleted + WAYBILL_REUSE_MIN_GAP_MS) {
      return false;
    }
    const remoteTerminalState =
      cloud.lifecycle === "history" ||
      remoteCompleted > 0 ||
      cp.status === "COMPLETED" ||
      cp.status === "CANCELLED";
    if (remoteTerminalState && lifecycle === "active") {
      return true;
    }
    if (cp.status && cp.status !== "UNKNOWN" && payload.status === "UNKNOWN" && lifecycle === "active") {
      return true;
    }
    const remoteEventAt = cloudTime(cp.eventAt, now);
    const localEventAt = cloudTime(payload.eventAt, now);
    if (lifecycle === "active" && remoteEventAt > localEventAt && !cleanString(payload.pickupCode)) {
      return true;
    }
    return (
      cloud.lifecycle === lifecycle &&
      cleanString(cp.importOrigin) === cleanString(payload.importOrigin) &&
      cleanString(cp.status) === cleanString(payload.status) &&
      (!cleanString(payload.carrierCode) || cleanString(cp.carrierCode) === cleanString(payload.carrierCode)) &&
      (!cleanString(payload.phone4) || cleanString(cp.phone4) === cleanString(payload.phone4)) &&
      (!cleanString(payload.pickupCode) ||
        (cleanString(cp.pickupCode) === cleanString(payload.pickupCode) &&
          cleanString(cp.pickupLocation) === cleanString(payload.pickupLocation))) &&
      (remoteCompleted > 0) === (localCompleted > 0)
    );
  }

  if (type === "express_note") {
    if (cloud.lifecycle !== "active") return false;
    if (normalizeWaybill(cleanString(cp.waybill)) !== normalizeWaybill(cleanString(payload.waybill))) {
      return false;
    }
    const remoteAnchor = cloudTime(cp.anchorAt, now);
    const remoteTerminal = cloudTime(cp.terminalAt, now);
    const localAnchor = cloudTime(payload.anchorAt, now);
    const localTerminal = cloudTime(payload.terminalAt, now);
    if (localTerminal > 0 && remoteAnchor >= localTerminal + WAYBILL_REUSE_MIN_GAP_MS) {
      return true;
    }
    if (remoteTerminal > 0 && localAnchor >= remoteTerminal + WAYBILL_REUSE_MIN_GAP_MS) {
      return false;
    }
    return cleanString(cp.note) === cleanString(payload.note);
  }

  if (type === "parcel_pickup") {
    if (normalizeWaybill(cleanString(cp.waybill)) !== normalizeWaybill(cleanString(payload.waybill))) {
      return false;
    }
    const remoteCaptured = cloudTime(cp.capturedAt, now);
    const localCaptured = cloudTime(payload.capturedAt, now);
    const remoteCompleted = cloudTime(cp.completedAt, now);
    const localCompleted = cloudTime(payload.completedAt, now);
    if ((cloud.lifecycle === "history" || remoteCompleted > 0) && lifecycle === "active" &&
        Math.abs(remoteCaptured - localCaptured) < WAYBILL_REUSE_MIN_GAP_MS) {
      return true;
    }
    if (remoteCaptured > localCaptured && lifecycle === "active") {
      return true;
    }
    return (
      cloud.lifecycle === lifecycle &&
      (!cleanString(payload.brandId) || cleanString(cp.brandId) === cleanString(payload.brandId)) &&
      cleanString(cp.code) === cleanString(payload.code) &&
      cleanString(cp.location) === cleanString(payload.location) &&
      (remoteCompleted > 0) === (localCompleted > 0) &&
      cleanString(cp.note) === cleanString(payload.note)
    );
  }

  if (type === "parcel_handoff") {
    const remoteCompleted = cloudTime(cp.completedAt, now);
    const localCompleted = cloudTime(payload.completedAt, now);
    if ((cloud.lifecycle === "history" || remoteCompleted > 0) && lifecycle === "active") {
      return true;
    }
    const futureBound = now + 366 * 86_400_000;
    return (
      cloud.lifecycle === lifecycle &&
      cleanString(cp.platform) === cleanString(payload.platform) &&
      cleanString(cp.code) === cleanString(payload.code) &&
      cloudTime(cp.windowStartAt, futureBound) === cloudTime(payload.windowStartAt, futureBound) &&
      cloudTime(cp.windowEndAt, futureBound) === cloudTime(payload.windowEndAt, futureBound) &&
      cleanString(cp.windowText) === cleanString(payload.windowText) &&
      (remoteCompleted > 0) === (localCompleted > 0) &&
      cleanString(cp.note) === cleanString(payload.note)
    );
  }

  if (type === "express_watch_feedback") {
    if (cloud.lifecycle !== "active") return false;
    if (cleanString(cp.waybill).toUpperCase() !== cleanString(payload.waybill).toUpperCase()) {
      return false;
    }
    const remoteActedAt = cloudTime(cp.actedAt, now);
    const localActedAt = cloudTime(payload.actedAt, now);
    const remoteAction = cp.action;
    const localAction = payload.action;
    const remoteWatchId = cleanString(cp.watchRecordId);
    const localWatchId = cleanString(payload.watchRecordId);
    if (remoteActedAt > localActedAt) return true;
    if (remoteActedAt < localActedAt) return false;
    if (remoteAction === "deleted" && localAction !== "deleted") return true;
    if (remoteAction !== localAction) return false;
    return !localWatchId || remoteWatchId === localWatchId || Boolean(remoteWatchId);
  }

  return (
    cloud.lifecycle === lifecycle &&
    stablePayloadDigest(cp) === stablePayloadDigest(payload)
  );
}

function standaloneBrandToPlatform(brandId: unknown): PickupPlatform | null {
  if (brandId === "cainiao" || brandId === "fengchao") return brandId;
  if (brandId === "duoduo") return "pinduoduo";
  return null;
}

function platformToStandaloneBrand(platform: PickupPlatform): "cainiao" | "fengchao" | "duoduo" {
  return platform === "pinduoduo" ? "duoduo" : platform;
}

function latestWatchTrackTime(shipment: Shipment): number {
  return Math.max(
    0,
    timelineLatestTrackAt(shipment.timeline) ?? 0,
    Number(shipment.timeline.statusEventAtMs) || 0,
    Number(shipment.updatedAtMs) || 0,
  );
}

function stablePayloadDigest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stablePayloadDigest).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stablePayloadDigest((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Applies pulled remote cloud records into local AppState / shared metadata cache and queues outbound
 * edits for local changes inside one App Group file transaction.
 */
export function reconcileParcelCloudRecordsWithLocal(scope: string, now = Date.now()): boolean {
  let stateChanged = false;
  updateParcelCloudState(scope, (cloudState) => {
    if (!cloudState.session || cloudState.snapshot || cloudState.cursor === null) return cloudState;
    const session = cloudState.session;
    const initialAppState = loadState(now);
    let workingState = initialAppState;

    const previousSynced = cloudState.synced;
    const nextSynced: Record<string, ParcelSyncedBaseline> = { ...cloudState.synced };
    const nextPddLinks: Record<string, CloudParcelPddLink> = {};
    const pulledTitles: Array<{ parcel: string; requestedAt: number; title: CloudParcelMetadata }> = [];

    // 1. Inbound `express` & `express_pdd_link`
    const pddParcels: CloudPddParcel[] = [];
    const pddExpressByWaybill = new Map<string, ParcelCloudEnvelope>();
    const nonPddExpress: Array<{ envelope: ParcelCloudEnvelope; waybill: string }> = [];
    for (const envelope of Object.values(cloudState.remote)) {
      if (envelope.type === "express") {
        const previousSync = cloudState.synced[envelope.recordId];
        if (envelope.deleted) {
          if (previousSync && envelope.reason === "user" && previousSync.localKey.startsWith("express:")) {
            const targetWaybill = previousSync.localKey.slice("express:".length);
            const target = workingState.shipments.find(
              (row) =>
                row.identity.manuallyAdded &&
                !unprojectedAccountOrder(row) &&
                normalizeWaybill(displayWaybill(row)) === targetWaybill &&
                row.identity.createdAtMs <= envelope.editedAt,
            );
            if (target) {
              workingState = {
                ...workingState,
                shipments: workingState.shipments.filter((row) => row.identity.id !== target.identity.id),
              };
            }
            delete nextSynced[envelope.recordId];
          }
          continue;
        }
        const payload = envelope.payload ?? {};
        const waybill = normalizeWaybill(cleanString(payload.waybill));
        if (!WAYBILL_PATTERN.test(waybill)) continue;
        const anchorAt = cloudTime(payload.createdAt, now) || cloudTime(payload.eventAt, now);
        const terminalAt = cloudTime(payload.completedAt, now);
        const phone = cleanString(payload.phone4);
        if (payload.importOrigin === "pdd" && anchorAt > 0) {
          const alreadySyncedSameRev = Boolean(
            previousSync &&
            previousSync.revision === envelope.revision &&
            !workingState.shipments.some(
              (row) => !unprojectedAccountOrder(row) && normalizeWaybill(displayWaybill(row)) === waybill,
            ),
          );
          if (!alreadySyncedSameRev) {
            pddParcels.push({
              waybill,
              anchorAt,
              terminalAt,
              carrierCode: cleanString(payload.carrierCode),
              phone4: /^\d{4}$/.test(phone) ? phone : "",
            });
          }
          pddExpressByWaybill.set(waybill, envelope);
        } else {
          nonPddExpress.push({ envelope, waybill });
        }
        nextSynced[envelope.recordId] = {
          revision: envelope.revision,
          type: "express",
          localKey: `express:${waybill}`,
          editedAt: envelope.editedAt,
        };
      } else if (envelope.type === "express_pdd_link" && !envelope.deleted) {
        const payload = envelope.payload ?? {};
        const waybill = normalizeWaybill(cleanString(payload.waybill));
        const anchorAt = cloudTime(payload.anchorAt, now);
        const terminalAt = cloudTime(payload.terminalAt, now);
        const shippingId = cleanString(payload.shippingId);
        if (!WAYBILL_PATTERN.test(waybill) || anchorAt <= 0 || (terminalAt > 0 && terminalAt < anchorAt)) continue;
        pddParcels.push({
          waybill,
          anchorAt,
          terminalAt,
          carrierCode: "",
          phone4: "",
          markOnly: true,
        });
        if (SHIPPING_ID_PATTERN.test(shippingId)) {
          nextPddLinks[waybill] = { waybill, anchorAt, terminalAt, shippingId };
        }
        nextSynced[envelope.recordId] = {
          revision: envelope.revision,
          type: "express_pdd_link",
          localKey: `pdd_link:${waybill}`,
          editedAt: envelope.editedAt,
        };
      }
    }

    for (const { envelope, waybill } of nonPddExpress) {
      const payload = envelope.payload ?? {};
      const anchorAt = cloudTime(payload.createdAt, now) || cloudTime(payload.eventAt, now) || now;
      const completedAt = cloudTime(payload.completedAt, now);
      if (completedAt > 0 && now - completedAt >= EXPRESS_SIGN_RETENTION_MS) continue;
      const tombstone = matchingCloudPddTombstone(workingState.cloudPddTombstones, waybill, anchorAt, completedAt);
      if (tombstone?.action === "deleted") continue;
      if (tombstone?.action === "completed" && now - tombstone.actedAtMs >= EXPRESS_SIGN_RETENTION_MS) continue;
      const existing = workingState.shipments.find(
        (row) => !unprojectedAccountOrder(row) && normalizeWaybill(displayWaybill(row)) === waybill,
      );
      if (existing) {
        if (!existing.identity.manuallyAdded || !matchesCloudShipmentLifecycle(existing, anchorAt, completedAt, now)) {
          continue;
        }
        const previousSync = cloudState.synced[envelope.recordId];
        const remoteCompletes =
          payload.status === "COMPLETED" &&
          completedAt > 0 &&
          !existing.forcedCompletedAtMs &&
          shipmentPresentationStatus(existing).semantic !== "COMPLETED" &&
          (!previousSync || envelope.revision > previousSync.revision);
        const tombstoneCompletes =
          tombstone?.action === "completed" &&
          !existing.forcedCompletedAtMs &&
          shipmentPresentationStatus(existing).semantic !== "COMPLETED";
        const effectiveCompletedAt = remoteCompletes
          ? completedAt
          : tombstoneCompletes
            ? tombstone.actedAtMs
            : 0;
        if (effectiveCompletedAt > 0) {
          workingState = {
            ...workingState,
            shipments: workingState.shipments.map((row) =>
              row.identity.id === existing.identity.id
                ? {
                    ...row,
                    forcedCompletedAtMs: effectiveCompletedAt,
                    settledAtMs: row.settledAtMs ?? effectiveCompletedAt,
                    timeline: {
                      ...row.timeline,
                      semantic: "COMPLETED",
                      structuredStatus: true,
                      statusEventAtMs: effectiveCompletedAt,
                    },
                  }
                : row,
            ),
          };
        }
        continue;
      }
      if (workingState.pendingQueries.some((q) => normalizeWaybill(q.waybill) === waybill)) continue;
      if (matchingIgnoredCloudManualWaybill(workingState.ignoredCloudManualWaybills, waybill, anchorAt, completedAt)) {
        continue;
      }
      const previousSync = cloudState.synced[envelope.recordId];
      // Do not resurrect a manual parcel that was already synced to this device and later removed locally.
      if (previousSync && previousSync.revision === envelope.revision) continue;
      const phone = cleanString(payload.phone4);
      const carrierCode = cleanString(payload.carrierCode);
      const carrier = projectedCarrierPresentation(waybill, carrierCode, "");
      const created = pendingManualPreviewShipment({
        id: `${workingState.activeSource}:${waybill}`,
        source: workingState.activeSource,
        waybill,
        phoneTail: /^\d{4}$/.test(phone) ? phone : "",
        ...carrier,
        rawCourierCode: carrierCode,
        createdAtMs: anchorAt,
        lastAttemptAtMs: now,
        attempts: 0,
      });
      const effectiveCompletedAt = payload.status === "COMPLETED" && completedAt > 0
        ? completedAt
        : tombstone?.action === "completed"
          ? tombstone.actedAtMs
          : 0;
      const imported = {
        ...(effectiveCompletedAt > 0
          ? {
              ...created,
              forcedCompletedAtMs: effectiveCompletedAt,
              settledAtMs: effectiveCompletedAt,
              timeline: {
                ...created.timeline,
                semantic: "COMPLETED" as const,
                structuredStatus: true,
                statusEventAtMs: effectiveCompletedAt,
              },
            }
          : created),
        cloudExpressOrigin: { waybill, waybillGeneration: 0 },
      };
      workingState = { ...workingState, shipments: [...workingState.shipments, imported] };
    }

    if (pddParcels.length) {
      workingState = applyCloudPddParcels(workingState, pddParcels, now);
    }

    if (pddExpressByWaybill.size) {
      let pddSyncedAny = false;
      const nextShipments = workingState.shipments.map((shipment) => {
        if (unprojectedAccountOrder(shipment) || !shipment.pddImport || !shipment.identity.manuallyAdded) {
          return shipment;
        }
        const waybill = normalizeWaybill(displayWaybill(shipment));
        const envelope = pddExpressByWaybill.get(waybill);
        if (!envelope || envelope.deleted) return shipment;
        const previousSync = cloudState.synced[envelope.recordId];
        if (previousSync && previousSync.revision >= envelope.revision) return shipment;
        const payload = envelope.payload ?? {};
        const remoteAnchor = cloudTime(payload.createdAt, now) || cloudTime(payload.eventAt, now) || now;
        const remoteCompleted = cloudTime(payload.completedAt, now);
        if (!matchesCloudShipmentLifecycle(shipment, remoteAnchor, remoteCompleted, now)) return shipment;
        const anchorAt = shipmentAnchorAtMs(shipment, now);
        const terminalAt = shipmentTerminalAtMs(shipment, anchorAt, now);
        const rawSemantic = shipmentPresentationStatus(shipment).semantic;
        const status: StatusSemantic = ALLOWED_STATUSES.has(rawSemantic) ? rawSemantic : "UNKNOWN";
        const completed = status === "COMPLETED" || status === "CANCELLED" || Boolean(shipment.forcedCompletedAtMs);
        const completedAt = completed ? (terminalAt || anchorAt) : 0;
        const rawLatestEventAt = timelineLatestEventAt(shipment.timeline) || shipment.timeline.statusEventAtMs || 0;
        const eventAt = Math.min(now, Math.max(anchorAt, rawLatestEventAt || anchorAt));
        const createdAt = Math.min(now, shipment.identity.createdAtMs > 0 ? shipment.identity.createdAtMs : anchorAt);
        const localUpdatedAt = Math.min(now, Math.max(createdAt, shipment.updatedAtMs || eventAt));
        const pickupValid = Boolean(shipment.pickup && shipment.pickup.code.trim() && shipment.pickup.capturedAtMs > 0);
        const localPayload: Record<string, unknown> = {
          waybill,
          carrierCode: (shipment.identity.courierCode || "").slice(0, 32),
          phone4: /^\d{4}$/.test(shipmentDetailPhoneTail(shipment) || shipment.identity.phone || "")
            ? (shipmentDetailPhoneTail(shipment) || shipment.identity.phone || "")
            : "",
          importOrigin: "pdd",
          status,
          eventAt,
          createdAt,
          updatedAt: localUpdatedAt,
          ...(completedAt > 0 ? { completedAt } : {}),
          ...(pickupValid
            ? {
                pickupCode: shipment.pickup!.code.trim().slice(0, 256),
                ...(shipment.pickup!.locationName ? { pickupLocation: shipment.pickup!.locationName.slice(0, 512) } : {}),
                pickupCapturedAt: Math.min(now, shipment.pickup!.capturedAtMs),
              }
            : {}),
        };
        const localLifecycle = completed && completedAt > 0 ? "history" : "active";
        if (envelope.editedAt < localUpdatedAt) {
          delete nextSynced[envelope.recordId];
          return shipment;
        }
        if (envelope.editedAt === localUpdatedAt && localWinsWholeRecordTie("express", localLifecycle, localPayload, envelope, now)) {
          delete nextSynced[envelope.recordId];
          return shipment;
        }
        const remotePhone = cleanString(payload.phone4);
        const remoteCarrier = cleanString(payload.carrierCode);
        const remotePickupCode = cleanString(payload.pickupCode);
        const remotePickupLocation = cleanString(payload.pickupLocation);
        const remotePickupCapturedAt = cloudTime(payload.pickupCapturedAt, now);
        const nextPhoneTail = /^\d{4}$/.test(remotePhone) ? remotePhone : shipment.identity.phoneTail;
        const nextPickup = remotePickupCode && remotePickupCapturedAt > 0
          ? {
              ...(shipment.pickup?.platform ? { platform: shipment.pickup.platform } : {}),
              waybill: displayWaybill(shipment),
              waybillGeneration: shipment.waybillReuseAtMs ?? 0,
              capturedAtMs: remotePickupCapturedAt,
              code: remotePickupCode.slice(0, 256),
              ...(remotePickupLocation ? { locationName: remotePickupLocation.slice(0, 512) } : {}),
              ...(remoteCompleted > 0 ? { completedAtMs: remoteCompleted } : {}),
            }
          : shipment.pickup;
        const nextCompletedAt = payload.status === "COMPLETED" && remoteCompleted > 0
          ? remoteCompleted
          : shipment.forcedCompletedAtMs;
        nextSynced[envelope.recordId] = {
          revision: envelope.revision,
          type: "express",
          localKey: `express:${waybill}`,
          editedAt: envelope.editedAt,
          localDigest: canonicalWholeRecordDigest("express", envelope.lifecycle, payload, now),
        };
        if (
          nextPhoneTail === shipment.identity.phoneTail &&
          (!remoteCarrier || remoteCarrier === shipment.identity.courierCode) &&
          JSON.stringify(nextPickup) === JSON.stringify(shipment.pickup) &&
          nextCompletedAt === shipment.forcedCompletedAtMs
        ) {
          return shipment;
        }
        pddSyncedAny = true;
        return {
          ...shipment,
          identity: {
            ...shipment.identity,
            phoneTail: nextPhoneTail,
            ...(remoteCarrier ? { courierCode: remoteCarrier } : {}),
          },
          ...(nextPickup ? { pickup: nextPickup } : {}),
          ...(nextCompletedAt
            ? {
                forcedCompletedAtMs: nextCompletedAt,
                settledAtMs: shipment.settledAtMs ?? nextCompletedAt,
                timeline: {
                  ...shipment.timeline,
                  semantic: "COMPLETED" as const,
                  structuredStatus: true,
                  statusEventAtMs: nextCompletedAt,
                },
              }
            : {}),
          updatedAtMs: envelope.editedAt > 0 ? envelope.editedAt : shipment.updatedAtMs,
        };
      });
      if (pddSyncedAny) workingState = { ...workingState, shipments: nextShipments };
    }

    // 2. Inbound `express_metadata` -> shared cache + monotonic title update
    const metadataByWaybill = new Map<string, { envelope: ParcelCloudEnvelope; meta: CloudParcelMetadata }>();
    for (const envelope of Object.values(cloudState.remote)) {
      if (envelope.type !== "express_metadata" || envelope.deleted) continue;
      const payload = envelope.payload ?? {};
      const waybill = normalizeWaybill(cleanString(payload.waybill));
      const anchorAt = cloudTime(payload.anchorAt, now);
      const terminalAt = cloudTime(payload.terminalAt, now);
      if (!WAYBILL_PATTERN.test(waybill) || anchorAt <= 0 || (terminalAt > 0 && terminalAt < anchorAt)) continue;
      const name = productTitle(payload.productName);
      const nameObservedAt = cloudTime(payload.productNameObservedAt, now);
      const imageURL = cloudProductImageURL(payload.productImageUrl);
      const estimate = cleanString(payload.deliveryEstimate).replace(/。$/, "");
      const estimateObservedAt = cloudTime(payload.deliveryEstimateObservedAt, now);
      if (!name && !imageURL && !(estimate && estimateObservedAt)) continue;
      const meta: CloudParcelMetadata = {
        waybill,
        anchorAt,
        terminalAt,
        ...(name ? { productName: name } : {}),
        ...(name && nameObservedAt ? { productNameObservedAt: nameObservedAt } : {}),
        ...(imageURL ? { productImageURL: imageURL } : {}),
        ...(estimate && estimateObservedAt
          ? { deliveryEstimate: estimate, deliveryEstimateObservedAt: estimateObservedAt }
          : {}),
      };
      metadataByWaybill.set(waybill, { envelope, meta });
      const matchingLocal = workingState.shipments.find(
        (row) => !unprojectedAccountOrder(row) && normalizeWaybill(displayWaybill(row)) === waybill,
      );
      const cacheParcelKey = matchingLocal
        ? JSON.stringify([waybill, shipmentLifecycleKey(matchingLocal)])
        : waybill;
      pulledTitles.push({ parcel: cacheParcelKey, requestedAt: Math.max(envelope.editedAt, now), title: meta });
      nextSynced[envelope.recordId] = {
        revision: envelope.revision,
        type: "express_metadata",
        localKey: `metadata:${waybill}`,
        editedAt: envelope.editedAt,
      };
    }

    if (!cloudState.legacyManualTitleCleaned) {
      let cleanedAny = false;
      const cleanedShipments = workingState.shipments.map((shipment) => {
        if (unprojectedAccountOrder(shipment)) return shipment;
        const fields = shipment.platformFields;
        if (!fields?.manualTitle) return shipment;
        const generation = shipment.waybillReuseAtMs ?? 0;
        if (fields.waybill !== displayWaybill(shipment) || fields.waybillGeneration !== generation) return shipment;
        const waybill = normalizeWaybill(displayWaybill(shipment));
        const entry = metadataByWaybill.get(waybill);
        const matchesRemoteLifecycle = entry
          ? matchesCloudShipmentLifecycle(shipment, entry.meta.anchorAt, entry.meta.terminalAt ?? 0, now)
          : false;
        const matchesCloudCopy = Boolean(
          fields.cloudProductName &&
          fields.manualTitle === fields.cloudProductName &&
          (fields.manualTitleEditedAtMs === undefined ||
            fields.manualTitleEditedAtMs === fields.cloudProductNameObservedAtMs),
        );
        const matchesLegacyRemoteCopy = Boolean(
          matchesRemoteLifecycle &&
          entry?.meta.productName &&
          fields.manualTitle === entry.meta.productName &&
          (fields.manualTitleEditedAtMs === undefined ||
            fields.manualTitleEditedAtMs === (entry.meta.productNameObservedAt ?? 0)),
        );
        if (!matchesCloudCopy && !matchesLegacyRemoteCopy) return shipment;
        cleanedAny = true;
        const { manualTitle: _mt, manualTitleEditedAtMs: _mtAt, ...restFields } = fields;
        const preservedCloudName = restFields.cloudProductName || (matchesRemoteLifecycle ? entry?.meta.productName : undefined);
        const preservedCloudAt = restFields.cloudProductNameObservedAtMs ??
          (matchesRemoteLifecycle ? entry?.meta.productNameObservedAt : undefined);
        return {
          ...shipment,
          platformFields: {
            ...restFields,
            ...(preservedCloudName ? { cloudProductName: preservedCloudName } : {}),
            ...(preservedCloudAt && preservedCloudAt > 0 ? { cloudProductNameObservedAtMs: preservedCloudAt } : {}),
          },
        };
      });
      if (cleanedAny) workingState = { ...workingState, shipments: cleanedShipments };
    }

    if (metadataByWaybill.size) {
      let updatedAny = false;
      const updatedShipments = workingState.shipments.map((shipment) => {
        if (unprojectedAccountOrder(shipment)) return shipment;
        const waybill = normalizeWaybill(displayWaybill(shipment));
        const entry = metadataByWaybill.get(waybill);
        if (!entry) return shipment;
        if (!matchesCloudShipmentLifecycle(shipment, entry.meta.anchorAt, entry.meta.terminalAt ?? 0, now)) {
          return shipment;
        }
        const incomingName = entry.meta.productName;
        if (!incomingName) return shipment;
        const incomingObservedAt = entry.meta.productNameObservedAt ?? 0;
        const fields = shipment.platformFields;
        const generation = shipment.waybillReuseAtMs ?? 0;
        const sameTarget = Boolean(
          fields && fields.waybill === displayWaybill(shipment) && fields.waybillGeneration === generation,
        );
        const existingCloudName = sameTarget ? (fields?.cloudProductName || "") : "";
        const existingCloudAt = sameTarget ? (fields?.cloudProductNameObservedAtMs ?? 0) : 0;
        if (existingCloudName) {
          if (incomingObservedAt > 0 && existingCloudAt > 0 && incomingObservedAt <= existingCloudAt) {
            if (existingCloudName === incomingName) return shipment;
            return shipment;
          }
          if (existingCloudAt > 0 && incomingObservedAt === 0) return shipment;
          if (existingCloudName === incomingName && existingCloudAt === incomingObservedAt) return shipment;
        }
        updatedAny = true;
        return {
          ...shipment,
          platformFields: {
            ...(sameTarget ? fields : {}),
            waybill: displayWaybill(shipment),
            waybillGeneration: generation,
            cloudProductName: incomingName,
            ...(incomingObservedAt > 0 ? { cloudProductNameObservedAtMs: incomingObservedAt } : {}),
          },
        };
      });
      if (updatedAny) workingState = { ...workingState, shipments: updatedShipments };
    }

    // 3. Inbound `express_note` -> Shipment.note
    const latestNoteByWaybill = new Map<string, ParcelCloudEnvelope>();
    for (const envelope of Object.values(cloudState.remote)) {
      if (envelope.type !== "express_note") continue;
      const previousSync = cloudState.synced[envelope.recordId];
      const payload = envelope.payload ?? {};
      const waybill = envelope.deleted
        ? (previousSync?.localKey.startsWith("note:") ? previousSync.localKey.slice("note:".length) : "")
        : normalizeWaybill(cleanString(payload.waybill));
      if (!waybill) continue;
      if (!envelope.deleted && payload.subject !== `waybill:${waybill}`) continue;
      const existing = latestNoteByWaybill.get(waybill);
      if (
        !existing ||
        envelope.editedAt > existing.editedAt ||
        (envelope.editedAt === existing.editedAt && envelope.revision > existing.revision)
      ) {
        latestNoteByWaybill.set(waybill, envelope);
      }
    }

    if (latestNoteByWaybill.size) {
      let noteChanged = false;
      const shipmentsWithNotes = workingState.shipments.map((shipment) => {
        if (unprojectedAccountOrder(shipment)) return shipment;
        const waybill = normalizeWaybill(displayWaybill(shipment));
        const envelope = latestNoteByWaybill.get(waybill);
        if (!envelope) return shipment;
        const previousSync = cloudState.synced[envelope.recordId];
        if (previousSync && previousSync.revision >= envelope.revision) return shipment;
        const payload = envelope.payload ?? {};
        const anchorAt = cloudTime(payload.anchorAt, now);
        const terminalAt = cloudTime(payload.terminalAt, now);
        if (!envelope.deleted && anchorAt > 0 && !matchesParcelMetadataLifecycle(shipment, anchorAt, terminalAt, now)) {
          return shipment;
        }
        const remoteNote = envelope.deleted ? "" : cleanString(payload.note);
        const currentNote = (shipment.note || "").trim();
        const hasUnsyncedLocalNote =
          (!previousSync && currentNote.length > 0) ||
          (previousSync !== undefined && previousSync.noteText !== undefined && currentNote !== previousSync.noteText);
        // Do not overwrite an unsynced local note edit when local is newer, or when timestamps tie (`===`) and local wins deterministic digest tie-breaker.
        if (hasUnsyncedLocalNote) {
          if (envelope.editedAt < shipment.updatedAtMs) {
            return shipment;
          }
          if (
            envelope.editedAt === shipment.updatedAtMs &&
            !envelope.deleted &&
            localWinsWholeRecordTie("express_note", "active", { waybill, note: currentNote }, envelope, now)
          ) {
            delete nextSynced[envelope.recordId];
            return shipment;
          }
        }
        if (envelope.deleted) {
          delete nextSynced[envelope.recordId];
        } else {
          nextSynced[envelope.recordId] = {
            revision: envelope.revision,
            type: "express_note",
            localKey: `note:${waybill}`,
            editedAt: envelope.editedAt,
            noteText: remoteNote,
            localDigest: canonicalWholeRecordDigest("express_note", "active", payload, now),
          };
        }
        if (remoteNote === currentNote) return shipment;
        noteChanged = true;
        return {
          ...shipment,
          note: remoteNote || undefined,
          updatedAtMs: envelope.editedAt > 0 ? Math.max(shipment.updatedAtMs, envelope.editedAt) : shipment.updatedAtMs,
        };
      });
      if (noteChanged) workingState = { ...workingState, shipments: shipmentsWithNotes };
    }

    // 4. Inbound `parcel_pickup` & `parcel_handoff` -> AppState.pickupCodeRecords & Shipment.pickup
    let pickupRecords: PickupCodeRecord[] = [...(workingState.pickupCodeRecords ?? [])];
    let pickupRecordsChanged = false;
    let waybillPickupsChanged = false;
    let shipmentsForPickups = workingState.shipments;
    const normalizeParcelCodeForMatch = (value: string): string =>
      cleanString(value).replace(/\s+/g, "").toUpperCase();
    const isLocalCodeBoundToOtherCloudRecord = (item: PickupCodeRecord, currentRecordId: string): boolean => {
      if (item.id !== currentRecordId && Boolean(cloudState.remote[item.id] && !cloudState.remote[item.id]!.deleted)) {
        return true;
      }
      if (!MEAL_UUID.test(item.id)) {
        const detId = parcelDetailRecordId(`parcel-${item.kind}:`, item.id);
        if (detId !== currentRecordId && Boolean(cloudState.remote[detId] && !cloudState.remote[detId]!.deleted)) {
          return true;
        }
      }
      for (const [otherRecordId, entry] of Object.entries(nextSynced)) {
        if (otherRecordId === currentRecordId) continue;
        if (entry.localKey === `code:${item.id}` && !cloudState.remote[otherRecordId]?.deleted) {
          return true;
        }
      }
      return false;
    };
    const findStandaloneCodeMatchIndex = (
      expectedKind: "pickup" | "handoff",
      envelopeRecordId: string,
      previousSync: ParcelSyncedBaseline | undefined,
      platform: PickupPlatform,
      rawCode: string,
      capturedAt: number,
    ): number => {
      const exactIdIndex = pickupRecords.findIndex(
        (item) =>
          item.kind === expectedKind &&
          (item.id === envelopeRecordId ||
            previousSync?.localKey === `code:${item.id}` ||
            (!MEAL_UUID.test(item.id) && parcelDetailRecordId(`parcel-${expectedKind}:`, item.id) === envelopeRecordId)),
      );
      if (exactIdIndex >= 0) return exactIdIndex;
      const normalizedCode = normalizeParcelCodeForMatch(rawCode);
      if (!normalizedCode) return -1;
      return pickupRecords.findIndex(
        (item) =>
          item.kind === expectedKind &&
          item.platform === platform &&
          normalizeParcelCodeForMatch(item.code) === normalizedCode &&
          Math.abs(item.capturedAtMs - capturedAt) <= 1_000 &&
          !isLocalCodeBoundToOtherCloudRecord(item, envelopeRecordId),
      );
    };

    for (const envelope of Object.values(cloudState.remote)) {
      if (envelope.type !== "parcel_pickup" && envelope.type !== "parcel_handoff") continue;
      const previousSync = cloudState.synced[envelope.recordId];
      if (envelope.deleted) {
        if (previousSync && previousSync.localKey.startsWith("code:")) {
          const localId = previousSync.localKey.slice("code:".length);
          const filtered = pickupRecords.filter((item) => item.id !== localId && item.id !== envelope.recordId);
          if (filtered.length !== pickupRecords.length) {
            pickupRecords = filtered;
            pickupRecordsChanged = true;
          }
          delete nextSynced[envelope.recordId];
        }
        continue;
      }
      if (previousSync && previousSync.revision >= envelope.revision) continue;
      const payload = envelope.payload ?? {};
      const code = cleanString(payload.code);
      const capturedAt = cloudTime(payload.capturedAt, now);
      if (!code || capturedAt <= 0) continue;
      const completedAt = cloudTime(payload.completedAt, now);
      const note = typeof payload.note === "string" ? payload.note.trim() : undefined;

      if (envelope.type === "parcel_pickup") {
        const waybill = normalizeWaybill(cleanString(payload.waybill));
        if (waybill) {
          const location = cleanString(payload.location);
          const platform = standaloneBrandToPlatform(payload.brandId) ?? undefined;
          let localTieWon = false;
          shipmentsForPickups = shipmentsForPickups.map((shipment) => {
            if (unprojectedAccountOrder(shipment) || normalizeWaybill(displayWaybill(shipment)) !== waybill) return shipment;
            if (shipment.pickup && shipment.pickup.capturedAtMs > capturedAt) return shipment;
            if (shipment.pickup && shipment.pickup.code.trim() && shipment.pickup.capturedAtMs > 0) {
              const localCap = Math.min(now, shipment.pickup.capturedAtMs);
              const localComp = shipment.pickup.completedAtMs && shipment.pickup.completedAtMs > 0
                ? Math.min(now, shipment.pickup.completedAtMs)
                : 0;
              const localLoc = [shipment.pickup.locationName, shipment.pickup.address].filter(Boolean).join(" ").trim();
              const localBrand = shipment.pickup.platform ? platformToStandaloneBrand(shipment.pickup.platform) : undefined;
              const localNote = (shipment.note || "").trim();
              const localPayload: Record<string, unknown> = {
                waybill,
                ...(localBrand ? { brandId: localBrand } : {}),
                code: shipment.pickup.code.trim().slice(0, 256),
                ...(localLoc ? { location: localLoc.slice(0, 512) } : {}),
                capturedAt: localCap,
                ...(localComp > 0 ? { completedAt: localComp } : {}),
                ...(localNote ? { note: localNote } : Object.hasOwn(payload, "note") ? { note: "" } : {}),
              };
              const localLifecycle = localComp > 0 ? "history" : "active";
              const localDigest = canonicalWholeRecordDigest("parcel_pickup", localLifecycle, localPayload, now);
              const unsynced = !previousSync || previousSync.localDigest !== localDigest;
              const localEditedAt = Math.max(localCap, localComp, shipment.updatedAtMs || localCap);
              const remoteCompletesUnfinished = completedAt > 0 && localComp === 0;
              if (unsynced && !remoteCompletesUnfinished) {
                if (envelope.editedAt < localEditedAt) {
                  localTieWon = true;
                  return shipment;
                }
                if (
                  envelope.editedAt === localEditedAt &&
                  localWinsWholeRecordTie("parcel_pickup", localLifecycle, localPayload, envelope, now)
                ) {
                  localTieWon = true;
                  return shipment;
                }
              }
            }
            const nextPickup = {
              ...(platform ? { platform } : shipment.pickup?.platform ? { platform: shipment.pickup.platform } : {}),
              waybill: displayWaybill(shipment),
              waybillGeneration: shipment.waybillReuseAtMs ?? 0,
              capturedAtMs: capturedAt,
              code,
              ...(location ? { locationName: location } : {}),
              ...(completedAt > 0 ? { completedAtMs: completedAt } : shipment.pickup?.completedAtMs ? { completedAtMs: shipment.pickup.completedAtMs } : {}),
            };
            if (JSON.stringify(shipment.pickup) === JSON.stringify(nextPickup)) return shipment;
            waybillPickupsChanged = true;
            return { ...shipment, pickup: nextPickup };
          });
          if (localTieWon) {
            delete nextSynced[envelope.recordId];
            continue;
          }
          nextSynced[envelope.recordId] = {
            revision: envelope.revision,
            type: "parcel_pickup",
            localKey: `waybill_pickup:${waybill}`,
            editedAt: envelope.editedAt,
            noteText: note ?? "",
            localDigest: canonicalWholeRecordDigest("parcel_pickup", envelope.lifecycle, payload, now),
          };
          continue;
        }
        const platform = standaloneBrandToPlatform(payload.brandId);
        if (!platform) continue;
        const location = cleanString(payload.location);
        const matchIndex = findStandaloneCodeMatchIndex(
          "pickup",
          envelope.recordId,
          previousSync,
          platform,
          code,
          capturedAt,
        );
        const existingItem = matchIndex >= 0 ? (pickupRecords[matchIndex] as StandaloneParcelPickup) : undefined;
        const localId = existingItem?.id ?? envelope.recordId;
        const remoteHasNote = Object.hasOwn(payload, "note");
        const remoteNote = note ?? "";
        let mergedCompletedAt = completedAt || (existingItem?.completedAtMs ?? 0);
        let mergedNote = remoteHasNote ? remoteNote : (existingItem?.note?.trim() ?? "");
        let mergedEditedAtMs: number | undefined;
        if (existingItem) {
          const localCap = Math.min(now, Math.trunc(existingItem.capturedAtMs));
          const localComp = existingItem.completedAtMs && existingItem.completedAtMs > 0
            ? Math.min(now, Math.trunc(existingItem.completedAtMs))
            : 0;
          const localLoc = [existingItem.locationName, existingItem.address].filter(Boolean).join(" ").trim();
          const localNote = existingItem.note?.trim() ?? "";
          const syncedNote = previousSync?.noteText ?? "";
          const localNoteChanged = previousSync ? localNote !== syncedNote : localNote.length > 0;
          const remoteNoteChanged = previousSync ? (remoteHasNote && remoteNote !== syncedNote) : (remoteHasNote && remoteNote.length > 0);
          const localPayload: Record<string, unknown> = {
            brandId: platformToStandaloneBrand(existingItem.platform),
            code: existingItem.code.trim().slice(0, 256),
            ...(localLoc ? { location: localLoc.slice(0, 512) } : {}),
            capturedAt: localCap,
            ...(localComp > 0 ? { completedAt: localComp } : {}),
            ...(existingItem.note !== undefined ? { note: existingItem.note } : remoteHasNote ? { note: "" } : {}),
          };
          const localLifecycle = localComp > 0 ? "history" : "active";
          const localDigest = canonicalWholeRecordDigest("parcel_pickup", localLifecycle, localPayload, now);
          const unsynced = !previousSync || previousSync.localDigest !== localDigest;
          const localEditedAt = Math.min(
            now,
            Math.max(localCap, localComp, existingItem.editedAtMs ? Math.trunc(existingItem.editedAtMs) : 0),
          );
          const remoteCompletesUnfinished = completedAt > 0 && localComp === 0;
          if (unsynced && !remoteCompletesUnfinished) {
            if (envelope.editedAt < localEditedAt) {
              delete nextSynced[envelope.recordId];
              continue;
            }
            if (
              envelope.editedAt === localEditedAt &&
              localWinsWholeRecordTie("parcel_pickup", localLifecycle, localPayload, envelope, now)
            ) {
              delete nextSynced[envelope.recordId];
              continue;
            }
          }
          mergedCompletedAt = completedAt > 0 && localComp > 0
            ? (envelope.editedAt >= localEditedAt ? completedAt : localComp)
            : (completedAt || localComp);
          if (localNoteChanged && !remoteNoteChanged) {
            mergedNote = localNote;
          } else if (localNoteChanged && remoteNoteChanged) {
            mergedNote =
              envelope.editedAt > localEditedAt ||
              (envelope.editedAt === localEditedAt &&
                !localWinsWholeRecordTie("parcel_pickup", localLifecycle, localPayload, envelope, now))
                ? remoteNote
                : localNote;
          } else {
            mergedNote = remoteHasNote ? remoteNote : localNote;
          }
          if (localNoteChanged && mergedNote === localNote && (!remoteHasNote || remoteNote !== localNote)) {
            mergedEditedAtMs = Math.min(now, Math.max(localEditedAt, envelope.editedAt + 1));
          }
        }
        if (mergedCompletedAt > 0 && now - mergedCompletedAt > RETENTION_CUTOFF_MS) {
          nextSynced[envelope.recordId] = {
            revision: envelope.revision,
            type: "parcel_pickup",
            localKey: `code:${localId}`,
            editedAt: envelope.editedAt,
            noteText: remoteNote,
            localDigest: canonicalWholeRecordDigest("parcel_pickup", envelope.lifecycle, payload, now),
          };
          continue;
        }
        const mergedRecord: StandaloneParcelPickup = {
          id: localId,
          kind: "pickup",
          platform,
          code,
          capturedAtMs: capturedAt,
          ...(location ? { locationName: location } : {}),
          ...(mergedCompletedAt > 0 ? { completedAtMs: mergedCompletedAt } : {}),
          ...(mergedNote ? { note: mergedNote } : {}),
          ...(mergedEditedAtMs ? { editedAtMs: mergedEditedAtMs } : {}),
        };
        if (matchIndex >= 0) {
          if (JSON.stringify(pickupRecords[matchIndex]) !== JSON.stringify(mergedRecord)) {
            pickupRecords[matchIndex] = mergedRecord;
            pickupRecordsChanged = true;
          }
        } else {
          pickupRecords.push(mergedRecord);
          pickupRecordsChanged = true;
        }
        nextSynced[envelope.recordId] = {
          revision: envelope.revision,
          type: "parcel_pickup",
          localKey: `code:${localId}`,
          editedAt: envelope.editedAt,
          noteText: remoteNote,
          localDigest: canonicalWholeRecordDigest("parcel_pickup", envelope.lifecycle, payload, now),
        };
      } else {
        const platform = payload.platform === "pinduoduo" || payload.platform === "cainiao" ? payload.platform : null;
        if (!platform) continue;
        const windowStartAt = cloudTime(payload.windowStartAt, now + 366 * 86_400_000);
        const windowEndAt = cloudTime(payload.windowEndAt, now + 366 * 86_400_000);
        const expiresAt = windowEndAt > 0 ? windowEndAt + 3_600_000 : 0;
        const windowText = cleanString(payload.windowText);
        const matchIndex = findStandaloneCodeMatchIndex(
          "handoff",
          envelope.recordId,
          previousSync,
          platform,
          code,
          capturedAt,
        );
        const existingItem = matchIndex >= 0 ? (pickupRecords[matchIndex] as ParcelHandoffRecord) : undefined;
        const localId = existingItem?.id ?? envelope.recordId;
        const remoteHasNote = Object.hasOwn(payload, "note");
        const remoteNote = note ?? "";
        let mergedCompletedAt = completedAt || (existingItem?.completedAtMs ?? 0);
        let mergedWinStart = windowStartAt;
        let mergedWinEnd = windowEndAt;
        let mergedWinText = windowText;
        let mergedExpires = expiresAt;
        let mergedNote = remoteHasNote ? remoteNote : (existingItem?.note?.trim() ?? "");
        let mergedEditedAtMs: number | undefined;
        if (existingItem) {
          const localCap = Math.min(now, Math.trunc(existingItem.capturedAtMs));
          const localWinEnd = existingItem.windowEndAtMs && existingItem.windowEndAtMs > 0 ? Math.trunc(existingItem.windowEndAtMs) : 0;
          const localWinStart = localWinEnd > 0 && existingItem.windowStartAtMs && existingItem.windowStartAtMs > 0
            ? Math.min(localWinEnd, Math.trunc(existingItem.windowStartAtMs))
            : 0;
          const localExpires = localWinEnd > 0 ? localWinEnd + 3_600_000 : 0;
          const rawLocalComp = existingItem.completedAtMs && existingItem.completedAtMs > 0
            ? Math.min(now, Math.trunc(existingItem.completedAtMs))
            : 0;
          const localComp = rawLocalComp > 0
            ? (localExpires > 0 && rawLocalComp >= localExpires ? Math.max(1, localExpires - 1) : rawLocalComp)
            : 0;
          const localNote = existingItem.note?.trim() ?? "";
          const syncedNote = previousSync?.noteText ?? "";
          const localNoteChanged = previousSync ? localNote !== syncedNote : localNote.length > 0;
          const remoteNoteChanged = previousSync ? (remoteHasNote && remoteNote !== syncedNote) : (remoteHasNote && remoteNote.length > 0);
          const localPayload: Record<string, unknown> = {
            platform: existingItem.platform,
            code: existingItem.code.trim().slice(0, 256),
            capturedAt: localCap,
            ...(localWinStart > 0 ? { windowStartAt: localWinStart } : {}),
            ...(localWinEnd > 0 ? { windowEndAt: localWinEnd } : {}),
            ...(existingItem.windowText ? { windowText: existingItem.windowText.slice(0, 128) } : {}),
            expiresAt: localExpires,
            ...(localComp > 0 ? { completedAt: localComp } : {}),
            ...(existingItem.note !== undefined ? { note: existingItem.note } : remoteHasNote ? { note: "" } : {}),
          };
          // Passive wall-clock handoff window expiry (`expired`) is a local projection, NOT a user edit.
          const localUserLifecycle = localComp > 0 ? "history" : "active";
          const localUserDigest = canonicalWholeRecordDigest("parcel_handoff", localUserLifecycle, localPayload, now);
          const unsyncedUserEdit = !previousSync || previousSync.localDigest !== localUserDigest;
          const localEditedAt = Math.min(
            now,
            Math.max(localCap, localComp, existingItem.editedAtMs ? Math.trunc(existingItem.editedAtMs) : 0),
          );
          const remoteCompletesUnfinished = completedAt > 0 && localComp === 0;
          if (unsyncedUserEdit && !remoteCompletesUnfinished) {
            if (envelope.editedAt < localEditedAt) {
              delete nextSynced[envelope.recordId];
              continue;
            }
            if (
              envelope.editedAt === localEditedAt &&
              localWinsWholeRecordTie("parcel_handoff", localUserLifecycle, localPayload, envelope, now)
            ) {
              delete nextSynced[envelope.recordId];
              continue;
            }
          }
          mergedCompletedAt = completedAt > 0 && localComp > 0
            ? (envelope.editedAt >= localEditedAt ? completedAt : existingItem.completedAtMs!)
            : (completedAt || (existingItem.completedAtMs ?? 0));
          if (
            existingItem.editedAtMs &&
            localEditedAt > envelope.editedAt &&
            (localWinStart !== windowStartAt || localWinEnd !== windowEndAt)
          ) {
            mergedWinStart = localWinStart;
            mergedWinEnd = localWinEnd;
            mergedWinText = existingItem.windowText ?? "";
            mergedExpires = localExpires;
            mergedEditedAtMs = Math.min(now, Math.max(localEditedAt, envelope.editedAt + 1));
          }
          if (localNoteChanged && !remoteNoteChanged) {
            mergedNote = localNote;
          } else if (localNoteChanged && remoteNoteChanged) {
            mergedNote =
              envelope.editedAt > localEditedAt ||
              (envelope.editedAt === localEditedAt &&
                !localWinsWholeRecordTie("parcel_handoff", localUserLifecycle, localPayload, envelope, now))
                ? remoteNote
                : localNote;
          } else {
            mergedNote = remoteHasNote ? remoteNote : localNote;
          }
          if (localNoteChanged && mergedNote === localNote && (!remoteHasNote || remoteNote !== localNote)) {
            mergedEditedAtMs = Math.min(now, Math.max(localEditedAt, envelope.editedAt + 1));
          }
        }
        const terminalClock = mergedCompletedAt || (mergedExpires > 0 && mergedExpires <= now ? mergedExpires : 0);
        if (terminalClock > 0 && now - terminalClock > RETENTION_CUTOFF_MS) {
          nextSynced[envelope.recordId] = {
            revision: envelope.revision,
            type: "parcel_handoff",
            localKey: `code:${localId}`,
            editedAt: envelope.editedAt,
            noteText: remoteNote,
            localDigest: canonicalWholeRecordDigest("parcel_handoff", completedAt > 0 ? "history" : "active", payload, now),
          };
          continue;
        }
        const mergedHandoff: ParcelHandoffRecord = {
          id: localId,
          kind: "handoff",
          platform,
          code,
          capturedAtMs: capturedAt,
          ...(mergedWinStart > 0 ? { windowStartAtMs: mergedWinStart } : {}),
          ...(mergedWinEnd > 0 ? { windowEndAtMs: mergedWinEnd } : {}),
          ...(mergedWinText ? { windowText: mergedWinText } : {}),
          ...(existingItem?.providerTitle ? { providerTitle: existingItem.providerTitle } : {}),
          ...(mergedCompletedAt > 0 ? { completedAtMs: mergedCompletedAt } : {}),
          ...(mergedExpires > 0 && mergedExpires <= now && !mergedCompletedAt
            ? { expiredAtMs: mergedExpires }
            : !mergedCompletedAt && existingItem?.expiredAtMs
              ? { expiredAtMs: existingItem.expiredAtMs }
              : {}),
          ...(mergedNote ? { note: mergedNote } : {}),
          ...(mergedEditedAtMs ? { editedAtMs: mergedEditedAtMs } : {}),
        };
        if (matchIndex >= 0) {
          if (JSON.stringify(pickupRecords[matchIndex]) !== JSON.stringify(mergedHandoff)) {
            pickupRecords[matchIndex] = mergedHandoff;
            pickupRecordsChanged = true;
          }
        } else {
          pickupRecords.push(mergedHandoff);
          pickupRecordsChanged = true;
        }
        nextSynced[envelope.recordId] = {
          revision: envelope.revision,
          type: "parcel_handoff",
          localKey: `code:${localId}`,
          editedAt: envelope.editedAt,
          noteText: remoteNote,
          localDigest: canonicalWholeRecordDigest("parcel_handoff", completedAt > 0 ? "history" : "active", payload, now),
        };
      }
    }

    if (waybillPickupsChanged) workingState = { ...workingState, shipments: shipmentsForPickups };
    if (pickupRecordsChanged) workingState = { ...workingState, pickupCodeRecords: pickupRecords };

    // 5. Inbound `express_watch_feedback` -> AppState.watchFeedback & watch: rows
    const watchScope = workingState.watchSource?.scope || activeWatchScope();
    if (watchScope) {
      let watchFeedbackList: WatchFeedbackRecord[] = [...(workingState.watchFeedback ?? [])];
      let watchFeedbackChanged = false;
      let watchRows = workingState.shipments;
      let watchRowsChanged = false;

      for (const envelope of Object.values(cloudState.remote)) {
        if (envelope.type !== "express_watch_feedback" || envelope.deleted) continue;
        const payload = envelope.payload ?? {};
        const waybill = cleanString(payload.waybill).toUpperCase();
        const action = payload.action === "completed" || payload.action === "deleted" ? payload.action : null;
        const actedAt = cloudTime(payload.actedAt, now);
        if (!WATCH_WAYBILL_PATTERN.test(waybill) || !action || actedAt <= 0) continue;
        const remoteWatchId = typeof payload.watchRecordId === "string" && MEAL_UUID.test(payload.watchRecordId)
          ? payload.watchRecordId
          : "";
        const sameWaybillWatchRow = watchRows.find(
          (row) =>
            internationalShipment(row) &&
            row.identity.id.startsWith("watch:") &&
            normalizeWaybill(displayWaybill(row)) === waybill,
        );
        // W1: if a newly re-tracked Watch record on the same waybill has updatedAtMs > actedAt (either a different
        // watchRecordId W_new !== W_old or a waybill-only feedback record), do not overwrite watchFeedbackList or
        // delete/complete the newer Watch record.
        if (
          sameWaybillWatchRow &&
          sameWaybillWatchRow.updatedAtMs > actedAt &&
          (!remoteWatchId || sameWaybillWatchRow.identity.id !== `watch:${remoteWatchId}`)
        ) {
          nextSynced[envelope.recordId] = {
            revision: envelope.revision,
            type: "express_watch_feedback",
            localKey: `watch_feedback:${waybill}`,
            editedAt: envelope.editedAt,
          };
          continue;
        }
        const matchingWatchRow = remoteWatchId
          ? watchRows.find(
              (row) =>
                internationalShipment(row) &&
                row.identity.id === `watch:${remoteWatchId}`,
            )
          : sameWaybillWatchRow;
        const resolvedWatchId = remoteWatchId ||
          (matchingWatchRow ? matchingWatchRow.identity.id.slice("watch:".length) : "") ||
          parcelDetailRecordId("parcel-watch-feedback:", waybill);

        const existingIndex = watchFeedbackList.findIndex(
          (entry) =>
            entry.scope === watchScope &&
            (entry.watchRecordId === resolvedWatchId || normalizeWaybill(entry.waybill) === waybill),
        );
        const existingEntry = existingIndex >= 0 ? watchFeedbackList[existingIndex] : undefined;
        const remoteWins =
          !existingEntry ||
          actedAt > existingEntry.actedAt ||
          (actedAt === existingEntry.actedAt && action === "deleted" && existingEntry.action !== "deleted");

        if (remoteWins) {
          const latestTrackAtMs = matchingWatchRow ? latestWatchTrackTime(matchingWatchRow) : (existingEntry?.latestTrackAtMs ?? 0);
          const nextEntry: WatchFeedbackRecord = {
            scope: watchScope,
            watchRecordId: resolvedWatchId,
            waybill,
            action,
            actedAt,
            latestTrackAtMs,
          };
          if (existingIndex >= 0) {
            if (JSON.stringify(watchFeedbackList[existingIndex]) !== JSON.stringify(nextEntry)) {
              watchFeedbackList[existingIndex] = nextEntry;
              watchFeedbackChanged = true;
            }
          } else {
            watchFeedbackList.push(nextEntry);
            watchFeedbackChanged = true;
          }
        }

        if (
          matchingWatchRow &&
          (!remoteWatchId ? actedAt >= matchingWatchRow.updatedAtMs : true) &&
          actedAt >= latestWatchTrackTime(matchingWatchRow)
        ) {
          if (action === "deleted") {
            watchRows = watchRows.filter((row) => row.identity.id !== matchingWatchRow.identity.id);
            watchRowsChanged = true;
          } else if (action === "completed" && !matchingWatchRow.forcedCompletedAtMs) {
            watchRows = watchRows.map((row) =>
              row.identity.id === matchingWatchRow.identity.id
                ? {
                    ...row,
                    forcedCompletedAtMs: actedAt,
                    settledAtMs: row.settledAtMs ?? actedAt,
                    timeline: { ...row.timeline, semantic: "COMPLETED", structuredStatus: true, statusEventAtMs: actedAt },
                  }
                : row,
            );
            watchRowsChanged = true;
          }
        }
        nextSynced[envelope.recordId] = {
          revision: envelope.revision,
          type: "express_watch_feedback",
          localKey: `watch_feedback:${waybill}`,
          editedAt: envelope.editedAt,
        };
      }

      if (watchFeedbackChanged || watchRowsChanged) {
        workingState = {
          ...workingState,
          ...(watchFeedbackChanged ? { watchFeedback: watchFeedbackList } : {}),
          ...(watchRowsChanged ? { shipments: watchRows } : {}),
        };
      }
    }

    // Commit inbound state changes if any
    let finalAppState = initialAppState;
    if (workingState !== initialAppState) {
      finalAppState = saveState(
        workingState,
        now,
        workingState.pickupCodeRecords !== initialAppState.pickupCodeRecords
          ? { pickupCodeRecords: workingState.pickupCodeRecords ?? [] }
          : {},
        initialAppState,
      );
      if (finalAppState.revision > initialAppState.revision) stateChanged = true;
    }

    // Publish pulled cloud parcel titles into shared metadata cache for immediate DetailPage display
    const credential = gatewayCredentialForLocalCache();
    if (credential && !credential.rejected && pulledTitles.length) {
      const storedCache = sharedData().cloudParcelTitles;
      const baseEntries = storedCache?.credential === credential.scope ? storedCache.entries : [];
      const mergedByParcel = new Map<string, { parcel: string; requestedAt: number; title?: CloudParcelMetadata }>();
      for (const entry of baseEntries) mergedByParcel.set(entry.parcel, entry);
      for (const pulled of pulledTitles) {
        const waybill = pulled.title?.waybill || pulled.parcel;
        const matchingFinal = finalAppState.shipments.find(
          (row) => !unprojectedAccountOrder(row) && normalizeWaybill(displayWaybill(row)) === waybill,
        );
        const canonicalParcelKey = matchingFinal
          ? JSON.stringify([waybill, shipmentLifecycleKey(matchingFinal)])
          : pulled.parcel;
        const entry = canonicalParcelKey === pulled.parcel ? pulled : { ...pulled, parcel: canonicalParcelKey };
        const prev = mergedByParcel.get(entry.parcel);
        if (!prev || entry.requestedAt >= prev.requestedAt) {
          mergedByParcel.set(entry.parcel, entry);
        }
      }
      const nextEntries = [...mergedByParcel.values()]
        .sort((left, right) => right.requestedAt - left.requestedAt)
        .slice(0, CLOUD_TITLE_CACHE_LIMIT);
      publishSharedData({
        cloudParcelTitles: {
          credential: credential.scope,
          deniedAt: 0,
          entries: nextEntries,
        },
      });
    }

    // 6. Compute Outbound Local Edits -> nextEdits
    const nextEdits: Record<string, ParcelCloudEdit> = { ...cloudState.edits };
    const nextQuarantined: Record<string, ParcelQuarantinedRecord> = normalizeQuarantinedEntries(
      cloudState.quarantined,
      now,
    );
    const nextQuarantineHistory: Record<string, ParcelQuarantineHistoryEntry> = normalizeQuarantineHistoryEntries(
      cloudState.quarantineHistory,
    );
    const isQuarantinedDigest = (recordId: string, digest: string): boolean => {
      const entry = nextQuarantined[recordId];
      if (!entry) return false;
      if (!entry.permanent && (entry.expiresAtMs === undefined || entry.expiresAtMs <= now)) {
        delete nextQuarantined[recordId];
        return false;
      }
      if (entry.digest === "*") {
        nextQuarantined[recordId] = { digest, permanent: true };
        nextQuarantineHistory[recordId] = { digest, rejections: PARCEL_CLOUD_QUARANTINE_MAX_REJECTIONS };
        return true;
      }
      return entry.digest === digest;
    };
    const enqueueEdit = (
      recordId: string,
      type: ParcelCloudRecordType,
      lifecycle: "active" | "history",
      historyAt: number,
      payload: Record<string, unknown> | undefined,
      editedAt: number,
      deleted?: true,
    ) => {
      const cloud = cloudState.remote[recordId];
      if (deleted) {
        if (!cloud || cloud.deleted) {
          delete nextEdits[recordId];
          return;
        }
        const qDigest = parcelEditQuarantineDigest(type, true, cloud.lifecycle, cloud.historyAt, undefined);
        if (isQuarantinedDigest(recordId, qDigest)) {
          delete nextEdits[recordId];
          return;
        }
        if (nextQuarantined[recordId]) delete nextQuarantined[recordId];
        if (nextQuarantineHistory[recordId] && nextQuarantineHistory[recordId]!.digest !== qDigest) {
          delete nextQuarantineHistory[recordId];
        }
        const effectiveEditedAt = Math.min(now, Math.max(1, editedAt, cloud.editedAt + 1));
        const existing = nextEdits[recordId];
        if (existing?.deleted && existing.editedAt >= effectiveEditedAt) return;
        nextEdits[recordId] = {
          mutationId: existing?.deleted ? existing.mutationId : newUuid(),
          recordId,
          type,
          editedAt: effectiveEditedAt,
          deleted: true,
          lifecycle: cloud.lifecycle,
          historyAt: cloud.historyAt,
        };
        return;
      }
      if (!payload) return;
      const qDigest = parcelEditQuarantineDigest(type, false, lifecycle, historyAt, payload);
      if (isQuarantinedDigest(recordId, qDigest)) {
        delete nextEdits[recordId];
        return;
      }
      if (nextQuarantined[recordId]) delete nextQuarantined[recordId];
      if (nextQuarantineHistory[recordId] && nextQuarantineHistory[recordId]!.digest !== qDigest) {
        delete nextQuarantineHistory[recordId];
      }
      const wholeRecordType = isWholeRecordType(type);
      if (cloud && !cloud.deleted && cloud.type === type) {
        if (isCloudRecordSemanticallyConverged(cloud, type, lifecycle, payload, editedAt, now)) {
          delete nextEdits[recordId];
          return;
        }
        if (wholeRecordType) {
          if (editedAt < cloud.editedAt) {
            delete nextEdits[recordId];
            return;
          }
          if (editedAt === cloud.editedAt && !localWinsWholeRecordTie(type, lifecycle, payload, cloud, now)) {
            delete nextEdits[recordId];
            return;
          }
        }
      }
      const effectiveEditedAt = cloud
        ? (wholeRecordType && !cloud.deleted && editedAt === cloud.editedAt
            ? cloud.editedAt
            : Math.min(now, Math.max(1, editedAt, cloud.editedAt + 1)))
        : Math.min(now, Math.max(1, editedAt));
      const existing = nextEdits[recordId];
      if (
        existing &&
        !existing.deleted &&
        existing.lifecycle === lifecycle &&
        existing.historyAt === historyAt &&
        stablePayloadDigest(existing.payload) === stablePayloadDigest(payload)
      ) {
        return;
      }
      nextEdits[recordId] = {
        mutationId: newUuid(),
        recordId,
        type,
        editedAt: effectiveEditedAt,
        lifecycle,
        historyAt,
        payload,
      };
    };

    const remoteExpressByWaybill = new Map<string, ParcelCloudEnvelope>();
    const remoteNoteByWaybill = new Map<string, ParcelCloudEnvelope>();
    const remoteWaybillPickupByWaybill = new Map<string, ParcelCloudEnvelope>();
    const remoteCodeByLocalId = new Map<string, ParcelCloudEnvelope>();

    for (const envelope of Object.values(cloudState.remote)) {
      const syncedEntry = nextSynced[envelope.recordId];
      if (envelope.type === "express" && !envelope.deleted) {
        const w = normalizeWaybill(cleanString(envelope.payload?.waybill));
        if (w) remoteExpressByWaybill.set(w, envelope);
      } else if (envelope.type === "express_note") {
        const w = envelope.deleted
          ? (syncedEntry?.localKey.startsWith("note:") ? syncedEntry.localKey.slice("note:".length) : "")
          : normalizeWaybill(cleanString(envelope.payload?.waybill));
        if (w) {
          const prev = remoteNoteByWaybill.get(w);
          if (!prev || envelope.editedAt >= prev.editedAt) remoteNoteByWaybill.set(w, envelope);
        }
      } else if (envelope.type === "parcel_pickup" && !envelope.deleted && cleanString(envelope.payload?.waybill)) {
        const w = normalizeWaybill(cleanString(envelope.payload?.waybill));
        if (w) remoteWaybillPickupByWaybill.set(w, envelope);
      }
      if ((envelope.type === "parcel_pickup" || envelope.type === "parcel_handoff") && syncedEntry?.localKey.startsWith("code:")) {
        remoteCodeByLocalId.set(syncedEntry.localKey.slice("code:".length), envelope);
      }
    }

    // 6a. Outbound per-shipment projections (`express`, `express_pdd_link`, `express_metadata`, `express_note`, waybill `parcel_pickup`)
    for (const shipment of finalAppState.shipments) {
      if (unprojectedAccountOrder(shipment)) continue;
      const waybill = normalizeWaybill(displayWaybill(shipment));
      if (!WAYBILL_PATTERN.test(waybill)) continue;
      const anchorAt = shipmentAnchorAtMs(shipment, now);
      if (anchorAt <= 0) continue;
      const terminalAt = shipmentTerminalAtMs(shipment, anchorAt, now);
      const rawSemantic = shipmentPresentationStatus(shipment).semantic;
      const status: StatusSemantic = ALLOWED_STATUSES.has(rawSemantic) ? rawSemantic : "UNKNOWN";

      // PDD `express` & `express_pdd_link`
      if (shipment.pddImport && !internationalShipment(shipment)) {
        if (shipment.identity.manuallyAdded) {
          const existingExpress = remoteExpressByWaybill.get(waybill);
          const remoteExpressPayload = existingExpress && !existingExpress.deleted ? existingExpress.payload : undefined;
          const recordId = existingExpress?.recordId ?? parcelDetailRecordId("parcel-express-pdd:", `${waybill}:${anchorAt}`);
          const completed = status === "COMPLETED" || status === "CANCELLED" || Boolean(shipment.forcedCompletedAtMs);
          const completedAt = completed ? (terminalAt || anchorAt) : 0;
          const rawLatestEventAt = timelineLatestEventAt(shipment.timeline) || shipment.timeline.statusEventAtMs || 0;
          const eventAt = Math.min(now, Math.max(anchorAt, rawLatestEventAt || anchorAt));
          const createdAt = Math.min(now, shipment.identity.createdAtMs > 0 ? shipment.identity.createdAtMs : anchorAt);
          const updatedAt = Math.min(now, Math.max(createdAt, shipment.updatedAtMs || eventAt));
          const localCarrier = (shipment.identity.courierCode || "").slice(0, 32);
          const carrierCode = localCarrier || cleanString(remoteExpressPayload?.carrierCode).slice(0, 32);
          const tail = shipmentDetailPhoneTail(shipment) || shipment.identity.phone || "";
          const remoteTail = cleanString(remoteExpressPayload?.phone4);
          const phone4 = /^\d{4}$/.test(tail) ? tail : (/^\d{4}$/.test(remoteTail) ? remoteTail : "");
          const pickupValid = Boolean(shipment.pickup && shipment.pickup.code.trim() && shipment.pickup.capturedAtMs > 0);
          const remotePickupCode = cleanString(remoteExpressPayload?.pickupCode);
          const remotePickupCapturedAt = cloudTime(remoteExpressPayload?.pickupCapturedAt, now);
          const remotePickupLocation = cleanString(remoteExpressPayload?.pickupLocation);
          const payload: Record<string, unknown> = {
            waybill,
            carrierCode,
            phone4,
            importOrigin: "pdd",
            status,
            eventAt,
            createdAt,
            updatedAt,
            ...(completedAt > 0 ? { completedAt } : {}),
            ...(pickupValid
              ? {
                  pickupCode: shipment.pickup!.code.trim().slice(0, 256),
                  ...(shipment.pickup!.locationName ? { pickupLocation: shipment.pickup!.locationName.slice(0, 512) } : {}),
                  pickupCapturedAt: Math.min(now, shipment.pickup!.capturedAtMs),
                }
              : remotePickupCode && remotePickupCapturedAt > 0
                ? {
                    pickupCode: remotePickupCode.slice(0, 256),
                    ...(remotePickupLocation ? { pickupLocation: remotePickupLocation.slice(0, 512) } : {}),
                    pickupCapturedAt: remotePickupCapturedAt,
                  }
                : {}),
          };
          enqueueEdit(
            recordId,
            "express",
            completed && completedAt > 0 ? "history" : "active",
            completed && completedAt > 0 ? completedAt : 0,
            payload,
            updatedAt,
          );
        }
        const shippingId = SHIPPING_ID_PATTERN.test(shipment.pddImport.shippingId || "")
          ? shipment.pddImport.shippingId!
          : "";
        if (!shipment.identity.manuallyAdded || shippingId) {
          const linkRecordId = parcelDetailRecordId("parcel-pdd-link:", waybill);
          const existingLink = cloudState.remote[linkRecordId];
          const remoteLinkPayload = existingLink && !existingLink.deleted ? existingLink.payload : undefined;
          const remoteAnchor = remoteLinkPayload ? cloudTime(remoteLinkPayload.anchorAt, now) : 0;
          const remoteTerminal = remoteLinkPayload ? cloudTime(remoteLinkPayload.terminalAt, now) : 0;
          const remoteObserved = remoteLinkPayload ? cloudTime(remoteLinkPayload.observedAt, now) : 0;
          const rawExistingShippingId = cleanString(remoteLinkPayload?.shippingId);
          const existingShippingId = SHIPPING_ID_PATTERN.test(rawExistingShippingId) ? rawExistingShippingId : "";
          const sameLinkLifecycle = remoteLinkPayload
            ? matchesCloudShipmentLifecycle(shipment, remoteAnchor, remoteTerminal, now)
            : false;
          // M-01 (`docs/PDD_MANUAL_FLOW_20261109.md:95-103`): mark-only automatic links without a shipping ID use `observedAt: 1`.
          const localObservedAt = shippingId ? Math.min(now, Math.max(1, anchorAt)) : 1;
          if (remoteLinkPayload && terminalAt > 0 && remoteAnchor >= terminalAt + WAYBILL_REUSE_MIN_GAP_MS) {
            delete nextEdits[linkRecordId];
          } else if (sameLinkLifecycle) {
            const needShippingPush = Boolean(
              shippingId &&
              shippingId !== existingShippingId &&
              ((!existingShippingId && remoteObserved <= 1) || localObservedAt > remoteObserved),
            );
            const needTerminalPush = Boolean(terminalAt > 0 && remoteTerminal < terminalAt);
            if (!needShippingPush && !needTerminalPush) {
              delete nextEdits[linkRecordId];
            } else {
              const mergedAnchorAt = remoteAnchor > 0 ? Math.min(remoteAnchor, anchorAt) : anchorAt;
              const mergedTerminalAt = Math.max(remoteTerminal, terminalAt);
              const mergedShippingId = needShippingPush ? shippingId : existingShippingId;
              const mergedObservedAt = needShippingPush
                ? (remoteObserved <= 1
                    ? Math.min(now, Math.max(localObservedAt, remoteObserved + 1))
                    : localObservedAt)
                : Math.max(1, remoteObserved);
              enqueueEdit(
                linkRecordId,
                "express_pdd_link",
                "active",
                0,
                {
                  waybill,
                  anchorAt: mergedAnchorAt,
                  terminalAt: mergedTerminalAt,
                  shippingId: mergedShippingId,
                  observedAt: mergedObservedAt,
                },
                mergedObservedAt,
              );
            }
          } else {
            enqueueEdit(
              linkRecordId,
              "express_pdd_link",
              "active",
              0,
              {
                waybill,
                anchorAt,
                terminalAt,
                shippingId,
                observedAt: localObservedAt,
              },
              Math.max(anchorAt, localObservedAt),
            );
          }
        }
      }

      // `express_metadata` (productName + deliveryEstimate, NEVER productImageUrl)
      const fields = shipment.platformFields;
      const fieldsMatch = fields && fields.waybill === displayWaybill(shipment) && fields.waybillGeneration === (shipment.waybillReuseAtMs ?? 0);
      const manualTitle = fieldsMatch ? productTitle(fields.manualTitle) : "";
      const platformTitle = fieldsMatch && !internationalShipment(shipment) ? productTitle(fields.title?.text) : "";
      const chosenTitle = manualTitle || platformTitle;
      const chosenTitleObservedAt = manualTitle
        ? Math.min(now, Math.max(1, fields!.manualTitleEditedAtMs || anchorAt))
        : platformTitle
          ? Math.min(now, Math.max(1, shipment.identity.createdAtMs || anchorAt))
          : 0;
      const rawEstimate = fieldsMatch && !internationalShipment(shipment) && deliveryEstimateApplies(shipment)
        ? normalizedEstimateForWire(fields.estimate?.text)
        : "";
      const estimateObservedAt = rawEstimate && fields?.estimate?.capturedAtMs
        ? Math.min(now, Math.max(1, fields.estimate.capturedAtMs))
        : 0;

      const metaId = parcelDetailRecordId("parcel-metadata:", waybill);
      if (chosenTitle || (rawEstimate && estimateObservedAt > 0)) {
        const existingMeta = cloudState.remote[metaId];
        const remotePayload = !existingMeta?.deleted ? existingMeta?.payload : undefined;
        const remoteAnchor = remotePayload ? cloudTime(remotePayload.anchorAt, now) : 0;
        const remoteTerminal = remotePayload ? cloudTime(remotePayload.terminalAt, now) : 0;
        if (remotePayload && terminalAt > 0 && remoteAnchor >= terminalAt + WAYBILL_REUSE_MIN_GAP_MS) {
          delete nextEdits[metaId];
        } else {
          const remoteLifecycleMatches = remotePayload
            ? matchesCloudShipmentLifecycle(shipment, remoteAnchor, remoteTerminal, now)
            : false;
          const remoteTitle = remoteLifecycleMatches ? productTitle(remotePayload?.productName) : "";
          const remoteTitleAt = remoteLifecycleMatches ? cloudTime(remotePayload?.productNameObservedAt, now) : 0;
          const remoteEstimate = remoteLifecycleMatches ? normalizedEstimateForWire(cleanString(remotePayload?.deliveryEstimate)) : "";
          const remoteEstimateAt = remoteLifecycleMatches ? cloudTime(remotePayload?.deliveryEstimateObservedAt, now) : 0;

          const shouldPushTitle = Boolean(
            chosenTitle &&
            (!remoteTitle
              ? true
              : chosenTitle === remoteTitle
                ? Boolean(session.expressTitleClockSupported && chosenTitleObservedAt > 0 && !remoteTitleAt)
                : chosenTitleObservedAt > remoteTitleAt),
          );
          const shouldPushEstimate = Boolean(
            rawEstimate &&
            estimateObservedAt > 0 &&
            (!remoteEstimate ? true : rawEstimate !== remoteEstimate && estimateObservedAt > remoteEstimateAt),
          );
          if (shouldPushTitle || shouldPushEstimate) {
            const localTitleWins = Boolean(
              chosenTitle &&
              (!remoteTitle || chosenTitle === remoteTitle || chosenTitleObservedAt > remoteTitleAt),
            );
            const finalTitle = localTitleWins ? chosenTitle : remoteTitle;
            const finalTitleAt = localTitleWins
              ? (chosenTitle === remoteTitle && remoteTitleAt > 0
                  ? Math.min(remoteTitleAt, chosenTitleObservedAt)
                  : chosenTitleObservedAt)
              : remoteTitleAt;
            const localEstimateWins = Boolean(
              rawEstimate &&
              estimateObservedAt > 0 &&
              (!remoteEstimate || rawEstimate === remoteEstimate || estimateObservedAt > remoteEstimateAt),
            );
            const finalEstimate = localEstimateWins ? rawEstimate : remoteEstimate;
            const finalEstimateAt = localEstimateWins
              ? (rawEstimate === remoteEstimate && remoteEstimateAt > 0
                  ? Math.min(remoteEstimateAt, estimateObservedAt)
                  : estimateObservedAt)
              : remoteEstimateAt;
            const mergedAnchorAt = remoteLifecycleMatches && remoteAnchor > 0 ? Math.min(remoteAnchor, anchorAt) : anchorAt;
            const mergedTerminalAt = remoteLifecycleMatches ? Math.max(remoteTerminal, terminalAt) : terminalAt;
            const metaPayload: Record<string, unknown> = {
              waybill,
              anchorAt: mergedAnchorAt,
              ...(mergedTerminalAt > 0 ? { terminalAt: mergedTerminalAt } : {}),
              ...(finalTitle
                ? {
                    productName: finalTitle,
                    ...(session.expressTitleClockSupported && finalTitleAt > 0
                      ? { productNameObservedAt: finalTitleAt }
                      : {}),
                  }
                : {}),
              ...(finalEstimate && finalEstimateAt > 0
                ? {
                    deliveryEstimate: finalEstimate,
                    deliveryEstimateObservedAt: finalEstimateAt,
                  }
                : {}),
            };
            enqueueEdit(
              metaId,
              "express_metadata",
              "active",
              0,
              metaPayload,
              Math.max(finalTitleAt, finalEstimateAt, anchorAt),
            );
          } else {
            delete nextEdits[metaId];
          }
        }
      }

      // `express_note`
      const localNote = (shipment.note || "").trim();
      const existingNote = remoteNoteByWaybill.get(waybill);
      if (localNote) {
        const noteId = existingNote?.recordId ?? parcelDetailRecordId("parcel-note:", waybill);
        enqueueEdit(
          noteId,
          "express_note",
          "active",
          0,
          {
            subject: `waybill:${waybill}`,
            waybill,
            note: localNote,
            anchorAt,
            ...(terminalAt > 0 ? { terminalAt } : {}),
            status,
          },
          Math.min(now, Math.max(anchorAt, shipment.updatedAtMs || anchorAt)),
        );
      } else if (existingNote && !existingNote.deleted && nextSynced[existingNote.recordId]) {
        enqueueEdit(existingNote.recordId, "express_note", "active", 0, undefined, now, true);
      }

      // Waybill-backed `parcel_pickup`
      if (shipment.pickup && shipment.pickup.code.trim() && shipment.pickup.capturedAtMs > 0) {
        const existingPickup = remoteWaybillPickupByWaybill.get(waybill);
        const pickupId = existingPickup?.recordId ?? parcelDetailRecordId("parcel-waybill-pickup:", `${waybill}:${shipment.pickup.capturedAtMs}`);
        const capturedAt = Math.min(now, shipment.pickup.capturedAtMs);
        const completedAt = shipment.pickup.completedAtMs && shipment.pickup.completedAtMs > 0
          ? Math.min(now, shipment.pickup.completedAtMs)
          : status === "COMPLETED" || shipment.forcedCompletedAtMs
            ? Math.min(now, terminalAt || now)
            : 0;
        const location = [shipment.pickup.locationName, shipment.pickup.address].filter(Boolean).join(" ").trim();
        const brand = shipment.pickup.platform ? platformToStandaloneBrand(shipment.pickup.platform) : undefined;
        const remotePickupHasNote = Boolean(
          existingPickup && !existingPickup.deleted && Object.hasOwn(existingPickup.payload ?? {}, "note"),
        );
        const pickupNoteField = localNote ? localNote : remotePickupHasNote ? "" : undefined;
        enqueueEdit(
          pickupId,
          "parcel_pickup",
          completedAt > 0 ? "history" : "active",
          completedAt > 0 ? capturedAt : 0,
          {
            waybill,
            ...(brand ? { brandId: brand } : {}),
            code: shipment.pickup.code.trim().slice(0, 256),
            ...(location ? { location: location.slice(0, 512) } : {}),
            capturedAt,
            ...(completedAt > 0 ? { completedAt } : {}),
            ...(pickupNoteField !== undefined ? { note: pickupNoteField } : {}),
          },
          Math.max(capturedAt, completedAt, shipment.updatedAtMs || capturedAt),
        );
      }
    }

    // 6b. Outbound `cloudPddTombstones` against cloud-imported `express` records (only rows created from cloud import)
    for (const tombstone of finalAppState.cloudPddTombstones ?? []) {
      const targetWaybill = normalizeWaybill(tombstone.waybill);
      const existingExpress = remoteExpressByWaybill.get(targetWaybill);
      if (!existingExpress || existingExpress.deleted) continue;
      const remoteAnchor = cloudTime(existingExpress.payload?.createdAt, now) || cloudTime(existingExpress.payload?.eventAt, now);
      if (
        tombstone.anchorAt > 0 &&
        remoteAnchor > 0 &&
        Math.abs(remoteAnchor - tombstone.anchorAt) >= WAYBILL_REUSE_MIN_GAP_MS
      ) {
        continue;
      }
      if (tombstone.action === "deleted" && tombstone.actedAtMs >= existingExpress.editedAt) {
        const stillOwnedLocally = finalAppState.shipments.some(
          (row) => !unprojectedAccountOrder(row) && normalizeWaybill(displayWaybill(row)) === targetWaybill,
        );
        if (stillOwnedLocally) continue;
        enqueueEdit(existingExpress.recordId, "express", existingExpress.lifecycle, existingExpress.historyAt, undefined, tombstone.actedAtMs, true);
      } else if (
        tombstone.action === "completed" &&
        existingExpress.lifecycle === "active" &&
        tombstone.actedAtMs >= existingExpress.editedAt
      ) {
        const completedAt = Math.min(now, Math.max(1, tombstone.actedAtMs));
        enqueueEdit(
          existingExpress.recordId,
          "express",
          "history",
          completedAt,
          {
            ...existingExpress.payload,
            status: "COMPLETED",
            completedAt,
            updatedAt: Math.max(completedAt, cloudTime(existingExpress.payload?.updatedAt, now)),
          },
          completedAt,
        );
      }
    }

    // 6c. Outbound standalone `parcel_pickup` & `parcel_handoff` (+ user deletions)
    const activeLocalCodeIds = new Set<string>();
    for (const record of finalAppState.pickupCodeRecords ?? []) {
      activeLocalCodeIds.add(record.id);
      const code = record.code.trim();
      if (!code || record.capturedAtMs <= 0) continue;
      const capturedAt = Math.min(now, Math.trunc(record.capturedAtMs));
      const existingRemote = remoteCodeByLocalId.get(record.id) ??
        (MEAL_UUID.test(record.id) ? cloudState.remote[record.id] : undefined);
      const recordId = existingRemote?.recordId ??
        (MEAL_UUID.test(record.id) ? record.id : parcelDetailRecordId(`parcel-${record.kind}:`, record.id));
      nextSynced[recordId] = nextSynced[recordId] ?? {
        revision: existingRemote?.revision ?? 0,
        type: record.kind === "pickup" ? "parcel_pickup" : "parcel_handoff",
        localKey: `code:${record.id}`,
        editedAt: existingRemote?.editedAt ?? capturedAt,
      };
      const remoteHasNote = Boolean(existingRemote && !existingRemote.deleted && Object.hasOwn(existingRemote.payload ?? {}, "note"));
      const noteField = record.note !== undefined ? record.note : remoteHasNote ? "" : undefined;
      const syncedSameRevision = Boolean(
        existingRemote && !existingRemote.deleted && previousSynced[recordId]?.revision === existingRemote.revision,
      );

      if (record.kind === "pickup") {
        const completedAt = record.completedAtMs && record.completedAtMs > 0 ? Math.min(now, Math.trunc(record.completedAtMs)) : 0;
        const userEditedAt = record.editedAtMs && record.editedAtMs > 0 ? Math.min(now, Math.trunc(record.editedAtMs)) : 0;
        const location = [record.locationName, record.address].filter(Boolean).join(" ").trim();
        const lifecycle = completedAt > 0 ? "history" : "active";
        const payload: Record<string, unknown> = {
          brandId: platformToStandaloneBrand(record.platform),
          code: code.slice(0, 256),
          ...(location ? { location: location.slice(0, 512) } : {}),
          capturedAt,
          ...(completedAt > 0 ? { completedAt } : {}),
          ...(noteField !== undefined ? { note: noteField } : {}),
        };
        const currentDigest = canonicalWholeRecordDigest("parcel_pickup", lifecycle, payload, now);
        const localChangedSinceSync = Boolean(
          syncedSameRevision &&
          previousSynced[recordId]?.localDigest !== undefined &&
          previousSynced[recordId]!.localDigest !== currentDigest,
        );
        if (!localChangedSinceSync && syncedSameRevision && existingRemote) {
          nextSynced[recordId] = { ...nextSynced[recordId]!, localDigest: currentDigest };
        }
        enqueueEdit(
          recordId,
          "parcel_pickup",
          lifecycle,
          completedAt > 0 ? capturedAt : 0,
          payload,
          localChangedSinceSync
            ? (userEditedAt || now)
            : syncedSameRevision
              ? Math.max(capturedAt, completedAt, userEditedAt, existingRemote?.editedAt ?? 0)
              : Math.max(capturedAt, completedAt, userEditedAt),
        );
      } else {
        const windowEndAt = record.windowEndAtMs && record.windowEndAtMs > 0 ? Math.trunc(record.windowEndAtMs) : 0;
        const windowStartAt = windowEndAt > 0 && record.windowStartAtMs && record.windowStartAtMs > 0
          ? Math.min(windowEndAt, Math.trunc(record.windowStartAtMs))
          : 0;
        const expiresAt = windowEndAt > 0 ? windowEndAt + 3_600_000 : 0;
        const rawCompletedAt = record.completedAtMs && record.completedAtMs > 0 ? Math.min(now, Math.trunc(record.completedAtMs)) : 0;
        const completedAt = rawCompletedAt > 0
          ? (expiresAt > 0 && rawCompletedAt >= expiresAt ? Math.max(1, expiresAt - 1) : rawCompletedAt)
          : 0;
        const userEditedAt = record.editedAtMs && record.editedAtMs > 0 ? Math.min(now, Math.trunc(record.editedAtMs)) : 0;
        const deadline = parcelHandoffDeadline(record);
        const historic = completedAt > 0 || (expiresAt > 0 && expiresAt <= now) || Boolean(deadline !== undefined && deadline <= now && expiresAt > 0);
        const lifecycle = historic ? "history" : "active";
        const payload: Record<string, unknown> = {
          platform: record.platform,
          code: code.slice(0, 256),
          capturedAt,
          ...(windowStartAt > 0 ? { windowStartAt } : {}),
          ...(windowEndAt > 0 ? { windowEndAt } : {}),
          ...(record.windowText ? { windowText: record.windowText.slice(0, 128) } : {}),
          expiresAt,
          ...(completedAt > 0 ? { completedAt } : {}),
          ...(noteField !== undefined ? { note: noteField } : {}),
        };
        const userDigest = canonicalWholeRecordDigest("parcel_handoff", completedAt > 0 ? "history" : "active", payload, now);
        const localChangedSinceSync = Boolean(
          syncedSameRevision &&
          previousSynced[recordId]?.localDigest !== undefined &&
          previousSynced[recordId]!.localDigest !== userDigest,
        );
        if (!localChangedSinceSync && syncedSameRevision && existingRemote) {
          nextSynced[recordId] = { ...nextSynced[recordId]!, localDigest: userDigest };
        }
        const passiveExpiryAt = completedAt === 0 && historic && expiresAt > 0 ? Math.min(now, expiresAt) : 0;
        enqueueEdit(
          recordId,
          "parcel_handoff",
          lifecycle,
          historic ? capturedAt : 0,
          payload,
          localChangedSinceSync
            ? (userEditedAt || now)
            : syncedSameRevision
              ? Math.max(capturedAt, completedAt, userEditedAt, passiveExpiryAt, existingRemote?.editedAt ?? 0)
              : Math.max(capturedAt, completedAt, userEditedAt, passiveExpiryAt),
        );
      }
    }

    // User deletions of previously synced standalone pickup / handoff records
    for (const [recordId, baseline] of Object.entries(cloudState.synced)) {
      if (!baseline.localKey.startsWith("code:")) continue;
      const localId = baseline.localKey.slice("code:".length);
      if (activeLocalCodeIds.has(localId)) continue;
      const cloud = cloudState.remote[recordId];
      if (!cloud || cloud.deleted) continue;
      const remoteCompleted = cloudTime(cloud.payload?.completedAt, now) || cloudTime(cloud.payload?.expiresAt, now);
      if (remoteCompleted > 0 && now - remoteCompleted > RETENTION_CUTOFF_MS) continue;
      enqueueEdit(recordId, cloud.type, cloud.lifecycle, cloud.historyAt, undefined, now, true);
    }

    // 6d. Outbound `express_watch_feedback`
    if (session.expressWatchFeedbackSupported) {
      for (const feedback of finalAppState.watchFeedback ?? []) {
        const waybill = feedback.waybill.trim().toUpperCase();
        if (!WATCH_WAYBILL_PATTERN.test(waybill) || feedback.actedAt <= 0) continue;
        const actedAt = Math.min(now, Math.max(1, Math.trunc(feedback.actedAt)));
        const feedbackId = parcelDetailRecordId("parcel-watch-feedback:", waybill);
        const existingFeedback = cloudState.remote[feedbackId];
        const remoteActedAt = !existingFeedback?.deleted ? cloudTime(existingFeedback?.payload?.actedAt, now) : 0;
        const remoteAction = !existingFeedback?.deleted ? existingFeedback?.payload?.action : undefined;
        if (
          remoteActedAt > actedAt ||
          (remoteActedAt === actedAt && (remoteAction === feedback.action || remoteAction === "deleted"))
        ) {
          delete nextEdits[feedbackId];
          continue;
        }
        enqueueEdit(
          feedbackId,
          "express_watch_feedback",
          "active",
          0,
          {
            waybill,
            ...(MEAL_UUID.test(feedback.watchRecordId) ? { watchRecordId: feedback.watchRecordId } : {}),
            action: feedback.action,
            actedAt,
          },
          actedAt,
        );
      }
    }

    return {
      ...cloudState,
      synced: nextSynced,
      edits: nextEdits,
      pddLinks: nextPddLinks,
      legacyManualTitleCleaned: true,
      ...(Object.keys(nextQuarantined).length ? { quarantined: nextQuarantined } : { quarantined: undefined }),
      ...(Object.keys(nextQuarantineHistory).length ? { quarantineHistory: nextQuarantineHistory } : { quarantineHistory: undefined }),
    };
  });
  if (stateChanged) {
    try {
      requestWidgetReload();
    } catch {
      // Optional widget notification.
    }
  }
  return stateChanged;
}

const deniedUntilByScope = new Map<string, number>();
let inFlight: { scope: string; promise: Promise<void>; rerunRequested: boolean } | undefined;

export function resetParcelCloudDeniedBackoffForTests(): void {
  deniedUntilByScope.clear();
  memoryFallbackStore = { version: 1, scopes: {} };
}

type ParcelSyncOutcome = "succeeded" | "no_changes" | "budget_exhausted" | "lease_held" | "skipped";

async function runParcelCloudSync(scope: string, budgetMs: number): Promise<ParcelSyncOutcome> {
  const now = Date.now();
  if ((deniedUntilByScope.get(scope) ?? 0) > now) return "skipped";
  const lease = acquireRenewingDurableRefreshLease(
    `cloud:parcel:${scope}`,
    Math.max(30_000, budgetMs + 5_000),
    now,
    { flowId: "parcel_cloud_sync", trigger: "foreground" },
  );
  if (!lease) return "lease_held";
  try {
    const deadlineAtMs = Date.now() + budgetMs;
    async function request(
      operation: "session" | "pull" | "mutate",
      body: Record<string, unknown>,
      onConflict?: (response: Readonly<Record<string, unknown>>) => void,
    ): Promise<Record<string, unknown>> {
      if (mealCredentialScope() !== scope || !lease?.isCurrent()) {
        throw new Error("Parcel cloud activation changed");
      }
      const reply = await postGateway(CLOUD_ROOT + operation, body, {
        timeoutMs: REQUEST_TIMEOUT_MS,
        deadlineAtMs,
        onConflict,
      });
      if (mealCredentialScope() !== scope || !lease?.isCurrent()) {
        throw new Error("Parcel cloud activation changed");
      }
      return reply;
    }

    let pulled = false;
    let reconciled = false;
    let processedRecords = false;

    for (let step = 0; step < MAX_STEPS && Date.now() < deadlineAtMs; step++) {
      let state = readParcelCloudState(scope);
      if (!state.session) {
        const session = sessionFromParcelResponse(await request("session", { schemaVersion: 1 }));
        updateParcelCloudState(scope, (current) =>
          current.session ? current : { ...current, session, quarantined: undefined },
        );
        pulled = false;
        reconciled = false;
        continue;
      }
      if (state.batch) {
        const batch = state.batch;
        let conflict: Record<string, unknown> | undefined;
        try {
          const response = await request("mutate", batch as unknown as Record<string, unknown>, (value) => {
            conflict = value;
          });
          updateParcelCloudState(scope, (current) => applyParcelReceipt(current, batch, response, Date.now()));
          processedRecords = true;
        } catch (error) {
          if (conflict && mealCredentialScope() === scope) {
            const recovered = updateParcelCloudState(scope, (current) => recoverParcelConflict(current, batch, conflict!));
            if (recovered.batch?.requestId !== batch.requestId) {
              processedRecords = true;
              pulled = Boolean(recovered.session);
              reconciled = false;
              continue;
            }
          }
          const isRetryableHoldStatus =
            error instanceof GatewayError &&
            (error.status === 401 || error.status === 408 || error.status === 409 || error.status === 429);
          if (!isRetryableHoldStatus && isClockSkewMutationRejection(error) && mealCredentialScope() === scope) {
            updateParcelCloudState(scope, (current) => dropRejectedParcelBatch(current, batch, error, Date.now()));
            throw error;
          }
          if (!isRetryableHoldStatus && isDeterministicParcelMutationRejection(error) && mealCredentialScope() === scope) {
            writeDiagnostic(
              "cloud.sync.failed",
              {
                domain: "parcel_cloud",
                stage: "cloud_record_sync",
                rejectedRecords: 1,
                ...diagnosticErrorDetails(error),
              },
              "warning",
            );
            updateParcelCloudState(scope, (current) => dropRejectedParcelBatch(current, batch, error, Date.now()));
            processedRecords = true;
            continue;
          }
          throw error;
        }
        continue;
      }
      if (!pulled || state.snapshot) {
        let response: Record<string, unknown>;
        let generationConflict = false;
        try {
          response = await request("pull", parcelPullRequest(state), (value) => {
            generationConflict = value.error === "endpoint_generation_conflict";
          });
        } catch (error) {
          if (!generationConflict || mealCredentialScope() !== scope) throw error;
          updateParcelCloudState(scope, (current) =>
            current.batch || current.session?.generation !== state.session?.generation
              ? current
              : { ...current, session: undefined, cursor: null, snapshot: undefined },
          );
          continue;
        }
        updateParcelCloudState(scope, (current) => applyParcelPage(current, state, response));
        processedRecords ||= response.mode === "snapshot" || (Array.isArray(response.records) && response.records.length > 0);
        pulled = response.hasMore === false && response.mode !== "snapshot";
        reconciled = false;
        continue;
      }
      if (!reconciled) {
        const localChanged = reconcileParcelCloudRecordsWithLocal(scope, Date.now());
        processedRecords ||= localChanged;
        reconciled = true;
      }
      state = updateParcelCloudState(scope, (current) => prepareParcelBatch(current, newUuid()));
      if (!state.batch) {
        return processedRecords ? "succeeded" : "no_changes";
      }
    }
    return "budget_exhausted";
  } catch (error) {
    if (
      error instanceof GatewayError &&
      error.status === 403 &&
      (error.gatewayCode === "cloud_metadata_not_granted" || error.gatewayCode === "cloud_sync_disabled")
    ) {
      deniedUntilByScope.set(scope, Date.now() + CLOUD_DENIED_BACKOFF_MS);
      return "skipped";
    }
    throw error;
  } finally {
    lease.release();
  }
}

/**
 * Synchronizes formal-track v2 parcel cloud records asynchronously.
 * Safe to invoke fire-and-forget from UI actions without blocking interaction; coalesces concurrent
 * triggers within the process and queues one trailing pass if new local mutations occurred mid-flight.
 */
export function synchronizeParcelCloudRecords(budgetMs = BUDGET_MS): Promise<void> {
  const scope = mealCredentialScope();
  if (!scope) return Promise.resolve();
  if (inFlight?.scope === scope) {
    inFlight.rerunRequested = true;
    return inFlight.promise;
  }
  const finish = beginDiagnosticOperation("cloud.sync", {
    domain: "parcel_cloud",
    stage: "cloud_record_sync",
  });
  const entry = {
    scope,
    rerunRequested: false,
    promise: Promise.resolve(),
  };
  entry.promise = (async () => {
    let finalOutcome: ParcelSyncOutcome = "no_changes";
    do {
      entry.rerunRequested = false;
      const outcome = await runParcelCloudSync(scope, budgetMs);
      if (outcome === "succeeded") finalOutcome = "succeeded";
      else if (finalOutcome !== "succeeded") finalOutcome = outcome;
      if (outcome === "lease_held" || outcome === "skipped" || outcome === "budget_exhausted") break;
    } while (entry.rerunRequested && mealCredentialScope() === scope);
    if (
      (finalOutcome !== "no_changes" && finalOutcome !== "lease_held" && finalOutcome !== "skipped") ||
      changedSinceLastLogged("parcel.cloud.sync.result", finalOutcome)
    ) {
      finish(finalOutcome);
    } else {
      finish.discard();
    }
  })().catch((error: unknown) => {
    finish("retained", diagnosticErrorDetails(error), "warning");
  }).finally(() => {
    if (inFlight === entry) inFlight = undefined;
  });
  inFlight = entry;
  return entry.promise;
}
