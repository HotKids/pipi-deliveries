import assert from "node:assert/strict";
import { carrierDisplayName } from "../services/carrier-presentation";
import { resolveCarrierQuery } from "../services/carrier-query";
import { queryKuaidi100Shipment, queryMotoShipment } from "../services/manual-query";

// 2026-10-08 user decision #9 (「显示和写入都先查表」): a carrier name that resolves in the built-in table is shown
// and stored as the table's visible name; upstream names only stand for off-table carriers. Synthetic data only.
const NOW = Date.UTC(2026, 9, 8, 2, 0, 0);

assert.equal(carrierDisplayName("邮政快递包裹"), "邮政快递", "an upstream alias displays as the table name");
assert.equal(carrierDisplayName(" 邮政快递包裹 "), "邮政快递");
assert.equal(carrierDisplayName("中通"), "中通快递");
assert.equal(carrierDisplayName("邮政EMS"), "EMS", "EMS keeps its own table identity");
assert.equal(carrierDisplayName("EMS"), "EMS");
assert.equal(carrierDisplayName("某某同城快运"), "某某同城快运", "an off-table name is shown as it is");
assert.equal(carrierDisplayName("JDKD"), "JDKD", "a raw code is not a table name");
assert.equal(carrierDisplayName(""), "快递");

const moto = await queryMotoShipment({
  waybill: "YZ9000000000001",
  rawCourierCode: "YZPY",
  bindingSource: "interface5",
  dependencies: {
    now: () => NOW,
    post: async () => ({
      status: 0,
      data: {
        cpCode: "YZPY",
        cpName: "邮政快递包裹",
        logisticsStatus: "TRANSPORT",
        fullTraceDetail: [{ time: "2026-10-08 09:00:00", desc: "快件已到达处理中心" }],
      },
    }),
  },
});
assert.equal(moto.identity.companyName, "邮政快递", "Moto's cpName alias is stored as the table name");
assert.equal(moto.timeline.courierCode, "YZPY");

const k100InTable = await queryKuaidi100Shipment({
  waybill: "DBL9000000000001",
  rawCourierCode: "DBL",
  bindingSource: "interface5",
  dependencies: {
    now: () => NOW,
    post: async () => ({
      status: "200",
      com: "debangwuliu",
      companyName: "德邦物流股份",
      data: [{ time: "2026-10-08 09:10:00", context: "快件运输中" }],
    }),
  },
});
assert.equal(k100InTable.identity.companyName, resolveCarrierQuery("DBL")?.displayName,
  "a table carrier's K100 upstream name never replaces the table name");
assert.notEqual(k100InTable.identity.companyName, "德邦物流股份");

const k100OffTable = await queryKuaidi100Shipment({
  waybill: "DBL9000000000002",
  rawCourierCode: "DBL",
  bindingSource: "interface5",
  dependencies: {
    now: () => NOW,
    post: async () => ({
      status: "200",
      com: "mouaxyzkuaiyun",
      companyName: "某某同城快运",
      data: [{ time: "2026-10-08 09:20:00", context: "快件运输中" }],
    }),
  },
});
assert.equal(k100OffTable.identity.companyName, "某某同城快运",
  "an off-table carrier keeps the upstream name");

console.log("carrier table-name-first tests passed");
