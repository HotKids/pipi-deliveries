import { publishSharedMealState, sharedData, sharedMealStateText, withSharedFileTransaction } from "../shared-file-transaction";
import type { MealTemperature, PickupVisualStyle } from "./pickup-artwork";

export const MEAL_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HISTORY_MS = 90 * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 512;

export type MealPayload = {
  brandId: string;
  brandName?: string;
  code?: string;
  merchantName?: string;
  productName?: string;
  status?: string;
  waitTime?: string;
  itemCount?: number;
  totalAmount?: string;
  drinkTemperature?: MealTemperature;
  qrPayload?: string;
  createdAt: number;
  expiresAt: number;
  completedAt?: number;
};
export type MealObservation = { payload: MealPayload; artwork: PickupVisualStyle };
export type MealEnvelope = {
  recordId: string;
  type: "meal_pickup";
  revision: number;
  changedAt: number;
  editedAt: number;
} & (
  | { deleted: true; lifecycle: "active" | "history"; historyAt: number; reason: "user" | "retention" }
  | { deleted: false; lifecycle: "active" | "history"; historyAt: number; payload: MealPayload }
);

export type MealEdit = { mutationId: string; editedAt: number; payload: MealPayload; requiresExisting?: true };
export type MealMutation = {
  mutationId: string;
  recordId: string;
  editedAt: number;
  baseRevision: number;
  operation: "put" | "restore";
  type: "meal_pickup";
  lifecycle: "active" | "history";
  historyAt: number;
  payload: MealPayload;
};
export type MealBatch = {
  schemaVersion: 1;
  generation: number;
  epoch: string;
  sequence: number;
  requestId: string;
  includeMealOrderMetadata: true;
  includeMealTemperature?: true;
  mutations: [MealMutation];
};
export type MealSession = { ownerId: string; endpointId: string; generation: number; epoch: string; nextSequence: number;
  mealTemperatureSupported?: true };
export type MealSnapshot = {
  session?: MealSession;
  cursor: number | null;
  // The snapshot is committed as a unit. Its cursor is the start of the following delta.
  snapshot?: { epoch: string; cursor: number; token: string; records: Record<string, MealEnvelope>; includeMealTemperature?: true };
  mealTemperatureProjected?: true;
  remote: Record<string, MealEnvelope>;
  edits: Record<string, MealEdit>;
  style: Record<string, PickupVisualStyle>;
  batch?: MealBatch;
  luckinDraft?: MealObservation;
};
type MealPartitions = Record<string, MealSnapshot>;

let readCache: { ref: string; data: MealPartitions } | undefined;

export function mealRevision(): string { return sharedData().mealStateRef ?? ""; }

function partitions(): MealPartitions {
  const ref = mealRevision();
  if (!ref) return {};
  if (readCache?.ref === ref) return readCache.data;
  const text = sharedMealStateText();
  if (!text) throw new Error("Missing meal state");
  const value = JSON.parse(text);
  if (value?.schema !== 1 || !value.partitions || typeof value.partitions !== "object") {
    throw new Error("Invalid meal state");
  }
  readCache = { ref, data: value.partitions };
  return readCache.data;
}

const EMPTY: MealSnapshot = { cursor: null, remote: {}, edits: {}, style: {} };
export function readMeals(scope: string): MealSnapshot {
  return scope ? withSharedFileTransaction(() => partitions()[scope] ?? EMPTY) : EMPTY;
}

export function updateMeals(scope: string, edit: (snapshot: MealSnapshot) => MealSnapshot): MealSnapshot {
  return withSharedFileTransaction(() => {
    const stored = partitions();
    const current = stored[scope] ?? EMPTY;
    const next = edit(current);
    if (next !== current) {
      publishSharedMealState(JSON.stringify({ schema: 1, partitions: { ...stored, [scope]: next } }));
    }
    return next;
  });
}

const LUCKIN_DRAFT_AGE_MS = 2 * 60 * 1000;

export function stageLuckinDraft(scope: string, draft: MealObservation): void {
  updateMeals(scope, state => state.luckinDraft && state.luckinDraft.payload.createdAt > draft.payload.createdAt
    ? state : { ...state, luckinDraft: draft });
}

export function mergeLuckinDraft(entry: MealObservation, draft: MealObservation | undefined): MealObservation {
  const credential = entry.payload;
  if (credential.brandId !== "ruixing" || !credential.code || !credential.qrPayload ||
      !draft || credential.createdAt < draft.payload.createdAt ||
      credential.createdAt - draft.payload.createdAt > LUCKIN_DRAFT_AGE_MS) return entry;
  const first = draft.payload;
  return { payload: {
    ...credential, merchantName: first.merchantName || credential.merchantName,
    productName: first.productName || credential.productName, status: first.status || credential.status,
    waitTime: first.waitTime || credential.waitTime, itemCount: first.itemCount || credential.itemCount,
    totalAmount: first.totalAmount || credential.totalAmount,
    drinkTemperature: first.drinkTemperature ?? draft.artwork.drinkTemperature,
  }, artwork: draft.artwork };
}

export function putMealObservations(scope: string, entries: readonly MealObservation[], local: boolean): string[] {
  const ids = entries.map(() => ({ id: UUID.string().toLowerCase(), mutationId: UUID.string().toLowerCase() }));
  updateMeals(scope, state => {
    const edits = { ...state.edits }, style = { ...state.style };
    let draft = state.luckinDraft;
    for (const [index, incoming] of entries.entries()) {
      const entry = local ? mergeLuckinDraft(incoming, draft) : incoming;
      if (local && incoming.payload.brandId === "ruixing" &&
          (!draft || incoming.payload.createdAt >= draft.payload.createdAt)) draft = undefined;
      const { id, mutationId } = ids[index];
      edits[id] = { mutationId, editedAt: entry.payload.createdAt, payload: entry.payload };
      style[id] = entry.artwork;
    }
    return { ...state, edits, style, luckinDraft: draft };
  });
  return ids.map(({ id }) => id);
}

export function currentMeal(state: MealSnapshot, id: string, now = Date.now()): MealPayload | undefined {
  const pending = state.edits[id]?.payload;
  const remote = state.remote[id];
  const value = pending ?? (remote?.deleted === false && remote.lifecycle === "active" ? remote.payload : undefined);
  return value && !value.completedAt && value.expiresAt > now ? value : undefined;
}

export function completeMeal(scope: string, id: string, now = Date.now()): boolean {
  const mutationId = UUID.string().toLowerCase();
  let completed = false;
  updateMeals(scope, state => {
    const payload = currentMeal(state, id, now);
    completed = Boolean(payload);
    if (!payload) return state;
    const pending = state.edits[id];
    const edits = { ...state.edits, [id]: {
      mutationId, editedAt: now, payload: { ...payload, completedAt: now },
      ...(!pending || pending.requiresExisting ? { requiresExisting: true as const } : {}),
    } };
    return { ...state, edits };
  });
  return completed;
}

export function pruneMeals(state: MealSnapshot, now: number): MealSnapshot {
  const keepInFlight = state.batch?.mutations[0].recordId;
  const cutoff = now - HISTORY_MS;
  const history = Object.entries(state.edits).filter(([, edit]) => edit.payload.completedAt || edit.payload.expiresAt <= now)
    .sort(([, a], [, b]) => b.payload.createdAt - a.payload.createdAt);
  const removal = history.filter(([id, item], index) =>
    id !== keepInFlight && (index >= HISTORY_LIMIT || item.payload.createdAt < cutoff));
  const draft = state.luckinDraft && now - state.luckinDraft.payload.createdAt <= LUCKIN_DRAFT_AGE_MS
    ? state.luckinDraft : undefined;
  const obsolete = Object.entries(state.remote).filter(([id, record]) =>
    id !== keepInFlight && !state.edits[id] && (record.deleted ||
      record.lifecycle === "history" && record.historyAt < cutoff));
  if (!removal.length && !obsolete.length && state.luckinDraft === draft) return state;
  const edits = { ...state.edits }, style = { ...state.style }, remote = { ...state.remote };
  for (const [id] of removal) { delete edits[id]; delete style[id]; }
  for (const [id] of obsolete) { delete remote[id]; delete style[id]; }
  return { ...state, edits, style, remote, luckinDraft: draft };
}
