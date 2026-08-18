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
    public void orderProbeQueuesResultsWithoutAFrameWideNativeBridge() {
        String probe = ExpressDetailActivity.orderProjectionProbeScript();
        String reader = ExpressDetailActivity.orderProjectionReadScript();

        assertTrue(probe.contains("__deliveriesOrderProjections"));
        assertTrue(probe.contains("q.length>4"));
        assertFalse(probe.contains(".accept("));
        assertTrue(reader.contains("q.shift()"));
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
    public void bothAccountInterfacesCanOwnACompleteCachedTimeline() {
        assertEquals("interface5", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE5", "")));
        assertEquals("interface6", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE6", "")));
        assertEquals("", ExpressDetailActivity.accountTimelineSource(
                item("I5-JD", "JDWAYBILL123")));
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
        return new ExpressItem(
                1L, "", "TEST123456", "ZTO", "中通快递",
                StatusSemantic.TRANSIT, "运输中", "已到达转运中心",
                "2026-08-22 10:00:00", "[]", "", owner, "",
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
}
