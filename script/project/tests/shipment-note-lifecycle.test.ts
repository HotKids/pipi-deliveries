import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment } from "../models";
import { emptyState, isStoredShipmentRetained, loadState, readAppStateSnapshot, removeShipment, saveState, setShipmentNote, setShipmentProductName, upsertShipment } from "../services/storage";
import { displayedPlatformFields, enrichPlatformParcel } from "../services/platform-parcel-merge";
import { absorbAutomaticShipment, applyAccountShipment, applyManualShipment, applyTargetedAccountShipment } from "../services/shipment-policy";
import { cachedProductImage, productImageCacheKey, pruneProductImages, rememberProductImage } from "../services/product-image-cache";
import { ShipmentLifecycleChangedError, shipmentLifecycleKey } from "../services/shipment-lifecycle";
import { sharedData, withSharedFileTransaction } from "../services/shared-file-transaction";

const clock = Date.now;
Date.now = () => NOW + 100;
function row(): Shipment {
  return { identity: { id: "interface5:account:synthetic-note", bindingSource: "interface5", sourceId: "synthetic-note",
    sourceOwner: "account", sourceProvider: "JingDong", phone: "13800000000", phoneTail: "0000", orderId: "synthetic-note", accountOrder: true,
    manuallyAdded: false, courierCode: "JDKD", rawCourierCode: "JDKD", companyName: "JD Shopping", createdAtMs: NOW - 1000 },
    timeline: { provider: "interface5", waybill: "synthetic-note", courierCode: "JDKD", companyName: "JD Shopping",
      semantic: "ORDERED", latestTimeText: String(NOW), latestDetail: "Ordered", successAtMs: NOW,
      tracks: [{ timeText: String(NOW), timeMs: NOW, detail: "Ordered", statusCode: "101", raw: {} }] }, updatedAtMs: NOW };
}
const page = readFileSync(new URL("../pages/DetailPage.tsx", import.meta.url), "utf8");
const action = stripTypeScriptTypes(page.slice(page.indexOf("async function editProductName()"), page.indexOf("const [loadingManualDetail")));
const noteAction = stripTypeScriptTypes(page.slice(page.indexOf("async function editNote()"), page.indexOf("async function editProductName()")));
const thumbnail = readFileSync(new URL("../components/ProductThumbnail.tsx", import.meta.url), "utf8");
const ownerSource = stripTypeScriptTypes(thumbnail.slice(thumbnail.indexOf("  const lifecycle ="), thumbnail.indexOf("  const [loaded,")));
try {
  for (const change of ["reimport", "reuse", "delete", "refresh", "projection", "manual-refresh", "first-owner", "absorption"] as const) {
    memory.clear();
    pruneProductImages([], [], NOW);
    let initial = row();
    if (change === "manual-refresh") {
      initial.identity = { ...initial.identity, id: "interface5:manual:JD0000000000001", sourceId: "JD0000000000001",
        accountOrder: false, manuallyAdded: true, orderId: undefined, sourceProvider: "", courierCode: "JD" };
      initial.timeline = { ...initial.timeline, provider: "v6_query", waybill: "JD0000000000001", courierCode: "JD" };
    }
    if (change === "first-owner" || change === "absorption") {
      if (change === "first-owner") initial.identity.rawCourierCode = "";
      initial = applyAccountShipment(undefined, initial, NOW, "interface5");
      assert.equal(initial.automaticOwnership?.ownerSource, change === "first-owner" ? null : "interface5");
    }
    const original = saveState({ ...emptyState(), shipments: [initial] }, NOW).shipments[0];
    const key = productImageCacheKey(original.identity);
    const isRetained = Function("scope", `with(scope) { ${ownerSource}; return isRetained; }`)({
      props: { shipment: original }, cacheKey: key, shipmentLifecycleKey, productImageCacheKey,
      isStoredShipmentRetained, readAppStateSnapshot, sharedData, withSharedFileTransaction,
    });
    const image = { syntheticImage: true } as unknown as UIImage;
    rememberProductImage(key, image, isRetained);
    assert.equal(cachedProductImage(key), image);
    let submit!: (value: string) => void;
    let published = false, notice = "";
    const edit = Function("scope", `with(scope) { ${action}; return editProductName; }`)({
      platformFields: displayedPlatformFields(original), ShipmentLifecycleChangedError, shipment: original,
      Dialog: { prompt: () => new Promise<string>(resolve => { submit = resolve; }) }, setShipmentProductName,
      setShipment: () => { published = true; }, props: {}, requestWidgetReload() {},
      setNotice: (value: string) => { notice = value; }, writeDiagnostic() {}, diagnosticErrorDetails: () => ({}),
    });
    const pending = edit();
    if (change === "delete" || change === "reimport") {
      removeShipment(original.identity.id, NOW + 1);
      if (change === "reimport") saveState({ ...emptyState(), shipments: [{ ...original,
        identity: { ...original.identity, createdAtMs: NOW + 2 }, note: "Replacement note" }] }, NOW + 2);
    } else if (change === "reuse") {
      saveState({ ...loadState(), shipments: [{ ...original, waybillReuseAtMs: NOW + 2, note: "Replacement note" }] }, NOW + 2);
    } else {
      const incoming = { ...original, identity: { ...original.identity, createdAtMs: NOW + 3, rawCourierCode: "JDKD",
        ...(change === "projection" ? { projectedWaybill: "JD0000000000001", courierCode: "JD" } : {}) },
        timeline: { ...original.timeline, latestDetail: "Refreshed", successAtMs: NOW + 3 }, updatedAtMs: NOW + 3 };
      const refreshed = change === "manual-refresh"
        ? applyManualShipment(original, incoming, NOW + 3)
        : change === "first-owner"
        ? applyAccountShipment(original, incoming, NOW + 3, "interface5")
        : change === "absorption"
        ? absorbAutomaticShipment(original,
          applyAccountShipment(undefined, { ...incoming, automaticOwnership: undefined }, NOW + 3, "interface5"), NOW + 3)
        : applyTargetedAccountShipment(original, incoming, NOW + 3);
      assert.equal(refreshed.identity.createdAtMs, original.identity.createdAtMs,
        "the real merge path preserves the lifecycle while rebuilding a fresh account snapshot");
      if (change === "first-owner") assert.equal(refreshed.automaticOwnership?.ownerSource, "interface5");
      if (change === "projection") {
        assert.equal(refreshed.identity.projectedWaybill, "JD0000000000001");
        assert.equal(refreshed.identity.id, original.identity.id);
      }
      upsertShipment(refreshed, NOW + 3);
    }
    submit("Draft from the open dialog");
    await pending;
    const current = loadState().shipments.find(item => item.identity.id === original.identity.id);
    if (["delete", "reimport", "reuse"].includes(change)) {
      assert.equal(current?.note, change === "delete" ? undefined : "Replacement note", `${change} rejects the stale dialog draft`);
      assert.equal(current?.platformFields?.manualTitle, undefined);
      assert.equal(published, false, `${change} does not report a successful edit`);
      assert.equal(notice, "快递已更新，请重新打开后编辑", `${change} asks to reopen the changed parcel instead of retrying the stale dialog`);
      assert.equal(cachedProductImage(key), null, `${change} invalidates the original thumbnail owner`);
    } else {
      assert.equal(current?.platformFields?.manualTitle, "Draft from the open dialog", `${change} preserves same-lifecycle editing`);
      assert.equal(published, true);
      assert.equal(notice, "商品名已更新");
      assert.equal(cachedProductImage(key), image, `${change} keeps the original thumbnail owner`);
    }
  }
  for (const draft of [null, ""] as const) {
    memory.clear();
    const previous = {
      ...row(),
      note: "Existing note",
      platformFields: { waybill: "", waybillGeneration: 0, manualTitle: "Existing product name",
        title: { text: "Original provider title", source: "jingdong" as const } },
    };
    const original = saveState({ ...emptyState(), shipments: [previous] }, NOW).shipments[0];
    const observation = enrichPlatformParcel(original, { source: "jingdong", waybill: "", title: "New provider title" }, NOW + 1);
    assert.equal(displayedPlatformFields(observation).title, "Existing product name");
    upsertShipment(observation, NOW + 1);
    const notices: string[] = [];
    const edit = Function("scope", `with(scope) { ${action}; return editProductName; }`)({
      platformFields: displayedPlatformFields(original), ShipmentLifecycleChangedError, shipment: original,
      Dialog: { prompt: async () => draft }, setShipmentProductName,
      setShipment() {}, props: {}, requestWidgetReload() {},
      setNotice: (value: string) => notices.push(value), writeDiagnostic() {}, diagnosticErrorDetails: () => ({}),
    });
    await edit();
    assert.deepEqual(notices, draft == null ? [] : ["商品名已更新"]);
    const current = loadState().shipments[0];
    assert.equal(current?.note, "Existing note");
    assert.equal(displayedPlatformFields(current).title, draft == null ? "Existing product name" : "New provider title");
  }
  memory.clear();
  const original = enrichPlatformParcel(row(), { source: "jingdong", waybill: "", title: "Provider title" }, NOW);
  const initial = saveState({ ...emptyState(), shipments: [original] }, NOW);
  const saved = setShipmentProductName(initial.shipments[0], "Manual title", NOW + 1);
  assert.equal(displayedPlatformFields(saveState(initial, NOW + 2).shipments[0]).title, "Manual title");
  const editNote = Function("scope", `with(scope) { ${noteAction}; return editNote; }`)({
    ShipmentLifecycleChangedError, shipment: saved.shipments[0], props: { persistedShipment: true },
    Dialog: { prompt: async () => "Parcel note" }, setShipmentNote, setShipment() {},
    requestWidgetReload() {}, setNotice() {}, writeDiagnostic() {}, diagnosticErrorDetails: () => ({}),
  });
  await editNote();
  assert.equal(loadState().shipments[0].note, "Parcel note");
  assert.equal(displayedPlatformFields(loadState().shipments[0]).title, "Manual title");
  setShipmentProductName(saved.shipments[0], "", NOW + 3);
  assert.equal(displayedPlatformFields(saveState(saved, NOW + 4).shipments[0]).title, "Provider title");
} finally { Date.now = clock; }
console.log("parcel editor lifecycle: stale dialog rejection, provider title priority and thumbnail ownership passed");
