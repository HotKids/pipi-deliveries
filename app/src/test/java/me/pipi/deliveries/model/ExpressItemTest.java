package me.pipi.deliveries.model;

import static org.junit.Assert.assertEquals;

import me.pipi.deliveries.R;
import me.pipi.deliveries.data.CarrierRegistry;

import org.junit.Test;

public final class ExpressItemTest {
    @Test
    public void accountOrderIsPresentedAsShoppingOrder() {
        ExpressItem item = new ExpressItem(
                1L, "13800138000", "JDORDER00000001", "JD", "京东快递",
                StatusSemantic.ORDERED, "已下单", "订单已出库", "2026-08-16 10:00:00",
                "[]", "", "I5-JD", "", 1L, 2L, "I5-JD", "");

        assertEquals("京东购物", item.displayCompany());
        assertEquals(R.drawable.jdshopping, item.displayIconResource());
    }

    @Test
    public void bestSourceIdentityUsesJtOnlyOnVisibleSurfaces() {
        ExpressItem item = new ExpressItem(
                2L, "", "JT0000000000001", "HTKY", "百世快递",
                StatusSemantic.TRANSIT, "运输中", "已到达转运中心", "2026-08-18 10:00:00",
                "[]", "", "V4", "");

        assertEquals("百世快递", item.companyName);
        assertEquals("HTKY", item.courierCode);
        assertEquals("极兔速递", item.displayCompany());
    }

    @Test
    public void lateOrderProjectionChangesDisplayWithoutReplacingSourceIdentity() {
        ExpressItem item = new ExpressItem(
                3L, "", "1234567890123456", "JD", "京东购物",
                StatusSemantic.TRANSIT, "运输中", "", "", "[]", "",
                "I5-JD", "", 1L, 2L, "I5-JD", "", "v5", "route", true,
                "SF1234567890123", "顺丰速运", "[]");

        assertEquals("1234567890123456", item.waybill);
        assertEquals("SF1234567890123", item.displayWaybill());
        assertEquals("顺丰速运", item.displayCompany());
        assertEquals("shunfeng", item.displayCourierCode());
        assertEquals(CarrierRegistry.icon("SF", "顺丰速运"),
                item.displayIconResource());
    }
}
