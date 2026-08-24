package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

import org.json.JSONObject;
import org.junit.Test;

public final class ExpressDetailScriptTest {
    @Test
    public void orderProbePostsEveryCandidateAndKeepsTheQueueFallback() {
        String probe = ExpressDetailActivity.orderProjectionProbeScript();
        String reader = ExpressDetailActivity.orderProjectionReadScript();

        assertTrue(probe.contains("__deliveriesOrderProjections"));
        assertTrue(probe.contains("q.length>16"));
        assertTrue(probe.contains("window.deliveriesOrderProjection"));
        assertTrue(probe.contains("bridge.postMessage"));
        assertTrue(probe.contains("function bounded("));
        assertTrue(probe.contains("add(info.waybillCode,carrier)"));
        assertTrue(probe.contains("add(candidate.waybillCode"));
        assertFalse(probe.contains("if(!way){for"));
        assertTrue(reader.contains("q.shift()"));
    }

    @Test
    public void bridgeRejectsNonStringSubframeOversizeAndUntrustedMessages() {
        String valid = "{\"waybillCode\":\"SF123456789\",\"carrierName\":\"\"}";

        assertEquals(valid, ExpressOrderProjectionBridge.validatedPayload(
                true, valid, "https://jingfen.jd.com", true));
        assertEquals("", ExpressOrderProjectionBridge.validatedPayload(
                false, valid, "https://jingfen.jd.com", true));
        assertEquals("", ExpressOrderProjectionBridge.validatedPayload(
                true, valid, "https://jingfen.jd.com", false));
        assertEquals("", ExpressOrderProjectionBridge.validatedPayload(
                true, valid, "https://jd.com.evil.invalid", true));
        assertEquals("", ExpressOrderProjectionBridge.validatedPayload(
                true, "界".repeat(ExpressOrderProjectionBridge.MAX_PAYLOAD_BYTES / 2),
                "https://jd.com", true));
    }

    @Test
    public void nativeCandidateSelectionSkipsTheOrderIdAndAcceptsTheTraceWaybill() {
        String sourceOrder = "350365030147";

        assertEquals(null, ExpressOrderProjectionBridge.candidate(
                "{\"waybillCode\":\"350365030147\",\"carrierName\":\"商城\"}",
                sourceOrder));
        ExpressOrderProjectionBridge.Candidate trace =
                ExpressOrderProjectionBridge.candidate(
                        "{\"waybillCode\":\"SF1234567890\",\"carrierName\":\"顺丰速运\"}",
                        sourceOrder);
        assertEquals("SF1234567890", trace.waybill);
        assertEquals("顺丰速运", trace.carrier);
    }

    @Test
    public void evaluationCallbackAcceptsOnlyEncodedStrings() {
        String projection = "{\"waybillCode\":\"TEST123456\",\"carrierName\":\"快递\"}";

        assertEquals(projection, ExpressDetailActivity.decodeEvaluationString(
                JSONObject.quote(projection)));
        assertEquals("", ExpressDetailActivity.decodeEvaluationString("null"));
        assertEquals("", ExpressDetailActivity.decodeEvaluationString("{}"));
        assertEquals("", ExpressDetailActivity.decodeEvaluationString("not-json"));
    }

    @Test
    public void ordinaryAccountRowsCanOwnACompleteCachedTimeline() {
        assertEquals("interface5", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE5", "", "ZTO", "中通快递", "pipi-route:v5")));
        assertEquals("interface6", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE6", "")));
    }

    @Test
    public void interface5TimelineRoutingFollowsTheRecordSource() {
        assertEquals("", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE5", "", "SF", "顺丰速运")));
        assertEquals("", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE5", "", "ZTO", "中通快递")));
        assertEquals("interface5", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE5", "", "ZTO", "中通快递", "pipi-route:v5")));
        assertEquals("interface5", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE5", "", "SF", "顺丰速运", "pipi-route:v5")));
        assertEquals("interface5", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE5", "", "ZTO", "中通快递",
                        "https://detail.cainiao.com/parcel?secretKey=test&from=interface5")));
        assertEquals("", ExpressDetailActivity.accountTimelineSource(
                accountOrder("I5-JD", "SFPROJECTED123")));
        assertEquals("", ExpressDetailActivity.accountTimelineSource(
                accountOrder("I6-JD", "SFPROJECTED456")));
        assertEquals("interface6", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE6", "", "SF", "顺丰速运")));
    }

    @Test
    public void projectedOrderReadsOnlyTheRealCarrierIdentity() {
        ExpressItem order = accountOrder("I5-JD", "SFPROJECTED123");

        assertEquals("SFPROJECTED123", ExpressDetailActivity.accountTimelineWaybill(order));
        assertEquals("TEST123456", ExpressDetailActivity.accountTimelineWaybill(
                item("INTERFACE5", "", "SF", "顺丰速运")));
    }

    @Test
    public void completeAccountTimelineWinsAndMissingAccountFallsBack() {
        ExpressQueryResult account = result("interface6", "主来源轨迹");
        ExpressQueryResult publicTimeline = result("v4", "公共查询轨迹");
        ExpressQueryResult kuaidi100 = result("kuaidi100", "兜底轨迹");

        assertEquals(account, ExpressDetailActivity.preferredDetailTimeline(
                account, publicTimeline, kuaidi100));
        assertEquals(publicTimeline, ExpressDetailActivity.preferredDetailTimeline(
                null, publicTimeline, kuaidi100));
        assertEquals(kuaidi100, ExpressDetailActivity.preferredDetailTimeline(
                null, null, kuaidi100));
    }

    @Test
    public void missingLocalCacheShowsLoadingOnlyWhileARefreshCanRun() {
        assertEquals(ExpressDetailActivity.InitialTimelinePresentation.LOADING,
                ExpressDetailActivity.initialTimelinePresentation(false, true));
        assertEquals(ExpressDetailActivity.InitialTimelinePresentation.TRACKS,
                ExpressDetailActivity.initialTimelinePresentation(true, true));
        assertEquals(ExpressDetailActivity.InitialTimelinePresentation.EMPTY,
                ExpressDetailActivity.initialTimelinePresentation(false, false));
    }

    @Test
    public void accountOrderWaitsForItsProjectedWaybillBeforeLocalLookup() {
        assertFalse(ExpressDetailActivity.canRefreshLocalTimeline(
                accountOrder("")));
        assertTrue(ExpressDetailActivity.canRefreshLocalTimeline(
                accountOrder("JDWAYBILL123")));
        assertFalse(ExpressDetailActivity.canRefreshLocalTimeline(
                accountOrder("I6-JD", "")));
        assertTrue(ExpressDetailActivity.canRefreshLocalTimeline(
                item("V4", "")));
    }

    @Test
    public void manualAuthoritySuppressesButDoesNotEraseTheProviderRoute() {
        ExpressItem before = sourceOwnedItem("", 0L);
        ExpressItem after = sourceOwnedItem("kuaidi100", 100L);
        ExpressItem manual = manualAuthorityItem(true, "I6-K100");
        ExpressItem promoted = manualAuthorityItem(false, "INTERFACE6");

        assertTrue(ExpressDetailActivity.allowsProviderRoute(before));
        assertFalse(ExpressDetailActivity.allowsProviderRoute(after));
        assertFalse(ExpressDetailActivity.allowsProviderRoute(manual));
        assertFalse(ExpressDetailActivity.allowsProviderRoute(promoted));
        assertEquals(before.detailUrl, after.detailUrl);
        assertEquals(before.routeCredential, after.routeCredential);
    }

    @Test
    public void selectedManualPackageOwnsDetailForManualAndPromotedAccountRows() {
        assertTrue(ExpressDetailActivity.manualTimelineOwnsDetail(
                manualAuthorityItem(true, "I6-K100")));
        assertTrue(ExpressDetailActivity.manualTimelineOwnsDetail(
                manualAuthorityItem(false, "INTERFACE6")));
        assertFalse(ExpressDetailActivity.manualTimelineOwnsDetail(
                manualAuthorityItem(false, "INTERFACE6", "", 0L)));
    }

    private static ExpressItem accountOrder(String projectedWaybill) {
        return accountOrder("I5-JD", projectedWaybill);
    }

    private static ExpressItem accountOrder(String owner, String projectedWaybill) {
        return new ExpressItem(
                1L, "", "JDORDER123456", "JD", "京东购物",
                StatusSemantic.TRANSIT, "运输中", "订单正在配送",
                "2026-08-22 10:00:00", "[]", "", owner, "",
                1L, 2L, owner, "", "v5", "route", true,
                projectedWaybill, "", "[]");
    }

    private static ExpressItem item(String owner, String projectedWaybill) {
        return item(owner, projectedWaybill, "ZTO", "中通快递");
    }

    private static ExpressItem item(
            String owner, String projectedWaybill, String courierCode, String companyName) {
        return item(owner, projectedWaybill, courierCode, companyName, "");
    }

    private static ExpressItem item(
            String owner, String projectedWaybill, String courierCode, String companyName,
            String detailUrl) {
        return new ExpressItem(
                1L, "", "TEST123456", courierCode, companyName,
                StatusSemantic.TRANSIT, "运输中", "已到达转运中心",
                "2026-08-22 10:00:00", "[]", "", owner, detailUrl,
                1L, 2L, owner, "", "", "", true,
                projectedWaybill, "", "[]");
    }

    private static ExpressQueryResult result(String provider, String detail) {
        return new ExpressQueryResult(
                "TEST123456", "ZTO", "中通快递", StatusSemantic.TRANSIT,
                "2026-08-22 10:00:00", detail,
                "[{\"time\":\"2026-08-22 10:00:00\",\"context\":\""
                        + detail + "\"}]",
                "", "", provider);
    }

    private static ExpressItem sourceOwnedItem(String manualProvider, long successAt) {
        return new ExpressItem(
                8L, "", "SFTEST123456", "SF", "顺丰速运",
                StatusSemantic.TRANSIT, "运输中", "账号来源摘要",
                "2026-08-24 10:00:00", "[]", "", "INTERFACE5",
                "pipi-route:v5", 1L, 2L, "INTERFACE5", "INTERFACE5",
                "v5", "https://example.invalid/private-route", true,
                "", "", "", "ShunFeng", false, manualProvider, successAt);
    }

    private static ExpressItem manualAuthorityItem(boolean manual, String owner) {
        return manualAuthorityItem(manual, owner, "kuaidi100", 100L);
    }

    private static ExpressItem manualAuthorityItem(
            boolean manual, String owner, String provider, long successAt) {
        return new ExpressItem(
                9L, "13900000000", "SFTEST123456", "SF", "顺丰速运",
                StatusSemantic.COMPLETED, "已签收", "快件已签收",
                "2026-08-25 09:00:00",
                "[{\"time\":\"2026-08-25 09:00:00\","
                        + "\"context\":\"快件已签收\"}]",
                "", owner, "", 1L, 2L, owner, "", "", "", true,
                "", "", "", "", manual, provider, successAt);
    }
}
