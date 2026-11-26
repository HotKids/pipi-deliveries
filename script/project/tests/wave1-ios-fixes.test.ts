import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { memory } from "./state-storage-mock";
import { saveGatewayToken } from "../services/credentials";
import { parseCloudParcelDetails } from "../services/cloud-parcel-metadata";
import { activeWatchScope, internationalShipmentSnapshot } from "../services/international-records";
import { applyCloudPddParcels, displayedPlatformFields } from "../services/platform-parcel-merge";
import { parseHandoffWindow, pddTimelineFromTraces } from "../services/platform-parcel-data";
import { shipmentNotificationEvent } from "../services/notification-events";
import { claimKuaidi100Capture, releaseKuaidi100Capture } from "../services/refresh-runtime-state";
import { parcelActivityContent, parcelPickupSubtitle } from "../services/parcel-pickup";
import { recognizeParcelCodes } from "../services/parcel-code-ocr";
import { parcelWaybillEvidence } from "../services/parcel-waybill-ocr";
import { selectShipmentTimeline } from "../services/shipment-policy";
import { shipmentPresentationStatus } from "../services/status";
import { TIMELINE_SLOT } from "../services/timeline-slot";
import { attachedShipmentIds, withWaybillOwnership } from "../services/waybill-ownership";
import {
  commitWatchSnapshot,
  deleteIndependentParcelCode,
  emptyState,
  forceCompleteShipment,
  loadState,
  removeShipment,
  saveRecognizedParcelCode,
  saveState,
  setShipmentProductName,
  visibleShipments,
} from "../services/storage";
import { createPickupRuntime } from "../services/meal/pickup-runtime";
import { onlineMealRequiresQR } from "../services/meal/recognize";
import { applyMealPage, prepareMealBatch, recoverMealConflict } from "../services/meal/cloud";
import { deleteMeal, putMealObservations, readMeals, updateMeals, type MealSession } from "../services/meal/records";
import { resolvePickupVisualStyle } from "../services/meal/pickup-artwork";
import { mealCard } from "../services/meal/cards";
import { parseRecognitionResult } from "../services/recognition/wire";
import { saveRecognitionSettings } from "../services/recognition/settings";
import type { Shipment, TimelinePackage } from "../models";

Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(globalThis, { UUID: { string: randomUUID } });

const NOW = Date.UTC(2026, 11, 31, 15, 0, 0); // 2026-12-31 23:00:00 CST (+08:00)

// 1. PDD Dual-Channel pdd_h5 timeline + Cloud PDD tombstones + pending notification suppression + M-02 ownership
{
  const pddPkg = pddTimelineFromTraces("SF1550000001234", "SF", "顺丰速运", [
    { time: "2026-12-31 20:10:00", info: "快件已发车" },
    { time: "2026-12-31 18:00:00", info: "顺丰速运 已收取快件" },
  ], NOW);
  assert.ok(pddPkg);
  assert.equal(pddPkg.provider, TIMELINE_SLOT.PDD_H5);
  assert.equal(pddPkg.tracks.length, 2);

  memory.clear();
  saveGatewayToken("AbCdEfGh_123-456");
  const anchorAt = NOW - 3_600_000;
  const base = saveState(emptyState(), NOW);
  const withCloudPdd = saveState(
    applyCloudPddParcels(base, [{ waybill: "SF1550000009999", anchorAt, carrierCode: "SF", phone4: "1234" }], NOW),
    NOW,
  );
  const cloudRow = withCloudPdd.shipments[0];
  assert.ok(cloudRow);
  assert.equal(cloudRow.identity.createdAtMs, anchorAt, "createdAtMs uses anchorAt instead of wall clock now");
  assert.equal(cloudRow.timeline.provider, "pending");

  // Pending -> enriched is first discovery (no false status-transition notification)
  const enrichedRow: Shipment = {
    ...cloudRow,
    timeline: { ...pddPkg, waybill: "SF1550000009999" },
    manualTimelines: [{ ...pddPkg, waybill: "SF1550000009999" }],
  };
  assert.equal(shipmentNotificationEvent(cloudRow, enrichedRow), null);

  // Forced completion tombstone survives next cloud PDD sync
  const signedState = forceCompleteShipment(cloudRow.identity.id, NOW + 100);
  assert.equal(signedState.cloudPddTombstones?.[0]?.action, "completed");
  const afterResyncSigned = applyCloudPddParcels(
    { ...signedState, shipments: [] },
    [{ waybill: "SF1550000009999", anchorAt, carrierCode: "SF", phone4: "1234" }],
    NOW + 200,
  );
  assert.equal(afterResyncSigned.shipments[0]?.forcedCompletedAtMs, NOW + 100);

  // Deletion tombstone prevents resurrection on next cloud PDD sync
  const deletedState = removeShipment(cloudRow.identity.id, NOW + 300);
  assert.equal(deletedState.cloudPddTombstones?.[0]?.action, "deleted");
  const afterResyncDeleted = applyCloudPddParcels(
    deletedState,
    [{ waybill: "SF1550000009999", anchorAt, carrierCode: "SF", phone4: "1234" }],
    NOW + 400,
  );
  assert.equal(afterResyncDeleted.shipments.length, 0, "deleted cloud PDD row does not resurrect");

  // M-02: withWaybillOwnership propagates pddImport & pddCloudOrigin from attached row to occupant
  const autoOccupant: Shipment = {
    identity: {
      id: "interface5:auto:SF1550000008888",
      bindingSource: "interface5",
      sourceOwner: "13800138000",
      sourceId: "SF1550000008888",
      sourceProvider: "cainiao",
      phone: "13800138000",
      phoneTail: "8000",
      courierCode: "SF",
      companyName: "顺丰速运",
      manuallyAdded: false,
      createdAtMs: NOW - 3_000,
    },
    timeline: { ...pddPkg, provider: "v5_query", waybill: "SF1550000008888" },
    updatedAtMs: NOW,
  };
  const secondAutoPdd: Shipment = {
    identity: {
      id: "interface5:auto2:SF1550000008888",
      bindingSource: "interface5",
      sourceOwner: "13900139000",
      sourceId: "SF1550000008888",
      sourceProvider: "sfexpress",
      phone: "13900139000",
      phoneTail: "9000",
      courierCode: "SF",
      companyName: "顺丰速运",
      manuallyAdded: false,
      createdAtMs: NOW - 1_000,
    },
    timeline: { ...pddPkg, waybill: "SF1550000008888" },
    pddImport: { ownerKey: "owner-1", orderId: "260101-111", shippingId: "99" },
    updatedAtMs: NOW - 500,
  };
  const owned = withWaybillOwnership(null, [autoOccupant, secondAutoPdd], NOW, row => row);
  const attachedIds = attachedShipmentIds(owned);
  assert.equal(attachedIds.has(secondAutoPdd.identity.id), true);
  const visibleOccupant = owned.find(row => !attachedIds.has(row.identity.id));
  assert.equal(visibleOccupant?.identity.id, autoOccupant.identity.id);
  assert.deepEqual(visibleOccupant?.pddImport, secondAutoPdd.pddImport, "occupant inherits attached row's pddImport");
}

// 2. Protocol Alignment #1: express_metadata productNameObservedAt monotonic comparison against manualTitleEditedAtMs
{
  const parsed = parseCloudParcelDetails({
    ok: true,
    metadata: {
      waybill: "SF1550000007777",
      anchorAt: NOW - 10_000,
      productName: "云端新商品名",
      productNameObservedAt: NOW + 5_000,
    },
  }, "SF1550000007777", NOW + 10_000);
  assert.equal(parsed?.metadata?.productNameObservedAt, NOW + 5_000);

  memory.clear();
  const shipment: Shipment = {
    identity: {
      id: "interface5:manual:SF1550000007777",
      bindingSource: "interface5",
      sourceOwner: "manual",
      sourceId: "SF1550000007777",
      phoneTail: "",
      courierCode: "SF",
      companyName: "顺丰速运",
      manuallyAdded: true,
      createdAtMs: NOW - 10_000,
    },
    timeline: pddTimelineFromTraces("SF1550000007777", "SF", "顺丰速运", [
      { time: "2026-12-31 20:00:00", info: "运输中" },
    ], NOW)!,
    updatedAtMs: NOW,
  };
  saveState({ ...emptyState(), shipments: [shipment] }, NOW);
  const renamed = setShipmentProductName(shipment, "本地改名", NOW + 1_000).shipments[0];
  assert.equal(
    displayedPlatformFields(renamed, NOW + 6_000, {
      waybill: "SF1550000007777",
      anchorAt: NOW - 10_000,
      productName: "旧云端名",
      productNameObservedAt: NOW + 500,
      deliveryEstimate: "",
      deliveryEstimateObservedAt: 0,
    }).title,
    "本地改名",
    "older cloud productNameObservedAt never overrides newer local manualTitle",
  );
  assert.equal(
    displayedPlatformFields(renamed, NOW + 6_000, {
      waybill: "SF1550000007777",
      anchorAt: NOW - 10_000,
      productName: "新云端名",
      productNameObservedAt: NOW + 5_000,
      deliveryEstimate: "",
      deliveryEstimateObservedAt: 0,
    }).title,
    "新云端名",
    "newer cloud productNameObservedAt wins over older local manualTitle",
  );
}

// 3. International WATCH_STATES + watchFeedback + Subtype Donor Clock
{
  for (const status of ["SHIPPED", "PICKED", "WAITING_PICKUP"] as const) {
    const snap = internationalShipmentSnapshot({
      id: "00000000-0000-0000-0000-000000000901",
      waybill: "INTL901",
      carrierName: "DHL",
      icon: "dhl",
      status,
      statusText: "状态正常",
      updatedAt: NOW,
      tracks: [],
    }, NOW);
    assert.equal(snap.timeline.semantic, status);
    assert.equal(snap.timeline.latestDetail, "状态正常");
  }
  assert.equal(internationalShipmentSnapshot({
    id: "00000000-0000-0000-0000-000000000902",
    waybill: "INTL902",
    carrierName: "DHL",
    icon: "dhl",
    status: "TRANSIT",
    statusText: "运输中",
    updatedAt: NOW,
    completed: NOW - 100,
    tracks: [],
  }, NOW).forcedCompletedAtMs, NOW - 100);

  memory.clear();
  saveGatewayToken("ZxCvBnMm_987-654");
  const scope = activeWatchScope();
  const watchRow = internationalShipmentSnapshot({
    id: "00000000-0000-0000-0000-000000000903",
    waybill: "INTL903",
    carrierName: "UPS",
    icon: "ups",
    status: "TRANSIT",
    statusText: "运输中",
    updatedAt: NOW - 5_000,
    tracks: [{ at: NOW - 5_000, time: new Date(NOW - 5_000).toISOString(), detail: "Scan 1" }],
  }, NOW);
  commitWatchSnapshot({ scope, snapshot: "s1", observedAtMs: NOW, shipments: [watchRow] });
  const afterComplete = forceCompleteShipment(watchRow.identity.id, NOW + 100);
  assert.equal(afterComplete.watchFeedback?.[0]?.action, "completed");
  assert.equal(afterComplete.watchFeedback?.[0]?.waybill, "INTL903");
  assert.equal(afterComplete.watchFeedback?.[0]?.watchRecordId, "00000000-0000-0000-0000-000000000903");
  assert.equal(afterComplete.watchFeedback?.[0]?.actedAt, NOW + 100);

  // Subtype donor clock: stale older CUSTOMS_CLEARANCE must NOT override newer TRANSPORT
  const staleCustomsPkg: TimelinePackage = {
    provider: TIMELINE_SLOT.V6_QUERY,
    waybill: "77100000000045",
    courierCode: "STO",
    companyName: "申通快递",
    semantic: "TRANSIT",
    structuredStatus: true,
    rawStatusCode: "CUSTOMS_CLEARANCE",
    statusEventAtMs: NOW - 86_400_000,
    latestTimeText: "2026-12-30 23:00",
    latestDetail: "清关中",
    tracks: [{ timeText: "2026-12-30 23:00", timeMs: NOW - 86_400_000, detail: "清关中", statusCode: "CUSTOMS_CLEARANCE", raw: {} }],
    successAtMs: NOW - 86_400_000,
  };
  const newerDomesticPkg: TimelinePackage = {
    provider: TIMELINE_SLOT.K100_H5,
    waybill: "77100000000045",
    courierCode: "STO",
    companyName: "申通快递",
    semantic: "TRANSIT",
    structuredStatus: true,
    rawStatusCode: "TRANSPORT",
    statusEventAtMs: NOW,
    latestTimeText: "2026-12-31 23:00",
    latestDetail: "快件已发往北京转运中心",
    tracks: [{ timeText: "2026-12-31 23:00", timeMs: NOW, detail: "快件已发往北京转运中心", statusCode: "TRANSPORT", raw: {} }],
    successAtMs: NOW,
    complete: true,
  };
  const customsShipment: Shipment = {
    identity: {
      id: "interface5:manual:77100000000045",
      bindingSource: "interface5",
      sourceOwner: "manual",
      sourceId: "77100000000045",
      phoneTail: "",
      courierCode: "STO",
      companyName: "申通快递",
      manuallyAdded: true,
      createdAtMs: NOW - 100_000_000,
    },
    timeline: newerDomesticPkg,
    manualTimelines: [staleCustomsPkg, newerDomesticPkg],
    updatedAtMs: NOW,
  };
  const selected = selectShipmentTimeline(customsShipment);
  assert.equal(shipmentPresentationStatus({ ...customsShipment, timeline: selected }).text, "运输中");
}

// 4. Meal 409 baseRevision===0 preservation + deleteMeal wire format + merchantName===brandName + fork.knife
{
  memory.clear();
  const mealRulesRaw = JSON.parse(readFileSync(new URL("../../../pickup-rules.json", import.meta.url), "utf8"));
  const mealRules = { raw: mealRulesRaw, parsed: createPickupRuntime(mealRulesRaw) };
  assert.equal(onlineMealRequiresQR({ brand: "瑞幸咖啡", pickupCode: "949" }, mealRules), true);

  const scope = "e".repeat(64);
  const style = resolvePickupVisualStyle(mealRulesRaw, { brandId: "ruixing", productName: "生椰拿铁", evidenceText: "" });
  const [newMealId] = putMealObservations(scope, [{
    payload: {
      brandId: "ruixing",
      brandName: "瑞幸咖啡",
      merchantName: "瑞幸咖啡",
      productName: "生椰拿铁",
      code: "882",
      createdAt: NOW,
      expiresAt: NOW + 7_200_000,
    },
    artwork: style,
  }], false);

  const card = mealCard(scope, newMealId, readMeals(scope), NOW)!;
  assert.equal(card.location, "", "merchantName === brandName collapses to empty so subtitle uses 请及时取餐");
  assert.deepEqual(parcelPickupSubtitle(card), { text: "请及时取餐", symbol: "fork.knife" });

  const session: MealSession = {
    ownerId: "a".repeat(64),
    endpointId: "scripting-meal:" + "b".repeat(64),
    epoch: "4d953a34-7399-5d91-a36b-000000000001",
    generation: 1,
    nextSequence: 1,
  };
  const withSession = updateMeals(scope, s => ({ ...s, session }));
  const prepared = prepareMealBatch(withSession, NOW, "4d953a34-7399-5d91-a36b-000000000099");
  assert.equal(prepared.batch?.mutations[0].baseRevision, 0);
  const recovered = recoverMealConflict(prepared, prepared.batch!, {
    ok: false,
    error: "endpoint_generation_conflict",
    requestId: prepared.batch!.requestId,
    sequence: 1,
    requestGeneration: 1,
    ownerId: session.ownerId,
    endpointId: session.endpointId,
    mutationOutcome: "unknown",
  });
  assert.equal(recovered.edits[newMealId]?.requiresExisting, undefined, "baseRevision===0 must not set requiresExisting");
  const nextSession = { ...session, generation: 2 };
  const resetState = { ...recovered, session: nextSession };
  const afterSnapshot = applyMealPage(resetState, resetState, {
    ...nextSession,
    ok: true,
    schemaVersion: 1,
    enabled: true,
    mode: "snapshot",
    reset: true,
    cursor: 5,
    hasMore: false,
    pageToken: null,
    records: [],
  });
  assert.ok(afterSnapshot.edits[newMealId], "newly scanned meal survives 409 endpoint_generation_conflict + empty snapshot");

  // Cloud-synced meal deletion prepares operation: "delete" without payload/lifecycle/historyAt
  const remoteSeeded = updateMeals(scope, s => ({
    ...s,
    session: nextSession,
    edits: {},
    remote: {
      [newMealId]: {
        recordId: newMealId,
        type: "meal_pickup",
        revision: 3,
        changedAt: NOW,
        editedAt: NOW,
        deleted: false,
        lifecycle: "active",
        historyAt: 0,
        payload: afterSnapshot.edits[newMealId].payload,
      },
    },
  }));
  assert.equal(deleteMeal(scope, newMealId, NOW + 500), true);
  const deleteBatch = prepareMealBatch(readMeals(scope), NOW + 500, "4d953a34-7399-5d91-a36b-000000000100").batch!;
  assert.deepEqual(Object.keys(deleteBatch.mutations[0]).sort(), [
    "baseRevision", "editedAt", "mutationId", "operation", "recordId", "type",
  ]);
  assert.equal(deleteBatch.mutations[0].operation, "delete");
}

// 5. Two-column Tea OCR negativeBefore + Cross-Year 12-31->01-01 + K100 phones cooldown + DELIVERY pickup card + IOS-SR-02/09
{
  const teaEvidence = parcelWaybillEvidence([
    { text: "订单编号", bounds: { left: 30, top: 800, right: 150, bottom: 830 } },
    { text: "2910384756123456 复制", bounds: { left: 420, top: 802, right: 780, bottom: 832 } },
  ]);
  assert.equal(teaEvidence.waybill, "", "two-column tea order number with 复制 is rejected by left-column 订单编号");

  const crossYearWindow = parseHandoffWindow("01-01 09:00-11:00", NOW);
  assert.deepEqual(crossYearWindow, [
    Date.parse("2027-01-01T09:00:00+08:00"),
    Date.parse("2027-01-01T11:00:00+08:00"),
  ]);
  const crossMidnightYearEnd = parseHandoffWindow("12-31 23:00-01-01 01:00", NOW);
  assert.deepEqual(crossMidnightYearEnd, [
    Date.parse("2026-12-31T23:00:00+08:00"),
    Date.parse("2027-01-01T01:00:00+08:00"),
  ]);
  const ocrHandoff = recognizeParcelCodes([
    { text: "菜鸟裹裹" },
    { text: "待上门取件" },
    { text: "寄件码 8812" },
    { text: "预约 01月01日 09:00-11:00 上门取件" },
  ], NOW);
  assert.equal(ocrHandoff.independent?.kind, "handoff");
  if (ocrHandoff.independent?.kind === "handoff") {
    assert.equal(ocrHandoff.independent.windowStartAtMs, Date.parse("2027-01-01T09:00:00+08:00"));
    assert.equal(ocrHandoff.independent.windowEndAtMs, Date.parse("2027-01-01T11:00:00+08:00"));
  }

  // K100 H5 phones cooldown key + no-tail rollback
  assert.equal(claimKuaidi100Capture("SF1234567890123", undefined, NOW, []), true);
  releaseKuaidi100Capture("SF1234567890123", [], NOW);
  assert.equal(claimKuaidi100Capture("SF1234567890123", undefined, NOW + 1, []), true,
    "released no-tail probe does not block retry");
  assert.equal(claimKuaidi100Capture("SF1234567890123", undefined, NOW + 2, ["8899"]), true,
    "supplying phone4 uses a distinct cooldown key from no-tail probe");

  // IOS-PARITY-01 & IOS-PARITY-03: DELIVERY parcel with pickup code + deleteIndependentParcelCode
  const deliveryWithCode: Shipment = {
    identity: {
      id: "interface5:manual:YT8888888888888",
      bindingSource: "interface5",
      sourceOwner: "manual",
      sourceId: "YT8888888888888",
      phoneTail: "",
      courierCode: "YTO",
      companyName: "圆通速递",
      manuallyAdded: true,
      createdAtMs: NOW,
    },
    timeline: {
      provider: TIMELINE_SLOT.V6_QUERY,
      waybill: "YT8888888888888",
      courierCode: "YTO",
      companyName: "圆通速递",
      semantic: "DELIVERY",
      structuredStatus: true,
      statusEventAtMs: NOW,
      latestTimeText: "23:00",
      latestDetail: "派送中",
      tracks: [{ timeText: "23:00", timeMs: NOW, detail: "派送中", statusCode: "DELIVERING", raw: {} }],
      successAtMs: NOW,
    },
    pickup: {
      waybill: "YT8888888888888",
      waybillGeneration: 0,
      capturedAtMs: NOW,
      code: "3-2-1008",
      locationName: "菜鸟驿站",
    },
    updatedAtMs: NOW,
  };
  assert.equal(parcelActivityContent(deliveryWithCode)?.code, "3-2-1008");

  saveRecognizedParcelCode({ id: "rec-del-1", kind: "pickup", platform: "cainiao", code: "9-9-9999", capturedAtMs: NOW }, NOW);
  assert.equal(loadState(NOW).pickupCodeRecords?.some(r => r.id === "rec-del-1"), true);
  assert.equal(deleteIndependentParcelCode("rec-del-1", NOW + 1).pickupCodeRecords?.some(r => r.id === "rec-del-1"), false);

  // IOS-SR-02: corrupted Keychain configuration does not block saving local mode
  Keychain.set("pipi_deliveries_recognition_v1", "{broken-json");
  saveRecognitionSettings({
    mode: "local",
    provider: "gemini",
    providerName: "",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    protocol: "responses",
    outputFormat: "json_schema",
    model: "",
  }, "");

  // IOS-SR-09: movie, train, flight structural consistency validation
  const envelope = (family: string, body: Record<string, unknown>) => JSON.stringify({
    express: null, pickup: null, flight: null, train: null, movie: null, taxi: null,
    [family]: body,
  });
  assert.throws(() => parseRecognitionResult(envelope("movie", {
    movieName: "测试电影", cinemaName: "测试影城", hallName: null, showStartTime: null,
    showEndTime: null, seatInfo: [], ticketCode: "123456", reservationNo: null, ticketCount: null,
  })));
  assert.throws(() => parseRecognitionResult(envelope("movie", {
    movieName: "测试电影", cinemaName: "测试影城", hallName: null, showStartTime: "2026-12-31 20:00",
    showEndTime: null, seatInfo: ["5排6座"], ticketCode: "123456", reservationNo: null, ticketCount: 2,
  })));
  assert.throws(() => parseRecognitionResult(envelope("train", {
    trainNo: "INVALID99", departureStation: "北京南", arrivalStation: "上海虹桥",
    departureDate: "2026-12-31", departureTime: "08:00", arrivalTime: "12:30",
    seatClass: null, coachNo: null, seatNo: null, ticketGate: null,
  })));
  assert.throws(() => parseRecognitionResult(envelope("flight", {
    flightNo: "BAD", airline: null, departureCity: "北京", arrivalCity: "上海",
    departureAirport: "首都", arrivalAirport: "虹桥", departureTerminal: null, arrivalTerminal: null,
    departureDate: "2026-12-31", scheduledDepartureTime: "09:00", scheduledArrivalTime: "11:15",
    boardingGate: null, seatNo: null, baggageCarousel: null,
  })));
}

console.log("Wave 1 iOS fixes (PDD dual-channel/tombstones, Watch feedback/donor clock, Meal 409/delete, OCR/cross-year, SR/PARITY) passed");
