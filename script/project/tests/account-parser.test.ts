import assert from "node:assert/strict";
import {
  AccountParseError,
  matchBoundPhone,
  mergeAccountParcel,
  parseAccountSyncResponse,
  parseAccountSyncResult,
  parseAccountTimelineResponse,
} from "../services/account-parser";

const v5 = parseAccountSyncResponse("interface5", {
  code: 0,
  data: {
    expressList: [{
      mailNo: "79025657335745",
      cpCode: "ZTO",
      name: "中通快递",
      provider: "CaiNiao",
      state: "待取件",
      stateNum: 106,
      phone: "****8000",
      details: [
        { time: "2026-08-16 16:00:00", desc: "快件运输中" },
        { time: "2026-08-16 17:03:18", desc: "已存放至驿站" },
        { time: "2026-08-16 18:00:00", desc: "快递状态已更新，点击查看>>" },
      ],
      detailUrl: "https://page.cainiao.com/detail?opaque=1",
    }, {
      mailNo: "9876543210987654",
      cpCode: "JD",
      provider: "JingDong",
      state: "订单已完成",
      stateNum: 101,
      normalizedStatusScope: "ORDER",
      normalizedStatusSemantic: "COMPLETED",
      normalizedStatusText: "已完成",
      jumpList: [{ type: "h5", link: "https://wqs.jd.com/order/987654321098765" }],
    }],
  },
});
assert.equal(v5.length, 2);
assert.equal(v5[0].semantic, "WAITING_PICKUP");
assert.equal(v5[0].tracks.length, 2);
assert.equal(v5[0].latestDetail, "已存放至驿站");
assert.equal(v5[0].routeUrl, "https://page.cainiao.com/detail?opaque=1");
assert.equal(matchBoundPhone(v5[0], ["13800138000"]), "13800138000");
assert.equal(
  matchBoundPhone(v5[0], ["13800138000", "13900138000"]),
  "",
);
assert.equal(v5[1].accountOrder, true);
assert.equal(v5[1].companyName, "京东购物");
assert.equal(v5[1].rawCompanyName, "");
assert.equal(v5[1].semantic, "ORDERED");
assert.equal(v5[1].normalizedStatusScope, "ORDER");
assert.equal(v5[1].normalizedStatusSemantic, "COMPLETED");
assert.equal(v5[1].normalizedStatusText, "已完成");

const parsedV5 = parseAccountSyncResult("interface5", {
  code: 0,
  value: "must-not-shadow-the-canonical-data-field",
  data: {
    expressList: [{ mailNo: "STRICT_FIXTURE_0001", cpCode: "SF" }],
  },
});
assert.equal(parsedV5.rawRecords, 1);
assert.equal(parsedV5.parcels.length, 1);
assert.equal(parsedV5.rejectedRecords, 0);
assert.deepEqual(parseAccountSyncResponse("interface5", {
  code: 0,
  data: { expressList: [] },
}), []);
for (const malformed of [
  { code: 0, data: null },
  { code: 0, data: {} },
  { code: 0, data: { expressList: {} } },
  { code: 0, data: { expressList: [{ state: "运输中" }] } },
]) {
  assert.throws(
    () => parseAccountSyncResponse("interface5", malformed),
    (error: unknown) => error instanceof AccountParseError,
  );
}

// The account list uses a 16-digit mailNo plus its exact provider as the order identity.
const providerOrder = parseAccountSyncResponse("interface5", {
  code: 0,
  data: {
    expressList: [{
      mailNo: "9876543210987680",
      providerName: "JingDong",
      state: "订单已完成",
      stateNum: 101,
      detailUrl: "https://page.cainiao.com/detail?must-not-project=1",
      jumpList: [{
        type: "h5",
        link: "https://u.jd.com/forward?opaque=1",
      }],
    }],
  },
})[0];
assert.equal(providerOrder.accountOrder, true);
assert.equal(providerOrder.ownerId, "9876543210987680");
assert.equal(providerOrder.waybill, "9876543210987680");
assert.equal(providerOrder.routeUrl, "");
assert.equal(providerOrder.projectionUrl, "https://u.jd.com/forward?opaque=1");

const shortProviderOrder = parseAccountSyncResponse("interface5", {
  code: 0,
  data: {
    expressList: [{
      mailNo: "350365030147",
      cpCode: "JD",
      name: "京东快递",
      provider: "JingDong",
      state: "已完成",
      stateNum: 107,
      details: [{
        time: "2026-08-25 23:04:00",
        desc: "您的订单350365030147已完成，感谢您对京东的支持。",
      }],
      jumpList: [{
        type: "h5",
        link: "https://u.jd.com/forward?short-order=1",
      }],
    }],
  },
})[0];
assert.equal(shortProviderOrder.accountOrder, true);
assert.equal(shortProviderOrder.orderId, "350365030147");
assert.equal(shortProviderOrder.companyName, "京东购物");
assert.equal(shortProviderOrder.routeUrl, "");
assert.equal(
  shortProviderOrder.projectionUrl,
  "https://u.jd.com/forward?short-order=1",
);

const shortJdWaybill = parseAccountSyncResponse("interface5", {
  code: 0,
  data: {
    expressList: [{
      mailNo: "350365030148",
      cpCode: "JD",
      name: "京东快递",
      provider: "JingDong",
      state: "运输中",
      stateNum: 104,
      details: [{
        time: "2026-08-25 23:04:00",
        desc: "快件正在运输中",
      }],
    }],
  },
})[0];
assert.equal(
  shortJdWaybill.accountOrder,
  false,
  "a 12-digit JD identifier still needs explicit order evidence",
);

const jdWaybill = parseAccountSyncResponse("interface5", {
  code: 0,
  data: {
    expressList: [{
      mailNo: "JDAP123456789012",
      cpCode: "JD",
      name: "京东快递",
      provider: "JingDong",
      stateNum: 104,
    }],
  },
})[0];
assert.equal(jdWaybill.accountOrder, false);
assert.equal(jdWaybill.companyName, "京东快递");

const providerPrecedence = parseAccountSyncResponse("interface5", {
  code: 0,
  data: {
    expressList: [{
      mailNo: "9876543210987681",
      cpCode: "JD",
      name: "京东快递",
      provider: "CaiNiao",
      providerName: "JingDong",
      stateNum: 104,
    }],
  },
})[0];
assert.equal(providerPrecedence.accountOrder, false);

const providerNameFallback = parseAccountSyncResponse("interface5", {
  code: 0,
  data: {
    expressList: [{
      mailNo: "SF123456789012",
      cpCode: "SF",
      name: "顺丰速运",
      providerName: "ShunFeng",
      fromCp: "must-not-own-source-provider",
      stateNum: 104,
    }],
  },
})[0];
assert.equal(providerNameFallback.sourceProvider, "ShunFeng");

const missingProvider = parseAccountSyncResponse("interface5", {
  code: 0,
  data: {
    expressList: [{
      mailNo: "SF123456789013",
      cpCode: "SF",
      name: "顺丰速运",
      fromCp: "must-not-own-source-provider",
      stateNum: 104,
    }],
  },
})[0];
assert.equal(missingProvider.sourceProvider, "");

const jdCodeOnly = parseAccountSyncResponse("interface5", {
  code: 0,
  data: {
    expressList: [{
      mailNo: "9876543210987682",
      cpCode: "JD",
      name: "京东快递",
      stateNum: 104,
    }],
  },
})[0];
assert.equal(jdCodeOnly.accountOrder, false);

const orderDetail = parseAccountTimelineResponse("interface5", {
  code: 0,
  data: {
    mailNo: "9876543210987680",
    provider: "JingDong",
    details: [{ time: "2026-08-26 20:00:00", desc: "订单已创建" }],
    detailUrl: "https://page.cainiao.com/detail?must-not-replace=1",
  },
});
const mergedOrder = mergeAccountParcel(providerOrder, orderDetail);
assert.equal(mergedOrder.routeUrl, "");
assert.equal(mergedOrder.projectionUrl, "https://u.jd.com/forward?opaque=1");

const v6 = parseAccountSyncResponse("interface6", {
  code: 200,
  value: JSON.stringify({
    parcelData: [{
      mailNo: "611704092029773",
      cpCode: "danniao",
      cpName: "丹鸟",
      fromCp: "CNGG",
      logsiticsStatus: "SIGN",
      logisticsStatusDesc: "已签收",
      logisticsGmtModified: "2026-08-26 10:00:00",
      lastLogisticDetail: "您的快件已签收",
      detailUrl: "https://page.cainiao.com/parcel/611704092029773",
    }],
  }),
});
assert.equal(v6.length, 1);
assert.equal(v6[0].semantic, "COMPLETED");
assert.equal(v6[0].companyName, "丹鸟");
assert.equal(v6[0].latestDetail, "您的快件已签收");
assert.equal(v6[0].routeUrl, "https://page.cainiao.com/parcel/611704092029773");

const completedWithPickupNode = parseAccountSyncResponse("interface5", {
  code: 0,
  data: {
    expressList: [{
      mailNo: "SF1226181467773",
      cpCode: "SF",
      state: "已签收",
      stateNum: 107,
      details: [{
        time: "2026-08-26 10:00:00",
        desc: "已存放至驿站",
        statusCode: 501,
      }],
    }],
  },
})[0];
assert.equal(completedWithPickupNode.semantic, "COMPLETED");
assert.equal(completedWithPickupNode.tracks[0].statusCode, "501");

const completedOrder = parseAccountSyncResponse("interface5", {
  code: 0,
  data: {
    expressList: [{
      mailNo: "9876543210987660",
      cpCode: "JD",
      provider: "JingDong",
      state: "已签收",
      stateNum: 107,
      detailUrl: "https://attacker.example/parcel",
    }],
  },
})[0];
assert.equal(completedOrder.semantic, "COMPLETED");
assert.equal(completedOrder.routeUrl, "");

const cancelledOrder = parseAccountSyncResponse("interface5", {
  code: 0,
  data: {
    expressList: [{
      mailNo: "9876543210987670",
      cpCode: "JD001",
      provider: "JingDong",
      state: "已取消",
      stateNum: 111,
    }],
  },
})[0];
assert.equal(cancelledOrder.accountOrder, true);
assert.equal(cancelledOrder.semantic, "CANCELLED");

const detail = parseAccountTimelineResponse("interface5", {
  code: 0,
  data: {
    details: [
      { time: "2026-08-21 22:00:00", desc: "快件运输中", stateNum: 104 },
    ],
  },
}, {
  waybill: "SF1226181467773",
  courierCode: "SF",
  rawCourierCode: "SF",
  companyName: "顺丰速运",
  phone: "13800138000",
});
assert.equal(detail?.waybill, "SF1226181467773");
assert.equal(detail?.latestDetail, "快件运输中");
assert.equal(detail?.receiverPhone, "13800138000");
assert.equal(detail?.rawCourierCode, "SF");

const normalizedWithoutRaw = parseAccountSyncResponse("interface5", {
  code: 0,
  data: {
    expressList: [{
      mailNo: "NORMALIZEDWITHOUTRAW001",
      normalizedCarrierCode: "SF",
      normalizedCarrierName: "顺丰速运",
      carrierBuiltIn: true,
      stateNum: 104,
    }],
  },
})[0];
assert.equal(normalizedWithoutRaw.courierCode, "SF");
assert.equal(normalizedWithoutRaw.rawCourierCode, "");

const rawCarrierSurvivesDisplayNormalization = parseAccountSyncResponse(
  "interface5",
  {
    code: 0,
    data: {
      expressList: [{
        mailNo: "RAWVERSUSDISPLAY0001",
        cpCode: "sfexpress",
        name: "顺丰来源原名",
        normalizedCarrierCode: "SF",
        normalizedCarrierName: "顺丰速运",
        carrierBuiltIn: true,
        stateNum: 104,
      }],
    },
  },
)[0];
assert.equal(rawCarrierSurvivesDisplayNormalization.rawCourierCode, "sfexpress");
assert.equal(rawCarrierSurvivesDisplayNormalization.rawCompanyName, "顺丰来源原名");
assert.equal(rawCarrierSurvivesDisplayNormalization.courierCode, "SF");
assert.equal(rawCarrierSurvivesDisplayNormalization.companyName, "顺丰速运");

const matchedAmongMultiple = parseAccountTimelineResponse("interface5", {
  code: 0,
  data: [{
    mailNo: "WRONG0001",
    details: [
      { time: "2026-08-26 23:00:00", desc: "错误快递最新节点" },
      { time: "2026-08-26 22:00:00", desc: "错误快递较早节点" },
    ],
  }, {
    mailNo: "TARGET0002",
    details: [
      { time: "2026-08-26 21:00:00", desc: "目标快递节点" },
    ],
  }],
}, { waybill: "TARGET0002" });
assert.equal(matchedAmongMultiple?.ownerId, "TARGET0002");
assert.equal(matchedAmongMultiple?.latestDetail, "目标快递节点");
assert.equal(
  parseAccountTimelineResponse("interface5", {
    code: 0,
    data: [{
      mailNo: "WRONG0001",
      details: [{ time: "2026-08-26 23:00:00", desc: "错误快递节点" }],
    }, {
      mailNo: "WRONG0003",
      details: [{ time: "2026-08-26 22:00:00", desc: "另一错误快递节点" }],
    }],
  }, { waybill: "TARGET0002" }),
  null,
);
assert.equal(parseAccountTimelineResponse("interface5", {
  code: 0,
  data: {
    mailNo: "WRONG0004",
    details: [{ time: "2026-08-26 21:00:00", desc: "错误单记录" }],
  },
}, { waybill: "TARGET0002" }), null);
assert.equal(parseAccountTimelineResponse("interface5", {
  code: 0,
  data: [{
    mailNo: "WRONG0004",
    details: [{ time: "2026-08-26 21:00:00", desc: "错误单记录" }],
  }, {
    details: [{ time: "2026-08-26 20:00:00", desc: "匿名错误记录" }],
  }],
}, { waybill: "TARGET0002" }), null);
const matchedProjectedAlias = parseAccountTimelineResponse("interface5", {
  code: 0,
  data: [{
    mailNo: "WRONG0005",
    details: [{ time: "2026-08-26 23:00:00", desc: "错误订单" }],
  }, {
    mailNo: "SFPROJECTED0003",
    details: [{ time: "2026-08-26 21:00:00", desc: "已投影订单快递节点" }],
  }],
}, {
  waybill: "ORDER0003",
  waybillAliases: ["SFPROJECTED0003"],
});
assert.equal(matchedProjectedAlias?.waybill, "SFPROJECTED0003");

assert.throws(
  () => parseAccountSyncResponse("interface5", { code: 204, message: "private text" }),
  (error: unknown) => error instanceof AccountParseError
    && !error.message.includes("private text"),
);
assert.equal(parseAccountTimelineResponse("interface5", { code: 0, data: null }), null);

const duplicateOwners = parseAccountSyncResponse("interface6", {
  code: 200,
  value: JSON.stringify({
    parcelData: [
      { mailNo: "DUPLICATE", cpName: "First" },
      { mailNo: "DUPLICATE", cpName: "Second" },
    ],
  }),
});
assert.equal(duplicateOwners.length, 1);
assert.equal(duplicateOwners[0].companyName, "First");

console.log("account parser tests passed");
