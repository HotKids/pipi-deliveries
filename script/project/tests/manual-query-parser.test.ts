import assert from "node:assert/strict";
import {
  explicitKuaidi100Failure,
  kuaidi100NoTrackYet,
  kuaidi100PhoneRejected,
  parseKuaidi100Timeline,
  rejectKuaidi100Response,
} from "../services/manual-query-parser";
import {
  queryPhoneTails,
  resolveCarrierQuery,
} from "../services/carrier-query";

const completed = parseKuaidi100Timeline({
  state: "3",
  data: [{
    time: "2026-08-26 14:00:00",
    context: "快件已送达代收点",
    statusCode: "501",
    areaCode: "440300",
  }],
});
assert.equal(completed.semantic, "COMPLETED");
assert.equal(completed.hasTimedTracking, true);
assert.equal(completed.tracks[0].statusCode, "501");
assert.equal(completed.tracks[0].raw.statusCode, "501");
assert.equal(completed.tracks[0].raw.areaCode, "440300");
assert.equal(completed.tracks[0].raw._pipiStatusSource, "kuaidi100");

const statusOnlyNewest = parseKuaidi100Timeline({
  data: [
    {
      time: "2026-08-26 14:00:00",
      statusCode: "501",
      logisticsStatus: "AGENT_SIGN",
    },
    {
      time: "2026-08-26 13:00:00",
      context: "快件到达营业点",
      statusCode: "0",
    },
  ],
});
assert.equal(statusOnlyNewest.semantic, "WAITING_PICKUP");
assert.equal(statusOnlyNewest.hasTimedTracking, true);
assert.equal(statusOnlyNewest.latestDetail, "快件到达营业点");
assert.equal(statusOnlyNewest.tracks[0].raw.logisticsStatus, "AGENT_SIGN");

const noUsableEvent = parseKuaidi100Timeline({
  state: "3",
  data: [{ time: "2026-08-26 14:00:00", statusCode: "501" }],
});
assert.equal(noUsableEvent.semantic, "WAITING_PICKUP");
assert.equal(noUsableEvent.hasTimedTracking, false);
assert.equal(noUsableEvent.hasRealTracking, false);

const providerError = parseKuaidi100Timeline({
  data: [{
    time: "2026-08-26 14:00:00",
    context: "验证码错误，请重试",
    statusCode: "0",
  }],
});
assert.equal(providerError.hasTimedTracking, false);
assert.equal(providerError.hasRealTracking, false);
assert.equal(providerError.latestDetail, "");
assert.equal(providerError.semantic, "UNKNOWN");

assert.equal(explicitKuaidi100Failure({ result: false, returnCode: "201" }), true);
assert.equal(kuaidi100NoTrackYet({ result: false, returnCode: "201" }), false);
assert.equal(explicitKuaidi100Failure({ result: false, returnCode: "500", data: [] }), true);
assert.equal(kuaidi100NoTrackYet({ result: false, returnCode: "500", data: [] }), true);
assert.equal(kuaidi100PhoneRejected({ returnCode: "408" }), true);
assert.equal(kuaidi100PhoneRejected({ message: "请输入手机尾号" }), true);
assert.equal(explicitKuaidi100Failure({ result: "true", returnCode: "200" }), false);
assert.equal(
  rejectKuaidi100Response({
    result: false,
    returnCode: "500",
    message: "请输入手机尾号",
    data: [],
  }),
  true,
);

const shunfeng = resolveCarrierQuery("shunfeng");
const yuantong = resolveCarrierQuery("YTO");
assert.equal(shunfeng?.requiresPhoneTail, true);
assert.deepEqual(queryPhoneTails(yuantong, "", ["8098"]), ["", "8098"]);
assert.deepEqual(queryPhoneTails(shunfeng, "", ["1515"]), ["1515"]);
assert.deepEqual(queryPhoneTails(yuantong, "7773", ["8098"]), ["", "7773", "8098"]);
assert.deepEqual(queryPhoneTails(shunfeng, "1515", ["8098", "1515"]), ["1515", "8098"]);
assert.equal(resolveCarrierQuery("VIVO_SF")?.standardCode, "SF");

console.log("manual query parser and carrier policy tests passed");
