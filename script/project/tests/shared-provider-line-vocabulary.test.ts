import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./state-storage-mock";
import type { Shipment, TimelinePackage } from "../models";
import { parseAccountSyncResult } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { selectShipmentDetailTimeline, selectShipmentTimeline } from "../services/shipment-policy";
import { TRANSIT_TIME_REMINDER, isAccountUpdateSummary, isProviderErrorDetail, parseProviderTime } from "../services/status";

// Provider placeholder and error lines (audits D2/X4 with the user instruction of 2026-09-12, restated
// 2026-09-26), read from the Worker-generated shared vocabulary. `kept`: the line stays in the data;
// `displayed`: a surface may show it as a timeline node or headline. The update placeholder in all four
// forms is kept but never displayed, on every source.
const shared = JSON.parse(readFileSync(
  new URL("./fixtures/express/provider-line-vocabulary.v1.json", import.meta.url), "utf8"));
const PHONE = "13800000000";
const FRESH = "2026-09-12 10:00:00", OLD = "2026-09-12 08:00:00";

assert.equal(shared.vocabulary.updateSummaryPattern, "^快递状态已更新(?:[，,]点击查看(?:>>)?)?$");
assert.ok(shared.cases.some((item: { line: string }) => item.line === "快递状态已更新，点击查看"),
  "the form without >> is covered");
// The transit-time reminder is in the same shared vocabulary (user 2026-10-01, item 6, on top of 2026-09-28
// 「加进占位清单」): iOS matches exactly that pattern, and its four forms are cases of the placeholder class.
assert.equal(TRANSIT_TIME_REMINDER.source, shared.vocabulary.transitTimeReminderPattern);
assert.equal(shared.cases.filter((item: { line: string }) =>
  TRANSIT_TIME_REMINDER.test(item.line.replace(/\s+/g, ""))).length, 4, "both commas, with and without >>");

function feedRow(provider: string, line: string): Shipment {
  const parcel = parseAccountSyncResult("interface5", { code: 0, data: { expressList: [{
    mailNo: "SYNTHETICVOCAB0001", provider, cpCode: provider === "ShunFeng" ? "SF" : "YTO",
    name: "Synthetic carrier", phone: PHONE, stateNum: 104,
    details: [{ time: FRESH, desc: line }, { time: OLD, desc: "Earlier real event" }],
  }] } }).parcels[0];
  return parcelToShipment(parcel, [PHONE], Date.UTC(2026, 8, 12, 6))!;
}

function manualRow(line: string): Shipment {
  const pack: TimelinePackage = {
    provider: "k100_h5", waybill: "YT0000000000001", courierCode: "YTO", companyName: "圆通速递",
    semantic: "UNKNOWN", statusEventAtMs: null, latestTimeText: FRESH, latestDetail: line,
    tracks: [FRESH, OLD].map((time, index) => ({ timeText: time, timeMs: parseProviderTime(time),
      detail: index ? "Earlier real event" : line, statusCode: "", raw: {} })),
    successAtMs: Date.UTC(2026, 8, 12, 6), complete: false,
  };
  return {
    identity: { id: "interface5:manual:YT0000000000001", bindingSource: "interface5", sourceOwner: "manual",
      sourceId: "YT0000000000001", phoneTail: "", phone: "", courierCode: "YTO", companyName: "圆通速递",
      manuallyAdded: true, createdAtMs: Date.UTC(2026, 8, 12, 0) },
    timeline: pack, sourceTimeline: null, manualTimelines: [pack], route: null, accountRecord: null,
    updatedAtMs: Date.UTC(2026, 8, 12, 6),
  };
}

for (const item of shared.cases) {
  const { line, kept, displayed } = item;
  assert.equal(isProviderErrorDetail(line), !kept, `${line}: an error line is dropped`);
  assert.equal(isAccountUpdateSummary(line), item.class === "updateSummary", `${line}: placeholder`);
  if (!kept) continue;
  for (const row of [feedRow("JingDong", line), feedRow("ShunFeng", line), feedRow("CaiNiao", line),
    manualRow(line)]) {
    const label = `${line} (${row.identity.manuallyAdded ? "manual" : row.identity.sourceProvider})`;
    const list = selectShipmentTimeline(row);
    const detail = selectShipmentDetailTimeline(row);
    assert.equal(list.latestDetail, displayed ? line : "Earlier real event", `${label}: headline`);
    assert.equal(list.tracks.some(track => track.detail === line), displayed, `${label}: list node`);
    assert.equal(detail.tracks.some(track => track.detail === line), displayed, `${label}: detail node`);
    if (!row.identity.manuallyAdded) {
      assert.ok(row.sourceTimeline?.tracks.some(track => track.detail === line), `${label}: kept in the data`);
    }
  }
}

console.log("shared provider line vocabulary tests passed");
