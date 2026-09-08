import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Shipment, TimelinePackage, TrackNode } from "../models";
import type { AccountParcelDto } from "../services/account-parser";

const NOW = Date.UTC(2026, 8, 8, 0, 14, 12);
const memory = new Map<string, unknown>();
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
Object.assign(globalThis, {
  Path: { join: (...p: string[]) => p.join("/").replace(/\/{2,}/g, "/") },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    createDirectorySync() {},
    existsSync: (p: string) => memory.has(`file:${p}`),
    isFileSync: (p: string) => memory.has(`file:${p}`),
    readAsStringSync(p: string) { const v = memory.get(`file:${p}`); if (typeof v !== "string") throw new Error("x"); return v; },
    removeSync(p: string) { memory.delete(`file:${p}`); },
    renameSync(p: string, n: string) { const v = memory.get(`file:${p}`); if (typeof v !== "string" || memory.has(`file:${n}`)) throw new Error("x"); memory.set(`file:${n}`, v); memory.delete(`file:${p}`); },
    writeAsStringSync(p: string, v: string) { memory.set(`file:${p}`, v); },
  },
  Data: { fromIntArray: (v: number[]) => String.fromCharCode(...v), fromString: (v: string) => v, fromRawString: (v: string) => v },
  Crypto: { sha256: (v: string) => ({ toHexString: () => sha(v) }) },
  Storage: { get: (k: string) => memory.get(k) ?? null, set(k: string, v: unknown) { memory.set(k, structuredClone(v)); return true; } },
  Keychain: { get: (k: string) => (memory.get(`keychain:${k}`) as string) ?? null, set(k: string, v: string) { memory.set(`keychain:${k}`, v); return true; }, remove(k: string) { memory.delete(`keychain:${k}`); } },
});

const storage = await import("../services/storage");
const { mergeAccountParcel } = await import("../services/sync");
const { timedTracks } = await import("../services/status");

const WAYBILL = "75123456780238";
const ORDERID = "3012345678901234";
const PHONE = "13800001515";
function node(h: number, detail: string): TrackNode {
  const t = NOW - h * 3600_000;
  return { timeText: new Date(t).toISOString(), timeMs: t, detail, statusCode: "", raw: {} };
}
const eleven = [2, 5, 9, 14, 20, 26, 33, 40, 46, 48, 52].map((h, i) =>
  node(h, i === 0 ? "快件已签收" : i === 9 ? "快件已揽收" : "运输中"));
function pkg(provider: string, complete: boolean): TimelinePackage {
  return { provider, complete, waybill: WAYBILL, courierCode: "ZTO", companyName: "中通快递",
    semantic: "COMPLETED", structuredStatus: false, statusEventAtMs: eleven[0].timeMs,
    latestTimeText: eleven[0].timeText, latestDetail: eleven[0].detail, tracks: eleven, successAtMs: NOW - 600_000 };
}
type Variant = {
  name: string;
  accountOrder: boolean;
  ownerId: string;
  waybill: string;
  provider: string;
  feedDetail: string;
  scope?: "ORDER" | "SHIPMENT";
  storedAccountOrder?: boolean;
  storedProjected?: string;
  storedSourceNull?: boolean;
};
const feedDetails = ["快件已签收", "快递状态已更新，点击查看>>", "暂无物流动态"];
const variants: Variant[] = [];
for (const accountOrder of [false, true]) {
  for (const sameOwner of [true, false]) {
    for (const detail of feedDetails) {
      for (const storedAccountOrder of [false, true]) {
        for (const storedSourceNull of [false, true]) {
          variants.push({
            name: `ao=${accountOrder} sameOwner=${sameOwner} detail=${detail.slice(0,4)} storedAO=${storedAccountOrder} srcNull=${storedSourceNull}`,
            accountOrder,
            ownerId: sameOwner ? WAYBILL : ORDERID,
            waybill: WAYBILL,
            provider: accountOrder ? "JingDong" : "CaiNiao",
            feedDetail: detail,
            scope: accountOrder ? "ORDER" : "SHIPMENT",
            storedAccountOrder,
            storedProjected: storedAccountOrder ? WAYBILL : "",
            storedSourceNull,
          });
        }
      }
    }
  }
}

for (const v of variants) {
  memory.clear();
  const feedTrack: TrackNode = {
    timeText: new Date(NOW - 2 * 3600_000).toISOString(), timeMs: NOW - 2 * 3600_000,
    detail: v.feedDetail, statusCode: "3", raw: { statusCode: "3", _pipiStatusSource: "interface5" },
  };
  const feed: TimelinePackage = {
    provider: "interface5", waybill: WAYBILL, courierCode: "ZTO", companyName: "中通快递",
    semantic: "COMPLETED", structuredStatus: true, statusEventAtMs: NOW - 2 * 3600_000,
    latestTimeText: feedTrack.timeText, latestDetail: feedTrack.detail,
    tracks: [feedTrack], successAtMs: NOW - 600_000,
  };
  const cnH5 = pkg("cn_h5", true), v4 = pkg("v4_query", false), kd = pkg("kdniao", true);
  const stored = {
    identity: {
      id: `interface5:account:${v.ownerId}`, bindingSource: "interface5",
      sourceOwner: v.storedAccountOrder ? "interface5:order" : "interface5",
      sourceId: v.ownerId, phoneTail: "1515", phone: PHONE, courierCode: "ZTO",
      rawCourierCode: "ZTO", companyName: "中通快递", sourceProvider: v.provider,
      orderId: v.storedAccountOrder ? v.ownerId : "",
      projectedWaybill: v.storedProjected,
      accountOrder: v.storedAccountOrder, manuallyAdded: false, createdAtMs: NOW - 60 * 3600_000,
    },
    timeline: cnH5,
    sourceTimeline: v.storedSourceNull ? null : feed,
    manualTimelines: [cnH5, v4, kd],
    route: { kind: "cainiao", source: "interface5" },
    accountRecord: { waybill: WAYBILL, companyCode: "ZTO", name: "中通快递", provider: "cainiao", stateNumber: 3, updateTime: feedTrack.timeText, phone: PHONE, channel: "cainiao" },
    updatedAtMs: NOW - 600_000,
  } as unknown as Shipment;
  storage.addBinding("interface5", PHONE, NOW - 3600_000);
  let state = storage.loadState(NOW);
  state = storage.saveState({ ...state, shipments: [stored] }, NOW - 500_000);
  const beforeRow = state.shipments[0];
  if (!beforeRow) { console.log("SKIP(no row)", v.name); continue; }
  const beforeManuals = (beforeRow.manualTimelines || []).length;
  const parcel = {
    source: "interface5", ownerId: v.ownerId, waybill: v.waybill, orderId: v.accountOrder ? v.ownerId : "",
    accountOrder: v.accountOrder, courierCode: "ZTO", rawCourierCode: "ZTO", rawCompanyName: "中通快递",
    companyName: "中通快递", carrierNormalization: null, sourceProvider: v.provider,
    sourceStateCode: "3", sourceStateText: "已签收", semantic: "COMPLETED",
    normalizedStatusScope: v.scope, normalizedStatusSemantic: "COMPLETED", normalizedStatusText: "已签收",
    receiverPhone: PHONE, senderPhone: "", latestTimeText: feedTrack.timeText, latestDetail: v.feedDetail,
    tracks: [{ timeText: feedTrack.timeText, detail: v.feedDetail, statusCode: "3" }],
    routeUrl: "", projectionUrl: "",
  } as unknown as AccountParcelDto;
  const merged = mergeAccountParcel(state, state.shipments, parcel, [PHONE], "interface5", NOW, new Map());
  const saved = storage.saveState({ ...state, shipments: merged }, NOW);
  const rows = saved.shipments;
  const counts = rows.map((r) => `${r.identity.id.slice(-8)}:${(r.manualTimelines || []).map((t) => `${t.provider}(${timedTracks(t.tracks).length})`).join("+") || "NONE"}`);
  const lost = rows.every((r) => !(r.manualTimelines || []).length);
  console.log(lost ? "LOST " : "keep ", `before=${beforeManuals} rows=${rows.length}`, counts.join(" | "), "::", v.name);
}
assert.ok(true);
