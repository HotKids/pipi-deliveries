import assert from "node:assert/strict";
import type { Shipment, TimelinePackage } from "../models";
import { shouldRefreshShipment, terminalEvidenceAtMs } from "../services/status";
import { hasSettledTimelineHistory } from "../services/shipment-policy";

const now = Date.UTC(2026, 8, 13, 8);
const timeline: TimelinePackage = {
  provider: "interface5", waybill: "TEST123456789", courierCode: "JD", companyName: "JD",
  semantic: "COMPLETED", structuredStatus: true, statusEventAtMs: null,
  latestTimeText: "", latestDetail: "", successAtMs: now,
  tracks: [0, 1].map(index => ({ timeMs: now - (index + 1) * 60_000,
    timeText: "", detail: "Carrier history", statusCode: "", raw: {} })),
};
const row = { timeline } as Shipment;
const failures: string[] = [];
function check(name: string, run: () => void) {
  try { run(); } catch (error) { failures.push(`${name}: ${String(error)}`); }
}

for (const detail of ["待签收", "未签收", "预计明天签收", "快件已签收", "配送完成"]) {
  check(`undated terminal with prose ${detail}`, () => {
    const shipment = { ...row, timeline: { ...timeline, tracks: timeline.tracks.map(node => ({ ...node, detail })) } };
    assert.equal(terminalEvidenceAtMs(shipment, now), 0);
    assert.equal(shouldRefreshShipment(shipment, now), true);
    assert.equal(hasSettledTimelineHistory(shipment, now), false);
    assert.equal(shipment.timeline.tracks[0].detail, detail);
  });
}
for (const offset of [1, 4 * 60_000, 5 * 60_000, 6 * 60_000]) {
  check(`future structured event ${offset}`, () => {
    const shipment = { ...row, timeline: { ...timeline, statusEventAtMs: now + offset } };
    assert.equal(terminalEvidenceAtMs(shipment, now), 0);
    assert.equal(shouldRefreshShipment(shipment, now), true);
    assert.equal(hasSettledTimelineHistory(shipment, now), false);
    assert.equal(shipment.timeline.statusEventAtMs, now + offset);
    assert.equal(shouldRefreshShipment(shipment, now + offset), false);
  });
}
for (const structuredStatus of [false, undefined]) {
  check(`unverified status provenance ${structuredStatus}`, () => {
    const shipment = { ...row, timeline: { ...timeline, structuredStatus, statusEventAtMs: now - 60_000 } };
    assert.equal(terminalEvidenceAtMs(shipment, now), 0);
    assert.equal(shouldRefreshShipment(shipment, now), true);
  });
}
check("verified terminal uses its own clock", () => {
  const shipment = { ...row, timeline: { ...timeline, statusEventAtMs: now - 60_000 } };
  assert.equal(terminalEvidenceAtMs(shipment, now), now - 60_000);
  assert.equal(shouldRefreshShipment(shipment, now), false);
  assert.equal(hasSettledTimelineHistory(shipment, now), true);
});
check("active status time is not terminal evidence", () => {
  const shipment = { ...row, timeline: { ...timeline, semantic: "TRANSIT" as const, statusEventAtMs: now - 60_000 } };
  assert.equal(terminalEvidenceAtMs(shipment, now), 0);
  assert.equal(shouldRefreshShipment(shipment, now), true);
});
check("explicit iOS sign-off remains frozen without provider evidence", () => {
  const shipment = { ...row, forcedCompletedAtMs: now - 60_000 };
  assert.equal(shouldRefreshShipment(shipment, now), false);
  assert.equal(hasSettledTimelineHistory(shipment, now), true);
});
assert.deepEqual(failures, []);
console.log("terminal evidence tests passed");
