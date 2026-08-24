import assert from "node:assert/strict";
import {
  courierHotline,
  courierIconName,
  projectedCarrierPresentation,
} from "../services/carrier-presentation";

assert.equal(courierIconName("SF", ""), "sf");
assert.equal(courierIconName("shunfeng", ""), "sf");
assert.equal(courierIconName("VIVO_SF", ""), "sf");
assert.equal(courierIconName("YOUZHENGBK", ""), "yzpy");
assert.equal(courierIconName("", "邮政快递包裹"), "yzpy");
assert.equal(courierIconName("HTKY", "百世快递"), "");
assert.equal(courierIconName("BEST", "百世"), "");
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
assert.equal(courierIconName("UNKNOWN", "未知快递"), "");
assert.equal(courierHotline("JD", "京东快递"), "950616");
assert.equal(courierHotline("shunfeng", ""), "95338");
assert.equal(courierHotline("", "邮政快递包裹"), "11183");
assert.equal(courierHotline("ZTOKY", "中通快运"), "");
assert.equal(courierHotline("HTKY", "百世快递"), "");
assert.equal(courierHotline("UNKNOWN", "未知快递"), "");

console.log("carrier presentation contract tests passed");
