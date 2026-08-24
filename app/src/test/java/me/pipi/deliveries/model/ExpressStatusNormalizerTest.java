package me.pipi.deliveries.model;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class ExpressStatusNormalizerTest {
    @Test
    public void dangerUsesTheUnifiedUserVisibleLabel() {
        assertEquals("异常件", StatusSemantic.DANGER.label);
        assertEquals(StatusSemantic.DANGER, StatusSemantic.fromStored("", "异常件"));
    }

    @Test
    public void explicitInterface5PickupEvidenceOverridesStaleTransitState() {
        assertEquals(StatusSemantic.WAITING_PICKUP, ExpressStatusNormalizer.normalize(
                "INTERFACE5", "TRANSPORT", "运输中",
                "【代收点】您的包裹已暂存至丰巢柜，请及时领取"));
    }

    @Test
    public void genericArrivalDoesNotBecomeWaitingPickup() {
        assertEquals(StatusSemantic.TRANSIT, ExpressStatusNormalizer.normalize(
                "INTERFACE5", "TRANSPORT", "运输中", "快件到达长沙，继续运输"));
    }

    @Test
    public void terminalStructuredStateIsNeverOverriddenByDetailText() {
        assertEquals(StatusSemantic.COMPLETED, ExpressStatusNormalizer.normalize(
                "INTERFACE5", "SIGN", "已签收", "已存放在丰巢柜，请及时领取"));
    }

    @Test
    public void identifiesProviderErrorsWithoutRejectingRealEvents() {
        assertTrue(ExpressStatusNormalizer.isProviderErrorDetail("no result"));
        assertTrue(ExpressStatusNormalizer.isProviderErrorDetail("验证码错误，请重试"));
        assertTrue(ExpressStatusNormalizer.isProviderErrorDetail("暂无物流动态"));
        assertFalse(ExpressStatusNormalizer.isProviderErrorDetail("快件到达杭州转运中心"));
    }

    @Test
    public void stateLabelsAreNotLatestLogisticsEvents() {
        assertTrue(ExpressStatusNormalizer.isHeadlinePlaceholder(
                "运输中", StatusSemantic.TRANSIT));
        assertTrue(ExpressStatusNormalizer.isHeadlinePlaceholder(
                "待取件", StatusSemantic.TRANSIT));
        assertTrue(ExpressStatusNormalizer.isHeadlinePlaceholder(
                "暂无物流动态", StatusSemantic.UNKNOWN));
        assertFalse(ExpressStatusNormalizer.isHeadlinePlaceholder(
                "快件到达杭州转运中心", StatusSemantic.TRANSIT));
    }

    @Test
    public void recoversAccountOrderStateFromItsCachedTimeline() {
        assertEquals(StatusSemantic.DELIVERY,
                ExpressStatusNormalizer.inferAccountOrderStatus("",
                        "[{\"time\":\"2026-08-16 10:00:00\","
                                + "\"context\":\"您的京东订单正在配送中\"},"
                                + "{\"time\":\"2026-08-16 09:00:00\","
                                + "\"context\":\"商品已出库\"}]"));
        assertEquals(StatusSemantic.ORDERED,
                ExpressStatusNormalizer.inferAccountOrderStatus(
                        "订单已完成，感谢您使用京东物流", "[]"));
    }
}
