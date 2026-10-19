import assert from "node:assert/strict";
import { kuaidi100MiniProgramURL, shunfengKuaidi100FallbackURL } from "../services/kuaidi100-app-link";
import type { Shipment } from "../models";

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
