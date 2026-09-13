import assert from "node:assert/strict";
import test from "node:test";
import type { Shipment, TimelinePackage } from "../models";
import { selectShipmentTimeline, shipmentSelectionEvidence } from "../services/shipment-policy";
import { compareTimelineProviderOrder } from "../services/status";

const EVENT = 1789290913000;
const WAYBILL = "8238522608021";
const stamp = (at: number) => new Date(at + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

function pack(provider: string, semantic: TimelinePackage["semantic"], count: number,
  eventAtMs = EVENT, priority = 0): TimelinePackage {
  return { provider, waybill: WAYBILL, courierCode: "EMS", companyName: "EMS", semantic,
    structuredStatus: semantic !== "UNKNOWN", statusEventAtMs: semantic === "UNKNOWN" ? null : eventAtMs,
    latestTimeText: stamp(eventAtMs), latestDetail: "Carrier event", successAtMs: EVENT,
    complete: provider === "k100_h5", tracks: Array.from({ length: count }, (_, index) => ({
      timeText: stamp(eventAtMs - index * 3_600_000), timeMs: eventAtMs - index * 3_600_000,
      detail: index === count - 1 && count > 1 ? "已收寄" : "Carrier event", statusCode: "", raw: {},
    })), ...(semantic === "UNKNOWN" ? {} : { normalizedStatus: {
      version: 1, scope: "SHIPMENT", semantic, code: "WORKER_STATUS", text: `Worker ${semantic} ${priority}`,
      priority, eventAtMs, structured: true,
    } }),
  };
}

function row(manualTimelines: TimelinePackage[], history?: TimelinePackage): Shipment {
  return { identity: { id: WAYBILL, bindingSource: "interface5", sourceOwner: "manual", sourceId: WAYBILL,
    phoneTail: "", phone: "", courierCode: "EMS", companyName: "EMS", sourceProvider: "manual",
    accountOrder: false, manuallyAdded: true, createdAtMs: EVENT - 1000 },
    timeline: history || manualTimelines[0], manualTimelines, route: null, accountRecord: null, updatedAtMs: EVENT,
    ...(history ? { detailSelection: { provider: history.provider, selectedAtMs: EVENT } } : {}),
  };
}

function permutations<T>(values: T[]): T[][] {
  return values.length < 2 ? [values] : values.flatMap((value, index) =>
    permutations(values.filter((_, i) => i !== index)).map(rest => [value, ...rest]));
}

test("same-event status donors use history quality independently of H5 and cache order", () => {
  const online = pack("v6_query", "TRANSIT", 1);
  const moto = pack("v4_query", "DELIVERY", 14, EVENT, 1);
  const h5 = pack("k100_h5", "UNKNOWN", 14);
  for (const donors of permutations([online, moto])) {
    for (const history of [undefined, h5]) {
      const shipment = row(history ? [...donors, history] : donors, history);
      const selected = selectShipmentTimeline(shipment);
      assert.equal(selected.provider, history ? "k100_h5" : "v4_query");
      assert.equal(selected.semantic, "DELIVERY");
      assert.equal(selected.normalizedStatus?.priority, 1);
      assert.equal(shipmentSelectionEvidence(shipment).statusProvider, "v4_query");
    }
  }
});

test("semantic representatives remove the priority/time comparison cycle", () => {
  const subtype = pack("v4_query", "DELIVERY", 2, EVENT - 200_000, 1);
  const ordinary = pack("v2_query", "DELIVERY", 2, EVENT, 0);
  const transit = pack("v6_query", "TRANSIT", 2, EVENT - 100_000, 0);
  const h5 = pack("k100_h5", "UNKNOWN", 14);
  for (const donors of permutations([subtype, ordinary, transit])) {
    const shipment = row([...donors, h5], h5);
    const selected = selectShipmentTimeline(shipment);
    assert.equal(selected.semantic, "TRANSIT");
    assert.equal(selected.statusEventAtMs, transit.statusEventAtMs);
    assert.equal(shipmentSelectionEvidence(shipment).statusProvider, "v6_query");
  }
});

test("equal donor quality has a fixed provider order rather than insertion order", () => {
  const moto = pack("v4_query", "DELIVERY", 2);
  const oppo = pack("v2_query", "TRANSIT", 2);
  const h5 = pack("k100_h5", "UNKNOWN", 14);
  assert.ok(compareTimelineProviderOrder(moto, oppo) < 0);
  assert.ok(compareTimelineProviderOrder(pack("cn_h5", "DELIVERY", 2),
    pack("k100_h5", "TRANSIT", 2)) < 0, "same-capability providers use the contract's fixed order");
  for (const donors of permutations([moto, oppo])) {
    assert.equal(shipmentSelectionEvidence(row([...donors, h5], h5)).statusProvider, "v4_query");
  }
});

test("newer cross-semantic evidence wins while owner and terminal protection remain", () => {
  const moto = pack("v4_query", "DELIVERY", 14, EVENT - 1000, 1);
  const online = pack("v6_query", "TRANSIT", 1);
  const h5 = pack("k100_h5", "UNKNOWN", 14);
  for (const donors of permutations([moto, online])) {
    assert.equal(selectShipmentTimeline(row([...donors, h5], h5)).semantic, "TRANSIT");
  }
  const shipment = row([online, moto, h5], h5);
  const terminal = pack("v4_query", "COMPLETED", 2, EVENT - 2000);
  assert.equal(selectShipmentTimeline({ ...shipment, timeline: terminal }).semantic, "COMPLETED");
  const owner = pack("interface5", "PICKED", 2, EVENT - 3000);
  assert.equal(selectShipmentTimeline({ ...shipment, identity: { ...shipment.identity,
    manuallyAdded: false, sourceProvider: "JingDong" }, sourceTimeline: owner, timeline: owner }).semantic, "PICKED");
});

test("automatic SF takeover can upgrade its same-semantic Worker subtype without changing history", () => {
  const sf = (timeline: TimelinePackage): TimelinePackage => ({ ...timeline,
    waybill: "SF123456789012", courierCode: "SF", companyName: "SF" });
  const source = sf(pack("interface5", "PICKED", 1, EVENT - 3000));
  const online = sf(pack("v6_query", "DELIVERY", 2));
  const station = sf(pack("v4_query", "DELIVERY", 14, EVENT - 1000, 1));
  const shipment: Shipment = { ...row([online, station]), identity: { ...row([online]).identity,
    id: source.waybill, sourceId: source.waybill, courierCode: "SF", companyName: "SF",
    manuallyAdded: false, sourceProvider: "ShunFeng" }, timeline: source, sourceTimeline: source };
  const selected = selectShipmentTimeline(shipment);
  assert.equal(selected.provider, "v6_query");
  assert.equal(selected.normalizedStatus?.priority, 1);
  assert.equal(selected.statusEventAtMs, station.statusEventAtMs);
  assert.equal(shipmentSelectionEvidence(shipment).statusProvider, "v4_query");
  const laterDifferent = sf(pack("v4_query", "COMPLETED", 14, EVENT + 1000));
  assert.equal(selectShipmentTimeline({ ...shipment, manualTimelines: [online, laterDifferent] }).semantic,
    "DELIVERY", "same-semantic preference cannot replace an already valid SF status with a different semantic");
  assert.equal(selectShipmentTimeline({ ...shipment, identity: { ...shipment.identity,
    sourceProvider: "JingDong" } }).semantic, "PICKED", "ordinary account status retains authority");
});
