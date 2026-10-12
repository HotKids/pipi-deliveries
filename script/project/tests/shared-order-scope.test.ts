import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAccountSyncResponse } from "../services/account-parser";

// Audit L6 (adopted 2026-09-25): order row versus shipment row, read from the Worker-generated shared
// cases. iOS reads only Interface 5 (v5). A row carrying the Worker's scope and a row stored before the
// scope existed (local rule) give the Worker's answer; prose naming the number is no evidence (default #3).
const shared = JSON.parse(readFileSync(
  new URL("./fixtures/express/order-scope-cases.v1.json", import.meta.url), "utf8"));
const v5 = shared.cases.filter((item: { interface: string }) => item.interface === "v5");
assert.ok(v5.length >= 10);
for (const item of v5) {
  const expected = item.expected.scope === "ORDER";
  for (const row of [{ ...item.row, normalizedStatusScope: item.expected.scope }, item.row]) {
    const parcel = parseAccountSyncResponse("interface5", {
      code: 0, data: { expressList: [{ ...row, details: [{ time: "2026-09-24 10:00:00",
        desc: `您的订单${row.mailNo}已完成，感谢您对京东的支持。` }] }] },
    })[0];
    assert.equal(parcel.accountOrder, expected,
      `${item.provenance} (${row.normalizedStatusScope ? "Worker scope" : "local rule"})`);
  }
}

console.log("shared order scope tests passed");
