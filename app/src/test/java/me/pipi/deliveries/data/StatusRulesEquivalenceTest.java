package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.model.StatusSemantic;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.Iterator;

/**
 * Mapping-table migration: every migrated table key equals the old switch. Lite has no
 * kdniao action switch (item 23 skip); kdniao keys are still checked against the shared oracle.
 * After G16 narrowing, the only listed table-vs-old-switch exception is G2 descriptorOverrides.
 */
public final class StatusRulesEquivalenceTest {
    @Test
    public void v5NumericRulesRemainSeparateFromTextAliases() {
        ExpressStatusLabels bundled = ExpressStatusLabels.bundled();
        assertEquals(StatusSemantic.COMPLETED, bundled.code("v5StateNum", "107"));
        assertEquals(StatusSemantic.COMPLETED, bundled.code("v5", "SIGN"));
        assertEquals(null, bundled.code("v5StateNum", "SIGN"));
        assertEquals(null, bundled.code("v5", "107"));
    }

    @Test
    public void kdniaoTableMatchesTheSharedOldSwitchOracle() throws Exception {
        JSONObject rules = new JSONObject(StatusLabelRulesJson.JSON).getJSONObject("statusRules");
        assertGroup(rules, "kdniao", StatusRulesEquivalenceTest::oldKdniaoAction);
        assertGroup(rules, "kdniaoTopState", StatusRulesEquivalenceTest::oldKdniaoState);
    }

    @Test
    public void structuredDescriptionsMatchTheOldSwitchIncludingAuthorizedG16Words() throws Exception {
        JSONObject rules = new JSONObject(StatusLabelRulesJson.JSON).getJSONObject("statusRules");
        assertGroup(rules, "structuredDescriptions",
                StatusRulesEquivalenceTest::oldStructuredDescription);
        assertEquals(StatusSemantic.PICKED, StatusSemantic.fromJtLabel("已揽收"));
        assertEquals(StatusSemantic.DANGER, StatusSemantic.fromStored("", "异常件"));
        assertEquals(StatusSemantic.WAITING_PICKUP, StatusSemantic.fromStored("", "代取件"));
        assertEquals(StatusSemantic.UNKNOWN, StatusSemantic.fromStored("", "分拣"));
        assertEquals(StatusSemantic.UNKNOWN, StatusSemantic.fromStored("", "评价赢京豆"));
    }

    @Test
    public void samsungJdDescriptorOverridesAreTheOnlyListedException() {
        assertEquals(StatusSemantic.TRANSIT,
                ExpressStatusLabels.rules().samsungDescriptorOverride("派件", "开始跨境运输"));
        assertEquals(StatusSemantic.WAITING_PICKUP,
                ExpressStatusLabels.rules().samsungDescriptorOverride("派件", "快递柜存放"));
        assertEquals("old 派件 wire stays DELIVERY without the G2 override",
                StatusSemantic.DELIVERY,
                ExpressStatusLabels.rules().samsungJdStatusAlias("派件"));
    }

    @Test
    public void timelineStartWordsMatchTheOldJudgmentOrder() throws Exception {
        ExpressStatusLabels rules = ExpressStatusLabels.rules();
        JSONObject start = new JSONObject(StatusLabelRulesJson.JSON)
                .getJSONObject("proseRules").getJSONObject("timelineStart");
        assertEquals(toList(start.getJSONArray("pickedWords")),
                rules.proseWords("timelineStart", "pickedWords"));
        assertEquals(toList(start.getJSONArray("orderedWords")),
                rules.proseWords("timelineStart", "orderedWords"));
        assertEquals(toList(start.getJSONArray("notStartWords")),
                rules.proseWords("timelineStart", "notStartWords"));
        assertEquals(toList(start.getJSONArray("orderCompletionWords")),
                rules.proseWords("timelineStart", "orderCompletionWords"));
        assertTrue(rules.proseContains("timelineStart", "pickedWords", "顺丰速运已收取快件"));
        assertTrue(rules.proseContains("timelineStart", "notStartWords", "待揽收"));
        assertTrue(Kuaidi100TimelinePolicy.containsTimelineStart(tracks("已揽收"), "k100_h5", false));
        assertFalse(Kuaidi100TimelinePolicy.containsTimelineStart(tracks("已下单，等待揽收"), "k100_h5", true));
        assertTrue(Kuaidi100TimelinePolicy.containsTimelineStart(tracks("订单已完成配送"), "k100_h5", true));
    }

    private static JSONArray tracks(String detail) throws Exception {
        return new JSONArray().put(new JSONObject()
                .put("time", "2026-09-12 10:00:00")
                .put("context", detail));
    }

    private static java.util.List<String> toList(JSONArray array) throws Exception {
        java.util.List<String> values = new java.util.ArrayList<>();
        for (int index = 0; index < array.length(); index++) values.add(array.getString(index));
        return values;
    }

    private static void assertGroup(JSONObject statusRules, String group,
            java.util.function.Function<String, StatusSemantic> oldSwitch) throws Exception {
        JSONObject object = statusRules.getJSONObject(group);
        Iterator<String> semantics = object.keys();
        while (semantics.hasNext()) {
            String semanticName = semantics.next();
            JSONArray codes = object.getJSONArray(semanticName);
            StatusSemantic expected = StatusSemantic.valueOf(semanticName);
            for (int index = 0; index < codes.length(); index++) {
                String code = codes.getString(index);
                assertEquals(group + " " + code, expected, oldSwitch.apply(code));
                assertEquals(group + " table " + code, expected,
                        ExpressStatusLabels.rules().code(group, code));
            }
        }
    }

    static StatusSemantic oldKdniaoAction(String action) {
        switch (action.trim().toUpperCase(java.util.Locale.ROOT)) {
            case "1": return StatusSemantic.PICKED;
            case "2":
            case "201":
            case "204":
            // Owner decision 2026-11-20 (customs clearance, MEIZU-CUSTOMS-CLEARANCE-20261120):
            // KDNiao Action 602 清关进行中 joins TRANSIT in both Worker tracks; it is an addition to
            // the old switch, not a migration difference.
            case "602": return StatusSemantic.TRANSIT;
            case "202": return StatusSemantic.DELIVERY;
            case "211":
            case "412": return StatusSemantic.WAITING_PICKUP;
            case "3":
            case "301":
            case "302":
            case "304":
            case "311":
            case "406": return StatusSemantic.COMPLETED;
            case "4":
            case "401":
            case "402":
            case "403":
            case "404":
            case "405":
            case "407": return StatusSemantic.DANGER;
            default: return StatusSemantic.UNKNOWN;
        }
    }

    static StatusSemantic oldKdniaoState(String state) {
        switch (state.trim()) {
            case "1": return StatusSemantic.PICKED;
            case "2":
            case "201": return StatusSemantic.TRANSIT;
            case "3": return StatusSemantic.COMPLETED;
            case "4": return StatusSemantic.DANGER;
            default: return StatusSemantic.UNKNOWN;
        }
    }

    static StatusSemantic oldStructuredDescription(String description) {
        switch (description.trim()) {
            case "取消":
            case "已取消": return StatusSemantic.CANCELLED;
            case "问题件":
            case "异常":
            case "异常件":
            case "运输异常": return StatusSemantic.DANGER;
            case "已下单": return StatusSemantic.ORDERED;
            case "已发货": return StatusSemantic.SHIPPED;
            case "揽件":
            case "已揽件":
            case "已揽收": return StatusSemantic.PICKED;
            case "在途":
            case "运输中": return StatusSemantic.TRANSIT;
            case "派件":
            case "派送中": return StatusSemantic.DELIVERY;
            case "待取":
            case "待取件":
            case "代取件":
            case "待领取": return StatusSemantic.WAITING_PICKUP;
            case "签收":
            case "已签收": return StatusSemantic.COMPLETED;
            default: return StatusSemantic.UNKNOWN;
        }
    }
}
