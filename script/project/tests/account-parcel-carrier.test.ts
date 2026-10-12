import assert from "node:assert/strict";
import { parseAccountSyncResponse, type AccountParcelDto } from "../services/account-parser";
import { prepareAccountParcelCarrier, withAccountOrderTextWaybill } from "../services/account-sync";
import { accountOrderTextIdentity } from "../services/account-order-text-identity";
import type { CarrierRecognitionResult } from "../services/carrier-recognition";

// Wave 3 (iOS): the carrier of every account parcel with a real waybill comes from the built-in table,
// then the free K100 recognition and the existing paid fallback.
//  - Audit C2 (adopted 2026-09-25): ordinary account rows go through the helper too, not only orders.
//  - R-20 on every JD business source (user decision 2026-09-26, Pipi 十二条 2).
//  - Audit C9 (adopted 2026-09-25): the Worker's code is used, the name comes from the local table.
//  - 其余裁决 7 (user decision 2026-09-26): Xiaomi's order text supplies the waybill only.

function parcel(input: Partial<AccountParcelDto> = {}): AccountParcelDto {
  return {
    source: "interface5", ownerId: "JT4006839564547", waybill: "JT4006839564547", orderId: "",
    accountOrder: false, courierCode: "JDKD", rawCourierCode: "JDKD", rawCompanyName: "京东快递",
    companyName: "京东快递", carrierNormalization: null, sourceProvider: "JingDong",
    sourceStateCode: "104", sourceStateText: "运输中", semantic: "TRANSIT", receiverPhone: "13800001515",
    senderPhone: "", latestTimeText: "2026-09-03 17:49:00", latestDetail: "运输中", tracks: [],
    routeUrl: "", projectionUrl: "", ...input,
  };
}

function recognizer(standardCode: string, displayName: string, kuaidi100Code: string) {
  const calls: string[] = [];
  const recognize = async (waybill: string): Promise<CarrierRecognitionResult> => {
    calls.push(waybill);
    return { normalization: { standardCode, displayName, kuaidi100Code, isBuiltIn: true, tableVersion: "t" },
      terminal: false, pendingSecondLevel: false, coolingDown: false };
  };
  return { calls, recognize };
}

// C2 + R-20: an ordinary JD-source row (not an order) whose JT waybill carries only the platform code.
{
  const { calls, recognize } = recognizer("JTSD", "极兔速递", "jtexpress");
  const prepared = await prepareAccountParcelCarrier(parcel(), { recognize });
  assert.deepEqual(calls, ["JT4006839564547"], "the JD platform label is no carrier evidence: recognize");
  assert.equal(prepared.courierCode, "JTSD");
  assert.equal(prepared.companyName, "极兔速递");
  assert.equal(prepared.rawCourierCode, "JDKD", "raw source fields are never rewritten");
}

// A real JD waybill keeps its table carrier without any request.
{
  const prepared = await prepareAccountParcelCarrier(
    parcel({ ownerId: "JDVD10645984010", waybill: "JDVD10645984010" }),
    { recognize: async () => { throw new Error("a JD waybill must not be recognized"); } },
  );
  assert.equal(prepared.courierCode, "JD");
}

// C9: the Worker's standard code, the local table's name.
{
  const prepared = await prepareAccountParcelCarrier(parcel({
    ownerId: "SF1234567890123", waybill: "SF1234567890123", sourceProvider: "ShunFeng",
    courierCode: "SF", rawCourierCode: "SF", rawCompanyName: "顺丰", companyName: "顺丰快递（旧表名）",
    carrierNormalization: { standardCode: "SF", displayName: "顺丰快递（旧表名）", kuaidi100Code: "shunfeng",
      isBuiltIn: true, tableVersion: "worker-old" },
  }), { recognize: async () => { throw new Error("a table carrier needs no recognition"); } });
  assert.equal(prepared.courierCode, "SF");
  assert.equal(prepared.companyName, "顺丰速运");
}

// C9 at parse time too: a Worker sidecar names the code; the displayed name is the local table's.
{
  const parsed = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [{
    mailNo: "SF1234567890124", provider: "ShunFeng", cpCode: "SF", name: "顺丰", phone: "13800001515", stateNum: 104,
    normalizedCarrierCode: "SF", normalizedCarrierName: "顺丰快递（旧表名）", carrierBuiltIn: true,
  }] } })[0];
  assert.equal(parsed.courierCode, "SF");
  assert.equal(parsed.companyName, "顺丰速运");
  assert.equal(parsed.carrierNormalization?.displayName, "顺丰快递（旧表名）", "the Worker envelope itself is kept");
}

// 其余裁决 7: an unprojected order whose text names 中通快递 and a waybill. The waybill is applied, the
// order-stage tuple is dropped, and the carrier is whatever recognition answers, not the text.
{
  const tracks = [{ timeText: "2026-09-08 11:00:00", statusCode: "",
    detail: "您的订单由第三方卖家拣货完成，待出库交付中通快递，运单号为 75600000001844" }];
  const order = parcel({ ownerId: "3610000000001844", waybill: "3610000000001844", orderId: "3610000000001844",
    accountOrder: true, companyName: "京东购物", rawCompanyName: "京东商品快递", tracks,
    textIdentity: accountOrderTextIdentity(tracks) });
  // T23 (user 2026-09-26, 其余裁决 28): the text waybill is shown only once a carrier matched it. With nothing
  // recognised yet the order stays as it is (old expectation: the waybill applied with an empty carrier).
  const applied = withAccountOrderTextWaybill(order);
  assert.equal(applied, order, "no matched carrier: the order keeps its own identity");
  const { calls, recognize } = recognizer("YTO", "圆通速递", "yuantong");
  const prepared = await prepareAccountParcelCarrier(order, { recognize });
  assert.deepEqual(calls, ["75600000001844"]);
  assert.equal(prepared.waybill, "75600000001844");
  assert.equal(prepared.courierCode, "YTO", "the carrier comes from recognition, never from the text");
  assert.equal(prepared.companyName, "圆通速递");
  assert.deepEqual([prepared.rawCourierCode, prepared.rawCompanyName], ["", ""],
    "the order-stage raw tuple is not carried to the carrier waybill");
  assert.equal(prepared.ownerId, "3610000000001844", "the order identity is unchanged");
}

console.log("account parcel carrier tests passed");
