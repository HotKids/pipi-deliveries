import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment, TimelinePackage } from "../models";
import { emptyState, saveState } from "../services/storage";
import { queryManualShipmentPreview, commitManualShipmentPreview, continueManualShipmentPreview,
  runShipmentRefreshForTesting } from "../services/sync";
import { WebTimelinePhoneError } from "../services/jt-h5";

const WAYBILL = "SF900000010008", PHONE = "13800001008";
const time = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });
const missingTail = () => new WebTimelinePhoneError();
function timeline(provider = "v6_query"): TimelinePackage {
  return { provider, waybill: WAYBILL, courierCode: "SF", companyName: "SF", semantic: "TRANSIT",
    structuredStatus: true, statusEventAtMs: NOW - 60000, complete: false, successAtMs: NOW,
    latestTimeText: time(NOW - 60000), latestDetail: "Carrier event without origin",
    tracks: [{ timeMs: NOW - 60000, timeText: time(NOW - 60000), detail: "Carrier event without origin",
      statusCode: "0", raw: { statusCode: "0" } }] };
}

for (const tail of ["", "5678"]) {
  test(`SF add and continuation keep successful tracks without a tail warning (${tail || "bound phone"})`, async () => {
    memory.clear();
    saveState({ ...emptyState(), bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 }] }, NOW);
    const preview = await queryManualShipmentPreview({ waybill: WAYBILL, phoneTail: tail,
      presentation: { courierCode: "SF", companyName: "SF", requiresPhoneTail: false } }, {
      now: () => NOW,
      post: async () => ({ code: 200, value: JSON.stringify({ nu: WAYBILL, com: "SF", name: "SF", state: "0",
        time: time(NOW - 60000), context: "Carrier event without origin" }) }),
    });
    assert.equal(preview.hasTimedResult, true);
    assert.equal(preview.roundComplete, false);
    commitManualShipmentPreview(preview, NOW);
    let receivedTail = "";
    const result = await continueManualShipmentPreview(preview, { dependencies: {
      now: () => NOW, queryMoto: async () => { throw missingTail(); },
      queryKuaidi100: async shipment => {
        receivedTail = shipment.identity.phoneTail;
        const fresh = timeline("k100_h5");
        return { ...shipment, timeline: fresh, manualTimelines: [fresh], sourceTimeline: null };
      }, queryKdniao: async () => { throw missingTail(); },
    } });
    assert.equal(receivedTail, tail, "explicit tail reaches the K100 seed; bound tails remain separate candidates");
    assert.equal(result.expressToast, undefined, "a successful source suppresses another source's tail rejection");
  });

  test(`SF detail passes bound tails and a saved explicit tail without a success warning (${tail || "bound phone"})`, async () => {
    memory.clear();
    const pack = timeline();
    const row: Shipment = { identity: { id: `interface5:manual:${WAYBILL}`, bindingSource: "interface5",
      sourceOwner: "manual", sourceId: WAYBILL, phoneTail: tail, courierCode: "SF", rawCourierCode: "SF",
      companyName: "SF", manuallyAdded: true, createdAtMs: NOW - 86400000 },
      timeline: pack, sourceTimeline: null, manualTimelines: [pack], updatedAtMs: NOW };
    const stored = saveState({ ...emptyState(), shipments: [row], bindings: [
      { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 } ] }, NOW).shipments[0];
    let receivedTails: readonly string[] = [];
    const result = await runShipmentRefreshForTesting(stored.identity.id,
      { isCurrent: () => true, deadlineAtMs: NOW + 60000 },
      { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
        refreshWebTimeline: async (shipment, _deadline, _observe, _signal, _query, tails) => {
          assert.equal(shipment.identity.phoneTail, tail);
          receivedTails = tails || [];
          const fresh = timeline("k100_h5");
          return { ...shipment, timeline: fresh, sourceTimeline: null, manualTimelines: [fresh] };
        },
        queryManualForSource: async () => { throw missingTail(); },
      });
    assert.deepEqual(receivedTails, ["1008"]);
    assert.equal(result.expressToast, undefined);
  });
}

test("a genuine phone-tail rejection with no usable history still asks for the tail", async () => {
  memory.clear();
  const preview = await queryManualShipmentPreview({ waybill: WAYBILL,
    presentation: { courierCode: "SF", companyName: "SF", requiresPhoneTail: false } }, {
    now: () => NOW, post: async () => ({ code: 200, value: "{}" }),
  });
  commitManualShipmentPreview(preview, NOW);
  const result = await continueManualShipmentPreview(preview, { dependencies: {
    now: () => NOW, queryMoto: async () => { throw missingTail(); },
    queryKuaidi100: async () => { throw missingTail(); },
    queryKdniao: async () => { throw missingTail(); },
  } });
  assert.equal(result.expressToast, "manualPhoneTailRequired");
});

function savedManualRow(tail: string, pack = timeline()): Shipment {
  const row: Shipment = { identity: { id: `interface5:manual:${WAYBILL}`, bindingSource: "interface5",
    sourceOwner: "manual", sourceId: WAYBILL, phoneTail: tail, courierCode: "SF", rawCourierCode: "SF",
    companyName: "SF", manuallyAdded: true, createdAtMs: NOW - 86400000 },
    timeline: pack, sourceTimeline: null, manualTimelines: [pack], updatedAtMs: NOW };
  return saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 } ] }, NOW).shipments[0];
}

for (const tail of ["", "5678"]) {
  for (const webFails of [true, false]) {
    test(`old partial history does not hide this detail round's tail rejection (${tail || "bound phone"}, ${webFails ? "rejected" : "empty"} H5)`, async () => {
      memory.clear();
      const stored = savedManualRow(tail);
      let webCalls = 0, fallbackCalls = 0;
      const result = await runShipmentRefreshForTesting(stored.identity.id,
        { isCurrent: () => true, deadlineAtMs: NOW + 60000 },
        { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
          refreshWebTimeline: async (shipment, _deadline, _observe, _signal, _query, tails) => {
            webCalls++;
            assert.equal(shipment.identity.phoneTail, tail);
            assert.deepEqual(tails, ["1008"]);
            if (webFails) throw missingTail();
            return null;
          },
          queryManualForSource: async input => {
            assert.equal(input.fallbackOnly, true);
            fallbackCalls++;
            throw missingTail();
          },
        });
      assert.equal(webCalls, 1);
      assert.equal(fallbackCalls, 1);
      assert.equal(result.expressToast, "manualPhoneTailRequired");
      assert.equal(result.querySucceeded, false);
      assert.deepEqual(result.shipment.timeline.tracks, stored.timeline.tracks);
    });
  }
}

test("this round's accepted structured-only KDNiao success suppresses an H5 tail rejection", async () => {
  memory.clear();
  const unknown = { ...timeline(), semantic: "UNKNOWN" as const, structuredStatus: false,
    statusEventAtMs: 0, tracks: timeline().tracks.map(track => ({ ...track, statusCode: "", raw: {} })) };
  const stored = savedManualRow("5678", unknown);
  let fallbackCalls = 0;
  const result = await runShipmentRefreshForTesting(stored.identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 60000 },
    { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
      refreshWebTimeline: async () => { throw missingTail(); },
      queryManualForSource: async input => {
        assert.equal(input.fallbackOnly, true);
        fallbackCalls++;
        const pack = { ...timeline("kdniao"), tracks: [], latestTimeText: "", latestDetail: "" };
        return { result: "success", shipment: { ...stored, timeline: pack, sourceTimeline: null,
          manualTimelines: [pack] }, pending: null, routeUrl: "" };
      },
    });
  assert.equal(fallbackCalls, 1);
  assert.equal(result.querySucceeded, true);
  assert.equal(result.expressToast, undefined);
});

for (const pickerSucceeds of [true, false]) {
  test(`only the successful current add source suppresses tail rejections (${pickerSucceeds ? "Picker preview" : "K100 continuation"})`, async () => {
    memory.clear();
    const preview = await queryManualShipmentPreview({ waybill: WAYBILL,
      presentation: { courierCode: "SF", companyName: "SF", requiresPhoneTail: false } }, {
      now: () => NOW, post: async () => ({ code: 200, value: pickerSucceeds
        ? JSON.stringify({ nu: WAYBILL, com: "SF", name: "SF", state: "0",
          time: time(NOW - 60000), context: "Carrier event without origin" }) : "{}" }),
    });
    assert.equal(preview.hasTimedResult, pickerSucceeds);
    commitManualShipmentPreview(preview, NOW);
    const result = await continueManualShipmentPreview(preview, { dependencies: {
      now: () => NOW, queryMoto: async () => { throw missingTail(); },
      queryKuaidi100: async shipment => {
        if (pickerSucceeds) throw missingTail();
        const pack = timeline("k100_h5");
        return { ...shipment, timeline: pack, sourceTimeline: null, manualTimelines: [pack] };
      }, queryKdniao: async () => { throw missingTail(); },
    } });
    assert.equal(result.expressToast, undefined);
  });
}

test("an accepted Picker supplement in this manual-submit round suppresses later tail rejections", async () => {
  memory.clear();
  const stored = savedManualRow("5678");
  const calls: string[] = [];
  const result = await runShipmentRefreshForTesting(stored.identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 60000 },
    { trigger: "manual_submit", forceManualRefresh: true, includeKdniaoFallback: true }, {
      refreshWebTimeline: async () => { calls.push("k100_h5"); throw missingTail(); },
      queryManualForSource: async input => {
        if (input.pickerOnly) {
          calls.push("v6_query");
          const pack = timeline();
          return { result: "success", shipment: { ...stored, timeline: pack, sourceTimeline: null,
            manualTimelines: [pack] }, pending: null, routeUrl: "" };
        }
        assert.equal(input.fallbackOnly, true);
        calls.push("kdniao");
        throw missingTail();
      },
    });
  assert.deepEqual(calls, ["v6_query", "k100_h5", "kdniao"]);
  assert.equal(result.expressToast, undefined);
});
