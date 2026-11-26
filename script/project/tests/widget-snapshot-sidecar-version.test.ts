import assert from "node:assert/strict";
import type { Shipment } from "../models";
import { memory, NOW } from "./state-storage-mock";
import { emptyState, loadWidgetSnapshot, saveState } from "../services/storage";

// Review item 8 (2): WidgetRow gained `sender` (owner 2026-11-20, the gray 寄 tag), so the widget
// sidecar moved to version 2. A version 1 sidecar written before that has no flag and is ignored:
// the widget falls back to the shared state and rewrites the sidecar.
const SIDECAR = "file:/group/pipi-deliveries/widget-snapshot-v1.json";
const waybill = "SF1234567890361";
const at = NOW - 60_000;
const timeline = {
  provider: "interface5", waybill, courierCode: "SF", companyName: "顺丰速运", structuredStatus: true,
  semantic: "TRANSIT" as const, statusEventAtMs: at, latestTimeText: "2026-09-08 13:59:00",
  latestDetail: "快件运输中", successAtMs: at,
  tracks: [{ timeText: "2026-09-08 13:59:00", timeMs: at, detail: "快件运输中", statusCode: "", raw: {} }],
};
const sender: Shipment = {
  identity: { id: `interface5:account:${waybill}`, bindingSource: "interface5", sourceOwner: "account",
    sourceId: waybill, courierCode: "SF", rawCourierCode: "SF", companyName: "顺丰速运", phoneTail: "",
    manuallyAdded: false, createdAtMs: at, sender: true },
  timeline, sourceTimeline: timeline, updatedAtMs: at,
};
saveState({ ...emptyState(), shipments: [sender] }, NOW);
const written = JSON.parse(String(memory.get(SIDECAR)));
assert.equal(written.version, 2, "a sidecar written with the sender flag is version 2");
assert.equal(written.snapshot.rows[0].sender, true);

// A version 2 sidecar matching the state is served as is.
memory.set(SIDECAR, JSON.stringify({ ...written,
  snapshot: { ...written.snapshot, rows: [{ ...written.snapshot.rows[0], latestDetail: "served from sidecar" }] } }));
assert.equal(loadWidgetSnapshot(NOW + 1).rows[0].latestDetail, "served from sidecar");

// A version 1 sidecar with the same revision and checksum predates the flag and is ignored.
const { sender: _flag, ...oldRow } = written.snapshot.rows[0];
memory.set(SIDECAR, JSON.stringify({ ...written, version: 1, snapshot: { ...written.snapshot, rows: [oldRow] } }));
const fallback = loadWidgetSnapshot(NOW + 2);
assert.equal(fallback.rows[0].sender, true, "the normal path restores the 寄 tag");
assert.equal(fallback.rows[0].latestDetail, "快件运输中");
const rewritten = JSON.parse(String(memory.get(SIDECAR)));
assert.equal(rewritten.version, 2, "the fallback rewrites the sidecar as version 2");
assert.equal(rewritten.snapshot.rows[0].sender, true);
console.log("Widget sidecar version 2 carries the sender flag; version 1 sidecars are ignored");
