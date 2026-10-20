import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAccountTimelineResponse, type AccountParcelDto } from "../services/account-parser";
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

const retainedSf = await normalizeAccountParcelCarrier(parcel({
  ownerId: "SF-CACHED-001", waybill: "SF-CACHED-001", sourceProvider: "JingDong",
  courierCode: "SF", rawCourierCode: "JDKD", companyName: "京东购物",
  carrierNormalization: {
    standardCode: "SF", displayName: "顺丰速运", kuaidi100Code: "shunfeng",
    isBuiltIn: true, tableVersion: "cached",
  },
}), {
  recognize: async () => {
    throw new Error("a platform raw label cannot bypass already known SF recognition");
  },
});
assert.equal(retainedSf.courierCode, "SF");
assert.equal(retainedSf.companyName, "顺丰速运");
assert.equal(retainedSf.rawCourierCode, "JDKD");
assert.equal(retainedSf.sourceProvider, "JingDong");

const rawNamedSf = parseAccountTimelineResponse("interface5", {
  code: 0,
  data: {
    mailNo: "SF-RAW-NAME-001", cpCode: "UNKNOWN", name: "顺丰速运", provider: "CaiNiao",
    normalizedCarrierCode: "YTO", normalizedCarrierName: "圆通速递",
    carrierBuiltIn: true, kuaidi100Code: "yuantong", tableVersion: "cached",
  },
});
assert.ok(rawNamedSf);
assert.equal(rawNamedSf.courierCode, "YTO");
assert.equal(rawNamedSf.rawCompanyName, "顺丰速运");
const localNameSf = await normalizeAccountParcelCarrier(rawNamedSf, {
  recognize: async () => { throw new Error("a local raw carrier name needs no recognition"); },
});
assert.equal(localNameSf.courierCode, "SF", "a local raw carrier name precedes a cached normalization");
assert.equal(localNameSf.companyName, "顺丰速运");
assert.equal(localNameSf.rawCourierCode, rawNamedSf.rawCourierCode);
assert.equal(localNameSf.rawCompanyName, rawNamedSf.rawCompanyName);

const projectedSf = await normalizeAccountParcelCarrier(parcel({
  ownerId: "SF-PROJECTED-001", waybill: "SF-PROJECTED-001", courierCode: "SF",
  companyName: "顺丰速运", rawCourierCode: "JDKD", sourceProvider: "JingDong",
  carrierNormalization: {
    standardCode: "YTO", displayName: "圆通速递", kuaidi100Code: "yuantong",
    isBuiltIn: true, tableVersion: "cached",
  },
}), { recognize: async () => { throw new Error("valid projected carrier needs no recognition"); } });
assert.equal(projectedSf.courierCode, "SF", "a valid local projected carrier precedes a cached normalization");

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
  "b6009e8d0a72f68005d3fcc8139b19aeb7113df0751e3db45744632406d525f9",
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
  "b6009e8d0a72f68005d3fcc8139b19aeb7113df0751e3db45744632406d525f9",
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
// Audit C2 (adopted 2026-09-25): every account parcel goes through the carrier helper, not only
// orders; the helper itself returns early without a real waybill. 用户 2026-09-27 第二轮清单：截断排后 changes only the
// order the parcels are recognised in (every index of the list, those cut off last round at the end); the list keeps
// its own order (old shape: `for (const parcel of parsed.parcels) { parcels.push(await prepareAccountParcelCarrier(parcel, {`).
assert.match(
  syncSource,
  /const parcels = \(await enhanceAccountParcels\(\[\.\.\.parsed\.parcels, \.\.\.cachedOrders\], bindings,[\s\S]*?const recognitionOrder = truncatedCarrierRecognitionLast\(\s*parcels\.map\(\(_parcel, index\) => index\),[\s\S]*?\);\s*for \(const index of recognitionOrder\) \{\s*parcels\[index\] = await prepareAccountParcelCarrier\(parcels\[index\], \{/,
  "background account sync must pass every parcel through the shared carrier helper",
);
assert.doesNotMatch(syncSource, /parcel\.accountOrder\s*\?/, "normalization is not gated on order rows");
// T23 (user 2026-09-26, 其余裁决 28): the helper recognises an order's feed-text waybill first and applies it only with
// its carrier (old shape: `normalizeAccountParcelCarrierBestEffort(withAccountOrderTextWaybill(parcel), options)`).
assert.match(
  accountSyncSource,
  /export async function prepareAccountParcelCarrier[\s\S]*?normalizeAccountParcelCarrierBestEffort\(\s*await withRecognizedAccountOrderTextWaybill\(parcel, options\),\s*options,\s*\)/,
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
// Audit C2: the per-waybill detail refresh passes every account parcel through the same helper.
assert.match(
  accountSyncSource.slice(detailStart),
  /return resolved\s*\?\s*options\.recognizeCarrier === false[\s\S]*?prepareAccountParcelCarrier\(resolved,/,
  "detail projection refresh must use the same carrier helper for every account parcel",
);

console.log("account carrier normalization tests passed");

// R-20 (2026-09-03): a JD-platform raw code on a non-JD real waybill is no carrier evidence.
{
  let platformRecognitions = 0;
  const jt = await normalizeAccountParcelCarrier(parcel({
    ownerId: "JT4006839564547",
    waybill: "JT4006839564547",
    courierCode: "JDKD",
    rawCourierCode: "JDKD",
    companyName: "京东快递",
    sourceProvider: "JingDong",
  }), {
    recognize: async () => {
      platformRecognitions += 1;
      return {
        normalization: {
          standardCode: "JTSD", displayName: "极兔速递", kuaidi100Code: "jtexpress",
          isBuiltIn: true, tableVersion: "t1",
        },
        terminal: false, pendingSecondLevel: false, coolingDown: false,
      };
    },
  });
  assert.equal(platformRecognitions, 1);
  assert.equal(jt.courierCode, "JTSD");
  assert.equal(jt.companyName, "极兔速递");

  // A real JD waybill keeps the built-in JD projection without any recognition call.
  const jd = await normalizeAccountParcelCarrier(parcel({
    ownerId: "JDVD10645984010",
    waybill: "JDVD10645984010",
    courierCode: "JDKD",
    rawCourierCode: "JDKD",
    companyName: "京东快递",
    sourceProvider: "JingDong",
  }), {
    recognize: async () => {
      throw new Error("a JD waybill must not be recognised");
    },
  });
  assert.equal(jd.courierCode, "JD");

  // A Worker sidecar that only re-states JD on a non-JD waybill is ignored the same way.
  let sidecarRecognitions = 0;
  const sidecar = await normalizeAccountParcelCarrier(parcel({
    ownerId: "JT4006839564547",
    waybill: "JT4006839564547",
    courierCode: "JD",
    companyName: "京东快递",
    sourceProvider: "JingDong",
    carrierNormalization: {
      standardCode: "JD", displayName: "京东快递", kuaidi100Code: "jd",
      isBuiltIn: true, tableVersion: "t1",
    },
  }), {
    recognize: async () => {
      sidecarRecognitions += 1;
      return {
        normalization: {
          standardCode: "JTSD", displayName: "极兔速递", kuaidi100Code: "jtexpress",
          isBuiltIn: true, tableVersion: "t1",
        },
        terminal: false, pendingSecondLevel: false, coolingDown: false,
      };
    },
  });
  assert.equal(sidecarRecognitions, 1);
  assert.equal(sidecar.courierCode, "JTSD");
}
