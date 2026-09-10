import assert from "node:assert/strict";
import type { Shipment, TimelinePackage } from "../models";
import {
  selectShipmentDetailTimeline,
  selectShipmentTimeline,
  withDetailSelection,
} from "../services/shipment-policy";

const NOW = Date.UTC(2026, 8, 1, 10, 0, 0);

function timeline(
  provider: string,
  count: number,
  options: Readonly<{
    courierCode?: string;
    semantic?: TimelinePackage["semantic"];
    complete?: boolean;
    marker?: string;
  }> = {},
): TimelinePackage {
  const courierCode = options.courierCode || "SF";
  const semantic = options.semantic || "TRANSIT";
  // 详情完整的判据（用户定 2026-09-04）要求轨迹里有揽收，且最新节点与 feed 相差 ≤30 分钟。
  // 所有 fixture 的最新节点都落在 NOW，时间那一半天然成立；这里给最老的那条补上揽收，
  // 让「多节点包 = 完整」这个 fixture 语义继续成立。单节点包保持不完整。
  const tracks = Array.from({ length: count }, (_, index) => ({
    timeText: `2026-09-01 ${String(10 - index).padStart(2, "0")}:00:00`,
    timeMs: NOW - index * 60 * 60 * 1_000,
    detail: count >= 2 && index === count - 1
      ? `${provider} 快件已揽收`
      : `${provider} node ${index + 1}`,
    statusCode: "",
    raw: options.marker ? { _pipiKuaidi100Com: options.marker } : {},
  }));
  return {
    provider,
    complete: options.complete ?? count >= 2,
    waybill: courierCode === "JD" ? "JD1234567890" : "SF1234567890",
    courierCode,
    companyName: courierCode === "JD" ? "京东快递" : "顺丰速运",
    semantic,
    statusEventAtMs: tracks[0]?.timeMs || null,
    latestTimeText: tracks[0]?.timeText || "",
    latestDetail: tracks[0]?.detail || "",
    tracks,
    successAtMs: NOW,
  };
}

function baseShipment(options: Readonly<{
  manuallyAdded?: boolean;
  sourceProvider?: string;
  courierCode?: string;
  manuals: TimelinePackage[];
  source?: TimelinePackage | null;
}>): Shipment {
  const courierCode = options.courierCode || "SF";
  const source = options.source ?? null;
  return {
    identity: {
      id: `interface5:${options.manuallyAdded ? "manual" : "account"}:test`,
      bindingSource: "interface5",
      sourceOwner: options.manuallyAdded ? "manual" : "account",
      sourceId: "test",
      phoneTail: "1234",
      courierCode,
      rawCourierCode: courierCode,
      companyName: courierCode === "JD" ? "京东快递" : "顺丰速运",
      sourceProvider: options.sourceProvider,
      manuallyAdded: Boolean(options.manuallyAdded),
      createdAtMs: NOW,
    },
    timeline: source || options.manuals[0],
    sourceTimeline: source,
    manualTimelines: options.manuals,
    updatedAtMs: NOW,
  };
}

const local = timeline("local", 3, { complete: false });
const richerWeb = timeline("web", 5);
const manual = baseShipment({ manuallyAdded: true, manuals: [local, richerWeb] });
assert.equal(
  selectShipmentTimeline(manual).provider,
  "web",
  "without a Picker result, the Home row must use the Moto/K100 race winner",
);
assert.equal(selectShipmentDetailTimeline(manual).provider, "web");
assert.equal(selectShipmentDetailTimeline(manual).tracks.length, 5);

const sparseWeb = timeline("web", 2);
const richerLocal = baseShipment({ manuallyAdded: true, manuals: [local, sparseWeb] });
// 用户定 2026-09-04：「完整」不再看包自称的 complete 标志，而是判据——最新节点与 feed 相差
// ≤30 分钟且有揽收。两个包都满足，就比覆盖：moto 3 条胜过 K100 的 2 条。
assert.equal(
  selectShipmentDetailTimeline(richerLocal).provider,
  "local",
  "两个包都满足完整判据时比覆盖",
);
assert.equal(selectShipmentDetailTimeline(richerLocal).tracks.length, 3);

const equalCompleteMoto = timeline("local", 2, { complete: true });
const equalCompleteK100 = timeline("kuaidi100_h5", 2, {
  complete: true,
  marker: "shunfeng",
});
const equalPrimary = baseShipment({
  manuallyAdded: true,
  manuals: [equalCompleteMoto, equalCompleteK100],
});
assert.equal(
  selectShipmentDetailTimeline(equalPrimary).provider,
  "local",
  "otherwise equal iOS primary packages use Moto before K100 H5",
);

const equalCompletePicker = timeline("route", 2, { complete: true });
const equalCompletePickerFirst = baseShipment({
  manuallyAdded: true,
  manuals: [equalCompleteMoto, equalCompleteK100, equalCompletePicker],
});
assert.equal(
  selectShipmentDetailTimeline(equalCompletePickerFirst).provider,
  "route",
  "otherwise equal complete packages use Picker before the primary round",
);
const equalCompleteShunFengPickerFirst = baseShipment({
  sourceProvider: "ShunFeng",
  manuals: [equalCompleteK100, equalCompletePicker],
  source: timeline("interface5", 1, { complete: false }),
});
assert.equal(
  selectShipmentDetailTimeline(equalCompleteShunFengPickerFirst).provider,
  "route",
  "otherwise equal ShunFeng detail packages use Picker before K100 H5",
);

const partialPicker = timeline("route", 1, { complete: false });
const newerPartialMoto = {
  ...timeline("local", 3, { complete: false }),
  statusEventAtMs: NOW + 60 * 60 * 1_000,
};
const newestPartialK100 = {
  ...timeline("kuaidi100_h5", 5, {
    complete: false,
    marker: "shunfeng",
  }),
  statusEventAtMs: NOW + 2 * 60 * 60 * 1_000,
};
const partialPickerFirst = baseShipment({
  manuallyAdded: true,
  manuals: [newestPartialK100, newerPartialMoto, partialPicker],
});
// 用户定 2026-09-04：详情页展示 = 先筛完整、再取**有效节点最多**。都不完整时就比节点覆盖，
// 而不是查询顺序——2026-09-04 实测到菜鸟 H5 抓回 10 条后详情反而掉到 6 条的 kdniao。
// picker 1 条 / moto 3 条 / 快递100 5 条，取 5 条那个。
assert.equal(
  selectShipmentDetailTimeline(partialPickerFirst).provider,
  "kuaidi100_h5",
  "都不完整时按节点覆盖取最多",
);

const account = timeline("interface5", 1, {
  semantic: "COMPLETED",
  complete: false,
});
const picker = timeline("route", 1, { complete: false });
const fallback = timeline("fallback", 7, { complete: true });
const shunFeng = baseShipment({
  sourceProvider: "ShunFeng",
  manuals: [picker, richerWeb, fallback],
  source: account,
});
assert.equal(selectShipmentTimeline(shunFeng).provider, "fallback",
  "SF Home and detail select the same complete manual package (user decision 2026-09-09)");
// 顺丰的 source 是粗略轨迹（层级排最后），且这里只有 1 条、没有揽收；fallback 7 条带揽收，
// 按「完整性 → 覆盖」胜出。详情不做终态保护——列表状态由 selectShipmentTimeline 负责。
assert.equal(
  selectShipmentDetailTimeline(shunFeng).provider,
  "fallback",
  "顺丰详情按完整判据与覆盖选包，来源粗轨迹只兜底",
);
const shunFengFallback = { ...shunFeng, manualTimelines: [picker, fallback] };
assert.equal(selectShipmentDetailTimeline(shunFengFallback).provider, "fallback");

const jdAccount = timeline("interface5", 1, {
  courierCode: "JD",
  semantic: "COMPLETED",
  complete: false,
});
const jdLocal = timeline("local", 9, { courierCode: "JD" });
const jdKuaidi100 = timeline("kuaidi100_h5", 2, {
  courierCode: "JD",
  marker: "jd",
});
const jdFallback = timeline("fallback", 6, { courierCode: "JD" });
const jingDong = baseShipment({
  sourceProvider: "JingDong",
  courierCode: "JD",
  manuals: [jdLocal, jdKuaidi100, jdFallback],
  source: jdAccount,
});
// 用户定 2026-09-05 晚：京东行的列表归 feed；H5 / 手动包各住各的槽，只在详情页参与选包。
assert.equal(
  selectShipmentTimeline(jingDong).provider,
  "interface5",
  "the JD list row is the feed package itself",
);
// 排序是「完整性 → 覆盖 → 层级」：feed 只有 1 条且无揽收，判据不成立；fallback 6 条带揽收
// 且时间与 feed 对齐，胜出。层级（接口 → feed → 免费手动 → 付费手动）只在前两项并列时才用。
assert.equal(
  selectShipmentDetailTimeline(jingDong).provider,
  "fallback",
  "完整判据成立且覆盖更多的包胜出",
);
// 手动包内部同样是「完整性 → 覆盖 → 层级」：两个都完整时 kdniao 的 6 条胜过 K100 的 2 条。
// 免费/付费的层级只在完整性与覆盖都并列时才决定胜负——展示只在已缓存的包里挑，不会因此多花钱。
assert.equal(
  selectShipmentDetailTimeline({
    ...jingDong,
    sourceTimeline: null,
    timeline: jdKuaidi100,
  }).provider,
  "fallback",
  "完整性相同就比覆盖，免费/付费只当并列时的 tiebreak",
);
const jingDongFallback = {
  ...jingDong,
  manualTimelines: [jdLocal, jdFallback],
};
// 京东链无 moto，jdLocal 没有资格；feed 1 条无揽收判据不成立，fallback 6 条带揽收胜出。
assert.equal(selectShipmentDetailTimeline(jingDongFallback).provider, "fallback");

const jingDongPartialPicker = timeline("route", 1, {
  courierCode: "JD",
  complete: false,
});
const jingDongPartialKuaidi100 = timeline("kuaidi100_h5", 1, {
  courierCode: "JD",
  complete: false,
  marker: "jd",
});
const jingDongPickerFirst = {
  ...jingDong,
  manualTimelines: [jingDongPartialKuaidi100, jingDongPartialPicker],
};
// 三个包完整性与覆盖都并列，层级 tiebreak 决定胜负。feed 只有一条节点时它是**状态摘要不是
// 轨迹**，排在手动包之后——否则详情会压回 feed 的那一条而丢掉承运商刚给的节点。
assert.equal(
  selectShipmentDetailTimeline(jingDongPickerFirst).provider,
  "route",
  "并列时只有一条节点的 feed 让位给手动包，手动层内部 Picker 先于 K100",
);
// 纯手动件没有 feed，手动层内部仍是 Picker 先于 K100。
// （自动件不能靠把 sourceTimeline 置空来表达「没有来源包」：sourceTimeline() 会退回
//  shipment.timeline，那样反而把 Picker 包当成了 feed。）
assert.equal(
  selectShipmentDetailTimeline({
    ...jingDongPickerFirst,
    identity: { ...jingDongPickerFirst.identity, manuallyAdded: true },
    sourceTimeline: null,
    timeline: jingDongPartialPicker,
  }).provider,
  "route",
  "手动层内部 Picker 先于 K100",
);

const jingDongCompleteKuaidi100 = timeline("kuaidi100_h5", 2, {
  courierCode: "JD",
  complete: true,
  marker: "jd",
});
const jingDongPartialFallbackWithStart = {
  ...timeline("fallback", 1, { courierCode: "JD", complete: false }),
  tracks: [{
    ...timeline("fallback", 1, { courierCode: "JD", complete: false }).tracks[0],
    detail: "京东订单已下单",
    statusCode: "101",
  }],
};
assert.equal(
  selectShipmentDetailTimeline({
    ...jingDong,
    manualTimelines: [
      jingDongCompleteKuaidi100,
      jingDongPartialFallbackWithStart,
    ],
  }).provider,
  "kuaidi100_h5",
  "完整判据成立的 K100 包胜过只有起点证据的 partial 兜底包",
);

const completeJdMoto = timeline("local", 2, {
  courierCode: "JD",
  complete: true,
});
const partialJdFallback = timeline("fallback", 1, {
  courierCode: "JD",
  complete: false,
});
assert.equal(
  selectShipmentDetailTimeline(baseShipment({
    manuallyAdded: true,
    courierCode: "JD",
    manuals: [partialJdFallback, completeJdMoto],
  })).provider,
  "local",
  "a JD carrier identity alone must not exclude Moto from a pure-manual detail",
);
assert.equal(
  selectShipmentDetailTimeline(baseShipment({
    sourceProvider: "CaiNiao",
    courierCode: "JD",
    manuals: [partialJdFallback, completeJdMoto],
    source: timeline("interface5", 1, {
      courierCode: "JD",
      complete: false,
    }),
  })).provider,
  "interface5",
  "a Cainiao-owned JD-carried parcel stays on its owner package despite stale manual sidecars",
);
assert.equal(
  selectShipmentDetailTimeline(baseShipment({
    sourceProvider: "Douyin",
    courierCode: "JD",
    manuals: [partialJdFallback, completeJdMoto],
    source: timeline("interface5", 1, {
      courierCode: "JD",
      complete: false,
    }),
  })).provider,
  "local",
  "an ordinary automatic JD-carried parcel must not be treated as a JingDong source",
);
assert.notEqual(
  selectShipmentDetailTimeline(baseShipment({
    sourceProvider: "JingDong",
    courierCode: "JD",
    manuals: [partialJdFallback, completeJdMoto],
    source: timeline("interface5", 1, {
      courierCode: "JD",
      complete: false,
    }),
  })).provider,
  "local",
  "a true JingDong business source must continue to exclude Moto",
);

// 实盘回归（2026-09-05 00:45，菜鸟 HTKY 尾号 4547）：五个包全部自报 complete，旧规则「complete
// 先赢、再比最新事件时间」让 6 条的快递鸟顶掉了 19 条的 feed——列表页显示 19 条，点进详情只剩
// 6 条。完整性并列时必须比有效节点数。
{
  const cainiaoField = baseShipment({
    courierCode: "HTKY",
    sourceProvider: "CaiNiao",
    source: timeline("interface5", 19, { courierCode: "HTKY", semantic: "COMPLETED" }),
    manuals: [
      timeline("kuaidi100_h5", 11, { courierCode: "HTKY", semantic: "COMPLETED" }),
      timeline("kdniao", 6, { courierCode: "HTKY", semantic: "COMPLETED" }),
      timeline("cainiao_h5", 10, { courierCode: "HTKY", semantic: "COMPLETED" }),
      timeline("meizu", 3, { courierCode: "HTKY", semantic: "COMPLETED" }),
    ],
  });
  const selected = selectShipmentDetailTimeline(cainiaoField);
  assert.equal(selected.provider, "interface5", "19 条的 feed 不能输给 6 条的快递鸟");
  assert.equal(
    selected.tracks.filter((track) => track.timeMs).length,
    19,
    "详情页拿到的节点数不能比列表页少",
  );
}


// 粘性选包（用户定 2026-09-05 晚）：上一轮显示过的包还在就默认还显示它；只有它不完整而
// 排第一的包完整时才换；包不在了（被清掉 / 串包）就照常排序。
{
  const stickyPicker = timeline("route", 3, { complete: true });
  const stickyK100 = timeline("kuaidi100_h5", 5, { complete: true, marker: "shunfeng" });
  const base = baseShipment({ manuallyAdded: true, manuals: [stickyPicker, stickyK100] });
  assert.equal(selectShipmentDetailTimeline(base).provider, "kuaidi100_h5", "默认按节点覆盖");
  assert.equal(
    selectShipmentDetailTimeline({
      ...base,
      detailSelection: { provider: "route", selectedAtMs: NOW },
    }).provider,
    "route",
    "上一轮显示的 picker 还在且完整，就还是 picker",
  );
  assert.equal(
    selectShipmentDetailTimeline({
      ...base,
      detailSelection: { provider: "kdniao", selectedAtMs: NOW },
    }).provider,
    "kuaidi100_h5",
    "上一轮的包不在了，照常排序",
  );
  const partialPicker = timeline("route", 1, { complete: false });
  assert.equal(
    selectShipmentDetailTimeline({
      ...baseShipment({ manuallyAdded: true, manuals: [partialPicker, stickyK100] }),
      detailSelection: { provider: "route", selectedAtMs: NOW },
    }).provider,
    "kuaidi100_h5",
    "上一轮的包不完整而对方完整，换",
  );
  const stamped = withDetailSelection(base, NOW + 1);
  assert.equal(stamped.detailSelection?.provider, "kuaidi100_h5");
  assert.equal(
    withDetailSelection(stamped, NOW + 2).detailSelection?.selectedAtMs,
    NOW + 1,
    "同一个包不重复盖时间戳",
  );
}

console.log("manual detail timeline selection tests passed");
