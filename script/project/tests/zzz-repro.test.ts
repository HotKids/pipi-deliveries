import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AppState, Shipment, TimelinePackage, TrackNode } from "../models";
import type { AccountParcelDto } from "../services/account-parser";

const NOW = Date.UTC(2026, 8, 8, 0, 14, 12);
const memory = new Map<string, unknown>();
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
Object.assign(globalThis, {
  Path: { join: (...p: string[]) => p.join("/").replace(/\/{2,}/g, "/") },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    createDirectorySync() {},
    existsSync: (p: string) => memory.has(`file:${p}`),
    isFileSync: (p: string) => memory.has(`file:${p}`),
    readAsStringSync(p: string) {
      const v = memory.get(`file:${p}`);
      if (typeof v !== "string") throw new Error("missing file");
      return v;
    },
    removeSync(p: string) { memory.delete(`file:${p}`); },
    renameSync(p: string, n: string) {
      const v = memory.get(`file:${p}`);
      if (typeof v !== "string" || memory.has(`file:${n}`)) throw new Error("rename rejected");
      memory.set(`file:${n}`, v); memory.delete(`file:${p}`);
    },
    writeAsStringSync(p: string, v: string) { memory.set(`file:${p}`, v); },
  },
  Data: {
    fromIntArray: (v: number[]) => String.fromCharCode(...v),
    fromString: (v: string) => v,
    fromRawString: (v: string) => v,
  },
  Crypto: { sha256: (v: string) => ({ toHexString: () => sha256(v) }) },
  Storage: {
    get<T>(k: string): T | null { return (memory.get(k) as T) ?? null; },
    set(k: string, v: unknown) { memory.set(k, structuredClone(v)); return true; },
  },
  Keychain: {
    get: (k: string) => (memory.get(`keychain:${k}`) as string) ?? null,
    set(k: string, v: string) { memory.set(`keychain:${k}`, v); return true; },
    remove(k: string) { memory.delete(`keychain:${k}`); },
  },
});

const { saveState, loadState, addBinding, emptyState } = await import("../services/storage");
const { mergeAccountParcel } = await import("../services/sync");
const { selectShipmentDetailTimeline } = await import("../services/shipment-policy");
const { timedTracks } = await import("../services/status");

const WAYBILL = "75123456780238";
const PHONE = "13800001515";

function node(offsetHours: number, detail: string, code = ""): TrackNode {
  const t = NOW - offsetHours * 3600_000;
  return { timeText: new Date(t).toISOString(), timeMs: t, detail, statusCode: code, raw: {} };
}
const eleven: TrackNode[] = [
  node(2, "快件已签收"), node(5, "派送中"), node(9, "到达网点"), node(14, "运输中"),
  node(20, "运输中"), node(26, "运输中"), node(33, "运输中"), node(40, "运输中"),
  node(46, "运输中"), node(48, "快件已揽收"), node(52, "商家已发货"),
];
function pkg(provider: string, complete: boolean): TimelinePackage {
  return {
    provider, complete, waybill: WAYBILL, courierCode: "ZTO", companyName: "中通快递",
    semantic: "COMPLETED", structuredStatus: false,
    statusEventAtMs: eleven[0].timeMs, latestTimeText: eleven[0].timeText,
    latestDetail: eleven[0].detail, tracks: eleven, successAtMs: NOW - 600_000,
  };
}
// feed slot: one timed node whose text is a provider placeholder -> timedTracks() === 0
const feedTrack: TrackNode = {
  timeText: new Date(NOW - 2 * 3600_000).toISOString(),
  timeMs: NOW - 2 * 3600_000,
  detail: "快件已签收，签收人：本人",
  statusCode: "3",
  raw: { statusCode: "3", _pipiStatusSource: "interface5" },
};
const feed: TimelinePackage = {
  provider: "interface5", waybill: WAYBILL, courierCode: "ZTO", companyName: "中通快递",
  semantic: "COMPLETED", structuredStatus: true, statusEventAtMs: NOW - 2 * 3600_000,
  latestTimeText: feedTrack.timeText, latestDetail: feedTrack.detail,
  tracks: [feedTrack], successAtMs: NOW - 600_000,
};
const cnH5 = pkg("cn_h5", true);
const v4 = pkg("v4_query", false);
const kdniao = pkg("kdniao", true);

const identity: Shipment["identity"] = {
  id: `interface5:account:${WAYBILL}`,
  bindingSource: "interface5",
  sourceOwner: "interface5",
  sourceId: WAYBILL,
  phoneTail: "1515",
  phone: PHONE,
  courierCode: "ZTO",
  rawCourierCode: "ZTO",
  companyName: "中通快递",
  sourceProvider: "cainiao",
  accountOrder: false,
  manuallyAdded: false,
  createdAtMs: NOW - 60 * 3600_000,
};
const stored: Shipment = {
  identity,
  timeline: cnH5,
  sourceTimeline: feed,
  manualTimelines: [cnH5, v4, kdniao],
  route: { kind: "cainiao", source: "interface5" },
  accountRecord: {
    waybill: WAYBILL, companyCode: "ZTO", name: "中通快递", provider: "cainiao",
    stateNumber: 3, updateTime: feedTrack.timeText, phone: PHONE, channel: "cainiao",
  },
  cainiaoH5FallbackActivatedAtMs: NOW - 700_000,
  detailSelection: { provider: "kdniao", selectedAtMs: NOW - 600_000 },
  settledAtMs: NOW - 2 * 3600_000,
  updatedAtMs: NOW - 600_000,
} as unknown as Shipment;

addBinding("interface5", PHONE, NOW - 3600_000);
let state = loadState(NOW);
state = saveState({ ...state, shipments: [stored] }, NOW - 500_000);
const before = state.shipments[0];
console.log("BEFORE manuals:", (before.manualTimelines || []).map((t) => `${t.provider}:${timedTracks(t.tracks).length}`));
console.log("BEFORE source:", before.sourceTimeline?.provider, timedTracks(before.sourceTimeline?.tracks || []).length);
console.log("BEFORE detail:", selectShipmentDetailTimeline(before).provider, timedTracks(selectShipmentDetailTimeline(before).tracks).length);

const parcel: AccountParcelDto = {
  source: "interface5",
  ownerId: WAYBILL,
  waybill: WAYBILL,
  orderId: "",
  accountOrder: false,
  courierCode: "ZTO",
  rawCourierCode: "ZTO",
  rawCompanyName: "中通快递",
  companyName: "中通快递",
  carrierNormalization: null,
  sourceProvider: "cainiao",
  sourceStateCode: "3",
  sourceStateText: "已签收",
  semantic: "COMPLETED",
  normalizedStatusScope: "SHIPMENT",
  normalizedStatusSemantic: "COMPLETED",
  normalizedStatusText: "已签收",
  receiverPhone: PHONE,
  senderPhone: "",
  latestTimeText: feedTrack.timeText,
  latestDetail: "快件已签收，签收人：本人",
  tracks: [{ timeText: feedTrack.timeText, detail: "快件已签收，签收人：本人", statusCode: "3" }],
  routeUrl: "",
  projectionUrl: "",
} as unknown as AccountParcelDto;

const merged = mergeAccountParcel(
  state, state.shipments, parcel, [PHONE], "interface5", NOW, new Map(),
);
const row = merged.find((s) => s.identity.id === identity.id) || merged[0];
console.log("AFTER  rows:", merged.length, merged.map((s) => s.identity.id));
console.log("AFTER  manuals:", (row.manualTimelines || []).map((t) => `${t.provider}:${timedTracks(t.tracks).length}`));
console.log("AFTER  source:", row.sourceTimeline?.provider, timedTracks(row.sourceTimeline?.tracks || []).length);
console.log("AFTER  detail:", selectShipmentDetailTimeline(row).provider, timedTracks(selectShipmentDetailTimeline(row).tracks).length);

const saved = saveState({ ...state, shipments: merged }, NOW);
const savedRow = saved.shipments.find((s) => s.identity.id === identity.id) || saved.shipments[0];
console.log("SAVED  manuals:", (savedRow.manualTimelines || []).map((t) => `${t.provider}:${timedTracks(t.tracks).length}`));
console.log("SAVED  source:", savedRow.sourceTimeline?.provider, timedTracks(savedRow.sourceTimeline?.tracks || []).length, "raw", savedRow.sourceTimeline?.tracks.length);
console.log("SAVED  detail:", selectShipmentDetailTimeline(savedRow).provider, timedTracks(selectShipmentDetailTimeline(savedRow).tracks).length);
console.log("SAVED  fallbackActivated:", savedRow.cainiaoH5FallbackActivatedAtMs, "detailSelection:", JSON.stringify(savedRow.detailSelection), "settledAtMs:", savedRow.settledAtMs);
// second round
const merged2 = mergeAccountParcel(saved, saved.shipments, parcel, [PHONE], "interface5", NOW + 60_000, new Map());
const saved2 = saveState({ ...saved, shipments: merged2 }, NOW + 60_000);
const row2 = saved2.shipments[0];
console.log("ROUND2 manuals:", (row2.manualTimelines || []).map((t) => `${t.provider}:${timedTracks(t.tracks).length}`));
console.log("ROUND2 detail:", selectShipmentDetailTimeline(row2).provider, timedTracks(selectShipmentDetailTimeline(row2).tracks).length);
console.log("ROUND2 fallbackActivated:", row2.cainiaoH5FallbackActivatedAtMs);
assert.ok(true);
