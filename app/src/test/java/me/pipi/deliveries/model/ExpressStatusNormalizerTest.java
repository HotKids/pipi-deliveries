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
        assertTrue(ExpressStatusNormalizer.isProviderErrorDetail("查无结果，请检查运单号"));
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
    }

    /**
     * 用户 2026-09-08 报：订单走完了（唯一节点写「您的订单<单号>已完成」），三端却只有 iOS 显示
     * 「已完成」。订单级终点与承运商签收同样是 COMPLETED，单号夹在中间也要认出来。
     */
    @Test
    public void accountOrderCompletionIsTerminalEvenWithTheOrderNumberInline() {
        assertEquals(StatusSemantic.COMPLETED,
                ExpressStatusNormalizer.inferAccountOrderStatus(
                        "订单已完成，感谢您使用京东物流", "[]"));
        assertEquals(StatusSemantic.COMPLETED,
                ExpressStatusNormalizer.inferAccountOrderStatus(
                        "您的订单3610448002878202已完成，感谢您对京东的支持，欢迎再次光临。"
                                + "期待您对本次购物进行评价。", "[]"));
        assertEquals(StatusSemantic.COMPLETED,
                ExpressStatusNormalizer.inferAccountOrderStatus("配送完成", "[]"));
        assertEquals(StatusSemantic.COMPLETED,
                ExpressStatusNormalizer.inferAccountOrderStatus("已完成", "[]"));
        // 下单阶段的词照旧停在「已下单」。
        assertEquals(StatusSemantic.ORDERED,
                ExpressStatusNormalizer.inferAccountOrderStatus(
                        "您的订单已下单成功，我们将尽快为您备货", "[]"));
        assertEquals(StatusSemantic.ORDERED,
                ExpressStatusNormalizer.inferAccountOrderStatus("拣货完成，待出库", "[]"));
    }
}
