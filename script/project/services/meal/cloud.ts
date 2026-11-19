import { asPlainObject, isPlainObject } from "../value-guards";
import { postGateway } from "../gateway";
import { writeDiagnostic } from "../logger";
import { MEAL_UUID, pruneMeals, readMeals, updateMeals, type MealBatch, type MealEnvelope,
  type MealPayload, type MealSession, type MealSnapshot } from "./records";
import { mealCredentialScope } from "./rules";

const CLOUD_ROOT = "/api/cloud-records/scripting-meals/";
const MAX_STEPS = 12;
const BUDGET_MS = 15000;
const REQUEST_TIMEOUT_MS = 5000;

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && MEAL_UUID.test(value);
}
function sessionFrom(value: Record<string, unknown>): MealSession {
  if (value.ok !== true || value.schemaVersion !== 1 || value.enabled !== true ||
      typeof value.ownerId !== "string" || !/^[0-9a-f]{64}$/.test(value.ownerId) ||
      typeof value.endpointId !== "string" || !/^scripting-meal:[0-9a-f]{64}$/.test(value.endpointId) ||
      !integer(value.generation, 1) || !uuid(value.epoch) || !integer(value.nextSequence, 1)) {
    throw new Error("Invalid meal sync session");
  }
  return { ownerId: value.ownerId, endpointId: value.endpointId, generation: value.generation,
    epoch: value.epoch, nextSequence: value.nextSequence };
}

function validPayload(payload: Record<string, unknown>): payload is MealPayload {
  return typeof payload.brandId === "string" && Boolean(payload.brandId.trim()) &&
    (typeof payload.code === "string" && Boolean(payload.code.trim()) ||
      typeof payload.qrPayload === "string" && Boolean(payload.qrPayload.trim())) &&
    integer(payload.createdAt, 1) && integer(payload.expiresAt, payload.createdAt) &&
    (payload.completedAt === undefined || integer(payload.completedAt));
}

function envelope(value: unknown): MealEnvelope {
  const item = asPlainObject(value);
  if (!item || item.type !== "meal_pickup" || !uuid(item.recordId) ||
      !integer(item.revision, 1) || !integer(item.changedAt, 1) || !integer(item.editedAt) ||
      (item.lifecycle !== "active" && item.lifecycle !== "history") ||
      !integer(item.historyAt) || (item.lifecycle === "active" ? item.historyAt !== 0 : item.historyAt === 0)) {
    throw new Error("Invalid meal sync record");
  }
  if (!(item.deleted === false && isPlainObject(item.payload) && validPayload(item.payload) ||
      item.deleted === true && item.payload === undefined && (item.reason === "retention" || item.reason === "user"))) {
    throw new Error("Invalid meal sync payload");
  }
  return item as MealEnvelope;
}

function sameEndpoint(a: MealSession, b: MealSession): boolean {
  return a.ownerId === b.ownerId && a.endpointId === b.endpointId && a.generation === b.generation;
}

export function mealPullRequest(state: MealSnapshot) {
  return {
    schemaVersion: 1, generation: state.session!.generation,
    epoch: state.snapshot?.epoch ?? (state.cursor !== null ? state.session!.epoch : ""),
    cursor: state.snapshot?.cursor ?? state.cursor ?? 0,
    ...(state.snapshot ? { pageToken: state.snapshot.token } : {}),
    includeEditTime: true, includeMealOrderMetadata: true,
  };
}

export function applyMealPage(current: MealSnapshot, expected: MealSnapshot, response: Record<string, unknown>): MealSnapshot {
  const previous = expected.session!;
  if (!current.session || !sameEndpoint(current.session, previous) || current.cursor !== expected.cursor ||
      current.session.epoch !== previous.epoch || current.snapshot?.token !== expected.snapshot?.token) return current;
  const session = sessionFrom(response);
  if (!sameEndpoint(session, previous) || !integer(response.cursor) || !Array.isArray(response.records) ||
      response.records.length > 100 || typeof response.hasMore !== "boolean") throw new Error("Invalid meal sync page");
  const snapshot = response.mode === "snapshot" && response.reset === true;
  if (!snapshot && (response.mode !== "delta" || response.reset !== false || previous.epoch !== session.epoch ||
      expected.snapshot || response.cursor < (expected.cursor ?? 0) || response.hasMore && response.cursor === expected.cursor)) {
    throw new Error("Invalid meal sync cursor");
  }
  const continuation = snapshot && expected.snapshot?.epoch === session.epoch ? expected.snapshot : undefined;
  if (continuation && (continuation.cursor !== response.cursor || continuation.token === response.pageToken)) {
    throw new Error("Invalid meal snapshot continuation");
  }
  const remote = { ...(snapshot ? continuation?.records : current.remote) };
  for (const value of response.records) {
    const row = envelope(value);
    if (!snapshot && row.revision > response.cursor) throw new Error("Invalid meal revision");
    if (!remote[row.recordId] || row.revision >= remote[row.recordId].revision) remote[row.recordId] = row;
  }
  if (snapshot && response.hasMore) {
    if (typeof response.pageToken !== "string" || !response.pageToken || response.pageToken.length > 2048) {
      throw new Error("Missing meal snapshot continuation");
    }
    return { ...current, snapshot: { epoch: session.epoch, cursor: response.cursor, token: response.pageToken, records: remote } };
  }
  if (response.pageToken != null) throw new Error("Unexpected meal continuation");
  return reconcileMealEdits({ ...current, session: { ...session, nextSequence: Math.max(current.session.nextSequence, session.nextSequence) },
    remote, snapshot: undefined, cursor: response.cursor }, current, snapshot);
}

function reconcileMealEdits(state: MealSnapshot, previous: MealSnapshot, completeSnapshot = false): MealSnapshot {
  const edits = { ...state.edits };
  const currentBatch = state.batch?.mutations[0].mutationId;
  for (const [id, edit] of Object.entries(edits)) {
    if (edit.mutationId === currentBatch) continue;
    const cloud = state.remote[id];
    if (cloud ? cloud.editedAt >= edit.editedAt || cloud.deleted && cloud.reason === "retention" :
      completeSnapshot && edit.requiresExisting) delete edits[id];
  }
  const style = Object.fromEntries(Object.entries(state.style).filter(([id]) => {
    const cloud = state.remote[id];
    const before = previous.remote[id];
    const current = edits[id]?.payload ?? (cloud?.deleted === false ? cloud.payload : undefined);
    const prior = previous.edits[id]?.payload ?? (before?.deleted === false ? before.payload : undefined);
    return current && (!prior || (prior.brandId === current.brandId && prior.productName === current.productName));
  }));
  return { ...state, edits, style };
}

export function prepareMealBatch(state: MealSnapshot, now: number, requestId: string): MealSnapshot {
  if (state.batch || state.snapshot || !state.session) return state;
  const [selected] = Object.entries(state.edits);
  if (!selected) return state;
  const [id, edit] = selected;
  const cloud = state.remote[id];
  const historic = edit.payload.expiresAt <= now || Boolean(edit.payload.completedAt);
  const batch: MealBatch = {
    schemaVersion: 1, generation: state.session.generation, epoch: state.session.epoch,
    sequence: state.session.nextSequence, requestId, includeMealOrderMetadata: true,
    mutations: [{
      mutationId: edit.mutationId, recordId: id, baseRevision: cloud?.revision ?? 0,
      type: "meal_pickup", operation: cloud?.deleted ? "restore" : "put",
      lifecycle: historic ? "history" : "active", historyAt: historic ? edit.payload.createdAt : 0,
      editedAt: edit.editedAt, payload: edit.payload,
    }],
  };
  return { ...state, batch };
}

export function applyMealReceipt(state: MealSnapshot, batch: MealBatch, response: Record<string, unknown>): MealSnapshot {
  if (state.batch?.requestId !== batch.requestId || !state.session) return state;
  const session = sessionFrom(response);
  const mutation = batch.mutations[0];
  const receipt = Array.isArray(response.results) && response.results.length === 1 ? asPlainObject(response.results[0]) : null;
  if (!receipt || !sameEndpoint(session, state.session) || response.sequence !== batch.sequence ||
      session.nextSequence !== batch.sequence + 1 || receipt.recordId !== mutation.recordId ||
      receipt.mutationId !== mutation.mutationId || !integer(receipt.revision, 1) ||
      !integer(receipt.editedAt) || typeof receipt.deleted !== "boolean") throw new Error("Invalid meal sync receipt");
  const { recordId: id, payload, lifecycle, historyAt } = mutation;
  const remote = { ...state.remote };
  if (!remote[id] || remote[id].revision < receipt.revision) {
    const common = { recordId: id, type: "meal_pickup" as const, revision: receipt.revision, changedAt: Date.now(),
      editedAt: receipt.editedAt, lifecycle, historyAt };
    remote[id] = receipt.deleted ? { ...common, deleted: true, reason: "retention" } : { ...common, deleted: false, payload };
  }
  const edits = { ...state.edits };
  if (edits[id]?.mutationId === mutation.mutationId) delete edits[id];
  // Preserve the durable pull cursor. The receipt cannot acknowledge unrelated records.
  return { ...state, remote, edits, session: { ...state.session, nextSequence: session.nextSequence }, batch: undefined };
}

export function recoverMealConflict(state: MealSnapshot, batch: MealBatch, conflict: Record<string, unknown>): MealSnapshot {
  if (state.batch?.requestId !== batch.requestId || !state.session ||
      conflict.requestId !== batch.requestId || conflict.sequence !== batch.sequence ||
      conflict.requestGeneration !== batch.generation || conflict.ownerId !== state.session.ownerId ||
      conflict.endpointId !== state.session.endpointId) return state;
  const mutation = batch.mutations[0];
  const id = mutation.recordId;
  if (conflict.error === "revision_conflict" && conflict.mutationOutcome === "not_committed" &&
      Array.isArray(conflict.conflicts) && conflict.conflicts.length === 1) {
    const item = asPlainObject(conflict.conflicts[0]);
    if (item?.recordId !== id) return state;
    const remote = { ...state.remote };
    let edits = state.edits;
    if (item.current === null) {
      delete remote[id];
      if (mutation.baseRevision || state.edits[id]?.requiresExisting) {
        edits = { ...edits };
        delete edits[id];
      }
    }
    else {
      const cloud = envelope(item.current);
      if (cloud.recordId !== id) return state;
      if (!remote[id] || cloud.revision >= remote[id].revision) remote[id] = cloud;
    }
    return reconcileMealEdits({ ...state, remote, edits, batch: undefined }, state);
  }
  if (!["reset_required", "endpoint_generation_conflict", "mutation_receipt_expired",
    "mutation_replay_conflict", "mutation_sequence_conflict"].includes(String(conflict.error))) return state;
  const edits = { ...state.edits };
  if (edits[id] && (mutation.baseRevision || conflict.mutationOutcome !== "not_committed")) {
    edits[id] = { ...edits[id], requiresExisting: true };
  }
  return { ...state, session: undefined, cursor: null, snapshot: undefined, batch: undefined, edits };
}

let inFlight: { scope: string; promise: Promise<void> } | undefined;

async function sync(scope: string, budgetMs: number): Promise<void> {
  const deadlineAtMs = Date.now() + budgetMs;
  async function request(operation: "session" | "pull" | "mutate", body: Record<string, unknown>,
    onConflict?: (response: Readonly<Record<string, unknown>>) => void) {
    if (mealCredentialScope() !== scope) throw new Error("Meal activation changed");
    const reply = await postGateway(CLOUD_ROOT + operation, body, {
      timeoutMs: REQUEST_TIMEOUT_MS, deadlineAtMs, onConflict,
    });
    if (mealCredentialScope() !== scope) throw new Error("Meal activation changed");
    return reply;
  }
  updateMeals(scope, current => pruneMeals(current, Date.now()));
  let pulled = false;
  for (let step = 0; step < MAX_STEPS && Date.now() < deadlineAtMs; step++) {
    let state = readMeals(scope);
    if (!state.session) {
      const session = sessionFrom(await request("session", { schemaVersion: 1 }));
      updateMeals(scope, current => current.session ? current : { ...current, session });
      pulled = false;
      continue;
    }
    if (state.batch) {
      const batch = state.batch;
      let conflict: Record<string, unknown> | undefined;
      try {
        const response = await request("mutate", batch, value => { conflict = value; });
        updateMeals(scope, current => applyMealReceipt(current, batch, response));
        pulled = false;
      } catch (error) {
        if (!conflict || mealCredentialScope() !== scope) throw error;
        const recovered = updateMeals(scope, current => recoverMealConflict(current, batch, conflict!));
        if (recovered.batch?.requestId === batch.requestId) throw error;
        pulled = Boolean(recovered.session);
      }
      continue;
    }
    if (!pulled || state.snapshot) {
      let response: Record<string, unknown>;
      let generationConflict = false;
      try {
        response = await request("pull", mealPullRequest(state), (value) => {
          generationConflict = value.error === "endpoint_generation_conflict";
        });
      } catch (error) {
        if (!generationConflict || mealCredentialScope() !== scope) throw error;
        updateMeals(scope, current => current.batch || current.session?.generation !== state.session?.generation
          ? current : { ...current, session: undefined, cursor: null, snapshot: undefined });
        continue;
      }
      updateMeals(scope, current => applyMealPage(current, state, response));
      pulled = response.hasMore === false && !(response.mode === "snapshot");
      continue;
    }
    state = updateMeals(scope, current => prepareMealBatch(pruneMeals(current, Date.now()), Date.now(), UUID.string().toLowerCase()));
    if (!state.batch) return;
  }
}

export function synchronizeMeals(budgetMs = BUDGET_MS): Promise<void> {
  const scope = mealCredentialScope();
  if (!scope) return Promise.resolve();
  if (inFlight?.scope === scope) return inFlight.promise;
  const promise = sync(scope, budgetMs).catch(() => {
    writeDiagnostic("meal.sync.deferred", { result: "retained" }, "info");
  }).finally(() => {
    if (inFlight?.promise === promise) inFlight = undefined;
  });
  inFlight = { scope, promise };
  return promise;
}
