import assert from "node:assert/strict";
import { test } from "node:test";
import { memory } from "./state-storage-mock";
import { parseAccountSyncResult } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { applyAccountShipment, selectShipmentDetailTimeline, selectShipmentTimeline } from "../services/shipment-policy";
import { emptyState, loadState, saveState } from "../services/storage";
import { isAccountUpdateSummary, isProviderErrorDetail, parseProviderTime } from "../services/status";
import type { Shipment } from "../models";

// 用户 2026-09-28「加进占位清单」：「您有包裹运输时效变化，请留意取件安排」（全角或半角逗号，结尾带不带「 >>」）与
// 「快递状态已更新」占位同样处理：不当节点、不当头条，列表与通知显示上一条真节点。只认这一句，别的「…>>」照常显示。
const NOW = Date.UTC(2026, 8, 12, 6), PHONE = "13800000000";
const REMINDER_AT = "2026-09-12 10:00:00", REAL_AT = "2026-09-12 08:00:00", REAL = "快件已到达【测试转运中心】";
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });
const REMINDERS = [
  "您有包裹运输时效变化，请留意取件安排",
  "您有包裹运输时效变化，请留意取件安排 >>",
  "您有包裹运输时效变化，请留意取件安排>>",
  "您有包裹运输时效变化,请留意取件安排 >>",
  "您有包裹运输时效变化,请留意取件安排",
];

function packet(details: { time: string; desc: string }[]): Shipment {
  const parcel = parseAccountSyncResult("interface5", { code: 0, data: { expressList: [{
    mailNo: "YT9990000000021", provider: "CaiNiao", cpCode: "YTO", name: "圆通速递", phone: PHONE,
    stateNum: 103, details,
  }] } }).parcels[0];
  return parcelToShipment(parcel, [PHONE], NOW)!;
}

function stored(row: Shipment): Shipment {
  memory.clear();
  saveState({ ...emptyState(), shipments: [row],
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 }],
    feedSlotRebuiltAtMs: NOW - 86400000 }, NOW);
  return loadState(NOW).shipments[0]!;
}

for (const reminder of REMINDERS) test(`the transit-time reminder is a placeholder: ${reminder}`, () => {
  assert.equal(isAccountUpdateSummary(reminder), true);
  assert.equal(isProviderErrorDetail(reminder), false);
  const row = stored(applyAccountShipment(undefined, packet([
    { time: REMINDER_AT, desc: reminder },
    { time: REAL_AT, desc: REAL },
  ]), NOW));
  const listed = selectShipmentTimeline(row);
  assert.equal(listed.latestDetail, REAL, "the list headline is the previous real node");
  assert.equal(listed.latestTimeText, REAL_AT);
  assert.deepEqual(listed.tracks.map((track) => track.detail), [REAL], "the reminder is no node");
  assert.deepEqual(selectShipmentDetailTimeline(row).tracks.map((track) => track.detail), [REAL]);
  assert.equal(row.timeline.latestDetail, REAL, "the persisted headline the notification reads");
  assert.equal(row.timeline.statusEventAtMs, parseProviderTime(REMINDER_AT));
});

test("only that sentence family: other lines, 「…>>」 included, stay ordinary nodes", () => {
  for (const line of ["您有包裹运输时效变化，请留意取件安排，详情见短信", "快件已到达【测试站】 >>"]) {
    assert.equal(isAccountUpdateSummary(line), false, line);
  }
});
