import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment } from "../models";
import { EXPRESS_TOAST_COPY } from "../services/express-toast-copy";
import { emptyState, isStoredShipmentRetained, loadState, removeShipment, saveState, setShipmentNote, upsertShipment } from "../services/storage";
import { absorbAutomaticShipment, applyAccountShipment, applyManualShipment, applyTargetedAccountShipment } from "../services/shipment-policy";
import { cachedProductImage, productImageCacheKey, pruneProductImages, rememberProductImage } from "../services/product-image-cache";
import { shipmentLifecycleKey } from "../services/shipment-lifecycle";
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
const action = stripTypeScriptTypes(page.slice(page.indexOf("async function editNote()"), page.indexOf("const [loadingManualDetail")));
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
      isStoredShipmentRetained, loadState, sharedData, withSharedFileTransaction,
    });
    const image = { syntheticImage: true } as unknown as UIImage;
    rememberProductImage(key, image, isRetained);
    assert.equal(cachedProductImage(key), image);
    let submit!: (value: string) => void;
    let published = false, notice = "";
    const edit = Function("scope", `with(scope) { ${action}; return editNote; }`)({
      EXPRESS_TOAST_COPY, shipment: original, Dialog: { prompt: () => new Promise<string>(resolve => { submit = resolve; }) }, setShipmentNote,
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
      assert.equal(published, false, `${change} does not report a successful edit`);
      assert.ok(notice, `${change} remains a recoverable page action`);
      assert.equal(cachedProductImage(key), null, `${change} invalidates the original thumbnail owner`);
    } else {
      assert.equal(current?.note, "Draft from the open dialog", `${change} preserves same-lifecycle editing`);
      assert.equal(published, true);
      assert.equal(notice, EXPRESS_TOAST_COPY.userNoteSaved);
      assert.equal(cachedProductImage(key), image, `${change} keeps the original thumbnail owner`);
    }
  }
  for (const draft of [null, ""] as const) {
    memory.clear();
    const original = saveState({ ...emptyState(), shipments: [{ ...row(), note: "Existing note" }] }, NOW).shipments[0];
    const notices: string[] = [];
    const edit = Function("scope", `with(scope) { ${action}; return editNote; }`)({
      EXPRESS_TOAST_COPY, shipment: original, Dialog: { prompt: async () => draft }, setShipmentNote,
      setShipment() {}, props: {}, requestWidgetReload() {},
      setNotice: (value: string) => notices.push(value), writeDiagnostic() {}, diagnosticErrorDetails: () => ({}),
    });
    await edit();
    assert.deepEqual(notices, draft == null ? [] : [EXPRESS_TOAST_COPY.userNoteDeleted]);
    assert.equal(loadState().shipments[0]?.note, draft == null ? "Existing note" : undefined);
  }
} finally { Date.now = clock; }
console.log("shipment note lifecycle: stale dialog/image rejection and ordinary merge, first ownership, absorption and projection preservation passed");
