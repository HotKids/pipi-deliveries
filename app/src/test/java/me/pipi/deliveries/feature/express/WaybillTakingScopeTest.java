package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

/**
 * AGENTS §9「谁需要自己取运单号」（用户 2026-09-26）：只有接口 5 的京东件自己取运单号。Home and the background
 * round treat an order whose text names a waybill as a projection candidate only for a JD source.
 */
public final class WaybillTakingScopeTest {
    private static final String NAMED = "[{\"time\":\"2026-09-24 08:00:00\","
            + "\"context\":\"待出库交付申通快递，运单号为770018906334362\"}]";

    @Test public void onlyAJdOrderIsACandidateForItsOrderText() {
        assertTrue(ExpressHomeOrderProjectionCapture.needsProjection(order("JingDong"), true));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(order("CaiNiao"), true));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(order("CaiNiao")));
    }

    /** An order without a route credential, so only its text could make it a candidate. */
    private static ExpressItem order(String provider) {
        return new ExpressItem(
                7L, "", "3630448013824601", "JD", "京东购物",
                StatusSemantic.PICKED, "已揽件", "订单进行中",
                "2026-09-24 08:00:00", NAMED, "", "I5-JD", "",
                1L, 2L, "I5-JD", "", "v5", "", false,
                "", "", "[]", provider);
    }
}
