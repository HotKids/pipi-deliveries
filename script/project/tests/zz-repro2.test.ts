import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type {
  AppState,
  BindingSource,
  PendingManualQuery,
  Shipment,
  StatusSemantic,
} from "../models";
import type { AccountParcelDto } from "../services/account-parser";

const NOW = Date.UTC(2026, 7, 26, 6, 0, 0);
const STATE_KEY = "pipi_deliveries_state_v1";
const ROUTES_KEY = "keychain:pipi_deliveries_routes_v1";
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const memory = new Map<string, unknown>();
let storageSetReturnsVoid = false;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

Object.assign(globalThis, {
  Path: {
    join(...parts: string[]) {
      return parts.join("/").replace(/\/{2,}/g, "/");
    },
  },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    createDirectorySync() {},
    existsSync(path: string) {
      return memory.has(`file:${path}`);
    },
    isFileSync(path: string) {
      return memory.has(`file:${path}`);
    },
    readAsStringSync(path: string) {
      const value = memory.get(`file:${path}`);
      if (typeof value !== "string") throw new Error("missing file");
      return value;
    },
    removeSync(path: string) {
      memory.delete(`file:${path}`);
    },
    renameSync(path: string, newPath: string) {
      const key = `file:${path}`;
      const destination = `file:${newPath}`;
      const value = memory.get(key);
      if (typeof value !== "string" || memory.has(destination)) {
        throw new Error("rename rejected");
      }
      memory.set(destination, value);
      memory.delete(key);
    },
    writeAsStringSync(path: string, value: string) {
      memory.set(`file:${path}`, value);
    },
  },
  Data: {
    fromIntArray(value: number[]) {
      return String.fromCharCode(...value);
    },
    fromString(value: string) {
      return value;
    },
    fromRawString(value: string) {
      return value;
    },
  },
  Crypto: {
    sha256(value: string) {
      const hex = sha256(value);
      return { toHexString: () => hex };
    },
  },
  Storage: {
    get<T>(key: string): T | null {
      return (memory.get(key) as T | undefined) ?? null;
    },
    set(key: string, value: unknown): boolean | void {
      memory.set(key, structuredClone(value));
      if (storageSetReturnsVoid) return;
      return true;
    },
  },
  Keychain: {
    get(key: string): string | null {
      return (memory.get(`keychain:${key}`) as string | undefined) ?? null;
    },
    set(key: string, value: string): boolean {
      memory.set(`keychain:${key}`, value);
      return true;
    },
    remove(key: string): void {
      memory.delete(`keychain:${key}`);
    },
  },
});


const { loadState, saveState, emptyState, commitRefreshState } = await import("../services/storage");
const { selectShipmentDetailTimeline, selectShipmentTimeline, applyAccountShipment } = await import("../services/shipment-policy");
const { mergeAccountParcel } = await import("../services/sync");

const WAYBILL = "78770238";
const T = Date.UTC(2026, 8, 8, 0, 14, 0);
const eleven = Array.from({ length: 11 }, (_, index) => ({
  timeText: "2026-09-06 09:00:00",
  timeMs: T - (2000 - index * 100) * 60_000,
  detail: index === 0 ? "您的快件已签收" : `节点${index}`,
  statusCode: "0",
  raw: {},
}));
function carrierPackage(provider: string, complete: boolean) {
  return {
    provider,
    complete,
    structuredStatus: true,
    waybill: WAYBILL,
    courierCode: "ZTO",
    companyName: "中通快递",
    semantic: "COMPLETED",
    statusEventAtMs: T - 2000 * 60_000,
    latestTimeText: "2026-09-06 09:00:00",
    latestDetail: "您的快件已签收",
    tracks: eleven,
    successAtMs: T - 600_000,
  };
}
const feed = {
  provider: "interface5",
  complete: false,
  structuredStatus: true,
  waybill: WAYBILL,
  courierCode: "ZTO",
  companyName: "中通快递",
  semantic: "COMPLETED",
  statusEventAtMs: null,
  latestTimeText: "",
  latestDetail: "",
  tracks: [],
  successAtMs: T - 600_000,
};
const stored = {
  identity: {
    id: `interface5:account:${WAYBILL}`,
    bindingSource: "interface5",
    sourceOwner: "interface5",
    sourceId: WAYBILL,
    phoneTail: "1515",
    phone: "13800001515",
    courierCode: "ZTO",
    rawCourierCode: "ZTO",
    rawCompanyName: "中通快递",
    companyName: "中通快递",
    sourceProvider: "CaiNiao",
    accountOrder: false,
    manuallyAdded: false,
    createdAtMs: T - 5 * 24 * 60 * 60 * 1000,
  },
  timeline: carrierPackage("cn_h5", true),
  sourceTimeline: feed,
  manualTimelines: [
    carrierPackage("cn_h5", true),
    carrierPackage("v4_query", false),
    carrierPackage("kdniao", true),
  ],
  route: null,
  accountRecord: null,
  updatedAtMs: T - 600_000,
} as any;

const base = { ...emptyState(), bindings: [{ source: "interface5", phone: "13800001515", boundAtMs: T - 999999 }] } as any;
const saved = saveState({ ...base, shipments: [stored] }, T);
const back = loadState(T + 1).shipments[0];
console.log("after save/load manuals:", (back.manualTimelines || []).map((t: any) => t.provider));
console.log("after save/load timeline:", back.timeline.provider, back.timeline.tracks.length);
console.log("detail:", selectShipmentDetailTimeline(back).provider);
