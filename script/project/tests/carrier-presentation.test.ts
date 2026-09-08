import assert from "node:assert/strict";
import {
  builtInCarrierPresentation,
  courierHotline,
  courierIconName,
  projectedCarrierPresentation,
} from "../services/carrier-presentation";

assert.equal(courierIconName("SF", ""), "sf");
assert.equal(courierIconName("shunfeng", ""), "sf");
assert.equal(courierIconName("VIVO_SF", ""), "default");
assert.equal(courierIconName("YOUZHENGBK", ""), "yzpy");
assert.equal(courierIconName("KYE", ""), "kysy");
assert.equal(courierIconName("JITU", ""), "jtsd");
assert.equal(courierIconName("ZMKM", ""), "danniao");
assert.equal(courierIconName("ZMKMKD", ""), "danniao");
assert.equal(courierIconName("", "极兔速递"), "jtsd");
assert.deepEqual(
  builtInCarrierPresentation("极兔"),
  { courierCode: "JTSD", companyName: "极兔速递" },
);
assert.deepEqual(
  builtInCarrierPresentation("百世"),
  { courierCode: "HTKY", companyName: "极兔速递" },
);
assert.deepEqual(
  builtInCarrierPresentation("极兔速递"),
  { courierCode: "JTSD", companyName: "极兔速递" },
);
assert.deepEqual(
  projectedCarrierPresentation("ZMKM123456789", "ZMKM", ""),
  { courierCode: "DANNIAO", companyName: "丹鸟速递" },
);
assert.equal(courierIconName("", "邮政快递包裹"), "yzpy");
assert.equal(courierIconName("HTKY", "百世快递"), "jtsd");
assert.equal(courierIconName("BEST", "百世"), "jtsd");
assert.equal(courierIconName("JTSD", "极兔速递"), "jtsd");
assert.equal(courierIconName("JD", "京东快递", true), "jdshopping");
assert.deepEqual(
  projectedCarrierPresentation(
    "JD0256747737308",
    "SF",
    "顺丰速运",
  ),
  { courierCode: "SF", companyName: "顺丰速运" },
);
assert.deepEqual(
  projectedCarrierPresentation("SF0256747737309", "JD", "京东购物"),
  { courierCode: "", companyName: "快递" },
);
assert.equal(courierIconName("UNKNOWN", "未知快递"), "default");
assert.equal(courierIconName("EMSGJ", "EMS国际"), "default");
assert.equal(courierHotline("JD", "京东快递"), "950616");
assert.equal(courierHotline("shunfeng", ""), "95338");
assert.equal(courierHotline("", "邮政快递包裹"), "11183");
assert.equal(courierHotline("ZTOKY", "中通快运"), "");
assert.equal(courierHotline("HTKY", "百世快递"), "");
assert.equal(courierHotline("UNKNOWN", "未知快递"), "");

console.log("carrier presentation contract tests passed");
