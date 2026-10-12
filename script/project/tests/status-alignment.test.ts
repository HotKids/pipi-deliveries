import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { memory, NOW } from "./state-storage-mock";
import type { AppState, Shipment, TimelinePackage, TrackNode } from "../models";
import { emptyState, loadState, saveState } from "../services/storage";
import { parseProviderTime } from "../services/status";
import {
  FORCED_COMPLETION_REFRESH_WINDOW_MS,
  selectShipmentDetailTimeline,
  selectShipmentTimeline,
  shipmentDetailComplete,
  shipmentSelectionEvidence,
  STATUS_ALIGNMENT_MS,
  statusAlignmentOutOfStep,
  statusAlignmentReason,
  statusAlignmentTimes,
} from "../services/shipment-policy";
import { runShipmentRefreshForTesting } from "../services/sync";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import {
  createStatusAlignment,
  runStatusAlignmentPass,
  type StatusAlignmentPassResult,
  type StatusAlignmentRecordStore,
} from "../services/status-alignment";

// 用户 2026-10-02「首先既然状态变成签收了 头条就应该对齐状态」「加一个限制 头条跟状态有一个更新时 另外（包含本地详情页）
// 就要强制刷新跟上（以时间为准）」，弹窗「四端都做」「五分钟」「同取件码强刷」「先取状态那一包的最新节点」。
// 合成数据（no real parcel data）：运单、手机号都是编的。

const WAYBILL = "SF0000000009001";
const PHONE = "13800009001";
const at = (text: string) => parseProviderTime(text)!;
const SIGNED_TEXT = "快递已完成签收";
const STORE_TEXT = "快件到达【测试驿站】";
const PICKUP_TEXT = "顺丰速运 已收取快件";

function node(timeText: string, detail: string, raw: TrackNode["raw"] = {}): TrackNode {
  return { timeText, timeMs: at(timeText), detail, statusCode: "", raw };
}

function feed(nodes: readonly [string, string][], statusAtText: string,
  semantic: TimelinePackage["semantic"] = "COMPLETED"): TimelinePackage {
  const tracks = nodes.map(([timeText, detail]) => node(timeText, detail));
  return { provider: "interface5", waybill: WAYBILL, courierCode: "SF", companyName: "顺丰速运",
    semantic, structuredStatus: true, statusEventAtMs: at(statusAtText), complete: false,
    latestTimeText: tracks[0]!.timeText, latestDetail: tracks[0]!.detail, successAtMs: NOW - 3_600_000, tracks };
}

function k100(nodes: readonly [string, string][], successAtMs = NOW - 3_600_000): TimelinePackage {
  const tracks = nodes.map(([timeText, detail]) => node(timeText, detail, { _pipiStatusSource: "web" }));
  return { provider: "k100_h5", waybill: WAYBILL, courierCode: "SF", companyName: "顺丰速运",
    semantic: "UNKNOWN", structuredStatus: false, statusEventAtMs: null, complete: true,
    latestTimeText: tracks[0]!.timeText, latestDetail: tracks[0]!.detail, successAtMs, tracks };
}

/** OPPO-style SF automatic row: the coarse feed signs, the list headline follows the K100 package (Picker/manual first). */
function sfRow(source: TimelinePackage, manual: TimelinePackage, extra: Partial<Shipment> = {}): Shipment {
  return { identity: { id: `interface5:account:${WAYBILL}`, sourceId: WAYBILL, bindingSource: "interface5",
    sourceOwner: "interface5:parcel", sourceProvider: "ShunFeng", courierCode: "SF", rawCourierCode: "SF",
    companyName: "顺丰速运", phone: PHONE, phoneTail: "9001", manuallyAdded: false, createdAtMs: NOW - 86_400_000 },
    timeline: source, sourceTimeline: source, manualTimelines: [manual], updatedAtMs: NOW - 3_600_000,
    accountRecord: { waybill: WAYBILL, companyCode: "SF", provider: "ShunFeng", phone: PHONE, stateNumber: 3 },
    ...extra } as Shipment;
}

function persist(shipment: Shipment): Shipment {
  return saveState({ ...emptyState(), shipments: [shipment], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86_400_000 },
  ] }, NOW).shipments[0]!;
}

const OUT_OF_STEP_ROW = () => sfRow(
  feed([["2026-09-08 13:31:00", SIGNED_TEXT]], "2026-09-08 13:31:00"),
  k100([["2026-09-08 11:41:00", STORE_TEXT], ["2026-09-07 10:00:00", PICKUP_TEXT]]),
);

const actualNow = Date.now;
let now = NOW;
Date.now = () => now;
try {
  // ---- 「五分钟」：任意两个时间都有、相差超过五分钟才算对不上，哪边新都算。
  {
    const S = at("2026-09-08 12:00:00");
    const exactly = { statusAtMs: S, headlineAtMs: S - STATUS_ALIGNMENT_MS, detailAtMs: S - STATUS_ALIGNMENT_MS };
    assert.equal(STATUS_ALIGNMENT_MS, 5 * 60_000);
    assert.equal(statusAlignmentOutOfStep(exactly), false, "exactly five minutes apart is still in step");
    const statusAhead = { ...exactly, headlineAtMs: S - STATUS_ALIGNMENT_MS - 1_000, detailAtMs: S };
    assert.equal(statusAlignmentOutOfStep(statusAhead), true);
    assert.equal(statusAlignmentReason(statusAhead), "status_ahead");
    const headlineAhead = { statusAtMs: S, headlineAtMs: S + STATUS_ALIGNMENT_MS + 1_000, detailAtMs: S };
    assert.equal(statusAlignmentOutOfStep(headlineAhead), true, "a newer headline counts too");
    assert.equal(statusAlignmentReason(headlineAhead), "headline_ahead");
    const detailBehind = { statusAtMs: S, headlineAtMs: S, detailAtMs: S - STATUS_ALIGNMENT_MS - 1_000 };
    assert.equal(statusAlignmentOutOfStep(detailBehind), true, "the local detail page counts as the third time");
    assert.equal(statusAlignmentReason(detailBehind), "detail_behind");
    assert.equal(statusAlignmentOutOfStep({ statusAtMs: S, headlineAtMs: 0, detailAtMs: 0 }), false,
      "a missing time takes no part");
    assert.equal(statusAlignmentOutOfStep({ statusAtMs: S, headlineAtMs: 0, detailAtMs: S - 6 * 60_000 }), true);
  }

  // ---- 刷回来之前的展示：状态比头条新超过五分钟，头条先换成给出状态的那一包（feed）最新的有效节点；状态、轨迹不动。
  // 顺丰来源件的头条原本取手动包（structuredStatusOverride 不拿账号头条覆盖 Picker 头条），这里同样换。
  {
    const row = OUT_OF_STEP_ROW();
    const listed = selectShipmentTimeline(row);
    assert.equal(listed.semantic, "COMPLETED");
    assert.equal(listed.structuredStatus, true);
    assert.equal(listed.statusEventAtMs, at("2026-09-08 13:31:00"), "status and its clock are unchanged");
    assert.equal(listed.latestDetail, STORE_TEXT, "SF keeps its detailed headline until a forced attempt finishes");
    assert.equal(listed.latestTimeText, "2026-09-08 11:41:00");
    assert.equal(listed.provider, "k100_h5", "the history stays the selected manual package");
    assert.deepEqual(listed.tracks.map(track => track.detail), [STORE_TEXT, PICKUP_TEXT], "tracks are unchanged");
    assert.equal(shipmentSelectionEvidence(row).headlineProvider, "k100_h5");
    assert.deepEqual(selectShipmentDetailTimeline(row).tracks.map(track => track.detail), [STORE_TEXT, PICKUP_TEXT],
      "the detail page keeps its own package");
    const times = statusAlignmentTimes(row)!;
    assert.deepEqual(times, { statusAtMs: at("2026-09-08 13:31:00"), headlineAtMs: at("2026-09-08 11:41:00"),
      detailAtMs: at("2026-09-08 11:41:00"), statusSemantic: "COMPLETED", needsNonCoarse: true },
      "the check compares the original detailed headline");
    assert.equal(statusAlignmentReason(times), "status_ahead");
    // Persisted rows carry the swapped headline (list, widgets and retention read the stored presentation).
    memory.clear();
    assert.equal(persist(row).timeline.latestTimeText, "2026-09-08 11:41:00");
  }

  // 给出状态的那一包没有比原头条新的节点：不换。
  {
    const row = sfRow(
      feed([["2026-09-08 09:00:00", "快件已发出"]], "2026-09-08 13:31:00"),
      k100([["2026-09-08 11:41:00", STORE_TEXT], ["2026-09-07 10:00:00", PICKUP_TEXT]]),
    );
    const listed = selectShipmentTimeline(row);
    assert.equal(listed.semantic, "COMPLETED");
    assert.equal(listed.latestDetail, STORE_TEXT, "the status package has nothing newer than the headline");
    assert.equal(listed.latestTimeText, "2026-09-08 11:41:00");
    assert.equal(statusAlignmentReason(statusAlignmentTimes(row)!), "status_ahead", "it is still refreshed once");
  }

  // 恰好五分钟、头条比状态新：不换（头条比状态新时只强刷）。
  {
    const fiveMinutes = sfRow(
      feed([["2026-09-08 11:46:00", SIGNED_TEXT]], "2026-09-08 11:46:00"),
      k100([["2026-09-08 11:41:00", STORE_TEXT], ["2026-09-07 10:00:00", PICKUP_TEXT]]),
    );
    assert.equal(selectShipmentTimeline(fiveMinutes).latestTimeText, "2026-09-08 11:41:00");
    assert.equal(statusAlignmentOutOfStep(statusAlignmentTimes(fiveMinutes)!), false);
    const headlineAhead = sfRow(
      feed([["2026-09-08 10:00:00", "快件已发出"]], "2026-09-08 10:00:00", "TRANSIT"),
      k100([["2026-09-08 11:41:00", STORE_TEXT], ["2026-09-07 10:00:00", PICKUP_TEXT]]),
    );
    assert.equal(selectShipmentTimeline(headlineAhead).latestTimeText, "2026-09-08 11:41:00");
    assert.equal(statusAlignmentReason(statusAlignmentTimes(headlineAhead)!), "headline_ahead");
  }

  // 手动签收（forcedCompletedAtMs）不换头条；用户 2026-10-02「我已取件这种硬冻结 也要等三态都是签收才冻结」，弹窗「iOS 右滑签收
  // 一起改」：三态没到签收、没满 72 小时时用来源自己的状态参与对齐，之后不参与。已取消、没有结构化状态时间的行不参与。
  {
    const manuallySigned = { ...OUT_OF_STEP_ROW(), forcedCompletedAtMs: at("2026-09-08 13:40:00") };
    assert.deepEqual(statusAlignmentTimes(manuallySigned), statusAlignmentTimes(OUT_OF_STEP_ROW()),
      "the source's own status, not the sign-off latch");
    assert.equal(selectShipmentTimeline(manuallySigned).latestTimeText, "2026-09-08 11:41:00");
    const hardFrozen = { ...OUT_OF_STEP_ROW(), forcedCompletedAtMs: NOW - FORCED_COMPLETION_REFRESH_WINDOW_MS };
    assert.equal(statusAlignmentTimes(hardFrozen), null);
    const cancelled = sfRow(
      feed([["2026-09-08 13:31:00", "订单已取消"]], "2026-09-08 13:31:00", "CANCELLED"),
      k100([["2026-09-08 11:41:00", STORE_TEXT], ["2026-09-07 10:00:00", PICKUP_TEXT]]),
    );
    assert.equal(statusAlignmentTimes(cancelled), null);
    // D-23（用户 2026-10-02「修」，AGENTS §9「状态看结构化，不看文案」）：选中的 K100 包只有文案推出的状态时，列表取同一运单
    // 各包里最新的结构化状态（这里是 feed 的签收），状态对齐照常参与；哪个包都没有结构化状态时才回到文案，不参与对齐。
    const prose = OUT_OF_STEP_ROW();
    const textStatus = { ...prose, manualTimelines: [{ ...prose.manualTimelines![0]!, semantic: "TRANSIT" as const,
      statusEventAtMs: at("2026-09-08 11:41:00") }], timeline: prose.manualTimelines![0]! };
    assert.equal(selectShipmentTimeline(textStatus).semantic, "COMPLETED");
    assert.equal(selectShipmentTimeline(textStatus).structuredStatus, true);
    assert.equal(selectShipmentTimeline(textStatus).statusEventAtMs, at("2026-09-08 13:31:00"));
    assert.deepEqual(statusAlignmentTimes(textStatus), statusAlignmentTimes(OUT_OF_STEP_ROW()));
    const proseFeed = { ...prose.sourceTimeline!, structuredStatus: false };
    const proseEverywhere = { ...textStatus, sourceTimeline: proseFeed };
    assert.equal(selectShipmentTimeline(proseEverywhere).structuredStatus, false);
    assert.equal(selectShipmentTimeline(proseEverywhere).semantic, "TRANSIT", "no structured status anywhere: the text");
    assert.equal(statusAlignmentTimes(proseEverywhere), null, "a prose-derived status has no structured time");
  }

  // ---- 同一组 (S, H, D) 只强刷一次：发起即记下（成功失败都记），三个时间都没变就不再刷，任一变了才可再刷。
  {
    memory.clear();
    setDiagnosticsEnabled(true);
    let state: AppState = loadState(NOW);
    state = saveState({ ...emptyState(), shipments: [OUT_OF_STEP_ROW()], bindings: [
      { source: "interface5", phone: PHONE, boundAtMs: NOW - 86_400_000 },
    ] }, NOW);
    const records: Record<string, string> = {};
    const store: StatusAlignmentRecordStore = {
      load: () => ({ ...records }),
      save: (next) => { for (const key of Object.keys(records)) delete records[key]; Object.assign(records, next); },
    };
    const refreshed: string[] = [];
    let failNext = false;
    const pass = (overrides: Parameters<typeof runStatusAlignmentPass>[1] = {}) => runStatusAlignmentPass({}, {
      appHost: () => true, busy: () => false, load: () => state, records: store, now: () => now,
      refresh: async (id, beforeQuery) => { beforeQuery();
        refreshed.push(id);
        if (failNext) throw new Error("网络连接失败");
        return { state };
      },
      ...overrides,
    });

    const first = await pass();
    assert.equal(first.result, "attempted");
    assert.equal(first.shipmentId, state.shipments[0]!.identity.id);
    assert.equal(refreshed.length, 1);
    assert.equal(Object.keys(records).length, 1);
    assert.doesNotMatch(JSON.stringify(records), new RegExp(WAYBILL), "the record keeps no waybill");
    const event = readDiagnostics().find(entry => entry.event === "detail.refresh.alignment")!;
    assert.equal(event.details.trigger, "status_alignment");
    assert.equal(event.details.alignmentReason, "status_ahead");
    assert.equal(event.details.statusEventAtMs, at("2026-09-08 13:31:00"));
    assert.equal(event.details.headlineAtMs, at("2026-09-08 11:41:00"));
    assert.equal(event.details.detailAtMs, at("2026-09-08 11:41:00"));
    assert.equal(event.details.headlineAligned, false, "the first attempt has not finished at its start event");
    assert.equal(event.details.waybillTail, "9001");
    assert.doesNotMatch(JSON.stringify(event.details), new RegExp(WAYBILL));

    assert.equal((await pass()).result, "nothing_due", "the same three times are refreshed once");
    assert.equal(refreshed.length, 1);

    // The headline package moves (a new node, not yet the signing): a new set, refreshed once more — and recorded
    // even though that refresh fails.
    const moved = OUT_OF_STEP_ROW();
    moved.manualTimelines = [k100([["2026-09-08 12:30:00", "快件派送中"], ["2026-09-08 11:41:00", STORE_TEXT],
      ["2026-09-07 10:00:00", PICKUP_TEXT]])];
    state = { ...state, shipments: [{ ...state.shipments[0]!, manualTimelines: moved.manualTimelines }] };
    failNext = true;
    const failed = await pass();
    assert.equal(failed.result, "failed");
    assert.equal(refreshed.length, 2);
    failNext = false;
    assert.equal((await pass()).result, "nothing_due", "a failed run waits for the ordinary row interval");
    assert.equal(refreshed.length, 2);

    // Widget and App Intent hosts never run it; a list still being written is checked after it settles.
    state = { ...state, shipments: [{ ...state.shipments[0]!, manualTimelines: [k100([["2026-09-08 12:40:00",
      "快件派送中"], ["2026-09-07 10:00:00", PICKUP_TEXT]])] }] };
    assert.equal((await pass({ appHost: () => false })).result, "not_app_host");
    assert.equal((await pass({ busy: () => true })).result, "busy");
    assert.equal(refreshed.length, 2);
    assert.equal((await pass()).result, "attempted");
    assert.equal(refreshed.length, 3);

    // The manually signed row (「我已取件」 analogue, forcedCompletedAtMs) takes part with its source's own times until it is
    // hard-frozen (用户 2026-10-02「我已取件这种硬冻结 也要等三态都是签收才冻结」): the same times are not forced again. Once
    // hard-frozen (here 72 hours after the sign-off) it no longer takes part. 用户 2026-10-03「四端都持久化、不因暂时消失删除」
    // （优化 3）：its record stays (it went only when the row is deleted or its times change); before 2026-10-03 the pass pruned it.
    state = { ...state, shipments: [{ ...state.shipments[0]!, forcedCompletedAtMs: at("2026-09-08 13:50:00") }] };
    assert.equal((await pass()).result, "nothing_due");
    assert.equal(refreshed.length, 3);
    assert.equal(Object.keys(records).length, 1, "a sign-off inside its refresh window keeps its record");
    const kept = JSON.stringify(records);
    state = { ...state, shipments: [{ ...state.shipments[0]!,
      forcedCompletedAtMs: NOW - FORCED_COMPLETION_REFRESH_WINDOW_MS }] };
    assert.equal((await pass()).result, "nothing_due");
    assert.equal(refreshed.length, 3);
    assert.equal(JSON.stringify(records), kept, "a row that no longer takes part keeps its record (优化 3)");
    // A row absent from this check (not listed at all) keeps its record as well.
    const listedState = state;
    state = { ...state, shipments: [] };
    assert.equal((await pass()).result, "nothing_due");
    assert.equal(JSON.stringify(records), kept, "a row missing from one check keeps its record");
    state = listedState;
  }

  // The record survives a new runtime (iOS starts a new one each time the app opens): the default store persists it.
  {
    memory.clear();
    const state = saveState({ ...emptyState(), shipments: [OUT_OF_STEP_ROW()], bindings: [
      { source: "interface5", phone: PHONE, boundAtMs: NOW - 86_400_000 },
    ] }, NOW);
    let calls = 0;
    const overrides = { appHost: () => true, busy: () => false, load: () => state, now: () => now,
      refresh: async (_id, beforeQuery) => { beforeQuery(); calls++; return { state }; } };
    assert.equal((await runStatusAlignmentPass({}, overrides)).result, "attempted");
    assert.equal((await runStatusAlignmentPass({}, overrides)).result, "nothing_due");
    assert.equal(calls, 1);
  }

  // ---- 强刷越过签收冻结与完整缓存：签收、详情已完整的顺丰件，下拉不再抓快递100；状态对齐强刷抓一次（每级一次），
  // 付费快递鸟的触发条件照旧（已到揽收就不问）。
  {
    const complete = () => sfRow(
      feed([["2026-09-08 13:31:00", SIGNED_TEXT]], "2026-09-08 13:31:00"),
      k100([["2026-09-08 13:20:00", "快件派送中"], ["2026-09-08 11:41:00", STORE_TEXT],
        ["2026-09-07 10:00:00", PICKUP_TEXT]]),
    );
    const row = complete();
    assert.equal(shipmentDetailComplete(row), true, "the cached detail is complete");
    assert.equal(statusAlignmentReason(statusAlignmentTimes(row)!), "status_ahead", "11 minutes apart");
    const run = async (trigger: "detail_pull" | "status_alignment") => {
      memory.clear();
      setDiagnosticsEnabled(true);
      now = NOW;
      const stored = persist(complete());
      const calls: string[] = [];
      const result = await runShipmentRefreshForTesting(stored.identity.id,
        { isCurrent: () => true, deadlineAtMs: NOW + 30_000 },
        { trigger, forceManualRefresh: true, includeKdniaoFallback: true, forceAccountOrderProjection: true }, {
          // Recorded rather than thrown: the manual contest settles provider errors itself.
          refreshAccountParcel: async () => { calls.push("v5_query"); return null; },
          queryManualForSource: async (input) => {
            calls.push(input.fallbackOnly ? "kdniao" : input.pickerOnly ? "v6_query" : "other");
            if (!input.pickerOnly || !input.currentShipment) return { shipment: null, pending: null, routeUrl: "" };
            // Online answers an SF parcel with its newest node only (no phone tail).
            const online: TimelinePackage = { ...k100([["2026-09-08 13:30:00", "快件已签收"]], now), provider: "v6_query",
              complete: false };
            return { shipment: { ...input.currentShipment, timeline: online, sourceTimeline: null,
              manualTimelines: [online] }, pending: null, routeUrl: "" };
          },
          refreshWebTimeline: async (shipment) => {
            calls.push("k100_h5");
            const fresh = k100([["2026-09-08 13:31:00", "快件已签收，签收人：本人"], ["2026-09-08 13:20:00", "快件派送中"],
              ["2026-09-08 11:41:00", STORE_TEXT], ["2026-09-07 10:00:00", PICKUP_TEXT]], now);
            return { ...shipment, timeline: fresh, sourceTimeline: null, manualTimelines: [fresh] };
          },
        });
      return { result, calls };
    };
    const pulled = await run("detail_pull");
    assert.deepEqual(pulled.calls, [], "a pull stops at the complete cache of a signed row");
    const aligned = await run("status_alignment");
    // 用户 2026-10-02「四端都先问 Picker（推荐）」：the SF list headline belongs to Online, so the alignment run asks it
    // first; every other level still runs once, and pickup already reached keeps the paid fallback closed.
    assert.deepEqual(aligned.calls, ["v6_query", "k100_h5"],
      "the alignment run passes the freeze and the complete cache once, Online first for an SF source row");
    assert.ok(loadState(now).shipments[0]!.manualTimelines?.some(timeline => timeline.provider === "v6_query"),
      "the Online answer is kept in its own slot");
    assert.equal(aligned.result.refreshed, true);
    const started = readDiagnostics().find(entry => entry.event === "detail.refresh.started")!;
    assert.equal(started.details.trigger, "status_alignment");
    const persisted = loadState(now).shipments[0]!;
    assert.equal(selectShipmentTimeline(persisted).latestTimeText, "2026-09-08 13:31:00");
    assert.equal(selectShipmentTimeline(persisted).latestDetail, "快件已签收，签收人：本人",
      "the fuller package now heads the list by itself");
    assert.equal(statusAlignmentOutOfStep(statusAlignmentTimes(persisted)!), false, "status, headline and detail agree");
  }

  // ---- The app root's check: after a sync round settles, once per row per chain; a busy list retries on the next tick.
  {
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const passes: Array<ReadonlySet<string>> = [];
    const results: StatusAlignmentPassResult[] = [];
    let outcome: (() => void) | null = null;
    let revision = 1;
    const applied: AppState[] = [];
    const controller = createStatusAlignment({
      runPass: async (options) => {
        passes.push(new Set(options.excludeIds));
        const result = results.shift() || { result: "nothing_due", moreDue: false };
        if (result.result === "attempted") revision++; // the forced refresh commits
        return result;
      },
      subscribeRefreshOutcome: (listener) => { outcome = () => listener({ source: "interface5", trigger: "foreground" });
        return () => { outcome = null; }; },
      peekRevision: () => revision,
      applyState: (state) => { applied.push(state); },
      setTimer: (callback, delayMs) => { timers.push({ callback, delayMs }); return timers.length; },
      clearTimer: () => {},
    });
    const flush = async () => {
      for (let round = 0; round < 20; round++) {
        const due = timers.filter(timer => timer.delayMs === 0);
        if (!due.length) { await new Promise(resolve => setImmediate(resolve)); if (!timers.some(t => t.delayMs === 0)) break; continue; }
        for (const timer of due) timers.splice(timers.indexOf(timer), 1);
        for (const timer of due) timer.callback();
        await new Promise(resolve => setImmediate(resolve));
      }
    };
    const tick = async () => {
      const watch = timers.find(timer => timer.delayMs > 0)!;
      timers.splice(timers.indexOf(watch), 1);
      watch.callback();
      await flush();
    };
    const state = emptyState();
    results.push({ result: "attempted", shipmentId: "a", moreDue: true, state },
      { result: "attempted", shipmentId: "b", moreDue: false, state });
    outcome!();
    await flush();
    assert.equal(passes.length, 2, "a settled round checks the list; one row forced at a time");
    assert.deepEqual([...passes[1]!], ["a"], "each row once per chain");
    assert.equal(applied.length, 2);
    assert.equal(revision, 3);
    await tick();
    assert.equal(passes.length, 2, "the chain's own commits are not news");
    revision = 6; // another runtime or a detail refresh committed
    await tick();
    assert.equal(passes.length, 3);
    results.push({ result: "busy", moreDue: false });
    revision = 7;
    await tick();
    assert.equal(passes.length, 4);
    await tick();
    assert.equal(passes.length, 5, "a check that met a list being written retries on the next tick");
    controller.scenePhaseChanged("background");
    outcome!();
    await flush();
    assert.equal(passes.length, 5, "nothing runs off screen");
    controller.stop();
  }

  // The app root wires it to the scene phase; widget and App Intent entry points never import it.
  {
    const app = readFileSync(new URL("../index.tsx", import.meta.url), "utf8");
    assert.match(app, /startStatusAlignment\(\{ applyState \}\)[\s\S]*?statusAlignment\.scenePhaseChanged\(phase\)[\s\S]*?statusAlignment\.stop\(\)/);
    for (const entry of ["widget.tsx", "app_intents.tsx", "intent.tsx"]) {
      const source = readFileSync(new URL(`../${entry}`, import.meta.url), "utf8");
      assert.doesNotMatch(source, /status-alignment|runStatusAlignmentPass/, entry);
    }
  }
} finally {
  Date.now = actualNow;
}

console.log("status alignment tests passed");
