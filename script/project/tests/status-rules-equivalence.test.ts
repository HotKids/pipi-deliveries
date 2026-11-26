import assert from "node:assert/strict";
import type { StatusSemantic } from "../models";
import {
  BOOTSTRAP_STATUS_LABEL_TABLE,
  exactStructuredSemantic,
  proseContains,
  proseWords,
  samsungDescriptorOverride,
  statusRuleSemantic,
} from "../services/status-labels";
import { startSemanticFromText } from "../services/status";

type CodeGroup = Readonly<Record<string, readonly string[]>>;

function oldKdniaoAction(value: string): StatusSemantic {
  switch (value.trim().toUpperCase()) {
    case "1": return "PICKED";
    case "2":
    case "201":
    case "204":
    // Owner decision 2026-11-20 (customs clearance, MEIZU-CUSTOMS-CLEARANCE-20261120): KDNiao Action
    // 602 清关进行中 joins TRANSIT in both Worker tracks; it is an addition to the old switch, not a
    // migration difference.
    case "602": return "TRANSIT";
    case "202": return "DELIVERY";
    case "211":
    case "412": return "WAITING_PICKUP";
    case "3":
    case "301":
    case "302":
    case "304":
    case "311":
    case "406": return "COMPLETED";
    case "4":
    case "401":
    case "402":
    case "403":
    case "404":
    case "405":
    case "407": return "DANGER";
    default: return "UNKNOWN";
  }
}

function oldKdniaoState(value: string): StatusSemantic {
  switch (value.trim()) {
    case "1": return "PICKED";
    case "2":
    case "201": return "TRANSIT";
    case "3": return "COMPLETED";
    case "4": return "DANGER";
    default: return "UNKNOWN";
  }
}

/** Old structuredDescriptions switch plus the authorized G16 extras. */
function oldStructuredDescription(value: string): StatusSemantic {
  switch (value.trim()) {
    case "取消":
    case "已取消": return "CANCELLED";
    case "问题件":
    case "异常":
    case "异常件":
    case "运输异常": return "DANGER";
    case "已下单": return "ORDERED";
    case "已发货": return "SHIPPED";
    case "揽件":
    case "已揽件":
    case "已揽收": return "PICKED";
    case "在途":
    case "运输中": return "TRANSIT";
    case "派件":
    case "派送中": return "DELIVERY";
    case "待取":
    case "待取件":
    case "代取件":
    case "待领取": return "WAITING_PICKUP";
    case "签收":
    case "已签收": return "COMPLETED";
    default: return "UNKNOWN";
  }
}

function assertGroup(
  group: string,
  table: CodeGroup,
  oldSwitch: (code: string) => StatusSemantic,
): void {
  for (const [semantic, codes] of Object.entries(table)) {
    for (const code of codes) {
      assert.equal(oldSwitch(code), semantic as StatusSemantic, `${group} oracle ${code}`);
      assert.equal(statusRuleSemantic(group, code), semantic as StatusSemantic, `${group} table ${code}`);
    }
  }
}

const statusRules = BOOTSTRAP_STATUS_LABEL_TABLE.statusRules as Record<string, unknown>;
assertGroup("kdniao", statusRules.kdniao as CodeGroup, oldKdniaoAction);
assert.equal(statusRuleSemantic("kdniao", "602"), "TRANSIT", "owner 2026-11-20: KDNiao 602 is 运输中 (清关中)");
assertGroup("kdniaoTopState", statusRules.kdniaoTopState as CodeGroup, oldKdniaoState);
assertGroup(
  "structuredDescriptions",
  statusRules.structuredDescriptions as CodeGroup,
  oldStructuredDescription,
);

assert.equal(exactStructuredSemantic("已揽收"), "PICKED");
assert.equal(exactStructuredSemantic("异常件"), "DANGER");
assert.equal(exactStructuredSemantic("运输异常"), "DANGER");
assert.equal(exactStructuredSemantic("代取件"), "WAITING_PICKUP");
assert.equal(exactStructuredSemantic("待领取"), "WAITING_PICKUP");
assert.equal(exactStructuredSemantic("分拣"), null);
assert.equal(exactStructuredSemantic("评价赢京豆"), null);
assert.equal(exactStructuredSemantic("订单完成"), null);

assert.equal(
  samsungDescriptorOverride("派件", "开始跨境运输"),
  "TRANSIT",
  "G2 exception: table override vs old 派件 DELIVERY",
);
assert.equal(
  samsungDescriptorOverride("派件", "快递柜存放"),
  "WAITING_PICKUP",
  "G2 exception: table override vs old 派件 DELIVERY",
);
assert.equal(statusRuleSemantic("common", "派件"), "DELIVERY");

for (const word of proseWords("timelineStart", "pickedWords")) {
  assert.equal(startSemanticFromText(word), "PICKED", word);
}
for (const word of proseWords("timelineStart", "orderedWords")) {
  assert.equal(startSemanticFromText(word), "ORDERED", word);
}
for (const word of proseWords("timelineStart", "notStartWords")) {
  assert.equal(startSemanticFromText(word), "UNKNOWN", word);
  assert.equal(startSemanticFromText(word + "已揽收"), "UNKNOWN", word);
}
for (const word of proseWords("timelineStart", "orderCompletionWords")) {
  assert.equal(startSemanticFromText(word), "UNKNOWN", word);
  assert.equal(proseContains("timelineStart", "orderCompletionWords", word), true, word);
}
