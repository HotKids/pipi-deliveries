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
  assert.equal(shipment.identity.phoneTail, "3333", "the accepted tail is the one kept");
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

console.log("KDNiao phone-tail rejection tests passed");
