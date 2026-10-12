import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { AppState, NormalizedStatus, Shipment, StatusSemantic } from "../models";
import type { AccountParcelDto } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { emptyState } from "../services/storage";
import { selectShipmentTimeline, statusAlignmentTimes } from "../services/shipment-policy";
import { loadAlignmentRecords, parseAlignmentAttempt, rowLedgerKey } from "../services/row-ledger";
import { runStatusAlignmentPass } from "../services/status-alignment";

const PHONE = "13800001008";
const S = NOW - 90 * 60_000;
const H = S + 2 * 60_000;
const realNow = Date.now;
const timeText = (at: number) => new Date(at + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
const status = (semantic: StatusSemantic, at: number): NormalizedStatus => ({
  version: 1, scope: "SHIPMENT", semantic, code: semantic, text: semantic,
  priority: 0, eventAtMs: at, structured: true,
});

beforeEach(() => { memory.clear(); Date.now = () => NOW; });
afterEach(() => { Date.now = realNow; });

function accountRow(sf = true, semantic: StatusSemantic = "DELIVERY",
  headlineSemantic: StatusSemantic = "COMPLETED"): Shipment {
  const waybill = sf ? "SF900000001008" : "ZTO900000001008";
  const parcel: AccountParcelDto = {
    source: "interface5", ownerId: waybill, waybill, orderId: "", accountOrder: false,
    courierCode: sf ? "SF" : "ZTO", companyName: "Synthetic carrier", carrierNormalization: null,
    sourceProvider: sf ? "ShunFeng" : "CaiNiao", sourceStateCode: semantic, sourceStateText: semantic,
    semantic, normalizedStatus: status(semantic, S), normalizedStatusScope: "SHIPMENT",
    receiverPhone: PHONE, senderPhone: "", latestTimeText: timeText(H), latestDetail: "Synthetic newer event",
    tracks: [
      { timeText: timeText(H), detail: "Synthetic newer event", statusCode: headlineSemantic,
        normalizedStatus: status(headlineSemantic, H) },
      { timeText: timeText(S), detail: "Synthetic same-state event", statusCode: semantic,
        normalizedStatus: status(semantic, S) },
    ],
    routeUrl: "", projectionUrl: "",
  };
  const shipment = parcelToShipment(parcel, [PHONE], NOW)!;
  assert.ok(shipment);
  assert.equal(shipment.sourceTimeline!.semantic, semantic);
  assert.equal(shipment.sourceTimeline!.statusEventAtMs, S);
  assert.equal(shipment.sourceTimeline!.tracks[0].raw.normalizedStatus.semantic, headlineSemantic);
  return shipment;
}

function state(shipment: Shipment): AppState {
  return { ...emptyState(), shipments: [shipment],
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86_400_000 }] };
}

test("a known newer SF account headline cannot promote the status before the first force finishes", () => {
  const shipment = accountRow();
  const shown = selectShipmentTimeline(shipment);
  assert.equal(shown.semantic, "DELIVERY");
  assert.equal(shown.statusEventAtMs, S);
  assert.equal(shown.latestDetail, "Synthetic newer event", "pending force preserves the original presentation");
  assert.deepEqual(shown.tracks, shipment.sourceTimeline!.tracks);
  assert.equal(loadAlignmentRecords()[rowLedgerKey(shipment.identity.id)], undefined);
});

test("the real first force unlocks only the coarse same-state fallback after it finishes", async () => {
  const shipment = accountRow();
  const before = state(shipment);
  let finishQuery!: () => void;
  let queryStarted!: () => void;
  const waiting = new Promise<void>(resolve => { finishQuery = resolve; });
  const started = new Promise<void>(resolve => { queryStarted = resolve; });
  let calls = 0;
  const pass = runStatusAlignmentPass({}, { appHost: () => true, busy: () => false,
    load: () => before, now: () => NOW, refresh: async (_id, beforeQuery) => {
      beforeQuery(); calls++; queryStarted(); await waiting; return { state: before };
    } });
  await started;
  const key = rowLedgerKey(shipment.identity.id);
  let pendingAssertion: unknown;
  try {
    const reserved = parseAlignmentAttempt(loadAlignmentRecords()[key])!;
    assert.equal(reserved.attempts, 1);
    assert.equal(reserved.finished, false);
    const pending = selectShipmentTimeline(shipment);
    assert.equal(pending.semantic, "DELIVERY");
    assert.equal(pending.latestDetail, "Synthetic newer event");
  } catch (error) { pendingAssertion = error; }
  finally { finishQuery(); }
  const result = await pass;
  if (pendingAssertion) throw pendingAssertion;
  assert.equal(calls, 1);
  assert.equal(result.result, "attempted");
  const finished = parseAlignmentAttempt(loadAlignmentRecords()[key])!;
  const times = statusAlignmentTimes(shipment)!;
  assert.equal(finished.times, `${times.statusAtMs}|${times.headlineAtMs}|${times.detailAtMs}`);
  assert.equal(finished.finished, true);
  assert.equal(finished.complete, false, "an unchanged response still requires the remaining bounded retries");
  const shown = selectShipmentTimeline(shipment);
  assert.equal(shown.semantic, "DELIVERY");
  assert.equal(shown.statusEventAtMs, S);
  assert.equal(shown.latestDetail, "Synthetic same-state event");
  assert.equal(shown.latestTimeText, timeText(S));
  assert.deepEqual(shown.tracks, shipment.sourceTimeline!.tracks);
});

test("non-SF known newer headlines retain their existing status promotion", () => {
  const shipment = accountRow(false);
  const shown = selectShipmentTimeline(shipment);
  assert.equal(shown.semantic, "COMPLETED");
  assert.equal(shown.statusEventAtMs, H);
  assert.equal(shown.latestDetail, "Synthetic newer event");
});

test("qualified non-coarse SF headlines retain their existing status promotion", () => {
  const shipment = accountRow();
  const source = shipment.sourceTimeline!;
  const pickupAt = S - 86_400_000;
  const manual = { ...source, provider: "k100_h5", complete: true,
    tracks: [...source.tracks, { timeText: timeText(pickupAt), timeMs: pickupAt,
      detail: "顺丰速运 已收取快件", statusCode: "PICKED", raw: { normalizedStatus: status("PICKED", pickupAt) } }] };
  const shown = selectShipmentTimeline({ ...shipment, manualTimelines: [manual] });
  assert.equal(shown.provider, "k100_h5");
  assert.equal(shown.semantic, "COMPLETED");
  assert.equal(shown.statusEventAtMs, H);
  assert.deepEqual(shown.tracks, manual.tracks);
});

test("an SF signed status still cannot regress to a known newer active headline", () => {
  const shipment = accountRow(true, "COMPLETED", "DELIVERY");
  const shown = selectShipmentTimeline(shipment);
  assert.equal(shown.semantic, "COMPLETED");
  assert.equal(shown.statusEventAtMs, S);
  assert.equal(shown.latestDetail, "Synthetic newer event");
});
