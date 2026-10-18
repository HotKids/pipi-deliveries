import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { AppState, Shipment, StatusSemantic, TimelinePackage, TrackNode } from "../models";
import { memory, NOW } from "./state-storage-mock";
import { OperationTimeoutError } from "../services/deadline";
import { loadAlignmentRecords, parseAlignmentAttempt, rowLedgerKey } from "../services/row-ledger";
import { selectShipmentTimeline, signedRefreshFrozen } from "../services/shipment-policy";
import { runStatusAlignmentPass } from "../services/status-alignment";
import { emptyState, loadState, saveState } from "../services/storage";
import { runShipmentRefreshForTesting } from "../services/sync";
import { preferNewerState } from "../services/ui-state";

const PHONE = "13800002731";
const WAYBILL = "SF900000002731";
const SIGNED_AT = NOW - 60_000;
const OLD_AT = SIGNED_AT - 2 * 3_600_000;
const OLD_BODY = "Synthetic delivery event";
const COARSE_BODY = "Synthetic coarse signing event";
const SIGNED_BODY = "Synthetic detailed signing event";
const actualNow = Date.now;
let now = NOW;
const text = (at: number) => new Date(at + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

Object.assign(globalThis, {
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic:detail" },
  Data: { ...globalThis.Data, fromFile: () => null },
  Widget: { reloadAll() {} },
  Notification: { schedule: async () => { assert.fail("these regressions have no pending notifications"); } },
});

beforeEach(() => { memory.clear(); now = NOW; Date.now = () => now; });
afterEach(() => { Date.now = actualNow; });

function node(at: number, detail: string, semantic: StatusSemantic): TrackNode {
  return { timeMs: at, timeText: text(at), detail, statusCode: semantic, raw: {
    normalizedStatus: { version: 1, scope: "SHIPMENT", semantic, code: semantic, text: semantic,
      priority: 0, eventAtMs: at, structured: true },
  } };
}

function pack(provider: string, semantic: StatusSemantic, at: number, tracks: TrackNode[]): TimelinePackage {
  return { provider, waybill: WAYBILL, courierCode: "SF", companyName: "Synthetic carrier",
    semantic, structuredStatus: true, statusEventAtMs: at, successAtMs: NOW, complete: false,
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, tracks };
}

function seed(): AppState {
  const source = pack("interface5", "COMPLETED", SIGNED_AT,
    [node(SIGNED_AT, COARSE_BODY, "COMPLETED")]);
  const manual = pack("v6_query", "DELIVERY", OLD_AT,
    [node(OLD_AT, OLD_BODY, "DELIVERY"), node(OLD_AT - 3_600_000, "Synthetic transit", "TRANSIT")]);
  const row: Shipment = { identity: { id: `interface5:account:${WAYBILL}`, sourceId: WAYBILL,
    bindingSource: "interface5", sourceOwner: "interface5:parcel", sourceProvider: "ShunFeng",
    courierCode: "SF", rawCourierCode: "SF", companyName: "Synthetic carrier", phone: PHONE,
    phoneTail: "2731", manuallyAdded: false, createdAtMs: OLD_AT - 86_400_000 },
    timeline: { ...manual, semantic: "COMPLETED", statusEventAtMs: SIGNED_AT },
    sourceTimeline: source, manualTimelines: [manual], updatedAtMs: NOW,
    accountRecord: { waybill: WAYBILL, companyCode: "SF", provider: "ShunFeng", phone: PHONE },
  };
  const state = saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: OLD_AT - 86_400_000 },
  ] }, now);
  assert.equal(state.shipments[0].timeline.semantic, "COMPLETED");
  assert.equal(state.shipments[0].timeline.latestDetail, OLD_BODY);
  assert.equal(signedRefreshFrozen(state.shipments[0], now), false);
  assert.equal(state.pendingNotifications?.length || 0, 0);
  return state;
}

for (const pickup of [true, false]) {
  test(`an Online child timeout continues to K100 within the original deadline${pickup ? " and pickup closes paid fallback" : " and missing pickup keeps the paid gate open"}`, async () => {
    const state = seed(), original = state.shipments[0];
    const calls: string[] = [];
    const deadline = NOW + 30_000;
    const fresh = pack("k100_h5", "COMPLETED", SIGNED_AT,
      [node(SIGNED_AT, SIGNED_BODY, "COMPLETED"),
        node(OLD_AT - 3_600_000, pickup ? "Synthetic pickup" : "Synthetic transit", pickup ? "PICKED" : "TRANSIT")]);
    await runShipmentRefreshForTesting(original.identity.id, { isCurrent: () => true, deadlineAtMs: deadline },
      { trigger: "status_alignment", beforeQuery: () => {}, forceManualRefresh: true, includeKdniaoFallback: true }, {
        refreshAccountParcel: async () => { assert.fail("SF alignment never uses account detail"); },
        queryManualForSource: async input => {
          input.beforeQuery?.(); input.onQueryAttempted?.(true);
          if (input.pickerOnly) {
            calls.push("online");
            assert.equal(input.deadlineAtMs, NOW + 15_000);
            now += 15_001;
            throw new OperationTimeoutError();
          }
          calls.push("paid");
          assert.equal(input.fallbackOnly, true);
          assert.ok(input.deadlineAtMs! <= deadline, "paid fallback cannot reset the parent budget");
          return { shipment: null, pending: null, routeUrl: "", result: "empty_response" };
        },
        refreshWebTimeline: async (_shipment, childDeadline) => {
          calls.push("k100");
          assert.ok(childDeadline! > now && childDeadline! <= deadline,
            "the next provider uses only the remaining parent budget");
          return { ...original, timeline: fresh, sourceTimeline: null, manualTimelines: [fresh] };
        },
      });
    assert.deepEqual(calls, pickup ? ["online", "k100"] : ["online", "k100", "paid"]);
    assert.equal(loadState(now).shipments[0].timeline.latestDetail, SIGNED_BODY);
  });
}

test("parent cancellation during Online cannot start K100 or paid fallback", async () => {
  const original = seed().shipments[0], controller = new AbortController();
  const calls: string[] = [];
  await assert.rejects(runShipmentRefreshForTesting(original.identity.id,
    { isCurrent: () => !controller.signal.aborted, deadlineAtMs: NOW + 30_000, signal: controller.signal },
    { trigger: "status_alignment", beforeQuery: () => {}, forceManualRefresh: true, includeKdniaoFallback: true }, {
      refreshAccountParcel: async () => { assert.fail("SF alignment never uses account detail"); },
      queryManualForSource: async input => {
        assert.equal(input.pickerOnly, true);
        calls.push("online"); input.beforeQuery?.(); controller.abort();
        throw new OperationTimeoutError();
      },
      refreshWebTimeline: async () => { assert.fail("a cancelled parent cannot open K100"); },
    }), OperationTimeoutError);
  assert.deepEqual(calls, ["online"]);
});

for (const fails of [true, false]) {
  test(`an unchanged ${fails ? "failed" : "successful"} force publishes a real revision and immediately updates the visible SF headline`, async () => {
    const before = seed(), id = before.shipments[0].identity.id;
    const result = await runStatusAlignmentPass({}, { appHost: () => true, busy: () => false,
      load: () => loadState(now), now: () => now,
      refresh: async (_id, beforeQuery) => {
        beforeQuery();
        assert.equal(selectShipmentTimeline(loadState(now).shipments[0]).latestDetail, OLD_BODY,
          "dispatch alone does not release the final coarse fallback");
        if (fails) throw new OperationTimeoutError();
        return { state: loadState(now) };
      },
    });
    assert.equal(result.result, fails ? "failed" : "attempted");
    assert.ok(result.state, "a settled failure must return the updated presentation too");
    assert.ok(result.state.revision > before.revision, "ledger-driven display changes need a durable revision");
    assert.equal(preferNewerState(before, result.state), result.state,
      "the real UI guard must accept the outcome without accepting stale equal-revision snapshots");
    assert.equal(result.state.shipments[0].timeline.latestDetail, COARSE_BODY);
    assert.equal(loadState(now).revision, result.state.revision);
    const attempt = parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(id)])!;
    assert.equal(attempt.attempts, 1);
    assert.equal(attempt.finished, true);
    assert.equal(attempt.complete, false, "no new logistics evidence must not complete the bounded group");
  });
}

for (const action of ["delete", "rebind"] as const) {
  test(`settling an old force after ${action} cannot restore the removed owner or overwrite its replacement`, async () => {
    seed();
    let changed!: AppState;
    await runStatusAlignmentPass({}, { appHost: () => true, busy: () => false,
      load: () => loadState(now), now: () => now,
      refresh: async (_id, beforeQuery) => {
        beforeQuery();
        const latest = loadState(now);
        changed = saveState({ ...latest,
          shipments: action === "delete" ? [] : latest.shipments.map(row => ({ ...row, note: "User edit after rebind" })),
          bindings: action === "rebind" ? latest.bindings.map(binding => ({ ...binding, boundAtMs: NOW + 1 })) : latest.bindings,
        }, now);
        throw new OperationTimeoutError();
      },
    });
    const durable = loadState(now);
    assert.equal(durable.revision, changed.revision, "a stale operation must not publish another business revision");
    assert.equal(durable.shipments.length, action === "delete" ? 0 : 1);
    if (action === "rebind") {
      assert.equal(durable.bindings[0].boundAtMs, NOW + 1);
      assert.equal(durable.shipments[0].note, "User edit after rebind");
    }
  });
}
