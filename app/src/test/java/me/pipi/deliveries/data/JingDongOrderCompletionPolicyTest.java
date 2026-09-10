package me.pipi.deliveries.data;

import static org.junit.Assert.*;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

public final class JingDongOrderCompletionPolicyTest {
    private static final String REVIEW = "您的订单123456789已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。";
    private static final String PRODUCT = "您的订单[测试商品]已完成，80京豆等您拿，完成评价即有机会获得，不要错过呦！";

    @Test public void exactTemplatesRequireTheKnownOrderAndKeepOtherText() {
        assertTrue(JingDongOrderCompletionPolicy.matches(REVIEW, "123456789"));
        assertTrue(JingDongOrderCompletionPolicy.matches(REVIEW, ""));
        assertFalse(JingDongOrderCompletionPolicy.matches(REVIEW, "987654321"));
        assertTrue(JingDongOrderCompletionPolicy.matches(PRODUCT, "123456789"));
        for (String text : new String[]{"已完成", "完成评价", "40京豆等您拿", "您的快件已送达至家门口",
                "订单已完成配送，感谢您选择京东购物", "预计明天送达", "您的订单123456789已完成"}) {
            assertFalse(text, JingDongOrderCompletionPolicy.matches(text, "123456789"));
        }
    }

    @Test public void removedStateUsesOnlySurvivingStructuredEvidence() throws Exception {
        ExpressQueryResult original = packet(new JSONArray().put(track("11:00:00", REVIEW))
                .put(track("10:00:00", "真实签收").put("statusCode", "107")));
        ExpressQueryResult clean = JingDongOrderCompletionPolicy.clean(original, "123456789");
        assertEquals("真实签收", clean.latestDetail);
        assertEquals(StatusSemantic.COMPLETED, clean.semantic);
        assertEquals(time("10:00:00"), clean.statusEventTime);
        assertSame(clean, JingDongOrderCompletionPolicy.clean(clean, "123456789"));
        assertEquals(original.waybill, clean.waybill);
        assertEquals(original.courierCode, clean.courierCode);
        assertEquals(original.detailUrl, clean.detailUrl);
        assertEquals(original.routeCredential, clean.routeCredential);
    }

    @Test public void deliveryProseCannotSupplyTheRemovedOrderStatus() throws Exception {
        ExpressQueryResult clean = JingDongOrderCompletionPolicy.clean(packet(
                new JSONArray().put(track("11:00:00", REVIEW))
                        .put(track("10:00:00", "您的快件已送达至家门口"))), "123456789");
        assertEquals(StatusSemantic.UNKNOWN, clean.semantic);
        assertEquals(0L, clean.statusEventTime);
        assertFalse(clean.structuredStatusEvidence);
        assertEquals("您的快件已送达至家门口", clean.latestDetail);
    }

    @Test public void independentCarrierStatusTimeSurvivesReviewRemoval() throws Exception {
        ExpressQueryResult original = packet(new JSONArray().put(track("11:00:00", REVIEW))
                .put(track("10:00:00", "真实签收")));
        original = new ExpressQueryResult(original.waybill, original.courierCode, original.companyName,
                StatusSemantic.COMPLETED, time("10:00:00"), original.latestTime, original.latestDetail,
                original.tracksJson, original.detailUrl, "", "v5_query", "", "", "JingDong");
        ExpressQueryResult clean = JingDongOrderCompletionPolicy.clean(original, "123456789");
        assertEquals(StatusSemantic.COMPLETED, clean.semantic);
        assertEquals(time("10:00:00"), clean.statusEventTime);
    }

    @Test public void emptyHistoryDoesNotKeepTheReviewSummaryOrState() throws Exception {
        ExpressQueryResult clean = JingDongOrderCompletionPolicy.clean(
                packet(new JSONArray().put(track("11:00:00", REVIEW))), "123456789");
        assertEquals("[]", clean.tracksJson);
        assertEquals("", clean.latestDetail);
        assertEquals("", clean.latestTime);
        assertEquals(StatusSemantic.UNKNOWN, clean.semantic);
        assertEquals(0L, clean.statusEventTime);
    }

    @Test public void actualInterface5ParserCodesRecoverStatusWithoutCrossProviderGuessing() throws Exception {
        java.lang.reflect.Method parse = Class.forName(
                "me.pipi.deliveries.network.ExpressDiscoveryClient").getDeclaredMethod(
                "parseExpress", JSONObject.class, String.class, String.class);
        parse.setAccessible(true);
        for (String code : new String[]{"107", "105"}) {
            JSONObject packet = new JSONObject().put("mailNo", "JDTEST1107")
                    .put("cpCode", "JD").put("name", "京东快递").put("provider", "JingDong")
                    .put("details", new JSONArray().put(track("11:00:00", REVIEW))
                            .put(track("10:00:00", "真实状态节点").put("statusCode", code)));
            ExpressQueryResult parsed = (ExpressQueryResult) parse.invoke(null, packet, "", "");
            assertNotNull(parsed);
            ExpressQueryResult clean = JingDongOrderCompletionPolicy.clean(parsed, "");
            assertEquals("107".equals(code) ? StatusSemantic.COMPLETED : StatusSemantic.DELIVERY,
                    clean.semantic);
            assertEquals(time("10:00:00"), clean.statusEventTime);
        }
        ExpressQueryResult foreignCode = packet(new JSONArray().put(track("11:00:00", REVIEW))
                .put(track("10:00:00", "其他来源节点").put("statusCode", "107")
                        .put("_pipiStatusSource", "k100_h5")));
        assertEquals(StatusSemantic.UNKNOWN,
                JingDongOrderCompletionPolicy.clean(foreignCode, "").semantic);
    }

    private static JSONObject track(String hour, String detail) throws Exception {
        return new JSONObject().put("time", "2026-09-09 " + hour).put("context", detail)
                .put("_pipiStatusSource", "interface5");
    }

    private static ExpressQueryResult packet(JSONArray tracks) {
        return new ExpressQueryResult("JDTEST1107", "YTO", "圆通速递", StatusSemantic.COMPLETED,
                time("11:00:00"), "2026-09-09 11:00:00", REVIEW, tracks.toString(),
                "original-route", "", "v5_query", "v5", "original-capability", "JingDong")
                .withManualStatusEvidence("已签收", true);
    }

    private static long time(String hour) {
        return ExpressSourcePolicy.parseEventTime("2026-09-09 " + hour);
    }
}
