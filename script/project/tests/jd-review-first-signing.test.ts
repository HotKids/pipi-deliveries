import assert from "node:assert/strict";
import { test } from "node:test";
import { memory } from "./state-storage-mock";
import type { Shipment, TimelinePackage, TrackNode } from "../models";
import type { AccountParcelDto } from "../services/account-parser";
import { parseAccountSyncResponse, parseAccountTimelineResponse } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { applyAccountShipment, applyTargetedAccountShipment, asAccountDetailObservation,
  hasSettledTimelineHistory, hasUsableShipmentDynamics, jingDongSignedHistoryGap, selectShipmentDetailTimeline,
  selectShipmentTimeline, shipmentDetailIncompleteReason, shipmentSelectionEvidence } from "../services/shipment-policy";
import { mergeAccountParcel, runShipmentRefreshForTesting } from "../services/sync";
import { emptyState, loadState, saveState } from "../services/storage";
import { saveOrderProjectionReferences } from "../services/routes";
import { jingDongSignedAnchorAtMs, parseProviderTime, shipmentPresentationStatus,
  withoutJingDongOrderCompletion } from "../services/status";

// 用户定 2026-09-27（四端同口径）：京东「订单已完成，请评价」节点只有在这一票更早就有结构化签收时才拦掉；
// 否则它就是第一条签收证据，照普通节点留下（能当列表头条、保留自己的时间、留在轨迹里）。更早的签收只认存盘
// 行的 settledAtMs 和同一个包里节点自己的结构化签收（结构化的 Worker 投影；投影缺失或非结构化时看节点自带的状态码，
// 不看文案）；包级 statusEventAtMs 不算；包自己没报结构化签收时照旧拦掉。同日用户又定：「这个已完成只能当作临时轨迹 打开详情页时签收轨迹可以覆盖列表页头条轨迹」，
// 取详情页排第一的包。
// 按一票真实样本的形态构造（运单号、订单号、手机号都换成了合成值）：接口 5 京东运单，
// v5_list 结构化签收 17:52:33，v5_query 最新到 16:16:18 派送中外加 17:52:33 的评价；以前评价被拦，列表
// 「已签收」配 16:16 的派送中。

const ORDER = "3999999000000001", WAYBILL = "JD9990000000001", PHONE = "13800000001";
const REVIEW = `您的订单${ORDER}已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。`;
const REVIEW_TIME = "2026-09-27 17:52:33", REVIEW_AT = 1790502753000;
const DELIVERING = "您的快件正在派送中，请您准备签收";
const HANDED_OVER = "您的快件已送达至【家门口】";
const DAY = 86400000;
const T0 = Date.UTC(2026, 8, 27, 8, 20);
const NOW = Date.UTC(2026, 8, 27, 12);
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });

type Detail = readonly [time: string, desc: string, projection?: Record<string, unknown>];

const providerTime = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
const unknownAt = (at: number) => ({ version: 1, scope: "SHIPMENT", semantic: "UNKNOWN", code: "", text: "",
  priority: 0, eventAtMs: at, structured: false });
const statusAt = (semantic: "COMPLETED" | "DELIVERY", at: number, scope = "ORDER") => ({
  version: 1, scope, semantic, code: semantic === "COMPLETED" ? "107" : "105",
  text: semantic === "COMPLETED" ? scope === "ORDER" ? "已完成" : "已签收" : "派送中",
  priority: semantic === "COMPLETED" ? 6 : 5, eventAtMs: at, structured: true });

/** Interface-5 JD record: every node carries the Worker's Xiaomi projection (UNKNOWN, unstructured). */
function record(mailNo: string, status: ReturnType<typeof statusAt>, details: readonly Detail[]) {
  return { mailNo, provider: "JingDong", cpCode: "JD", name: "京东快递", phone: PHONE,
    stateNum: status.semantic === "COMPLETED" ? 107 : 105, normalizedStatus: status,
    details: details.map(([time, desc, projection]) => ({ time, desc,
      normalizedStatus: projection || unknownAt(parseProviderTime(time)!) })) };
}
const history: readonly Detail[] = [
  ["2026-09-27 16:16:18", DELIVERING],
  ["2026-09-27 07:30:00", "您的快件已到达【深圳南山站】"],
  ["2026-09-26 20:00:00", "您的快件已由京东快递揽收"],
];

function listDto(value: ReturnType<typeof record>) {
  return parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [value] } })[0]!;
}
function owner(direct: boolean, value: ReturnType<typeof record>, at: number): Shipment {
  const mailNo = direct ? WAYBILL : ORDER;
  const dto = parseAccountTimelineResponse("interface5", { code: 0, data: value }, { waybill: mailNo })!;
  return applyAccountShipment(undefined, parcelToShipment({ ...dto, waybill: WAYBILL }, [PHONE], at)!, at);
}
function listRound(current: Shipment, value: ReturnType<typeof record>, at: number): Shipment {
  const rows = mergeAccountParcel({ shipments: [current] } as never, [current], listDto(value),
    [PHONE], "interface5", at, new Map());
  return rows.find((row) => row.identity.id === current.identity.id)!;
}
function queryRound(current: Shipment, value: ReturnType<typeof record>, at: number): Shipment {
  const dto = parseAccountTimelineResponse("interface5", { code: 0, data: value },
    { waybill: current.identity.sourceId })!;
  const incoming = parcelToShipment({ ...dto, waybill: WAYBILL }, [PHONE], at)!;
  return applyTargetedAccountShipment(current, asAccountDetailObservation(current, incoming), at);
}
function persist(row: Shipment, at: number): Shipment {
  saveState({ ...emptyState(), shipments: [row], feedSlotRebuiltAtMs: at }, at);
  return loadState(at + 1000).shipments.find((item) => item.identity.id === row.identity.id)!;
}
const packages = (row: Shipment): TimelinePackage[] => [row.timeline, ...row.sourceTimeline ? [row.sourceTimeline] : [],
  ...row.manualTimelines || [], ...(row.automaticOwnership?.observations || []).map((item) => item.sourceTimeline)];
const hasReview = (timeline: TimelinePackage) => timeline.tracks.some((track) => track.detail === REVIEW);
const queryPackage = (row: Shipment) => (row.manualTimelines || []).find((item) => item.provider === "v5_query");

test("the real sample's clock is 17:52:33 in Asia/Shanghai", () => {
  assert.equal(parseProviderTime(REVIEW_TIME), REVIEW_AT);
});

for (const direct of [false, true]) for (const listCarriesReview of [false, true]) {
  test(`real-sample shape (${direct ? "direct waybill" : "projected order"}, review ${listCarriesReview ? "in list and query" : "in query only"}): the first signing review is kept and heads the list`, () => {
    memory.clear();
    const mailNo = direct ? WAYBILL : ORDER;
    const delivering = persist(owner(direct,
      record(mailNo, statusAt("DELIVERY", parseProviderTime(history[0]![0])!), history), T0), T0);
    assert.equal(delivering.settledAtMs, undefined);
    const listNodes: Detail[] = listCarriesReview ? [[REVIEW_TIME, REVIEW], ...history] : [...history];
    const signedList = record(mailNo, statusAt("COMPLETED", REVIEW_AT), listNodes);
    const query = record(mailNo, statusAt("COMPLETED", REVIEW_AT), [[REVIEW_TIME, REVIEW], ...history]);
    const row = persist(queryRound(listRound(delivering, signedList, NOW), query, NOW), NOW);
    assert.equal(row.settledAtMs, REVIEW_AT, "the first signing stamps the review's own time");
    assert.ok(hasReview(queryPackage(row)!), "the query keeps the review as an ordinary node");
    if (listCarriesReview) assert.ok(hasReview(row.sourceTimeline!), "the feed keeps it too");
    // 「收窄」: between the row's own account packages the review counts, so a review only in v5_query makes
    // v5_query the detail on show and heads the list through the 2026-09-24 exception.
    if (!listCarriesReview) assert.equal(selectShipmentDetailTimeline(row).provider, "v5_query");
    assert.ok(hasReview(selectShipmentDetailTimeline(row)), "the detail shows the review");
    const listed = selectShipmentTimeline(row);
    assert.equal(listed.semantic, "COMPLETED");
    assert.equal(listed.statusEventAtMs, REVIEW_AT);
    assert.equal(listed.latestDetail, REVIEW, "the list headline is the review, not 16:16 派送中");
    assert.equal(listed.latestTimeText, REVIEW_TIME);
    assert.equal(shipmentPresentationStatus({ ...row, timeline: listed }).text, "已签收");
    assert.equal(row.identity.projectedWaybill || row.identity.sourceId, WAYBILL,
      "identity never comes from the review text");

    // (v) Repeated list/query rounds and reads keep the same decision and anchor.
    let again = row;
    for (let round = 1; round <= 2; round++) {
      again = persist(queryRound(listRound(again, signedList, NOW + round * 60000), query, NOW + round * 60000),
        NOW + round * 60000);
      assert.equal(again.settledAtMs, REVIEW_AT);
      assert.ok(hasReview(queryPackage(again)!));
      const shown = selectShipmentTimeline(again);
      assert.equal(shown.latestDetail, REVIEW);
      assert.equal(shown.latestTimeText, REVIEW_TIME);
    }
  });
}

test("a review after a signing stamped days earlier is removed (settledAtMs earlier)", () => {
  memory.clear();
  const signedAt = REVIEW_AT - 3 * DAY;
  const signedNodes: Detail[] = [[providerTime(signedAt), HANDED_OVER], ...history.slice(1).map(
    ([time, desc]) => [providerTime(parseProviderTime(time)! - 3 * DAY), desc] as const)];
  const signed = persist(owner(false, record(ORDER, statusAt("COMPLETED", signedAt), signedNodes),
    signedAt + 60000), signedAt + 60000);
  assert.equal(signed.settledAtMs, signedAt);
  // Xiaomi stamps the package with its newest node's time: the review's own time here.
  const later = record(ORDER, statusAt("COMPLETED", REVIEW_AT), [[REVIEW_TIME, REVIEW], ...signedNodes]);
  const row = persist(queryRound(listRound(signed, later, NOW), later, NOW), NOW);
  assert.equal(row.settledAtMs, signedAt);
  for (const timeline of packages(row)) assert.equal(hasReview(timeline), false, timeline.provider);
  const listed = selectShipmentTimeline(row);
  assert.equal(listed.semantic, "COMPLETED");
  assert.equal(listed.latestDetail, HANDED_OVER);
  assert.equal(listed.latestTimeText, providerTime(signedAt));
});

test("the anchor decides strictly: earlier removes, equal or later keeps, cancelled rows lend none", () => {
  const value = record(ORDER, statusAt("COMPLETED", REVIEW_AT), [[REVIEW_TIME, REVIEW], ...history]);
  const row = owner(false, value, NOW);
  const feed = row.sourceTimeline!;
  assert.ok(hasReview(feed), "without an anchor or node-level signing the review stays at ingestion");
  const clean = (anchor: number) => withoutJingDongOrderCompletion(feed, row.identity, false, anchor);
  assert.equal(clean(REVIEW_AT), feed, "(iii) an equal anchor keeps the review and changes nothing");
  assert.equal(clean(REVIEW_AT + 1000), feed);
  assert.equal(clean(0), feed);
  const removed = clean(REVIEW_AT - 1000);
  assert.equal(hasReview(removed), false, "(ii) an earlier anchor removes it");
  assert.equal(removed.latestDetail, DELIVERING);
  assert.equal(removed.semantic, "COMPLETED");
  assert.equal(removed.statusEventAtMs, REVIEW_AT, "the structured packet keeps its own clock after removal");
  const completed = { timeline: { ...feed, semantic: "COMPLETED" as const }, settledAtMs: REVIEW_AT - 1000 };
  assert.equal(jingDongSignedAnchorAtMs(completed), REVIEW_AT - 1000);
  assert.equal(jingDongSignedAnchorAtMs({ ...completed, timeline: { ...feed, semantic: "CANCELLED" } }), 0,
    "the cancelled window's stamp is no signing evidence");
  assert.equal(jingDongSignedAnchorAtMs({ ...completed, settledAtMs: undefined }), 0);
  // An undated review leaves only when some earlier signing exists.
  const undated = { ...feed, latestDetail: REVIEW, latestTimeText: "", tracks: [
    { ...feed.tracks[0]!, timeMs: null, timeText: "" }, ...feed.tracks.slice(1)] };
  assert.equal(withoutJingDongOrderCompletion(undated, row.identity, false, 0), undated);
  const undatedRemoved = withoutJingDongOrderCompletion(undated, row.identity, false, REVIEW_AT + 1000);
  assert.equal(hasReview(undatedRemoved), false);
  assert.equal(undatedRemoved.latestDetail, DELIVERING);
});

test("(iv) a node-level structured COMPLETED earlier in the same package removes the review", () => {
  const signedAt = parseProviderTime("2026-09-27 16:40:00")!;
  const nodeSigned = statusAt("COMPLETED", signedAt, "SHIPMENT");
  const value = record(ORDER, statusAt("COMPLETED", REVIEW_AT),
    [[REVIEW_TIME, REVIEW], ["2026-09-27 16:40:00", HANDED_OVER, nodeSigned], ...history]);
  const row = owner(false, value, NOW);
  assert.equal(hasReview(row.sourceTimeline!), false);
  assert.equal(row.sourceTimeline!.latestDetail, HANDED_OVER);
  assert.equal(row.sourceTimeline!.latestTimeText, "2026-09-27 16:40:00");
  // Without its own clock the projection falls back to the node's time.
  const undatedProjection = owner(false, record(ORDER, statusAt("COMPLETED", REVIEW_AT),
    [[REVIEW_TIME, REVIEW], ["2026-09-27 16:40:00", HANDED_OVER, { ...nodeSigned, eventAtMs: 0 }], ...history]), NOW);
  assert.equal(hasReview(undatedProjection.sourceTimeline!), false);
  // The review's own structured projection counts too: at its own time it is the first signing.
  const own = owner(false, record(ORDER, statusAt("COMPLETED", REVIEW_AT),
    [[REVIEW_TIME, REVIEW, statusAt("COMPLETED", REVIEW_AT, "SHIPMENT")], ...history]), NOW);
  assert.ok(hasReview(own.sourceTimeline!));
  const ownEarlier = owner(false, record(ORDER, statusAt("COMPLETED", REVIEW_AT),
    [[REVIEW_TIME, REVIEW, statusAt("COMPLETED", signedAt, "SHIPMENT")], ...history]), NOW);
  assert.equal(hasReview(ownEarlier.sourceTimeline!), false);
  // A later node-level signing, an unstructured projection, or the package clock prove nothing earlier.
  const later = owner(false, record(ORDER, statusAt("COMPLETED", REVIEW_AT),
    [["2026-09-27 18:00:00", HANDED_OVER, statusAt("COMPLETED", REVIEW_AT + 60000, "SHIPMENT")],
      [REVIEW_TIME, REVIEW], ...history]), NOW);
  assert.ok(hasReview(later.sourceTimeline!));
  const unstructured = owner(false, record(ORDER, statusAt("COMPLETED", REVIEW_AT),
    [[REVIEW_TIME, REVIEW], ["2026-09-27 16:40:00", HANDED_OVER, { ...nodeSigned, structured: false }], ...history]),
  NOW);
  assert.ok(hasReview(unstructured.sourceTimeline!));
  const packageOnly = owner(false, record(ORDER, statusAt("COMPLETED", signedAt),
    [[REVIEW_TIME, REVIEW], ...history]), NOW);
  assert.ok(hasReview(packageOnly.sourceTimeline!), "the package-level status clock is no earlier evidence");
});

test("(v) a kept review never triggers the settledAtMs repair and survives repeated reads", () => {
  memory.clear();
  const value = record(ORDER, statusAt("COMPLETED", REVIEW_AT), [[REVIEW_TIME, REVIEW], ...history]);
  const base = owner(false, value, NOW);
  // The repair condition: the stored anchor equals the stored status clock the review carries.
  const stored: Shipment = { ...base, settledAtMs: REVIEW_AT };
  assert.equal(stored.timeline.statusEventAtMs, REVIEW_AT);
  assert.ok(hasReview(stored.timeline));
  const first = persist(stored, NOW);
  assert.equal(first.settledAtMs, REVIEW_AT);
  assert.ok(hasReview(first.sourceTimeline!));
  const second = persist(first, NOW + 60000);
  const third = persist(second, NOW + 120000);
  assert.equal(third.settledAtMs, REVIEW_AT);
  assert.deepEqual(third.sourceTimeline, first.sourceTimeline);
  assert.equal(selectShipmentTimeline(third).latestDetail, REVIEW);
  assert.equal(selectShipmentTimeline(third).latestTimeText, REVIEW_TIME);
  const tracks: readonly TrackNode[] = third.sourceTimeline!.tracks;
  assert.equal(tracks.filter((track) => track.detail === REVIEW).length, 1);
});

test("(iv) a node's own raw enum counts when it has no structured Worker projection; its prose never does", () => {
  const row = owner(false, record(ORDER, statusAt("COMPLETED", REVIEW_AT), [[REVIEW_TIME, REVIEW], ...history]), NOW);
  const feed = row.sourceTimeline!;
  const node = (statusCode: string, raw: Record<string, unknown>, detail = HANDED_OVER): TrackNode => ({
    timeText: "2026-09-27 16:40:00", timeMs: parseProviderTime("2026-09-27 16:40:00"), detail, statusCode, raw });
  const withNode = (extra: TrackNode) => ({ ...feed, tracks: [feed.tracks[0]!, extra, ...feed.tracks.slice(1)] });
  const rawSigned = withNode(node("107", { statusCode: "107", _pipiStatusSource: "interface5" }));
  assert.equal(hasReview(withoutJingDongOrderCompletion(rawSigned, row.identity)), false,
    "an earlier node whose own raw enum is 107 proves the earlier signing");
  const projected = withNode(node("107", { statusCode: "107", _pipiStatusSource: "interface5",
    normalizedStatus: unknownAt(parseProviderTime("2026-09-27 16:40:00")!) }));
  assert.equal(hasReview(withoutJingDongOrderCompletion(projected, row.identity)), false,
    "an unstructured Worker projection falls back to the node's raw enum, as Pipi and Lite read it");
  const structuredOther = withNode(node("107", { statusCode: "107", _pipiStatusSource: "interface5",
    normalizedStatus: statusAt("DELIVERY", parseProviderTime("2026-09-27 16:40:00")!, "SHIPMENT") }));
  assert.equal(withoutJingDongOrderCompletion(structuredOther, row.identity), structuredOther,
    "a structured projection of another status is not overridden by the raw enum");
  const prose = withNode(node("", { _pipiStatusSource: "interface5" }, "您的快件已签收"));
  assert.equal(withoutJingDongOrderCompletion(prose, row.identity), prose, "signing prose is no evidence");
  const later = { ...rawSigned, tracks: rawSigned.tracks.map((track) => track.detail === HANDED_OVER
    ? { ...track, timeText: "2026-09-27 18:00:00", timeMs: parseProviderTime("2026-09-27 18:00:00") } : track) };
  assert.equal(withoutJingDongOrderCompletion(later, row.identity), later, "a later raw signing proves nothing earlier");
});

test("the save that first stamps settledAtMs cleans with it: commit, notification and reads agree", () => {
  memory.clear();
  const listSignedAt = parseProviderTime("2026-09-27 17:50:00")!;
  const delivering = persist(owner(false,
    record(ORDER, statusAt("DELIVERY", parseProviderTime(history[0]![0])!), history), T0), T0);
  const list = record(ORDER, statusAt("COMPLETED", listSignedAt), history);
  const query = record(ORDER, statusAt("COMPLETED", REVIEW_AT), [[REVIEW_TIME, REVIEW], ...history]);
  const merged = queryRound(listRound(delivering, list, NOW), query, NOW);
  assert.ok(hasReview(queryPackage(merged)!), "the merge itself has no anchor yet");
  const before = saveState({ ...emptyState(), shipments: [delivering], feedSlotRebuiltAtMs: T0 }, T0);
  const committed = saveState({ ...before, shipments: [merged] }, NOW, { notifyChanges: true });
  const row = committed.shipments[0]!;
  assert.equal(row.settledAtMs, listSignedAt);
  for (const timeline of packages(row)) assert.equal(hasReview(timeline), false, timeline.provider);
  assert.notEqual(selectShipmentTimeline(row).latestDetail, REVIEW);
  assert.ok((committed.pendingNotifications || []).every((item) => item.body !== REVIEW),
    "the pending notification carries the final headline");
  const reread = loadState(NOW + 1000).shipments[0]!;
  assert.deepEqual(reread.manualTimelines, row.manualTimelines);
  assert.equal(selectShipmentTimeline(reread).latestDetail, selectShipmentTimeline(row).latestDetail);
  assert.equal(selectShipmentTimeline(reread).latestTimeText, selectShipmentTimeline(row).latestTimeText);
});

// 京粉页：签收节点 17:52:30（早于评价 3 秒），带「已揽收」。
const UNION_SIGNED = "您的订单已送达至【家门口】，感谢您在京东购物，欢迎再次光临。";
function unionPage(nodes: readonly Detail[], successAtMs: number): TimelinePackage {
  const tracks = nodes.map(([timeText, detail]) => ({ timeText, timeMs: parseProviderTime(timeText), detail,
    statusCode: "", raw: { _pipiStatusSource: "jingdong_h5" } }));
  return { provider: "jd_h5", waybill: WAYBILL, courierCode: "JD", companyName: "京东快递", semantic: "UNKNOWN",
    structuredStatus: false, complete: true, tracks, latestTimeText: tracks[0]!.timeText,
    latestDetail: tracks[0]!.detail, statusEventAtMs: null, successAtMs };
}
const unionHistory: readonly Detail[] = [
  ["2026-09-27 17:52:30", UNION_SIGNED],
  ["2026-09-27 16:16:18", DELIVERING],
  ["2026-09-27 07:30:00", "您的快件已到达【深圳南山站】"],
  ["2026-09-27 02:00:00", "您的快件已离开【深圳分拣中心】"],
  ["2026-09-26 22:00:00", "您的快件已到达【深圳分拣中心】"],
  ["2026-09-26 20:00:00", "您的快件已揽收"],
];

test("real-sample shape: the kept review is a temporary headline; the detail's top package replaces it", () => {
  memory.clear();
  const delivering = persist(owner(false,
    record(ORDER, statusAt("DELIVERY", parseProviderTime(history[0]![0])!), history), T0), T0);
  const signedList = record(ORDER, statusAt("COMPLETED", REVIEW_AT), [[REVIEW_TIME, REVIEW], ...history]);
  const signed = persist(queryRound(listRound(delivering, signedList, NOW), signedList, NOW), NOW);
  assert.equal(selectShipmentTimeline(signed).latestDetail, REVIEW, "until a signing trace exists, the review heads the list");

  // A union page with fewer nodes than the account history (ranked without the temporary review) is not
  // the detail's top package, so the review stays the headline.
  const partial = persist({ ...signed, manualTimelines: [...signed.manualTimelines || [],
    unionPage(unionHistory.slice(0, 2), NOW)] }, NOW + 1000);
  assert.notEqual(selectShipmentDetailTimeline(partial).provider, "jd_h5");
  assert.equal(selectShipmentTimeline(partial).latestDetail, REVIEW);

  const captured = persist({ ...signed, manualTimelines: [...signed.manualTimelines || [],
    unionPage(unionHistory, NOW)] }, NOW + 2000);
  assert.equal(selectShipmentDetailTimeline(captured).provider, "jd_h5", "the complete union page ranks first");
  const listed = selectShipmentTimeline(captured);
  assert.equal(listed.latestDetail, UNION_SIGNED, "the union page's signing replaces the review in the list");
  assert.equal(listed.latestTimeText, "2026-09-27 17:52:30");
  assert.equal(listed.semantic, "COMPLETED");
  assert.equal(listed.statusEventAtMs, REVIEW_AT, "status and its clock stay the feed's");
  assert.equal(shipmentSelectionEvidence(captured).headlineProvider, "jd_h5");
  assert.ok(hasReview(captured.sourceTimeline!), "the review stays in the feed's own history");
  assert.equal(captured.settledAtMs, REVIEW_AT);
});

function gapParcel(unionPageBefore: boolean): AccountParcelDto {
  const tracks = [[REVIEW_TIME, REVIEW], ["2026-09-27 16:16:18", DELIVERING],
    ["2026-09-27 07:30:00", "您的快件已到达【深圳南山站】"], ["2026-09-26 20:00:00", "您的快件已揽收"]]
    .map(([timeText, detail]) => ({ timeText, detail, statusCode: "" }));
  return {
    source: "interface5", ownerId: ORDER, orderId: ORDER, accountOrder: true, waybill: WAYBILL,
    courierCode: "JD", rawCourierCode: "JD", companyName: "京东快递", sourceProvider: "JingDong",
    sourceStateCode: "107", sourceStateText: "已完成", semantic: "COMPLETED", normalizedStatusScope: "ORDER",
    normalizedStatusSemantic: "COMPLETED", normalizedStatusText: "已完成", normalizedStatus: statusAt("COMPLETED", REVIEW_AT),
    receiverPhone: PHONE, senderPhone: "", latestTimeText: tracks[0]!.timeText, latestDetail: tracks[0]!.detail,
    tracks, routeUrl: "", projectionUrl: "https://u.jd.com/forward?test=kept-review",
    // A union page captured before the completion, still at 派送中.
    ...unionPageBefore ? { projectionTimeline: unionPage(unionHistory.slice(1), REVIEW_AT - 3600000) } : {},
  } as unknown as AccountParcelDto;
}

for (const unionPageBefore of [false, true]) test(`a detail pull still opens the union page once when only the kept review reaches the signing (${unionPageBefore ? "old union page cached" : "no union page yet"})`, async () => {
  memory.clear();
  const row = parcelToShipment(gapParcel(unionPageBefore), [PHONE], NOW)!;
  const state = saveState({ ...emptyState(), shipments: [row], feedSlotRebuiltAtMs: NOW, bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - DAY }] }, NOW);
  saveOrderProjectionReferences([{ ownerId: row.identity.id, source: "interface5",
    url: gapParcel(unionPageBefore).projectionUrl }], NOW);
  const stored = state.shipments[0]!;
  assert.ok(hasReview(stored.sourceTimeline!));
  assert.equal(jingDongSignedHistoryGap(stored), true);
  // A union page captured before the completion competes with the review counted (「要求」), so the feed
  // with the review stays the detail on show and the list headline. The gates read the row as HEAD did,
  // without the temporary review, so its history stops before the signing.
  assert.equal(selectShipmentDetailTimeline(stored).provider, "interface5");
  assert.equal(selectShipmentTimeline(stored).latestDetail, REVIEW, "before the pull the review heads the list");
  assert.equal(shipmentDetailIncompleteReason(stored), "time_mismatch");
  let captures = 0, v5Queries = 0;
  const unexpected: string[] = [];
  const overrides = {
    refreshAccountParcel: async (): Promise<AccountParcelDto | null> => { v5Queries++; throw new Error("no v5"); },
    refreshWebTimeline: async () => { unexpected.push("web"); throw new Error("no web"); },
    queryManualForSource: async () => { unexpected.push("manual"); throw new Error("no manual"); },
    projectAccountOrderWithCarrier: async (input: AccountParcelDto) => {
      captures++;
      return { ...input, waybill: WAYBILL, projectionTimeline: unionPage(unionHistory, NOW) };
    },
  };
  const lease = { isCurrent: () => true, deadlineAtMs: NOW + 30000 };
  const pull = { trigger: "detail_pull" as const, forceManualRefresh: true, includeKdniaoFallback: true };
  const result = await runShipmentRefreshForTesting(row.identity.id, lease, pull, overrides as never);
  assert.equal(captures, 1, "the pull opens the union page once");
  assert.equal(v5Queries, 0);
  assert.deepEqual(unexpected, [], "K100, the manual chain and KDNiao stay behind the feed's pickup");
  const after = loadState(NOW).shipments[0]!;
  assert.equal(selectShipmentDetailTimeline(after).provider, "jd_h5");
  assert.equal(selectShipmentTimeline(after).latestDetail, UNION_SIGNED);
  assert.equal(selectShipmentTimeline(after).latestTimeText, "2026-09-27 17:52:30");
  assert.equal(selectShipmentTimeline(result.shipment).latestDetail, UNION_SIGNED);
  // Once per completion: the capture after the completion is the final history.
  assert.equal(jingDongSignedHistoryGap(after), false);
  await runShipmentRefreshForTesting(row.identity.id, lease, pull, overrides as never);
  assert.equal(captures, 1, "a second pull does not reopen the page");
});

test("a union page captured before the completion never replaces the temporary review; one captured after does", () => {
  memory.clear();
  const delivering = persist(owner(false,
    record(ORDER, statusAt("DELIVERY", parseProviderTime(history[0]![0])!), history), T0), T0);
  const signedList = record(ORDER, statusAt("COMPLETED", REVIEW_AT), [[REVIEW_TIME, REVIEW], ...history]);
  const signed = persist(queryRound(listRound(delivering, signedList, NOW), signedList, NOW), NOW);
  for (const [capturedAt, replaces] of [[REVIEW_AT - 1000, false], [REVIEW_AT, true], [NOW, true]] as const) {
    const row = persist({ ...signed, manualTimelines: [...signed.manualTimelines || [],
      unionPage(unionHistory, capturedAt)] }, NOW + 1000);
    assert.equal(selectShipmentDetailTimeline(row).provider, "jd_h5", "the complete union page ranks first");
    const listed = selectShipmentTimeline(row);
    assert.equal(listed.latestDetail, replaces ? UNION_SIGNED : REVIEW, `captured at ${capturedAt}`);
    assert.equal(listed.latestTimeText, replaces ? "2026-09-27 17:52:30" : REVIEW_TIME);
  }
});

test("review only in v5_query with an older pre-completion union page: the review shows until a post-completion capture", () => {
  memory.clear();
  const delivering = persist(owner(false,
    record(ORDER, statusAt("DELIVERY", parseProviderTime(history[0]![0])!), history), T0), T0);
  const list = record(ORDER, statusAt("COMPLETED", REVIEW_AT), history);
  const query = record(ORDER, statusAt("COMPLETED", REVIEW_AT), [[REVIEW_TIME, REVIEW], ...history]);
  const signed = persist(queryRound(listRound(delivering, list, NOW), query, NOW), NOW);
  assert.equal(hasReview(signed.sourceTimeline!), false, "the list itself stops at 16:16:18");
  // An older union page with more real nodes (5 to the account's 3), captured before the completion.
  const withOld = persist({ ...signed, manualTimelines: [...signed.manualTimelines || [],
    unionPage(unionHistory.slice(1), REVIEW_AT - 3600000)] }, NOW + 1000);
  const detail = selectShipmentDetailTimeline(withOld);
  assert.equal(detail.provider, "v5_query", "a pre-completion page competes with the review counted");
  assert.ok(hasReview(detail));
  assert.equal(selectShipmentTimeline(withOld).latestDetail, REVIEW);
  assert.equal(selectShipmentTimeline(withOld).latestTimeText, REVIEW_TIME);
  // A later capture after the completion replaces the old page, ranks first and takes the list headline.
  const withNew = persist({ ...withOld, manualTimelines: [...(withOld.manualTimelines || [])
    .filter((timeline) => timeline.provider !== "jd_h5"), unionPage(unionHistory, NOW + 60000)] }, NOW + 60000);
  assert.equal(selectShipmentDetailTimeline(withNew).provider, "jd_h5");
  assert.equal(selectShipmentTimeline(withNew).latestDetail, UNION_SIGNED);
  assert.equal(selectShipmentTimeline(withNew).latestTimeText, "2026-09-27 17:52:30");
});

test("a post-completion union page may outrank the account only because the review stops counting", () => {
  memory.clear();
  const delivering = persist(owner(false,
    record(ORDER, statusAt("DELIVERY", parseProviderTime(history[0]![0])!), history), T0), T0);
  const signedList = record(ORDER, statusAt("COMPLETED", REVIEW_AT), [[REVIEW_TIME, REVIEW], ...history]);
  const signed = persist(queryRound(listRound(delivering, signedList, NOW), signedList, NOW), NOW);
  // No recognised pickup: incomplete, but five real nodes to the account's three once the review is set aside.
  const nodes = unionHistory.slice(0, 5);
  for (const [capturedAt, wins] of [[REVIEW_AT - 1000, false], [NOW, true]] as const) {
    const row = persist({ ...signed, manualTimelines: [...signed.manualTimelines || [],
      unionPage(nodes, capturedAt)] }, NOW + 1000);
    assert.equal(selectShipmentDetailTimeline(row).provider === "jd_h5", wins, `captured at ${capturedAt}`);
    assert.equal(selectShipmentTimeline(row).latestDetail, wins ? UNION_SIGNED : REVIEW);
  }
});

// 用户 2026-09-28「改成严格晚于」：完成之后抓到、详情排第一的京粉页，最新一条只是账号自己最后那条（同一时间的
// 「派送中」）时，列表仍显示这条临时评价；严格晚于账号最后一条的节点才换上去。
test("a post-completion union page replaces the temporary review only with a node strictly later than the account's", () => {
  memory.clear();
  const delivering = persist(owner(false,
    record(ORDER, statusAt("DELIVERY", parseProviderTime(history[0]![0])!), history), T0), T0);
  const signedList = record(ORDER, statusAt("COMPLETED", REVIEW_AT), [[REVIEW_TIME, REVIEW], ...history]);
  const signed = persist(queryRound(listRound(delivering, signedList, NOW), signedList, NOW), NOW);
  const sameTime = persist({ ...signed, manualTimelines: [...signed.manualTimelines || [],
    unionPage(unionHistory.slice(1), NOW)] }, NOW + 1000);
  assert.equal(selectShipmentDetailTimeline(sameTime).provider, "jd_h5", "the post-completion page ranks first");
  assert.equal(selectShipmentTimeline(sameTime).latestDetail, REVIEW, "the same 派送中 at the same time is no newer");
  assert.equal(selectShipmentTimeline(sameTime).latestTimeText, REVIEW_TIME);

  const laterAt = "2026-09-27 16:17:18";
  const later = persist({ ...signed, manualTimelines: [...signed.manualTimelines || [],
    unionPage([[laterAt, DELIVERING], ...unionHistory.slice(2)], NOW)] }, NOW + 2000);
  assert.equal(selectShipmentDetailTimeline(later).provider, "jd_h5");
  assert.equal(selectShipmentTimeline(later).latestDetail, DELIVERING);
  assert.equal(selectShipmentTimeline(later).latestTimeText, laterAt);
});

// 用户 2026-10-01「除了 13 14 16 17 其他都做」（含「评价节点当临时头条那一支要不要也改成「不晚于」」）：账号自己最新的非评价节点 B 与结构化
// 完成时间同一秒。B 不晚于完成时间，完成之后抓到、详情排第一的京粉页里严格晚于 B 的节点照样换掉临时评价。
test("a temporary review at the same second as the account's last real node still hands the list to a strictly later node", () => {
  memory.clear();
  const sameSecond = "您的快件已到达【深圳测试驿站】";
  const delivering = persist(owner(false,
    record(ORDER, statusAt("DELIVERY", parseProviderTime(history[0]![0])!), history), T0), T0);
  const signedList = record(ORDER, statusAt("COMPLETED", REVIEW_AT),
    [[REVIEW_TIME, REVIEW], [REVIEW_TIME, sameSecond], ...history]);
  const signed = persist(queryRound(listRound(delivering, signedList, NOW), signedList, NOW), NOW);
  assert.ok(signed.sourceTimeline!.tracks.some((track) => track.detail === sameSecond));
  assert.equal(selectShipmentTimeline(signed).latestDetail, REVIEW, "the review is the temporary headline");

  const laterTime = "2026-09-27 17:53:33";
  const row = persist({ ...signed, manualTimelines: [...signed.manualTimelines || [],
    unionPage([[laterTime, UNION_SIGNED], [REVIEW_TIME, sameSecond], ...unionHistory.slice(1)], NOW)] }, NOW + 1000);
  assert.equal(selectShipmentDetailTimeline(row).provider, "jd_h5", "the post-completion page ranks first");
  const listed = selectShipmentTimeline(row);
  assert.equal(listed.latestDetail, UNION_SIGNED);
  assert.equal(listed.latestTimeText, laterTime);
  assert.equal(listed.semantic, "COMPLETED");
  assert.equal(listed.statusEventAtMs, REVIEW_AT, "status and its clock stay the feed's");
  assert.ok(hasReview(row.sourceTimeline!), "the review stays in the feed's own history");
});

test("「要求」: a review in a package without structured signing is removed as before", () => {
  // Unstructured ORDER-scope 已完成 with the review as its only node: removed, and the order status is invalidated.
  const orderOnly = record(ORDER, { ...statusAt("COMPLETED", REVIEW_AT), structured: false } as never, [[REVIEW_TIME, REVIEW]]);
  const row = owner(false, orderOnly, NOW);
  assert.equal(hasReview(row.sourceTimeline!), false);
  assert.equal(row.sourceTimeline!.semantic, "UNKNOWN");
  // A package whose own node reports structured signing keeps a first-signing review even without a package enum.
  const nodeSigned = record(ORDER, statusAt("DELIVERY", parseProviderTime("2026-09-27 16:16:18")!, "SHIPMENT"),
    [[REVIEW_TIME, REVIEW, statusAt("COMPLETED", REVIEW_AT, "SHIPMENT")], ...history]);
  assert.ok(hasReview(owner(false, nodeSigned, NOW).sourceTimeline!));
  // An unknown packet whose nodes report nothing: removed.
  const unknown = record(ORDER, { ...unknownAt(REVIEW_AT) } as never, [[REVIEW_TIME, REVIEW], ...history]);
  assert.equal(hasReview(owner(false, unknown, NOW).sourceTimeline!), false);
});

test("gates read the row without temporary reviews, as HEAD did", () => {
  memory.clear();
  // Review only, structured completion: the display keeps it, the gates see an empty history.
  const reviewOnly = persist(owner(false, record(ORDER, statusAt("COMPLETED", REVIEW_AT), [[REVIEW_TIME, REVIEW]]), NOW), NOW);
  assert.equal(selectShipmentTimeline(reviewOnly).latestDetail, REVIEW);
  assert.equal(shipmentDetailIncompleteReason(reviewOnly), "no_tracks");
  assert.equal(hasUsableShipmentDynamics(reviewOnly), false);
  assert.equal(hasSettledTimelineHistory(reviewOnly, NOW + 1000), false);
});

test("the post-completion comparison runs before a pre-completion package can win the review-counted ranking", () => {
  memory.clear();
  const delivering = persist(owner(false,
    record(ORDER, statusAt("DELIVERY", parseProviderTime(history[0]![0])!), history), T0), T0);
  const signedList = record(ORDER, statusAt("COMPLETED", REVIEW_AT), [[REVIEW_TIME, REVIEW], ...history]);
  const signed = persist(queryRound(listRound(delivering, signedList, NOW), signedList, NOW), NOW);
  // A complete union page captured before the completion (7 nodes, newest 17:30) ...
  const preNodes: Detail[] = [["2026-09-27 17:30:00", "您的快件已到达【深圳南山站】，准备派送"], ...unionHistory.slice(1)];
  const pre = unionPage(preNodes, REVIEW_AT - 60000);
  // ... and a complete Picker package captured after it (5 nodes, newest 17:52:30).
  const picker: TimelinePackage = { ...unionPage([unionHistory[0]!, unionHistory[1]!, unionHistory[2]!,
    unionHistory[4]!, unionHistory[5]!], NOW), provider: "v6_query" };
  const row = persist({ ...signed, manualTimelines: [...signed.manualTimelines || [], pre, picker] }, NOW + 1000);
  assert.equal(selectShipmentDetailTimeline(row).provider, "v6_query");
  assert.equal(selectShipmentTimeline(row).latestDetail, UNION_SIGNED);
});

test("a review pushed twice within five minutes is judged once, at the newer copy's time (K15)", () => {
  const firstCopy = "2026-09-27 17:50:00";
  const value = record(ORDER, statusAt("COMPLETED", REVIEW_AT), [[REVIEW_TIME, REVIEW], [firstCopy, REVIEW], ...history]);
  const row = owner(false, value, NOW);
  const feed = { ...row.sourceTimeline!, tracks: [
    ...row.sourceTimeline!.tracks.filter((track) => track.detail !== REVIEW),
    ...[REVIEW_TIME, firstCopy].map((timeText) => ({ timeText, timeMs: parseProviderTime(timeText), detail: REVIEW,
      statusCode: "", raw: { _pipiStatusSource: "interface5" } })),
  ] };
  const reviews = (timeline: TimelinePackage) => timeline.tracks.filter((track) => track.detail === REVIEW).length;
  assert.equal(reviews(feed), 2);
  // Signed at the first copy's time, and that copy is in the package: the anchor is the review's own copy, no earlier
  // signing, so both copies stay (用户 2026-09-28「修，按规则保留」; both went before).
  assert.equal(withoutJingDongOrderCompletion(feed, row.identity, false, parseProviderTime(firstCopy)!), feed);
  // Signed at the newer copy's time, or unknown: the collapsed review is the first signing and both copies stay.
  assert.equal(withoutJingDongOrderCompletion(feed, row.identity, false, REVIEW_AT), feed);
  assert.equal(withoutJingDongOrderCompletion(feed, row.identity), feed);
  // Merged into the row's own query history (mergeTracks) the copies are one node at the newer time, kept as the
  // first signing.
  memory.clear();
  const delivering = persist(owner(false,
    record(ORDER, statusAt("DELIVERY", parseProviderTime(history[0]![0])!), history), T0), T0);
  const queried = persist(queryRound(delivering,
    record(ORDER, statusAt("DELIVERY", parseProviderTime(history[0]![0])!), history), T0 + 1000), T0 + 1000);
  const merged = persist(queryRound(queried, value, NOW), NOW);
  assert.deepEqual(queryPackage(merged)!.tracks.filter((track) => track.detail === REVIEW)
    .map((track) => track.timeText), [REVIEW_TIME]);
  // A row already signed at the first copy's time drops both copies of the later push: judged uncollapsed, the
  // 17:50:00 copy (not after the anchor) would have stayed.
  memory.clear();
  const signedEarlier = persist(listRound(queried, record(ORDER, statusAt("COMPLETED", parseProviderTime(firstCopy)!),
    history), NOW), NOW);
  assert.equal(signedEarlier.settledAtMs, parseProviderTime(firstCopy));
  const pushedTwice = persist(queryRound(signedEarlier, value, NOW + 1000), NOW + 1000);
  for (const timeline of packages(pushedTwice)) assert.equal(hasReview(timeline), false, timeline.provider);
});

test("a review removed after an earlier signing still lets the 2026-09-24 swap take the detail's signed node", () => {
  memory.clear();
  const signedAt = parseProviderTime("2026-09-27 17:52:00")!;
  const delivering = persist(owner(false,
    record(ORDER, statusAt("DELIVERY", parseProviderTime(history[0]![0])!), history), T0), T0);
  // The list signs the parcel at 17:52:00 without a node, then repeats the completion with a later review.
  const signed = persist(listRound(delivering, record(ORDER, statusAt("COMPLETED", signedAt), history), NOW), NOW);
  assert.equal(signed.settledAtMs, signedAt);
  const withReview = persist(listRound(signed,
    record(ORDER, statusAt("COMPLETED", signedAt), [[REVIEW_TIME, REVIEW], ...history]), NOW + 1000), NOW + 1000);
  for (const timeline of packages(withReview)) assert.equal(hasReview(timeline), false, timeline.provider);
  assert.equal(selectShipmentTimeline(withReview).latestTimeText, "2026-09-27 16:16:18");
  const signedNode = "2026-09-27 17:51:30";
  const captured = persist({ ...withReview, manualTimelines: [...withReview.manualTimelines || [],
    unionPage([[signedNode, UNION_SIGNED], ...unionHistory.slice(1)], REVIEW_AT - 3600000)] }, NOW + 2000);
  assert.equal(selectShipmentDetailTimeline(captured).provider, "jd_h5");
  const listed = selectShipmentTimeline(captured);
  assert.equal(listed.latestDetail, UNION_SIGNED, "the feed's completion is later than its headline: the swap applies");
  assert.equal(listed.latestTimeText, signedNode);
  assert.equal(shipmentSelectionEvidence(captured).headlineProvider, "jd_h5");
});

// 同一条评价 5 分钟内推了两次、两份都自己带签收（结构化投影或原始 107），此前没有签收：签收证据也按 K15 合并后的
// 时间线量（较新那份的时间），较早那份不能当「更早的签收」把自己删掉。相隔超过 5 分钟就是两个节点：较早那份是第一条
// 签收、留着，之后那份照删。
for (const structured of [true, false]) test(`signing review copies are measured on the collapsed timeline (${structured ? "structured projection" : "raw enum"})`, () => {
  const row = owner(false, record(ORDER, statusAt("COMPLETED", REVIEW_AT), [[REVIEW_TIME, REVIEW], ...history]), NOW);
  const signingReview = (timeText: string): TrackNode => {
    const timeMs = parseProviderTime(timeText)!;
    return structured
      ? { timeText, timeMs, detail: REVIEW, statusCode: "",
        raw: { _pipiStatusSource: "interface5", normalizedStatus: statusAt("COMPLETED", timeMs, "SHIPMENT") } }
      : { timeText, timeMs, detail: REVIEW, statusCode: "107",
        raw: { statusCode: "107", _pipiStatusSource: "interface5" } };
  };
  const withCopies = (times: readonly string[]): TimelinePackage => ({ ...row.sourceTimeline!, tracks: [
    ...times.map(signingReview), ...row.sourceTimeline!.tracks.filter((track) => track.detail !== REVIEW)] });
  const reviewTimes = (timeline: TimelinePackage) =>
    timeline.tracks.filter((track) => track.detail === REVIEW).map((track) => track.timeText);

  const twins = withCopies([REVIEW_TIME, "2026-09-27 17:50:33"]);
  assert.equal(withoutJingDongOrderCompletion(twins, row.identity), twins,
    "twin copies with no earlier signing: the collapsed review is the first signing and both copies stay");

  const apart = withCopies(["2026-09-27 17:58:34", REVIEW_TIME]);
  const cleaned = withoutJingDongOrderCompletion(apart, row.identity);
  assert.deepEqual(reviewTimes(cleaned), [REVIEW_TIME],
    "more than five minutes apart: the first copy is the first signing, the later one is removed");
  assert.equal(cleaned.latestDetail, REVIEW);
  assert.equal(cleaned.latestTimeText, REVIEW_TIME);
});

// 用户 2026-09-28「修，按规则保留」：第一轮评价是第一条签收（settledAtMs 记在 17:52:33），第二轮同一条评价 2 分钟后又
// 推了一份（列表和 query 里两份都在）。存下的签收就是这条评价自己的一份，不算更早的签收：评价留着、仍是列表表头，
// 存盘重读照旧。相隔超过 5 分钟的那份照删；存下的签收是另一个节点的，评价照删。
const TWIN_TIME = "2026-09-27 17:54:33";
function signedByReview(): Shipment {
  memory.clear();
  const delivering = persist(owner(false,
    record(ORDER, statusAt("DELIVERY", parseProviderTime(history[0]![0])!), history), T0), T0);
  const queried = persist(queryRound(delivering,
    record(ORDER, statusAt("DELIVERY", parseProviderTime(history[0]![0])!), history), T0 + 1000), T0 + 1000);
  const signedList = record(ORDER, statusAt("COMPLETED", REVIEW_AT), [[REVIEW_TIME, REVIEW], ...history]);
  const signed = persist(queryRound(listRound(queried, signedList, NOW), signedList, NOW), NOW);
  assert.equal(signed.settledAtMs, REVIEW_AT);
  assert.equal(selectShipmentTimeline(signed).latestDetail, REVIEW);
  return signed;
}

test("a cross-round twin of the first-signing review is kept and stays the list headline", () => {
  const signed = signedByReview();
  const twice = record(ORDER, statusAt("COMPLETED", parseProviderTime(TWIN_TIME)!),
    [[TWIN_TIME, REVIEW], [REVIEW_TIME, REVIEW], ...history]);
  let row = persist(queryRound(listRound(signed, twice, NOW + 1000), twice, NOW + 1000), NOW + 1000);
  for (let read = 0; read < 2; read++) {
    assert.equal(row.settledAtMs, REVIEW_AT, "the stored completion stays the first copy's");
    assert.equal(selectShipmentTimeline(row).latestDetail, REVIEW, `read ${read}`);
    assert.ok(hasReview(queryPackage(row)!), `read ${read}: the query keeps the review`);
    row = loadState(NOW + 5000 + read).shipments.find((item) => item.identity.id === row.identity.id)!;
  }
});

test("a cross-round copy more than five minutes after the stored first signing is still removed", () => {
  const signed = signedByReview();
  const laterTime = "2026-09-27 17:58:34";
  const later = record(ORDER, statusAt("COMPLETED", parseProviderTime(laterTime)!),
    [[laterTime, REVIEW], [REVIEW_TIME, REVIEW], ...history]);
  const row = persist(queryRound(listRound(signed, later, NOW + 1000), later, NOW + 1000), NOW + 1000);
  const query = queryPackage(row)!;
  assert.deepEqual(query.tracks.filter((track) => track.detail === REVIEW).map((track) => track.timeText),
    [REVIEW_TIME], "the later copy goes, the first signing stays");
  assert.equal(selectShipmentTimeline(row).latestTimeText, REVIEW_TIME);
});

test("a stored signing on a different node still removes the review", () => {
  const signed = signedByReview();
  const feed = signed.sourceTimeline!;
  // The stored completion is a different node's (已送达 17:52:30, no status of its own), three seconds before.
  const deliveredAt = parseProviderTime("2026-09-27 17:52:30")!;
  const withDelivery = { ...feed, tracks: [feed.tracks[0]!, { timeText: "2026-09-27 17:52:30", timeMs: deliveredAt,
    detail: HANDED_OVER, statusCode: "", raw: { _pipiStatusSource: "interface5" } }, ...feed.tracks.slice(1)] };
  assert.equal(hasReview(withoutJingDongOrderCompletion(withDelivery, signed.identity, false, deliveredAt)), false);
  // Nothing at the stored completion's second shows it was this review: it stays earlier signing evidence.
  assert.equal(hasReview(withoutJingDongOrderCompletion(feed, signed.identity, false, REVIEW_AT - 1000)), false);
});
