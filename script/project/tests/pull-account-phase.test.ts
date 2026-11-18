import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { memory } from "./state-storage-mock";
import { emptyState, loadState, saveState } from "../services/storage";
import { refreshAllShipments, refreshAllShipmentsForPull } from "../services/sync";
import { parseAccountSyncResult } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { applyAccountShipment, cainiaoHasTrajectoryGap } from "../services/shipment-policy";
import { listHeadline } from "../services/status";
import { saveGatewayToken } from "../services/credentials";
import { setDiagnosticsEnabled } from "../services/logger";
import { refreshSummaryToast } from "../services/ui-feedback";
import { EXPRESS_TOAST_COPY } from "../services/express-toast-copy";

// E1 (owner 2026-11-10): the express list pull is answered once the account phase is stored; the
// per-shipment work goes on in the same refresh in the background.

const NOW = Date.UTC(2026, 8, 12, 6), PHONE = "13800000000";
const OLD = "2026-09-12 08:00:00", NEW = "2026-09-12 10:00:00";
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({ toHexString: () => createHmac("sha256", key).update(value).digest("hex") }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(Data, { fromFile: () => null });
Object.assign(globalThis, {
  Notification: { schedule: async () => undefined }, Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class { constructor() { assert.fail("the pull never opens WebView here"); } },
});
const json = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
const record = {
  mailNo: "YT9990000000011", provider: "CaiNiao", cpCode: "YTO", name: "Synthetic carrier", phone: PHONE,
  stateNum: 104, details: [{ time: OLD, desc: "快递状态已更新，点击查看>>" }],
};
// The list reports a change, so the refresh's enrichment queries this shipment's detail.
const changed = { ...record, stateNum: 105, details: [{ time: NEW, desc: "快递状态已更新，点击查看>>" }] };

function seed(...records: typeof record[]) {
  memory.clear();
  setDiagnosticsEnabled(true);
  const parsed = parseAccountSyncResult("interface5", { code: 0, data: { expressList: records.length ? records : [record] } });
  const shipments = parsed.parcels.map(parcel => applyAccountShipment(undefined,
    parcelToShipment(parcel, [PHONE], NOW - 3600000)!, NOW - 3600000));
  saveState({ ...emptyState(), shipments,
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 }],
    feedSlotRebuiltAtMs: NOW - 86400000 }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
}

test("the pull resolves after the account phase while per-shipment work is still running", async () => {
  seed();
  let releaseDetail!: () => void;
  const detailHeld = new Promise<void>(resolve => { releaseDetail = resolve; });
  let detailStarted = false;
  let lists = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    if (path === "/api/cloud-records/pdd-shipments") return json({ ok: true, parcels: [], nextAfter: null });
    if (path === "/api/express/accounts/sync") {
      lists++;
      return json({ code: 0, data: { expressList: [changed] } });
    }
    assert.equal(path, "/api/express/timeline/source");
    const request = JSON.parse(String(init.body));
    assert.equal(request.interface, "v5");
    detailStarted = true;
    await detailHeld;
    return json({ code: 0, data: { ...changed, details: [
      { time: NEW, desc: "query 实际物流事件" }, { time: "2026-09-12 07:00:00", desc: "已揽收" },
    ] } });
  }) as typeof fetch;

  const pulled = refreshAllShipmentsForPull("interface5", { accountOrderProjection: false });
  let answered = false;
  const answer = pulled.then((value) => { answered = true; return value; });
  // Let the account phase run; the detail request it starts stays held.
  for (let tick = 0; tick < 200 && !(answered && detailStarted); tick++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  try {
    assert.equal(detailStarted, true, "the changed shipment's detail request is under way");
    assert.equal(answered, true, "the pull must be answered before the held per-shipment request finishes");
    const { summary, completion } = await answer;
    assert.equal(lists, 1);
    assert.equal(summary.continuing, true);
    assert.equal(summary.attempted, 1, "only the account part is counted");
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 0);
    assert.equal(refreshSummaryToast(summary), EXPRESS_TOAST_COPY.refreshContinuing);
    // A second pull while the first one's background work runs joins it and is answered at once.
    const again = await refreshAllShipmentsForPull("interface5", { accountOrderProjection: false });
    assert.equal(again.completion, completion, "a repeated pull shares the refresh in flight");
    assert.equal(again.summary, summary);
    releaseDetail();
    const finished = await completion;
    assert.equal(finished.continuing, undefined, "the whole refresh reports its own counts");
    assert.ok(finished.attempted > summary.attempted, "the held request counts in the whole refresh");
  } finally {
    releaseDetail();
    await (await answer).completion.catch(() => undefined);
  }
});

test("a pull with no per-shipment work left is answered once with the whole refresh (PF5)", async () => {
  const ready = { ...record, details: [{ time: OLD, desc: "已到达转运中心" }] };
  seed(ready);
  let other = 0;
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    if (path === "/api/cloud-records/pdd-shipments") return json({ ok: true, parcels: [], nextAfter: null });
    if (path === "/api/express/accounts/sync") return json({ code: 0, data: { expressList: [ready] } });
    other++;
    return { ok: false, status: 503, text: async () => "unexpected per-shipment request" };
  }) as typeof fetch;
  const { summary, completion } = await refreshAllShipmentsForPull("interface5", { accountOrderProjection: false });
  const finished = await completion;
  assert.equal(other, 0, "fixture premise: the unchanged list leaves no per-shipment request");
  assert.notEqual(summary.continuing, true, "nothing continues in the background");
  assert.equal(summary, finished);
  assert.equal(refreshSummaryToast(summary), "刷新完成");
});

test("a pull restores a missing Cainiao headline even when the list status and event time stay the same", async () => {
  const picked = { ...record, stateNum: 103 };
  const absent = { ...picked, mailNo: "YT9990000000022" };
  const headline = "快件已揽收";
  seed(picked, absent);
  const shipmentId = `interface5:account:${picked.mailNo}`;
  const before = loadState(NOW).shipments.find(row => row.identity.id === shipmentId);
  assert.ok(before);
  assert.equal(before.timeline.semantic, "PICKED");
  assert.ok(before.timeline.statusEventAtMs);
  assert.equal(before.timeline.latestDetail, "");
  assert.equal(before.timeline.latestTimeText, "");
  let detailRequests = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    if (path === "/api/cloud-records/pdd-shipments") return json({ ok: true, parcels: [], nextAfter: null });
    if (path === "/api/express/accounts/sync") return json({ code: 0, data: { expressList: [picked] } });
    assert.equal(path, "/api/express/timeline/source");
    detailRequests++;
    const request = JSON.parse(String(init.body));
    assert.equal(request.interface, "v5");
    assert.equal(request.mode, "detail");
    assert.equal(request.record.waybill, picked.mailNo);
    return json({ code: 0, data: { ...picked, details: [{ time: OLD, desc: headline }] } });
  }) as typeof fetch;
  const { completion } = await refreshAllShipmentsForPull("interface5", { accountOrderProjection: false });
  await completion;
  assert.equal(detailRequests, 1, "only the account item returned by this list refresh is queried");
  const after = loadState(NOW).shipments.find(row => row.identity.id === shipmentId);
  assert.equal(after?.timeline.semantic, "PICKED");
  assert.equal(after?.timeline.latestDetail, headline);
  assert.equal(after?.timeline.latestTimeText, OLD);
  assert.equal(after?.timeline.statusEventAtMs, before.timeline.statusEventAtMs);
});

test("a pull whose account phase failed is answered with that failure", async () => {
  seed();
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    return { ok: false, status: 503, text: async () => "Synthetic unavailable" };
  }) as typeof fetch;
  const { summary, completion } = await refreshAllShipmentsForPull("interface5", { accountOrderProjection: false });
  const finished = await completion;
  // Answered at the account phase (the refresh goes on with its stored rows), or — when it stopped there —
  // with the whole refresh; either way the failed account list is what the toast reports.
  if (summary.continuing) {
    assert.equal(summary.succeeded, 0);
    assert.ok(summary.failed > 0);
  } else {
    assert.equal(summary, finished);
  }
  assert.equal(refreshSummaryToast(summary), EXPRESS_TOAST_COPY.refreshFailed);
});

test("a failed account list still lets a pull restore a cached bound shipment's missing headline", async () => {
  const picked = { ...record, stateNum: 103 };
  seed(picked);
  let queried = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    if (path === "/api/express/accounts/sync") return { ok: false, status: 502, text: async () => "Synthetic upstream unavailable" };
    assert.equal(path, "/api/express/timeline/source");
    assert.equal(JSON.parse(String(init.body)).record.waybill, picked.mailNo);
    queried++;
    return json({ code: 0, data: { ...picked, details: [{ time: OLD, desc: "快件已揽收" }] } });
  }) as typeof fetch;
  const { summary, completion } = await refreshAllShipmentsForPull("interface5", { accountOrderProjection: false });
  assert.equal(summary.failed, 1);
  assert.equal(summary.succeeded, 0);
  assert.equal(refreshSummaryToast(summary), EXPRESS_TOAST_COPY.refreshFailed);
  const finished = await completion;
  assert.equal(queried, 1);
  assert.equal(finished.succeeded, 1);
  assert.equal(loadState(NOW).shipments[0].timeline.latestDetail, "快件已揽收");
});

test("a scheduled refresh repairs missing bound Cainiao headlines after a recoverable list failure", async () => {
  const picked = { ...record, stateNum: 103 };
  const cached = { ...picked, mailNo: "YT9990000000022",
    details: [{ time: OLD, desc: "原有真实揽收轨迹" }] };
  seed(picked, cached);
  const requests: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    if (path === "/api/express/accounts/sync") return { ok: false, status: 502, text: async () => "Synthetic upstream unavailable" };
    assert.equal(path, "/api/express/timeline/source");
    requests.push(JSON.parse(String(init.body)).record.waybill);
    return json({ code: 0, data: { ...picked, details: [{ time: OLD, desc: "快件已揽收" }] } });
  }) as typeof fetch;

  const result = await refreshAllShipments("interface5", { backgroundHostSafe: true });
  assert.deepEqual(requests, [picked.mailNo], "only the bound parcel missing an observation needs a query");
  assert.equal(result.failed, 1, "the account-list failure remains visible to the caller");
  const reloaded = loadState(NOW).shipments.find(row => row.identity.sourceId === picked.mailNo);
  assert.equal(reloaded?.timeline.latestDetail, "快件已揽收");
  assert.equal(reloaded?.timeline.latestTimeText, OLD);
});

test("a real same-state pickup observation fills a new row even when the feed summary clock is later", async () => {
  const summary = { ...record, stateNum: 103,
    details: [{ time: NEW, desc: "快递状态已更新，点击查看>>" }] };
  seed(summary);
  let queried = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    if (path === "/api/express/accounts/sync") return json({ code: 0, data: { expressList: [summary] } });
    assert.equal(path, "/api/express/timeline/source");
    assert.equal(JSON.parse(String(init.body)).record.waybill, summary.mailNo);
    queried++;
    return json({ code: 0, data: { ...summary, details: [{ time: OLD, desc: "快件已揽收", statusCode: 103 }] } });
  }) as typeof fetch;

  const { completion } = await refreshAllShipmentsForPull("interface5", { accountOrderProjection: false });
  const result = await completion;
  assert.equal(queried, 1);
  assert.equal(result.failed, 1, "recovering an observed headline does not certify clock alignment");
  const reloaded = loadState(NOW).shipments[0];
  assert.equal(reloaded.timeline.latestDetail, "快件已揽收");
  assert.equal(reloaded.timeline.latestTimeText, OLD, "show the pickup time from the same node");
  assert.equal(reloaded.timeline.semantic, "PICKED");
  assert.equal(reloaded.sourceTimeline?.latestTimeText, NEW, "the original feed summary clock stays separate");
  assert.equal(cainiaoHasTrajectoryGap(reloaded, NOW), true);
});

for (const [nodeStatus, recovers] of [[103, true], [104, false], [undefined, false]] as const) {
  test(`a detail without a packet status recovers the first headline only from a matching dated node (${nodeStatus})`, async () => {
    const feed = { ...record, stateNum: 103,
      details: [{ time: NEW, desc: "快递状态已更新，点击查看>>" }] };
    seed(feed);
    const before = loadState(NOW).shipments[0];
    assert.equal(listHeadline(before.timeline), null);
    assert.equal(before.timeline.semantic, "PICKED");
    const event = { time: OLD, desc: "快件已由网点揽收", statusCode: nodeStatus };
    let queried = 0;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
      if (path === "/api/express/accounts/sync") return json({ code: 0, data: { expressList: [feed] } });
      assert.equal(path, "/api/express/timeline/source");
      assert.equal(JSON.parse(String(init.body)).record.waybill, feed.mailNo);
      queried++;
      return json({ code: 0, data: { ...feed, stateNum: undefined, details: [event] } });
    }) as typeof fetch;

    const { completion } = await refreshAllShipmentsForPull("interface5", { accountOrderProjection: false });
    await completion;
    assert.equal(queried, 1);
    const after = loadState(NOW).shipments[0];
    assert.equal(after.timeline.semantic, "PICKED");
    assert.equal(after.timeline.statusEventAtMs, before.timeline.statusEventAtMs);
    assert.equal(after.sourceTimeline?.latestTimeText, NEW);
    assert.deepEqual(listHeadline(after.timeline), recovers ? { detail: event.desc, timeText: OLD } : null);
  });
}

test("an ordinary forced refresh still resolves with the whole refresh", async () => {
  seed();
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    if (path === "/api/express/accounts/sync") return json({ code: 0, data: { expressList: [record] } });
    return json({ code: 0, data: { ...record } });
  }) as typeof fetch;
  const summary = await refreshAllShipments("interface5", { forceManualRefresh: true, accountOrderProjection: false });
  assert.notEqual(summary.continuing, true, "only the pull API answers early");
});

test("the continuing toast keeps failure precedence and the four-client copy", () => {
  assert.equal(EXPRESS_TOAST_COPY.refreshContinuing, "列表已更新");
  assert.equal(refreshSummaryToast({ attempted: 1, succeeded: 0, failed: 1, continuing: true }),
    EXPRESS_TOAST_COPY.refreshFailed);
  assert.equal(refreshSummaryToast({ attempted: 2, succeeded: 1, failed: 1, continuing: true }),
    EXPRESS_TOAST_COPY.listUpdated);
  assert.equal(refreshSummaryToast({ attempted: 0, succeeded: 0, failed: 0, continuing: true }),
    EXPRESS_TOAST_COPY.refreshContinuing);
  assert.equal(refreshSummaryToast({ attempted: 0, succeeded: 0, failed: 0 }),
    EXPRESS_TOAST_COPY.refreshUpToDate);
});
