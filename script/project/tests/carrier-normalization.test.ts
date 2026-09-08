import assert from "node:assert/strict";
import { parseCarrierNormalization } from "../services/carrier-normalization";

assert.deepEqual(parseCarrierNormalization({
  normalizedCarrierCode: "SF",
  normalizedCarrierName: "顺丰速运",
  carrierBuiltIn: true,
}), {
  standardCode: "SF",
  displayName: "顺丰速运",
  kuaidi100Code: "",
  isBuiltIn: true,
  tableVersion: "",
});

assert.deepEqual(parseCarrierNormalization({
  carrierNormalization: {
    standardCode: "sf",
    displayName: "顺丰速运",
    kuaidi100Code: "SHUNFENG",
    isBuiltIn: true,
    tableVersion: "catalog@abc123",
  },
}), {
  standardCode: "SF",
  displayName: "顺丰速运",
  kuaidi100Code: "shunfeng",
  isBuiltIn: true,
  tableVersion: "catalog@abc123",
});

assert.deepEqual(parseCarrierNormalization({
  normalizedCarrierCode: "JD",
  normalizedCarrierName: "京东快递",
  carrierBuiltIn: true,
  carrierNormalization: {
    standardCode: "SF",
    displayName: "顺丰速运",
    isBuiltIn: true,
  },
}), {
  standardCode: "JD",
  displayName: "京东快递",
  kuaidi100Code: "",
  isBuiltIn: true,
  tableVersion: "",
});

assert.deepEqual(parseCarrierNormalization({
  standardCode: "JDKY",
  displayName: "京东快运",
  kuaidi100Code: "jingdongkuaiyun",
  isBuiltIn: true,
  tableVersion: "legacy-1",
}), {
  standardCode: "JDKY",
  displayName: "京东快运",
  kuaidi100Code: "jingdongkuaiyun",
  isBuiltIn: true,
  tableVersion: "legacy-1",
});

assert.deepEqual(parseCarrierNormalization({
  carrierNormalization: {
    standardCode: "",
    displayName: "",
    kuaidi100Code: "",
    isBuiltIn: false,
  },
}, {
  carrierNormalization: { tableVersion: "catalog@unknown" },
}), {
  standardCode: "",
  displayName: "",
  kuaidi100Code: "",
  isBuiltIn: false,
  tableVersion: "catalog@unknown",
});

assert.equal(parseCarrierNormalization({ cpCode: "RAW" }), null);
assert.deepEqual(parseCarrierNormalization({
  carrierNormalization: {
    standardCode: "SF",
    displayName: "顺丰速运",
    kuaidi100Code: "shunfeng",
    isBuiltIn: true,
  },
}), {
  standardCode: "SF",
  displayName: "顺丰速运",
  kuaidi100Code: "shunfeng",
  isBuiltIn: true,
  tableVersion: "",
});

console.log("carrier normalization adapter tests passed");
