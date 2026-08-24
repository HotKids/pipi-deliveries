package me.pipi.deliveries.model;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

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
        assertEquals(StatusSemantic.ORDERED, item.sourceSemantic);
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

    @Test
    public void interface5ShunFengSourceNormalizesOwnerAndProvider() {
        assertTrue(sourceItem("INTERFACE5", "ShunFeng", "ZTO", "中通快递")
                .isInterface5ShunFengSource());
        assertTrue(sourceItem("interface5", "shunfeng", "SF", "顺丰速运")
                .isInterface5ShunFengSource());
        assertFalse(sourceItem("INTERFACE6", "ShunFeng", "SF", "顺丰速运")
                .isInterface5ShunFengSource());
        assertFalse(sourceItem("INTERFACE5", "CaiNiao", "SF", "顺丰速运")
                .isInterface5ShunFengSource());
        assertFalse(sourceItem(
                "INTERFACE5", "ShunFeng", "SF", "顺丰速运", true)
                .isInterface5ShunFengSource());
    }

    @Test
    public void interface5AccountTimelineRequiresItsSupportedDetailCapability() {
        assertTrue(sourceItem(
                "INTERFACE5", "CaiNiao", "ZTO", "中通快递",
                false, "pipi-route:v5").usesInterface5AccountTimeline());
        assertTrue(sourceItem(
                "INTERFACE5", "CaiNiao", "ZTO", "中通快递",
                false, "https://detail.cainiao.com/parcel?secretKey=test")
                .usesInterface5AccountTimeline());
        assertFalse(sourceItem(
                "INTERFACE5", "CaiNiao", "ZTO", "中通快递",
                false, "").usesInterface5AccountTimeline());
        assertFalse(sourceItem(
                "INTERFACE5", "ShunFeng", "SF", "顺丰速运",
                false, "https://example.invalid/detail")
                .usesInterface5AccountTimeline());
        assertFalse(sourceItem(
                "INTERFACE6", "", "ZTO", "中通快递",
                false, "pipi-route:v5").usesInterface5AccountTimeline());
        assertTrue(sourceItem(
                "I5-JD", "JingDong", "JD", "京东购物",
                false, "").usesInterface5AccountTimeline());
    }

    private static ExpressItem sourceItem(
            String owner, String provider, String courierCode, String companyName) {
        return sourceItem(owner, provider, courierCode, companyName, false);
    }

    private static ExpressItem sourceItem(
            String owner, String provider, String courierCode, String companyName,
            boolean manuallyAdded) {
        return sourceItem(owner, provider, courierCode, companyName, manuallyAdded, "");
    }

    private static ExpressItem sourceItem(
            String owner, String provider, String courierCode, String companyName,
            boolean manuallyAdded, String detailUrl) {
        return new ExpressItem(
                4L, "", "WAYBILL", courierCode, companyName,
                StatusSemantic.TRANSIT, "运输中", "快件运输中", "2026-08-24 10:00:00",
                "[]", "", owner, detailUrl, 1L, 2L, owner, "", "", "", true,
                "", "", "", provider, manuallyAdded, "", 0L);
    }
}
