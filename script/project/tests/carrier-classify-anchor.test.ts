import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment } from "../models";
import type { AccountParcelDto } from "../services/account-parser";
import {
  accountParcelClassifyAnchor,
  accountParcelRowId,
  normalizeAccountParcelCarrier,
} from "../services/account-carrier-normalization";
import { parcelToShipment } from "../services/account-sync";
import { firstClassifyAnchor } from "../services/row-ledger";
import { detectManualCarrier } from "../services/manual-query";
import {
  buildCarrierClassificationRequest,
  classifyWithWorker,
  recognizeNonSyncCarrier,
  type CarrierRecognitionEntry,
  type CarrierRecognitionStore,
} from "../services/carrier-recognition";
import { saveGatewayToken } from "../services/credentials";
import { emptyState, loadState, removeShipment, saveState } from "../services/storage";
import { runShipmentRefreshForTesting } from "../services/sync";
import { shipmentReuseAnchorAtMs } from "../services/waybill-reuse";

// 用户 2026-10-03「答案按新件分开、总额仍按运单」（优化 5；接口约定协调方定）：iOS 的 /api/express/classify 请求带可选的
// `parcelAnchorAtMs`——这一行自己记录的运单号重用锚点（与 services/waybill-reuse.ts 同一个：最早的有时间节点，没有节点取
// 状态时间，再没有取最新时间）。须大于 0、不在未来，否则不传；不认识这个字段的 Worker 忽略它，回答照常解析。
// 合成数据：运单号、手机号都是编的。

const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });
const providerTime = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");

// ---- The request: the anchor goes along only when it is a valid past time.
const ANCHOR = NOW - 3 * 86400000;
assert.deepEqual(buildCarrierClassificationRequest(" raw123456789 ", ANCHOR, NOW), {
  route: "/api/express/classify",
  payload: { waybill: "RAW123456789", firstStageCompleted: true, parcelAnchorAtMs: ANCHOR },
});
for (const invalid of [undefined, 0, -1, NOW + 1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
  assert.deepEqual(buildCarrierClassificationRequest("RAW123456789", invalid as number | undefined, NOW).payload,
    { waybill: "RAW123456789", firstStageCompleted: true }, `${invalid}: not sent`);
}
assert.deepEqual(buildCarrierClassificationRequest("RAW123456789", NOW, NOW).payload.parcelAnchorAtMs, NOW,
  "now itself is not in the future");

// ---- The Worker call: the payload carries it; an answer that ignores it parses as before.
{
  const posted: unknown[] = [];
  const post = (async (_route: string, payload: unknown) => {
    posted.push(payload);
    return { auto: [{ comCode: "ZTO", name: "中通快递" }] };
  }) as unknown as Parameters<typeof classifyWithWorker>[2];
  const answer = await classifyWithWorker({ waybill: "RAW123456789", firstStageCompleted: true, parcelAnchorAtMs: ANCHOR },
    {}, post);
  assert.equal(answer?.standardCode, "ZTO", "a Worker that ignores the field answers as before");
  await classifyWithWorker({ waybill: "RAW123456789", firstStageCompleted: true }, {}, post);
  assert.deepEqual(posted, [
    { waybill: "RAW123456789", firstStageCompleted: true, parcelAnchorAtMs: ANCHOR },
    { waybill: "RAW123456789", firstStageCompleted: true },
  ], "an old caller without an anchor sends the old payload");
}

// ---- The recognizer hands the caller's anchor to the paid stage.
function memoryStore(): CarrierRecognitionStore {
  let entries: readonly CarrierRecognitionEntry[] = [];
  return { load: () => entries, save: (next) => { entries = next; } };
}
for (const [anchor, expected] of [[ANCHOR, ANCHOR], [NOW + 60000, undefined], [undefined, undefined]] as const) {
  let classified: unknown = null;
  await recognizeNonSyncCarrier("ANCHOR123456789", {
    store: memoryStore(),
    parcelAnchorAtMs: anchor,
    detect: async () => [],
    classify: async (input) => {
      classified = input;
      return null;
    },
  });
  assert.deepEqual(classified, {
    waybill: "ANCHOR123456789",
    firstStageCompleted: true,
    ...(expected ? { parcelAnchorAtMs: expected } : {}),
  }, `anchor ${anchor}`);
}

// ---- An account record's anchor is its own: the earliest timed node, then its status time (three different rows: each
// row's first anchor is recorded and kept, see 优化 5 续 below).
{
  const tracks = [
    { timeText: providerTime(NOW - 3600000), detail: "快件派送中", statusCode: "" },
    { timeText: providerTime(NOW - 2 * 86400000), detail: "已揽收", statusCode: "" },
  ];
  const parcel = {
    source: "interface5", ownerId: "YT0000000009501", waybill: "YT0000000009501", accountOrder: false,
    courierCode: "", rawCourierCode: "XYZ", companyName: "", sourceProvider: "CaiNiao",
    sourceStateCode: "105", sourceStateText: "派送中", semantic: "DELIVERY", normalizedStatusScope: "SHIPMENT",
    normalizedStatusSemantic: "DELIVERY", normalizedStatusText: "派送中", receiverPhone: "13800009501",
    senderPhone: "", latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, tracks, routeUrl: "",
    normalizedStatus: { version: 1, scope: "SHIPMENT", semantic: "DELIVERY", code: "105", text: "派送中",
      priority: 0, eventAtMs: NOW - 3600000, structured: true },
  } as AccountParcelDto;
  memory.clear();
  const anchors: Array<number | undefined> = [];
  const recognize = (async (_waybill: string, options?: { parcelAnchorAtMs?: number | (() => number | undefined) }) => {
    const anchor = options?.parcelAnchorAtMs;
    anchors.push(typeof anchor === "function" ? anchor() : anchor);
    return { normalization: null, terminal: false, pendingSecondLevel: false, coolingDown: true };
  }) as unknown as typeof recognizeNonSyncCarrier;
  await normalizeAccountParcelCarrier(parcel, { recognize });
  await normalizeAccountParcelCarrier({ ...parcel, ownerId: "YT0000000009502", waybill: "YT0000000009502",
    tracks: [] }, { recognize });
  await normalizeAccountParcelCarrier({ ...parcel, ownerId: "YT0000000009503", waybill: "YT0000000009503",
    tracks: [], normalizedStatus: undefined, latestTimeText: "" }, { recognize });
  assert.deepEqual(anchors, [NOW - 2 * 86400000, NOW - 3600000, undefined],
    "earliest node, then the status time, else nothing");
  assert.equal(accountParcelRowId(parcel), parcelToShipment(parcel, ["13800009501"], NOW)!.identity.id,
    "the anchor is kept under the id of the row the record lands on");
}

// ---- 优化 5 续（用户 2026-10-03「第一次识别时记下锚点，之后不变」）：这一行第一次发锚点时按当时的历史算出来记下，之后一律
// 发记下的这个——历史变多（最早节点往前挪超过 24 小时）、变少（往后挪超过 24 小时）都不漂；真实删除清掉；运单号被新件接管
// 从头再记；还没有行的手动加件照旧不发。
{
  memory.clear();
  const DAY = 86400000;
  const record = (earliestAt: number, ownerId = "YT0000000009511"): AccountParcelDto => {
    const tracks = [
      { timeText: providerTime(NOW - 3600000), detail: "快件派送中", statusCode: "" },
      { timeText: providerTime(earliestAt), detail: "已揽收", statusCode: "" },
    ];
    return { source: "interface5", ownerId, waybill: ownerId, accountOrder: false, courierCode: "",
      rawCourierCode: "XYZ", companyName: "", sourceProvider: "CaiNiao", sourceStateCode: "105",
      sourceStateText: "派送中", semantic: "DELIVERY", normalizedStatusScope: "SHIPMENT",
      normalizedStatusSemantic: "DELIVERY", normalizedStatusText: "派送中", receiverPhone: "13800009511",
      senderPhone: "", latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, tracks, routeUrl: "",
      normalizedStatus: { version: 1, scope: "SHIPMENT", semantic: "DELIVERY", code: "105", text: "派送中",
        priority: 0, eventAtMs: NOW - 3600000, structured: true } } as AccountParcelDto;
  };
  /** One recognition reaching the paid stage (a fresh recognition cache each time), the anchor it sent. */
  const sentAnchor = async (parcel: AccountParcelDto, freeStage: unknown[] = []) => {
    let sent: unknown = "not sent";
    await recognizeNonSyncCarrier(parcel.waybill, {
      store: memoryStore(),
      parcelAnchorAtMs: accountParcelClassifyAnchor(parcel),
      detect: async () => freeStage as never,
      classify: async (input) => { sent = input.parcelAnchorAtMs; return null; },
    });
    return sent;
  };
  const first = NOW - 2 * DAY;
  // A recognition the free stage settles sends nothing and records nothing.
  assert.equal(await sentAnchor(record(first), [{ courierCode: "zhongtong", companyName: "中通快递" }]), "not sent");
  assert.equal(firstClassifyAnchor(accountParcelRowId(record(first)), () => 0), undefined, "nothing recorded yet");
  // The first paid request records the anchor as the history is now …
  assert.equal(await sentAnchor(record(first)), first);
  // … and it stays when the earliest node later moves by more than 24 hours, either way.
  assert.equal(await sentAnchor(record(first - 3 * DAY)), first, "more history: the recorded anchor is sent");
  assert.equal(await sentAnchor(record(first + DAY + 3600000)), first, "less history: still the recorded anchor");
  const row = (parcel: AccountParcelDto) => parcelToShipment(parcel, ["13800009511"], NOW)!;
  // A stored row recognised on its detail path reads the same record.
  saveState({ ...emptyState(), shipments: [row(record(first - 3 * DAY))], bindings: [] }, NOW);
  assert.equal(firstClassifyAnchor(row(record(first)).identity.id, () => NOW - 3600000), first);
  // Saves of other rows keep it, the row itself included.
  saveState({ ...loadState(NOW) }, NOW);
  assert.equal(await sentAnchor(record(first - 5 * DAY)), first);
  // A new parcel taking the row over on a reused number starts a fresh anchor.
  const stored = loadState(NOW).shipments[0]!;
  saveState({ ...loadState(NOW), shipments: [{ ...stored, waybillReuseAtMs: NOW }] }, NOW);
  assert.equal(await sentAnchor(record(NOW - 3 * 3600000)), NOW - 3 * 3600000, "a new parcel: a fresh anchor");
  assert.equal(await sentAnchor(record(first)), NOW - 3 * 3600000, "which then stays");
  // A real deletion clears it: the row added again records anew.
  removeShipment(stored.identity.id, NOW);
  assert.equal(await sentAnchor(record(first)), first, "after a real deletion the anchor is recorded again");
  // A record whose row has not landed yet keeps its anchor through other saves for a day, then it goes.
  const pending = record(first, "YT0000000009512");
  assert.equal(await sentAnchor(pending), first);
  saveState({ ...emptyState(), shipments: [], bindings: [] }, NOW + 60000);
  assert.equal(await sentAnchor(record(first - 3 * DAY, "YT0000000009512")), first, "kept while its row is pending");
  saveState({ ...emptyState(), shipments: [], bindings: [] }, NOW + 25 * 3600000);
  assert.equal(firstClassifyAnchor(accountParcelRowId(pending), () => first - 3 * DAY), first - 3 * DAY,
    "a day later, with no row ever saved, the old record is gone");
}

// ---- A stored row recognised again on its detail page sends the row's own anchor (the reuse reading).
{
  Object.assign(Crypto, {
    hmacSHA256: (value: string, key: string) => ({
      toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
    }),
    generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
  });
  Object.assign(Data, { fromFile: () => null });
  Object.assign(globalThis, {
    Notification: { schedule: async () => undefined },
    Widget: { reloadAll() {} },
    Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  });
  const bodies: unknown[] = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const { hostname, pathname } = new URL(url);
    if (hostname === "www.kuaidi100.com" && pathname === "/autonumber/autoComNum") {
      return { ok: true, status: 200, text: async () => JSON.stringify({ auto: [] }) };
    }
    if (pathname === "/api/express/classify") {
      bodies.push(JSON.parse(init?.body || "{}"));
      return { ok: true, status: 200, text: async () => JSON.stringify({ auto: [{ comCode: "ZTO", name: "中通快递" }] }) };
    }
    return { ok: false, status: 503, text: async () => "Synthetic offline" };
  }) as typeof fetch;
  const waybill = "MANUAL000009501";
  const first = NOW - 2 * 86400000;
  const tracks = [NOW - 3600000, first].map((at, index) => ({
    timeMs: at, timeText: providerTime(at), detail: index ? "快件已揽收" : "快件派送中", statusCode: "", raw: {},
  }));
  const timeline = { provider: "v6_query", waybill, courierCode: "", companyName: "", semantic: "DELIVERY" as const,
    structuredStatus: true, statusEventAtMs: NOW - 3600000, latestTimeText: tracks[0].timeText,
    latestDetail: tracks[0].detail, successAtMs: NOW - 3600000, tracks };
  const manual = { identity: { id: `interface5:manual:${waybill}`, bindingSource: "interface5", sourceOwner: "manual",
    sourceId: waybill, phoneTail: "9501", courierCode: "", companyName: "", manuallyAdded: true,
    createdAtMs: NOW - 3 * 86400000 }, timeline, sourceTimeline: null, manualTimelines: [timeline],
    updatedAtMs: NOW - 3600000 } as unknown as Shipment;
  memory.clear();
  saveState({ ...emptyState(), shipments: [manual], bindings: [] }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
  const stored = loadState(NOW).shipments[0]!;
  assert.equal(shipmentReuseAnchorAtMs(stored, NOW), first, "the row's earliest timed node");
  await runShipmentRefreshForTesting(stored.identity.id, { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
    { trigger: "detail_open" }, {
      queryManualForSource: async () => ({ shipment: null, pending: null, routeUrl: "" }),
      refreshWebTimeline: async () => null,
    });
  assert.deepEqual(bodies, [{ waybill, firstStageCompleted: true, parcelAnchorAtMs: first }]);
  assert.equal(loadState(NOW).shipments[0]!.identity.companyName, "中通快递");

  // 优化 5 续: the row's history later gains a node three days earlier and its carrier is asked again (a blank carrier
  // and a fresh recognition record); the first anchor is sent unchanged.
  const earlier = NOW - 5 * 86400000;
  const grown = { ...timeline, tracks: [...tracks, { timeMs: earlier, timeText: providerTime(earlier),
    detail: "商家已发货", statusCode: "", raw: {} }] };
  const current = loadState(NOW).shipments[0]!;
  saveState({ ...loadState(NOW), shipments: [{ ...current, identity: { ...current.identity, courierCode: "",
    companyName: "" }, timeline: grown, manualTimelines: [grown] }] }, NOW);
  Storage.set("pipi_deliveries_carrier_recognition_v1", "[]", { shared: true });
  assert.equal(shipmentReuseAnchorAtMs(loadState(NOW).shipments[0]!, NOW), earlier, "the history moved by three days");
  await runShipmentRefreshForTesting(stored.identity.id, { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
    { trigger: "detail_open" }, {
      queryManualForSource: async () => ({ shipment: null, pending: null, routeUrl: "" }),
      refreshWebTimeline: async () => null,
    });
  assert.deepEqual(bodies[1], { waybill, firstStageCompleted: true, parcelAnchorAtMs: first },
    "the anchor recorded the first time is sent again");

  // A manual add has no row yet: its recognition sends no anchor.
  Storage.set("pipi_deliveries_carrier_recognition_v1", "[]", { shared: true });
  await detectManualCarrier("MANUAL000009599", { deadlineAtMs: NOW + 30000 });
  assert.deepEqual(bodies[2], { waybill: "MANUAL000009599", firstStageCompleted: true });
}

console.log("carrier classify anchor tests passed");
