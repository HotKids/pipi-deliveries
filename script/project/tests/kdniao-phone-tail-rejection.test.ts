import assert from "node:assert/strict";
import { GatewayError } from "../services/gateway";
import { queryKdniaoShipment } from "../services/manual-query";

// User 2026-10-02 「补：全不对时提示重新输入」: the Worker gives a KDNiao phone-tail rejection the code
// `phone_verification_required`. A rejected tail moves on to the next one; only when every tail was
// rejected does the query ask for the tail again. Synthetic waybill and tails.
const NOW = Date.UTC(2026, 9, 2, 8, 0, 0);
const WAYBILL = "SF0000000000001";

function rejection() {
  return new GatewayError("请输入正确的手机尾号", 200, "phone_verification_required");
}

function success() {
  return {
    success: true,
    state: "2",
    logisticCode: WAYBILL,
    shipperCode: "SF",
    traces: [{ acceptTime: "2026-10-01 09:00:00", acceptStation: "快件已揽收", action: "1" }],
  };
}

{
  const tried: string[] = [];
  const shipment = await queryKdniaoShipment({
    waybill: WAYBILL, rawCourierCode: "SF", phoneTail: "1111", phoneTails: ["2222", "3333"],
    dependencies: { now: () => NOW, post: async (_path, payload) => {
      tried.push(String(payload.phone));
      if (payload.phone !== "3333") throw rejection();
      return success();
    } },
  });
  assert.deepEqual(tried, ["1111", "2222", "3333"], "a rejected tail moves on to the next one");
  assert.equal(shipment.timeline.provider, "kdniao");
  assert.equal(shipment.identity.phoneTail, "1111", "tracking does not replace an explicit tail with a trial candidate");
}

{
  const tried: string[] = [];
  await assert.rejects(queryKdniaoShipment({
    waybill: WAYBILL, rawCourierCode: "SF", phoneTail: "1111", phoneTails: ["2222"],
    dependencies: { now: () => NOW, post: async (_path, payload) => {
      tried.push(String(payload.phone));
      throw rejection();
    } },
  }), (error: unknown) => error instanceof Error
    && error.message === "手机尾号不正确，请重新输入"
    && (error as { needsPhoneTail?: boolean }).needsPhoneTail === true,
  "every tail rejected: ask for the tail again");
  assert.deepEqual(tried, ["1111", "2222"]);
}

{
  const tried: string[] = [];
  await assert.rejects(queryKdniaoShipment({
    waybill: WAYBILL, rawCourierCode: "SF", phoneTail: "1111", phoneTails: ["2222"],
    dependencies: { now: () => NOW, post: async (_path, payload) => {
      tried.push(String(payload.phone));
      throw new GatewayError("查询失败", 200, "upstream_business_error");
    } },
  }), (error: unknown) => error instanceof GatewayError
    && error.gatewayCode === "upstream_business_error",
  "another KDNiao failure is not a tail problem");
  assert.deepEqual(tried, ["1111"], "another failure stops at the first tail, as before");
}

{
  const tried: string[] = [];
  const shipment = await queryKdniaoShipment({
    waybill: WAYBILL, rawCourierCode: "SF", phoneTails: ["2222"],
    dependencies: { now: () => NOW, post: async (_path, payload) => {
      tried.push(String(payload.phone));
      return success();
    } },
  });
  assert.deepEqual(tried, [""], "a no-tail query precedes all bound candidates");
  assert.equal(shipment.identity.phoneTail, "", "a no-tail result does not acquire a bound phone");
}

{
  const tried: string[] = [];
  const shipment = await queryKdniaoShipment({
    waybill: WAYBILL, rawCourierCode: "SF", phoneTails: ["2222"],
    dependencies: { now: () => NOW, post: async (_path, payload) => {
      tried.push(String(payload.phone));
      if (!payload.phone) throw rejection();
      return success();
    } },
  });
  assert.deepEqual(tried, ["", "2222"], "an explicit upstream requirement permits the bound retry");
  assert.equal(shipment.identity.phoneTail, "", "cached tracking cannot prove a candidate's ownership");
}

{
  const tried: string[] = [];
  const shipment = await queryKdniaoShipment({
    waybill: WAYBILL, rawCourierCode: "SF", phoneTails: [],
    dependencies: { now: () => NOW, post: async (_path, payload) => {
      tried.push(String(payload.phone));
      return success();
    } },
  });
  assert.deepEqual(tried, [""], "no bindings must not block a no-tail query");
  assert.equal(shipment.timeline.provider, "kdniao");
}

for (const reason of ["手机端查询服务暂不可用", "手机端查询服务错误", "请求签名校验失败", "查询失败"]) {
  const tried: string[] = [];
  await assert.rejects(queryKdniaoShipment({
    waybill: WAYBILL, rawCourierCode: "SF", phoneTails: ["2222"],
    dependencies: { now: () => NOW, post: async (_path, payload) => {
      tried.push(String(payload.phone));
      return { success: false, reason };
    } },
  }), (error: unknown) => error instanceof Error
    && (error as { needsPhoneTail?: boolean }).needsPhoneTail === false);
  assert.deepEqual(tried, [""], "generic failures do not try bound phone candidates");
}

for (const reason of ["收寄件人手机号后四位校验不通过", "手机尾号校验失败"]) {
  const tried: string[] = [];
  const shipment = await queryKdniaoShipment({
    waybill: WAYBILL, rawCourierCode: "SF", phoneTails: ["1111", "2222"],
    dependencies: { now: () => NOW, post: async (_path, payload) => {
      tried.push(String(payload.phone));
      if (!payload.phone) return { success: false, reason: "请输入手机尾号" };
      if (payload.phone === "1111") return { success: false, reason };
      return success();
    } },
  });
  assert.deepEqual(tried, ["", "1111", "2222"], "explicit phone validation rejection permits the next candidate");
  assert.equal(shipment.identity.phoneTail, "", "a successful trial still cannot assign the phone identity");
}

{
  const tried: string[] = [];
  const shipment = await queryKdniaoShipment({
    waybill: WAYBILL, rawCourierCode: "SF", phoneTails: ["2222"],
    dependencies: { now: () => NOW, post: async (_path, payload) => {
      tried.push(String(payload.phone));
      if (!payload.phone) return { ...success(), traces: [], reason: "CustomerName is required" };
      return success();
    } },
  });
  assert.deepEqual(tried, ["", "2222"]);
  assert.equal(shipment.identity.phoneTail, "");
}

{
  const tried: string[] = [];
  const shipment = await queryKdniaoShipment({
    waybill: WAYBILL, rawCourierCode: "SF", phoneTails: ["2222"],
    dependencies: { now: () => NOW, post: async (_path, payload) => {
      tried.push(String(payload.phone));
      return { ...success(), traces: [] };
    } },
  });
  assert.deepEqual(shipment.timeline.tracks, []);
  assert.equal(shipment.identity.phoneTail, "");
  assert.deepEqual(tried, [""], "an empty result alone is not a request for phone verification");
}

console.log("KDNiao phone-tail rejection tests passed");
