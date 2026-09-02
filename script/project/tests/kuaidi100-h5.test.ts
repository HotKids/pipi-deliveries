import assert from "node:assert/strict";
import {
  KUAIDI100_H5_QUERY_URL,
  Kuaidi100H5Error,
  kuaidi100ToastMessage,
  type Kuaidi100H5Diagnostics,
  queryKuaidi100JdTimeline,
} from "../services/kuaidi100-h5";
import { OperationTimeoutError } from "../services/deadline";

const WAYBILL = "JDSYNTHETIC123456";
const NOW = Date.UTC(2026, 7, 31, 16, 0, 0);

function response(value: unknown) {
  return {
    ok: true,
    status: 200,
    expectedContentLength: 256,
    text: async () => JSON.stringify(value),
  };
}

const order: string[] = [];
let requestOptions: Record<string, unknown> | null = null;
let successDiagnostics: Kuaidi100H5Diagnostics | null = null;
const detectJd = async () => [{ courierCode: "jd", companyName: "京东快递" }];
const timeline = await queryKuaidi100JdTimeline({
  waybill: WAYBILL,
  phoneTail: "1515",
  courierCode: "JD",
  companyName: "京东快递",
  observe: (diagnostics) => { successDiagnostics = diagnostics; },
  dependencies: {
    now: () => NOW,
    detect: async () => {
      throw new Error("a trusted built-in JD carrier must bypass autoComNum");
    },
    request: async (url, options) => {
      order.push("request");
      assert.equal(url, KUAIDI100_H5_QUERY_URL);
      requestOptions = options;
      return response({
        status: "200",
        com: "jd",
        nu: WAYBILL,
        state: "5",
        data: [
          { time: "2026-08-31 16:00:00", context: "正在派送" },
          { time: "2026-08-31 10:00:00", context: "运输中" },
        ],
      });
    },
  },
});
assert.deepEqual(order, ["request"]);
assert.equal(timeline?.provider, "kuaidi100_h5");
assert.equal(timeline?.complete, true);
assert.equal(timeline?.tracks.length, 2);
assert.equal(timeline?.rawCourierCode, "jd");
assert.equal(timeline?.tracks[0]?.raw._pipiKuaidi100Com, "jd");
assert.match(String(requestOptions?.body), /postid=JDSYNTHETIC123456/);
assert.match(String(requestOptions?.body), /type=jd/);
assert.match(String(requestOptions?.body), /phone=1515/);
assert.deepEqual(successDiagnostics, {
  carrierCode: "JD",
  extractionSource: "data_array",
  rawTrackCount: 2,
  validTrackCount: 2,
  effectiveTrackCount: 2,
  exitReason: "timed_tracks",
});
assert.equal(
  kuaidi100ToastMessage(null, successDiagnostics),
  "轨迹加载成功",
);

let noPhoneRequestBody = "";
const noPhoneTimeline = await queryKuaidi100JdTimeline({
  waybill: "YTOSYNTHETIC123456",
  phoneTail: "1515",
  courierCode: "YTO",
  companyName: "圆通速递",
  dependencies: {
    now: () => NOW,
    detect: async () => {
      throw new Error("a trusted built-in YTO carrier must bypass autoComNum");
    },
    request: async (_url, options) => {
      noPhoneRequestBody = String(options.body);
      return response({
        status: "200",
        com: "yuantong",
        nu: "YTOSYNTHETIC123456",
        data: [{ time: "2026-08-31 16:00:00", context: "运输中" }],
      });
    },
  },
});
assert.equal(noPhoneTimeline?.courierCode, "YTO");
assert.match(noPhoneRequestBody, /type=yuantong/);
assert.match(noPhoneRequestBody, /(?:^|&)phone=(?:&|$)/);

let missingRequiredPhoneRequested = false;
await assert.rejects(
  queryKuaidi100JdTimeline({
    waybill: WAYBILL,
    phoneTail: "",
    courierCode: "JD",
    companyName: "京东快递",
    dependencies: {
      detect: async () => {
        throw new Error("a trusted built-in JD carrier must bypass autoComNum");
      },
      request: async () => {
        missingRequiredPhoneRequested = true;
        throw new Error("the request must not start without JD's phone tail");
      },
    },
  }),
  (error: unknown) =>
    error instanceof Kuaidi100H5Error && error.code === "phone_tail",
);
assert.equal(missingRequiredPhoneRequested, false);

let providerAttempts = 0;
const providerLimitedDependencies = {
  now: () => NOW,
  detect: detectJd,
  request: async () => {
    providerAttempts++;
    if (providerAttempts === 1) {
      return {
        ok: false,
        status: 429,
        expectedContentLength: 0,
        text: async () => "",
      };
    }
    return response({
      status: "200",
      com: "jd",
      nu: WAYBILL,
      data: [{ time: "2026-08-31 16:00:00", context: "运输中" }],
    });
  },
};
await assert.rejects(
  queryKuaidi100JdTimeline({
    waybill: WAYBILL,
    phoneTail: "1515",
    dependencies: providerLimitedDependencies,
  }),
  (error: unknown) =>
    error instanceof Kuaidi100H5Error && error.code === "rejected",
);
const immediateRetry = await queryKuaidi100JdTimeline({
  waybill: WAYBILL,
  phoneTail: "1515",
  dependencies: providerLimitedDependencies,
});
assert.equal(providerAttempts, 2);
assert.equal(immediateRetry?.tracks.length, 1);
assert.equal(
  kuaidi100ToastMessage(
    new Kuaidi100H5Error("K100 查询过于频繁", "rejected"),
    null,
  ),
  "请求过于频繁，请稍后重试",
);

let noResultDiagnostics: Kuaidi100H5Diagnostics | null = null;
const noResult = await queryKuaidi100JdTimeline({
  waybill: WAYBILL,
  phoneTail: "1515",
  observe: (diagnostics) => { noResultDiagnostics = diagnostics; },
  dependencies: {
    now: () => NOW,
    detect: detectJd,
    request: async () => response({
      status: "200",
      com: "jd",
      nu: WAYBILL,
      data: [{
        time: "2026-08-31 16:00:00",
        context: "查无结果，请检查运单号",
      }],
    }),
  },
});
assert.equal(noResult, null);
assert.deepEqual(noResultDiagnostics, {
  carrierCode: "JD",
  extractionSource: "data_array",
  rawTrackCount: 1,
  validTrackCount: 1,
  effectiveTrackCount: 0,
  exitReason: "no_usable_timed_tracks",
});
assert.equal(
  kuaidi100ToastMessage(null, noResultDiagnostics),
  "暂未获取到可用轨迹",
);
assert.equal(
  kuaidi100ToastMessage(new OperationTimeoutError(), null),
  "查询超时，请稍后下拉刷新",
);

let emptyDiagnostics: Kuaidi100H5Diagnostics | null = null;
const emptyResult = await queryKuaidi100JdTimeline({
  waybill: WAYBILL,
  phoneTail: "1515",
  observe: (diagnostics) => { emptyDiagnostics = diagnostics; },
  dependencies: {
    now: () => NOW,
    detect: detectJd,
    request: async () => response({
      status: "200",
      com: "jd",
      nu: WAYBILL,
      data: [],
    }),
  },
});
assert.equal(emptyResult, null);
assert.deepEqual(emptyDiagnostics, {
  carrierCode: "JD",
  extractionSource: "data_array",
  rawTrackCount: 0,
  validTrackCount: 0,
  effectiveTrackCount: 0,
  exitReason: "empty_data",
});

await assert.rejects(
  queryKuaidi100JdTimeline({
    waybill: WAYBILL,
    phoneTail: "1515",
    dependencies: {
      now: () => NOW,
      detect: detectJd,
      request: async () => response({
        status: "408",
        message: "请输入手机尾号",
      }),
    },
  }),
  (error: unknown) =>
    error instanceof Kuaidi100H5Error && error.code === "phone_tail",
);

const aborted = new AbortController();
aborted.abort();
let abortedDetection = false;
await assert.rejects(
  queryKuaidi100JdTimeline({
    waybill: WAYBILL,
    phoneTail: "1515",
    signal: aborted.signal,
    dependencies: {
      detect: async () => {
        abortedDetection = true;
        return detectJd();
      },
    },
  }),
  (error: unknown) => error instanceof OperationTimeoutError,
);
assert.equal(abortedDetection, false);

const shunFeng = await queryKuaidi100JdTimeline({
  waybill: "SFSYNTHETIC123456",
  phoneTail: "1515",
  dependencies: {
    now: () => NOW,
    detect: async () => [{ courierCode: "shunfeng", companyName: "顺丰速运" }],
    request: async (_url, options) => {
      assert.match(String(options.body), /type=shunfeng/);
      return response({
        status: "200",
        com: "shunfeng",
        nu: "SFSYNTHETIC123456",
        data: [{ time: "2026-08-31 16:00:00", context: "运输中" }],
      });
    },
  },
});
assert.equal(shunFeng?.courierCode, "SF");
assert.equal(shunFeng?.companyName, "顺丰速运");
assert.equal(
  shunFeng?.tracks[0]?.raw._pipiKuaidi100Com,
  "shunfeng",
);

const deBangAlias = await queryKuaidi100JdTimeline({
  waybill: "DBLSYNTHETIC123456",
  phoneTail: "1515",
  dependencies: {
    now: () => NOW,
    detect: async () => [{ courierCode: "debangkuaidi", companyName: "德邦快递" }],
    request: async () => response({
      status: "200",
      com: "debangwuliu",
      nu: "DBLSYNTHETIC123456",
      data: [{ time: "2026-08-31 16:00:00", context: "运输中" }],
    }),
  },
});
assert.equal(deBangAlias?.courierCode, "DBL");
assert.equal(deBangAlias?.companyName, "德邦快递");
assert.equal(deBangAlias?.rawCourierCode, "debangwuliu");
assert.equal(
  deBangAlias?.tracks[0]?.raw._pipiKuaidi100Com,
  "debangwuliu",
  "the raw marker must retain literal root.com instead of the canonical K100 code",
);

await assert.rejects(
  queryKuaidi100JdTimeline({
    waybill: "JDWAYBILLMISMATCH123456",
    phoneTail: "1515",
    courierCode: "JD",
    companyName: "京东快递",
    dependencies: {
      now: () => NOW,
      detect: async () => {
        throw new Error("a trusted built-in JD carrier must bypass autoComNum");
      },
      request: async () => response({
        status: "200",
        com: "jd",
        nu: "JDOTHERWAYBILL123456",
        data: [{ time: "2026-08-31 16:00:00", context: "运输中" }],
      }),
    },
  }),
  (error: unknown) =>
    error instanceof Kuaidi100H5Error && error.code === "invalid_response",
);

await assert.rejects(
  queryKuaidi100JdTimeline({
    waybill: "JDMISMATCH123456",
    phoneTail: "1515",
    dependencies: {
      now: () => NOW,
      detect: detectJd,
      request: async () => response({
        status: "200",
        com: "youzhengguonei",
        nu: "JDMISMATCH123456",
        data: [{ time: "2026-08-31 16:00:00", context: "运输中" }],
      }),
    },
  }),
  (error: unknown) =>
    error instanceof Kuaidi100H5Error && error.code === "carrier_mismatch",
);

console.log("Kuaidi100 JD H5 query tests passed");
