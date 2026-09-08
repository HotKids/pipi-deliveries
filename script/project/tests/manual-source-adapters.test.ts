import assert from "node:assert/strict";
import {
  allowsLocalCapabilityForSourceProvider,
  allowsRouteCapabilityForSourceProvider,
  queryKdniaoShipment,
  queryKuaidi100Shipment,
  queryManualForSource,
  queryMeizuShipment,
  queryMotoShipment,
  SCRIPT_MANUAL_SOURCE_ACTIVATION,
  type ManualSourceDependencies,
} from "../services/manual-query";

const NOW = Date.UTC(2026, 7, 30, 10, 0, 0);

assert.deepEqual(SCRIPT_MANUAL_SOURCE_ACTIVATION, {
  local: true,
  route: true,
  fallback: true,
});
assert.equal(allowsLocalCapabilityForSourceProvider("CaiNiao"), true);
assert.equal(allowsLocalCapabilityForSourceProvider("JingDong"), false);
assert.equal(allowsLocalCapabilityForSourceProvider("ShunFeng"), false);
assert.equal(allowsLocalCapabilityForSourceProvider(""), true);
assert.equal(allowsRouteCapabilityForSourceProvider("ShunFeng"), true);
assert.equal(allowsRouteCapabilityForSourceProvider("CaiNiao"), false);
assert.equal(allowsRouteCapabilityForSourceProvider("JingDong"), false);
assert.equal(allowsRouteCapabilityForSourceProvider(""), true);

let localPayload: Record<string, unknown> | null = null;
const local = await queryMotoShipment({
  waybill: "ZT1234567890",
  rawCourierCode: "ZTO",
  bindingSource: "interface5",
  dependencies: {
    now: () => NOW,
    post: async (route, payload) => {
      assert.equal(route, "/api/express/timeline/public");
      localPayload = payload;
      return {
        status: 0,
        data: {
          cpCode: "ZTO",
          cpName: "中通快递",
          logisticsStatus: "TRANSPORT",
          fullTraceDetail: [{
            time: "2026-08-30 17:00:00",
            desc: "快件离开分拨中心",
          }],
        },
      };
    },
  },
});
assert.deepEqual(localPayload, {
  waybill: "ZT1234567890",
  companyCode: "ZTO",
});
assert.equal(local.timeline.provider, "v4_query");
assert.equal(local.timeline.complete, false);
assert.equal(local.timeline.semantic, "TRANSIT");
assert.equal(local.timeline.rawCourierCode, "ZTO");

let rawAliasMotoPayload: Record<string, unknown> | null = null;
const rawAliasMoto = await queryMotoShipment({
  waybill: "JDLEX1234567890",
  rawCourierCode: "  JDLEX  ",
  bindingSource: "interface5",
  dependencies: {
    now: () => NOW,
    post: async (route, payload) => {
      assert.equal(route, "/api/express/timeline/public");
      rawAliasMotoPayload = payload;
      return {
        status: 0,
        data: {
          cpCode: "JDLEX",
          cpName: "京东快递",
          logisticsStatus: "TRANSPORT",
          fullTraceDetail: [{
            time: "2026-08-30 17:01:00",
            desc: "京东快件运输中",
          }],
        },
      };
    },
  },
});
assert.deepEqual(rawAliasMotoPayload, {
  waybill: "JDLEX1234567890",
  companyCode: "JDLEX",
});
assert.equal(rawAliasMoto.timeline.rawCourierCode, "JDLEX");
assert.equal(rawAliasMoto.timeline.courierCode, "JD");

let detectedJdkyPayload: Record<string, unknown> | null = null;
await queryManualForSource({
  source: "interface5",
  bindings: [],
  waybill: "TESTJDKY123456",
  presentation: {
    courierCode: "JDKY",
    companyName: "京东快运",
    requiresPhoneTail: false,
  },
  motoOnly: true,
  dependencies: {
    now: () => NOW,
    post: async (path, payload) => {
      assert.equal(path, "/api/express/timeline/public");
      detectedJdkyPayload = payload;
      return {
        status: 0,
        data: {
          cpCode: "jingdongkuaiyun",
          cpName: "京东快运",
          logisticsStatus: "TRANSPORT",
          fullTraceDetail: [{
            time: "2026-08-30 17:02:00",
            desc: "京东快运运输中",
          }],
        },
      };
    },
  },
});
assert.deepEqual(detectedJdkyPayload, {
  waybill: "TESTJDKY123456",
  companyCode: "JDKY",
});

let cainiaoSfMotoCalls = 0;
const cainiaoSf = await queryManualForSource({
  source: "interface5",
  bindings: [],
  waybill: "SF1234567890",
  rawCourierCode: "SF",
  sourceProvider: "CaiNiao",
  dependencies: {
    now: () => NOW,
    post: async (path) => {
      assert.equal(path, "/api/express/timeline/public");
      cainiaoSfMotoCalls++;
      return {
        status: 0,
        data: {
          cpCode: "SF",
          cpName: "顺丰速运",
          logisticsStatus: "TRANSPORT",
          fullTraceDetail: [{
            time: "2026-08-30 17:05:00",
            desc: "快件运输中",
          }],
        },
      };
    },
  },
});
assert.equal(cainiaoSfMotoCalls, 0);
assert.equal(cainiaoSf.shipment, null);

for (const rawCpCode of ["JD", "JDLEX", "JDVD"]) {
  let cainiaoJdMotoCalls = 0;
  const cainiaoJdCarrier = await queryManualForSource({
    source: "interface5",
    bindings: [],
    waybill: `CAINIAO${rawCpCode}123456`,
    phoneTail: "1515",
    rawCourierCode: rawCpCode,
    sourceProvider: "CaiNiao",
    motoOnly: true,
    dependencies: {
      now: () => NOW,
      post: async (path) => {
        assert.equal(path, "/api/express/timeline/public");
        cainiaoJdMotoCalls++;
        return {
          status: 0,
          data: {
            cpCode: rawCpCode,
            cpName: "京东快递",
            logisticsStatus: "TRANSPORT",
            fullTraceDetail: [{
              time: "2026-08-30 17:06:00",
              desc: "菜鸟来源、京东承运件运输中",
            }],
          },
        };
      },
    },
  });
  assert.equal(cainiaoJdMotoCalls, 1);
  assert.equal(cainiaoJdCarrier.shipment?.timeline.provider, "v4_query");
  assert.equal(cainiaoJdCarrier.shipment?.timeline.courierCode, "JD");
  assert.equal(
    cainiaoJdCarrier.shipment?.timeline.rawCourierCode,
    rawCpCode,
    "Moto sidecars must retain the literal returned JD* cpCode",
  );
}

let routePayload: Record<string, unknown> | null = null;
const route = await queryMeizuShipment({
  waybill: "SF1234567890",
  phoneTail: "1515",
  rawCourierCode: "SF",
  bindingSource: "interface5",
  dependencies: {
    now: () => NOW,
    post: async (path, payload) => {
      assert.equal(path, "/api/express/timeline/source");
      routePayload = payload;
      return {
        code: 200,
        value: JSON.stringify({
          nu: "SF1234567890",
          com: "KYE",
          name: "跨越速运",
          state: "2",
          time: "2026-08-30 17:15:00",
          context: "快件运输中",
          detailUrl: "https://m.kuaidi100.com/result.jsp?nu=SF1234567890",
        }),
      };
    },
  },
});
assert.equal(routePayload?.mode, "manual");
assert.equal(route.shipment.timeline.provider, "v6_picker");
assert.equal(route.shipment.timeline.complete, false);
assert.equal(route.shipment.timeline.courierCode, "KYSY");
assert.equal(route.shipment.timeline.rawCourierCode, "KYE");
assert.match(route.routeUrl, /^https:\/\/m\.kuaidi100\.com\//);

await assert.rejects(
  queryMeizuShipment({
    waybill: "SF1234567890",
    rawCourierCode: "SF",
    bindingSource: "interface5",
    dependencies: {
      now: () => NOW,
      post: async () => ({
        code: 200,
        value: JSON.stringify({
          nu: "SF1234567890",
          data: [{
            mailNo: "OTHER1234567890",
            time: "2026-08-30 17:15:00",
            context: "不应采用的轨迹",
          }],
        }),
      }),
    },
  }),
  (error: unknown) =>
    error instanceof Error &&
    error.message === "路由轨迹返回的运单与查询不一致",
  "every declared Meizu waybill in nested envelope arrays must match the request",
);

const routeWithoutResponseIdentity = await queryMeizuShipment({
  waybill: "SF1234567890",
  rawCourierCode: "SF",
  bindingSource: "interface5",
  dependencies: {
    now: () => NOW,
    post: async () => ({
      code: 200,
      value: JSON.stringify({
        time: "2026-08-30 17:16:00",
        context: "未声明运单身份的有效轨迹",
      }),
    }),
  },
});
assert.equal(routeWithoutResponseIdentity.shipment.timeline.provider, "v6_picker");
assert.equal(routeWithoutResponseIdentity.shipment.timeline.tracks.length, 1);

let preferredPayload: Record<string, unknown> | null = null;
const preferred = await queryKuaidi100Shipment({
  waybill: "DBL1234567890",
  rawCourierCode: "DBL",
  bindingSource: "interface5",
  dependencies: {
    now: () => NOW,
    post: async (path, payload) => {
      assert.equal(path, "/api/express/timeline/preferred");
      preferredPayload = payload;
      return {
        status: "200",
        com: "debangwuliu",
        data: [{ time: "2026-08-30 17:30:00", context: "快件运输中" }],
      };
    },
  },
});
assert.deepEqual(preferredPayload, {
  waybill: "DBL1234567890",
  companyCode: "debangkuaidi",
  phone: "",
});
assert.equal(preferred.timeline.courierCode, "DBL");
assert.equal(preferred.timeline.rawCourierCode, "debangwuliu");

let meizuRetryAttempts = 0;
const retriedRoute = await queryMeizuShipment({
  waybill: "SF1234567890",
  phoneTail: "1515",
  rawCourierCode: "SF",
  bindingSource: "interface5",
  dependencies: {
    now: () => NOW,
    post: async () => {
      meizuRetryAttempts++;
      if (meizuRetryAttempts === 1) {
        return { code: 503, message: "temporarily unavailable" };
      }
      return {
        code: 200,
        value: JSON.stringify({
          nu: "SF1234567890",
          com: "SF",
          name: "顺丰速运",
          state: "2",
          time: "2026-08-30 17:15:00",
          context: "快件运输中",
        }),
      };
    },
  },
});
assert.equal(meizuRetryAttempts, 2);
assert.equal(retriedRoute.shipment.timeline.tracks.length, 1);
assert.equal(retriedRoute.shipment.timeline.provider, "v6_picker");

let fallbackPayload: Record<string, unknown> | null = null;
const fallback = await queryKdniaoShipment({
  waybill: "ZT1234567890",
  rawCourierCode: "ZMKM",
  phoneTail: "1515",
  bindingSource: "interface5",
  dependencies: {
    now: () => NOW,
    post: async (path, payload) => {
      assert.equal(path, "/api/express/timeline/fallback");
      fallbackPayload = payload;
      return {
        success: true,
        state: "2",
        logisticCode: "ZT1234567890",
        shipperCode: "ZMKM",
        traces: [{
          acceptTime: "2026-08-30 17:40:00",
          acceptStation: "正在派件",
          action: "202",
        }],
      };
    },
  },
});
assert.deepEqual(fallbackPayload, {
  waybill: "ZT1234567890",
  shipperCode: "DANNIAO",
  phone: "",
});
assert.equal(fallback.timeline.provider, "kdniao");
assert.equal(fallback.timeline.complete, true);
assert.equal(fallback.timeline.courierCode, "DANNIAO");
assert.equal(fallback.timeline.rawCourierCode, "ZMKM");

for (const [label, response] of [
  ["missing waybill", {
    success: true,
    shipperCode: "ZMKM",
  }],
  ["mismatched waybill", {
    success: true,
    logisticCode: "OTHER1234567890",
    shipperCode: "ZMKM",
  }],
  ["missing carrier", {
    success: true,
    logisticCode: "ZT1234567890",
  }],
  ["mismatched carrier", {
    success: true,
    logisticCode: "ZT1234567890",
    shipperCode: "SF",
  }],
] as const) {
  await assert.rejects(
    queryKdniaoShipment({
      waybill: "ZT1234567890",
      rawCourierCode: "ZMKM",
      bindingSource: "interface5",
      dependencies: {
        now: () => NOW,
        post: async () => ({
          ...response,
          state: "2",
          traces: [{
            acceptTime: "2026-08-30 17:40:00",
            acceptStation: "不应被采用的轨迹",
            action: "202",
          }],
        }),
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "快递鸟返回身份与查询不一致",
    `KDNiao ${label} must fail before a shipment can be cached or selected`,
  );
}

await assert.rejects(
  queryKdniaoShipment({
    waybill: "ZT1234567890",
    rawCourierCode: "ZTO",
    bindingSource: "interface5",
  }),
  (error: unknown) =>
    error instanceof Error && error.message === "请输入手机尾号",
  "a missing tail asks for the tail; the four-digit wording is for a partial one",
);

// Physical JD carrier identity does not make a pure-manual parcel a JingDong
// business-source parcel; Moto remains in the primary round.
let rawJdMotoCalls = 0;
const rawJdManual = await queryManualForSource({
  source: "interface5",
  bindings: [],
  waybill: "JDRAWCP123456",
  phoneTail: "1515",
  rawCourierCode: "JD",
  motoOnly: true,
  dependencies: {
    now: () => NOW,
    post: async (path) => {
      assert.equal(path, "/api/express/timeline/public");
      rawJdMotoCalls++;
      return {
        status: 0,
        data: {
          cpCode: "JD",
          cpName: "京东快递",
          logisticsStatus: "TRANSPORT",
          fullTraceDetail: [{
            time: "2026-08-30 17:45:00",
            desc: "京东承运的菜鸟件运输中",
          }],
        },
      };
    },
  },
});
assert.equal(rawJdMotoCalls, 1);
assert.equal(rawJdManual.shipment?.timeline.provider, "v4_query");

function dependencies(routes: string[]): ManualSourceDependencies {
  return {
    now: () => NOW,
    post: async (path) => {
      routes.push(path);
      if (path === "/api/express/timeline/public") {
        return {
          status: 0,
          data: {
            cpCode: "ZTO",
            cpName: "中通快递",
            logisticsStatus: "TRANSPORT",
            fullTraceDetail: [{
              time: "2026-08-30 18:00:00",
              desc: "本地轨迹",
            }],
          },
        };
      }
      if (path === "/api/express/timeline/source") {
        return { code: 200, value: "{}" };
      }
      if (path === "/api/express/timeline/fallback") {
        return {
          success: true,
          state: "2",
          logisticCode: "ZT1234567890",
          shipperCode: "ZTO",
          traces: [{
            acceptTime: "2026-08-30 18:00:00",
            acceptStation: "最终兜底轨迹",
            action: "2",
          }],
        };
      }
      throw new Error(`unexpected route: ${path}`);
    },
  };
}

const cainiaoRoutes: string[] = [];
const cainiao = await queryManualForSource({
  source: "interface5",
  bindings: [],
  waybill: "ZT1234567890",
  phoneTail: "1515",
  rawCourierCode: "ZTO",
  sourceProvider: "CaiNiao",
  dependencies: dependencies(cainiaoRoutes),
});
assert.equal(cainiao.shipment?.timeline.provider, "v4_query");
assert.deepEqual(cainiaoRoutes, ["/api/express/timeline/public"]);

const sfRoutes: string[] = [];
const sf = await queryManualForSource({
  source: "interface5",
  bindings: [],
  waybill: "SF1234567890",
  phoneTail: "1515",
  rawCourierCode: "SF",
  sourceProvider: "ShunFeng",
  includeKdniaoFallback: true,
  dependencies: {
    now: () => NOW,
    post: async (path) => {
      sfRoutes.push(path);
      if (path === "/api/express/timeline/source") {
        return { code: 200, value: JSON.stringify({
          nu: "SF1234567890",
          com: "SF",
          name: "顺丰速运",
        }) };
      }
      if (path === "/api/express/timeline/fallback") {
        return {
          success: true,
          state: "2",
          logisticCode: "SF1234567890",
          shipperCode: "SF",
          traces: [{
            acceptTime: "2026-08-30 18:00:00",
            acceptStation: "顺丰快件运输中",
            action: "2",
          }],
        };
      }
      throw new Error(`unexpected route: ${path}`);
    },
  },
});
assert.deepEqual(sfRoutes, [
  "/api/express/timeline/source",
  "/api/express/timeline/fallback",
]);
assert.equal(sf.shipment?.timeline.provider, "kdniao");

// 表格「待改 1」：京东这一槽不再直连 K100，统一走 picker；K100 那一页由详情链下一级抓
// picker 返回的 `detailUrl`。
const jdRoutes: string[] = [];
const jd = await queryManualForSource({
  source: "interface5",
  bindings: [],
  waybill: "JD1234567890",
  phoneTail: "1515",
  rawCourierCode: "JD",
  sourceProvider: "JingDong",
  dependencies: {
    now: () => NOW,
    post: async (path) => {
      jdRoutes.push(path);
      if (path === "/api/express/timeline/source") {
        return { code: 200, value: JSON.stringify({
          nu: "JD1234567890",
          com: "JD",
          name: "京东快递",
          time: "2026-08-30 18:00:00",
          context: "京东快件运输中",
          detailUrl: "https://m.kuaidi100.com/result.jsp?nu=JD1234567890",
        }) };
      }
      throw new Error(`unexpected gateway route: ${path}`);
    },
  },
});
assert.deepEqual(jdRoutes, ["/api/express/timeline/source"]);
assert.equal(jd.shipment?.timeline.provider, "v6_picker");
assert.equal(
  jd.routeUrl,
  "https://m.kuaidi100.com/result.jsp?nu=JD1234567890",
  "picker 返回的 detailUrl 必须交出去，它是 K100 H5 那一级的入口",
);
assert.equal(jd.pending, null);

const fallbackOnlyRoutes: string[] = [];
const fallbackOnly = await queryManualForSource({
  source: "interface5",
  bindings: [],
  waybill: "ZT1234567890",
  phoneTail: "1515",
  rawCourierCode: "ZTO",
  includeKdniaoFallback: true,
  fallbackOnly: true,
  dependencies: dependencies(fallbackOnlyRoutes),
});
assert.deepEqual(fallbackOnlyRoutes, ["/api/express/timeline/fallback"]);
assert.equal(fallbackOnly.shipment?.timeline.provider, "kdniao");

console.log("manual source adapter tests passed");
