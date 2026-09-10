import assert from "node:assert/strict";
import { parseAccountExternalAppRoutes } from "../services/account-parser";
import { parseAccountSyncResponse } from "../services/account-parser";
import { AccountApi, buildAccountSyncRequest } from "../services/account-api";
import { accountExternalAppName, fetchAccountExternalAppRoutes, parcelToShipment } from "../services/account-sync";
import { memory } from "./state-storage-mock";

const parseAccountExternalAppRoute = (...args: Parameters<typeof parseAccountExternalAppRoutes>) =>
  parseAccountExternalAppRoutes(...args)[0]?.url || "";
const waybill = "SYNTHETIC_0001";
const cpCode = "ZTO";
const record = { waybill, companyCode: cpCode, provider: "CaiNiao" };
const link = `cainiao://startapp/logistic?comefrom=xiaomi&mailNo=${waybill}&cpCode=${cpCode}&opaque=unchanged%2Bvalue`;
const response = (links: unknown, fields: object = {}) => ({
  code: 0,
  data: {
    mailNo: waybill,
    cpCode,
    provider: "CaiNiao",
    jumpList: links,
    ...fields,
  },
});
const app = (value: string) => ({ type: "app", link: value });

// Pipi's verified v5 single-parcel Taobao fallback (CainiaoAppLinksTest).
const taobaoOper = "tbopen://m.taobao.com/tbopen/index.html?action=ali.open.nav&module=h5&h5Url="
  + encodeURIComponent(`h5.m.taobao.com/awp/mtb/oper.htm?mailNo=${waybill}`);
assert.equal(parseAccountExternalAppRoute(response([app(taobaoOper)]), record), taobaoOper,
  "a source-issued Taobao fallback must remain available when Cainiao has no handler");

assert.equal(parseAccountExternalAppRoute(response([app(link)]), record), link);
assert.equal(parseAccountExternalAppRoute(response([
  { type: "h5", link: "https://page.cainiao.com/detail" },
  app("cainiao://startapp/list"), app(link), app(link),
]), record), link, "selection preserves the first usable provider-issued URI verbatim");

for (const invalid of [
  link.replace(waybill, "OTHER"),
  link.replace("cpCode=ZTO", "cpCode=YTO"),
  link.replace("comefrom=xiaomi", "comefrom=other"),
  `${link}&mailNo=OTHER`, `${link}&cpCode=YTO`,
  `${link}#fragment`, ` ${link}`, `${link}\n`,
  link.replace("startapp/", "startapp.evil/"),
  link.replace("startapp/", "user@startapp/"),
  "javascript:alert(1)", "https://page.cainiao.com/detail", "",
]) assert.equal(parseAccountExternalAppRoute(response([app(invalid)]), record), "");

for (const changed of [
  { mailNo: "OTHER" }, { mailNo: "" }, { provider: "JingDong" },
  { provider: "" }, { cpCode: "YTO" },
]) assert.equal(parseAccountExternalAppRoute(response([app(link)], changed), record), "");
assert.equal(parseAccountExternalAppRoute(response(null), record), "");
assert.equal(parseAccountExternalAppRoute(response([app(link)]), { ...record, provider: "ShunFeng" }), "");

const order = "9876543210987654";
const jd = "openapp.jdmobile://virtual?params=" + encodeURIComponent(JSON.stringify({
  category: "jump", des: "m", url: "https://u.jd.com/forward?fixture=1",
}));
const jdRecord = { waybill: order, companyCode: "JDKD", provider: "JingDong" };
const jdResponse = (uri: string) => response([app(uri)], {
  mailNo: order, cpCode: "JDKD", provider: "JingDong",
});
assert.equal(parseAccountExternalAppRoute(jdResponse(jd), jdRecord), jd);
assert.equal(parseAccountExternalAppRoute(jdResponse(jd), { ...jdRecord, waybill: "JD_PROJECTED_0001" }), "",
  "a projected display waybill must not substitute the source order identity");
for (const invalid of [
  jd.replace("virtual?", "virtual.evil?"),
  "openapp.jdmobile://virtual?params=", `${jd}#fragment`, `${jd}\n`, link,
]) assert.equal(parseAccountExternalAppRoute(jdResponse(invalid), jdRecord), "");
assert.throws(() => parseAccountExternalAppRoute({ code: 1, data: {} }, record));

memory.set("keychain:pipi_deliveries_account_v5_identity_v1", JSON.stringify({
  userId: "1234567890", oaid: "0011223344556677", vaid: "8899aabbccddeeff",
}));
const parcel = parseAccountSyncResponse("interface5", {
  code: 0, data: { expressList: [{
    mailNo: order, cpCode: "JDKD", provider: "JingDong", stateNum: 104,
    phone: "13800138000", details: [{ time: "2026-09-09 12:00:00", desc: "运输中" }],
  }] },
})[0];
const shipment = parcelToShipment(parcel, ["13800138000"]);
assert.ok(shipment);
shipment.identity.projectedWaybill = "SF_SYNTHETIC_0001";
shipment.identity.courierCode = "SF";
assert.equal(accountExternalAppName(shipment), "京东");
assert.equal(accountExternalAppName({ ...shipment, identity: { ...shipment.identity, manuallyAdded: true } }), "");
assert.equal(accountExternalAppName({ ...shipment, identity: { ...shipment.identity, sourceProvider: "ShunFeng" } }), "");
assert.equal(accountExternalAppName({ ...shipment, accountRecord: { ...shipment.accountRecord!, waybill: "OTHER" } }), "");

const initial = JSON.stringify(shipment);
const original = AccountApi.prototype.sync;
let requests = 0;
let abortDuringRequest: AbortController | null = null;
try {
  AccountApi.prototype.sync = async (request) => {
    requests++;
    const built = buildAccountSyncRequest(request);
    assert.equal(built.route, "/api/express/accounts/sync");
    assert.deepEqual(built.payload.phones, ["13800138000"]);
    abortDuringRequest?.abort();
    return { code: 0, data: { expressList: [jdResponse(jd).data] } };
  };
  assert.deepEqual(await fetchAccountExternalAppRoutes(shipment, new AbortController().signal), [{ kind: "jd", url: jd }]);
  assert.equal(requests, 1);
  assert.equal(JSON.stringify(shipment), initial, "navigation must not publish business state");
  const cancelled = new AbortController();
  cancelled.abort();
  assert.deepEqual(await fetchAccountExternalAppRoutes(shipment, cancelled.signal), []);
  assert.equal(requests, 1, "already-cancelled navigation must not query");
  memory.delete("keychain:pipi_deliveries_account_app_routes_v1");
  abortDuringRequest = new AbortController();
  assert.deepEqual(await fetchAccountExternalAppRoutes(shipment, abortDuringRequest.signal), []);
  assert.equal(requests, 2, "a result arriving after detail closes must not launch an App");
} finally {
  AccountApi.prototype.sync = original;
}

// Same v5 route partitions as Pipi's CainiaoAppLinksTest: miniature App, oper, and Alipay page/query.
const attribution = `from=xiaomi&showcard=true&insertPackage=true&cpCode=${cpCode}&mailNo=${waybill}`;
const miniapp = `https://m.duanqu.com?_ariver_appid=11509317&${attribution}&query=${encodeURIComponent(attribution)}`;
const taobao = "tbopen://m.taobao.com/tbopen/index.html?action=ali.open.nav&module=h5&h5Url=" + encodeURIComponent(miniapp);
const alipay = "alipays://platformapi/startapp?appId=2021001141626787&query=" + encodeURIComponent(attribution);
const alipayPage = "alipays://platformapi/startapp?appId=2021001141626787&page="
  + encodeURIComponent(`pages/logistic/logistic?appName=GUOGUO&mailNo=${waybill}`)
  + "&query=from%3Dxiaomifuyiping202409";
const sourceLinks = [alipay, taobaoOper, link, taobao, alipayPage, link];
const expectedLinks = [link, link, taobaoOper, taobao, alipay, alipayPage];
const packet = response(sourceLinks.map(app));
const before = JSON.stringify(packet);
assert.deepEqual(parseAccountExternalAppRoutes(packet, record).map((target) => target.url), expectedLinks);
assert.equal(JSON.stringify(packet), before, "App preference must not reorder the original packet");
assert.deepEqual(parseAccountExternalAppRoutes(response([app(alipay), app(taobao)]), record)
  .map((target) => target.kind), ["taobao", "alipay"]);

for (const invalid of [
  taobao.replace(encodeURIComponent(waybill), "OTHER"),
  taobao.replace("m.duanqu.com", "evil.example"),
  taobao.replace("11509317", "OTHER"),
  taobao.replace("insertPackage%253Dtrue", "insertPackage%253Dfalse"),
  taobao.replace("insertPackage%3Dtrue", "insertPackage%3Dfalse"),
  taobao.replace("h5Url=", "h5Url=&h5Url="),
  taobaoOper.replace(waybill, "OTHER"),
  alipay.replace("2021001141626787", "OTHER"),
  alipay.replace("cpCode%3DZTO", "cpCode%3DYTO"),
  alipayPage.replace(waybill, "OTHER"),
  alipayPage.replace("xiaomifuyiping202409", "other"),
  `${link}&MAILNO=OTHER`, `${link}&opaque=%zz`,
]) assert.deepEqual(parseAccountExternalAppRoutes(response([app(invalid)]), record), []);

for (const candidate of [link, taobao, alipay, taobaoOper, alipayPage]) {
  const withSecret = `${candidate}&secretKey=SYNTHETIC_SECRET`;
  assert.equal(parseAccountExternalAppRoutes(response([app(withSecret)], {
    secretKey: "SYNTHETIC_SECRET",
  }), record).length, 1);
  assert.deepEqual(parseAccountExternalAppRoutes(response([app(withSecret)], {
    secretKey: "OTHER_SYNTHETIC_SECRET",
  }), record), []);
}
const diagnostics: unknown[] = [];
parseAccountExternalAppRoutes(response([app(link)]), record, (value) => diagnostics.push(value));
parseAccountExternalAppRoutes(response([], { provider: "" }), record, (value) => diagnostics.push(value));
assert.deepEqual(diagnostics, [
  { result: "ready", rawRecords: 1, records: 1 },
  { result: "provider_mismatch", rawRecords: 0, records: 0 },
]);
assert.ok(!JSON.stringify(diagnostics).includes(waybill));

const sf = "com.sf-express://order/detail?id=synthetic%2Bopaque";
const sfRecord = { waybill: "SF_SYNTHETIC_0001", companyCode: "SF", provider: "ShunFeng" };
const sfResponse = (links: unknown, fields: object = {}) => response(links, {
  mailNo: sfRecord.waybill, cpCode: "SF", provider: "ShunFeng", ...fields,
});
assert.deepEqual(parseAccountExternalAppRoutes(sfResponse([
  { type: "other", link: "hap://app/example" }, { type: "h5", link: "https://www.sf-express.com/" }, app(sf),
]), sfRecord), [{ kind: "sf", url: sf }]);
for (const invalid of ["com.sf-express://", "com.sf-express.evil://order/detail", ` ${sf}`, `${sf}\n`,
  `${sf}#fragment`, "hap://app/example", "https://www.sf-express.com/", link, jd]) {
  assert.deepEqual(parseAccountExternalAppRoutes(sfResponse([app(invalid)]), sfRecord), []);
}
for (const fields of [{ mailNo: "OTHER" }, { provider: "CaiNiao" }, { cpCode: "YTO" }, { cpCode: "" }]) {
  assert.deepEqual(parseAccountExternalAppRoutes(sfResponse([app(sf)], fields), sfRecord), []);
}
