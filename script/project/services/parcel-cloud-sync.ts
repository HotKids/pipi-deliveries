import type {
  AppState,
  ParcelHandoffRecord,
  PickupCodeRecord,
  PickupPlatform,
  Shipment,
  StandaloneParcelPickup,
  StatusSemantic,
  WatchFeedbackRecord,
} from "../models";
import { cloudParcelMetadataForCache } from "./cloud-parcel-metadata";
import { projectedCarrierPresentation } from "./carrier-presentation";
import { gatewayCredentialForLocalCache } from "./credentials";
import { readDurableTextResult, writeDurableText } from "./durable-files";
import { GatewayError, postGateway } from "./gateway";
import { activeWatchScope, internationalShipment } from "./international-records";
import { beginDiagnosticOperation, changedSinceLastLogged, diagnosticErrorDetails } from "./logger";
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
import { matchesParcelMetadataLifecycle, shipmentReuseAnchorAtMs } from "./waybill-reuse";
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

export function readParcelCloudState(scope: string): ParcelCloudSnapshot {
  if (!scope) return emptyParcelCloudSnapshot();
  const raw = readStoreFile().scopes[scope];
  if (!raw || raw.schemaVersion !== 1) return emptyParcelCloudSnapshot();
  return {
    schemaVersion: 1,
    ...(raw.session ? { session: raw.session } : {}),
    cursor: integer(raw.cursor) ? raw.cursor : null,
    ...(raw.snapshot ? { snapshot: raw.snapshot } : {}),
    remote: isPlainObject(raw.remote) ? raw.remote : {},
    synced: isPlainObject(raw.synced) ? raw.synced : {},
    edits: isPlainObject(raw.edits) ? raw.edits : {},
    ...(isPlainObject(raw.pddLinks) ? { pddLinks: raw.pddLinks } : {}),
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
    if (cloud.editedAt >= edit.editedAt || (cloud.deleted && (cloud.reason === "retention" || Boolean(edit.deleted)))) {
      continue;
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
      remote[id] = {
        recordId: id,
        type: mutation.type,
        revision: receipt.revision,
        changedAt: now,
        editedAt,
        lifecycle: mutation.lifecycle ?? "active",
        historyAt: mutation.historyAt ?? 0,
        deleted: false,
        payload: mutation.payload ?? {},
      };
    }
  }
  const synced: Record<string, ParcelSyncedBaseline> = { ...state.synced };
  if (mutation.operation === "delete" || receipt.deleted) {
    delete synced[id];
  } else {
    const existingLocalKey = synced[id]?.localKey || defaultLocalKeyForMutation(mutation);
    synced[id] = {
      revision: receipt.revision,
      type: mutation.type,
      localKey: existingLocalKey,
      editedAt,
      ...(mutation.type === "express_note" && typeof mutation.payload?.note === "string"
        ? { noteText: mutation.payload.note }
        : {}),
    };
  }
  const edits: Record<string, ParcelCloudEdit> = { ...state.edits };
  if (edits[id]?.mutationId === mutation.mutationId) delete edits[id];
  return {
    ...state,
    remote,
    synced,
    edits,
    session: { ...state.session, nextSequence: session.nextSequence },
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

function normalizedEstimateForWire(text: string | undefined): string {
  const cleaned = cleanString(text);
  if (!cleaned) return "";
  if (ESTIMATE_WIRE_PATTERN.test(cleaned)) return cleaned;
  const candidate = cleaned.startsWith("预计") ? cleaned : `预计${cleaned}`;
  const suffixed = candidate.endsWith("送达") || candidate.endsWith("送达。") ? candidate : `${candidate}送达`;
  return ESTIMATE_WIRE_PATTERN.test(suffixed) ? suffixed : "";
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

    const nextSynced: Record<string, ParcelSyncedBaseline> = { ...cloudState.synced };
    const nextPddLinks: Record<string, CloudParcelPddLink> = {};
    const pulledTitles: Array<{ parcel: string; requestedAt: number; title: CloudParcelMetadata }> = [];

    // 1. Inbound `express` & `express_pdd_link`
    const pddParcels: CloudPddParcel[] = [];
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
          pddParcels.push({
            waybill,
            anchorAt,
            terminalAt,
            carrierCode: cleanString(payload.carrierCode),
            phone4: /^\d{4}$/.test(phone) ? phone : "",
          });
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
      const existing = workingState.shipments.find(
        (row) => !unprojectedAccountOrder(row) && normalizeWaybill(displayWaybill(row)) === waybill,
      );
      if (existing) {
        const previousSync = cloudState.synced[envelope.recordId];
        if (
          payload.status === "COMPLETED" &&
          completedAt > 0 &&
          !existing.forcedCompletedAtMs &&
          shipmentPresentationStatus(existing).semantic !== "COMPLETED" &&
          (!previousSync || envelope.revision > previousSync.revision)
        ) {
          workingState = {
            ...workingState,
            shipments: workingState.shipments.map((row) =>
              row.identity.id === existing.identity.id
                ? {
                    ...row,
                    forcedCompletedAtMs: completedAt,
                    settledAtMs: row.settledAtMs ?? completedAt,
                    timeline: {
                      ...row.timeline,
                      semantic: "COMPLETED",
                      structuredStatus: true,
                      statusEventAtMs: completedAt,
                    },
                  }
                : row,
            ),
          };
        }
        continue;
      }
      if (workingState.pendingQueries.some((q) => normalizeWaybill(q.waybill) === waybill)) continue;
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
      const imported = payload.status === "COMPLETED" && completedAt > 0
        ? {
            ...created,
            forcedCompletedAtMs: completedAt,
            settledAtMs: completedAt,
            timeline: { ...created.timeline, semantic: "COMPLETED" as const, structuredStatus: true, statusEventAtMs: completedAt },
          }
        : created;
      workingState = { ...workingState, shipments: [...workingState.shipments, imported] };
    }

    if (pddParcels.length) {
      workingState = applyCloudPddParcels(workingState, pddParcels, now);
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

    if (metadataByWaybill.size) {
      let updatedAny = false;
      const updatedShipments = workingState.shipments.map((shipment) => {
        if (unprojectedAccountOrder(shipment)) return shipment;
        const waybill = normalizeWaybill(displayWaybill(shipment));
        const entry = metadataByWaybill.get(waybill);
        if (!entry) return shipment;
        const matched = cloudParcelMetadataForCache(shipment, entry.meta);
        if (!matched?.productName || !matched.productNameObservedAt) return shipment;
        const fields = shipment.platformFields;
        const generation = shipment.waybillReuseAtMs ?? 0;
        const localEditedAt = fields && fields.waybill === displayWaybill(shipment) && fields.waybillGeneration === generation
          ? (fields.manualTitleEditedAtMs ?? 0)
          : 0;
        const currentShown = fields?.manualTitle || fields?.title?.text || "";
        if (matched.productNameObservedAt <= localEditedAt) return shipment;
        if (currentShown === matched.productName && localEditedAt === matched.productNameObservedAt) return shipment;
        if (!localEditedAt && fields?.title?.text === matched.productName) return shipment;
        updatedAny = true;
        return {
          ...shipment,
          platformFields: {
            ...(fields && fields.waybill === displayWaybill(shipment) && fields.waybillGeneration === generation ? fields : {}),
            waybill: displayWaybill(shipment),
            waybillGeneration: generation,
            manualTitle: matched.productName,
            manualTitleEditedAtMs: matched.productNameObservedAt,
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
        // Do not overwrite an unsynced local note edit unless the remote edit is newer than the shipment's update clock.
        if (previousSync && previousSync.noteText !== undefined && currentNote !== previousSync.noteText && envelope.editedAt < shipment.updatedAtMs) {
          return shipment;
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
          };
        }
        if (remoteNote === currentNote) return shipment;
        noteChanged = true;
        return {
          ...shipment,
          note: remoteNote || undefined,
          updatedAtMs: Math.max(now, shipment.updatedAtMs + 1),
        };
      });
      if (noteChanged) workingState = { ...workingState, shipments: shipmentsWithNotes };
    }

    // 4. Inbound `parcel_pickup` & `parcel_handoff` -> AppState.pickupCodeRecords & Shipment.pickup
    let pickupRecords: PickupCodeRecord[] = [...(workingState.pickupCodeRecords ?? [])];
    let pickupRecordsChanged = false;
    let waybillPickupsChanged = false;
    let shipmentsForPickups = workingState.shipments;

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
          shipmentsForPickups = shipmentsForPickups.map((shipment) => {
            if (unprojectedAccountOrder(shipment) || normalizeWaybill(displayWaybill(shipment)) !== waybill) return shipment;
            if (shipment.pickup && shipment.pickup.capturedAtMs > capturedAt) return shipment;
            const nextPickup = {
              ...(platform ? { platform } : {}),
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
          nextSynced[envelope.recordId] = {
            revision: envelope.revision,
            type: "parcel_pickup",
            localKey: `waybill_pickup:${waybill}`,
            editedAt: envelope.editedAt,
          };
          continue;
        }
        const platform = standaloneBrandToPlatform(payload.brandId);
        if (!platform) continue;
        const location = cleanString(payload.location);
        const matchIndex = pickupRecords.findIndex(
          (item) =>
            item.id === envelope.recordId ||
            (previousSync?.localKey === `code:${item.id}`) ||
            (item.kind === "pickup" && item.platform === platform && item.code === code && Math.abs(item.capturedAtMs - capturedAt) <= 1_000),
        );
        const existingItem = matchIndex >= 0 ? (pickupRecords[matchIndex] as StandaloneParcelPickup) : undefined;
        const localId = existingItem?.id ?? envelope.recordId;
        if (completedAt > 0 && now - completedAt > RETENTION_CUTOFF_MS) {
          nextSynced[envelope.recordId] = {
            revision: envelope.revision,
            type: "parcel_pickup",
            localKey: `code:${localId}`,
            editedAt: envelope.editedAt,
          };
          continue;
        }
        const mergedRecord: StandaloneParcelPickup = {
          id: localId,
          kind: "pickup",
          platform,
          code,
          capturedAtMs: existingItem?.capturedAtMs ?? capturedAt,
          ...(location ? { locationName: location } : existingItem?.locationName ? { locationName: existingItem.locationName } : {}),
          ...(existingItem?.address ? { address: existingItem.address } : {}),
          ...(completedAt > 0
            ? { completedAtMs: completedAt }
            : existingItem?.completedAtMs
              ? { completedAtMs: existingItem.completedAtMs }
              : {}),
          ...(note !== undefined ? (note ? { note } : {}) : existingItem?.note ? { note: existingItem.note } : {}),
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
        };
      } else {
        const platform = payload.platform === "pinduoduo" || payload.platform === "cainiao" ? payload.platform : null;
        if (!platform) continue;
        const windowStartAt = cloudTime(payload.windowStartAt, now + 366 * 86_400_000);
        const windowEndAt = cloudTime(payload.windowEndAt, now + 366 * 86_400_000);
        const expiresAt = windowEndAt > 0 ? windowEndAt + 3_600_000 : 0;
        const windowText = cleanString(payload.windowText);
        const matchIndex = pickupRecords.findIndex(
          (item) =>
            item.id === envelope.recordId ||
            (previousSync?.localKey === `code:${item.id}`) ||
            (item.kind === "handoff" && item.platform === platform && item.code === code && Math.abs(item.capturedAtMs - capturedAt) <= 1_000),
        );
        const existingItem = matchIndex >= 0 ? (pickupRecords[matchIndex] as ParcelHandoffRecord) : undefined;
        const localId = existingItem?.id ?? envelope.recordId;
        const terminalClock = completedAt || (expiresAt > 0 && expiresAt <= now ? expiresAt : 0);
        if (terminalClock > 0 && now - terminalClock > RETENTION_CUTOFF_MS) {
          nextSynced[envelope.recordId] = {
            revision: envelope.revision,
            type: "parcel_handoff",
            localKey: `code:${localId}`,
            editedAt: envelope.editedAt,
          };
          continue;
        }
        const mergedHandoff: ParcelHandoffRecord = {
          id: localId,
          kind: "handoff",
          platform,
          code,
          capturedAtMs: existingItem?.capturedAtMs ?? capturedAt,
          ...(windowStartAt > 0 ? { windowStartAtMs: windowStartAt } : {}),
          ...(windowEndAt > 0 ? { windowEndAtMs: windowEndAt } : {}),
          ...(windowText ? { windowText } : {}),
          ...(existingItem?.providerTitle ? { providerTitle: existingItem.providerTitle } : {}),
          ...(completedAt > 0
            ? { completedAtMs: completedAt }
            : existingItem?.completedAtMs
              ? { completedAtMs: existingItem.completedAtMs }
              : {}),
          ...(expiresAt > 0 && expiresAt <= now && !completedAt
            ? { expiredAtMs: expiresAt }
            : existingItem?.expiredAtMs
              ? { expiredAtMs: existingItem.expiredAtMs }
              : {}),
          ...(note !== undefined ? (note ? { note } : {}) : existingItem?.note ? { note: existingItem.note } : {}),
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
        if (!cloud || cloud.deleted) return;
        const effectiveEditedAt = Math.max(editedAt, cloud.editedAt + 1);
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
      if (
        cloud &&
        !cloud.deleted &&
        cloud.type === type &&
        cloud.lifecycle === lifecycle &&
        cloud.historyAt === historyAt &&
        stablePayloadDigest(cloud.payload) === stablePayloadDigest(payload)
      ) {
        delete nextEdits[recordId];
        return;
      }
      const effectiveEditedAt = cloud ? Math.max(editedAt, cloud.editedAt + 1) : Math.max(1, editedAt);
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
          const recordId = existingExpress?.recordId ?? parcelDetailRecordId("parcel-express-pdd:", `${waybill}:${anchorAt}`);
          const completed = status === "COMPLETED" || status === "CANCELLED" || Boolean(shipment.forcedCompletedAtMs);
          const completedAt = completed ? (terminalAt || anchorAt) : 0;
          const eventAt = Math.min(now, Math.max(anchorAt, timelineLatestEventAt(shipment.timeline) || anchorAt));
          const createdAt = Math.min(now, shipment.identity.createdAtMs > 0 ? shipment.identity.createdAtMs : anchorAt);
          const updatedAt = Math.min(now, Math.max(createdAt, shipment.updatedAtMs || eventAt));
          const tail = shipmentDetailPhoneTail(shipment) || shipment.identity.phone || "";
          const phone4 = /^\d{4}$/.test(tail) ? tail : "";
          const pickupValid = shipment.pickup && shipment.pickup.code.trim() && shipment.pickup.capturedAtMs > 0;
          const payload: Record<string, unknown> = {
            waybill,
            carrierCode: (shipment.identity.courierCode || "").slice(0, 32),
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
          const existingShippingId = cleanString(existingLink?.payload?.shippingId);
          const mergedShippingId = shippingId || (SHIPPING_ID_PATTERN.test(existingShippingId) ? existingShippingId : "");
          const observedAt = Math.min(now, Math.max(anchorAt, shipment.updatedAtMs || now));
          enqueueEdit(
            linkRecordId,
            "express_pdd_link",
            "active",
            0,
            {
              waybill,
              anchorAt,
              terminalAt,
              shippingId: mergedShippingId,
              observedAt,
            },
            observedAt,
          );
        }
      }

      // `express_metadata` (productName + deliveryEstimate, NEVER productImageUrl)
      const fields = shipment.platformFields;
      const fieldsMatch = fields && fields.waybill === displayWaybill(shipment) && fields.waybillGeneration === (shipment.waybillReuseAtMs ?? 0);
      const manualTitle = fieldsMatch ? productTitle(fields.manualTitle) : "";
      const platformTitle = fieldsMatch && !internationalShipment(shipment) ? productTitle(fields.title?.text) : "";
      const chosenTitle = manualTitle || platformTitle;
      const chosenTitleObservedAt = manualTitle
        ? Math.min(now, Math.max(1, fields!.manualTitleEditedAtMs || shipment.updatedAtMs || now))
        : platformTitle
          ? Math.min(now, Math.max(1, shipment.updatedAtMs || anchorAt))
          : 0;
      const rawEstimate = fieldsMatch && !internationalShipment(shipment) && deliveryEstimateApplies(shipment)
        ? normalizedEstimateForWire(fields.estimate?.text)
        : "";
      const estimateObservedAt = rawEstimate && fields?.estimate?.capturedAtMs
        ? Math.min(now, Math.max(1, fields.estimate.capturedAtMs))
        : 0;

      if (chosenTitle || (rawEstimate && estimateObservedAt > 0)) {
        const metaId = parcelDetailRecordId("parcel-metadata:", waybill);
        const existingMeta = cloudState.remote[metaId];
        const remotePayload = !existingMeta?.deleted ? existingMeta?.payload : undefined;
        const remoteLifecycleMatches = remotePayload
          ? matchesParcelMetadataLifecycle(
              shipment,
              cloudTime(remotePayload.anchorAt, now),
              cloudTime(remotePayload.terminalAt, now),
              now,
            )
          : false;
        const remoteTitle = remoteLifecycleMatches ? productTitle(remotePayload?.productName) : "";
        const remoteTitleAt = remoteLifecycleMatches ? cloudTime(remotePayload?.productNameObservedAt, now) : 0;
        const remoteEstimate = remoteLifecycleMatches ? normalizedEstimateForWire(cleanString(remotePayload?.deliveryEstimate)) : "";
        const remoteEstimateAt = remoteLifecycleMatches ? cloudTime(remotePayload?.deliveryEstimateObservedAt, now) : 0;

        const shouldPushTitle = Boolean(
          chosenTitle &&
          (chosenTitle !== remoteTitle || (session.expressTitleClockSupported && chosenTitleObservedAt > remoteTitleAt && !remoteTitleAt)) &&
          chosenTitleObservedAt >= remoteTitleAt,
        );
        const shouldPushEstimate = Boolean(
          rawEstimate &&
          estimateObservedAt > 0 &&
          rawEstimate !== remoteEstimate &&
          estimateObservedAt >= remoteEstimateAt,
        );
        if (shouldPushTitle || shouldPushEstimate) {
          const finalTitle = chosenTitleObservedAt >= remoteTitleAt ? chosenTitle : remoteTitle;
          const finalTitleAt = chosenTitleObservedAt >= remoteTitleAt ? chosenTitleObservedAt : remoteTitleAt;
          const finalEstimate = estimateObservedAt >= remoteEstimateAt ? rawEstimate : remoteEstimate;
          const finalEstimateAt = estimateObservedAt >= remoteEstimateAt ? estimateObservedAt : remoteEstimateAt;
          const metaPayload: Record<string, unknown> = {
            waybill,
            anchorAt,
            ...(terminalAt > 0 ? { terminalAt } : {}),
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
            Math.max(finalTitleAt, finalEstimateAt, shipment.updatedAtMs || now),
          );
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
          Math.min(now, Math.max(anchorAt, shipment.updatedAtMs || now)),
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
            ...(localNote ? { note: localNote } : {}),
          },
          Math.max(capturedAt, completedAt, shipment.updatedAtMs || now),
        );
      }
    }

    // 6b. Outbound `cloudPddTombstones` against cloud PDD `express` records
    for (const tombstone of finalAppState.cloudPddTombstones ?? []) {
      const existingExpress = remoteExpressByWaybill.get(normalizeWaybill(tombstone.waybill));
      if (!existingExpress || existingExpress.deleted || existingExpress.payload?.importOrigin !== "pdd") continue;
      const remoteAnchor = cloudTime(existingExpress.payload.createdAt, now) || cloudTime(existingExpress.payload.eventAt, now);
      if (
        tombstone.anchorAt > 0 &&
        remoteAnchor > 0 &&
        Math.abs(remoteAnchor - tombstone.anchorAt) >= 24 * 3_600_000
      ) {
        continue;
      }
      if (tombstone.action === "deleted" && tombstone.actedAtMs >= existingExpress.editedAt) {
        enqueueEdit(existingExpress.recordId, "express", existingExpress.lifecycle, existingExpress.historyAt, undefined, tombstone.actedAtMs, true);
      } else if (tombstone.action === "completed" && existingExpress.lifecycle === "active") {
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
            updatedAt: Math.max(completedAt, cloudTime(existingExpress.payload.updatedAt, now)),
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

      if (record.kind === "pickup") {
        const completedAt = record.completedAtMs && record.completedAtMs > 0 ? Math.min(now, Math.trunc(record.completedAtMs)) : 0;
        const location = [record.locationName, record.address].filter(Boolean).join(" ").trim();
        enqueueEdit(
          recordId,
          "parcel_pickup",
          completedAt > 0 ? "history" : "active",
          completedAt > 0 ? capturedAt : 0,
          {
            brandId: platformToStandaloneBrand(record.platform),
            code: code.slice(0, 256),
            ...(location ? { location: location.slice(0, 512) } : {}),
            capturedAt,
            ...(completedAt > 0 ? { completedAt } : {}),
            ...(noteField !== undefined ? { note: noteField } : {}),
          },
          Math.max(capturedAt, completedAt),
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
        const deadline = parcelHandoffDeadline(record);
        const historic = completedAt > 0 || (expiresAt > 0 && expiresAt <= now) || Boolean(deadline !== undefined && deadline <= now && expiresAt > 0);
        enqueueEdit(
          recordId,
          "parcel_handoff",
          historic ? "history" : "active",
          historic ? capturedAt : 0,
          {
            platform: record.platform,
            code: code.slice(0, 256),
            capturedAt,
            ...(windowStartAt > 0 ? { windowStartAt } : {}),
            ...(windowEndAt > 0 ? { windowEndAt } : {}),
            ...(record.windowText ? { windowText: record.windowText.slice(0, 128) } : {}),
            expiresAt,
            ...(completedAt > 0 ? { completedAt } : {}),
            ...(noteField !== undefined ? { note: noteField } : {}),
          },
          Math.max(capturedAt, completedAt),
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
        updateParcelCloudState(scope, (current) => (current.session ? current : { ...current, session }));
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
          if (!conflict || mealCredentialScope() !== scope) throw error;
          const recovered = updateParcelCloudState(scope, (current) => recoverParcelConflict(current, batch, conflict!));
          if (recovered.batch?.requestId === batch.requestId) throw error;
          processedRecords = true;
          pulled = Boolean(recovered.session);
          reconciled = false;
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
