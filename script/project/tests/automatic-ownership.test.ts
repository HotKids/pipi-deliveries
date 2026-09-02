import assert from "node:assert/strict";
import type { Shipment, TimelinePackage } from "../models";
import {
  applyManualShipment,
  AUTOMATIC_TAKEOVER_COOLDOWN_MS,
  displayWaybill,
  invalidateAutomaticOwner,
  isQualifiedAutomaticShipment,
  normalizeAutomaticOwnership,
  observeQualifiedAutomaticShipment,
  recordAutomaticOwnerRefresh,
} from "../services/shipment-policy";

const NOW = Date.UTC(2026, 7, 30, 8, 0, 0);
const WAYBILL = "SYNTHETIC123456";

function timeline(
  source: string,
  semantic: TimelinePackage["semantic"],
  detail: string,
  successAtMs: number,
): TimelinePackage {
  return {
    provider: source,
    waybill: WAYBILL,
    courierCode: source === "synthetic-a" ? "SF" : "JD",
    companyName: source === "synthetic-a" ? "顺丰速运" : "京东快递",
    semantic,
    statusEventAtMs: successAtMs,
    latestTimeText: new Date(successAtMs).toISOString(),
    latestDetail: detail,
    tracks: [{
      timeText: new Date(successAtMs).toISOString(),
      timeMs: successAtMs,
      detail,
      statusCode: semantic === "COMPLETED" ? "3" : "104",
      raw: { source },
    }],
    successAtMs,
  };
}

function automatic(
  source: string,
  successAtMs: number,
  semantic: TimelinePackage["semantic"] = "TRANSIT",
  phone = "13800138000",
): Shipment {
  const sourceTimeline = timeline(
    source,
    semantic,
    `${source}-${semantic}`,
    successAtMs,
  );
  return {
    identity: {
      id: `${source}:account:${WAYBILL}`,
      bindingSource: null,
      sourceOwner: `${source}:parcel`,
      sourceId: WAYBILL,
      phoneTail: phone.slice(-4),
      phone,
      courierCode: sourceTimeline.courierCode,
      rawCourierCode: sourceTimeline.courierCode,
      companyName: sourceTimeline.companyName,
      sourceProvider: source === "synthetic-b" ? "JingDong" : "Other",
      manuallyAdded: false,
      createdAtMs: successAtMs,
    },
    timeline: sourceTimeline,
    sourceTimeline,
    manualTimelines: [],
    route: source === "synthetic-a"
      ? { kind: "cainiao", source: "interface5" }
      : null,
    accountRecord: {
      waybill: WAYBILL,
      companyCode: sourceTimeline.courierCode,
      name: sourceTimeline.companyName,
      provider: source,
      stateNumber: 104,
      updateTime: sourceTimeline.latestTimeText,
      phone,
      channel: "1",
    },
    updatedAtMs: successAtMs,
  };
}

function manual(successAtMs: number): Shipment {
  const manualTimeline = timeline("kuaidi100", "TRANSIT", "manual-sidecar", successAtMs);
  return {
    identity: {
      id: `interface5:manual:${WAYBILL}`,
      bindingSource: "interface5",
      sourceOwner: "manual",
      sourceId: WAYBILL,
      phoneTail: "8000",
      courierCode: "SF",
      companyName: "顺丰速运",
      manuallyAdded: true,
      createdAtMs: successAtMs,
    },
    timeline: manualTimeline,
    sourceTimeline: null,
    manualTimelines: [manualTimeline],
    route: { kind: "cainiao", source: "interface5" },
    updatedAtMs: successAtMs,
  };
}

const first = observeQualifiedAutomaticShipment(
  undefined,
  automatic("synthetic-a", NOW),
  "synthetic-a",
  NOW,
);
assert.equal(first.automaticOwnership?.ownerSource, "synthetic-a");
assert.equal(first.automaticOwnership?.claimedAtMs, NOW);
assert.equal(isQualifiedAutomaticShipment(automatic("synthetic-a", NOW), "synthetic-a"), true);
const projectedOrderWithoutRawCarrier = automatic(
  "synthetic-a",
  NOW + 250,
);
projectedOrderWithoutRawCarrier.identity = {
  ...projectedOrderWithoutRawCarrier.identity,
  sourceId: "ORDER20260831001",
  orderId: "ORDER20260831001",
  projectedWaybill: WAYBILL,
  accountOrder: true,
  rawCourierCode: "",
  rawCompanyName: "",
};
assert.equal(
  isQualifiedAutomaticShipment(
    projectedOrderWithoutRawCarrier,
    "synthetic-a",
  ),
  true,
  "a JD order-page projection is valid even when the account row omits raw carrier fields",
);
const ownerUpdateWithoutQualifyingCarrier = automatic(
  "synthetic-a",
  NOW + 500,
);
ownerUpdateWithoutQualifyingCarrier.identity = {
  ...ownerUpdateWithoutQualifyingCarrier.identity,
  rawCourierCode: "",
  rawCompanyName: "",
};
ownerUpdateWithoutQualifyingCarrier.timeline = {
  ...ownerUpdateWithoutQualifyingCarrier.timeline,
  latestDetail: "established-owner-update",
};
ownerUpdateWithoutQualifyingCarrier.sourceTimeline =
  ownerUpdateWithoutQualifyingCarrier.timeline;
assert.equal(
  isQualifiedAutomaticShipment(
    ownerUpdateWithoutQualifyingCarrier,
    "synthetic-a",
  ),
  false,
);
const updatedEstablishedOwner = observeQualifiedAutomaticShipment(
  first,
  ownerUpdateWithoutQualifyingCarrier,
  "synthetic-a",
  NOW + 500,
);
assert.equal(updatedEstablishedOwner.automaticOwnership?.ownerSource, "synthetic-a");
assert.equal(
  updatedEstablishedOwner.timeline.latestDetail,
  "established-owner-update",
  "the qualification gate must not stop updates from the established owner",
);
const emptySameSourceTimeline = automatic("synthetic-a", NOW);
emptySameSourceTimeline.identity = {
  ...emptySameSourceTimeline.identity,
  sourceProvider: "",
};
emptySameSourceTimeline.timeline = {
  ...emptySameSourceTimeline.timeline,
  tracks: [],
};
emptySameSourceTimeline.sourceTimeline = emptySameSourceTimeline.timeline;
assert.equal(
  isQualifiedAutomaticShipment(emptySameSourceTimeline, "synthetic-a"),
  false,
  "a source label does not replace the required local timeline",
);
const incompleteEstablishedOwnerUpdate = automatic(
  "synthetic-a",
  NOW + 750,
  "UNKNOWN",
);
incompleteEstablishedOwnerUpdate.timeline = {
  ...incompleteEstablishedOwnerUpdate.timeline,
  tracks: [],
};
incompleteEstablishedOwnerUpdate.sourceTimeline =
  incompleteEstablishedOwnerUpdate.timeline;
const acceptedIncompleteOwnerUpdate = observeQualifiedAutomaticShipment(
  first,
  incompleteEstablishedOwnerUpdate,
  "synthetic-a",
  NOW + 750,
);
assert.equal(acceptedIncompleteOwnerUpdate.updatedAtMs, NOW + 750);
assert.equal(
  acceptedIncompleteOwnerUpdate.automaticOwnership?.ownerSource,
  "synthetic-a",
  "the qualification gate applies only when ownership is established",
);
for (const unqualified of [
  {
    ...automatic("synthetic-a", NOW),
    identity: {
      ...automatic("synthetic-a", NOW).identity,
      rawCourierCode: "",
      courierCode: "",
    },
  },
  {
    ...automatic("synthetic-a", NOW),
    timeline: { ...automatic("synthetic-a", NOW).timeline, semantic: "UNKNOWN" as const },
    sourceTimeline: {
      ...automatic("synthetic-a", NOW).timeline,
      semantic: "UNKNOWN" as const,
    },
  },
  {
    ...automatic("synthetic-a", NOW),
    sourceTimeline: {
      ...automatic("synthetic-a", NOW).timeline,
      provider: "synthetic-b",
    },
  },
]) {
  assert.equal(isQualifiedAutomaticShipment(unqualified, "synthetic-a"), false);
  assert.equal(
    observeQualifiedAutomaticShipment(undefined, unqualified, "synthetic-a", NOW)
      .automaticOwnership?.ownerSource,
    null,
  );
}

const candidate = observeQualifiedAutomaticShipment(
  first,
  automatic("synthetic-b", NOW + 1_000),
  "synthetic-b",
  NOW + 1_000,
);
assert.equal(candidate.automaticOwnership?.ownerSource, "synthetic-a");
assert.equal(candidate.identity.sourceOwner, "synthetic-a:parcel");
assert.equal(candidate.timeline.latestDetail, "synthetic-a-TRANSIT");
assert.deepEqual(
  new Set(candidate.automaticOwnership?.observations.map((item) => item.source)),
  new Set(["synthetic-a", "synthetic-b"]),
);

const manuallyAdded = manual(NOW - 1_000);
const autoTookManual = observeQualifiedAutomaticShipment(
  manuallyAdded,
  automatic("synthetic-b", NOW + 2_000),
  "synthetic-b",
  NOW + 2_000,
);
assert.equal(autoTookManual.identity.manuallyAdded, false);
assert.equal(autoTookManual.automaticOwnership?.ownerSource, "synthetic-b");
assert.equal(autoTookManual.route, null, "manual route must not migrate into automatic identity");
assert.equal(autoTookManual.manualTimelines?.[0]?.provider, "kuaidi100");

const manualCannotTakeAuto = applyManualShipment(
  candidate,
  manual(NOW + 3_000),
  NOW + 3_000,
);
assert.equal(manualCannotTakeAuto.automaticOwnership?.ownerSource, "synthetic-a");
assert.equal(manualCannotTakeAuto.identity.sourceOwner, "synthetic-a:parcel");

const invalidated = invalidateAutomaticOwner(
  candidate,
  "synthetic-a",
  NOW + 4_000,
);
assert.equal(invalidated.automaticOwnership?.ownerSource, "synthetic-b");
assert.equal(invalidated.identity.sourceOwner, "synthetic-b:parcel");
assert.equal(invalidated.identity.courierCode, "JD");
assert.equal(invalidated.timeline.latestDetail, "synthetic-b-TRANSIT");
assert.equal(invalidated.route, null);
assert.equal(invalidated.manualTimelines?.length, candidate.manualTimelines?.length);

const sameSourceFirstBinding = observeQualifiedAutomaticShipment(
  undefined,
  automatic("synthetic-a", NOW + 4_010, "TRANSIT", "13800138000"),
  "synthetic-a",
  NOW + 4_010,
);
const sameSourceSecondBinding = observeQualifiedAutomaticShipment(
  sameSourceFirstBinding,
  automatic("synthetic-a", NOW + 4_020, "TRANSIT", "13900139000"),
  "synthetic-a",
  NOW + 4_020,
);
assert.equal(sameSourceSecondBinding.identity.phone, "13800138000");
assert.equal(
  sameSourceSecondBinding.automaticOwnership?.ownerBindingIdentity,
  "phone:13800138000",
);
assert.equal(sameSourceSecondBinding.automaticOwnership?.observations.length, 2);
const sameSourceCandidateInvalidated = invalidateAutomaticOwner(
  sameSourceSecondBinding,
  "synthetic-a",
  NOW + 4_025,
  "13900139000",
);
assert.equal(
  sameSourceCandidateInvalidated.automaticOwnership?.ownerBindingIdentity,
  "phone:13800138000",
);
assert.equal(sameSourceCandidateInvalidated.identity.phone, "13800138000");
assert.equal(
  sameSourceCandidateInvalidated.automaticOwnership?.observations.find(
    (observation) => observation.bindingIdentity === "phone:13900139000",
  )?.bindingValid,
  false,
);
const sameSourceBindingTakeover = invalidateAutomaticOwner(
  sameSourceSecondBinding,
  "synthetic-a",
  NOW + 4_030,
  "13800138000",
);
assert.equal(sameSourceBindingTakeover.automaticOwnership?.ownerSource, "synthetic-a");
assert.equal(
  sameSourceBindingTakeover.automaticOwnership?.ownerBindingIdentity,
  "phone:13900139000",
);
assert.equal(sameSourceBindingTakeover.identity.phone, "13900139000");
assert.equal(sameSourceBindingTakeover.automaticOwnership?.observations.length, 2);
assert.equal(
  sameSourceBindingTakeover.automaticOwnership?.observations.find(
    (observation) => observation.bindingIdentity === "phone:13800138000",
  )?.bindingValid,
  false,
);

const projectedOrder = automatic("synthetic-a", NOW + 4_100);
projectedOrder.identity = {
  ...projectedOrder.identity,
  id: "synthetic-a:account:ORDER20260830001",
  sourceId: "ORDER20260830001",
  orderId: "ORDER20260830001",
  projectedWaybill: WAYBILL,
  accountOrder: true,
};
const projectedOwner = observeQualifiedAutomaticShipment(
  undefined,
  projectedOrder,
  "synthetic-a",
  NOW + 4_100,
);
const projectedWithRealWaybillCandidate = observeQualifiedAutomaticShipment(
  projectedOwner,
  automatic("synthetic-b", NOW + 4_200),
  "synthetic-b",
  NOW + 4_200,
);
assert.equal(
  projectedWithRealWaybillCandidate.automaticOwnership?.ownerSource,
  "synthetic-a",
);
const completedUnprojectedWithOldProjection: Shipment = {
  ...projectedWithRealWaybillCandidate,
  identity: {
    ...projectedOrder.identity,
    projectedWaybill: "",
    companyName: "京东购物",
  },
  timeline: {
    ...projectedOrder.timeline,
    waybill: "ORDER20260830001",
    semantic: "ORDERED",
  },
  sourceTimeline: {
    ...projectedOrder.timeline,
    waybill: "ORDER20260830001",
    semantic: "ORDERED",
  },
  statusPresentation: {
    scope: "ORDER",
    semantic: "COMPLETED",
    text: "已完成",
  },
};
const completedOwnerMiss = recordAutomaticOwnerRefresh(
  completedUnprojectedWithOldProjection,
  "synthetic-a",
  "missing",
  NOW + 4_250,
);
assert.equal(completedOwnerMiss.automaticOwnership?.ownerSource, "synthetic-b");
assert.equal(completedOwnerMiss.identity.id, `synthetic-b:account:${WAYBILL}`);
assert.equal(displayWaybill(completedOwnerMiss), WAYBILL);
assert.equal(completedOwnerMiss.statusPresentation, undefined);
const projectedTakeover = invalidateAutomaticOwner(
  projectedWithRealWaybillCandidate,
  "synthetic-a",
  NOW + 4_300,
);
assert.equal(projectedTakeover.automaticOwnership?.ownerSource, "synthetic-b");
assert.equal(projectedTakeover.identity.id, `synthetic-b:account:${WAYBILL}`);
assert.equal(projectedTakeover.identity.sourceId, WAYBILL);
assert.equal(projectedTakeover.identity.orderId || "", "");
assert.equal(projectedTakeover.identity.projectedWaybill || "", "");
assert.equal(projectedTakeover.identity.sourceOwner, "synthetic-b:parcel");
assert.equal(projectedTakeover.identity.courierCode, "JD");
assert.equal(projectedTakeover.timeline.waybill, WAYBILL);
assert.equal(
  projectedTakeover.automaticOwnership?.observations.find(
    (observation) => observation.source === "synthetic-a",
  )?.identity.sourceId,
  "ORDER20260830001",
);

const withoutCandidate = invalidateAutomaticOwner(
  first,
  "synthetic-a",
  NOW + 5_000,
);
assert.equal(withoutCandidate.automaticOwnership?.ownerSource, null);
const reclaimed = observeQualifiedAutomaticShipment(
  withoutCandidate,
  automatic("synthetic-c", NOW + 6_000),
  "synthetic-c",
  NOW + 6_000,
);
assert.equal(reclaimed.automaticOwnership?.ownerSource, "synthetic-c");

assert.equal(
  recordAutomaticOwnerRefresh(candidate, "synthetic-a", "not_executed", NOW + 7_000)
    .automaticOwnership?.ownerSource,
  "synthetic-a",
);
const missed = recordAutomaticOwnerRefresh(
  candidate,
  "synthetic-a",
  "missing",
  NOW + 7_000,
);
assert.equal(missed.automaticOwnership?.ownerSource, "synthetic-b");
assert.equal(missed.automaticOwnership?.lastTakeoverAtMs, NOW + 7_000);

const thirdCandidate = observeQualifiedAutomaticShipment(
  missed,
  automatic("synthetic-c", NOW + 8_000),
  "synthetic-c",
  NOW + 8_000,
);
const cooldownMiss = recordAutomaticOwnerRefresh(
  thirdCandidate,
  "synthetic-b",
  "missing",
  NOW + 9_000,
);
assert.equal(cooldownMiss.automaticOwnership?.ownerSource, "synthetic-b");
assert.equal(cooldownMiss.automaticOwnership?.takeoverPending, false);
const afterCooldown = recordAutomaticOwnerRefresh(
  cooldownMiss,
  "synthetic-b",
  "missing",
  NOW + 7_000 + AUTOMATIC_TAKEOVER_COOLDOWN_MS,
);
assert.equal(afterCooldown.automaticOwnership?.ownerSource, "synthetic-c");

const completed = observeQualifiedAutomaticShipment(
  undefined,
  automatic("synthetic-a", NOW + 10_000, "COMPLETED"),
  "synthetic-a",
  NOW + 10_000,
);
const completedWithCandidate = observeQualifiedAutomaticShipment(
  completed,
  automatic("synthetic-b", NOW + 11_000),
  "synthetic-b",
  NOW + 11_000,
);
const exempt = recordAutomaticOwnerRefresh(
  completedWithCandidate,
  "synthetic-a",
  "missing",
  NOW + 12_000,
);
assert.equal(exempt.automaticOwnership?.ownerSource, "synthetic-a");
assert.equal(exempt.automaticOwnership?.ownerMisses, 0);

const legacy = normalizeAutomaticOwnership(automatic("synthetic-a", NOW), NOW);
assert.equal(legacy.automaticOwnership?.ownerSource, "synthetic-a");
assert.equal(normalizeAutomaticOwnership(manual(NOW), NOW).automaticOwnership, undefined);

console.log("automatic ownership state-machine tests passed");
