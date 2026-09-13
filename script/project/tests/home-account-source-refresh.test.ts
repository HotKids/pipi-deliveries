import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";
import { parseAccountTimelineResponse, type AccountParcelDto } from "../services/account-parser";
import type { Shipment } from "../models";
import { emptyState, saveState, loadState, commitRefreshState, removeBinding, removeShipment } from "../services/storage";
import { runShipmentEnrichmentForTesting, runShipmentRefreshForTesting } from "../services/sync";
import { parcelToShipment } from "../services/account-sync";
import { applyAccountShipment } from "../services/shipment-policy";
import { saveGatewayToken } from "../services/credentials";

const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });

function row(provider: "JingDong" | "CaiNiao", suffix: string): Shipment {
  const waybill = `YT12345678${suffix}`;
  const timeline = { provider: "v5_list", waybill, courierCode: "YTO", companyName: "Carrier",
    semantic: "TRANSIT" as const, structuredStatus: true, statusEventAtMs: NOW - 60000,
    latestDetail: "Earlier carrier event", latestTimeText: String(NOW - 60000), successAtMs: NOW,
    tracks: [{ timeMs: NOW - 60000, timeText: String(NOW - 60000), detail: "Earlier carrier event",
      statusCode: "", raw: {} }] };
  return { identity: { id: `interface5:account:${waybill}`, sourceId: waybill,
    bindingSource: "interface5", sourceProvider: provider, sourceOwner: "interface5:parcel",
    manuallyAdded: false, courierCode: "YTO", rawCourierCode: "YTO", companyName: "Carrier",
    phone: "13800001234", phoneTail: "1234", createdAtMs: NOW - 86400000 },
    timeline, sourceTimeline: timeline, manualTimelines: [], updatedAtMs: NOW - 60000,
    accountRecord: { waybill, provider, companyCode: "YTO", phone: "13800001234" } };
}

async function run(rows: Shipment[], activePull: boolean, outcome: "empty" | "failure" = "empty") {
  memory.clear();
  let base = saveState({ ...emptyState(), shipments: rows,
    bindings: [{ source: "interface5", phone: "13800001234", boundAtMs: NOW - 86400000 }] }, NOW);
  const calls: string[] = [];
  const result = await runShipmentEnrichmentForTesting(base, "interface5", "source-only-home",
    (candidate, _routes, _stage, jobBase) => {
      base = commitRefreshState(jobBase || base, candidate, "interface5", NOW).state;
      return base;
    }, NOW + 30000, new Set(), activePull, false, undefined, {
      refreshAccountParcel: async shipment => {
        calls.push(shipment.identity.id);
        if (outcome === "failure") throw new Error("Synthetic account failure");
        return null;
      },
      queryManualForSource: async () => { assert.fail("account Home follow-up must never enter manual providers"); },
    }, activePull, new Set(activePull ? rows.map(value => value.identity.id) : []));
  return { result, calls, stored: loadState(NOW) };
}

test("active Home pull queries only updated Cainiao and leaves JD list-owned", async () => {
  const rows = [row("JingDong", "01"), row("CaiNiao", "02")];
  const { calls, result, stored } = await run(rows, true);
  assert.deepEqual(calls, [rows[1].identity.id]);
  assert.equal(result.failed, 1);
  assert.ok(stored.shipments.every(value => value.timeline.tracks.length === 1));
});

test("Home JD with missing history cannot substitute an account or manual query", async () => {
  const jd = row("JingDong", "09");
  jd.timeline = { ...jd.timeline, tracks: [], latestDetail: "", latestTimeText: "" };
  jd.sourceTimeline = jd.timeline;
  const { calls, result } = await run([jd], true);
  assert.deepEqual(calls, []);
  assert.equal(result.attempted, 0);
});

test("failed account follow-up preserves history and ends without a fallback", async () => {
  const { calls, result, stored } = await run([row("CaiNiao", "03")], true, "failure");
  assert.equal(calls.length, 1);
  assert.equal(result.failed, 1);
  assert.equal(stored.shipments[0].timeline.latestDetail, "Earlier carrier event");
});

test("scheduled Home refresh keeps its previous query eligibility", async () => {
  const { calls, result } = await run([row("JingDong", "04"), row("CaiNiao", "05")], false);
  assert.deepEqual(calls, []);
  assert.equal(result.attempted, 0);
});

test("Home account follow-up retains trusted and manual completion freezes", async () => {
  const signed = row("JingDong", "06");
  signed.timeline = { ...signed.timeline, semantic: "COMPLETED", statusEventAtMs: NOW - 60000 };
  signed.sourceTimeline = signed.timeline;
  const forced = { ...row("CaiNiao", "07"), forcedCompletedAtMs: NOW - 60000 };
  const { calls } = await run([signed, forced], true);
  assert.deepEqual(calls, []);
});

function freshParcel(shipment: Shipment): AccountParcelDto {
  return { source: "interface5", ownerId: shipment.identity.sourceId, accountOrder: false,
    waybill: shipment.identity.sourceId, courierCode: "YTO", rawCourierCode: "YTO",
    companyName: "Carrier", rawCompanyName: "Carrier", carrierNormalization: null,
    sourceProvider: shipment.identity.sourceProvider!, sourceStateCode: "105", sourceStateText: "派送中",
    semantic: "DELIVERY", normalizedStatusScope: "SHIPMENT", normalizedStatusSemantic: "DELIVERY",
    normalizedStatusText: "派送中", receiverPhone: "13800001234", senderPhone: "",
    routeUrl: "", projectionUrl: "", latestDetail: "Fresh account event", latestTimeText: "2026-09-08 14:00:00",
    tracks: [{ timeMs: NOW, timeText: "2026-09-08 14:00:00", detail: "Fresh account event", statusCode: "105", raw: {} }] };
}

function seedSource() {
  memory.clear();
  return saveState({ ...emptyState(), shipments: [row("CaiNiao", "08")],
    bindings: [{ source: "interface5", phone: "13800001234", boundAtMs: NOW - 86400000 }] }, NOW);
}
function startSourceFollowup(initial: ReturnType<typeof emptyState>, query: (shipment: Shipment, deadline?: number, signal?: AbortSignal) => Promise<AccountParcelDto | null>, signal?: AbortSignal) {
  return runShipmentEnrichmentForTesting(initial, "interface5", "source-home-test",
    (candidate, _routes, _stage, base) => commitRefreshState(base || initial, candidate, "interface5", NOW).state,
    NOW + 30000, new Set(), true, false, signal,
    { refreshAccountParcel: query, queryManualForSource: async () => { assert.fail("source-only must stop here"); } }, true, new Set(initial.shipments.map(value => value.identity.id)));
}

test("a populated account query advances status and history in its own cache", async () => {
  const initial = seedSource();
  const result = await startSourceFollowup(initial, async shipment => freshParcel(shipment));
  assert.equal(result.succeeded, 1);
  const stored = loadState(NOW).shipments[0];
  assert.equal(stored.timeline.latestDetail, "Fresh account event");
  assert.equal(stored.timeline.semantic, "DELIVERY");
  assert.equal(stored.sourceTimeline?.latestDetail, "Earlier carrier event", "query does not overwrite the feed slot");
});

test("Cainiao detail entry reuses the complete query committed by Home", async () => {
  const initial = seedSource();
  await startSourceFollowup(initial, async shipment => {
    const parcel = freshParcel(shipment);
    return { ...parcel, tracks: [...parcel.tracks,
      { timeMs: NOW - 86400000, timeText: "2026-09-07 14:00:00", detail: "已揽收", statusCode: "103", raw: {} },
    ] };
  });
  let queryCalls = 0;
  await runShipmentRefreshForTesting(initial.shipments[0].identity.id,
    { isCurrent: () => true }, { trigger: "detail_open" }, {
      refreshAccountParcel: async () => { queryCalls++; assert.fail("complete Home query must be reused"); },
      queryManualForSource: async () => { assert.fail("complete Home query must not enter manual providers"); },
    });
  assert.equal(queryCalls, 0);
  assert.equal(loadState(NOW).shipments[0].timeline.latestDetail, "Fresh account event");
});

for (const mutation of ["delete", "unbind", "cancel"] as const) {
  test(`late Home account response cannot undo ${mutation}`, async () => {
    const initial = seedSource(), controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const run = startSourceFollowup(initial, async shipment => { await gate; return freshParcel(shipment); }, controller.signal);
    const rejected = mutation === "cancel" ? assert.rejects(run) : null;
    await new Promise(resolve => setImmediate(resolve));
    if (mutation === "delete") saveState({ ...loadState(NOW), shipments: [] }, NOW);
    if (mutation === "unbind") removeBinding("interface5", "13800001234", NOW);
    if (mutation === "cancel") controller.abort();
    release();
    if (rejected) await rejected; else await run;
    assert.ok(loadState(NOW).shipments.every(shipment => shipment.timeline.latestDetail !== "Fresh account event"));
  });
}

test("Home and detail share one live account request while one cancelled consumer cannot cancel the other", async () => {
  const initial = seedSource(), controller = new AbortController();
  let calls = 0, transportSignal: AbortSignal | undefined, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const query = async (shipment: Shipment, _deadline?: number, signal?: AbortSignal) => {
    calls++; transportSignal = signal; await gate; return freshParcel(shipment);
  };
  const home = startSourceFollowup(initial, query, controller.signal);
  const rejected = assert.rejects(home);
  await new Promise(resolve => setImmediate(resolve));
  const detail = runShipmentRefreshForTesting(initial.shipments[0].identity.id,
    { isCurrent: () => true }, { trigger: "detail_open" }, { refreshAccountParcel: query });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  controller.abort();
  await rejected;
  assert.equal(transportSignal?.aborted, false);
  release();
  await detail;
  assert.equal(loadState(NOW).shipments[0].timeline.latestDetail, "Fresh account event");
});

const ACCOUNT_ORDER = "9999000011112222", PROJECTED_WAYBILL = "SYNTHETIC000001", ACCOUNT_PHONE = "13800000000";
const ACCOUNT_QUERY_DETAIL = "Synthetic fresh account detail";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function withAccountTransport(run: (transport: {
  initial: ReturnType<typeof emptyState>;
  stages: string[];
  accountStarted: ReturnType<typeof deferred>;
  accountReply: ReturnType<typeof deferred>;
  recognitionStarted: ReturnType<typeof deferred>;
  recognitionReply: ReturnType<typeof deferred>;
  home: () => ReturnType<typeof runShipmentEnrichmentForTesting>;
  detail: (signal?: AbortSignal) => ReturnType<typeof runShipmentRefreshForTesting>;
}) => Promise<void>) {
  memory.clear();
  const oldFetch = globalThis.fetch;
  const oldGenerateKey = Crypto.generateSymmetricKey, oldHmac = Crypto.hmacSHA256;
  Object.assign(Crypto, {
    generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
    hmacSHA256: (data: string, key: string) => ({
      toHexString: () => createHmac("sha256", key).update(data).digest("hex"),
    }),
  });
  saveGatewayToken("AbCdEfGh_123-456");
  const response = { code: 0, data: { mailNo: ACCOUNT_ORDER, provider: "JingDong", cpCode: "JD",
    name: "Synthetic carrier", stateNum: 105, normalizedStatusScope: "SHIPMENT", phone: ACCOUNT_PHONE,
    details: [
      { time: "2026-09-08 13:00:00", desc: ACCOUNT_QUERY_DETAIL, statusCode: 105 },
      { time: "2026-09-07 08:00:00", desc: "已揽收", statusCode: 103 },
    ] } };
  const parsed = parseAccountTimelineResponse("interface5", response, { waybill: ACCOUNT_ORDER })!;
  const shipment = applyAccountShipment(undefined, parcelToShipment({ ...parsed, waybill: PROJECTED_WAYBILL,
    tracks: [{ timeText: "2026-09-07 09:00:00", detail: "Synthetic feed-only event", statusCode: "104" }],
    semantic: "TRANSIT", sourceStateCode: "104" }, [ACCOUNT_PHONE], NOW)!, NOW);
  const initial = saveState({ ...emptyState(), shipments: [shipment], bindings: [
    { source: "interface5", phone: ACCOUNT_PHONE, boundAtMs: NOW - 86400000 },
  ] }, NOW);
  const stages: string[] = [], tasks: Promise<unknown>[] = [];
  const accountStarted = deferred(), accountReply = deferred();
  const recognitionStarted = deferred(), recognitionReply = deferred();
  const json = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    if (url.includes("autoComNum")) {
      stages.push("autoComNum");
      return json({ auto: [] });
    }
    if (url.includes("/api/express/classify")) {
      stages.push("worker_classify");
      recognitionStarted.resolve();
      await recognitionReply.promise;
      return json({ auto: [{ comCode: "zhongtong", name: "中通快递" }] });
    }
    const request = JSON.parse(init.body);
    assert.equal(request.mode, "detail", "only the existing account detail request is allowed");
    assert.equal(request.record.waybill, ACCOUNT_ORDER);
    stages.push("account_detail");
    accountStarted.resolve();
    await accountReply.promise;
    return json(response);
  }) as unknown as typeof fetch;
  const track = <T>(task: Promise<T>): Promise<T> => {
    tasks.push(task);
    void task.catch(() => {});
    return task;
  };
  try {
    await run({ initial, stages, accountStarted, accountReply, recognitionStarted, recognitionReply,
      home: () => track(runShipmentEnrichmentForTesting(initial, "interface5", "source-home-real-transport",
        (candidate, _routes, _stage, base) => commitRefreshState(base || initial, candidate, "interface5", NOW).state,
        NOW + 30000, new Set(), true, false, undefined,
        { queryManualForSource: async () => { assert.fail("source Home must not enter manual providers"); } }, true)),
      detail: signal => track(runShipmentRefreshForTesting(initial.shipments[0].identity.id,
        { isCurrent: () => true, signal }, { trigger: "detail_open" })),
    });
  } finally {
    accountReply.resolve();
    recognitionReply.resolve();
    await Promise.allSettled(tasks);
    globalThis.fetch = oldFetch;
    Object.assign(Crypto, { generateSymmetricKey: oldGenerateKey, hmacSHA256: oldHmac });
  }
}

test("JD Home starts no query or recognition even with a projected carrier", async () => {
  await withAccountTransport(async transport => {
    transport.accountReply.resolve();
    const result = await transport.home();
    assert.equal(result.attempted, 0);
    assert.deepEqual(transport.stages, []);
    const stored = loadState(NOW).shipments[0];
    assert.deepEqual(stored.manualTimelines, transport.initial.shipments[0].manualTimelines);
    assert.deepEqual(stored.sourceTimeline, transport.initial.shipments[0].sourceTimeline);
    assert.notEqual(stored.identity.courierCode, "ZTO");
  });
});

test("JD detail commits its account result and recognition while Home stays list-only", async () => {
  await withAccountTransport(async transport => {
    const detail = transport.detail(), home = transport.home();
    await transport.accountStarted.promise;
    transport.accountReply.resolve();
    await transport.recognitionStarted.promise;
    assert.equal((await home).attempted, 0);
    const raw = loadState(NOW).shipments[0];
    assert.equal(raw.manualTimelines?.find(pack => pack.provider === "v5_query")?.latestDetail, ACCOUNT_QUERY_DETAIL);
    assert.notEqual(raw.identity.courierCode, "ZTO", "the account result commits before recognition completes");
    transport.recognitionReply.resolve();
    await detail;
    assert.deepEqual(transport.stages, ["account_detail", "autoComNum", "worker_classify"]);
    const stored = loadState(NOW).shipments[0];
    assert.equal(stored.identity.courierCode, "ZTO");
    assert.equal(stored.identity.projectedWaybill, PROJECTED_WAYBILL);
    assert.equal(stored.manualTimelines?.find(pack => pack.provider === "v5_query")?.latestDetail, ACCOUNT_QUERY_DETAIL);
    assert.deepEqual(stored.sourceTimeline?.tracks, transport.initial.shipments[0].sourceTimeline?.tracks);
  });
});

test("cancelling JD detail recognition preserves its committed query without Home work", async () => {
  await withAccountTransport(async transport => {
    const controller = new AbortController();
    const detail = transport.detail(controller.signal), home = transport.home();
    const rejected = assert.rejects(detail);
    transport.accountReply.resolve();
    await transport.recognitionStarted.promise;
    assert.equal((await home).attempted, 0);
    const before = loadState(NOW).shipments[0];
    controller.abort();
    transport.recognitionReply.resolve();
    await rejected;
    const stored = loadState(NOW).shipments[0];
    assert.deepEqual(stored, before);
    assert.equal(stored.manualTimelines?.find(pack => pack.provider === "v5_query")?.latestDetail, ACCOUNT_QUERY_DETAIL);
    assert.notEqual(stored.identity.courierCode, "ZTO");
    assert.equal(transport.stages.filter(stage => stage === "account_detail").length, 1);
  });
});

for (const stage of ["account_response", "recognition"] as const) {
  for (const mutation of ["delete", "unbind"] as const) {
    test(`${mutation} during JD detail ${stage} prevents a late carrier write`, async () => {
      await withAccountTransport(async transport => {
        const detail = transport.detail(), home = transport.home();
        await transport.accountStarted.promise;
        if (stage === "recognition") {
          transport.accountReply.resolve();
          await transport.recognitionStarted.promise;
          await home;
        }
        if (mutation === "delete") removeShipment(transport.initial.shipments[0].identity.id, NOW);
        else removeBinding("interface5", ACCOUNT_PHONE, NOW);
        const preserved = loadState(NOW);
        transport.accountReply.resolve();
        transport.recognitionReply.resolve();
        const [detailResult, homeResult] = await Promise.allSettled([detail, home]);
        assert.equal(homeResult.status, "fulfilled", homeResult.status === "rejected" ? String(homeResult.reason) : undefined);
        assert.equal(detailResult.status, preserved.shipments.length ? "fulfilled" : "rejected");
        const stored = loadState(NOW);
        assert.deepEqual(stored.bindings, preserved.bindings);
        assert.deepEqual(stored.shipments, preserved.shipments);
        assert.ok(stored.shipments.every(shipment => shipment.identity.courierCode !== "ZTO"));
        assert.equal(transport.stages.filter(value => value === "account_detail").length, 1);
        if (stage === "account_response") assert.deepEqual(transport.stages, ["account_detail"]);
      });
    });
  }
}
