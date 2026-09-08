import assert from "node:assert/strict";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";
import {
  activeCarrierQueryRecords,
  installCarrierQueryRecords,
  resetCarrierQueryRecordsForTesting,
  resolveCarrierCpCode,
  resolveCarrierKuaidi100Code,
  resolveCarrierQuery,
} from "../services/carrier-query";

const records = EXPRESS_POLICY.carrierQuery.records;
assert.equal(records.length, 17);
assert.deepEqual(records.map((record) => [
  record.standardCode,
  record.displayName,
  record.kuaidi100Code,
  record.hotline,
  record.iconKey,
]), [
  ["SF", "顺丰速运", "shunfeng", "95338", "sf"],
  ["ZTO", "中通快递", "zhongtong", "95311", "zto"],
  ["ZTOKY", "中通快运", "zhongtongkuaiyun", "", "zto"],
  ["YTO", "圆通速递", "yuantong", "95554", "yto"],
  ["STO", "申通快递", "shentong", "95543", "sto"],
  ["YD", "韵达快递", "yunda", "95546", "yd"],
  ["JD", "京东快递", "jd", "950616", "jd"],
  ["JDKY", "京东快运", "jingdongkuaiyun", "950616", "jd"],
  ["EMS", "EMS", "ems", "11183", "ems"],
  ["YZPY", "邮政快递", "youzhengguonei", "11183", "yzpy"],
  ["JTSD", "极兔速递", "jtexpress", "956025", "jtsd"],
  ["HTKY", "极兔速递", "huitongkuaidi", "", "jtsd"],
  ["DBL", "德邦快递", "debangkuaidi", "95353", "dbl"],
  ["KYSY", "跨越速运", "kuayue", "95324", "kysy"],
  ["ZJS", "宅急送", "zhaijisong", "4006789000", "zjs"],
  ["UC", "优速快递", "youshuwuliu", "", "uc"],
  ["DANNIAO", "丹鸟速递", "danniao", "", "danniao"],
]);
assert.equal(resolveCarrierQuery("KYE"), null);
assert.equal(resolveCarrierQuery("JITU"), null);
assert.equal(resolveCarrierQuery("JDLEX"), null);
assert.equal(resolveCarrierCpCode("KYE")?.standardCode, "KYSY");
assert.equal(resolveCarrierCpCode("JITU")?.standardCode, "JTSD");
assert.equal(resolveCarrierCpCode("JDLEX")?.standardCode, "JD");
assert.equal(resolveCarrierQuery("JDKY")?.standardCode, "JDKY");
assert.equal(resolveCarrierCpCode("JDKY")?.standardCode, "JD");
assert.equal(resolveCarrierCpCode("JDVD")?.standardCode, "JD");
assert.equal(resolveCarrierCpCode("jd_future")?.standardCode, "JD");
assert.equal(resolveCarrierCpCode("VIVO_JD"), null);
assert.equal(resolveCarrierCpCode("J.DVD"), null);
assert.equal(resolveCarrierCpCode("J DVD"), null);
assert.equal(resolveCarrierCpCode("J.D.L.E.X"), null);
assert.equal(resolveCarrierCpCode("J D L E X"), null);
assert.equal(resolveCarrierCpCode("J&T")?.standardCode, "JTSD");
assert.equal(resolveCarrierQuery("JD")?.requiresPhoneTail, true);
assert.equal(resolveCarrierCpCode("J&T")?.standardCode, "JTSD");
assert.equal(resolveCarrierQuery("S-F"), null);
assert.equal(resolveCarrierQuery("J.D.L.E.X"), null);
assert.equal(resolveCarrierQuery("debangwuliu"), null);
assert.equal(resolveCarrierCpCode("debangwuliu")?.standardCode, "DBL");
assert.equal(resolveCarrierKuaidi100Code("debangwuliu")?.standardCode, "DBL");
assert.equal(
  resolveCarrierKuaidi100Code("debangwuliu")?.kuaidi100Code,
  "debangkuaidi",
);
assert.equal(resolveCarrierCpCode("EYB")?.standardCode, "EMS");
assert.equal(resolveCarrierCpCode("EYB")?.kuaidi100Code, "ems");
assert.equal(resolveCarrierCpCode("ZMKM")?.standardCode, "DANNIAO");
assert.equal(resolveCarrierCpCode("ZMKM")?.displayName, "丹鸟速递");
assert.equal(resolveCarrierCpCode("ZMKMKD")?.standardCode, "DANNIAO");
assert.deepEqual(
  records.find((record) => record.standardCode === "DANNIAO")?.aliases,
  ["ZMKM", "ZMKMKD"],
);
assert.equal(EXPRESS_POLICY.carrierIcons.aliases.ZMKM, "danniao");
assert.deepEqual(
  records.find((record) => record.standardCode === "DBL")?.kuaidi100CodeAliases,
  ["debangwuliu"],
);
assert.equal(resolveCarrierQuery("EMSGJ"), null);
assert.deepEqual(
  records.find((record) => record.standardCode === "YZPY")?.nameAliases,
  ["邮政", "邮政快递包裹", "中国邮政", "邮政国内标准", "邮政包裹", "包裹信件"],
);
assert.deepEqual(
  records.find((record) => record.standardCode === "DANNIAO")?.nameAliases,
  ["丹鸟", "丹鸟快递", "菜鸟速递", "菜鸟直送", "菜鸟直送(丹鸟)", "菜鸟直送（丹鸟）"],
);
assert.equal(
  records.find((record) => record.standardCode === "HTKY")?.displayName,
  "极兔速递",
);

// Field-level proof: K100 aliases remain usable even when the same spelling is
// absent from raw cpCode aliases, and they never leak into raw/internal lookup.
const k100OnlyDblAlias = activeCarrierQueryRecords().map((record) =>
  record.standardCode === "DBL"
    ? {
        ...record,
        aliases: record.aliases.filter(
          (alias) => alias.toUpperCase() !== "DEBANGWULIU",
        ),
      }
    : record
);
assert.equal(
  installCarrierQueryRecords(k100OnlyDblAlias, "field-level-k100-alias"),
  true,
);
assert.equal(resolveCarrierCpCode("debangwuliu"), null);
assert.equal(resolveCarrierQuery("debangwuliu"), null);
assert.equal(resolveCarrierKuaidi100Code("debangwuliu")?.standardCode, "DBL");
resetCarrierQueryRecordsForTesting();

console.log("built-in carrier catalog tests passed");
