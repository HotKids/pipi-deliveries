import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { memory } from "./state-storage-mock";
import { emptyState, saveState } from "../services/storage";
import { refreshAllShipments, refreshAllShipmentsForPull } from "../services/sync";
import { parseAccountSyncResult } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { applyAccountShipment } from "../services/shipment-policy";
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

function seed() {
  memory.clear();
  setDiagnosticsEnabled(true);
  const parsed = parseAccountSyncResult("interface5", { code: 0, data: { expressList: [record] } });
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
  seed();
  let other = 0;
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    if (path === "/api/express/accounts/sync") return json({ code: 0, data: { expressList: [record] } });
    other++;
    return { ok: false, status: 503, text: async () => "unexpected per-shipment request" };
  }) as typeof fetch;
  const { summary, completion } = await refreshAllShipmentsForPull("interface5", { accountOrderProjection: false });
  const finished = await completion;
  assert.equal(other, 0, "fixture premise: the unchanged list leaves no per-shipment request");
  assert.notEqual(summary.continuing, true, "nothing continues in the background");
  assert.equal(summary, finished);
  assert.notEqual(refreshSummaryToast(summary), EXPRESS_TOAST_COPY.refreshContinuing);
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
  assert.equal(EXPRESS_TOAST_COPY.refreshContinuing, "列表已更新，轨迹在后台继续更新");
  assert.equal(refreshSummaryToast({ attempted: 1, succeeded: 0, failed: 1, continuing: true }),
    EXPRESS_TOAST_COPY.refreshFailed);
  assert.equal(refreshSummaryToast({ attempted: 2, succeeded: 1, failed: 1, continuing: true }),
    EXPRESS_TOAST_COPY.listUpdated);
  assert.equal(refreshSummaryToast({ attempted: 0, succeeded: 0, failed: 0, continuing: true }),
    EXPRESS_TOAST_COPY.refreshContinuing);
  assert.equal(refreshSummaryToast({ attempted: 0, succeeded: 0, failed: 0 }),
    EXPRESS_TOAST_COPY.refreshUpToDate);
});
