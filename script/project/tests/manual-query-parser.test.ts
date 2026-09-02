import assert from "node:assert/strict";
import {
  explicitKuaidi100Failure,
  kuaidi100NoTrackYet,
  kuaidi100PhoneRejected,
  parseKdniaoTimeline,
  parseKuaidi100Timeline,
  parseMeizuTimeline,
  parseMotoTimeline,
  rejectKuaidi100Response,
} from "../services/manual-query-parser";

const meizu = parseMeizuTimeline({
  state: "2",
  stateName: "运输中",
  time: "2026-08-30 17:15:00",
  context: "快件到达魅族 Picker 网点",
});
assert.equal(meizu.tracks.length, 1);
assert.equal(meizu.tracks[0]?.raw._pipiStatusSource, "meizu");
assert.equal(meizu.hasTimedTracking, true);
assert.equal(meizu.hasStructuredStatus, false);

const nestedMeizu = parseMeizuTimeline({
  code: 200,
  value: JSON.stringify({
    data: {
      manual: JSON.stringify({
        complete: true,
        tracks: [
          {
            time: "2026-08-30 09:00:00",
            context: "运输中",
            status: "TRANSIT",
          },
          {
            time: "2026-08-30 13:00:00",
            context: "待取件",
            status: "AGENT_SIGN",
          },
        ],
      }),
    },
  }),
});
assert.equal(nestedMeizu.tracks.length, 2);
assert.equal(nestedMeizu.semantic, "WAITING_PICKUP");
assert.equal(nestedMeizu.statusEventAtMs, Date.UTC(2026, 7, 30, 5, 0, 0));
assert.equal(nestedMeizu.latestTimeText, "2026-08-30 13:00:00");
assert.equal(nestedMeizu.latestDetail, "待取件");
assert.equal(nestedMeizu.tracks[0]?.raw._pipiStatusSource, "meizu");
assert.equal(nestedMeizu.hasStructuredStatus, false);

const meizuProviderError = parseMeizuTimeline({
  time: "2026-09-02 10:45:00",
  message: "验证码错误，请重试",
  status: "SIGN",
});
assert.equal(meizuProviderError.tracks.length, 0);
assert.equal(meizuProviderError.hasTimedTracking, false);
assert.equal(meizuProviderError.hasRealTracking, false);
assert.equal(meizuProviderError.latestDetail, "");
assert.equal(meizuProviderError.semantic, "UNKNOWN");
assert.equal(meizuProviderError.statusEventAtMs, null);

const rootMeizuProviderErrorWithRealSibling = parseMeizuTimeline({
  time: "2026-09-02 10:45:00",
  message: "验证码错误，请重试",
  status: "SIGN",
  data: {
    tracks: [{
      time: "2026-09-02 10:46:00",
      context: "快件运输中",
    }],
  },
});
assert.equal(rootMeizuProviderErrorWithRealSibling.tracks.length, 1);
assert.equal(rootMeizuProviderErrorWithRealSibling.latestDetail, "快件运输中");
assert.equal(rootMeizuProviderErrorWithRealSibling.semantic, "UNKNOWN");
assert.equal(rootMeizuProviderErrorWithRealSibling.statusEventAtMs, null);

const mixedMeizuProviderError = parseMeizuTimeline({
  value: JSON.stringify({
    manual: {
      tracks: [
        {
          time: "2026-09-02 10:45:00",
          message: "验证码错误，请重试",
          status: "SIGN",
        },
        {
          time: "2026-09-02 10:46:00",
          context: "快件运输中",
          status: "TRANSIT",
        },
      ],
    },
  }),
});
assert.equal(mixedMeizuProviderError.tracks.length, 1);
assert.equal(mixedMeizuProviderError.latestDetail, "快件运输中");
assert.equal(mixedMeizuProviderError.semantic, "TRANSIT");
import {
  queryPhoneTails,
  resolveCarrierKuaidi100Code,
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
assert.equal(completed.hasStructuredStatus, false);
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
assert.equal(kuaidi100PhoneRejected({ status: "408" }), true);
assert.equal(kuaidi100PhoneRejected({ message: "请输入手机尾号" }), true);
assert.equal(explicitKuaidi100Failure({ result: "true", returnCode: "200" }), false);
assert.equal(explicitKuaidi100Failure({ status: "200" }), false);
assert.equal(explicitKuaidi100Failure({ status: "201" }), true);
assert.equal(
  rejectKuaidi100Response({
    result: false,
    returnCode: "500",
    message: "请输入手机尾号",
    data: [],
  }),
  true,
);

const shunfeng = resolveCarrierKuaidi100Code("shunfeng");
const yuantong = resolveCarrierQuery("YTO");
assert.equal(shunfeng?.requiresPhoneTail, true);
assert.deepEqual(queryPhoneTails(yuantong, "", ["8098"]), ["", "8098"]);
assert.deepEqual(queryPhoneTails(shunfeng, "", ["1515"]), ["1515"]);
assert.deepEqual(queryPhoneTails(yuantong, "7773", ["8098"]), ["", "7773", "8098"]);
assert.deepEqual(queryPhoneTails(shunfeng, "1515", ["8098", "1515"]), ["1515", "8098"]);
assert.equal(resolveCarrierQuery("VIVO_SF"), null);

const moto = parseMotoTimeline({
  status: 0,
  data: {
    logisticsStatus: "SIGN",
    logisticsStatusDesc: "已签收",
    fullTraceDetail: [{ time: "2026-08-29 16:00:00", desc: "本人签收" }],
  },
});
assert.equal(moto.semantic, "COMPLETED");
assert.equal(moto.hasStructuredStatus, true);
assert.equal(moto.tracks[0].raw._pipiStatusSource, "moto");
assert.equal(moto.tracks[0].raw.logisticsStatus, "SIGN");

const kdniao = parseKdniaoTimeline({
  success: true,
  state: "2",
  stateEx: "311",
  traces: [{
    acceptTime: "2026-08-29 17:00:00",
    acceptStation: "已签收",
    action: "311",
    location: "深圳",
  }],
});
assert.equal(kdniao.hasStructuredStatus, true);
assert.equal(kdniao.semantic, "COMPLETED");
assert.equal(kdniao.tracks[0].statusCode, "311");
assert.equal(kdniao.tracks[0].raw.location, "深圳");

const kdniaoBasicStateOnly = parseKdniaoTimeline({
  success: true,
  state: "2",
  traces: [{
    acceptTime: "2026-08-29 18:00:00",
    acceptStation: "已到达驿站，请凭取件码领取",
  }],
});
assert.equal(kdniaoBasicStateOnly.hasStructuredStatus, false);
assert.equal(kdniaoBasicStateOnly.semantic, "TRANSIT");

const motoDescriptionOnly = parseMotoTimeline({
  status: 0,
  data: {
    logisticsStatusDesc: "已签收",
    fullTraceDetail: [{ time: "2026-08-29 16:00:00", desc: "本人签收" }],
  },
});
assert.equal(motoDescriptionOnly.hasStructuredStatus, false);

console.log("manual query parser and carrier policy tests passed");
