import assert from "node:assert/strict";
import { AccountApi } from "../services/account-api";
import { parseAccountSyncResponse } from "../services/account-parser";
import { accountExternalAppName, fetchAccountExternalAppRoutes, parcelToShipment } from "../services/account-sync";
import { memory } from "./state-storage-mock";
import { loadAccountAppRoutes, pruneAccountAppRoutes, saveAccountAppRoutes } from "../services/routes";

const phone = "13800138000";
const order = "9876543210987654";
const jd = "openapp.jdmobile://virtual?params=" + encodeURIComponent(JSON.stringify({
  category: "jump", des: "m", url: "https://u.jd.com/forward?fixture=source-feed",
}));
const row = {
  mailNo: order, cpCode: "JDKD", provider: "JingDong", stateNum: 104, phone,
  details: [{ time: "2026-09-09 12:00:00", desc: "运输中" }],
  jumpList: [{ type: "app", link: jd }],
};
const feed = { code: 0, data: { expressList: [row] } };
const parcel = parseAccountSyncResponse("interface5", feed)[0];
const shipment = parcelToShipment(parcel, [phone])!;
shipment.identity.projectedWaybill = "SF_SYNTHETIC_0001";
shipment.identity.courierCode = "SF";
memory.set("keychain:pipi_deliveries_account_v5_identity_v1", JSON.stringify({
  userId: "1234567890", oaid: "0011223344556677", vaid: "8899aabbccddeeff",
}));
const originalSync = AccountApi.prototype.sync;
const originalTimeline = AccountApi.prototype.timeline;
let syncs = 0;
let queries = 0;
try {
  AccountApi.prototype.sync = async (request) => {
    syncs++;
    assert.equal(request.source, "interface5");
    assert.deepEqual(request.phones, [phone]);
    return feed;
  };
  AccountApi.prototype.timeline = async () => {
    queries++;
    // Observed build 64 partition: query has tracks, but no jumpList.
    return { code: 0, data: { ...row, jumpList: [] } };
  };
  const before = JSON.stringify(shipment);
  assert.deepEqual(await fetchAccountExternalAppRoutes(shipment, new AbortController().signal),
    [{ kind: "jd", url: jd }], "restore source-issued App links from getList, not the timeline query");
  assert.equal(syncs, 1);
  assert.equal(queries, 0);
  AccountApi.prototype.sync = async () => { throw new Error("network unavailable"); };
  assert.deepEqual(await fetchAccountExternalAppRoutes(shipment, new AbortController().signal),
    [{ kind: "jd", url: jd }], "cached source links must open without a network request");
  assert.equal(JSON.stringify(shipment), before, "navigation cannot alter shipment business state");
  assert.ok(!before.includes(jd), "source capabilities cannot enter business snapshots");
  for (const replacement of [
    { waybill: "OTHER_ORDER" }, { companyCode: "YTO" }, { provider: "CaiNiao" }, { phone: "13900139000" },
  ]) assert.deepEqual(loadAccountAppRoutes({ ...shipment.accountRecord!, ...replacement }), []);
  assert.equal(saveAccountAppRoutes([{ record: shipment.accountRecord!, route: { targets: [], secretKey: "" } }]), 0);
  assert.equal(loadAccountAppRoutes(shipment.accountRecord!).length, 1, "a sparse query must not erase feed links");
  pruneAccountAppRoutes([]);
  assert.deepEqual(loadAccountAppRoutes(shipment.accountRecord!), [], "deletion or unbinding removes navigation capabilities");

  const cn = { ...row, mailNo: "CN_SYNTHETIC_0001", cpCode: "ZTO", provider: "CaiNiao" };
  const cnLink = `cainiao://startapp/logistic?comefrom=xiaomi&mailNo=${cn.mailNo}&cpCode=ZTO`;
  cn.jumpList = [{ type: "app", link: cnLink }];
  const cnParcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [cn] } })[0];
  const cnShipment = parcelToShipment(cnParcel, [phone])!;
  saveAccountAppRoutes([{ record: cnShipment.accountRecord!, route: cnParcel.appRoute! }]);
  assert.deepEqual(await fetchAccountExternalAppRoutes(cnShipment, new AbortController().signal),
    [{ kind: "cainiao", url: cnLink }], "a cached Cainiao source link must bypass the failing network");

  // Fold7 v5 evidence: ShunFeng returns app / hap / HTTPS entries. Only the original native App entry is eligible.
  const sfLink = "com.sf-express://order/detail?id=synthetic%2Bopaque";
  const sf = { ...row, mailNo: "SF_SYNTHETIC_0001", cpCode: "SF", provider: "ShunFeng",
    jumpList: [{ type: "app", link: sfLink }, { type: "other", link: "hap://app/example" },
      { type: "h5", link: "https://www.sf-express.com/" }] };
  const sfParcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [sf] } })[0];
  const sfShipment = parcelToShipment(sfParcel, [phone])!;
  assert.equal(accountExternalAppName(sfShipment), "", "do not display an SF action without a retained source capability");
  assert.deepEqual(sfParcel.appRoute?.targets, [{ kind: "sf", url: sfLink }]);
  assert.equal(saveAccountAppRoutes([{ record: sfShipment.accountRecord!, route: sfParcel.appRoute! }]), 1);
  assert.equal(accountExternalAppName(sfShipment), "顺丰");
  assert.deepEqual(await fetchAccountExternalAppRoutes(sfShipment, new AbortController().signal),
    [{ kind: "sf", url: sfLink }], "the original SF URI must open from cache, without an account request");
  for (const replacement of [
    { waybill: "OTHER" }, { companyCode: "YTO" }, { provider: "JingDong" }, { phone: "13900139000" },
  ]) assert.deepEqual(loadAccountAppRoutes({ ...sfShipment.accountRecord!, ...replacement }), []);
  pruneAccountAppRoutes([]);
  assert.equal(accountExternalAppName(sfShipment), "", "deletion/unbinding must also remove the SF action");
} finally {
  AccountApi.prototype.sync = originalSync;
  AccountApi.prototype.timeline = originalTimeline;
}
