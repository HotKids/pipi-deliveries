import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import type { Shipment, TimelinePackage } from "../models";
import * as policy from "../services/shipment-policy";
import * as status from "../services/status";
import { primaryH5Provider } from "../services/jt-h5";
import { runManualDetailSourceContest } from "../services/manual-detail-refresh";

const NOW = Date.UTC(2026, 8, 8, 10);
function timeline(provider: string, detail = "快件运输中", offset = 0): TimelinePackage {
  return { provider, complete: false, waybill: "SYNTHETIC123456", courierCode: "ZTO",
    companyName: "Test carrier", semantic: "TRANSIT", statusEventAtMs: NOW + offset,
    latestTimeText: "2026-09-08 10:00:00", latestDetail: detail, successAtMs: NOW,
    tracks: [{ timeText: "2026-09-08 10:00:00", timeMs: NOW + offset,
      detail, statusCode: "", raw: {} }] };
}
function shipment(kind = "manual", detail = "快件运输中"): Shipment {
  const owner = kind === "manual" ? null : timeline("interface5", detail);
  const selected = owner || timeline("v6_query", detail);
  return { identity: { id: "synthetic-parcel", bindingSource: "interface5",
    sourceOwner: kind === "manual" ? "manual" : "account", sourceId: "SYNTHETIC123456",
    sourceProvider: kind === "sf" ? "ShunFeng" : "DouYin", phoneTail: "1234",
    courierCode: "ZTO", rawCourierCode: "ZTO", companyName: "Test carrier",
    manuallyAdded: kind === "manual", createdAtMs: NOW }, timeline: selected,
    sourceTimeline: owner, manualTimelines: owner ? [] : [selected], updatedAtMs: NOW };
}

import { memory } from "./state-storage-mock";
import { emptyState, saveState } from "../services/storage";
import { runShipmentRefreshForTesting } from "../services/sync";
const realNow = Date.now;
Date.now = () => NOW;
try {
  for (const origin of [null, "订单已提交", "快件运输中"]) {
    memory.clear();
    const seed = saveState({ ...emptyState(), shipments: [shipment()] }, NOW).shipments[0]!;
    const calls: string[] = [];
    await runShipmentRefreshForTesting(seed.identity.id, { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
      { trigger: "manual_submit", includeKdniaoFallback: true }, {
        refreshAccountParcel: async () => { assert.fail("manual submission has no account-detail request"); },
        refreshWebTimeline: async () => { calls.push("h5"); return null; },
        queryManualForSource: async input => {
          const provider = input.pickerOnly ? "picker" : input.motoOnly ? "moto" : "kdniao";
          calls.push(provider);
          return { shipment: provider === "picker" && origin
            ? { ...seed, timeline: timeline("v6_query", origin), manualTimelines: [] } : null,
            pending: null, routeUrl: "" };
        },
      });
    assert.equal(calls[0], "picker", "first manual submission retains Online before enrichment");
    assert.deepEqual(calls, origin === "订单已提交" ? ["picker"] : ["picker", "moto", "h5", "kdniao"]);
  }
} finally { Date.now = realNow; }
console.log("first manual submission retains its Picker gate");
