import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Shipment, TimelinePackage } from "../models";
import {
  activateCainiaoManualFallback,
  cainiaoAutomaticNeedsH5Supplement,
  selectShipmentDetailTimeline,
} from "../services/shipment-policy";

const NOW = Date.parse("2026-09-02T10:00:00+08:00");

function timeline(
  semantic: TimelinePackage["semantic"],
  detail: string,
  statusCode: string,
): TimelinePackage {
  return {
    provider: "interface5",
    complete: true,
    waybill: "784300000001",
    courierCode: "ZTO",
    companyName: "中通快递",
    semantic,
    statusEventAtMs: NOW,
    latestTimeText: "2026-09-02 10:00:00",
    latestDetail: detail,
    tracks: [{
      timeText: "2026-09-02 10:00:00",
      timeMs: NOW,
      detail,
      statusCode,
      raw: { statusCode, _pipiStatusSource: "interface5" },
    }],
    successAtMs: NOW,
  };
}

function shipment(sourceTimeline: TimelinePackage): Shipment {
  return {
    identity: {
      id: "interface5:account:784300000001",
      bindingSource: "interface5",
      sourceOwner: "interface5",
      sourceId: "784300000001",
      phoneTail: "1234",
      courierCode: "ZTO",
      companyName: "中通快递",
      sourceProvider: "CaiNiao",
      accountOrder: false,
      manuallyAdded: false,
      createdAtMs: NOW,
    },
    timeline: sourceTimeline,
    sourceTimeline,
    manualTimelines: [],
    route: { kind: "cainiao", source: "interface5" },
    accountRecord: null,
    updatedAtMs: NOW,
  };
}

const transitOnly = shipment(timeline("TRANSIT", "运输中", "2"));
assert.equal(
  cainiaoAutomaticNeedsH5Supplement(transitOnly),
  true,
  "a stateful Cainiao owner missing its pickup stage must request its own H5",
);

const picked = timeline("PICKED", "快件已揽收", "1");
assert.equal(
  cainiaoAutomaticNeedsH5Supplement(shipment(picked)),
  false,
  "a Cainiao source timeline containing pickup evidence must stay authoritative",
);

const empty = shipment({
  ...transitOnly.timeline,
  semantic: "UNKNOWN",
  statusEventAtMs: null,
  latestTimeText: "",
  latestDetail: "",
  tracks: [],
});
assert.equal(
  cainiaoAutomaticNeedsH5Supplement(empty),
  false,
  "an empty owner response is not the stateful missing-pickup partition",
);
assert.equal(
  cainiaoAutomaticNeedsH5Supplement({
    ...empty,
    timeline: { ...empty.timeline, semantic: "TRANSIT" },
    sourceTimeline: { ...empty.sourceTimeline!, semantic: "TRANSIT" },
  }),
  true,
  "a known Cainiao state with no pickup track still needs its own H5",
);
assert.equal(
  cainiaoAutomaticNeedsH5Supplement({
    ...transitOnly,
    identity: { ...transitOnly.identity, manuallyAdded: true },
  }),
  false,
  "manual shipments never enter the Cainiao automatic H5 gate",
);

const cainiaoH5: TimelinePackage = {
  ...timeline("TRANSIT", "快件运输中", "2"),
  provider: "cainiao_h5",
  complete: false,
};
const staleManual = {
  ...timeline("COMPLETED", "已签收", "5"),
  provider: "kdniao",
};
assert.equal(
  selectShipmentDetailTimeline({
    ...transitOnly,
    manualTimelines: [staleManual],
  }).provider,
  "interface5",
  "a missing pickup stage alone must not let a stale manual sidecar bypass Cainiao H5",
);
// 兜底激活之后 kdniao 才**有资格**进候选；但排序上它是最后一层（付费手动包），本地 feed
// 增量仍然在它之上（用户定 2026-09-04 的统一优先级）。
assert.equal(
  selectShipmentDetailTimeline(activateCainiaoManualFallback({
    ...transitOnly,
    manualTimelines: [staleManual],
  }, NOW + 1)).provider,
  "interface5",
  "本地 feed 增量在付费手动包之上",
);
// feed 没有可用节点时，才轮到已缓存的 kdniao 包显示。
assert.equal(
  selectShipmentDetailTimeline(activateCainiaoManualFallback({
    ...transitOnly,
    sourceTimeline: { ...timeline("TRANSIT", "运输中", "2"), tracks: [] },
    manualTimelines: [staleManual],
  }, NOW + 1)).provider,
  "kdniao",
  "feed 无可用节点时才显示已缓存的付费兜底包",
);
// 用户定 2026-09-04：详情页展示 = 已缓存的包里先筛完整、再取节点最多，**并列时 feed 赢**。
// 三个包节点数相同且都不完整时，feed（interface5）拿下。
assert.equal(
  selectShipmentDetailTimeline({
    ...transitOnly,
    manualTimelines: [
      cainiaoH5,
      { ...timeline("COMPLETED", "已签收", "5"), provider: "kdniao" },
    ],
  }).provider,
  "interface5",
  "完整性与节点数并列时 feed 赢",
);
// 排序是「完整性 → 节点覆盖 → 层级」，层级只当并列时的 tiebreak。2026-09-04 实测的 bug 是
// 19 条完整的 interface5 被 6 条的 kdniao 顶掉——按覆盖比较就不会再发生。
const richCainiaoH5: TimelinePackage = {
  ...cainiaoH5,
  // 判据是「先筛完整、再取节点最多」，所以这里要跟 feed 同为完整，比较才落在节点数上。
  complete: true,
  tracks: [
    ...cainiaoH5.tracks,
    {
      timeText: "2026-08-26 12:00:00",
      timeMs: Date.UTC(2026, 7, 26, 4, 0, 0),
      detail: "快件已揽收",
      statusCode: "1",
      raw: {},
    },
  ],
};
assert.equal(
  selectShipmentDetailTimeline({
    ...transitOnly,
    manualTimelines: [richCainiaoH5],
  }).provider,
  "cainiao_h5",
  "完整性与覆盖优先于层级：完整且节点更多的包胜出",
);

const sync = readFileSync(
  new URL("../services/sync.ts", import.meta.url),
  "utf8",
);
assert.match(
  sync,
  /const cainiaoH5Requested = explicitTimelineRefresh &&[\s\S]*?cainiaoAutomaticNeedsH5Supplement\(enrichmentBase\)[\s\S]*?await refreshCainiaoH5\([\s\S]*?cainiaoH5Succeeded = Boolean\([\s\S]*?containsTimelinePickupTrack\(capturedCainiaoH5\.tracks\)[\s\S]*?const cainiaoManualFallbackRequested = cainiaoH5Requested &&[\s\S]*?!cainiaoH5Succeeded;[\s\S]*?const pickerSupplementRequested =[\s\S]*?cainiaoManualFallbackRequested[\s\S]*?if \(pickerSupplementRequested\)/,
  "Cainiao must finish its gated automatic H5 before the ordinary manual chain may start",
);
assert.match(
  sync,
  /const ordinaryAutomaticPrimaryRequested =[\s\S]*?cainiaoManualFallbackRequested[\s\S]*?!hasTimelineStartBeforeKdniao\(enrichmentBase\)[\s\S]*?runManualDetailSourceContest\(/,
  "a failed Cainiao H5 must reuse Picker, Moto plus K100 H5, then gated KDNiao",
);
// 用户定 2026-09-04：菜鸟 H5 的终止判据是揽收（PICKED），不是「抓到任意一条带时间的节点」。
// 只抓到一条「已下单」时链子必须继续往下跑 picker / moto ∥ 快递100 / kdniao。
assert.doesNotMatch(
  sync,
  /cainiaoH5Succeeded = true;/,
  "抓到节点就终止的旧判据不得回归",
);
assert.match(
  sync,
  /refreshed = cainiaoH5Succeeded\s*\?\s*clearCainiaoManualFallback\(cainiaoH5\)\s*:\s*cainiaoH5;/,
  "没到揽收时仍要保留抓到的 H5 包，只是不清兜底标记",
);
assert.doesNotMatch(
  sync,
  /h5Kind === "cainiao"/,
  "Cainiao automatic H5 must not remain inside the manual H5 provider contest",
);

console.log("Cainiao automatic H5 fallback wiring tests passed");
