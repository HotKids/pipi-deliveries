import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { NormalizedStatus, Shipment, StatusSemantic, TimelinePackage } from "../models";
import { parseAccountSyncResponse } from "../services/account-parser";
import { parseMeizuTimeline } from "../services/manual-query-parser";
import {
  BOOTSTRAP_STATUS_LABEL_TABLE,
  installStatusLabelTable,
  parseStatusLabelTable,
  resetStatusLabelTableForTesting,
  statusDisplay,
} from "../services/status-labels";
import {
  buildWidgetSnapshot,
  mergeTimelinePackage,
  shipmentPresentationStatus,
  sortShipments,
  statusTextAccent,
} from "../services/status";
import { applyManualShipment } from "../services/shipment-policy";

// Owner decision 2026-11-20 (「清关中怎么变成了异常件 应该属于运输中吧 然后如果可以抓到清关中的状态就显示清关中
// 属于运输中的分支」): Meizu v6 puts Kuaidi100's customs states into its coarse FAILED bucket and keeps the
// structured state name in logisticsStatusDesc. The shape is the VPS raw Online answer (waybill replaced).
// FAILED + 清关中 is TRANSIT shown 清关中; 待清关 / 已清关 are 运输中; anything else stays 异常件. Sorting and
// colour follow 运输中. Both Worker tracks carry the subtype (owner 2026-11-20, "Formal and beta") and the
// bundled table is generated from the formal Worker; it is also installed here the way a Worker snapshot
// installs it.
const CUSTOMS_SUBTYPE = { semantic: "TRANSIT", code: "CUSTOMS_CLEARANCE", label: "清关中", priority: 1 } as const;
const STAMP = "2026-11-20 17:28:31";
const AT = Date.UTC(2026, 10, 20, 9, 28, 31);
const NOW = Date.UTC(2026, 10, 20, 10, 0, 0);

function online(description: string | undefined, extra: Record<string, unknown> = {}) {
  return {
    code: 200,
    value: JSON.stringify({
      mailNo: "77100000000001", cpCode: "zhongtongguoji", cpName: "中通国际", fromCp: "KD-100",
      logsiticsStatus: "FAILED", lastLogisticDetail: "[中国]进行处理，快件已开始清关",
      logisticsGmtModified: STAMP,
      ...(description === undefined ? {} : { logisticsStatusDesc: description }),
      ...extra,
    }),
  };
}

const withSubtype = parseStatusLabelTable({
  ...BOOTSTRAP_STATUS_LABEL_TABLE,
  subtypes: [...BOOTSTRAP_STATUS_LABEL_TABLE.subtypes.filter((value) => value.code !== CUSTOMS_SUBTYPE.code),
    CUSTOMS_SUBTYPE],
});
assert.ok(withSubtype);
assert.equal(installStatusLabelTable(withSubtype), true);

// Local Meizu parse (no Worker projection): FAILED + 清关中 → the Worker's TRANSIT subtype projection.
{
  const parsed = parseMeizuTimeline(online("清关中"));
  assert.equal(parsed.semantic, "TRANSIT");
  assert.equal(parsed.statusEventAtMs, AT);
  assert.equal(parsed.hasStructuredStatus, true);
  assert.deepEqual(parsed.normalizedStatus, { version: 1, scope: "SHIPMENT", semantic: "TRANSIT",
    code: "CUSTOMS_CLEARANCE", text: "清关中", priority: 1, eventAtMs: AT, structured: true });
  assert.equal(parsed.tracks.length, 1);
  assert.equal((parsed.tracks[0].raw.normalizedStatus as NormalizedStatus).code, "CUSTOMS_CLEARANCE",
    "the node carries the same projection, so node readers see TRANSIT");
  assert.equal(statusDisplay({ scope: "SHIPMENT", semantic: "TRANSIT", code: "CUSTOMS_CLEARANCE" }).label, "清关中");
  const named = parseMeizuTimeline(online(undefined, { stateName: "清关中" }));
  assert.equal(named.normalizedStatus?.code, "CUSTOMS_CLEARANCE", "stateName is the other description field");
}

for (const description of ["待清关", "已清关"]) {
  const parsed = parseMeizuTimeline(online(description));
  assert.equal(parsed.semantic, "TRANSIT", description);
  assert.equal(parsed.normalizedStatus?.code, "TRANSIT", description);
  assert.equal(parsed.normalizedStatus?.text, "运输中", description);
}

for (const description of ["清关异常", "问题件", "", undefined, "清关中了"]) {
  const parsed = parseMeizuTimeline(online(description));
  assert.equal(parsed.semantic, "DANGER", String(description));
  assert.equal(parsed.normalizedStatus, undefined, String(description));
}
assert.equal(parseMeizuTimeline(online(undefined, { lastLogisticDetail: "清关中" })).semantic, "DANGER",
  "the track text is never status evidence");
assert.equal(parseMeizuTimeline(online("清关中", { logsiticsStatus: "SIGN" })).semantic, "COMPLETED",
  "the description refines only FAILED");

// The VPS Online scalar spells the coarse field logisticsStatus; the owner's plan names all four v6
// spellings for the FAILED trigger (Worker order), and the owner's 2026-11-21 answer 「Read it for every
// status」 lets that spelling decide every Online status.
for (const field of ["logisticsStatus", "status", "state"]) {
  const { logsiticsStatus: _misspelled, ...record } = JSON.parse(online("清关中").value) as Record<string, unknown>;
  const parsed = parseMeizuTimeline({ code: 200, value: JSON.stringify({ ...record, [field]: "FAILED" }) });
  assert.equal(parsed.semantic, "TRANSIT", field);
  assert.equal(parsed.normalizedStatus?.code, "CUSTOMS_CLEARANCE", field);
}
{
  const conflict = parseMeizuTimeline(online("清关中", { logsiticsStatus: "SIGN", logisticsStatus: "FAILED" }));
  assert.equal(conflict.normalizedStatus, undefined, "a disagreeing recognized spelling is no FAILED bucket");
  const { logsiticsStatus: _misspelled, ...record } = JSON.parse(online("清关异常").value) as Record<string, unknown>;
  const other = parseMeizuTimeline({ code: 200, value: JSON.stringify({ ...record, logisticsStatus: "FAILED" }) });
  assert.equal(other.normalizedStatus, undefined, "清关异常 is no customs refinement");
  // Owner 2026-11-21 「Read it for every status」: logisticsStatus FAILED + 清关异常 is 异常件, as the Worker,
  // Lite and the Bot read it.
  assert.equal(other.semantic, "DANGER");
  assert.equal(other.statusEventAtMs, AT);
}

// Two status nodes at one clock (plain 运输中 and FAILED + 清关中) give the 清关中 subtype in either order,
// the Worker's selectStatusEvidence answer.
for (const reversed of [false, true]) {
  const nodes = [
    { time: STAMP, logsiticsStatus: "TRANSPORT", context: "Carrier event A" },
    { time: STAMP, logsiticsStatus: "FAILED", logisticsStatusDesc: "清关中", context: "Carrier event B" },
  ];
  const parsed = parseMeizuTimeline({ code: 200, value: JSON.stringify({ mailNo: "77100000000001",
    tracks: reversed ? nodes.reverse() : nodes }) });
  assert.equal(parsed.semantic, "TRANSIT", String(reversed));
  assert.deepEqual(parsed.normalizedStatus, { version: 1, scope: "SHIPMENT", semantic: "TRANSIT",
    code: "CUSTOMS_CLEARANCE", text: "清关中", priority: 1, eventAtMs: AT, structured: true }, String(reversed));
}

// The Worker-generated shared provider fixture ties this local copy of the FAILED-description policy to
// the Worker: every v6 case must give the Worker's semantic and label, and the Worker's projection when
// the refinement applies. Kuaidi100 and KDNiao reach iOS already projected by the Worker.
{
  const parity = JSON.parse(readFileSync(
    new URL("./fixtures/express/provider-status-parity.v1.json", import.meta.url), "utf8"));
  const cases = parity.cases.filter((value: { provider: string }) => value.provider === "v6");
  assert.ok(cases.length >= 8, "the shared fixture carries the customs v6 cases");
  for (const value of cases) {
    const parsed = parseMeizuTimeline(value.input);
    const expected = value.expected as NormalizedStatus;
    assert.equal(parsed.semantic, expected.semantic, value.name);
    assert.equal(parsed.statusEventAtMs, expected.eventAtMs, value.name);
    assert.equal(statusDisplay({ scope: "SHIPMENT", semantic: parsed.semantic,
      code: parsed.normalizedStatus?.code ?? "" }).label, expected.text, value.name);
    if (expected.semantic === "TRANSIT") assert.deepEqual(parsed.normalizedStatus, expected, value.name);
  }
}

// A Worker projection on the packet decides by itself.
{
  const worker: NormalizedStatus = { version: 1, scope: "SHIPMENT", semantic: "TRANSIT", code: "CUSTOMS_CLEARANCE",
    text: "清关中", priority: 1, eventAtMs: AT, structured: true };
  const parsed = parseMeizuTimeline({ ...online("清关中"), normalizedStatus: worker });
  assert.deepEqual(parsed.normalizedStatus, worker);
  const danger: NormalizedStatus = { ...worker, semantic: "DANGER", code: "FAILED", text: "异常件", priority: 0 };
  assert.equal(parseMeizuTimeline({ ...online("清关中"), normalizedStatus: danger }).semantic, "DANGER",
    "an older Worker's projection is not reinterpreted by the client");
}

// Interface-6 list rows read the same refinement.
{
  const rows = ["清关中", "已清关", "清关异常"].map((description, index) => ({
    mailNo: `7710000000000${index + 1}`, cpCode: "zhongtongguoji", cpName: "中通国际", fromCp: "KD-100",
    logisticsStatus: "FAILED", logisticsStatusDesc: description, logisticsGmtModified: STAMP,
    lastLogisticDetail: "[中国]进行处理，快件已开始清关",
  }));
  const parcels = parseAccountSyncResponse("interface6", { code: 200, value: JSON.stringify({ parcelData: rows }) });
  assert.deepEqual(parcels.map((parcel) => [parcel.semantic, parcel.normalizedStatus?.code ?? ""]), [
    ["TRANSIT", "CUSTOMS_CLEARANCE"], ["TRANSIT", "TRANSIT"], ["DANGER", ""],
  ]);
  assert.equal(parcels[0].sourceStateCode, "FAILED", "the raw upstream code is kept");
}

// Display, sorting and colour: 清关中 is a 运输中 branch.
function shipment(id: string, semantic: StatusSemantic, normalizedStatus?: NormalizedStatus): Shipment {
  const packet: TimelinePackage = {
    provider: "v6_query", waybill: id, courierCode: "ZTO", companyName: "中通快递", semantic,
    structuredStatus: Boolean(normalizedStatus?.structured), statusEventAtMs: normalizedStatus?.eventAtMs || AT,
    ...(normalizedStatus ? { normalizedStatus } : {}),
    latestTimeText: STAMP, latestDetail: "节点", tracks: [], successAtMs: NOW,
  };
  return {
    identity: { id: `manual:${id}`, bindingSource: "manual", sourceOwner: "manual", sourceId: id, orderId: "",
      projectedWaybill: "", accountOrder: false, manuallyAdded: true, sourceProvider: "", courierCode: "ZTO",
      companyName: "中通快递", phone: "", phoneTail: "", createdAtMs: NOW },
    timeline: packet, sourceTimeline: packet, manualTimelines: [], route: null, accountRecord: null, updatedAtMs: NOW,
  } as unknown as Shipment;
}
{
  const customs = shipment("77100000000001", "TRANSIT", parseMeizuTimeline(online("清关中")).normalizedStatus);
  const transit = shipment("77100000000002", "TRANSIT", { version: 1, scope: "SHIPMENT", semantic: "TRANSIT",
    code: "TRANSPORT", text: "运输中", priority: 0, eventAtMs: AT - 60_000, structured: true });
  const danger = shipment("77100000000003", "DANGER", { version: 1, scope: "SHIPMENT", semantic: "DANGER",
    code: "FAILED", text: "异常件", priority: 0, eventAtMs: AT + 60_000, structured: true });
  assert.deepEqual(shipmentPresentationStatus(customs), { semantic: "TRANSIT", text: "清关中" });
  assert.equal(statusTextAccent("TRANSIT", "清关中"), 0x00796b);
  assert.notEqual(statusTextAccent("TRANSIT", "清关中"), statusTextAccent("TRANSIT", "运输中"));
  assert.equal(statusTextAccent("TRANSIT", "清关中", true), statusTextAccent("TRANSIT", "运输中", true));
  assert.notEqual(statusTextAccent("TRANSIT", "清关中"), statusTextAccent("DANGER", "异常件"));
  const sorted = sortShipments([danger, transit, customs]).map((value) => value.identity.sourceId);
  assert.ok(sorted.indexOf("77100000000001") < sorted.indexOf("77100000000003"),
    "清关中 sorts with 运输中, not with 异常件");
  assert.equal(buildWidgetSnapshot([customs], NOW).rows[0].statusLabel, "清关中");
}

// The bundled table is generated from the formal Worker, which carries the subtype.
resetStatusLabelTableForTesting();
assert.deepEqual(BOOTSTRAP_STATUS_LABEL_TABLE.subtypes.find((value) => value.code === CUSTOMS_SUBTYPE.code),
  CUSTOMS_SUBTYPE);
{
  const parsed = parseMeizuTimeline(online("清关中"));
  assert.equal(parsed.semantic, "TRANSIT");
  assert.equal(parsed.normalizedStatus?.text, "清关中");
  assert.deepEqual(shipmentPresentationStatus(shipment("77100000000001", "TRANSIT", parsed.normalizedStatus)),
    { semantic: "TRANSIT", text: "清关中" });
}
// A table without the subtype (an older served snapshot) still shows 运输中, never 异常件.
{
  const withoutSubtype = parseStatusLabelTable({
    ...BOOTSTRAP_STATUS_LABEL_TABLE,
    subtypes: BOOTSTRAP_STATUS_LABEL_TABLE.subtypes.filter((value) => value.code !== CUSTOMS_SUBTYPE.code),
  });
  assert.ok(withoutSubtype);
  assert.equal(installStatusLabelTable(withoutSubtype), true);
  const parsed = parseMeizuTimeline(online("清关中"));
  assert.equal(parsed.semantic, "TRANSIT");
  assert.equal(parsed.normalizedStatus?.text, "运输中");
  assert.deepEqual(shipmentPresentationStatus(shipment("77100000000001", "TRANSIT", parsed.normalizedStatus)),
    { semantic: "TRANSIT", text: "运输中" });
  resetStatusLabelTableForTesting();
}

// Owner 2026-11-21 「Read it for every status」: the correctly spelled logisticsStatus decides every Online
// status, in the Worker's order (logsiticsStatus, logisticsStatus, status, state); an unrecognized value does
// not mask a recognized one, and recognized values that disagree give no status (the Worker's rule).
{
  const node = (fields: Record<string, unknown>) => parseMeizuTimeline({ manual: {
    time: "2026-08-30 11:00:00", context: "已签收", ...fields } });
  for (const field of ["logsiticsStatus", "logisticsStatus", "status", "state"]) {
    const parsed = node({ [field]: "SIGN" });
    assert.equal(parsed.semantic, "COMPLETED", field);
    assert.equal(parsed.statusEventAtMs, Date.UTC(2026, 7, 30, 3, 0, 0), field);
  }
  assert.equal(node({ logisticsStatus: "SIGN", status: "NEW_STATE" }).semantic, "COMPLETED",
    "an unrecognized spelling does not mask logisticsStatus");
  assert.equal(node({ logsiticsStatus: "TRANSPORT", logisticsStatus: "SIGN" }).semantic, "UNKNOWN",
    "two recognized spellings that disagree give no status");
  assert.equal(node({ logisticsStatus: "SIGN", logsiticsStatus: "SIGN" }).semantic, "COMPLETED");
  assert.equal(node({ logisticStatus: "SIGN" }).semantic, "UNKNOWN", "an unlisted spelling owns no status");
  assert.equal(node({ logisticsStatus: "sign" }).semantic, "UNKNOWN", "values still match exactly");
  // The untimed root fallback reads the same fields in the same order.
  assert.equal(parseMeizuTimeline({ logsiticsStatus: "SIGN", tracks: [{ context: "节点" }] }).semantic, "COMPLETED");
  assert.equal(parseMeizuTimeline({ logsiticsStatus: "TRANSPORT", status: "SIGN",
    tracks: [{ context: "节点" }] }).semantic, "UNKNOWN");
}

// The same-source Online cache (补充修改五, 2026-11-21 review): the VPS package was cached under the old
// Worker, which projected the 17:28:31 event as FAILED / 异常件. The next answer of the updated Worker reads
// the same event as 清关中. The cached copy is read again through the refinement, so the event is kept once
// and the package follows the refined reading.
{
  const oldWorker: NormalizedStatus = { version: 1, scope: "SHIPMENT", semantic: "DANGER", code: "FAILED",
    text: "异常件", priority: 0, eventAtMs: AT, structured: true };
  const newWorker: NormalizedStatus = { version: 1, scope: "SHIPMENT", semantic: "TRANSIT",
    code: "CUSTOMS_CLEARANCE", text: "清关中", priority: 1, eventAtMs: AT, structured: true };
  const record = (description: string, extra: Record<string, unknown> = {}) => ({
    mailNo: "77100000000045", cpCode: "zhongtongguoji", cpName: "中通国际", fromCp: "KD-100",
    logisticsStatus: "FAILED", logisticsStatusDesc: description,
    lastLogisticDetail: "[中国]进行处理，快件已开始清关", logisticsGmtModified: STAMP, ...extra,
  });
  // manual-query.ts queryMeizuShipmentOnce hands the record with the packet projection to the parser.
  const pkg = (value: Record<string, unknown>, projection: NormalizedStatus | undefined,
    successAtMs: number): TimelinePackage => {
    const parsed = parseMeizuTimeline({ ...value, ...(projection ? { normalizedStatus: projection } : {}) });
    return { provider: "v6_query", complete: false, structuredStatus: parsed.hasStructuredStatus,
      waybill: "77100000000045", courierCode: "ZTO", companyName: "中通快递", semantic: parsed.semantic,
      statusEventAtMs: parsed.statusEventAtMs, normalizedStatus: parsed.normalizedStatus,
      latestTimeText: parsed.latestTimeText, latestDetail: parsed.latestDetail, tracks: parsed.tracks,
      successAtMs };
  };
  const cached = pkg(record("清关中"), oldWorker, NOW - 3_600_000);
  assert.equal(cached.semantic, "DANGER", "the old Worker's answer, as the VPS cached it");
  const fresh = pkg(record("清关中"), newWorker, NOW);
  const merged = mergeTimelinePackage(cached, fresh);
  assert.equal(merged.semantic, "TRANSIT");
  assert.deepEqual(merged.normalizedStatus, newWorker);
  assert.equal(merged.statusEventAtMs, AT);
  assert.equal(merged.tracks.filter((track) => track.timeText === STAMP).length, 1, "one 17:28:31 node");
  assert.equal((merged.tracks[0].raw.normalizedStatus as NormalizedStatus).code, "CUSTOMS_CLEARANCE");
  // The same with a locally projected answer (no Worker projection).
  const local = mergeTimelinePackage(cached, pkg(record("清关中"), undefined, NOW));
  assert.deepEqual([local.semantic, local.normalizedStatus?.code, local.tracks.length],
    ["TRANSIT", "CUSTOMS_CLEARANCE", 1]);
  for (const description of ["待清关", "已清关"]) {
    const plain = mergeTimelinePackage(pkg(record(description), oldWorker, NOW - 3_600_000),
      pkg(record(description), { ...newWorker, code: "TRANSIT", text: "运输中", priority: 0 }, NOW));
    assert.deepEqual([plain.semantic, plain.normalizedStatus?.code, plain.tracks.length],
      ["TRANSIT", "TRANSIT", 1], description);
  }
  // The shipment that owns the cache follows it: 清关中, sorted and coloured as 运输中.
  const owner = (timeline: TimelinePackage): Shipment => ({
    identity: { id: "manual:manual:77100000000045", bindingSource: "manual", sourceOwner: "manual",
      sourceId: "77100000000045", phoneTail: "", courierCode: "ZTO", rawCourierCode: "ZTO",
      companyName: "中通快递", manuallyAdded: true, createdAtMs: NOW - 86_400_000 },
    timeline, sourceTimeline: null, manualTimelines: [timeline], route: null, updatedAtMs: NOW,
  } as unknown as Shipment);
  const applied = applyManualShipment(owner(cached), owner(fresh), NOW);
  assert.deepEqual(shipmentPresentationStatus(applied), { semantic: "TRANSIT", text: "清关中" });
  const online = (applied.manualTimelines || []).find((value) => value.provider === "v6_query")!;
  assert.equal(online.tracks.filter((track) => track.timeText === STAMP).length, 1);

  // An older Worker still answering FAILED for the event: nothing is re-read, nothing is duplicated.
  const stale = mergeTimelinePackage(cached, pkg(record("清关中"), oldWorker, NOW));
  assert.deepEqual([stale.semantic, stale.tracks.length], ["DANGER", 1]);
  // A genuine 异常件 (清关异常) stays as it was; the refinement reads only the listed descriptions.
  const genuine = pkg(record("清关异常"), oldWorker, NOW - 3_600_000);
  const kept = mergeTimelinePackage(genuine, fresh);
  assert.equal(kept.semantic, "DANGER", "a same-event DANGER that is not the customs misreading is kept");
  assert.equal(kept.tracks.filter((track) => track.timeText === STAMP).length, 2);
}

// Third review C-02 (2026-11-23): Meizu's real Online answer spells the coarse field `logsiticsStatus`, and
// `stateName` is its second structured description. Both are retained on the node so a cached node can be
// read again; a node cached before they were retained still carries its FAILED projection, which is the
// structured evidence of that coarse FAILED. C-01 ②: Online answers with its latest node only, so a cached
// node is re-read from its own fields even when the next answer has moved past that event. H-01: an
// interface-6 account package stored as the unrefined FAILED moves to 清关中 for the same clock.
{
  const oldWorker: NormalizedStatus = { version: 1, scope: "SHIPMENT", semantic: "DANGER", code: "FAILED",
    text: "异常件", priority: 0, eventAtMs: AT, structured: true };
  const newWorker: NormalizedStatus = { version: 1, scope: "SHIPMENT", semantic: "TRANSIT",
    code: "CUSTOMS_CLEARANCE", text: "清关中", priority: 1, eventAtMs: AT, structured: true };
  const realRecord = (description: string, extra: Record<string, unknown> = {}) => ({
    mailNo: "77100000000045", cpCode: "zhongtongguoji", cpName: "中通国际", fromCp: "KD-100",
    logsiticsStatus: "FAILED", logisticsStatusDesc: description,
    lastLogisticDetail: "[中国]进行处理，快件已开始清关", logisticsGmtModified: STAMP, ...extra,
  });
  const pkg = (value: Record<string, unknown>, projection: NormalizedStatus | undefined,
    successAtMs: number): TimelinePackage => {
    const parsed = parseMeizuTimeline({ ...value, ...(projection ? { normalizedStatus: projection } : {}) });
    return { provider: "v6_query", complete: false, structuredStatus: parsed.hasStructuredStatus,
      waybill: "77100000000045", courierCode: "ZTO", companyName: "中通快递", semantic: parsed.semantic,
      statusEventAtMs: parsed.statusEventAtMs, normalizedStatus: parsed.normalizedStatus,
      latestTimeText: parsed.latestTimeText, latestDetail: parsed.latestDetail, tracks: parsed.tracks,
      successAtMs };
  };
  // The node keeps the upstream spelling and stateName.
  const kept = parseMeizuTimeline(realRecord("", { logisticsStatusDesc: undefined, stateName: "清关中" }));
  assert.equal(kept.tracks[0].raw.logsiticsStatus, "FAILED");
  assert.equal(kept.tracks[0].raw.stateName, "清关中");
  assert.equal(kept.semantic, "TRANSIT");
  // A package cached before this fix: compactTrackRaw had dropped `logsiticsStatus` from its node.
  const legacy = (value: TimelinePackage): TimelinePackage => ({ ...value, tracks: value.tracks.map((track) => {
    const raw = { ...track.raw } as Record<string, unknown>;
    delete raw.logsiticsStatus;
    delete raw.stateName;
    return { ...track, raw };
  }) });
  const cached = legacy(pkg(realRecord("清关中"), oldWorker, NOW - 3_600_000));
  assert.equal(cached.semantic, "DANGER");
  assert.equal(cached.tracks[0].raw.logsiticsStatus, undefined, "the stored node lost its coarse field");
  // Same-second refresh with the real misspelled key: one 17:28:31 node, 清关中.
  const merged = mergeTimelinePackage(cached, pkg(realRecord("清关中"), newWorker, NOW));
  assert.deepEqual([merged.semantic, merged.normalizedStatus?.code], ["TRANSIT", "CUSTOMS_CLEARANCE"]);
  assert.equal(merged.tracks.filter((track) => track.timeText === STAMP).length, 1, "no duplicated 清关中 node");
  // The same with a locally projected answer, and with a node cached without its own projection (the
  // package's FAILED projection at that clock is the evidence).
  const local = mergeTimelinePackage(cached, pkg(realRecord("清关中"), undefined, NOW));
  assert.deepEqual([local.semantic, local.tracks.filter((track) => track.timeText === STAMP).length], ["TRANSIT", 1]);
  const bare = { ...cached, tracks: cached.tracks.map((track) => {
    const raw = { ...track.raw } as Record<string, unknown>;
    delete raw.normalizedStatus;
    return { ...track, raw };
  }) };
  assert.equal(mergeTimelinePackage(bare, pkg(realRecord("清关中"), newWorker, NOW)).semantic, "TRANSIT");
  // C-01 ②: the next answer's single latest node has moved past 17:28:31 (a newer TRANSPORT scan): the cached
  // 17:28:31 node is still read again, so it no longer shows 异常件 beside the newer node.
  const LATER = "2026-11-20 19:00:00";
  const laterAt = Date.UTC(2026, 10, 20, 11, 0, 0);
  const moved = mergeTimelinePackage(cached, pkg({ ...realRecord(""), logsiticsStatus: "TRANSPORT",
    logisticsStatusDesc: undefined, lastLogisticDetail: "[中国]干线运输", logisticsGmtModified: LATER },
  { ...newWorker, code: "TRANSPORT", text: "运输中", priority: 0, eventAtMs: laterAt }, NOW));
  const old = moved.tracks.find((track) => track.timeText === STAMP)!;
  assert.equal((old.raw.normalizedStatus as NormalizedStatus).code, "CUSTOMS_CLEARANCE");
  assert.deepEqual([moved.semantic, moved.tracks.length], ["TRANSIT", 2]);
  // A newer FAILED + 清关中 scan: same answer, the newest node owns the status.
  const again = mergeTimelinePackage(cached, pkg(realRecord("清关中", { lastLogisticDetail: "[中国]海关查验",
    logisticsGmtModified: LATER }), { ...newWorker, eventAtMs: laterAt }, NOW));
  assert.deepEqual([again.semantic, again.statusEventAtMs, again.tracks.length], ["TRANSIT", laterAt, 2]);
  assert.equal((again.tracks.find((track) => track.timeText === STAMP)!.raw.normalizedStatus as NormalizedStatus)
    .code, "CUSTOMS_CLEARANCE");
  // Not re-read: a genuine 清关异常 node, and an event an older Worker still answers as FAILED.
  const genuine = legacy(pkg(realRecord("清关异常"), oldWorker, NOW - 3_600_000));
  const genuineMoved = mergeTimelinePackage(genuine, pkg({ ...realRecord(""), logsiticsStatus: "TRANSPORT",
    logisticsStatusDesc: undefined, lastLogisticDetail: "[中国]干线运输", logisticsGmtModified: LATER },
  { ...newWorker, code: "TRANSPORT", text: "运输中", priority: 0, eventAtMs: laterAt }, NOW));
  assert.equal((genuineMoved.tracks.find((track) => track.timeText === STAMP)!.raw.normalizedStatus as
    NormalizedStatus).code, "FAILED", "a genuine 清关异常 node keeps its 异常件 reading");
  assert.equal(mergeTimelinePackage(genuine, pkg(realRecord("清关中"), newWorker, NOW)).semantic, "DANGER");
  const stale = mergeTimelinePackage(cached, pkg(realRecord("清关中"), oldWorker, NOW));
  assert.deepEqual([stale.semantic, stale.tracks.length], ["DANGER", 1]);

  // H-01: interface-6 account packages (list rows) carry only the package projection.
  const account = (semantic: StatusSemantic, projection: NormalizedStatus): TimelinePackage => ({
    provider: "interface6", complete: false, structuredStatus: true, waybill: "77100000000045",
    courierCode: "ZTO", companyName: "中通快递", semantic, statusEventAtMs: AT, normalizedStatus: projection,
    latestTimeText: STAMP, latestDetail: "[中国]进行处理，快件已开始清关",
    tracks: [{ timeText: STAMP, timeMs: AT, detail: "[中国]进行处理，快件已开始清关", statusCode: "",
      raw: { normalizedStatus: projection, _pipiStatusSource: "interface6" } }],
    successAtMs: NOW,
  });
  const stored = account("DANGER", oldWorker);
  const recovered = mergeTimelinePackage(stored, account("TRANSIT", newWorker), false);
  assert.deepEqual([recovered.semantic, recovered.normalizedStatus?.code], ["TRANSIT", "CUSTOMS_CLEARANCE"]);
  // Not let through: 待清关 / 已清关 (code TRANSIT, the same code as an upstream TRANSIT), another DANGER code,
  // and the Online cache (re-read node by node instead).
  assert.equal(mergeTimelinePackage(stored, account("TRANSIT",
    { ...newWorker, code: "TRANSIT", text: "运输中", priority: 0 }), false).semantic, "DANGER");
  const problem = account("DANGER", { ...oldWorker, code: "PROBLEM" });
  assert.equal(mergeTimelinePackage(problem, account("TRANSIT", newWorker), false).semantic, "DANGER");
  assert.equal(mergeTimelinePackage({ ...stored, provider: "interface5" }, { ...account("TRANSIT", newWorker),
    provider: "interface5" }, false).semantic, "DANGER", "only the Meizu account interface");
}

console.log("customs clearance tests passed");
