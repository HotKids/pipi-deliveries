import assert from "node:assert/strict";
import { accountKuaidi100URL, kuaidi100MiniProgramURL, shunfengKuaidi100FallbackURL } from "../services/kuaidi100-app-link";
import type { AccountBinding, Shipment } from "../models";

assert.equal(kuaidi100MiniProgramURL(" - \u200b"), "");
const link = kuaidi100MiniProgramURL("jd 0000-0000-0162");
const parsed = new URL(link);
assert.equal(parsed.protocol, "weixin:");
assert.equal(parsed.hostname, "dl");
assert.equal(parsed.pathname, "/business/");
assert.equal(parsed.searchParams.get("appid"), "wx6885acbedba59c14");
assert.equal(parsed.searchParams.get("path"), "pages/result/result");
assert.equal(parsed.searchParams.get("env_version"), "release");
assert.equal(parsed.searchParams.get("query"), "nu=JD000000000162&querysource=third_xcx");
assert.equal(parsed.searchParams.has("com"), false);
assert.match(link, /&path=pages\/result\/result&query=nu%3DJD000000000162%26querysource%3Dthird_xcx&/);

const sf = {
  identity: { id: "synthetic-sf", manuallyAdded: false, sourceProvider: "ShunFeng", bindingSource: "interface5",
    sourceOwner: "synthetic-account", sourceId: "SF000000000162", courierCode: "SF" },
  accountRecord: { provider: "ShunFeng", waybill: "SF000000000162", phone: "13800138000", companyCode: "SF" },
  timeline: { waybill: "SF000000000162" },
} as Shipment;
assert.equal(shunfengKuaidi100FallbackURL(sf, sf), kuaidi100MiniProgramURL("SF000000000162"));
for (const current of [undefined,
  { ...sf, identity: { ...sf.identity, id: "replacement" } },
  { ...sf, identity: { ...sf.identity, manuallyAdded: true } },
  { ...sf, identity: { ...sf.identity, accountOrder: true } },
  { ...sf, identity: { ...sf.identity, sourceProvider: "CaiNiao" } },
  { ...sf, identity: { ...sf.identity, bindingSource: null } },
  { ...sf, identity: { ...sf.identity, sourceOwner: "another-account" } },
  { ...sf, identity: { ...sf.identity, sourceId: "SF000000000163" } },
  { ...sf, identity: { ...sf.identity, projectedWaybill: "SF000000000163" } },
  { ...sf, accountRecord: { ...sf.accountRecord!, phone: "13900139000" } },
  { ...sf, accountRecord: { ...sf.accountRecord!, companyCode: "YTO" } },
  { ...sf, accountRecord: { ...sf.accountRecord!, provider: "CaiNiao" } },
  { ...sf, accountRecord: { ...sf.accountRecord!, waybill: "SF000000000163" } },
]) assert.equal(shunfengKuaidi100FallbackURL(sf, current), "");

const account = {
  identity: { id: "synthetic-other-account", manuallyAdded: false, sourceProvider: "OtherAccount", bindingSource: "interface5",
    sourceOwner: "interface5", sourceId: "JT000000000162", courierCode: "HTKY" },
  accountRecord: { provider: "OtherAccount", waybill: "JT000000000162", phone: "13800138000", companyCode: "HTKY" },
  timeline: { waybill: "JT000000000162" },
} as Shipment;
const accountBinding: AccountBinding = { source: "interface5", phone: "13800138000", boundAtMs: 5 };
const scopedAccountURL = (shipment: Shipment, current: Shipment | undefined) =>
  accountKuaidi100URL(shipment, current, accountBinding, accountBinding);
assert.equal(accountKuaidi100URL(account, account, undefined, undefined), "",
  "retained account metadata after unbinding is not an active source capability");
for (const currentBinding of [undefined,
  { ...accountBinding, source: "interface6" as const },
  { ...accountBinding, phone: "13900139000" },
  { ...accountBinding, boundAtMs: 6 },
]) assert.equal(accountKuaidi100URL(account, account, accountBinding, currentBinding), "");
assert.equal(scopedAccountURL(account, account), kuaidi100MiniProgramURL("JT000000000162"));
assert.equal(scopedAccountURL({ ...account, identity: { ...account.identity, courierCode: "UNMATCHED" } },
  { ...account, identity: { ...account.identity, courierCode: "UNMATCHED" } }), kuaidi100MiniProgramURL("JT000000000162"),
  "a direct same-waybill launch does not require carrier recognition");
for (const provider of ["JingDong", "CaiNiao", "ShunFeng", " CaiNiao "]) {
  const supported = { ...account, identity: { ...account.identity, sourceProvider: provider },
    accountRecord: { ...account.accountRecord!, provider } };
  assert.equal(scopedAccountURL(supported, supported), "", "source App failure is not a missing capability");
}
for (const invalid of [
  { ...account, identity: { ...account.identity, sourceProvider: "" },
    accountRecord: { ...account.accountRecord!, provider: "" } },
  { ...account, identity: { ...account.identity, manuallyAdded: true } },
  { ...account, identity: { ...account.identity, bindingSource: null } },
  { ...account, identity: { ...account.identity, accountOrder: true } },
  { ...account, identity: { ...account.identity, sourceProvider: "CaiNiao" } },
  { ...account, accountRecord: { ...account.accountRecord!, provider: "CaiNiao" } },
  { ...account, accountRecord: { ...account.accountRecord!, waybill: "JT000000000163" } },
  { ...account, accountRecord: null },
  { ...account, timeline: { ...account.timeline, waybill: "" } },
  { ...account, timeline: { ...account.timeline, waybill: "JT000000000163" } },
]) assert.equal(scopedAccountURL(invalid, invalid), "");
for (const current of [undefined,
  { ...account, identity: { ...account.identity, id: "replacement" } },
  { ...account, identity: { ...account.identity, sourceOwner: "another-account" } },
  { ...account, identity: { ...account.identity, sourceId: "JT000000000163" } },
  { ...account, identity: { ...account.identity, sourceProvider: "ReplacementAccount" },
    accountRecord: { ...account.accountRecord!, provider: "ReplacementAccount" } },
  { ...account, accountRecord: { ...account.accountRecord!, phone: "13900139000" } },
  { ...account, accountRecord: { ...account.accountRecord!, companyCode: "YTO" } },
]) assert.equal(scopedAccountURL(account, current), "");
const projectedAccount = { ...account, identity: { ...account.identity, accountOrder: true,
  sourceId: "351000000162", projectedWaybill: "JT000000000162" },
  accountRecord: { ...account.accountRecord!, waybill: "351000000162" } };
assert.equal(scopedAccountURL(projectedAccount, projectedAccount), kuaidi100MiniProgramURL("JT000000000162"),
  "a projected order opens the real displayed waybill and never the order identifier");
