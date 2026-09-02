import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AccountParcelDto } from "../services/account-parser";
import {
  hasBuiltInAccountCarrierName,
  normalizeAccountParcelCarrier,
} from "../services/account-carrier-normalization";

function parcel(input: Partial<AccountParcelDto> = {}): AccountParcelDto {
  return {
    source: "interface5",
    ownerId: "JDAP123456789012",
    waybill: "JDAP123456789012",
    orderId: "",
    accountOrder: false,
    courierCode: "RAW",
    companyName: "原始厂商标签",
    carrierNormalization: null,
    sourceProvider: "JingDong",
    sourceStateCode: "104",
    sourceStateText: "运输中",
    semantic: "TRANSIT",
    receiverPhone: "13800001515",
    senderPhone: "",
    latestTimeText: "2026-08-29 10:00:00",
    latestDetail: "运输中",
    tracks: [],
    routeUrl: "",
    projectionUrl: "",
    ...input,
  };
}

assert.equal(hasBuiltInAccountCarrierName(" 顺 丰 速 运 "), true);
assert.equal(hasBuiltInAccountCarrierName("京东购物"), false);
assert.equal(hasBuiltInAccountCarrierName("EMS国际"), false);

let unprojectedRecognitionCalls = 0;
const unprojectedOrder = parcel({
  ownerId: "ORDER202609020000",
  orderId: "ORDER202609020000",
  waybill: "ORDER202609020000",
  accountOrder: true,
  courierCode: "JD",
  companyName: "京东购物",
});
assert.strictEqual(await normalizeAccountParcelCarrier(unprojectedOrder, {
  recognize: async () => {
    unprojectedRecognitionCalls++;
    throw new Error("an order id must not enter carrier recognition");
  },
}), unprojectedOrder);
assert.equal(unprojectedRecognitionCalls, 0);

let recognitionCalls = 0;
const direct = await normalizeAccountParcelCarrier(parcel({
  rawCourierCode: "KYE",
  courierCode: "KYE",
  companyName: "跨越",
}), {
  recognize: async () => {
    recognitionCalls++;
    throw new Error("must not classify a built-in alias");
  },
});
assert.equal(recognitionCalls, 0);
assert.equal(direct.courierCode, "KYSY");
assert.equal(direct.companyName, "跨越速运");

const jdPrefix = await normalizeAccountParcelCarrier(parcel({
  source: "interface2",
  ownerId: "owner-jdvd",
  courierCode: "JDVD",
  rawCourierCode: "JDVD",
  companyName: "上游原始名称",
  sourceProvider: "CaiNiao",
  routeUrl: "pipi-route:opaque-jdvd-route",
  projectionUrl: "https://projection.invalid/jdvd",
}), {
  recognize: async () => {
    throw new Error("JD* must not enter carrier recognition");
  },
});
assert.equal(jdPrefix.rawCourierCode, "JDVD");
assert.equal(jdPrefix.courierCode, "JD");
assert.equal(jdPrefix.companyName, "京东快递");
assert.equal(jdPrefix.source, "interface2");
assert.equal(jdPrefix.ownerId, "owner-jdvd");
assert.equal(jdPrefix.sourceProvider, "CaiNiao");
assert.equal(jdPrefix.routeUrl, "pipi-route:opaque-jdvd-route");
assert.equal(jdPrefix.projectionUrl, "https://projection.invalid/jdvd");
assert.equal(
  jdPrefix.carrierNormalization?.tableVersion,
  "6e4ec3e45a460dbea446093a9b7ccb81b2da80f716f57369bc32572d640dda0e",
);

const newlyBuiltInRawCode = await normalizeAccountParcelCarrier(parcel({
  courierCode: "YZPY",
  rawCourierCode: "EYB",
  rawCompanyName: "旧上游名称",
  companyName: "邮政快递",
  carrierNormalization: {
    standardCode: "YZPY",
    displayName: "邮政快递",
    kuaidi100Code: "youzhengguonei",
    isBuiltIn: true,
    tableVersion: "worker@old",
  },
}), {
  recognize: async () => {
    throw new Error("an approved raw cpCode must override stale normalization");
  },
});
assert.equal(newlyBuiltInRawCode.rawCourierCode, "EYB");
assert.equal(newlyBuiltInRawCode.rawCompanyName, "旧上游名称");
assert.equal(newlyBuiltInRawCode.courierCode, "EMS");
assert.equal(newlyBuiltInRawCode.companyName, "EMS");
assert.equal(newlyBuiltInRawCode.carrierNormalization?.standardCode, "EMS");
assert.equal(newlyBuiltInRawCode.carrierNormalization?.kuaidi100Code, "ems");
assert.equal(
  newlyBuiltInRawCode.carrierNormalization?.tableVersion,
  "6e4ec3e45a460dbea446093a9b7ccb81b2da80f716f57369bc32572d640dda0e",
);

const internalJdky = await normalizeAccountParcelCarrier(parcel({
  courierCode: "JDKY",
  companyName: "京东快运",
}), {
  recognize: async () => {
    throw new Error("an exact internal code must not enter carrier recognition");
  },
});
assert.equal(internalJdky.courierCode, "JDKY");
assert.equal(internalJdky.companyName, "京东快运");

const recognized = await normalizeAccountParcelCarrier(parcel(), {
  recognize: async () => ({
    normalization: {
      standardCode: "SF",
      displayName: "顺丰速运",
      kuaidi100Code: "shunfeng",
      isBuiltIn: true,
      tableVersion: "worker@1",
    },
    terminal: false,
    pendingSecondLevel: false,
    coolingDown: false,
  }),
});
assert.equal(recognized.courierCode, "SF");
assert.equal(recognized.companyName, "顺丰速运");
assert.equal(recognized.carrierNormalization?.tableVersion, "worker@1");

let projectedRecognitionCalls = 0;
const recognizedProjection = await normalizeAccountParcelCarrier(parcel({
  ownerId: "ORDER202609020001",
  orderId: "ORDER202609020001",
  waybill: "REALWAYBILL202609020001",
  accountOrder: true,
  courierCode: "",
  rawCourierCode: "UPSTREAM_UNKNOWN",
  rawCompanyName: "上游原始名称",
  companyName: "快递",
}), {
  recognize: async (waybill) => {
    projectedRecognitionCalls++;
    assert.equal(waybill, "REALWAYBILL202609020001");
    return {
      normalization: {
        standardCode: "JD",
        displayName: "京东快递",
        kuaidi100Code: "jd",
        isBuiltIn: true,
        tableVersion: "worker@projected",
      },
      terminal: false,
      pendingSecondLevel: false,
      coolingDown: false,
    };
  },
});
assert.equal(projectedRecognitionCalls, 1);
assert.equal(recognizedProjection.rawCourierCode, "UPSTREAM_UNKNOWN");
assert.equal(recognizedProjection.rawCompanyName, "上游原始名称");
assert.equal(recognizedProjection.courierCode, "JD");
assert.equal(recognizedProjection.companyName, "京东快递");
assert.equal(
  recognizedProjection.carrierNormalization?.tableVersion,
  "worker@projected",
);

const unresolved = parcel();
assert.strictEqual(await normalizeAccountParcelCarrier(unresolved, {
  recognize: async () => ({
    normalization: null,
    terminal: true,
    pendingSecondLevel: false,
    coolingDown: false,
  }),
}), unresolved, "terminal recognition keeps the raw carrier presentation");

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const accountSyncSource = await readFile(
  resolve(projectDir, "services/account-sync.ts"),
  "utf8",
);
const syncStart = accountSyncSource.indexOf(
  "export async function fetchAccountParcels",
);
const manualStart = accountSyncSource.indexOf(
  "export async function queryAccountManual",
  syncStart,
);
assert.ok(syncStart >= 0 && manualStart > syncStart);
const syncSource = accountSyncSource.slice(syncStart, manualStart);
assert.match(
  syncSource,
  /normalizeAccountParcelCarrier/,
  "background account sync must normalize a projected real waybill through the shared carrier helper",
);
const detailStart = accountSyncSource.indexOf(
  "export async function refreshAccountParcel",
  manualStart,
);
assert.ok(detailStart > manualStart);
assert.match(
  accountSyncSource.slice(manualStart, detailStart),
  /normalizeAccountParcelCarrier/,
  "manual account lookup must use the same carrier helper",
);
assert.match(
  accountSyncSource.slice(detailStart),
  /normalizeAccountParcelCarrier/,
  "detail projection refresh must use the same carrier helper",
);

console.log("account carrier normalization tests passed");
