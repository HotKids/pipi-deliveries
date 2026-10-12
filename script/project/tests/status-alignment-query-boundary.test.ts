import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";
import type { AppState, Shipment, TimelinePackage } from "../models";
import { saveGatewayToken } from "../services/credentials";
import { accountOrderProjectionRouteHash } from "../services/account-sync-policy";
import { loadAlignmentRecords, parseAlignmentAttempt, rowLedgerKey, saveAlignmentRecords } from "../services/row-ledger";
import { acquireDurableRefreshLease, recordRefreshProviderResult } from "../services/refresh-runtime-state";
import { sharedData } from "../services/shared-file-transaction";
import { displayWaybill, statusAlignmentTimes } from "../services/shipment-policy";
import { saveOrderProjectionReferences } from "../services/routes";
import { emptyState, loadState, saveState } from "../services/storage";
import { createStatusAlignment, runStatusAlignmentPass } from "../services/status-alignment";
import { runTargetedShipmentRefreshForTesting } from "../services/sync";

const WAYBILL = "ZTO900000001008";
const realNow = Date.now, realFetch = globalThis.fetch;
let clock = NOW, requests: string[] = [], reservedBeforeRequests: boolean[] = [];
let id = "interface5:account:QUERY1008";
const time = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
function packageFor(provider: string): TimelinePackage {
  const tracks = [NOW - 3600000, NOW - 86400000].map((at, index) => ({
    timeMs: at, timeText: time(at), detail: index ? "已揽收" : "Synthetic old carrier event",
    statusCode: "", raw: {},
  }));
  return { provider, waybill: WAYBILL, courierCode: "ZTO", rawCourierCode: "ZTO", companyName: "Synthetic carrier",
    semantic: "TRANSIT", structuredStatus: true, statusEventAtMs: NOW - 60000, complete: true,
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, tracks, successAtMs: NOW - 3600000 };
}
function seed(manual = false): Shipment {
  memory.clear(); requests = []; reservedBeforeRequests = []; clock = NOW;
  Date.now = () => clock;
  id = `interface5:${manual ? "manual" : "account"}:QUERY1008`;
  const source = packageFor(manual ? "kdniao" : "interface5");
  const row: Shipment = { identity: { id, bindingSource: "interface5", sourceOwner: manual ? "manual" : "interface5:parcel",
    sourceId: WAYBILL, courierCode: "ZTO", rawCourierCode: "ZTO", companyName: "Synthetic carrier",
    sourceProvider: manual ? "" : "CaiNiao", manuallyAdded: manual, createdAtMs: NOW - 86400000 },
    sourceTimeline: manual ? null : source, manualTimelines: manual ? [source] : [], timeline: source,
    updatedAtMs: NOW, ...(!manual ? { accountRecord: { waybill: WAYBILL, companyCode: "ZTO", provider: "CaiNiao",
      name: "Synthetic carrier", phone: "13800001008", stateNumber: 2, updateTime: "", channel: "" } } : {}) };
  const saved = saveState({ ...emptyState(), shipments: [row] }, clock).shipments[0];
  id = saved.identity.id;
  return saved;
}
function started(path: string): void {
  requests.push(path);
  const record = parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(id)]);
  reservedBeforeRequests.push(record?.attempts === 1 && record.finished === false);
}
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({ toHexString: () => createHmac("sha256", key).update(value).digest("hex") }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(globalThis, {
  Widget: { reloadAll() {} }, Notification: { schedule: async () => undefined },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class {
    async loadURL() { started("web"); return false; }
    async evaluateJavaScript() { return null; }
    dispose() {}
  },
});
function allowSyntheticGateway(): void {
  saveGatewayToken("AbCdEfGh_123-456");
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    started(path);
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: {} }) };
  }) as typeof fetch;
}
afterEach(() => { Date.now = realNow; globalThis.fetch = realFetch; });
const pass = () => runStatusAlignmentPass({}, { appHost: () => true, busy: () => false,
  load: () => loadState(clock), now: () => clock });

function seedJdOrder(cooled: boolean): void {
  seed();
  const original = loadState(clock).shipments[0];
  const order = "3610000000001008";
  id = `interface5:account:${order}`;
  const source = { ...original.sourceTimeline!, waybill: "", courierCode: "JD" };
  saveState({ ...emptyState(), shipments: [{ ...original, identity: { ...original.identity,
    id, sourceId: order, orderId: order, accountOrder: true, projectedWaybill: "", sourceProvider: "JingDong",
    courierCode: "JD", rawCourierCode: "JD", ...(cooled ? { orderProjectionRetry: {
      routeHash: accountOrderProjectionRouteHash(id), failedAtMs: clock - 60000,
    } } : {}) }, timeline: source, sourceTimeline: source, accountRecord: { ...original.accountRecord!,
      waybill: order, provider: "JingDong", companyCode: "JD" } }] }, clock);
  saveOrderProjectionReferences([{ ownerId: id, source: "interface5", url: "https://u.jd.com/forward?synthetic=alignment" }], clock);
}

test("the real account Gateway request reserves before fetch, and an empty reply uses one attempt", async () => {
  seed(); allowSyntheticGateway();
  assert.equal((await pass()).result, "attempted");
  assert.deepEqual(requests, ["/api/express/timeline/source"]);
  assert.deepEqual(reservedBeforeRequests, [true]);
  const record = parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(id)])!;
  assert.equal(record.attempts, 1);
  assert.equal(record.finished, true);
  assert.equal(record.complete, false);
});

test("a failed reservation in the real account transport propagates without sending fetch", async () => {
  const shipment = seed(); allowSyntheticGateway();
  recordRefreshProviderResult({ key: `interface5:${id}`, provider: "account_detail",
    identityFingerprint: [displayWaybill(shipment), shipment.identity.courierCode, shipment.identity.phoneTail].join(":"),
    result: "success", now: clock - 60000 });
  const providersBefore = JSON.stringify(sharedData().refresh?.providers);
  const set = Storage.set;
  Storage.set = ((key: string, value: unknown, options?: { shared: boolean }) =>
    key === "pipi_deliveries_row_ledger_v1" ? false : set(key, value, options)) as typeof Storage.set;
  try {
    await assert.rejects(pass(), /Failed to save alignment/);
    assert.deepEqual(requests, []);
    assert.equal(loadAlignmentRecords()[rowLedgerKey(id)], undefined);
    assert.equal(JSON.stringify(sharedData().refresh?.providers), providersBefore,
      "a rejected reservation must not change the provider failure count or cooldown");
  } finally { Storage.set = set; }
});

test("an actual account transport failure retains its provider failure bookkeeping", async () => {
  seed(); allowSyntheticGateway();
  globalThis.fetch = (async (url: string) => { started(new URL(url).pathname); throw new Error("Synthetic transport failure"); }) as typeof fetch;
  assert.equal((await pass()).result, "attempted");
  assert.deepEqual(requests, ["/api/express/timeline/source"]);
  assert.deepEqual(reservedBeforeRequests, [true]);
  const provider = (sharedData().refresh?.providers as { provider: string; consecutiveFailures: number; lastResult: string }[])
    .find(item => item.provider === "account_detail")!;
  assert.equal(provider.consecutiveFailures, 1);
  assert.equal(provider.lastResult, "network");
});

test("a new S/H/D group starts at the real account request without inheriting the old group interval or cap", async () => {
  const shipment = seed(); allowSyntheticGateway();
  const times = statusAlignmentTimes(shipment)!;
  const previousTimes = `${times.statusAtMs}|${times.headlineAtMs}|${times.detailAtMs}`;
  saveAlignmentRecords({ [rowLedgerKey(id)]: JSON.stringify({ times: previousTimes, attempts: 3,
    lastAttemptAtMs: clock, complete: false, finished: true }) });
  const source = { ...shipment.sourceTimeline!, statusEventAtMs: shipment.sourceTimeline!.statusEventAtMs! + 1000 };
  saveState({ ...loadState(clock), shipments: [{ ...shipment, timeline: source, sourceTimeline: source }] }, clock);
  assert.equal((await pass()).result, "attempted");
  assert.deepEqual(requests, ["/api/express/timeline/source"]);
  assert.deepEqual(reservedBeforeRequests, [true]);
  const record = parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(id)])!;
  assert.notEqual(record.times, previousTimes);
  assert.equal(record.attempts, 1);
  assert.equal(record.lastAttemptAtMs, clock);
});

test("the real manual Gateway and H5 starts share one reservation after their own gates", async () => {
  seed(true); allowSyntheticGateway();
  assert.equal((await pass()).result, "attempted");
  assert.ok(requests.includes("/api/express/timeline/public"));
  assert.ok(requests.includes("web"));
  assert.ok(reservedBeforeRequests.length >= 2 && reservedBeforeRequests.every(Boolean),
    JSON.stringify({ requests, reservedBeforeRequests }));
  assert.equal(requests.some(path => path.includes("fallback")), false);
  assert.equal(parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(id)])!.attempts, 1);
});

test("the existing watch resumes a first attempt after the real foreign detail lease is released", async () => {
  const shipment = seed(); allowSyntheticGateway();
  const foreign = acquireDurableRefreshLease(`detail:${shipment.identity.id}`, 35000, clock)!;
  let timerId = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const controller = createStatusAlignment({
    runPass: options => runStatusAlignmentPass(options, { appHost: () => true, busy: () => false,
      load: () => loadState(clock), now: () => clock }),
    subscribeRefreshOutcome: () => () => {}, peekRevision: () => 1, applyState: () => {},
    setTimer: (callback, delay) => { const next = ++timerId; timers.set(next, { due: clock + delay, callback }); return next; },
    clearTimer: next => { timers.delete(next as number); },
  });
  const tick = async (elapsed: number) => {
    clock += elapsed;
    for (let round = 0; round < 30; round++) {
      for (const [next, timer] of [...timers].filter(([, timer]) => timer.due <= clock)) {
        timers.delete(next); timer.callback();
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
  try {
    controller.scenePhaseChanged("active");
    await tick(0);
    assert.deepEqual(requests, []);
    assert.equal(loadAlignmentRecords()[rowLedgerKey(id)], undefined);
    foreign.release();
    await tick(3000);
    assert.deepEqual(requests, ["/api/express/timeline/source"]);
    assert.deepEqual(reservedBeforeRequests, [true]);
    assert.equal(parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(id)])!.attempts, 1);
  } finally { foreign.release(); controller.stop(); }
});

test("the real JD order cooldown and unavailable account transport consume no attempt", async () => {
  seedJdOrder(true);
  globalThis.fetch = (async () => { requests.push("unexpected"); return { ok: false, status: 503 }; }) as typeof fetch;
  await pass();
  assert.deepEqual(requests, []);
  assert.equal(loadAlignmentRecords()[rowLedgerKey(id)], undefined);
});

test("a failed reservation before JD page load preserves its existing projection cooldown record", async () => {
  seedJdOrder(false);
  const set = Storage.set;
  let pageLoads = 0;
  Storage.set = ((key: string, value: unknown, options?: { shared: boolean }) =>
    key === "pipi_deliveries_row_ledger_v1" ? false : set(key, value, options)) as typeof Storage.set;
  try {
    await assert.rejects(runStatusAlignmentPass({}, { appHost: () => true, busy: () => false,
      load: () => loadState(clock), now: () => clock,
      refresh: (shipmentId, beforeQuery) => runTargetedShipmentRefreshForTesting(shipmentId,
        { trigger: "status_alignment", beforeQuery, forceAccountOrderProjection: true, forceManualRefresh: true,
          includeKdniaoFallback: true, deadlineAtMs: clock + 30000 }, {
          refreshAccountParcel: async () => null,
          projectAccountOrderWithCarrier: async (input, _projectionDeadline, _recognitionDeadline, _observe, _signal, beforeLoad) => {
            beforeLoad?.(); pageLoads++; return input;
          },
        }),
    }), /Failed to save alignment/);
    assert.equal(pageLoads, 0);
    assert.equal(loadAlignmentRecords()[rowLedgerKey(id)], undefined);
    assert.equal(loadState(clock).shipments[0].identity.orderProjectionRetry, undefined,
      "no JD query started, so storage failure cannot create a provider cooldown");
  } finally { Storage.set = set; }
});
