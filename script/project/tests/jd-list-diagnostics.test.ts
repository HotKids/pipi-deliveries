import assert from "node:assert/strict";
import { test } from "node:test";
import type { Shipment } from "../models";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";
import { emptyState, loadState, saveState } from "../services/storage";
import { refreshAllShipments } from "../services/sync";
import { parseAccountSyncResult } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { applyAccountShipment, applyTargetedAccountShipment, asAccountDetailObservation } from "../services/shipment-policy";
import { parseProviderTime } from "../services/status";
import { saveGatewayToken } from "../services/credentials";
import { diagnosticText, readDiagnostics, setDiagnosticsEnabled, writeDiagnostic } from "../services/logger";

const PHONE = "13800000000", SECOND_PHONE = "13900000000";
const OLD = "2026-09-08 08:00:00", NEW = "2026-09-08 10:00:00";
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
  WebViewController: class { constructor() { assert.fail("list diagnostics must not open WebView"); } },
});
const record = (mailNo: string, cpCode: string, stateNum = 105, time = OLD) => ({
  mailNo, cpCode, provider: "JingDong", name: "Synthetic carrier", phone: PHONE,
  stateNum, normalizedStatusScope: "SHIPMENT", details: [{ time, desc: "Synthetic carrier event" }],
});
type Row = ReturnType<typeof record>;
async function run(before: Row[], after: Row[], phones = [PHONE], enabled = true,
  seed: (shipment: Shipment) => Shipment = shipment => shipment) {
  memory.clear();
  const parcels = parseAccountSyncResult("interface5", { code: 0, data: { expressList: before } }).parcels;
  saveState({ ...emptyState(), shipments: parcels.map(parcel => seed(applyAccountShipment(undefined,
    parcelToShipment(parcel, phones, NOW - 3600000)!, NOW - 3600000))),
    bindings: phones.map(phone => ({ source: "interface5" as const, phone, boundAtMs: NOW - 86400000 })),
    feedSlotRebuiltAtMs: NOW - 86400000 }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
  setDiagnosticsEnabled(enabled);
  let lists = 0;
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "Synthetic offline authority" };
    assert.equal(path, "/api/express/accounts/sync", "list diagnostics cannot substitute query or another provider");
    lists++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { expressList: after } }) };
  }) as typeof fetch;
  const result = await refreshAllShipments("interface5", { forceManualRefresh: true, accountOrderProjection: false });
  assert.equal(lists, 1);
  assert.equal(result.failed, 0);
  return { stored: loadState(NOW), entries: readDiagnostics().filter(entry => entry.event === "account.list.record") };
}

test("JD list diagnostics trace carrier completion through parsing, preparation, merge and commit without a detail query", async () => {
  const before = [record("JD1234567974", "JD"), record("SF1234563374", "SF"), record("1234567897379", "ZTO")];
  const result = await run(before, before.map(row => ({ ...row, stateNum: 107, details: [{ time: NEW, desc: "Synthetic delivered event" }] })));
  assert.equal(result.entries.length, 3);
  for (const entry of result.entries) {
    const d = entry.details;
    assert.equal(d.listStateNumber, 107);
    assert.equal(d.listStatusScope, "SHIPMENT");
    assert.equal(d.listStatusSemantic, "COMPLETED");
    assert.equal(d.preparedStatusSemantic, "COMPLETED");
    assert.equal(d.previousFeedStatusSemantic, "DELIVERY");
    assert.equal(d.mergedFeedStatusSemantic, "COMPLETED");
    assert.equal(d.feedStatusSemantic, "COMPLETED");
    assert.equal(d.statusSemantic, "COMPLETED");
    assert.equal(d.bindingMatched, true);
    assert.equal(d.result, "stored");
    assert.ok(d.revision! > 0);
  }
  assert.ok(result.stored.shipments.every(row => row.timeline.semantic === "COMPLETED"));
  const text = diagnosticText();
  for (const value of [PHONE, ...before.map(row => row.mailNo), "Synthetic delivered event"]) assert.ok(!text.includes(value));
});

// Build 123 reports 107/ORDER for all three rows, then prepares the previous 105.
// ORDER describes the list's order-number identity; node prose and identities here
// are synthetic, not a replay of an unseen device response body.
for (const signedQuery of [false, true]) {
  test(`order-key JD list completion reaches the stored feed with ${signedQuery ? "a previously signed query" : "only an active feed"}`, async () => {
    const before = [
      ["9999000011110001", "JD1234567974", "京东快递"],
      ["9999000011110002", "SF1234563374", "顺丰速运"],
      ["9999000011110003", "1234567897379", "中通快递"],
    ].map(([order, waybill, carrier]) => ({ ...record(order, "JDKD"), normalizedStatusScope: "ORDER",
      details: [{ time: OLD, desc: `交付${carrier}，运单号为${waybill}` }] }));
    const after = before.map(row => ({ ...row, stateNum: 107,
      details: [{ time: NEW, desc: "Synthetic carrier delivery confirmation" }] }));
    const { entries, stored } = await run(before, after, [PHONE], true, current => {
      if (!signedQuery) return current;
      const dto = parseAccountSyncResult("interface5", { code: 0, data: { expressList: [{
        ...after.find(row => row.mailNo === current.identity.sourceId)!, normalizedStatusScope: "SHIPMENT",
      }] } }).parcels[0]!;
      const incoming = parcelToShipment({ ...dto, waybill: current.identity.projectedWaybill! }, [PHONE], NOW - 1000)!;
      return applyTargetedAccountShipment(current, asAccountDetailObservation(current, incoming), NOW - 1000);
    });
    assert.equal(entries.length, 3);
    for (const entry of entries) {
      const d = entry.details;
      assert.equal(d.listStateNumber, 107);
      assert.equal(d.listStatusScope, "ORDER");
      assert.equal(d.listStatusSemantic, "COMPLETED");
      assert.equal(d.preparedStatusSemantic, "COMPLETED", `${d.waybillTail}: the list completion must survive projection`);
      assert.equal(d.previousFeedStatusSemantic, "DELIVERY");
      assert.equal(d.mergedFeedStatusSemantic, "COMPLETED");
      assert.equal(d.feedStatusSemantic, "COMPLETED");
      assert.equal(d.statusSemantic, "COMPLETED");
      assert.equal(d.preparedEventAtMs, parseProviderTime(NEW));
      assert.equal(d.mergedFeedEventAtMs, parseProviderTime(NEW));
      assert.equal(d.result, "stored");
    }
    for (const row of stored.shipments) {
      assert.equal(row.sourceTimeline?.semantic, "COMPLETED");
      assert.equal(row.sourceTimeline?.statusEventAtMs, parseProviderTime(NEW));
      assert.equal(row.timeline.semantic, "COMPLETED");
      assert.equal(row.accountRecord?.waybill, row.identity.sourceId);
      assert.ok(row.identity.projectedWaybill);
      assert.equal(row.manualTimelines?.some(pack => pack.provider === "v5_query") || false, signedQuery);
    }
  });
}

test("an older completion response is distinguished from an upstream DELIVERY packet", async () => {
  const row = record("SF1234563374", "SF");
  const { entries } = await run([row], [{ ...row, stateNum: 107, details: [{ time: "2026-09-08 07:00:00", desc: "Synthetic older completion" }] }]);
  assert.equal(entries.length, 1);
  const d = entries[0].details;
  assert.equal(d.listStatusSemantic, "COMPLETED");
  assert.equal(d.preparedStatusSemantic, "COMPLETED");
  assert.equal(d.mergedFeedStatusSemantic, "DELIVERY");
  assert.equal(d.feedStatusSemantic, "DELIVERY");
  assert.ok(d.listEventAtMs! < d.previousFeedEventAtMs!);
});

test("a received row with no matching binding is visible in diagnostics without becoming a new owner", async () => {
  const row = record("JD1234567974", "JD");
  const { entries, stored } = await run([row], [{ ...row, phone: "", stateNum: 107 }], [PHONE, SECOND_PHONE]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].details.bindingMatched, false);
  assert.equal(entries[0].details.listStateNumber, 107);
  assert.equal(entries[0].details.feedStatusSemantic, "DELIVERY");
  assert.equal(stored.shipments.length, 1);
});

test("order-review completion removed during projection is distinguished from the parsed list status", async () => {
  const order = "9999000011112222", waybill = "SF1234563374";
  const row = { ...record(order, "JDKD"), normalizedStatusScope: "ORDER", details: [
    { time: OLD, desc: `交付顺丰速运，运单号为${waybill}` },
  ] };
  const { entries } = await run([row], [{ ...row, stateNum: 107, details: [
    { time: NEW, desc: `您的订单${order}已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。` },
  ] }]);
  assert.equal(entries.length, 1);
  const d = entries[0].details;
  assert.equal(d.waybillTail, "3374");
  assert.equal(d.listStatusScope, "ORDER");
  assert.equal(d.listStatusSemantic, "COMPLETED");
  assert.equal(d.preparedStatusSemantic, "DELIVERY");
  assert.equal(d.feedStatusSemantic, "DELIVERY");
  assert.ok(d.listEventAtMs! > d.preparedEventAtMs!);
});

test("diagnostics disabled leaves the same list update and produces no per-record entries", async () => {
  const row = record("SF1234563374", "SF");
  const result = await run([row], [{ ...row, stateNum: 107, details: [{ time: NEW, desc: "Synthetic delivered" }] }], [PHONE], false);
  assert.equal(result.entries.length, 0);
  assert.equal(result.stored.shipments[0].timeline.semantic, "COMPLETED");
});

test("an omitted cached JD row is logged separately from a received unchanged row", async () => {
  const { entries, stored } = await run([record("SF1234563374", "SF")], []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].details.result, "omitted");
  assert.equal(entries[0].details.listStateNumber, undefined);
  assert.equal(entries[0].details.feedStatusSemantic, "DELIVERY");
  assert.equal(stored.shipments[0].timeline.semantic, "DELIVERY");
});

test("new list diagnostic fields accept only status enums and the documented numeric state range", () => {
  memory.clear();
  setDiagnosticsEnabled(true);
  writeDiagnostic("account.list.record", { listStateNumber: Number(PHONE), listStatusScope: "private-scope",
    listStatusSemantic: "private-value", preparedStatusSemantic: "private-value",
    previousFeedStatusSemantic: "private-value", mergedFeedStatusSemantic: "private-value",
    feedStatusSemantic: "private-value" } as never);
  const d = readDiagnostics()[0].details;
  for (const key of ["listStateNumber", "listStatusScope", "listStatusSemantic", "preparedStatusSemantic",
    "previousFeedStatusSemantic", "mergedFeedStatusSemantic", "feedStatusSemantic"]) assert.ok(!(key in d));
});
