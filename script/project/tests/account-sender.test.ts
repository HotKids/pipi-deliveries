import assert from "node:assert/strict";
import { parseAccountSyncResponse } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { applyAccountShipment, applyTargetedAccountShipment, asAccountDetailObservation } from "../services/shipment-policy";

const PHONE = "13800001515";
const OTHER = "13900002626";
const NOW = Date.UTC(2026, 8, 12, 8);

function parcel(sendPhone: string) {
  return parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [{
    mailNo: "SFTEST123456", companyCode: "SF", companyName: "顺丰速运",
    provider: "shunfeng", phone: PHONE, sendPhone, state: 102,
    details: [{ time: "2026-09-12 15:00:00", context: "快件运输中" }],
  }] } })[0]!;
}

// Xiaomi ExpressUtils.isSelfSend checks exact membership in the bound phone list.
const sender = parcelToShipment(parcel(PHONE), [PHONE], NOW)!;
assert.equal(sender.identity.sender, true, "list sender evidence must reach presentation identity");
for (const sendPhone of ["", OTHER, "1515", "138****1515"]) {
  assert.equal(parcelToShipment(parcel(sendPhone), [PHONE], NOW)!.identity.sender, false,
    "receiver membership and partial sender phone evidence do not establish a sender");
}
assert.equal(parcelToShipment({ ...parcel(OTHER), receiverPhone: "" }, [PHONE, OTHER], NOW)!.identity.sender, true,
  "sender evidence can match another bound phone");
assert.equal(parcelToShipment(parcel(OTHER), [PHONE, OTHER], NOW), null,
  "the sender badge must not bypass existing ambiguous ownership rejection");

const queryWithoutSender = parcelToShipment(parcel(""), [PHONE], NOW + 1)!;
const refreshed = applyTargetedAccountShipment(sender,
  asAccountDetailObservation(sender, queryWithoutSender), NOW + 1);
assert.equal(refreshed.identity.sender, true, "query history must not erase the list sender flag");
const received = parcelToShipment(parcel(OTHER), [PHONE], NOW + 2)!;
assert.equal(applyAccountShipment(refreshed, received, NOW + 2).identity.sender, false,
  "new list evidence must replace the prior sender flag");
console.log("account sender tests passed");
