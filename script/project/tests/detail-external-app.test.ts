import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { displayWaybill } from "../services/shipment-policy";
import { normalizeWaybill, waybillSuffix } from "../services/status";
import { accountKuaidi100URL, kuaidi100MiniProgramURL, shunfengKuaidi100FallbackURL } from "../services/kuaidi100-app-link";
import { pddParcelAppURL } from "../services/platform-parcel-data";
import { cloudPddParcelAppURL, hasPddParcelSource, samePlatformTarget, type CloudParcelPddLink } from "../services/platform-parcel-merge";
import type { AccountBinding, Shipment } from "../models";

const page = readFileSync(new URL("../pages/DetailPage.tsx", import.meta.url), "utf8");
const start = page.indexOf("  async function openExternalApp() {");
const end = page.indexOf("\n  return (", start);
assert.ok(start >= 0 && end > start);
assert.match(page.slice(end), /topBarTrailing:[\s\S]*?action=\{openExternalApp\}/);
assert.doesNotMatch(page.slice(end), /在拼多多 App 中打开/);
// Run the actual page action with a synthetic native opener and request boundary.
const action = new Function(
  "externalAppAbortRef", "externalAppName", "setOpeningExternalApp",
  "fetchAccountExternalAppRoutes", "shipment", "setNotice", "Safari", "writeDiagnostic",
  "displayWaybill", "waybillSuffix", "props", "loadState", "kuaidi100MiniProgramURL", "normalizeWaybill",
  "shunfengKuaidi100FallbackURL", "accountExternalAppName", "accountKuaidi100URL", "accountBindingRef",
  "pddExternalAppURL", "samePlatformTarget", "pddParcelAppURL", "gatewayCredentialGeneration", "cloudGeneration",
  "ownsCloudWaybill", "cloudPddParcelAppURL", "cloudDetails",
  "platformSession", "presentPddParcelH5", "hasPddParcelSource",
  `return (${page.slice(start, end).trim()});`,
);

function scenario(openResult: boolean | Error | (boolean | Error)[] = true, requestFailure = false, appName = "菜鸟",
  options: { shipment?: Shipment; persisted?: boolean; current?: Shipment[]; loadFailure?: boolean;
    states?: { shipments: Shipment[]; bindings: AccountBinding[] }[]; currentAppName?: string;
    cancelAfterOpen?: boolean; binding?: AccountBinding; pddURL?: string; pddLink?: CloudParcelPddLink;
    credentialChanged?: boolean; ownsCloudWaybill?: boolean; pddLogin?: "active" | "expired" | "unavailable" } = {}) {
  let resolveTargets!: (targets: { kind: string; url: string }[]) => void;
  const route = new Promise<{ kind: string; url: string }[]>((resolve) => { resolveTargets = resolve; });
  const resolveRoute = (value: string) => resolveTargets(value ? [{ kind: "cainiao", url: value }] : []);
  const diagnostics: unknown[] = [];
  const ref: { current: AbortController | null } = { current: null };
  const busy: boolean[] = [];
  const notices: string[] = [];
  const opened: string[] = [];
  const h5: string[] = [];
  let pddLogin = options.pddLogin;
  let requests = 0;
  let stateReads = 0;
  const run = action(ref, appName, (value: boolean) => busy.push(value), async () => {
    requests++;
    if (requestFailure) throw new Error("synthetic request failure");
    if (options.shipment?.identity.manuallyAdded) return [];
    return route;
  }, options.shipment || { identity: { sourceId: "JT0000000000162", courierCode: "HTKY", sourceProvider: "CaiNiao" },
    timeline: { waybill: "JT0000000000162" } }, (value: string) => notices.push(value), {
    async openURL(value: string) {
      opened.push(value);
      const result = Array.isArray(openResult) ? openResult[opened.length - 1] : openResult;
      if (options.cancelAfterOpen) ref.current?.abort();
      if (result instanceof Error) throw result;
      return result;
    },
  }, (event: string, details: unknown) => diagnostics.push({ event, details }), displayWaybill, waybillSuffix,
  { persistedShipment: options.persisted }, () => {
    if (options.loadFailure) throw new Error("synthetic state failure");
    const state = options.states?.[Math.min(stateReads, options.states.length - 1)];
    stateReads++;
    return state || { shipments: options.current || [], bindings: options.binding ? [options.binding] : [] };
  }, kuaidi100MiniProgramURL, normalizeWaybill, shunfengKuaidi100FallbackURL,
  () => options.currentAppName ?? "顺丰", accountKuaidi100URL, { current: options.binding }, options.pddURL ?? "",
  samePlatformTarget, pddParcelAppURL, () => options.credentialChanged ? "updated" : "original", "original",
  () => options.ownsCloudWaybill !== false, cloudPddParcelAppURL, { pddLink: options.pddLink },
  () => pddLogin ? { generation: "synthetic" } : null, async (value: string) => {
    h5.push(value);
    if (pddLogin === "unavailable") throw new Error("synthetic page unavailable");
    if (pddLogin === "expired") { pddLogin = undefined; return false; }
    return true;
  }, hasPddParcelSource) as () => Promise<void>;
  return { run, resolveRoute, resolveTargets, diagnostics, ref, busy, notices, opened, h5, requestCount: () => requests };
}

const uri = "cainiao://startapp/logistic?fixture=synthetic";
const repeated = scenario();
const first = repeated.run();
await repeated.run();
assert.equal(repeated.requestCount(), 1);
repeated.resolveRoute(uri);
await first;
assert.deepEqual(repeated.opened, [uri]);
assert.deepEqual(repeated.busy, [true, false]);
assert.deepEqual(repeated.diagnostics, [{ event: "detail.external.open", details: {
  stage: "cainiao", attempted: 1, result: "opened", waybillTail: "0162",
  carrierCode: "HTKY", sourceProvider: "CaiNiao",
} }]);

const cancelled = scenario();
const pending = cancelled.run();
cancelled.ref.current!.abort();
cancelled.resolveRoute(uri);
await pending;
assert.deepEqual(cancelled.opened, []);
assert.deepEqual(cancelled.notices, []);

const missing = scenario();
const missingTask = missing.run();
missing.resolveRoute("");
await missingTask;
assert.deepEqual(missing.opened, []);
assert.deepEqual(missing.notices, ["来源暂未提供可用的菜鸟应用链接"]);

const unavailable = scenario(false);
const unavailableTask = unavailable.run();
unavailable.resolveRoute(uri);
await unavailableTask;
assert.deepEqual(unavailable.notices, ["打开失败，请确认已安装菜鸟、淘宝或支付宝"]);

for (const failed of [scenario(true, true)]) {
  const task = failed.run();
  failed.resolveRoute(uri);
  await task;
  assert.deepEqual(failed.notices, ["打开菜鸟失败，请稍后重试"]);
  assert.deepEqual(failed.busy, [true, false]);
}

const targets = [
  { kind: "cainiao", url: uri },
  { kind: "taobao", url: "tbopen://m.taobao.com/tbopen/index.html?fixture=synthetic" },
  { kind: "alipay", url: "alipays://platformapi/startapp?fixture=synthetic" },
];
for (const [results, count] of [
  [[true], 1], [[false, true], 2], [[false, false, true], 3],
  [[new Error("synthetic native failure"), false, true], 3],
] as const) {
  const fallback = scenario([...results]);
  const task = fallback.run();
  fallback.resolveTargets(targets);
  await task;
  assert.deepEqual(fallback.opened, targets.slice(0, count).map((target) => target.url));
  assert.deepEqual(fallback.notices, []);
  assert.deepEqual(fallback.busy, [true, false]);
  assert.ok(!JSON.stringify(fallback.diagnostics).includes("://"), "no URI enters diagnostics");
}
const exhausted = scenario(false);
const exhaustedTask = exhausted.run();
exhausted.resolveTargets(targets);
await exhaustedTask;
assert.deepEqual(exhausted.opened, targets.map((target) => target.url));
assert.equal(exhausted.notices.length, 1, "report failure only after all Apps were tried");

for (const opened of [true, false]) {
  const sf = scenario(opened, false, "顺丰");
  const task = sf.run();
  const uri = "com.sf-express://order/detail?id=synthetic%2Bopaque";
  sf.resolveTargets([{ kind: "sf", url: uri }]);
  await task;
  assert.deepEqual(sf.opened, [uri]);
  assert.deepEqual(sf.notices, opened ? [] : ["无法打开顺丰，请确认已安装该应用"]);
}

const manual = {
  identity: { id: "manual-synthetic", manuallyAdded: true, sourceId: "JD000000000162", courierCode: "JD" },
  timeline: { waybill: "JD000000000162" },
} as Shipment;
const manualUrl = kuaidi100MiniProgramURL(displayWaybill(manual));
for (const result of [true, false, new Error("synthetic native failure")]) {
  const test = scenario(result, false, "快递100", { shipment: manual, persisted: true, current: [manual] });
  const first = test.run();
  await test.run();
  await first;
  assert.deepEqual(test.opened, [manualUrl], "one direct launch must not query account credentials or duplicate taps");
  assert.equal(test.requestCount(), 0);
  assert.deepEqual(test.busy, [true, false]);
  assert.deepEqual(test.notices, result === true ? [] : ["无法打开快递100小程序，请稍后重试"]);
  assert.ok(!JSON.stringify(test.diagnostics).includes("://"));
  assert.ok(!JSON.stringify(test.diagnostics).includes("JD000000000162"));
}

const pdd = { ...manual, pddImport: { ownerKey: "synthetic-pdd-owner", orderId: "synthetic-order", shippingId: "73162" } };
const pddURL = pddParcelAppURL(pdd.pddImport, displayWaybill(pdd));
for (const [pddLogin, results, expected, opensWeb] of [
  [undefined, [true], [pddURL], false],
  [undefined, [false, true], [pddURL, manualUrl], false],
  ["active", [false], [pddURL], true],
  ["expired", [false, true], [pddURL, manualUrl], true],
  ["unavailable", [false], [pddURL], true],
] as const) {
  const attempt = scenario([...results], false, "拼多多", { shipment: pdd, current: [pdd], persisted: true, pddURL, pddLogin });
  await attempt.run();
  assert.match(pddURL, /^pinduoduo:\/\//);
  assert.deepEqual(attempt.opened, expected);
  assert.deepEqual(attempt.h5, opensWeb ? [pddURL] : []);
  assert.equal(attempt.requestCount(), 0);
  assert.deepEqual(attempt.notices, pddLogin === "unavailable" ? ["打开拼多多失败，请稍后重试"] : []);
  assert.ok(!JSON.stringify(attempt.diagnostics).includes(pdd.pddImport.shippingId));
}
const now = Date.now();
const cloudPdd = { ...manual, timeline: { ...manual.timeline, statusEventAtMs: now - 1000, tracks: [] } };
const pddLink = { waybill: displayWaybill(cloudPdd), shippingId: pdd.pddImport.shippingId, anchorAt: now - 2000 };
for (const credentialChanged of [false, true]) {
  const attempt = scenario(true, false, "拼多多", { shipment: cloudPdd, current: [cloudPdd], persisted: true,
    pddURL, pddLink, credentialChanged });
  await attempt.run();
  assert.deepEqual(attempt.opened, credentialChanged ? [] : [pddURL]);
  assert.equal(attempt.requestCount(), 0);
}

const visibilityStart = page.indexOf("  const manualExternalAppURL =");
const visibilityEnd = page.indexOf("\n  const externalAppName =", visibilityStart);
assert.ok(visibilityStart >= 0 && visibilityEnd > visibilityStart);
const visibleManualURL = new Function("props", "shipment", "kuaidi100MiniProgramURL", "displayWaybill",
  `${page.slice(visibilityStart, visibilityEnd)}\nreturn manualExternalAppURL;`);
assert.equal(visibleManualURL({ persistedShipment: false }, manual, kuaidi100MiniProgramURL, displayWaybill), "");
assert.equal(visibleManualURL({ persistedShipment: true }, manual, kuaidi100MiniProgramURL, displayWaybill), manualUrl);
assert.equal(visibleManualURL({ persistedShipment: true }, {
  ...manual, timeline: { ...manual.timeline, waybill: "" },
}, kuaidi100MiniProgramURL, displayWaybill), "");

const navigationStart = page.indexOf("  const externalAppName =");
const navigationEnd = page.indexOf("\n  const detailSourceIcon =", navigationStart);
assert.ok(navigationStart >= 0 && navigationEnd > navigationStart);
const presentation = new Function("shipment", "syncedInternational", "pddExternalAppURL", "pddOrigin",
  "manualExternalAppURL", "accountExternalAppURL", "accountExternalAppName", "DETAIL_SOURCES",
  `${page.slice(navigationStart, navigationEnd)}\nreturn { externalAppName, detailSource };`);
assert.deepEqual(presentation(manual, true, "pinduoduo://fixture", true, manualUrl, "",
  () => "菜鸟", { pinduoduo: ["拼多多", "fixture.png"] }), { externalAppName: "", detailSource: undefined });

const projectedManual = { ...manual, identity: { ...manual.identity,
  sourceId: "SYNTHETIC_OWNER", projectedWaybill: "JD000000000164" } };
const projected = scenario(true, false, "快递100", {
  shipment: projectedManual, persisted: true, current: [projectedManual],
});
await projected.run();
assert.equal(new URL(projected.opened[0]).searchParams.get("query"),
  "nu=JD000000000164&querysource=third_xcx", "launch the displayed waybill instead of the owner or stale timeline identity");

for (const options of [
  { persisted: false, current: [manual] },
  { persisted: true, current: [] },
  { persisted: true, current: [{ ...manual, identity: { ...manual.identity, id: "different" } }] },
  { persisted: true, current: [{ ...manual, identity: { ...manual.identity, manuallyAdded: false } }] },
  { persisted: true, current: [{ ...manual, timeline: { ...manual.timeline, waybill: "JD000000000163" } }] },
]) {
  const stale = scenario(true, false, "快递100", { shipment: manual, ...options });
  await stale.run();
  assert.deepEqual(stale.opened, []);
  assert.equal(stale.requestCount(), 0);
  assert.deepEqual(stale.notices, ["快递信息已更新，请重新打开详情"]);
  assert.deepEqual(stale.busy, [true, false]);
}

const stateFailure = scenario(true, false, "快递100", { shipment: manual, persisted: true, loadFailure: true });
await stateFailure.run();
assert.deepEqual(stateFailure.opened, []);
assert.deepEqual(stateFailure.notices, ["打开快递100失败，请稍后重试"]);
assert.deepEqual(stateFailure.busy, [true, false]);

const sfShipment = {
  identity: { id: "sf-synthetic", manuallyAdded: false, bindingSource: "interface5",
    sourceId: "SF000000000162", sourceOwner: "synthetic-account", courierCode: "SF", sourceProvider: "ShunFeng" },
  timeline: { waybill: "SF000000000162" },
  accountRecord: { waybill: "SF000000000162", companyCode: "SF", provider: "ShunFeng", phone: "13800138000" },
} as Shipment;
const sfBinding: AccountBinding = { source: "interface5", phone: "13800138000", boundAtMs: 5 };
const sfState = { shipments: [sfShipment], bindings: [sfBinding] };
const sfNative = "com.sf-express://order/detail?id=synthetic";
const sfMiniProgram = kuaidi100MiniProgramURL(displayWaybill(sfShipment));
for (const [results, expected, notice] of [
  [[true], [sfNative], []],
  [[false, true], [sfNative, sfMiniProgram], []],
  [[false, false], [sfNative, sfMiniProgram], ["无法打开快递100小程序，请稍后重试"]],
  [[false, new Error("synthetic WeChat open error")], [sfNative, sfMiniProgram], ["无法打开快递100小程序，请稍后重试"]],
  [[new Error("synthetic SF open error")], [sfNative], ["打开顺丰失败，请稍后重试"]],
] as const) {
  const attempt = scenario([...results], false, "顺丰", { shipment: sfShipment, states: [sfState] });
  const task = attempt.run();
  attempt.resolveTargets([{ kind: "sf", url: sfNative }]);
  await task;
  assert.deepEqual(attempt.opened, expected);
  assert.deepEqual(attempt.notices, notice);
  assert.deepEqual(attempt.busy, [true, false]);
  assert.ok(!JSON.stringify(attempt.diagnostics).includes("SF000000000162"));
  assert.ok(!JSON.stringify(attempt.diagnostics).includes("://"));
}

for (const next of [
  { ...sfState, shipments: [] },
  { ...sfState, bindings: [] },
  { ...sfState, bindings: [{ ...sfBinding, boundAtMs: 6 }] },
  { ...sfState, shipments: [{ ...sfShipment, identity: { ...sfShipment.identity, sourceOwner: "replacement" } }] },
  { ...sfState, shipments: [{ ...sfShipment, timeline: { ...sfShipment.timeline, waybill: "SF000000000163" } }] },
]) {
  const stale = scenario([false, true], false, "顺丰", { shipment: sfShipment, states: [sfState, next] });
  const task = stale.run();
  stale.resolveTargets([{ kind: "sf", url: sfNative }]);
  await task;
  assert.deepEqual(stale.opened, [sfNative], "a stale SF tuple must not donate its waybill to K100");
  assert.deepEqual(stale.notices, ["快递信息已更新，请重新打开详情"]);
}

const capabilityLost = scenario([false, true], false, "顺丰", {
  shipment: sfShipment, states: [sfState], currentAppName: "",
});
const lostTask = capabilityLost.run();
capabilityLost.resolveTargets([{ kind: "sf", url: sfNative }]);
await lostTask;
assert.deepEqual(capabilityLost.opened, [sfNative]);
assert.deepEqual(capabilityLost.notices, ["快递信息已更新，请重新打开详情"]);

const closedSf = scenario([false, true], false, "顺丰", {
  shipment: sfShipment, states: [sfState], cancelAfterOpen: true,
});
const closedTask = closedSf.run();
closedSf.resolveTargets([{ kind: "sf", url: sfNative }]);
await closedTask;
assert.deepEqual(closedSf.opened, [sfNative]);
assert.deepEqual(closedSf.notices, []);

const otherAccount = {
  identity: { id: "other-account-synthetic", manuallyAdded: false, bindingSource: "interface5",
    sourceId: "JT000000000162", sourceOwner: "interface5", courierCode: "HTKY", sourceProvider: "OtherAccount" },
  timeline: { waybill: "JT000000000162" },
  accountRecord: { waybill: "JT000000000162", companyCode: "HTKY", provider: "OtherAccount", phone: "13800138000" },
} as Shipment;
const otherBinding: AccountBinding = { source: "interface5", phone: "13800138000", boundAtMs: 5 };
const accountDirect = scenario(true, false, "快递100", {
  shipment: otherAccount, persisted: true, current: [otherAccount], binding: otherBinding,
});
accountDirect.resolveRoute("");
await accountDirect.run();
assert.deepEqual(accountDirect.opened, [kuaidi100MiniProgramURL(displayWaybill(otherAccount))],
  "a persisted account parcel without a source App capability opens its actual waybill in K100");
assert.equal(accountDirect.requestCount(), 0, "the direct action must not query an unsupported source App route");

const accountVisibilityStart = page.indexOf("  const accountExternalAppURL =");
const accountVisibilityEnd = page.indexOf("\n  const manualExternalAppURL =", accountVisibilityStart);
assert.ok(accountVisibilityStart >= 0 && accountVisibilityEnd > accountVisibilityStart);
const visibleAccountURL = new Function("props", "shipment", "accountKuaidi100URL", "accountBindingRef",
  `${page.slice(accountVisibilityStart, accountVisibilityEnd)}\nreturn accountExternalAppURL;`);
const accountVisibility = (props: object, shipment = otherAccount) => visibleAccountURL(
  { accountBinding: otherBinding, ...props }, shipment, accountKuaidi100URL, { current: otherBinding });
assert.equal(accountVisibility({ persistedShipment: true }),
  kuaidi100MiniProgramURL(displayWaybill(otherAccount)));
assert.equal(accountVisibility({ persistedShipment: false }), "");
assert.equal(accountVisibility({ persistedShipment: true, accountBinding: undefined }), "");
assert.equal(accountVisibility({ persistedShipment: true, accountBinding: { ...otherBinding, boundAtMs: 6 } }), "");

for (const result of [false, new Error("synthetic WeChat failure")]) {
  const unavailable = scenario(result, false, "快递100", {
    shipment: otherAccount, persisted: true, current: [otherAccount], binding: otherBinding,
  });
  await unavailable.run();
  assert.equal(unavailable.opened.length, 1);
  assert.equal(unavailable.requestCount(), 0);
  assert.deepEqual(unavailable.notices, ["无法打开快递100小程序，请稍后重试"]);
  assert.deepEqual(unavailable.busy, [true, false]);
}
for (const options of [
  { persisted: false, current: [otherAccount] },
  { persisted: true, current: [] },
  { persisted: true, current: [{ ...otherAccount, identity: { ...otherAccount.identity, sourceOwner: "replacement" } }] },
  { persisted: true, current: [{ ...otherAccount, identity: { ...otherAccount.identity, sourceId: "JT000000000163" },
    timeline: { ...otherAccount.timeline, waybill: "JT000000000163" },
    accountRecord: { ...otherAccount.accountRecord!, waybill: "JT000000000163" } }] },
  { persisted: true, current: [{ ...otherAccount, identity: { ...otherAccount.identity, sourceProvider: "CaiNiao" },
    accountRecord: { ...otherAccount.accountRecord!, provider: "CaiNiao" } }] },
  { persisted: true, current: [{ ...otherAccount, accountRecord: { ...otherAccount.accountRecord!, phone: "13900139000" } }] },
]) {
  const stale = scenario(true, false, "快递100", { shipment: otherAccount, binding: otherBinding, ...options });
  await stale.run();
  assert.deepEqual(stale.opened, []);
  assert.equal(stale.requestCount(), 0);
  assert.deepEqual(stale.notices, ["快递信息已更新，请重新打开详情"]);
}
for (const bindings of [[], [{ ...otherBinding, boundAtMs: 6 }]]) {
  const stale = scenario(true, false, "快递100", {
    shipment: otherAccount, persisted: true, binding: otherBinding,
    states: [{ shipments: [otherAccount], bindings }],
  });
  await stale.run();
  assert.deepEqual(stale.opened, [], "unbind and rebind invalidate an already visible direct action");
  assert.equal(stale.requestCount(), 0);
  assert.deepEqual(stale.notices, ["快递信息已更新，请重新打开详情"]);
}
for (const [provider, name] of [["JingDong", "京东"], ["CaiNiao", "菜鸟"], ["ShunFeng", "顺丰"]]) {
  const known = { ...otherAccount, identity: { ...otherAccount.identity, sourceProvider: provider },
    accountRecord: { ...otherAccount.accountRecord!, provider } };
  assert.equal(accountVisibility({ persistedShipment: true }, known), "");
  for (const failure of [false, true]) {
    const missing = scenario(true, failure, name, { shipment: known, persisted: true, current: [known] });
    missing.resolveRoute("");
    await missing.run();
    assert.deepEqual(missing.opened, [], "route failure cannot activate the unrelated direct K100 path");
    assert.equal(missing.requestCount(), 1);
    assert.deepEqual(missing.notices, [failure ? `打开${name}失败，请稍后重试` : `来源暂未提供可用的${name}应用链接`]);
  }
}
