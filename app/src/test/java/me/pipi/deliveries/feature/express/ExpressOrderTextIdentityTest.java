package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** Xiaomi JD order text naming a carrier waybill is read directly instead of opening the H5. */
public final class ExpressOrderTextIdentityTest {
    private static final String TRACKS = "["
            + "{\"time\":\"2026-09-03 17:49:00\",\"context\":\"【DK测试网点】的测试员（19900000371）已取件\"},"
            + "{\"time\":\"2026-09-03 17:22:00\",\"context\":\"您的订单由第三方卖家拣货完成，待出库交付极兔速递，运单号为JT4006839564547\"},"
            + "{\"time\":\"2026-09-03 14:49:00\",\"context\":\"最快9月3日发货，9月4日(周五)送达\"}]";

    /**
     * 用户 2026-09-26（其余裁决 7，iOS 与 Lite 同）：文案只取运单号，「交付极兔速递」里的承运商不读，承运商走内置表
     * → K100 免费识别 → 付费兜底。此前这里断言承运商按本地表解析成 JTSD（取代 AGENTS §9 09-03 那条的承运商部分）。
     */
    @Test
    public void theNamedWaybillIsReadButNeverItsCarrier() throws Exception {
        ExpressOrderTextIdentity.Identity identity =
                ExpressOrderTextIdentity.fromTracksJson(TRACKS, "3610448002878202");
        assertEquals("JT4006839564547", identity.waybill);
    }

    @Test
    public void jdFulfilledOrdersWithoutANamedWaybillStayOnTheH5Projection() {
        assertNull(ExpressOrderTextIdentity.fromTracksJson(
                "[{\"context\":\"您的快件已由京东快递揽收\"},{\"context\":\"订单已出库\"}]",
                "3610448002878202"));
        assertNull(ExpressOrderTextIdentity.fromTracksJson("", "1"));
        assertNull(ExpressOrderTextIdentity.fromTracksJson("not json", "1"));
        assertNull(ExpressOrderTextIdentity.fromDetail("运单号为 12", "1"));
    }

    @Test
    public void anUnknownNamedCarrierStillYieldsTheWaybill() throws Exception {
        ExpressOrderTextIdentity.Identity identity =
                ExpressOrderTextIdentity.fromDetail("待出库交付某某物流，运单号为 AB12345678", "1");
        assertEquals("AB12345678", identity.waybill);
    }
}
