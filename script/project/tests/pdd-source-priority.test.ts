import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { memory, NOW } from "./state-storage-mock";

import type { Shipment, TimelinePackage } from "../models";
import { parseAccountSyncResponse } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { saveGatewayToken } from "../services/credentials";
import { setDiagnosticsEnabled } from "../services/logger";
import { parseCloudPddShipmentPage } from "../services/pdd-cloud-records";
import { pddParcelAppURL } from "../services/platform-parcel-data";
import {
  adoptCloudPddParcelSource, displayedPlatformFields, hasPddParcelSource, pddParcelProductImage,
} from "../services/platform-parcel-merge";
import { registerProjectionViewportHost } from "../services/projection-viewport";
import { applyAccountShipment } from "../services/shipment-policy";
import {
  emptyState, loadState, saveCloudPddParcels, saveCloudPddParcelSource, saveState, visibleShipments,
} from "../services/storage";
import { refreshAllShipments } from "../services/sync";

// 同一票快递的来源次序「已确认 PDD > 自动来源 > 普通手动来源」（用户 2026-11-20「pdd 图标这条把优先级提到最高」）：
// 同一寄递周期、不是寄件人的件有了拼多多确认证据，详情页的来源与外跳就是拼多多；状态、轨迹、取件码仍归自动来源。
// iOS 的丢失点：自动账号行按 §5.2 接管同号手动行时只带走备注，手动行上的拼多多来源随行删除。这里锁住接管时带走来源、
// 云端拼多多记录能挂到自动账号行，以及单号复用、寄件人、京东业务来源与订单占位照旧不挂。合成的运单号、手机号与订单。

const PHONE = "13800002727";
const DAY = 86400000;
const HOUR = 3600000;
const OWNER = "synthetic-pdd-owner";
const IMAGE = "https://img.pddpic.com/mms-material-img/synthetic-priority.png";
const PDD_TITLE = { text: "合成拼多多商品", source: "pinduoduo" } as const;
const EDITED_TITLE = "用户改过的商品名";

let clock = NOW;
const realNow = Date.now;
Date.now = () => clock;
process.on("exit", () => { Date.now = realNow; });
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(Data, { fromFile: () => null });
Object.assign(globalThis, {
  Notification: { schedule: async () => {} },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class {
    async loadURL() { return true; }
    async evaluateJavaScript() { return { extractionSource: "probe", traceList: [] }; }
    dispose() {}
  },
});
registerProjectionViewportHost({ mount: async () => false, unmount: () => {} });

const providerTime = (at: number) =>
  new Date(at + 8 * HOUR).toISOString().slice(0, 19).replace("T", " ");
const record = (waybill: string, stateNum: number, details: readonly { at: number; desc: string }[],
  provider = "CaiNiao", extra: Record<string, unknown> = {}) => ({
  mailNo: waybill, provider, cpCode: provider === "JingDong" ? "JD" : "YTO",
  name: provider === "JingDong" ? "京东快递" : "圆通速递", phone: PHONE, stateNum,
  details: details.map(({ at, desc }) => ({ time: providerTime(at), desc })), ...extra,
});
const transit = (waybill: string, provider = "CaiNiao", extra: Record<string, unknown> = {}) =>
  record(waybill, 104, [
    { at: NOW - 2 * HOUR, desc: "运输中 synthetic account parcel" },
    { at: NOW - DAY, desc: "已揽收 synthetic account parcel" },
  ], provider, extra);

function row(input: unknown, at = NOW - HOUR): Shipment {
  const parcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [input] } })[0]!;
  return applyAccountShipment(undefined, parcelToShipment(parcel, [PHONE], at)!, at);
}

function manualPackage(waybill: string, semantic: TimelinePackage["semantic"], at: number, detail: string): TimelinePackage {
  return {
    provider: "v6_query", waybill, courierCode: "YTO", companyName: "圆通速递", semantic, structuredStatus: true,
    statusEventAtMs: at, latestTimeText: providerTime(at), latestDetail: detail,
    tracks: [{ timeText: providerTime(at), timeMs: at, detail, statusCode: "", raw: {} }],
    successAtMs: at,
  };
}

const pddImportFor = (waybill: string) => ({ ownerKey: OWNER, orderId: `synthetic-order-${waybill.slice(-4)}`,
  shippingId: `7300${waybill.slice(-4)}` });

/** A manual row carrying a confirmed PDD source: its local PDD import with product fields, or a cloud PDD origin. */
function pddManual(waybill: string, mark: "import" | "cloud", options: { pkg?: TimelinePackage; note?: string } = {}): Shipment {
  const pkg = options.pkg || manualPackage(waybill, "PICKED", NOW - DAY, "已揽收 synthetic manual package");
  const pddImport = pddImportFor(waybill);
  return {
    identity: {
      id: `interface5:manual:${waybill}`, bindingSource: "interface5", sourceOwner: "manual", sourceId: waybill,
      phoneTail: PHONE.slice(-4), courierCode: "YTO", companyName: "圆通速递", manuallyAdded: true,
      createdAtMs: NOW - 3 * DAY,
    },
    timeline: pkg,
    sourceTimeline: null,
    manualTimelines: [pkg],
    ...(mark === "import" ? {
      pddImport,
      platformFields: {
        waybill, waybillGeneration: 0, title: PDD_TITLE, manualTitle: EDITED_TITLE, manualTitleEditedAtMs: NOW - 2 * DAY,
        pddImage: { url: IMAGE, association: JSON.stringify([pddImport.ownerKey, pddImport.orderId, pddImport.shippingId]) },
      },
    } : { pddCloudOrigin: { waybill, waybillGeneration: 0 } }),
    ...(options.note ? { note: options.note } : {}),
    updatedAtMs: NOW - DAY,
  };
}

function seed(rows: Shipment[]) {
  clock = NOW;
  memory.clear();
  setDiagnosticsEnabled(true);
  saveState({
    ...emptyState(),
    shipments: rows,
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 30 * DAY }],
    feedSlotRebuiltAtMs: NOW - DAY,
  }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
}

async function listRound(records: readonly unknown[], at: number) {
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path !== "/api/express/accounts/sync") {
      return { ok: false, status: 503, text: async () => "Synthetic offline" };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { expressList: records } }) };
  }) as typeof fetch;
  clock = at;
  await refreshAllShipments();
}

const byId = (id: string) => loadState().shipments.find((shipment) => shipment.identity.id === id);
const accountId = (waybill: string) => `interface5:account:${waybill}`;
const manualRows = () => loadState().shipments.filter((shipment) => shipment.identity.manuallyAdded);

// The detail page's source and external entry, evaluated from its own source text (the same slice as
// detail-external-app.test.ts): the button name and the source artwork follow `pddOrigin`.
const page = readFileSync(new URL("../pages/DetailPage.tsx", import.meta.url), "utf8");
const navigationStart = page.indexOf("  const externalAppName =");
const navigationEnd = page.indexOf("\n  const detailSourceIcon =", navigationStart);
assert.ok(navigationStart >= 0 && navigationEnd > navigationStart);
const detailPresentation = new Function("shipment", "syncedInternational", "pddExternalAppURL", "pddOrigin",
  "manualExternalAppURL", "accountExternalAppURL", "accountExternalAppName", "DETAIL_SOURCES",
  `${page.slice(navigationStart, navigationEnd)}\nreturn { externalAppName, detailSource };`);
const DETAIL_SOURCES = { pinduoduo: ["拼多多", "pinduoduo.png"], cainiao: ["菜鸟", "cainiao.png"] };
const accountApp = () => "菜鸟";

// 1. The account row that takes over a manual PDD row keeps the PDD source, its product name and image. The automatic
// source keeps the status and timeline, the manual history is merged as before and the note follows as before.
{
  const waybill = "YT8200000000001";
  const manual = pddManual(waybill, "import", { note: "synthetic note" });
  seed([manual]);
  assert.equal(pddParcelProductImage(byId(manual.identity.id)!), IMAGE, "fixture: the manual row shows the PDD image");
  await listRound([transit(waybill)], NOW);
  assert.deepEqual(manualRows(), [], "the account row takes the manual row over");
  const account = byId(accountId(waybill))!;
  assert.equal(account.identity.manuallyAdded, false);
  assert.equal(account.identity.sourceProvider, "CaiNiao");
  assert.equal(account.timeline.semantic, "TRANSIT", "the automatic source keeps the status");
  assert.ok((account.manualTimelines || []).some((timeline) => timeline.provider === "v6_query"),
    "the manual history is merged as before");
  assert.equal(account.note, "synthetic note", "the note follows as before");
  assert.equal(hasPddParcelSource(account), true, "the confirmed PDD source follows the parcel");
  assert.deepEqual(account.pddImport, manual.pddImport);
  assert.equal(pddParcelProductImage(account), IMAGE, "the PDD product image stays linked");
  assert.deepEqual(account.platformFields?.title, PDD_TITLE, "the PDD product name stays linked");
  assert.equal(displayedPlatformFields(account, NOW).title, EDITED_TITLE, "the edited product name is kept");
  assert.deepEqual(visibleShipments(loadState()).map((shipment) => shipment.identity.id), [accountId(waybill)]);

  // The detail page names PDD and opens the exact PDD parcel page.
  const exactPage = pddParcelAppURL(account.pddImport, waybill);
  assert.match(exactPage, /^pinduoduo:\/\/.*shipping_id=73000001&tracking_number=YT8200000000001$/);
  assert.deepEqual(detailPresentation(account, false, exactPage, hasPddParcelSource(account), "", "", accountApp,
    DETAIL_SOURCES), { externalAppName: "拼多多", detailSource: DETAIL_SOURCES.pinduoduo });

  // Later list rounds keep it.
  await listRound([transit(waybill)], NOW + 60_000);
  const later = byId(accountId(waybill))!;
  assert.equal(hasPddParcelSource(later), true);
  assert.equal(pddParcelProductImage(later), IMAGE);
  assert.equal(displayedPlatformFields(later, NOW + 60_000).title, EDITED_TITLE);
}

// 2. A manual row that holds a cloud PDD origin hands it to the account row, keyed to the survivor's waybill generation.
{
  const waybill = "YT8200000000002";
  seed([pddManual(waybill, "cloud")]);
  await listRound([transit(waybill)], NOW);
  assert.deepEqual(manualRows(), []);
  const account = byId(accountId(waybill))!;
  assert.deepEqual(account.pddCloudOrigin, { waybill, waybillGeneration: 0 });
  assert.equal(account.pddImport, undefined, "nothing is invented");
  assert.equal(hasPddParcelSource(account), true);
  assert.deepEqual(detailPresentation(account, false, "", hasPddParcelSource(account), "", "", accountApp, DETAIL_SOURCES),
    { externalAppName: "拼多多", detailSource: DETAIL_SOURCES.pinduoduo });
}

// 3. The survivor's own product fields are never replaced: a stored Cainiao title stays, the PDD image joins it.
{
  const waybill = "YT8200000000003";
  const ownTitle = { text: "菜鸟商品名", source: "cainiao" } as const;
  seed([
    { ...row(transit(waybill)), platformFields: { waybill, waybillGeneration: 0, title: ownTitle } },
    pddManual(waybill, "import"),
  ]);
  await listRound([transit(waybill)], NOW + 60_000);
  assert.deepEqual(manualRows(), []);
  const account = byId(accountId(waybill))!;
  assert.deepEqual(account.platformFields?.title, ownTitle, "the survivor's own title stays");
  assert.equal(account.platformFields?.manualTitle, EDITED_TITLE, "the missing edited name is filled in");
  assert.equal(pddParcelProductImage(account), IMAGE);
  assert.equal(hasPddParcelSource(account), true);
}

// 4. Unchanged: a new parcel on a reused number. The old signed PDD row is not merged and its source stays behind.
{
  const waybill = "YT8200000000004";
  const signedAt = NOW - 5 * DAY;
  seed([pddManual(waybill, "import", {
    note: "old note", pkg: manualPackage(waybill, "COMPLETED", signedAt, "已签收 synthetic old parcel"),
  })]);
  await listRound([record(waybill, 103, [{ at: signedAt + 2 * DAY, desc: "已揽收 synthetic new parcel" }])], NOW);
  assert.deepEqual(manualRows(), [], "the new parcel takes the old manual row over");
  const account = byId(accountId(waybill))!;
  assert.equal(account.timeline.semantic, "PICKED");
  assert.equal(hasPddParcelSource(account), false, "a reused number does not inherit the old PDD source");
  assert.equal(account.pddImport, undefined);
  assert.equal(account.platformFields, undefined);
  assert.equal(account.note, undefined);
}

// 5. Unchanged: the deterministic account id reused by a later parcel does not keep the PDD source it once took over.
{
  const waybill = "YT8200000000005";
  const signedAt = NOW - 5 * DAY;
  seed([pddManual(waybill, "import", {
    pkg: manualPackage(waybill, "PICKED", signedAt - DAY, "已揽收 synthetic pdd parcel"),
  })]);
  await listRound([record(waybill, 107, [
    { at: signedAt, desc: "已签收 synthetic pdd parcel" },
    { at: signedAt - DAY, desc: "已揽收 synthetic pdd parcel" },
  ])], NOW);
  assert.equal(hasPddParcelSource(byId(accountId(waybill))!), true, "the PDD parcel's own row keeps its source");
  await listRound([record(waybill, 103, [{ at: signedAt + 2 * DAY, desc: "已揽收 synthetic new parcel" }])], NOW + 60_000);
  const reused = byId(accountId(waybill))!;
  assert.ok(Number(reused.waybillReuseAtMs) > 0, "the new parcel takes the row");
  assert.equal(hasPddParcelSource(reused), false, "the new parcel does not inherit the stale PDD source");
  assert.equal(reused.pddImport, undefined);
  assert.equal(pddParcelProductImage(reused), "");
  assert.equal(displayedPlatformFields(reused, NOW + 60_000).title, undefined);
}

// 6. Unchanged: a sender parcel never takes the PDD source.
{
  const waybill = "YT8200000000006";
  seed([pddManual(waybill, "import")]);
  await listRound([transit(waybill, "CaiNiao", { sendPhone: PHONE })], NOW);
  assert.deepEqual(manualRows(), []);
  const account = byId(accountId(waybill))!;
  assert.equal(account.identity.sender, true);
  assert.equal(hasPddParcelSource(account), false);
  assert.equal(account.pddImport, undefined);
}

// 7. Unchanged: JingDong business sources never take the PDD source, neither a JingDong-sourced waybill row nor a JD
// order projected onto the number.
{
  const waybill = "JDV820000000007";
  seed([pddManual(waybill, "import")]);
  await listRound([transit(waybill, "JingDong")], NOW);
  assert.deepEqual(manualRows(), []);
  const account = byId(accountId(waybill))!;
  assert.equal(account.identity.sourceProvider, "JingDong");
  assert.equal(account.identity.accountOrder, false);
  assert.equal(hasPddParcelSource(account), false);
}
{
  const waybill = "YT8200000000008";
  const ORDER = "3630448013820008";
  const orderRecord = { mailNo: ORDER, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE, stateNum: 104,
    details: [{ time: providerTime(NOW - DAY), desc: "您的订单已出库" }] };
  const order = row(orderRecord);
  assert.equal(order.identity.accountOrder, true);
  seed([{ ...order, identity: { ...order.identity, projectedWaybill: waybill } }, pddManual(waybill, "import")]);
  await listRound([orderRecord], NOW);
  assert.deepEqual(manualRows(), [], "the projected order takes the manual row over as before");
  const projected = byId(accountId(ORDER))!;
  assert.equal(projected.identity.projectedWaybill, waybill);
  assert.equal(hasPddParcelSource(projected), false);
  assert.equal(projected.pddImport, undefined);
}

// 8. A cloud PDD record now also attaches to the unique same-lifecycle account row: from the import list and from the
// detail link. The row keeps its identity, status and history; a replay changes nothing.
{
  const waybill = "YT8200000000009";
  seed([row(transit(waybill))]);
  const before = loadState();
  const current = before.shipments[0]!;
  assert.equal(detailPresentation(current, false, "", hasPddParcelSource(current), "", "", accountApp, DETAIL_SOURCES)
    .externalAppName, "菜鸟", "fixture: without PDD evidence the account keeps its own source");
  const cloud = { waybill, anchorAt: NOW - DAY, terminalAt: 0, carrierCode: "YTO", phone4: "" };
  const { state, changed } = saveCloudPddParcels([cloud], before, () => true, NOW);
  assert.equal(changed, true);
  assert.equal(state.shipments.length, 1, "no manual row is added");
  const adopted = state.shipments[0]!;
  assert.equal(hasPddParcelSource(adopted), true);
  assert.deepEqual(adopted.pddCloudOrigin, { waybill, waybillGeneration: 0 });
  assert.deepEqual(adopted.identity, current.identity);
  assert.deepEqual(adopted.timeline, current.timeline);
  assert.deepEqual(detailPresentation(adopted, false, "", hasPddParcelSource(adopted), "", "", accountApp, DETAIL_SOURCES),
    { externalAppName: "拼多多", detailSource: DETAIL_SOURCES.pinduoduo });
  const replay = saveCloudPddParcels([cloud], state, () => true, NOW);
  assert.equal(replay.changed, false);
  assert.equal(replay.state.revision, state.revision);
}
{
  const waybill = "YT8200000000010";
  seed([row(transit(waybill))]);
  const current = loadState().shipments[0]!;
  const link = { waybill, anchorAt: NOW - DAY, terminalAt: 0, shippingId: "73000010" };
  const saved = saveCloudPddParcelSource(current, link, () => true, NOW)!;
  assert.equal(saved.shipments.length, 1);
  assert.equal(hasPddParcelSource(saved.shipments[0]!), true);
  assert.deepEqual(saved.shipments[0]!.identity, current.identity);
  assert.equal(saveCloudPddParcelSource(current, link, () => true, NOW), undefined, "already attached");
}

// 9. Unchanged: a cloud PDD record does not attach to a sender row, a JingDong business source, a reused number, an
// order placeholder or a synced international parcel.
{
  const cases: Array<[string, Shipment, number, number]> = [
    ["sender", row(transit("YT8200000000011", "CaiNiao", { sendPhone: PHONE })), NOW - DAY, 0],
    ["JingDong source", row(transit("JDV820000000012", "JingDong")), NOW - DAY, 0],
    ["reused number", row(transit("YT8200000000013")), NOW - 10 * DAY, NOW - 9 * DAY],
  ];
  for (const [label, current, anchorAt, terminalAt] of cases) {
    seed([current]);
    const before = loadState();
    const waybill = before.shipments[0]!.identity.sourceId;
    const result = saveCloudPddParcels([{ waybill, anchorAt, terminalAt, carrierCode: "YTO", phone4: "" }], before,
      () => true, NOW);
    assert.equal(result.changed, false, label);
    assert.equal(hasPddParcelSource(result.state.shipments[0]!), false, label);
    assert.equal(result.state.shipments.length, 1, label);
  }
  const order = row({ mailNo: "3630448013820014", provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE,
    stateNum: 104, details: [{ time: providerTime(NOW - DAY), desc: "您的订单已出库" }] });
  const parcel = { waybill: "YT8200000000014", anchorAt: NOW - DAY, terminalAt: 0 };
  const projected = { ...order, identity: { ...order.identity, projectedWaybill: parcel.waybill } };
  assert.equal(adoptCloudPddParcelSource(projected, parcel, NOW), projected, "a projected JD order");
  assert.equal(adoptCloudPddParcelSource(order, { ...parcel, waybill: order.identity.sourceId }, NOW), order,
    "an unprojected order placeholder");
  const tracked = row(transit(parcel.waybill));
  assert.notEqual(adoptCloudPddParcelSource(tracked, parcel, NOW), tracked, "control: the account row itself attaches");
  const watch: Shipment = { ...tracked, identity: { ...tracked.identity,
    id: "watch:synthetic", bindingSource: null, sourceOwner: "lastscanned", sourceProvider: "lastscanned" } };
  assert.equal(adoptCloudPddParcelSource(watch, parcel, NOW), watch, "a synced international parcel");
}

// 10. Third external review C-03 (owner 2026-11-23): Pipi exports an automatic row's confirmed PDD source only as its PDD
// link. The pdd-shipments page lists those links in `pddLinks`; each marks the waybill's sole same-lifecycle row and never
// adds a row. A page without links reads as before, and an earlier finished parcel's link marks nothing.
{
  const waybill = "YT8200000000015";
  seed([row(transit(waybill))]);
  const before = loadState();
  const page = parseCloudPddShipmentPage({ ok: true, parcels: [], nextAfter: null, pddLinks: [
    { waybill, anchorAt: NOW - DAY, terminalAt: 0 },
    { waybill: "YT8200000000016", anchorAt: NOW - DAY, terminalAt: 0 },
  ] }, null, NOW);
  assert.deepEqual(page.parcels.map((parcel) => [parcel.waybill, parcel.markOnly]),
    [[waybill, true], ["YT8200000000016", true]]);
  const { state, changed } = saveCloudPddParcels(page.parcels, before, () => true, NOW);
  assert.equal(changed, true);
  assert.equal(state.shipments.length, 1, "a link never adds a row");
  assert.equal(hasPddParcelSource(state.shipments[0]!), true);
  assert.deepEqual(state.shipments[0]!.identity, before.shipments[0]!.identity);
  assert.deepEqual(state.shipments[0]!.timeline, before.shipments[0]!.timeline);
  assert.equal(saveCloudPddParcels(page.parcels, state, () => true, NOW).changed, false, "a replay changes nothing");

  seed([row(transit("YT8200000000017"))]);
  const later = loadState();
  const earlier = parseCloudPddShipmentPage({ ok: true, parcels: [], nextAfter: null, pddLinks: [
    { waybill: "YT8200000000017", anchorAt: NOW - 10 * DAY, terminalAt: NOW - 9 * DAY },
  ] }, null, NOW);
  assert.equal(saveCloudPddParcels(earlier.parcels, later, () => true, NOW).changed, false);
  assert.deepEqual(parseCloudPddShipmentPage({ ok: true, parcels: [], nextAfter: null }, null, NOW).parcels, []);
  assert.throws(() => parseCloudPddShipmentPage({ ok: true, parcels: [], pddLinks: {}, nextAfter: null }, null, NOW));
}

// 11. Fourth external review R4-NEW-06 (owner 2026-11-23「报告里的都直接做」): the Worker lists only anchors at or before
// its own clock, and this clock may run behind it. An anchor up to the Worker's cloud edit future tolerance (5 minutes)
// ahead reads as now, so a link uploaded a moment ago still marks its row; an entry further ahead is skipped alone
// instead of failing the whole page and every other parcel on it.
{
  const waybill = "YT8200000000018";
  seed([row(transit(waybill))]);
  const before = loadState();
  const page = parseCloudPddShipmentPage({ ok: true, nextAfter: null,
    parcels: [
      { waybill: "YT8200000000019", anchorAt: NOW + 60_000, terminalAt: 0, carrierCode: "YTO", phone4: "" },
      { waybill: "YT8200000000020", anchorAt: NOW + 10 * 60_000, terminalAt: 0, carrierCode: "YTO", phone4: "" },
    ],
    pddLinks: [
      { waybill, anchorAt: NOW + 30_000, terminalAt: 0 },
      { waybill: "YT8200000000021", anchorAt: NOW + 6 * 60_000, terminalAt: 0 },
    ] }, null, NOW);
  assert.deepEqual(page.parcels.map((parcel) => [parcel.waybill, parcel.anchorAt, parcel.markOnly === true]),
    [["YT8200000000019", NOW, false], [waybill, NOW, true]]);
  const { state, changed } = saveCloudPddParcels(page.parcels.filter((parcel) => parcel.markOnly), before,
    () => true, NOW);
  assert.equal(changed, true);
  assert.equal(hasPddParcelSource(state.shipments[0]!), true, "a link a moment ahead of this clock still marks its row");
  for (const anchorAt of [0, -1, "1"]) {
    assert.throws(() => parseCloudPddShipmentPage({ ok: true, parcels: [], nextAfter: null,
      pddLinks: [{ waybill, anchorAt, terminalAt: 0 }] }, null, NOW), String(anchorAt));
  }
}

// 12. Fifth review follow-up (owner 2026-11-25 「也用同一个函数（推荐）」): a PDD parcel's or link's terminal time is read
// with the shared cloudRecordTime, as its anchor and the parcel metadata are. A terminal time the Worker just wrote up to
// five minutes ahead of this clock reads as now; one further ahead stays invalid (0), as do missing and non-positive ones.
{
  const page = parseCloudPddShipmentPage({ ok: true, nextAfter: null,
    parcels: [
      { waybill: "YT8200000000022", anchorAt: NOW - DAY, terminalAt: NOW + 90_000, carrierCode: "YTO", phone4: "" },
      { waybill: "YT8200000000023", anchorAt: NOW - DAY, terminalAt: NOW + 6 * 60_000, carrierCode: "YTO", phone4: "" },
      { waybill: "YT8200000000024", anchorAt: NOW - DAY, terminalAt: NOW - HOUR, carrierCode: "YTO", phone4: "" },
      { waybill: "YT8200000000025", anchorAt: NOW - DAY, terminalAt: -1, carrierCode: "YTO", phone4: "" },
    ],
    pddLinks: [
      { waybill: "YT8200000000026", anchorAt: NOW - DAY, terminalAt: NOW + 30_000 },
      { waybill: "YT8200000000027", anchorAt: NOW - DAY, terminalAt: NOW + 10 * 60_000 },
      { waybill: "YT8200000000028", anchorAt: NOW - DAY },
    ] }, null, NOW);
  assert.deepEqual(page.parcels.map((parcel) => [parcel.waybill, parcel.terminalAt]), [
    ["YT8200000000022", NOW], ["YT8200000000023", 0], ["YT8200000000024", NOW - HOUR], ["YT8200000000025", 0],
    ["YT8200000000026", NOW], ["YT8200000000027", 0], ["YT8200000000028", 0],
  ]);
}
