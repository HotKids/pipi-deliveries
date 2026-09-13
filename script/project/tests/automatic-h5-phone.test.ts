import assert from "node:assert/strict";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment, TimelinePackage } from "../models";
import { emptyState, saveState } from "../services/storage";
import { diagnosticText, setDiagnosticsEnabled } from "../services/logger";
import { runShipmentRefreshForTesting } from "../services/sync";
import { primaryH5Route } from "../services/jt-h5";

const WAYBILL = "JT000000000001", PHONE = "13800005678";
const source: TimelinePackage = { provider: "interface5", waybill: WAYBILL,
  courierCode: "HTKY", companyName: "Synthetic carrier", semantic: "TRANSIT",
  structuredStatus: true, statusEventAtMs: NOW - 60_000, latestTimeText: "2026-09-08 13:59:00",
  latestDetail: "Synthetic account event", tracks: [], successAtMs: NOW };
const actualNow = Date.now;
Date.now = () => NOW;
try {
  for (const explicit of ["", "invalid", "1234"]) {
    memory.clear(); setDiagnosticsEnabled(true);
    const row: Shipment = { identity: { id: `interface5:account:${WAYBILL}`, sourceId: WAYBILL,
      bindingSource: "interface5", sourceOwner: "interface5", sourceProvider: "ShunFeng",
      courierCode: "HTKY", companyName: "Synthetic carrier", phone: PHONE,
      phoneTail: explicit, manuallyAdded: false, createdAtMs: NOW - 86400000 },
      timeline: source, sourceTimeline: source, manualTimelines: [], updatedAtMs: NOW };
    saveState({ ...emptyState(), shipments: [row], bindings: [
      { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 },
    ] }, NOW);
    let challenged = true;
    const submitted: string[] = [];
    const input = { value: "", getClientRects: () => [1], dispatchEvent() {
      submitted.push(this.value); challenged = false;
    } };
    const pageState = {};
    const document = { readyState: "complete", querySelector(selector: string) {
      if (selector === ".query-popup input.uni-input-input") return challenged ? input : null;
      if (selector === ".scft-left .cgsllt-right") return { textContent: WAYBILL };
      return null;
    }, querySelectorAll(selector: string) {
      if (selector !== ".scd-route .scdr-list") return [];
      return ["2026-09-08 13:00:00", "2026-09-08 12:00:00"].map((time) => ({
        querySelector(child: string) {
          if (child === ".scdrl-left") return { textContent: "已揽件" };
          if (child === ".scdrlr-time") return { textContent: time };
          if (child === ".scdrl-right") return { children: [{ textContent: "Synthetic carrier event",
            classList: { contains: () => false } }] };
          return null;
        },
      }));
    } };
    Object.assign(globalThis, { WebViewController: class {
      async loadURL(url: string) { assert.equal(url, primaryH5Route(WAYBILL, "HTKY")); return true; }
      async evaluateJavaScript(script: string) {
        return new Function("window", "document", "location", "Event", script)(
          pageState, document, new URL(primaryH5Route(WAYBILL, "HTKY")), class {});
      }
      dispose() {}
    } });
    const result = await runShipmentRefreshForTesting(row.identity.id,
      { isCurrent: () => true, deadlineAtMs: NOW + 30_000 },
      { trigger: "detail_pull", forceManualRefresh: true }, {
        refreshAccountParcel: async () => { assert.fail("SF pull cannot query the account"); },
        queryManualForSource: async () => ({ shipment: null, pending: null, routeUrl: "" }),
      });
    assert.deepEqual(submitted, [explicit === "1234" ? explicit : "5678"],
      "eligible automatic H5 uses a valid explicit suffix exclusively, otherwise client bindings");
    assert.equal(result.shipment.identity.phone, PHONE);
    assert.ok(result.shipment.manualTimelines?.some(pack => pack.provider === "jt_h5"));
    assert.equal(diagnosticText().includes(PHONE), false);
    assert.equal(diagnosticText().includes("5678"), false);
  }
} finally { Date.now = actualNow; }
console.log("automatic H5 bound-phone candidate tests passed");
