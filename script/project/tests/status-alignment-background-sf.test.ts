import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment, StatusSemantic, TimelinePackage, TrackNode } from "../models";
import { manualProviderSchedule, queryManualForSource } from "../services/manual-query";
import { commitRefreshState, emptyState, loadState, saveState } from "../services/storage";
import { runShipmentEnrichmentForTesting } from "../services/sync";
import { loadAlignmentRecords, parseAlignmentAttempt, rowLedgerKey, saveAlignmentRecords } from "../services/row-ledger";
import { MANUAL_REFRESH_MIN_INTERVAL_MS, selectShipmentTimeline, signedTripleReached, statusAlignmentTimes,
  FORCED_COMPLETION_REFRESH_WINDOW_MS, shipmentHeadlineMatchesStatus } from "../services/shipment-policy";
import { acquireDurableRefreshLease, recordRefreshProviderResult } from "../services/refresh-runtime-state";
import { sharedData } from "../services/shared-file-transaction";

const PHONE = "13800009044", WAYBILL = "SF900000009044";
const SIGNED_AT = NOW - 30 * 60_000, OLD_AT = NOW - 2 * 3_600_000;
const OLD_BODY = "Synthetic previous delivery event", SIGNED_BODY = "Synthetic coarse signing event";
const actualNow = Date.now, actualFetch = globalThis.fetch;
let clock = NOW;
const time = (at: number) => new Date(at + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

function node(at: number, detail: string, semantic: StatusSemantic): TrackNode {
  return { timeMs: at, timeText: time(at), detail, statusCode: semantic, raw: {
    normalizedStatus: { version: 1, scope: "SHIPMENT", semantic, code: semantic, text: semantic,
      priority: 0, eventAtMs: at, structured: true },
  } };
}

function pack(provider: string, semantic: StatusSemantic, tracks: TrackNode[]): TimelinePackage {
  return { provider, waybill: WAYBILL, courierCode: "SF", companyName: "Synthetic carrier",
    semantic, structuredStatus: true, statusEventAtMs: tracks[0].timeMs, successAtMs: OLD_AT,
    complete: false, latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, tracks };
}

function row(): Shipment {
  const source = pack("interface5", "COMPLETED", [node(SIGNED_AT, SIGNED_BODY, "COMPLETED")]);
  const online = pack("v6_query", "DELIVERY", [node(OLD_AT, OLD_BODY, "DELIVERY"),
    node(OLD_AT - 86_400_000, "Synthetic pickup event", "PICKED")]);
  return { identity: { id: `interface5:account:${WAYBILL}`, sourceId: WAYBILL,
    bindingSource: "interface5", sourceOwner: "interface5:parcel", sourceProvider: "ShunFeng",
    courierCode: "SF", rawCourierCode: "SF", companyName: "Synthetic carrier", phone: PHONE,
    phoneTail: "9044", manuallyAdded: false, createdAtMs: OLD_AT - 86_400_000 },
    timeline: { ...online, semantic: "COMPLETED", statusEventAtMs: SIGNED_AT },
    sourceTimeline: source, manualTimelines: [online], updatedAtMs: OLD_AT,
    accountRecord: { waybill: WAYBILL, companyCode: "SF", provider: "ShunFeng", phone: PHONE } };
}

function seed(shipment = row()): Shipment {
  return saveState({ ...emptyState(), shipments: [shipment], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: OLD_AT - 86_400_000 },
  ] }, clock).shipments[0];
}

function withoutCoarseNode(): Shipment {
  const shipment = row();
  return { ...shipment, sourceTimeline: { ...shipment.sourceTimeline!, tracks: [],
    latestDetail: "", latestTimeText: "" } };
}

type QueryInput = Parameters<typeof queryManualForSource>[0];
type QueryResult = Awaited<ReturnType<typeof queryManualForSource>>;
const emptyReply = (): QueryResult => ({ result: "empty_response", shipment: null, pending: null, routeUrl: "" });
const attempt = (shipment: Shipment) => parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(shipment.identity.id)]);

async function background(query: typeof queryManualForSource, deadline = clock + 60_000, signal?: AbortSignal) {
  let base = loadState(clock);
  const checkpoint: Parameters<typeof runShipmentEnrichmentForTesting>[3] = (candidate, _mutations, _stage, jobBase) => {
    const result = commitRefreshState(jobBase || base, candidate, "interface5", clock);
    assert.equal(result.applied, true);
    base = result.state;
    return base;
  };
  return runShipmentEnrichmentForTesting(base, "interface5", "synthetic-background", checkpoint, deadline,
    new Set(), false, false, signal, { queryManualForSource: query }, false, new Set(), undefined, true);
}

beforeEach(() => {
  memory.clear(); clock = NOW; Date.now = () => clock;
  globalThis.fetch = (async () => { assert.fail("Synthetic background tests must never send HTTP"); }) as typeof fetch;
});
afterEach(() => { Date.now = actualNow; globalThis.fetch = actualFetch; });

test("background asks Online before releasing a signed SF coarse headline", async () => {
  const original = seed();
  assert.equal(original.timeline.semantic, "COMPLETED");
  assert.equal(original.timeline.latestDetail, OLD_BODY);
  assert.equal(signedTripleReached(original, clock), false);
  const calls: QueryInput[] = [];
  await background(async input => {
    input.beforeQuery?.();
    calls.push(input);
    assert.equal(attempt(original)?.finished, false, "the request must reserve before dispatch");
    assert.equal(selectShipmentTimeline(loadState(clock).shipments[0]).latestDetail, OLD_BODY,
      "the coarse fallback cannot appear while Online is in flight");
    return emptyReply();
  });
  assert.equal(calls.length, 1, "the signed account status must not suppress its pending background alignment");
  assert.equal(calls[0].pickerOnly, true);
  assert.equal(calls[0].includeKdniaoFallback, false);
  assert.equal(calls[0].hostSafe, true);
  assert.equal(attempt(original)?.attempts, 1);
  assert.equal(attempt(original)?.finished, true);
  assert.equal(attempt(original)?.complete, false, "an empty reply is not newer logistics evidence");
  assert.equal(loadState(clock).shipments[0].timeline.latestDetail, SIGNED_BODY,
    "the finished attempt persists the same-state coarse fallback without opening the app");
  assert.deepEqual(loadState(clock).shipments[0].manualTimelines![0].tracks,
    original.manualTimelines![0].tracks, "coarse headline alignment preserves the detailed history");
});

test("a newer Online signing replaces the stale headline with its detailed same-state node", async () => {
  const original = seed();
  const detailed = "Synthetic new detailed signing event";
  const fresh = pack("v6_query", "COMPLETED", [node(SIGNED_AT, detailed, "COMPLETED"),
    ...original.manualTimelines![0].tracks]);
  let calls = 0;
  await background(async input => {
    input.beforeQuery?.(); calls++;
    assert.equal(input.pickerOnly, true);
    assert.equal(input.includeKdniaoFallback, false);
    return { result: "success", shipment: { ...input.currentShipment!, timeline: fresh,
      sourceTimeline: null, manualTimelines: [fresh] }, pending: null, routeUrl: "" };
  });
  assert.equal(calls, 1);
  const stored = loadState(clock).shipments[0];
  assert.equal(stored.timeline.latestDetail, detailed);
  assert.equal(stored.timeline.statusEventAtMs, SIGNED_AT);
  assert.equal(attempt(original)?.finished, true);
  assert.equal(attempt(original)?.complete, true);
});

test("an unchanged Online response finishes the attempt and persists the coarse signing headline", async () => {
  const original = seed();
  let calls = 0;
  await background(async input => {
    input.beforeQuery?.(); calls++;
    const old = original.manualTimelines![0];
    return { result: "success", shipment: { ...input.currentShipment!, timeline: old,
      sourceTimeline: null, manualTimelines: [old] }, pending: null, routeUrl: "" };
  });
  assert.equal(calls, 1);
  assert.equal(attempt(original)?.finished, true);
  assert.equal(attempt(original)?.complete, false);
  assert.equal(loadState(clock).shipments[0].timeline.latestDetail, SIGNED_BODY);
});

test("a dispatched Online failure settles before the same-state fallback is saved", async () => {
  const original = seed();
  let calls = 0;
  await background(async input => {
    input.beforeQuery?.(); calls++;
    assert.equal(loadState(clock).shipments[0].timeline.latestDetail, OLD_BODY);
    throw new Error("Synthetic Online timeout");
  });
  assert.equal(calls, 1);
  assert.equal(attempt(original)?.attempts, 1);
  assert.equal(attempt(original)?.finished, true);
  assert.equal(attempt(original)?.complete, false);
  assert.equal(loadState(clock).shipments[0].timeline.latestDetail, SIGNED_BODY);
});

test("foreground and background share the row interval and three-attempt ceiling", async () => {
  const original = seed(withoutCoarseNode());
  const times = statusAlignmentTimes(original)!;
  const key = `${times.statusAtMs}|${times.headlineAtMs}|${times.detailAtMs}`;
  saveAlignmentRecords({ [rowLedgerKey(original.identity.id)]: JSON.stringify({ times: key,
    attempts: 1, lastAttemptAtMs: clock, finished: true, complete: false }) });
  let calls = 0;
  const query: typeof queryManualForSource = async input => {
    input.beforeQuery?.(); calls++;
    return emptyReply();
  };
  clock += MANUAL_REFRESH_MIN_INTERVAL_MS - 1;
  await background(query);
  assert.equal(calls, 0);
  clock++;
  await background(query);
  assert.equal(calls, 1);
  assert.equal(attempt(original)?.attempts, 2);
  clock += MANUAL_REFRESH_MIN_INTERVAL_MS;
  await background(query);
  assert.equal(calls, 2);
  assert.equal(attempt(original)?.attempts, 3);
  clock += 30 * 60_000;
  await background(query);
  assert.equal(calls, 2, "a later background host cannot replenish a foreground group's allowance");
  assert.equal(attempt(original)?.attempts, 3);
});

test("the existing Online provider cooldown cannot reserve a background alignment attempt", async () => {
  const original = seed();
  const schedule = manualProviderSchedule({ source: "interface5", waybill: WAYBILL,
    rawCourierCode: "SF", phoneTail: "9044", sourceProvider: "ShunFeng" });
  recordRefreshProviderResult({ key: schedule.key, provider: "picker", identityFingerprint: schedule.identityFingerprint,
    result: "success", now: clock - 60_000 });
  let calls = 0;
  await background(async () => { calls++; return emptyReply(); });
  assert.equal(calls, 0);
  assert.equal(attempt(original), null);
  assert.equal(loadState(clock).shipments[0].timeline.latestDetail, OLD_BODY);
});

test("the real scheduled manual chain only asks Online and retains its existing success cooldown", async () => {
  const original = seed(withoutCoarseNode());
  const paths: string[] = [];
  const query: typeof queryManualForSource = input => queryManualForSource({ ...input, dependencies: {
    now: () => clock,
    post: async (path, _payload, options) => {
      options?.beforeQuery?.(); options?.onQueryAttempted?.(true);
      paths.push(path);
      return { code: 200, normalizedStatus: { version: 1, scope: "SHIPMENT", semantic: "DELIVERY",
        code: "DELIVERY", text: "Delivery", priority: 0, eventAtMs: OLD_AT, structured: true },
      value: { nu: WAYBILL, com: "SF", tracks: original.manualTimelines![0].tracks.map(track => ({
        time: track.timeText, context: track.detail, state: track.statusCode,
      })) } };
    },
  } });
  await background(query);
  assert.deepEqual(paths, ["/api/express/timeline/source"]);
  assert.equal(attempt(original)?.finished, true);
  assert.equal(attempt(original)?.complete, false, "the reply carries no newer node or status time");
  const provider = (sharedData().refresh?.providers as Array<{ provider: string; nextDueAtMs: number }>)
    .find(item => item.provider === "picker")!;
  assert.ok(provider.nextDueAtMs >= NOW + 10 * 60_000, "the existing cooldown includes its normal jitter");
  clock += MANUAL_REFRESH_MIN_INTERVAL_MS;
  await background(query);
  assert.equal(paths.length, 1, "the shared row interval does not bypass Online's provider cooldown");
  assert.equal(attempt(original)?.attempts, 1);
  clock = provider.nextDueAtMs;
  await background(query);
  assert.deepEqual(paths, ["/api/express/timeline/source", "/api/express/timeline/source"]);
  assert.equal(attempt(original)?.attempts, 2);
});

test("a coarse headline already aligned by a finished query does not schedule a detail-only background repair", async () => {
  const original = seed();
  let calls = 0;
  const query: typeof queryManualForSource = async input => {
    input.beforeQuery?.(); calls++;
    return emptyReply();
  };
  await background(query);
  const aligned = loadState(clock).shipments[0];
  assert.equal(calls, 1);
  assert.equal(aligned.timeline.latestDetail, SIGNED_BODY);
  assert.equal(shipmentHeadlineMatchesStatus(aligned), true);
  assert.equal(signedTripleReached(aligned, clock), false,
    "the detailed history is still older than signing");
  assert.equal(statusAlignmentTimes(aligned)?.detailAtMs, OLD_AT);
  clock += 30 * 60_000;
  await background(query);
  assert.equal(calls, 1, "the background exception repairs the headline, not the remaining detail history");
  assert.equal(attempt(original)?.attempts, 1);
});

test("a provider-side cooldown without dispatch cannot unlock the coarse fallback", async () => {
  const original = seed();
  await background(async () => ({ ...emptyReply(), skipReason: "cooldown" }));
  assert.equal(attempt(original), null);
  assert.equal(loadState(clock).shipments[0].timeline.latestDetail, OLD_BODY);
});

test("signed non-SF, already aligned, hard-frozen and unbound rows stay outside background alignment", async () => {
  for (const kind of ["non-sf", "aligned", "hard-frozen", "unbound"] as const) {
    memory.clear();
    let input = row();
    if (kind === "non-sf") input = { ...input, identity: { ...input.identity, sourceProvider: "OtherSource" } };
    if (kind === "aligned") {
      const complete = pack("v6_query", "COMPLETED", [node(SIGNED_AT, SIGNED_BODY, "COMPLETED"),
        ...input.manualTimelines![0].tracks]);
      input = { ...input, timeline: complete, manualTimelines: [complete] };
    }
    if (kind === "hard-frozen") input = { ...input, forcedCompletedAtMs: clock - FORCED_COMPLETION_REFRESH_WINDOW_MS };
    const original = seed(input);
    if (kind === "unbound") saveState({ ...loadState(clock), bindings: [] }, clock);
    let calls = 0;
    await background(async () => { calls++; return emptyReply(); });
    assert.equal(calls, 0, kind);
    assert.equal(attempt(original), null, kind);
  }
});

test("an exhausted host budget and an already-cancelled host reserve no attempt", async () => {
  const original = seed();
  let calls = 0;
  const query: typeof queryManualForSource = async () => { calls++; return emptyReply(); };
  await background(query, clock);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(background(query, clock + 60_000, controller.signal));
  assert.equal(calls, 0);
  assert.equal(attempt(original), null);
  assert.equal(loadState(clock).shipments[0].timeline.latestDetail, OLD_BODY);
});

test("cancellation after dispatch retains the unfinished attempt without showing a coarse completion", async () => {
  const original = seed();
  const controller = new AbortController();
  await assert.rejects(background(async input => {
    input.beforeQuery?.(); controller.abort();
    throw new Error("Synthetic host cancellation");
  }, clock + 60_000, controller.signal));
  assert.equal(attempt(original)?.attempts, 1);
  assert.equal(attempt(original)?.finished, false);
  assert.equal(loadState(clock).shipments[0].timeline.latestDetail, OLD_BODY);
});

test("a failed durable reservation prevents dispatch and preserves the old headline", async () => {
  const original = seed();
  const set = Storage.set;
  let dispatched = 0;
  Storage.set = ((key: string, value: unknown, options?: { shared: boolean }) =>
    key === "pipi_deliveries_row_ledger_v1" ? false : set(key, value, options)) as typeof Storage.set;
  try {
    await assert.rejects(background(async input => {
      input.beforeQuery?.(); dispatched++;
      return emptyReply();
    }), /Failed to save alignment/);
    assert.equal(dispatched, 0);
    assert.equal(attempt(original), null);
    assert.equal(loadState(clock).shipments[0].timeline.latestDetail, OLD_BODY);
  } finally { Storage.set = set; }
});

test("another host's row lease prevents dispatch and reserves no background attempt", async () => {
  const original = seed();
  const lease = acquireDurableRefreshLease(`detail:${original.identity.id}`, 35_000, clock)!;
  assert.ok(lease);
  let calls = 0;
  try {
    await background(async () => { calls++; return emptyReply(); });
    assert.equal(calls, 0);
    assert.equal(attempt(original), null);
    assert.equal(loadState(clock).shipments[0].timeline.latestDetail, OLD_BODY);
  } finally { lease.release(); }
});

test("deletion, rebinding or parcel replacement before dispatch cannot reserve the old owner", async () => {
  for (const change of ["delete", "rebind", "reuse", "reuse-marker"] as const) {
    memory.clear();
    const original = seed();
    let dispatched = 0;
    await assert.rejects(background(async input => {
      const current = loadState(clock);
      saveState({ ...current,
        bindings: change === "rebind" ? current.bindings.map(binding => ({ ...binding, boundAtMs: clock })) : current.bindings,
        shipments: change === "delete" ? [] : change === "reuse"
          ? current.shipments.map(shipment => ({ ...shipment,
            identity: { ...shipment.identity, createdAtMs: clock } }))
          : change === "reuse-marker" ? current.shipments.map(shipment => ({ ...shipment, waybillReuseAtMs: clock }))
          : current.shipments,
      }, clock);
      input.beforeQuery?.(); dispatched++;
      return emptyReply();
    }), /Alignment owner changed/);
    assert.equal(dispatched, 0, change);
    assert.equal(attempt(original), null, change);
  }
});

test("an in-flight reply cannot resurrect a deleted or replaced parcel or a former binding", async () => {
  for (const change of ["delete", "rebind", "reuse", "reuse-marker"] as const) {
    memory.clear();
    const original = seed();
    await background(async input => {
      input.beforeQuery?.();
      const current = loadState(clock);
      saveState({ ...current,
        bindings: change === "rebind" ? current.bindings.map(binding => ({ ...binding, boundAtMs: clock })) : current.bindings,
        shipments: change === "delete" ? [] : change === "reuse"
          ? current.shipments.map(shipment => ({ ...shipment,
            identity: { ...shipment.identity, createdAtMs: clock } }))
          : change === "reuse-marker" ? current.shipments.map(shipment => ({ ...shipment, waybillReuseAtMs: clock }))
          : current.shipments,
      }, clock);
      const fresh = pack("v6_query", "COMPLETED", [node(SIGNED_AT, "Synthetic obsolete reply", "COMPLETED")]);
      return { result: "success", shipment: { ...input.currentShipment!, timeline: fresh,
        sourceTimeline: null, manualTimelines: [fresh] }, pending: null, routeUrl: "" };
    });
    const stored = loadState(clock).shipments;
    assert.equal(stored.length, change === "delete" ? 0 : 1, change);
    if (stored.length) assert.equal(stored[0].timeline.latestDetail, OLD_BODY, change);
    if (change === "reuse-marker") assert.equal(stored[0].identity.createdAtMs, original.identity.createdAtMs,
      "the existing parcel generation marker alone must fence the reply");
    assert.notEqual(attempt(original)?.finished, true, change);
  }
});

test("a finished failed query does not invent a signing headline when no same-state source node exists", async () => {
  const original = seed(withoutCoarseNode());
  let calls = 0;
  await background(async input => { input.beforeQuery?.(); calls++; return emptyReply(); });
  assert.equal(calls, 1);
  assert.equal(attempt(original)?.finished, true);
  assert.equal(attempt(original)?.complete, false);
  assert.equal(loadState(clock).shipments[0].timeline.latestDetail, OLD_BODY,
    "a completed enum alone is not a replacement timeline node");
});
