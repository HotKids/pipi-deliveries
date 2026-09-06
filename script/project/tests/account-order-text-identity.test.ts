import assert from "node:assert/strict";

import { accountOrderTextIdentity } from "../services/account-order-text-identity";

const shipped = {
  detail: "您的订单由第三方卖家拣货完成，待出库交付极兔速递，运单号为JT4006839564547",
};
const picked = {
  detail: "【DK江门维达网点】的谭秀文（18128210371）已取件,物流问题请联系：0750-2484284为您解决",
};

// Newest-first track order: the shipped message is older than the pickup message.
const identity = accountOrderTextIdentity([picked, shipped, { detail: "最快9月3日发货" }]);
assert.deepEqual(identity, {
  waybill: "JT4006839564547",
  courierCode: "JTSD",
  companyName: "极兔速递",
});

// JD-fulfilled orders never name a waybill in the text: the H5 projection stays responsible.
assert.equal(
  accountOrderTextIdentity([
    { detail: "您的快件已由京东快递揽收" },
    { detail: "订单已出库，正在等待配送" },
  ]),
  null,
);

// Unknown carrier names keep the raw name so carrier recognition can still resolve it later.
assert.deepEqual(
  accountOrderTextIdentity([{ detail: "待出库交付某某物流，运单号为 AB12345678" }]),
  { waybill: "AB12345678", courierCode: "", companyName: "某某物流" },
);

// Malformed or absent numbers are ignored.
assert.equal(accountOrderTextIdentity([{ detail: "运单号为 12" }]), null);
assert.equal(accountOrderTextIdentity(null), null);

console.log("account order text identity tests passed");
