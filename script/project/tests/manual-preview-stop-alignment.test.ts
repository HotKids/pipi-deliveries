import assert from "node:assert/strict";
import type { TimelinePackage } from "../models";
import { memory, NOW } from "./state-storage-mock";
import { loadState } from "../services/storage";
import {
  queryManualShipmentPreview, commitManualShipmentPreview, continueManualShipmentPreview,
} from "../services/sync";
import { manualPreviewNeedsDetailRefresh } from "../services/manual-preview";

const WAYBILL = "SFINITIALALIGN1013";
const HOUR = 60 * 60_000;
const timeText = (at: number) => new Date(at + 8 * HOUR).toISOString().slice(0, 19).replace("T", " ");
const actualNow = Date.now;
Date.now = () => NOW;
try {
  for (const origin of ["stale", "pickup", "ordered"] as const) {
    memory.clear();
    const stale = origin === "stale";
    const semantic = stale ? "TRANSIT" : origin === "pickup" ? "PICKED" : "ORDERED";
    const preview = await queryManualShipmentPreview({ waybill: WAYBILL,
      presentation: { courierCode: "SF", companyName: "Test carrier", requiresPhoneTail: false },
    }, {
      now: () => NOW,
      post: async path => {
        assert.equal(path, "/api/express/timeline/source");
        return { code: 200, normalizedStatus: { version: 1, scope: "SHIPMENT", semantic,
          code: semantic, text: semantic, priority: 0, eventAtMs: NOW, structured: true },
          value: JSON.stringify({ nu: WAYBILL, com: "SF", name: "Test carrier",
            time: timeText(stale ? NOW - 10 * HOUR : NOW),
            context: origin === "ordered" ? "已下单" : "已揽收" }) };
      },
    });
    assert.equal(preview.roundComplete, !stale,
      `initial ${origin} Picker needs both its original start and latest status/time alignment`);
    assert.equal(manualPreviewNeedsDetailRefresh(preview.shipment), stale,
      "the actual detail-entry decision must agree with the initial round state");
    const committed = commitManualShipmentPreview(preview, NOW);
    assert.equal(committed.shipments.length, stale ? 0 : 1);
    assert.equal(committed.pendingQueries.length, stale ? 1 : 0,
      "an incomplete first response keeps the existing durable continuation");
    if (!stale) continue;
    const seed = preview.shipment!;
    const h5: TimelinePackage = { ...seed.timeline, provider: "k100_h5", semantic: "UNKNOWN",
      structuredStatus: false, normalizedStatus: undefined, statusEventAtMs: null,
      latestTimeText: timeText(NOW), latestDetail: "Current carrier event",
      tracks: [{ timeMs: NOW, timeText: timeText(NOW),
        detail: "Current carrier event", statusCode: "", raw: {} },
      { timeMs: NOW - 10 * HOUR, timeText: timeText(NOW - 10 * HOUR),
        detail: "已揽收", statusCode: "", raw: {} }] };
    const calls: string[] = [];
    const completed = await continueManualShipmentPreview(preview, { dependencies: {
      now: () => NOW,
      queryMoto: async () => { calls.push("moto"); return null; },
      queryKuaidi100: async () => { calls.push("h5"); return { ...seed,
        timeline: h5, manualTimelines: [h5], sourceTimeline: null }; },
      queryKdniao: async () => { calls.push("kdniao"); return null; },
    } });
    assert.deepEqual(calls, ["moto", "h5"],
      "the existing primary round continues and its aligned accumulated history stops KDNiao");
    assert.equal(completed.state.pendingQueries.length, 0);
    assert.equal(loadState(NOW).shipments.length, 1,
      "the owner is published only after the existing continuation completes");
  }
} finally { Date.now = actualNow; }
console.log("Initial manual preview alignment tests passed");
