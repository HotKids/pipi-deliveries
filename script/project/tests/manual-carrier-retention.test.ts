import assert from "node:assert/strict";
import { memory } from "./state-storage-mock";
import { accountParcelWithExistingProjection, parcelToShipment } from "../services/account-sync";
import type { AccountParcelDto } from "../services/account-parser";
import { queryManualForSource } from "../services/manual-query";
import { runShipmentRefreshForTesting } from "../services/sync";
import { emptyState, loadState, saveState, visibleShipments } from "../services/storage";

const now = Date.UTC(2026, 8, 9, 7);
const day = 86400000;
const phone = "13800001234";
const orderId = "361000000000001";
const timeText = (at: number) => new Date(at + 8 * 3600000).toISOString().replace("T", " ").slice(0, 19);
const realNow = Date.now;
Date.now = () => now;
const failures: string[] = [];
try {
  for (const carrier of ["SF", "YTO", "JD"]) {
    for (const ageDays of [13, 14, 15]) {
      try {
        memory.clear();
        const waybill = `${carrier}123456789000`;
        const signedAt = now - ageDays * day;
        const parcel = {
          source: "interface5", ownerId: orderId, orderId, waybill: orderId, accountOrder: true,
          courierCode: "JD", rawCourierCode: "JDKD", companyName: "JD", rawCompanyName: "JD",
          sourceProvider: "JingDong", semantic: "UNKNOWN", sourceStateCode: "0", sourceStateText: "",
          receiverPhone: phone, senderPhone: "", routeUrl: "", projectionUrl: "", carrierNormalization: null,
          latestTimeText: timeText(signedAt), latestDetail: "Carrier event",
          tracks: [
            { timeText: timeText(signedAt), detail: "Carrier event", statusCode: "" },
            { timeText: timeText(signedAt - day), detail: "已揽收", statusCode: "" },
          ],
        } as AccountParcelDto;
        const projected = parcelToShipment({ ...parcel, waybill, courierCode: carrier, rawCourierCode: "" }, [phone], now)!;
        const restored = accountParcelWithExistingProjection(parcel, [projected]);
        const row = parcelToShipment(restored, [phone], now)!;
        assert.equal(row.identity.courierCode, carrier);
        assert.equal(row.accountRecord?.companyCode, "JDKD", "the account query keeps its original platform tuple");
        const state = saveState({ ...emptyState(), shipments: [row], bindings: [
          { source: "interface5", phone, boundAtMs: now - day },
        ] }, now);
        const before = state.shipments[0]!;
        const requests: { shipperCode: string; phone: string }[] = [];
        const result = await runShipmentRefreshForTesting(before.identity.id,
          { isCurrent: () => true, deadlineAtMs: now + 30000 },
          { trigger: "detail_open", includeKdniaoFallback: true }, {
            refreshAccountParcel: async () => null,
            queryManualForSource: async (input) => {
              if (input.pickerOnly) return { shipment: null, pending: null, routeUrl: "" };
              return queryManualForSource({ ...input, dependencies: {
                post: async (_route, payload) => {
                  requests.push({ shipperCode: String(payload.shipperCode), phone: String(payload.phone) });
                  const matched = payload.shipperCode === carrier;
                  return { success: true, logisticCode: waybill, shipperCode: payload.shipperCode,
                    state: matched ? "3" : "0", stateEx: matched ? "301" : "0",
                    traces: matched ? [
                      { acceptTime: timeText(signedAt), acceptStation: "Delivered", action: "301" },
                      { acceptTime: timeText(signedAt - day), acceptStation: "Collected", action: "1" },
                    ] : [] };
                },
              } });
            },
          });
        assert.deepEqual(requests, [{ shipperCode: carrier, phone: carrier === "YTO" ? "" : "1234" }]);
        const saved = loadState(now).shipments.find(item => item.identity.id === before.identity.id)!;
        assert.equal(result.shipment.timeline.semantic, "COMPLETED");
        assert.equal(saved.timeline.semantic, "COMPLETED");
        assert.equal(saved.settledAtMs, signedAt, "retention starts at the returned carrier event, not the refresh");
        assert.deepEqual(saved.sourceTimeline?.tracks, before.sourceTimeline?.tracks, "retention never strips source history");
        assert.equal(saved.manualTimelines?.find(pack => pack.provider === "kdniao")?.tracks.length, 2);
        assert.equal(visibleShipments(loadState(now), now).length, ageDays < 14 ? 1 : 0,
          "an expired parcel leaves Home as one row while its cached status and history remain intact");
      } catch (error) {
        failures.push(`${carrier}/${ageDays}: ${String(error)}`);
      }
    }
  }
} finally {
  Date.now = realNow;
}
assert.deepEqual(failures, []);
console.log("manual carrier dispatch and whole-row signed retention tests passed");
