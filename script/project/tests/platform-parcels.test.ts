import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, privateDecrypt, randomBytes, randomUUID, constants } from "node:crypto";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { Shipment } from "../models";
import { memory, NOW } from "./state-storage-mock";
import { code128Widths } from "../services/code128";
import { encryptFengchaoChallenge } from "../services/fengchao-rsa";
import {
  accountStatus, clearPlatformLogin, currentPlatformSession, notePlatformSync, platformAccountSubtitle, platformSession, saveCainiaoNickname, savePlatformLogin,
  trustedPlatformPage,
} from "../services/platform-accounts";
import { identityCodeFromResponse, fetchStationIdentity, openProviderController, readCainiaoProfileNickname, readCainiaoSenderAppointments,
  retainJdLoginView, stationIdentityDestination } from "../services/platform-wire";
import { cainiaoHandoffId, cainiaoHandoffs, cainiaoParcelDetails, cainiaoRecipientParcels, displayDeliveryEstimate, parseHandoffWindow,
  pddParcelAppURL, pddParcelDetailPath, pddPickupParcels } from "../services/platform-parcel-data";
import { cabinetParcels, type CabinetParcel } from "../services/fengchao-account";
import { cloudPddParcelAppURL, displayedPlatformFields, enrichPlatformParcel, hasPddParcelSource, keepPlatformFields, matchPlatformParcel, pddParcelProductImage } from "../services/platform-parcel-merge";
import { parseCloudParcelDetails } from "../services/cloud-parcel-metadata";
import { cainiaoImageCacheKey, productImageCachePath } from "../services/product-image-cache";
import { activePickupCards, nextPickupArtwork, parcelActivityContent, shipmentForPickupTarget, withPickupArtwork } from "../services/parcel-pickup";
import { registerProjectionViewportHost } from "../services/projection-viewport";
import { clearDiagnostics, readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { fetchJdParcels } from "../services/platform-web-parcels";
import { refreshParcelDetailFields } from "../services/parcel-detail-fields";

const {
  completeCurrentParcelCard, emptyState, expireDueParcelHandoffs, loadState, saveCloudPddParcels, savePlatformParcelData,
  saveCloudPddParcelSource, saveRecognizedParcelCode, saveState, setParcelHandoffWindow, setPickupCardNote, visibleShipments,
} = await import("../services/storage");
const { pickupCabinetActions, performPickupAction, platformRefreshMessage, refreshPlatformParcels } =
  await import("../services/platform-parcel-sync");
const { manualRefreshTasks } = await import("../services/sync/manual-chain-runner");

const waybill = "YT000000008123";
const order = "88000008123";
const key = "synthetic-cainiao-account";
test("PDD app detail opens the exact parcel using the native scheme", () => {
  const parcel = { ownerKey: "synthetic-pdd-owner", orderId: order, shippingId: "73000919" };
  const path = "/psnl_goods_help.html?_t_module_name=assistant_waybill&shipping_id=73000919&tracking_number=" + waybill;
  assert.equal(pddParcelDetailPath(parcel.shippingId, waybill), path);
  assert.equal(pddParcelAppURL(parcel, waybill), "pinduoduo://com.xunmeng.pinduoduo" + path);
  assert.equal(pddParcelAppURL(undefined, waybill), "");
  assert.equal(pddParcelAppURL({ ...parcel, ownerKey: "" }, waybill), "");
  assert.equal(pddParcelAppURL({ ...parcel, orderId: "" }, waybill), "");
  assert.equal(pddParcelAppURL({ ...parcel, shippingId: "1&bad=1" }, waybill), "");
  assert.equal(pddParcelAppURL(parcel, waybill + "#other"), "");
});
const pickupInput = { source: "cainiao", waybill, code: "1-5-0012", name: "测试菜鸟驿站", address: "测试路 1 号" } as const;
const rediscovered = cainiaoRecipientParcels({ packages: [{
  status: "WAIT_PICKUP", mailNo: waybill, tbOrderId: order,
  packageItem: [{ itemTitle: "示例商品" }],
  packageStation: { authCode: "NEED_SMS", showPickupCode: "１-５-００１２", pointName: "测试菜鸟驿站", address: "测试路 1 号" },
  packageDyn: { arriveTime: "预计明天送达" },
}] }, NOW);

function shipment(overrides: Partial<Shipment> = {}): Shipment {
  return {
    identity: { id: "parcel-fixture", bindingSource: null, sourceOwner: "manual", sourceId: waybill, phoneTail: "",
      courierCode: "YTO", companyName: "圆通速递", manuallyAdded: true, createdAtMs: NOW - 20_000 },
    timeline: {
      provider: "picker", waybill, courierCode: "YTO", companyName: "圆通速递", semantic: "WAITING_PICKUP",
      statusEventAtMs: NOW - 10_000, latestTimeText: "2026-09-08 13:59", latestDetail: "快递已到驿站",
      tracks: [{
        timeMs: NOW - 10_000, timeText: "2026-09-08 13:59", detail: "快递已到驿站", statusCode: "", raw: {},
      }], successAtMs: NOW - 10_000,
    },
    updatedAtMs: NOW - 10_000, ...overrides,
  };
}

test("cloud PDD adopts a matching manual waybill and queues a new one without local PDD login", () => {
  memory.clear();
  const manual = shipment({ note: "Keep this note" });
  const before = saveState({ ...emptyState(), shipments: [manual] }, NOW);
  const current = before.shipments[0];
  const cloud = { waybill, anchorAt: NOW - 20_000, terminalAt: 0, carrierCode: "YTO", phone4: "1234" };
  const newBill = "YT000000008124";
  const records = [cloud, { ...cloud, waybill: newBill }];
  assert.deepEqual(saveCloudPddParcels(records, before, () => false, NOW), { state: before, changed: false });
  const { state: imported, changed } = saveCloudPddParcels(records, before, () => true, NOW);
  assert.equal(changed, true);
  const adopted = imported.shipments.find(row => row.identity.id === current.identity.id)!;
  assert.deepEqual(adopted.identity, current.identity);
  assert.deepEqual(adopted.timeline, current.timeline);
  assert.equal(adopted.note, current.note);
  assert.equal(hasPddParcelSource(adopted), true);
  const added = imported.shipments.find(row => row.identity.sourceId === newBill)!;
  assert.equal(imported.shipments.length, 2);
  assert.equal(added.identity.manuallyAdded, true);
  assert.equal(added.identity.phoneTail, "1234");
  assert.equal(added.timeline.semantic, "UNKNOWN");
  assert.deepEqual(added.timeline.tracks, []);
  assert.equal(hasPddParcelSource(added), true);
  assert.ok(manualRefreshTasks(imported, imported.activeSource, NOW, new Set(), false)
    .some(task => task.id === added.identity.id));
  assert.deepEqual(visibleShipments(imported, NOW).map(row => row.identity.id), [current.identity.id]);
  const replayed = saveCloudPddParcels(records, imported, () => true, NOW);
  assert.equal(replayed.state.revision, imported.revision);
  assert.equal(replayed.changed, false);
  assert.equal(hasPddParcelSource(keepPlatformFields(adopted, current)), true);
  assert.equal(hasPddParcelSource({ ...adopted, waybillReuseAtMs: NOW }), false);
});

test("cloud PDD leaves other owners and ambiguous or reused waybills alone", () => {
  memory.clear();
  const current = shipment();
  const before = saveState({ ...emptyState(), shipments: [current] }, NOW);
  const cloud = { waybill, anchorAt: NOW - 20_000, terminalAt: 0, carrierCode: "YTO", phone4: "" };
  assert.equal(saveCloudPddParcels([cloud, cloud], before, () => true, NOW).state.revision, before.revision);
  const earlier = NOW - 3 * 86_400_000;
  assert.equal(saveCloudPddParcels([{ ...cloud, anchorAt: earlier, terminalAt: earlier + 1 }], before, () => true, NOW).state.revision, before.revision);
  const deleted = saveState({ ...before, shipments: [] }, NOW);
  const afterDeletion = saveCloudPddParcels([cloud], before, () => true, NOW);
  assert.equal(afterDeletion.state.revision, deleted.revision);
  assert.equal(afterDeletion.changed, false);
});

test("a cloud PDD link can open a matched parcel with complete local display fields and no PDD session", () => {
  const pddLink = { waybill, anchorAt: NOW - 10_000, terminalAt: 0, shippingId: "73000919", observedAt: NOW - 2_000 };
  const parsed = parseCloudParcelDetails({ ok: true, metadata: null, pddLink }, waybill, NOW);
  assert.equal(parsed?.metadata, undefined);
  assert.equal(cloudPddParcelAppURL(shipment(), parsed?.pddLink, NOW),
    "pinduoduo://com.xunmeng.pinduoduo" + pddParcelDetailPath("73000919", waybill));
  const untrackedManual = shipment({
    timeline: {
      provider: "manual", waybill, courierCode: "SF", companyName: "顺丰速运", semantic: "UNKNOWN",
      statusEventAtMs: null, latestTimeText: "", latestDetail: "", tracks: [], successAtMs: null,
    },
  });
  assert.equal(cloudPddParcelAppURL(untrackedManual, parsed?.pddLink, NOW),
    "pinduoduo://com.xunmeng.pinduoduo" + pddParcelDetailPath("73000919", waybill));
  const reused = { ...pddLink, anchorAt: NOW - 3 * 86_400_000, terminalAt: NOW - 2 * 86_400_000 };
  assert.equal(cloudPddParcelAppURL(shipment(), reused, NOW), "");
  assert.equal(cloudPddParcelAppURL(untrackedManual, reused, NOW), "");
  assert.equal(cloudPddParcelAppURL(shipment(), { ...pddLink, waybill: "SYNTHETIC456" }, NOW), "");
  for (const shippingId of ["", 73000919, "73000919&next=2"]) {
    const metadata = { waybill, anchorAt: NOW - 10_000, productName: "Synthetic item" };
    const validTitle = parseCloudParcelDetails({ ok: true, metadata, pddLink: { ...pddLink, shippingId } }, waybill, NOW);
    assert.equal(validTitle?.pddLink, undefined);
    assert.equal(validTitle?.metadata?.productName, "Synthetic item");
  }
});

test("PDD product images stay with their exact local association or matching cloud parcel", () => {
  const pddImport = { ownerKey: "synthetic-pdd-owner", orderId: order, shippingId: "73000919" };
  const parcel = shipment({ pddImport });
  const image = "https://img.pddpic.com/mms-material-img/synthetic.png";
  const result = { source: "pinduoduo" as const, waybill, shippingId: pddImport.shippingId, productImageURL: image };
  assert.equal(pddParcelProductImage(enrichPlatformParcel(parcel, { ...result, shippingId: "73000920" }, NOW)), "");
  const matched = enrichPlatformParcel(parcel, result, NOW);
  assert.equal(pddParcelProductImage(matched), image);
  assert.equal(pddParcelProductImage(enrichPlatformParcel(matched, {
    ...result, productImageURL: "https://img.pddpic.com/another.png",
  }, NOW)), image);
  assert.equal(pddParcelProductImage({ ...matched, pddImport: { ...pddImport, ownerKey: "other-account" } }), "");
  assert.equal(pddParcelProductImage({ ...matched, waybillReuseAtMs: NOW }), "");

  const metadata = { waybill, anchorAt: NOW - 20_000, terminalAt: 0, productImageUrl: image };
  const cloud = parseCloudParcelDetails({ ok: true, metadata }, waybill, NOW)?.metadata;
  assert.equal(displayedPlatformFields(shipment(), NOW, cloud).productImageURL, image);
  assert.equal(displayedPlatformFields(shipment(), NOW, { ...cloud!, waybill: "YTOTHER00000" }).productImageURL, undefined);
  for (const invalid of ["https://funimg.pddpic.com/carrier.png", image + "?token=synthetic"]) {
    assert.equal(parseCloudParcelDetails({ ok: true, metadata: { ...metadata, productImageUrl: invalid } }, waybill, NOW), undefined);
  }
});

test("a signed PDD link adopts the existing signed manual shipment without replacing its data", () => {
  memory.clear();
  const base = shipment();
  const signed = shipment({ note: "Keep this note", timeline: { ...base.timeline, semantic: "COMPLETED",
    structuredStatus: true } });
  const before = saveState({ ...emptyState(), shipments: [signed] }, NOW);
  const current = before.shipments[0];
  const link = { waybill, anchorAt: NOW - 20_000, terminalAt: NOW - 10_000, shippingId: "73000919" };
  assert.equal(saveCloudPddParcelSource(current, link, () => false, NOW), undefined);
  assert.equal(saveCloudPddParcelSource(current, { ...link, shippingId: "" }, () => true, NOW), undefined);
  const saved = saveCloudPddParcelSource(current, link, () => true, NOW)!;
  assert.equal(saved.shipments.length, 1);
  assert.ok(hasPddParcelSource(saved.shipments[0]));
  assert.deepEqual(saved.shipments[0].identity, current.identity);
  assert.deepEqual(saved.shipments[0].timeline, current.timeline);
  assert.equal(saved.shipments[0].note, current.note);
  assert.equal(saveCloudPddParcelSource(current, link, () => true, NOW), undefined);
  assert.equal(loadState(NOW).revision, saved.revision);
  saveState({ ...saved, shipments: [] }, NOW);
  assert.equal(saveCloudPddParcelSource(current, link, () => true, NOW), undefined);
  assert.deepEqual(loadState(NOW).shipments, []);
});

let generation = 0;
Object.assign(globalThis, { UUID: { string: () => "generation-" + ++generation } });
const sessionCookie = {
  name: "PDDAccessToken", value: "synthetic-pdd-session", domain: ".pinduoduo.com",
  path: "/", isSecure: true, isHTTPOnly: true, isSessionOnly: true,
};

test("Cainiao labels admit a profile nickname, masked phone or numeric ID", async (t) => {
  memory.clear();
  const cookie = (name: string, value: string) => ({ ...sessionCookie, domain: ".taobao.com", name, value });
  const credentials = { kind: "web", cookies: [cookie("lgc", "private-login-name"), cookie("unb", "2200998877")] } as const;
  savePlatformLogin("cainiao", "", credentials, "private-login-name");
  assert.equal(accountStatus("cainiao").label, "****8877");
  const first = platformSession("cainiao")!;
  clearPlatformLogin("cainiao", first.generation);
  savePlatformLogin("cainiao", accountStatus("cainiao").generation,
    { ...credentials, cookies: [...credentials.cookies, cookie("_nk_", "13900139000")] }, "private-login-name");
  assert.equal(accountStatus("cainiao").label, "139****9000");
  assert.equal(saveCainiaoNickname(first.generation, "Stale profile"), false);

  const oldCrypto = globalThis.Crypto;
  Object.assign(globalThis, { Crypto: { ...oldCrypto,
    md5: (data: string) => ({ toHexString: () => createHash("md5").update(data).digest("hex") }),
  } });
  const request = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.match(String(url), /mtop\.taobao\.reborn\.mclaren\.h5/);
    assert.equal((init.headers as Record<string, string>).Referer, "https://main.m.taobao.com/mytaobao/index.html");
    return new Response(JSON.stringify({ ret: ["SUCCESS"], data: { h5HeaderValve: {
      userInfo: { nickName: "示例昵称" }, accountTip: { userName: "private-login-name" },
    } } }));
  });
  try {
    const active = platformSession("cainiao")!;
    const nickname = await readCainiaoProfileNickname(active);
    assert.equal(nickname, "示例昵称");
    assert.equal(saveCainiaoNickname(active.generation, nickname), true);
    assert.equal(accountStatus("cainiao").label, "示例昵称");
    assert.equal(accountStatus("cainiao").syncedAtMs, undefined);
    request.mock.mockImplementationOnce(async () => new Response(JSON.stringify({ ret: ["SUCCESS"], data: { h5HeaderValve: {
      userInfo: { nickName: "private-login-name" }, accountTip: { userName: "private-login-name" },
    } } })));
    assert.equal(await readCainiaoProfileNickname(active), "");
  } finally {
    Object.assign(globalThis, { Crypto: oldCrypto });
  }
});

test("the account subtitle keeps the nickname or masked label and only dates earlier syncs", (t) => {
  memory.clear();
  t.mock.method(Date, "now", () => new Date(2026, 10, 18, 0, 8).getTime());
  const syncedAt = new Date(2026, 10, 18, 0, 7).getTime();
  const credentials = { kind: "web", cookies: [sessionCookie] } as const;
  savePlatformLogin("pinduoduo", "", credentials, "synthetic-account-0123", "示例昵称");
  const pdd = accountStatus("pinduoduo");
  assert.equal(platformAccountSubtitle(pdd), "示例昵称 · 尚未同步");
  notePlatformSync("pinduoduo", pdd.generation, syncedAt);
  assert.equal(platformAccountSubtitle(accountStatus("pinduoduo")), "示例昵称 · 00:07");
  clearPlatformLogin("pinduoduo", pdd.generation, true);
  assert.equal(platformAccountSubtitle(accountStatus("pinduoduo")), "示例昵称 · 请重新登录");
  savePlatformLogin("cainiao", "", { kind: "web", cookies: [
    { ...sessionCookie, domain: ".taobao.com", name: "unb", value: "2200994321" },
  ] }, "2200994321");
  const cainiao = accountStatus("cainiao");
  notePlatformSync("cainiao", cainiao.generation, new Date(2026, 10, 17, 23, 59).getTime());
  assert.equal(platformAccountSubtitle(accountStatus("cainiao")), "****4321 · 11-17 23:59");
  assert.equal(platformAccountSubtitle({ ...cainiao, label: "账号 ****4321" }), "****4321 · 尚未同步");
  assert.equal(platformAccountSubtitle(accountStatus("fengchao")), "尚未登录");
});

test("recipient field aliases, placeholder rejection and station address", () => {
  assert.equal(rediscovered.length, 1);
  assert.deepEqual(rediscovered[0], {
    ...pickupInput, orderIds: [order], title: "示例商品", estimate: "预计明天送达", unnumbered: false,
    carrierCode: "", carrierName: "",
  });
  assert.equal(cainiaoRecipientParcels({ packages: [{
    status: "SIGNED", mailNo: waybill, packageStation: { authCode: "12345" },
  }] }, NOW)[0]?.taken, true);
  const pdd = pddPickupParcels({ result: { station_name: "页面标题", only_wx_scan: true, combine_list: [{
    company_name: "包裹所属多多驿站", address: "测试路 12 号", combine_track_list: [{ tracking_number: waybill }],
  }] } });
  assert.equal(pdd[0].name, "包裹所属多多驿站");
  assert.equal(pdd[0].code, "");
  const existing = enrichPlatformParcel(shipment(), pickupInput, NOW);
  assert.deepEqual(enrichPlatformParcel(existing, pdd[0], NOW + 5), existing);
});

test("ETA keeps the first observation and disappears after the expected day or pickup", () => {
  const moving = shipment({ timeline: { ...shipment().timeline, semantic: "TRANSIT" } });
  const first = enrichPlatformParcel(moving, rediscovered[0], NOW);
  const repeated = enrichPlatformParcel(first, rediscovered[0], NOW + 86_400_000);
  assert.equal(first.platformFields?.estimate?.capturedAtMs, NOW);
  assert.equal(repeated.platformFields?.estimate?.capturedAtMs, NOW);
  assert.deepEqual(displayedPlatformFields(repeated, NOW + 86_400_000), {
    title: "示例商品", estimate: "预计9月9日送达",
  });
  assert.equal(displayDeliveryEstimate("预计明天送达", NOW, NOW + 2 * 86_400_000), "");
  assert.equal(displayedPlatformFields({ ...repeated, timeline: shipment().timeline }, NOW).estimate, "");
});

test("cloud metadata fills same-parcel gaps with its original observation and preserves manual titles", () => {
  const moving = shipment({ timeline: { ...shipment().timeline, semantic: "TRANSIT" } });
  const metadata = { waybill, productName: "示例云商品", anchorAt: NOW - 3_600_000,
    deliveryEstimate: "预计明天送达", deliveryEstimateObservedAt: NOW - 86_400_000 };
  assert.deepEqual(displayedPlatformFields(moving, NOW, metadata), {
    title: "示例云商品", estimate: "预计9月8日送达",
  });
  const manual = { ...moving, platformFields: {
    waybill, waybillGeneration: 0, manualTitle: "示例手动名称",
  } };
  assert.equal(displayedPlatformFields(manual, NOW, metadata).title, "示例手动名称");
  assert.equal(displayedPlatformFields(moving, NOW, { ...metadata, waybill: "MISMATCH123" }).title ?? "", "");
  assert.equal(displayedPlatformFields(moving, NOW, { ...metadata, anchorAt: NOW - 4 * 86_400_000,
    terminalAt: NOW - 3 * 86_400_000 }).title ?? "", "");
  assert.equal(displayedPlatformFields(shipment(), NOW, metadata).estimate, "");
});

test("only same-order uniquely verified waybill reaches a waiting Cainiao order", () => {
  const base = shipment();
  const orderOwner = shipment({
    identity: { ...base.identity, sourceId: order, orderId: order, sourceProvider: "cainiao", accountOrder: true },
    timeline: { ...base.timeline, waybill: order },
  });
  const observed = { ...rediscovered[0], carrierCode: "YTO", carrierName: "圆通速递" };
  assert.equal(matchPlatformParcel([orderOwner], observed, key), orderOwner);
  assert.equal(matchPlatformParcel([orderOwner, { ...orderOwner, identity: { ...orderOwner.identity, id: "split" }}],
    observed, key), undefined);
  const projected = enrichPlatformParcel(orderOwner, observed, NOW);
  assert.equal(projected.identity.projectedWaybill, waybill);
  assert.equal(parcelActivityContent(projected)?.code, pickupInput.code);
});

test("signed, removed and reused waybills cannot acquire a late recipient code", () => {
  for (const replacement of ["completed", "removed", "reused"]) {
    memory.clear();
    const original = saveState({ ...emptyState(), shipments: [shipment()] }, NOW);
    const saved = original.shipments[0];
    const next = replacement === "removed" ? [] : [{
      ...saved,
      ...(replacement === "completed" ? { forcedCompletedAtMs: NOW + 5 } : { waybillReuseAtMs: NOW + 5 }),
    }];
    saveState({ ...original, shipments: next }, NOW + 5);
    const result = savePlatformParcelData({ observed: original, owner: key, current: () => true, parcels: rediscovered }, NOW + 10);
    assert.equal(activePickupCards(visibleShipments(result.state), result.state.pickupCodeRecords).length, 0);
    assert.equal(result.state.shipments[0]?.pickup, undefined);
  }
});

test("genuinely unnumbered Cainiao pickup is separate and never revived after completion", () => {
  memory.clear();
  const original = saveState({ ...emptyState(), shipments: [shipment()] }, NOW);
  const rows = cainiaoRecipientParcels({ packages: [
    { packageStation: { authCode: "A1234", pointName: "示例驿站" } },
    { packageStation: { authCode: "C1234" } },
    { mailNo: "YT000000008985", packageStation: { authCode: "B1234", pointName: "示例驿站" } },
  ] }, NOW);
  const input = { observed: original, owner: key, current: () => true, parcels: rows };
  const { state: result, changed } = savePlatformParcelData(input, NOW + 1000);
  assert.equal(changed, true);
  assert.equal(result.shipments.length, 1);
  assert.equal(result.pickupCodeRecords?.length, 2);
  const cards = activePickupCards(visibleShipments(result), result.pickupCodeRecords);
  const card = cards.find(item => item.code === "A1234")!;
  assert.equal(card.title, "菜鸟驿站");
  assert.equal(cards.find(item => item.code === "C1234")?.title, "菜鸟驿站");
  completeCurrentParcelCard(card, NOW + 2000);
  const { state: repeated, changed: replayChanged } = savePlatformParcelData(input, NOW + 3000);
  assert.equal(replayChanged, false);
  assert.equal(repeated.pickupCodeRecords?.find(item => item.code === "A1234")?.completedAtMs, NOW + 2000);
  assert.deepEqual(activePickupCards(visibleShipments(repeated), repeated.pickupCodeRecords).map(item => item.code), ["C1234"]);
});

test("Cainiao details take the first valid product image from the exact parcel", () => {
  const image = "https://img.alicdn.com/synthetic-product.jpg";
  const detail = { mailNo: waybill, partnerLogoUrl: "https://img.alicdn.com/synthetic-partner.jpg",
    goodsList: [{ itemPic: "//img.alicdn.com/synthetic-product.jpg" }] };
  const result = cainiaoParcelDetails({ result: [{ ...detail, mailNo: "YT000000007000" }, detail] }, waybill, NOW);
  assert.equal(result?.productImageURL, image);
  assert.equal(cainiaoParcelDetails({ result: [detail, detail] }, waybill, NOW), undefined);
  assert.equal(cainiaoParcelDetails({ result: { ...detail, goodsList: [
    { itemPic: "https://img.alicdn.com/first.jpg" }, { itemPic: "https://img.alicdn.com/second.jpg" },
  ] } }, waybill, NOW)?.productImageURL, "https://img.alicdn.com/first.jpg");
  assert.equal(cainiaoParcelDetails({ result: { ...detail, goodsList: [
    { itemPic: "https://example.invalid/image.jpg" }, { allPicUrl: "https://img.alicdn.com/second.jpg" },
  ] } }, waybill, NOW)?.productImageURL, "https://img.alicdn.com/second.jpg");
  assert.equal(cainiaoParcelDetails({ result: { ...detail, goodsList: [
    { itemPic: "https://img.alicdn.com/synthetic-product.jpg?access=placeholder" },
  ] } }, waybill, NOW)?.productImageURL, undefined);
  const saved = enrichPlatformParcel(shipment(), result!, NOW, "synthetic-session");
  assert.deepEqual(saved.platformFields?.cainiaoImage, { url: image, generation: "synthetic-session" });
});

test("verified sender artwork ignores a saved fallback brand", () => {
  const id = cainiaoHandoffId(key, "SYNTHETIC");
  const common = { kind: "handoff", platform: "cainiao", code: "4221", capturedAtMs: NOW } as const;
  const verified = activePickupCards([], [{ id, ...common }])[0];
  assert.equal(nextPickupArtwork(verified), undefined);
  assert.equal(withPickupArtwork(verified, { ["record:" + id]: "douyin" }).artworkChoice, undefined);
  assert.equal(nextPickupArtwork(activePickupCards([], [{ id: "local-capture", ...common }])[0]), undefined);
  assert.notEqual(nextPickupArtwork(activePickupCards([], [{ id: "local-capture", ...common, platform: "pinduoduo" }])[0]), undefined);
});

test("recipient sync closes only explicitly taken cards without changing tracking", () => {
  memory.clear();
  const original = saveState({ ...emptyState(), shipments: [shipment()] }, NOW);
  const station = { authCode: "A1234", pointName: "示例驿站" };
  const active = cainiaoRecipientParcels({ packages: [
    { mailNo: waybill, packageStation: { authCode: "B1234" } },
    { packageStation: station },
    { packageStation: { authCode: "C1234" } },
  ] }, NOW);
  const sync = (observed, parcels, at) => savePlatformParcelData({ observed, owner: key, current: () => true, parcels }, at);
  const first = sync(original, active, NOW).state;
  assert.equal(activePickupCards(visibleShipments(first, NOW), first.pickupCodeRecords).length, 3);
  assert.equal(sync(first, [], NOW + 1).changed, false);
  const receipts = cainiaoRecipientParcels({ packages: [
    { status: "SIGNED", mailNo: waybill },
    { status: "已取件", packageStation: station },
    { status: "已取消", packageStation: { authCode: "C1234" } },
  ] }, NOW + 2);
  const completed = sync(first, receipts, NOW + 2).state;
  assert.equal(completed.shipments[0].timeline.semantic, "WAITING_PICKUP");
  assert.deepEqual(activePickupCards(visibleShipments(completed, NOW), completed.pickupCodeRecords).map(card => card.code), ["C1234"]);
  assert.equal(sync(completed, active, NOW + 3).changed, false);
});

test("a manual appointment edit and a time-only reschedule keep one card and its expiry", () => {
  memory.clear();
  const record = {
    id: cainiaoHandoffId(key, "APPOINTMENT"), platform: "cainiao", kind: "handoff",
    code: "5629", capturedAtMs: NOW,
  } as const;
  const first = saveRecognizedParcelCode(record, NOW);
  const manualWindow = parseHandoffWindow("09-08 16:00–17:00", NOW, true)!;
  assert.equal(parseHandoffWindow("bad 09-08 16:00–17:00", NOW, true), undefined);
  const manually = setParcelHandoffWindow(first.pickupCodeRecords![0] as typeof record, manualWindow, NOW + 1);
  assert.equal(manually.pickupCodeRecords![0].windowEndAtMs, manualWindow[1]);
  const provider = (packages, existing) => cainiaoHandoffs({ packages }, key, NOW + 2, existing.pickupCodeRecords);
  const sync = (observed, handoffs) => savePlatformParcelData({ observed, owner: key, current: () => true, parcels: [], handoffs }, NOW + 3);
  const waiting = { appointmentId: "APPOINTMENT", status: "WAIT_GOT" };
  assert.equal(sync(manually, provider([waiting], manually)).changed, false);
  const rescheduled = sync(manually, provider([{ ...waiting, appointTimeStr: "09-08 18:00–19:00" }], manually)).state;
  const nextEnd = Date.UTC(2026, 8, 8, 11);
  assert.equal(rescheduled.pickupCodeRecords?.length, 1);
  assert.deepEqual([rescheduled.pickupCodeRecords![0].id, rescheduled.pickupCodeRecords![0].windowEndAtMs], [record.id, nextEnd]);
  assert.throws(() => setParcelHandoffWindow(manually.pickupCodeRecords![0] as typeof record, manualWindow, NOW + 4));
  assert.equal(activePickupCards([], expireDueParcelHandoffs(nextEnd + 3_600_000 - 1).pickupCodeRecords).length, 1);
  assert.equal(activePickupCards([], expireDueParcelHandoffs(nextEnd + 3_600_000).pickupCodeRecords).length, 0);
});

test("active doorstep appointments carry absolute windows and terminal statuses are excluded", () => {
  const input = { appointmentId: "return-order-synthetic", sendCode: "8001", appointTimeStr: "09-08 16:00–18:00 上门" };
  const result = cainiaoHandoffs({ sendPackages: [
    { status: "WAIT_GOT", appointment: { ...input, appointStatus: "APPOINTED" } },
    { status: "已揽收", appointment: { ...input, appointStatus: "APPOINTED" } },
    { status: "WAIT_GOT", appointment: { appointmentId: "courier-no-window", sendCode: "8002" } },
  ] }, key, NOW);
  assert.equal(result.length, 2);
  assert.equal(result[0].code, "8001");
  assert.equal(result[0].windowStartAtMs, Date.UTC(2026, 8, 8, 8));
  assert.equal(result[0].windowEndAtMs, Date.UTC(2026, 8, 8, 10));
  assert.equal(result[1].code, "8002");
  assert.equal(result[1].windowEndAtMs, undefined);
});

test("pickup detail and note writes follow the matching waybill generation", () => {
  memory.clear();
  const state = saveState({ ...emptyState(), shipments: [shipment({ pickup: {
    platform: "cainiao", waybill, waybillGeneration: 0, code: "1-2-3456", capturedAtMs: NOW - 1000,
  } })] }, NOW);
  const visible = visibleShipments(state, NOW);
  const card = activePickupCards(visible)[0];
  const linked = shipmentForPickupTarget(visible, card.target)!;
  assert.equal(linked.identity.id, "interface5:manual:" + waybill);
  assert.equal(shipmentForPickupTarget([{ ...linked, waybillReuseAtMs: NOW }], card.target), undefined);
  const saved = setPickupCardNote(card, "", "  到站后检查  ", NOW + 1);
  assert.equal(saved.shipments[0].note, "到站后检查");
  assert.throws(() => setPickupCardNote(card, "", "旧编辑器", NOW + 2));
  assert.equal(setPickupCardNote(card, "到站后检查", "", NOW + 3).shipments[0].note, undefined);
});

test("a handoff note survives provider refresh and cannot edit a completed card", async (t) => {
  memory.clear();
  t.mock.method(Date, "now", () => NOW + 100);
  const record = {
    id: "synthetic-handoff-note", kind: "handoff", platform: "cainiao", code: "4100", capturedAtMs: NOW,
    windowEndAtMs: NOW + 30_000, windowText: "09-08 14:00–15:00 上门",
  } as const;
  const state = saveRecognizedParcelCode(record, NOW);
  const card = activePickupCards([], state.pickupCodeRecords)[0];
  assert.equal(shipmentForPickupTarget([], card.target), undefined);
  const noted = setPickupCardNote(card, "", "退换货", NOW + 1);
  const refreshed = savePlatformParcelData({
    observed: noted, owner: key, parcels: [], handoffs: [{ ...record, windowEndAtMs: NOW + 60_000 }],
    current: () => true,
  }, NOW + 2).state;
  assert.equal(refreshed.pickupCodeRecords?.find(({ id }) => id === record.id)?.note, "退换货");
  assert.equal(await performPickupAction(card, false, () => {}), "已寄件");
  assert.throws(() => setPickupCardNote(card, "退换货", "迟到备注", NOW + 101));
});

test("Taobao station identity reads the reference script's nested payload and expiry", () => {
  const value = "CS00000000000000001A";
  assert.deepEqual(identityCodeFromResponse("cainiao", { identityCode: value }, NOW),
    { value, expiresAtMs: NOW + 300_000 });
  for (const field of ["result", "data"]) {
    assert.deepEqual(identityCodeFromResponse("cainiao", { [field]: { identityCode: value } }, NOW),
      { value, expiresAtMs: NOW + 300_000 });
  }
  assert.deepEqual(identityCodeFromResponse("cainiao",
    { data: { model: [{ identityCode: value, expireTime: 30 }] } }, NOW),
    { value, expiresAtMs: NOW + 30_000 });
  assert.deepEqual(identityCodeFromResponse("cainiao",
    { result: { model: { code: value, expireTime: 1_200_000 } } }, NOW),
    { value, expiresAtMs: NOW + 1_200_000 });
  assert.throws(() => identityCodeFromResponse("cainiao",
    { result: { unrelatedCode: value } }, NOW));
});

test("PDD identity uses the provider lifetime and standard Code 128 symbols", () => {
  assert.deepEqual(identityCodeFromResponse("pinduoduo", { result: { identification_code: "PD123456", expire_mills: 30_000 } }, NOW),
    { value: "PD123456", expiresAtMs: NOW + 30_000 });
  assert.deepEqual(identityCodeFromResponse("pinduoduo", {
    result: { identification_code: "PD123456", mobile_info_desc: "已绑定常用手机号：138****0000" },
  }, NOW), { value: "PD123456", expiresAtMs: NOW + 300_000, mobile: "138****0000" });
  assert.throws(() => identityCodeFromResponse("pinduoduo",
    { result: { identification_code: "012345", expire_mills: true } }, NOW));
  assert.throws(() => identityCodeFromResponse("pinduoduo", { result: { identification_code: "跨", expire_mills: 10 } }, NOW));
  assert.equal(code128Widths("123456").join(""), "2112321122321311233311211321312331112");
  assert.equal(trustedPlatformPage("pinduoduo", "https://mobile.yangkeduo.com/orders.html"), true);
  assert.equal(trustedPlatformPage("pinduoduo", "https://mobile.yangkeduo.com.example.invalid/orders.html"), false);
});

test("the Cainiao action requests the Taobao identity with the current account only", async (t) => {
  memory.clear();
  const cookie = { ...sessionCookie, name: "cookie2", domain: ".taobao.com", value: "synthetic-taobao-session" };
  savePlatformLogin("cainiao", "", { kind: "web", cookies: [cookie] }, "synthetic-taobao-account");
  const session = platformSession("cainiao")!;
  t.mock.method(Date, "now", () => NOW);
  const previousCrypto = globalThis.Crypto;
  const value = "CS00000000000000001A";
  const read = (input: string, init: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.hostname, "h5api.m.taobao.com");
    assert.equal(url.searchParams.get("api"), "mtop.cainiao.pickup.identity.getIdentityMessage");
    assert.deepEqual(JSON.parse(url.searchParams.get("data")!), {});
    assert.equal((init.headers as Record<string, string>).Cookie, "cookie2=synthetic-taobao-session");
    return new Response(JSON.stringify({ ret: ["SUCCESS::ok"], data: { data: { model: { identityCode: value, expireTime: 90 } } } }));
  };
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => read(input, init));
  try {
    Object.assign(globalThis, { Crypto: { ...previousCrypto,
      md5: (data: string) => ({ toHexString: () => createHash("md5").update(data).digest("hex") }),
    } });
    assert.deepEqual(await fetchStationIdentity("cainiao", session), { value, expiresAtMs: NOW + 90_000 });
    fetchMock.mock.mockImplementationOnce(async (input: string, init: RequestInit) => {
      const response = read(input, init);
      clearPlatformLogin("cainiao", session.generation);
      return response;
    });
    await assert.rejects(fetchStationIdentity("cainiao", session), /changed/);
  } finally {
    Object.assign(globalThis, { Crypto: previousCrypto });
  }
});

test("old PDD identity response after logout cannot create an active code or clear a newer account", async () => {
  memory.clear();
  savePlatformLogin("pinduoduo", "", { kind: "web", cookies: [sessionCookie] }, "synthetic-account-one");
  const first = platformSession("pinduoduo")!;
  let respond!: (result: Response) => void;
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise((resolve) => { respond = resolve; });
  try {
    const request = fetchStationIdentity("pinduoduo", first);
    clearPlatformLogin("pinduoduo", first.generation);
    const loggedOut = accountStatus("pinduoduo");
    savePlatformLogin("pinduoduo", loggedOut.generation, { kind: "web", cookies: [sessionCookie] }, "synthetic-account-two");
    respond(new Response(JSON.stringify({ result: { identification_code: "A12345", expire_mills: 30_000 } })));
    await assert.rejects(request, /changed/);
    assert.notEqual(platformSession("pinduoduo")?.generation, first.generation);
    assert.equal(currentPlatformSession("pinduoduo", first.generation), null);
  } finally { globalThis.fetch = realFetch; }
});

test("the same Taobao session reads both Taobao and Cainiao outbound codes", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  memory.clear();
  const cookie = { ...sessionCookie, name: "cookie2", domain: ".taobao.com", value: "synthetic-taobao-session" };
  savePlatformLogin("cainiao", "", { kind: "web", cookies: [cookie] }, "synthetic-account");
  const session = platformSession("cainiao")!;
  const previousCrypto = globalThis.Crypto;
  const calls: string[] = [];
  const code = "CS00000000000000002A";
  const taobaoCode = "XNSTA123456789";
  let outboundAvailable = true;
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const api = url.searchParams.get("api")!;
    calls.push(api);
    const data = JSON.parse(url.searchParams.get("data")!);
    assert.equal(url.hostname, "h5api.m.taobao.com");
    assert.equal(new Headers(init?.headers).get("cookie"), "cookie2=synthetic-taobao-session");
    if (api === "mtop.cainiao.pickup.identity.getIdentityMessage") {
      assert.deepEqual(data, {});
      return new Response(JSON.stringify({ ret: ["SUCCESS"], data: { result: { identityCode: taobaoCode } } }));
    }
    assert.equal(api, "mtop.cainiao.nbpickup.identitycode.get");
    assert.equal(url.searchParams.get("v"), "1.0");
    assert.equal(new Headers(init?.headers).get("referer"), "https://h5.m.taobao.com/");
    assert.deepEqual(data, { appName: "GUOGUO", verifyVersion: "V2" });
    if (!outboundAvailable) {
      return new Response(JSON.stringify({ ret: ["FAIL_SYS_SESSION_EXPIRED"] }));
    }
    return new Response(JSON.stringify({ ret: ["SUCCESS"], data: { model: { identityCode: code, expireTime: 240 } } }));
  });
  try {
    Object.assign(globalThis, { Crypto: { ...previousCrypto,
      md5: (data: string) => ({ toHexString: () => createHash("md5").update(data).digest("hex") }),
    } });
    assert.equal((await fetchStationIdentity("cainiao", session)).value, taobaoCode);
    assert.deepEqual(await fetchStationIdentity("cainiao", session, undefined, true),
      { value: code, expiresAtMs: NOW + 240_000 });
    assert.deepEqual(calls, ["mtop.cainiao.pickup.identity.getIdentityMessage", "mtop.cainiao.nbpickup.identitycode.get"]);
    outboundAvailable = false;
    await assert.rejects(fetchStationIdentity("cainiao", session, undefined, true), /unavailable/);
    assert.equal(platformSession("cainiao")?.generation, session.generation);
    assert.equal((await fetchStationIdentity("cainiao", session)).value, taobaoCode);
  } finally {
    Object.assign(globalThis, { Crypto: previousCrypto });
  }
});

test("the station identity entry prefers local codes, then the provider app, then inline login", async (t) => {
  const providers = [
    { platform: "cainiao", scheme: "taobao:", page: "/tbopen/index.html",
      expired: { ret: ["FAIL_SYS_SESSION_EXPIRED"] },
      cookie: { ...sessionCookie, name: "cookie2", domain: ".taobao.com", value: "synthetic-taobao-session" } },
    { platform: "pinduoduo", scheme: "pinduoduo:", page: "/mdkd/package",
      expired: { error_code: 40001 }, cookie: sessionCookie },
  ] as const;
  const previousCrypto = globalThis.Crypto;
  Object.assign(globalThis, { Crypto: { ...previousCrypto,
    md5: (data: string) => ({ toHexString: () => createHash("md5").update(data).digest("hex") }),
  } });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 503 }));
  try {
    for (const { platform, scheme, page, expired, cookie } of providers) {
      memory.clear();
      const openApp = t.mock.fn(async (_url: string) => true);
      assert.equal(await stationIdentityDestination(platform, async () => false), "login");
      assert.equal(await stationIdentityDestination(platform, openApp), "app");
      const appURL = new URL(openApp.mock.calls[0].arguments[0]);
      assert.equal(appURL.protocol, scheme);
      assert.equal(appURL.pathname, page);
      if (platform === "cainiao") {
        assert.match(appURL.searchParams.get("h5Url") ?? "", /\/end-collect-platform\/identity-code$/);
      } else {
        assert.equal(appURL.searchParams.get("tab"), "ID_CODE");
      }

      assert.equal(await stationIdentityDestination(platform, async () => {
        savePlatformLogin(platform, "", { kind: "web", cookies: [cookie] }, "synthetic-account");
        return false;
      }), "local");
      const session = platformSession(platform)!;
      assert.equal(await stationIdentityDestination(platform, openApp), "local");
      await assert.rejects(fetchStationIdentity(platform, session), /unavailable/);
      assert.equal(await stationIdentityDestination(platform, openApp), "local");
      assert.equal(openApp.mock.callCount(), 1);

      fetchMock.mock.mockImplementationOnce(async () => new Response(JSON.stringify(expired)));
      await assert.rejects(fetchStationIdentity(platform, session), /expired/);
      assert.equal(accountStatus(platform).state, "expired");
      assert.equal(await stationIdentityDestination(platform, openApp), "app");
      assert.equal(await stationIdentityDestination(platform, async () => { throw new Error("unavailable"); }), "login");
    }
  } finally {
    Object.assign(globalThis, { Crypto: previousCrypto });
  }
});

test("opening a retained detail reads only its CaiNiao parcel and leaves the account clock alone", async (t) => {
  memory.clear();
  let elapsed = 0;
  t.mock.method(Date, "now", () => NOW + elapsed);
  const base = shipment();
  const selected = { ...base, identity: { ...base.identity, sourceProvider: "cainiao" },
    timeline: { ...base.timeline, semantic: "TRANSIT" as const } };
  saveState({ ...emptyState(), shipments: [selected] }, NOW);
  const cookie = { ...sessionCookie, name: "cookie2", domain: ".taobao.com", value: "synthetic-taobao-session" };
  const previousCrypto = globalThis.Crypto;
  Object.assign(globalThis, { Crypto: { ...previousCrypto,
    md5: (data: string) => ({ toHexString: () => createHash("md5").update(data).digest("hex") }),
  } });
  const fetched = t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    assert.equal(url.searchParams.get("api"), "mtop.cainiao.logisticsdetail.packages.pid.orderCode.mailNo.get");
    assert.deepEqual(JSON.parse(url.searchParams.get("data")!), { mailNo: waybill });
    return new Response(JSON.stringify({ ret: ["SUCCESS"], data: { result: [
      { mailNo: "TESTOTHER008", packageItem: [{ itemTitle: "Other parcel" }] },
      { mailNo: waybill, packageItem: [{ itemTitle: "Selected parcel" }],
        packageDyn: { arriveTime: elapsed ? "预计后天送达" : "预计明天送达" },
        goodsList: [{ itemPic: elapsed ? "https://img.alicdn.com/rotated-product.jpg" : "https://img.alicdn.com/synthetic-product.jpg" }] },
    ] } }));
  });
  try {
    const row = visibleShipments(loadState())[0];
    assert.equal(await refreshParcelDetailFields(row, () => true), undefined);
    assert.equal(fetched.mock.callCount(), 0);
    savePlatformLogin("cainiao", "", { kind: "web", cookies: [cookie] }, "synthetic-cainiao-account");
    const priorSync = accountStatus("cainiao").syncedAtMs;
    const update = await refreshParcelDetailFields(row, () => true);
    assert.ok(update);
    assert.deepEqual(displayedPlatformFields(update.shipment, NOW), { title: "Selected parcel", estimate: "预计明天送达" });
    assert.equal(update.shipment.platformFields?.cainiaoImage?.url, "https://img.alicdn.com/synthetic-product.jpg");
    assert.deepEqual(update.shipment.timeline, row.timeline);
    assert.equal(accountStatus("cainiao").syncedAtMs, priorSync);
    assert.equal(fetched.mock.callCount(), 1);
    assert.equal(await refreshParcelDetailFields(update.shipment, () => true), undefined);
    assert.equal(fetched.mock.callCount(), 1, "filling the image does not change the hourly reservation");
    const imageFile = productImageCachePath(cainiaoImageCacheKey(update.shipment));
    const directoryRead = FileManager.readDirectorySync;
    FileManager.readDirectorySync = (path, recursive) => path.endsWith("/product-images") ? [imageFile] : directoryRead?.(path, recursive) ?? [];
    t.after(() => { FileManager.readDirectorySync = directoryRead; });
    elapsed = 3_600_000;
    const second = await refreshParcelDetailFields(update.shipment, () => true);
    assert.ok(second);
    assert.equal(displayedPlatformFields(second.shipment, NOW + elapsed).estimate, "预计后天送达");
    assert.equal(second.shipment.platformFields?.cainiaoImage?.url, update.shipment.platformFields?.cainiaoImage?.url);
    assert.equal(fetched.mock.callCount(), 2);
    assert.equal(accountStatus("cainiao").syncedAtMs, priorSync);
  } finally {
    Object.assign(globalThis, { Crypto: previousCrypto });
  }
});

test("an image-only PDD detail refresh captures the matching product thumbnail", async (t) => {
  memory.clear();
  let elapsed = 0;
  t.mock.method(Date, "now", () => NOW + elapsed);
  savePlatformLogin("pinduoduo", "", { kind: "web", cookies: [sessionCookie] }, "synthetic-pdd-account");
  const session = platformSession("pinduoduo")!;
  const shippingId = "73000919";
  const base = shipment();
  const row = { ...base, pddImport: { ownerKey: session.ownerKey, orderId: order, shippingId },
    platformFields: { waybill, waybillGeneration: 0, title: { source: "pinduoduo" as const, text: "Cached item" } },
    timeline: { ...base.timeline, semantic: "COMPLETED" as const, structuredStatus: true } };
  saveState({ ...emptyState(), shipments: [row] }, NOW);
  const product = "https://img.pddpic.com/mms-material-img/synthetic-item.jpeg";
  const carrier = "https://img.pddpic.com/synthetic-carrier.jpeg";
  const original = globalThis.WebViewController;
  let loads = 0;
  Object.assign(globalThis, { WebViewController: class {
    injected = "";
    sandbox: Record<string, unknown> = {};
    async setCookie() { return true; }
    async addUserScript(options: { source: string }) { this.injected = options.source; return "synthetic-script"; }
    async loadURL(url: string) {
      loads++;
      const location = new URL(url);
      const packet = { shipping_id: shippingId, tracking_number: waybill, express_image_url: carrier };
      this.sandbox = { URL, URLSearchParams, location, document: { body: {}, querySelectorAll: () => [] },
        XMLHttpRequest: class { send() {} },
        fetch: async (address: string) => ({ ok: true, url: address, clone: () => ({
          text: async () => JSON.stringify({ shipping: { ...packet, thumb_url: product } }),
        }) }) };
      this.sandbox.window = this.sandbox;
      this.sandbox.top = this.sandbox;
      runInNewContext(this.injected, this.sandbox);
      const request = location.origin + "/proxy/api/api/express/shipping/track?shipping_id=" + shippingId +
        "&tracking_number=" + waybill;
      await (this.sandbox.fetch as (url: string) => Promise<unknown>)(request);
      await new Promise<void>(resolve => setImmediate(resolve));
      return true;
    }
    async evaluateJavaScript(script: string) {
      elapsed += 2_000;
      return runInNewContext("(function(){" + script + "})()", this.sandbox);
    }
    dispose() {}
  } });
  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  try {
    const result = await refreshParcelDetailFields(visibleShipments(loadState())[0], () => true);
    assert.ok(result);
    assert.equal(pddParcelProductImage(result.shipment), product);
    assert.equal((await refreshParcelDetailFields(result.shipment, () => true)), undefined);
    assert.equal(loads, 1);
  } finally {
    globalThis.WebViewController = original;
    registerProjectionViewportHost(null);
  }
});

test("an empty parcel detail response reserves its waybill and a delayed response cannot write after leaving", async (t) => {
  memory.clear();
  let clock = NOW;
  t.mock.method(Date, "now", () => clock);
  const base = shipment();
  saveState({ ...emptyState(), shipments: [{ ...base, identity: { ...base.identity, sourceProvider: "cainiao" } }] }, NOW);
  const cookie = { ...sessionCookie, name: "cookie2", domain: ".taobao.com", value: "synthetic-taobao-session" };
  savePlatformLogin("cainiao", "", { kind: "web", cookies: [cookie] }, "synthetic-cainiao-account");
  const previousCrypto = globalThis.Crypto;
  Object.assign(globalThis, { Crypto: { ...previousCrypto,
    md5: (data: string) => ({ toHexString: () => createHash("md5").update(data).digest("hex") }),
  } });
  const fetched = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ret: ["SUCCESS"], data: { result: [] } })));
  try {
    const row = visibleShipments(loadState())[0];
    assert.equal(await refreshParcelDetailFields(row, () => true), undefined);
    assert.equal(await refreshParcelDetailFields(row, () => true), undefined);
    assert.equal(fetched.mock.callCount(), 1);
    clock += 3_600_000;
    let visible = true;
    fetched.mock.mockImplementationOnce(async () => {
      visible = false;
      return new Response(JSON.stringify({ ret: ["SUCCESS"], data: { result: { mailNo: waybill, packageItem: [{ itemTitle: "Late" }] } } }));
    });
    assert.equal(await refreshParcelDetailFields(row, () => visible), undefined);
    assert.equal(fetched.mock.callCount(), 2);
    assert.equal(visibleShipments(loadState())[0].platformFields, undefined);
  } finally {
    Object.assign(globalThis, { Crypto: previousCrypto });
  }
});

test("Cainiao publishes the recipient sync time before a distinct sender failure", async (t) => {
  memory.clear();
  t.mock.method(UUID, "string", randomUUID);
  saveState(emptyState());
  setDiagnosticsEnabled(true);
  clearDiagnostics();
  const cookie = { ...sessionCookie, name: "cookie2", value: "synthetic-cainiao-refresh", domain: ".taobao.com" };
  savePlatformLogin("cainiao", "", { kind: "web", cookies: [cookie] }, "synthetic-cainiao-owner", "示例昵称");
  const originalFetch = globalThis.fetch;
  const originalCrypto = globalThis.Crypto;
  Object.assign(globalThis, { Crypto: { ...originalCrypto,
    md5: (data: string) => ({ toHexString: () => createHash("md5").update(data).digest("hex") }),
  } });
  globalThis.fetch = (async (url) => {
    const api = new URL(String(url)).searchParams.get("api");
    if (api?.endsWith("queryPdsPackageDataList")) {
      return new Response(JSON.stringify({ ret: ["SUCCESS"], data: { packages: [] } }));
    }
    assert.ok(api?.endsWith("queryUncompletedOrder"));
    assert.ok(accountStatus("cainiao").syncedAtMs);
    assert.match(platformAccountSubtitle(accountStatus("cainiao")), /^示例昵称 · \d\d:\d\d$/);
    return new Response(JSON.stringify({ ret: ["FAIL_SYS_REQUEST_REJECTED"] }));
  }) as typeof fetch;
  try {
    const result = await refreshPlatformParcels(() => {}, "manual", "cainiao");
    assert.deepEqual(result.issues, [{ platform: "cainiao", reason: "partial" }], JSON.stringify(readDiagnostics()));
    assert.ok(readDiagnostics().some((row) => row.event === "platform.cainiao.sync.failed" &&
      row.details.stage === "cainiao_sender_request"));
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(globalThis, { Crypto: originalCrypto });
    clearPlatformLogin("cainiao", accountStatus("cainiao").generation);
    setDiagnosticsEnabled(false);
  }
});

test("Cainiao sender history reads waiting order codes without requiring an echoed ID or window", async (t) => {
  memory.clear();
  const cookie = { ...sessionCookie, name: "cookie2", value: "synthetic-sender-session", domain: ".taobao.com" };
  savePlatformLogin("cainiao", "", { kind: "web", cookies: [cookie] }, "synthetic-sender-owner");
  const session = platformSession("cainiao")!;
  const originalCrypto = globalThis.Crypto;
  Object.assign(globalThis, { Crypto: { ...originalCrypto,
    md5: (value: string) => ({ toHexString: () => createHash("md5").update(value).digest("hex") }),
  } });
  const ids: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    const api = url.searchParams.get("api");
    const request = JSON.parse(url.searchParams.get("data")!);
    const wrap = (data: object) => new Response(JSON.stringify({ ret: ["SUCCESS"], data: { data } }));
    if (api?.endsWith("queryUncompletedOrder")) {
      assert.equal(request.pageNo, 0);
      assert.equal(request.pageSize, 199);
      return wrap({ orderBriefList: [
        { orderId: "SYNTH-A", orderStatus: 30, carryoutStatus: 20 },
        { orderId: "SYNTH-B", orderStatus: 100, carryoutStatus: 20 },
        { orderId: "SYNTH-C", orderStatus: 30, carryoutStatus: 20 },
        { orderId: "SYNTH-D", orderStatus: 30, carryoutStatus: 20,
          item: { detail: { title: "示例平台 退货 ｜ 不要显示的补充信息" } } },
        { orderId: "SYNTH-E", orderStatus: 30, carryoutStatus: 20,
          title: "寄给 测试用户 的快递" },
      ] });
    }
    assert.ok(api?.endsWith("queryOrderDetail"));
    ids.push(request.tdOrderId);
    if (request.tdOrderId === "SYNTH-C") return wrap({
      pickupCode: "3571", orderInfo: { orderId: "DETAIL-C" }, detail: { title: "寄给【测试用户】的包裹" },
    });
    if (request.tdOrderId === "SYNTH-D" || request.tdOrderId === "SYNTH-E") return wrap({
      pickupCode: request.tdOrderId === "SYNTH-D" ? "6048" : "4316",
      detail: { ttRefundMsg: "淘宝退货 | 详情补充信息" },
    });
    return wrap({ pickupCode: "5629", orderInfo: { orderId: request.tdOrderId, orderStatus: 30, carryOutStatus: 20 },
      detail: { ttRefundMsg: "我退的示例商品", orderSource: 2, channelId: 10004,
      appointmentStart: NOW + 3_600_000, appointmentEnd: NOW + 7_200_000,
    } });
  });
  try {
    const result = await readCainiaoSenderAppointments(session);
    const handoffs = cainiaoHandoffs(result, session.ownerKey, NOW);
    assert.deepEqual(ids, ["SYNTH-A", "SYNTH-C", "SYNTH-D", "SYNTH-E"]);
    assert.equal(result.incomplete, false);
    assert.equal(handoffs.length, 4);
    assert.equal(handoffs[0].code, "5629");
    assert.equal(handoffs[0].windowEndAtMs, NOW + 7_200_000);
    assert.equal(handoffs[0].providerTitle, "淘宝退货");
    assert.equal(handoffs[1].code, "3571");
    assert.equal(handoffs[1].windowEndAtMs, undefined);
    assert.equal(handoffs[1].providerTitle, "寄给【测试用户】的包裹");
    assert.equal(handoffs[2].providerTitle, "示例平台 退货");
    assert.equal(handoffs[3].providerTitle, "寄给 测试用户 的快递");
  } finally {
    Object.assign(globalThis, { Crypto: originalCrypto });
  }
});

test("Cainiao completed history closes the saved appointment and an empty history preserves it", async (t) => {
  memory.clear();
  t.mock.method(Date, "now", () => NOW + 1000);
  const cookie = { ...sessionCookie, name: "cookie2", value: "synthetic-sent-history", domain: ".taobao.com" };
  savePlatformLogin("cainiao", "", { kind: "web", cookies: [cookie] }, "synthetic-sent-owner", "示例用户");
  const session = platformSession("cainiao")!;
  const id = cainiaoHandoffId(session.ownerKey, "SYNTH-ACTIVE");
  saveRecognizedParcelCode({ id, kind: "handoff", platform: "cainiao", code: "4721",
    capturedAtMs: NOW, windowEndAtMs: NOW + 86_400_000 }, NOW);
  const originalCrypto = globalThis.Crypto;
  Object.assign(globalThis, { Crypto: { ...originalCrypto,
    md5: (value: string) => ({ toHexString: () => createHash("md5").update(value).digest("hex") }),
  } });
  let completed = false;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const api = new URL(input).searchParams.get("api");
    const wrap = (data: object) => new Response(JSON.stringify({ ret: ["SUCCESS"], data: { data } }));
    if (api?.endsWith("queryPdsPackageDataList")) return wrap({ packages: [] });
    if (api?.endsWith("queryUncompletedOrder")) return wrap({ orderBriefList: [] });
    assert.ok(api?.endsWith("queryCompletedOrder"));
    return wrap({ orderBriefList: [
      { orderId: "OTHER-APPOINTMENT", orderStatus: 100 },
      { orderId: "SYNTH-ACTIVE", orderStatus: completed ? 100 : -1 },
    ] });
  });
  try {
    await refreshPlatformParcels(() => {}, "manual", "cainiao");
    assert.equal(activePickupCards([], loadState().pickupCodeRecords).length, 1);
    completed = true;
    await refreshPlatformParcels(() => {}, "manual", "cainiao");
    const records = loadState().pickupCodeRecords!;
    assert.deepEqual(records.map(record => [record.id, record.completedAtMs]), [[id, NOW + 1000]]);
    assert.equal(activePickupCards([], records).length, 0);
  } finally {
    Object.assign(globalThis, { Crypto: originalCrypto });
    clearPlatformLogin("cainiao", session.generation);
  }
});

for (const loadCompleted of [true, false]) {
  test(`JD reads authenticated mainland orders with native load completion=${loadCompleted}`, { timeout: 2_500 }, async () => {
    memory.clear();
    const cookie = { ...sessionCookie, name: "pt_key", value: "synthetic-jd-session", domain: ".jd.com" };
    savePlatformLogin("jingdong", "", { kind: "web", cookies: [cookie] }, "synthetic-jd-account");
    let enteredOrders = false;
    let profileLoads = 0;
    let controllers = 0;
    let disposed = 0;
    const title = { textContent: "示例商品" };
    const orderData = { getAttribute: () => JSON.stringify({ orderid: order }) };
    const card = {
      querySelector: (selector: string) => selector.includes("order_item") ? title : null,
      querySelectorAll: (selector: string) => selector.includes("order_state") ? [state]
        : selector.includes("data-eparam") ? [orderData] : [title],
    };
    const state = { parentElement: card, textContent: "待收货" };
    const originalController = globalThis.WebViewController;
    Object.assign(globalThis, { WebViewController: class {
      cookies: Cookie[] = [];
      constructor() { controllers++; }
      async setCookie(value: Cookie) { this.cookies.push(value); return true; }
      async getAllCookies() { return this.cookies; }
      async loadURL(url: string) {
        if (url === "https://my.m.jd.com/index.html?sceneval=2") {
          enteredOrders = false;
          profileLoads++;
          return loadCompleted;
        }
        assert.equal(url, "https://trade.m.jd.com/order/orderlist_jdm.shtml");
        assert.equal(trustedPlatformPage("jingdong", "https://mtrade.jd.hk/order/orderlist_jdm.shtml"), false);
        enteredOrders = true;
        return loadCompleted;
      }
      async evaluateJavaScript(script: string) {
        const window = { top: {} };
        window.top = window;
        const document = {
          // The account page can contain a security settings link alongside the order entry.
          body: { innerText: enteredOrders ? "待收货" : "我的京东 全部订单 账号安全验证" },
          querySelectorAll: () => enteredOrders ? [state] : [],
          querySelector: (selector: string) => !enteredOrders && selector === ".my_header_name"
            ? { textContent: "京东示例昵称" } : null,
        };
        return runInNewContext(`(() => {${script}})()`, {
          window, document, location: new URL(enteredOrders
            ? "https://trade.m.jd.com/order/orderlist_jdm.shtml" : "https://my.m.jd.com/index.html?sceneval=2"),
        });
      }
      dispose() { disposed++; }
    } });
    let loginView: WebViewController | undefined;
    let detachLogin: (() => void) | undefined;
    if (loadCompleted) {
      loginView = new WebViewController({ ephemeral: true });
      await loginView.setCookie(cookie);
      const detached = new Promise<void>((resolve) => { detachLogin = resolve; });
      retainJdLoginView(accountStatus("jingdong").generation, loginView, detached);
    }
    let attached = false;
    registerProjectionViewportHost({ mount: async (view) => {
      if (loginView) assert.equal(view, loginView, "the first sync receives the authenticated login view");
      attached = true;
      return true;
    }, unmount: () => {} });
    try {
      const pending = refreshPlatformParcels(() => {}, "manual", "jingdong");
      if (detachLogin) {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(attached, false, "the sync view is attached only after the login sheet detaches");
        detachLogin();
      }
      const result = await pending;
      assert.equal(result.succeeded, 1);
      assert.deepEqual(result.issues, []);
      assert.equal(enteredOrders, true);
      assert.equal(accountStatus("jingdong").label, "京东示例昵称",
        "the nickname is read from the account page before the mainland order page");
      assert.ok(accountStatus("jingdong").syncedAtMs);
      const next = await refreshPlatformParcels(() => {}, "manual", "jingdong");
      assert.equal(next.succeeded, 1);
      assert.equal(profileLoads, 1, "an established nickname does not require another profile load");
      assert.equal(controllers, 1, "the active account keeps the same isolated JD session across sync rounds");
      assert.equal(disposed, 0);
      clearPlatformLogin("jingdong", accountStatus("jingdong").generation);
      await Promise.resolve();
      assert.equal(disposed, 1, "sign-out releases the isolated browser");
    } finally {
      detachLogin?.();
      globalThis.WebViewController = originalController;
      registerProjectionViewportHost(null);
    }
  });
}

test("JD reads a logistics summary with a past waybill also present in the page text", { timeout: 2_500 }, async () => {
  memory.clear();
  const cookie = { ...sessionCookie, name: "pt_key", value: "synthetic-jd-detail", domain: ".jd.com" };
  savePlatformLogin("jingdong", "", { kind: "web", cookies: [cookie] }, "synthetic-jd-account", "示例昵称");
  const session = platformSession("jingdong")!;
  const parcel = shipment();
  parcel.identity = { ...parcel.identity, manuallyAdded: false, accountOrder: true,
    sourceProvider: "jingdong", orderId: order, projectedWaybill: waybill };
  const original = globalThis.WebViewController;
  let page = new URL("about:blank");
  const card = {
    querySelector: (selector: string) => selector.includes("order_item") ? {} : null,
    querySelectorAll: (selector: string) => selector.includes("order_state") ? [state]
      : selector.includes("data-eparam") ? [{ getAttribute: () => JSON.stringify({ orderid: order }) }] : [],
  };
  const state = { parentElement: card, textContent: "待收货" };
  const summary = { querySelectorAll: (selector: string) => selector.includes("data-copy-cont")
    ? [{ getAttribute: () => waybill }] : [{ textContent: "示例详情商品" }] };
  Object.assign(globalThis, { WebViewController: class {
    cookies: Cookie[] = [];
    async setCookie(value: Cookie) { this.cookies.push(value); return true; }
    async getAllCookies() { return this.cookies; }
    async loadURL(url: string) { page = new URL(url); return true; }
    async evaluateJavaScript(script: string) {
      const window = { top: {} };
      window.top = window;
      const onDetail = page.pathname.endsWith("/deal_wuliu_jdm.shtml");
      const document = {
        body: { innerText: onDetail ? `运单号：${waybill}\n曾用运单号：YT000099999999` : "待收货" },
        querySelector: (selector: string) => onDetail && selector.includes("Summary-module") ? summary : null,
        querySelectorAll: () => onDetail ? [] : [state],
      };
      return runInNewContext(`(() => {${script}})()`, { window, document, location: page, URLSearchParams });
    }
    dispose() {}
  } });
  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  try {
    const result = await fetchJdParcels(session, [parcel], () => {});
    assert.deepEqual(result.parcels, [{ source: "jingdong", waybill, title: "示例详情商品", code: "" }]);
  } finally {
    clearPlatformLogin("jingdong", session.generation);
    globalThis.WebViewController = original;
    registerProjectionViewportHost(null);
  }
});

test("a rejected JD cookie restore records the failed session stage during a manual sync", async (t) => {
  t.mock.method(UUID, "string", randomUUID);
  memory.clear();
  setDiagnosticsEnabled(true);
  clearDiagnostics();
  const cookie = { ...sessionCookie, name: "pt_key", value: "synthetic-jd-restore", domain: ".jd.com" };
  savePlatformLogin("jingdong", "", { kind: "web", cookies: [cookie] }, "synthetic-jd-account");
  let openedPage = false;
  let disposed = false;
  const originalController = globalThis.WebViewController;
  Object.assign(globalThis, { WebViewController: class {
    async setCookie() { return false; }
    async getAllCookies() { return []; }
    async loadURL() { openedPage = true; return true; }
    dispose() { disposed = true; }
  } });
  try {
    const result = await refreshPlatformParcels(() => {}, "manual", "jingdong");
    assert.deepEqual(result.issues, [{ platform: "jingdong", reason: "failed" }]);
    assert.equal(openedPage, false);
    assert.equal(disposed, true);
    assert.equal(accountStatus("jingdong").state, "active");
    const note = readDiagnostics().find(({ event }) => event === "platform.jingdong.sync.failed");
    assert.equal(note?.details.stage, "jd_sync_session");
    assert.equal(note?.details.result, "unavailable");
    assert.doesNotMatch(JSON.stringify(note), /synthetic-jd-restore/);
  } finally {
    globalThis.WebViewController = originalController;
    setDiagnosticsEnabled(false);
  }
});

test("a rejected native JD load is distinguishable from an unreadable order list", async (t) => {
  t.mock.method(UUID, "string", randomUUID);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  memory.clear();
  setDiagnosticsEnabled(true);
  clearDiagnostics();
  const cookie = { ...sessionCookie, name: "pt_key", value: "synthetic-jd-navigation", domain: ".jd.com" };
  savePlatformLogin("jingdong", "", { kind: "web", cookies: [cookie] }, "synthetic-jd-account");
  const originalController = globalThis.WebViewController;
  Object.assign(globalThis, { WebViewController: class {
    async setCookie() { return true; }
    async getAllCookies() { return [cookie]; }
    async loadURL() { return false; }
    async evaluateJavaScript(script: string) {
      if (script.startsWith("window.__pipiDeliveriesPreviousJDPage = true")) return true;
      await Promise.resolve();
      now += 12_001;
      return null;
    }
    dispose() {}
  } });
  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  try {
    const result = await refreshPlatformParcels(() => {}, "manual", "jingdong");
    assert.equal(result.failed, 1);
    const note = readDiagnostics().find(({ event }) => event === "platform.jingdong.sync.failed");
    assert.equal(note?.details.stage, "jd_sync_load_failed");
  } finally {
    clearPlatformLogin("jingdong", accountStatus("jingdong").generation);
    registerProjectionViewportHost(null);
    globalThis.WebViewController = originalController;
    setDiagnosticsEnabled(false);
  }
});

test("an unexpected JD document reports its origin and native load outcome without URL contents", async (t) => {
  t.mock.method(UUID, "string", randomUUID);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  memory.clear();
  setDiagnosticsEnabled(true);
  clearDiagnostics();
  const cookie = { ...sessionCookie, name: "pt_key", value: "synthetic-jd-navigation", domain: ".jd.com" };
  const renewed = { ...cookie, value: "synthetic-jd-renewed-during-navigation" };
  savePlatformLogin("jingdong", "", { kind: "web", cookies: [cookie] }, "synthetic-jd-account");
  const originalController = globalThis.WebViewController;
  const window: { top?: object } = {};
  window.top = window;
  let location = new URL("https://gias.jd.com/synthetic-path?token=synthetic-query#synthetic-fragment");
  Object.assign(globalThis, { WebViewController: class {
    private cookies: Cookie[] = [];
    async setCookie(value: Cookie) { this.cookies.push(value); return true; }
    async getAllCookies() { return this.cookies; }
    async loadURL() { this.cookies = [renewed]; return false; }
    async evaluateJavaScript(script: string) {
      if (script.startsWith("window.__pipiDeliveriesPreviousJDPage = true")) return true;
      setImmediate(() => { now += 12_001; });
      return runInNewContext(`(() => { ${script} })()`, { window, location });
    }
    dispose() {}
  } });
  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  try {
    // D11 (owner 2026-11-21 「三项都改（推荐）」): the page is a closed kind, never a host name.
    for (const [address, expectedPage] of [
      [location.href, "jd_other"],
      ["https://synthetic-host.example/synthetic-path", "web_other"],
      ["applewebdata://synthetic-page/synthetic-path", "local_page"],
    ]) {
      clearDiagnostics();
      location = new URL(address);
      const result = await refreshPlatformParcels(() => {}, "manual", "jingdong");
      assert.equal(result.failed, 1);
      const note = readDiagnostics().find(({ event }) => event === "platform.jingdong.sync.failed");
      assert.equal(note?.details.stage, "jd_sync_unexpected_page");
      assert.equal(note?.details.jdPage, expectedPage);
      assert.equal(note?.details.jdNativeLoad, "returned_false");
      assert.doesNotMatch(JSON.stringify(note), /synthetic-/);
      assert.equal(accountStatus("jingdong").state, "active");
    }
    const saved = platformSession("jingdong")?.credentials;
    assert.equal(saved?.kind, "web");
    if (saved?.kind !== "web") throw new Error("Missing saved JD account");
    const reopened = await openProviderController("jingdong", saved.cookies);
    try {
      assert.equal((await reopened.getAllCookies()).find(({ name }) => name === "pt_key")?.value, renewed.value);
    } finally {
      reopened.dispose();
    }
    location = new URL("https://plogin.m.jd.com/login/login?token=synthetic-query");
    clearDiagnostics();
    const expired = await refreshPlatformParcels(() => {}, "manual", "jingdong");
    assert.deepEqual(expired.issues, [{ platform: "jingdong", reason: "expired" }]);
    assert.equal(platformSession("jingdong"), null);
    const note = readDiagnostics().find(({ event }) => event === "platform.jingdong.sync.failed");
    assert.equal(note?.details.jdPage, "jd_login");
    assert.doesNotMatch(JSON.stringify(note), /synthetic-/);
  } finally {
    clearPlatformLogin("jingdong", accountStatus("jingdong").generation);
    registerProjectionViewportHost(null);
    globalThis.WebViewController = originalController;
    setDiagnosticsEnabled(false);
  }
});

test("PDD waiting pickup sync survives an unavailable order-capture host", async (t) => {
  t.mock.method(Date, "now", () => NOW + 2);
  memory.clear();
  saveState({ ...emptyState(), shipments: [shipment()] }, NOW);
  savePlatformLogin("pinduoduo", "", { kind: "web", cookies: [sessionCookie] }, "synthetic-account");
  const originalFetch = globalThis.fetch;
  const originalController = globalThis.WebViewController;
  Object.assign(globalThis, { WebViewController: class {
    async setCookie() { return true; }
    dispose() {}
  } });
  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  let stationRequests = 0;
  globalThis.fetch = (async (url: string) => {
    assert.equal(url, "https://api.pinduoduo.com/api/express_trackbox/station/package");
    stationRequests++;
    return new Response(JSON.stringify({ result: { combine_list: [{
      company_name: "示例多多驿站", combine_track_list: [{ tracking_number: waybill, pick_code: "5112" }],
    }] } }));
  }) as typeof fetch;
  try {
    const progress: string[] = [];
    const result = await refreshPlatformParcels(() => {}, "manual", "pinduoduo",
      (source, running) => progress.push(`${source}:${running}`));
    assert.equal(stationRequests, 1);
    assert.equal(loadState().shipments[0].pickup?.code, "5112");
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 1);
    assert.deepEqual(progress, ["pinduoduo:true", "pinduoduo:false"]);
    assert.equal(platformRefreshMessage(result), "部分同步完成 · 拼多多同步未完成，请稍后重试");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebViewController = originalController;
    registerProjectionViewportHost(null);
  }
});

test("PDD checks a batch of known orders without decoding the full store per waybill", async (t) => {
  t.mock.method(Date, "now", () => NOW + 2_000);
  memory.clear();
  const orders = Array.from({ length: 30 }, (_, index) => ({
    waybill: `YT900000000${String(index).padStart(3, "0")}`, orderId: String(8_800_000 + index),
  }));
  const shipments = orders.map(({ waybill }, index) => {
    const row = shipment();
    return shipment({
      identity: { ...row.identity, id: `synthetic-order-${index}`, sourceId: waybill },
      timeline: { ...row.timeline, waybill, semantic: "TRANSIT", latestDetail: "运输中",
        tracks: row.timeline.tracks.map(track => ({ ...track, detail: "运输中" })) },
    });
  });
  const seeded = saveState({ ...emptyState(), shipments }, NOW);
  assert.equal(savePlatformLogin("pinduoduo", "", { kind: "web", cookies: [sessionCookie] }, "synthetic-account"), true);
  const parse = JSON.parse;
  const baseline = parse(String(memory.get("pipi_deliveries_state_v1"))).payload;
  let decodes = 0, networkCalls = 0;
  const originalController = globalThis.WebViewController, originalFetch = globalThis.fetch;
  Object.assign(globalThis, { WebViewController: class {
    async setCookie() { return true; }
    async addUserScript() { return "synthetic-script"; }
    async loadURL() { return true; }
    async evaluateJavaScript() { return orders; }
    dispose() {}
  } });
  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  globalThis.fetch = (async () => { networkCalls++; throw new Error("Unexpected request for known orders"); }) as typeof fetch;
  JSON.parse = (value, reviver) => {
    if (value === baseline) decodes++;
    return parse(value, reviver);
  };
  try {
    const result = await refreshPlatformParcels(() => {}, "observe", "pinduoduo");
    assert.equal(result.failed, 0);
    assert.equal(result.succeeded, 1);
    assert.equal(result.added, 0);
    assert.equal(networkCalls, 0);
    assert.ok(decodes <= 4, `a batch used ${decodes} full decodes for ${orders.length} existing waybills`);
    assert.equal(loadState().shipments.length, seeded.shipments.length);
  } finally {
    JSON.parse = parse;
    globalThis.fetch = originalFetch;
    globalThis.WebViewController = originalController;
    registerProjectionViewportHost(null);
  }
});

test("PDD reads station data for a parcel that becomes eligible during order capture", async (t) => {
  t.mock.method(Date, "now", () => NOW + 2_000);
  memory.clear();
  const original = saveState({ ...emptyState(), shipments: [shipment({
    timeline: { ...shipment().timeline, semantic: "TRANSIT" },
  })] }, NOW);
  savePlatformLogin("pinduoduo", "", { kind: "web", cookies: [sessionCookie] }, "synthetic-account");
  const originalFetch = globalThis.fetch;
  const originalController = globalThis.WebViewController;
  Object.assign(globalThis, { WebViewController: class {
    async setCookie() { return true; }
    async addUserScript() { return "synthetic-script"; }
    async loadURL() {
      saveState({ ...original, shipments: [shipment()] }, NOW + 1_000);
      return true;
    }
    async evaluateJavaScript() { return []; }
    dispose() {}
  } });
  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  let stationRequests = 0;
  globalThis.fetch = (async (url: string) => {
    assert.equal(url, "https://api.pinduoduo.com/api/express_trackbox/station/package");
    stationRequests++;
    return new Response(JSON.stringify({ result: { combine_list: [{
      combine_track_list: [{ tracking_number: waybill, pick_code: "5112" }],
    }] } }));
  }) as typeof fetch;
  try {
    const result = await refreshPlatformParcels(() => {}, "observe", "pinduoduo");
    assert.equal(stationRequests, 1);
    assert.equal(loadState().shipments[0].pickup?.code, "5112");
    assert.equal(result.failed, 0);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebViewController = originalController;
    registerProjectionViewportHost(null);
  }
});

function sampleCabinet(): CabinetParcel {
  return cabinetParcels({ cabinets: [{
    cabinetCode: "TEST-01", cabinetName: "测试丰巢柜", address: "测试路 1 号",
    boxes: [{ boxId: "TEST-02", location: "右侧", packages: [{ code: "9246", expressId: waybill, postId: "TEST-03" }] }],
  }] }, "13000000000")[0];
}

test("cabinet opening requires a live association after confirmation and submits one request", async (t) => {
  t.mock.method(Date, "now", () => NOW + 2);
  memory.clear();
  const seed = saveState({ ...emptyState(), shipments: [shipment()] }, NOW);
  const parcel = sampleCabinet();
  const credentials = { kind: "cabinet", token: "fixture", flag: "", userAuth: "", mobile: "13000000000", clientIp: "" } as const;
  savePlatformLogin("fengchao", "", credentials, credentials.mobile);
  const session = platformSession("fengchao")!;
  const committed = savePlatformParcelData({ observed: seed, owner: session.ownerKey, current: () => true,
    parcels: [], cabinets: [parcel] }, NOW + 1);
  assert.equal(committed.state.shipments[0].pickup?.code, "9246");
  notePlatformSync("fengchao", session.generation, NOW + 1, { cabinetLinks: committed.cabinetLinks });
  const [card] = activePickupCards(visibleShipments(committed.state), committed.state.pickupCodeRecords);
  const readAccount = t.mock.method(Keychain, "get", Keychain.get);
  assert.deepEqual([...pickupCabinetActions([card, { ...card, code: "123456" }])], [card]);
  assert.equal(readAccount.mock.callCount(), 1, "pickup rendering reads one session for multiple cabinet cards");
  let calls = 0;
  let allow!: (selected: boolean) => void;
  Object.assign(globalThis, { Dialog: { confirm: () => new Promise((resolve) => { allow = resolve; }) } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    assert.equal(url, "https://consumer.fcbox.com/post/clientGet/openBox");
    assert.equal(options.method, "POST");
    calls++;
    return new Response('{"code":0,"success":true}');
  }) as typeof fetch;
  try {
    const first = performPickupAction(card, true, () => {});
    assert.match(await performPickupAction(card, true, () => {}), /正在请求开柜/);
    allow(false);
    assert.equal(await first, "");
    const confirmed = performPickupAction(card, true, () => {});
    allow(true);
    assert.match(await confirmed, /柜门已开启/);
    assert.equal(calls, 1);
    assert.equal(loadState().shipments[0].forcedCompletedAtMs, undefined);
    const stale = performPickupAction(card, true, () => {});
    clearPlatformLogin("fengchao", session.generation);
    allow(true);
    assert.match(await stale, /状态已变更/);
    assert.equal(calls, 1);
    assert.equal(pickupCabinetActions([card]).size, 0);
  } finally { globalThis.fetch = realFetch; }
});

test("Fengchao challenge uses a real PKCS#1 v1.5 encoded block with random nonzero padding", () => {
  const previousCrypto = globalThis.Crypto;
  const previousData = globalThis.Data;
  function makeData(buffer: Buffer) {
    return {
      toArrayBuffer: () => Uint8Array.from(buffer).buffer,
      toBase64String: () => buffer.toString("base64"),
    };
  }
  Object.assign(globalThis, {
    Data: { fromRawString: (text: string) => makeData(Buffer.from(text)),
      fromBase64String: (value: string) => makeData(Buffer.from(value, "base64")),
      fromUint8Array: (value: Uint8Array) => makeData(Buffer.from(value)),
    },
    Crypto: {
      md5: (value: string) => createHash("md5").update(value),
      generateSymmetricKey: (size: number) => makeData(randomBytes(size / 8)),
    },
  });
  try {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const plain = "synthetic challenge message";
    const encrypted = Buffer.from(encryptFengchaoChallenge(plain, spki), "base64");
    const block = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, encrypted);
    assert.deepEqual([...block.subarray(0, 2)], [0, 2]);
    const delimiter = block.indexOf(0, 2);
    assert.ok(delimiter >= 10);
    assert.equal(block.subarray(delimiter + 1).toString(), plain);
  } finally { Object.assign(globalThis, { Crypto: previousCrypto, Data: previousData }); }
});
