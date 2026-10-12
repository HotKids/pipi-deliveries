package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

/**
 * 其余裁决 35（用户 2026-09-27：「算了统一前面加 快递 两个字吧」）：承运商位置为空时，小组件（和通知、列表、详情页）统一写
 * 「快递」；有承运商名或原始码时照旧显示它们。
 */
public final class EmptyCarrierLabelTest {
    @Test public void anEmptyCarrierPositionReadsKuaidi() {
        ExpressItem blank = projectedOrder("");
        assertEquals("", blank.displayCompany());
        assertEquals("快递", blank.displayCarrierLabel());
        assertEquals("快递 4547 · 运输中", ExpressWidgetPresentation.rowTitle(blank));
        assertEquals("快递 4547", ExpressWidgetPresentation.rowIdentity(blank));
    }

    @Test public void aCarrierNameOrRawCodeIsShownAsBefore() {
        ExpressItem named = projectedOrder("YTO");
        assertEquals("圆通速递 4547 · 运输中", ExpressWidgetPresentation.rowTitle(named));
        ExpressItem rawCode = new ExpressItem(
                1L, "", "MM7700189071", "MMKD", "",
                StatusSemantic.TRANSIT, "运输中", "快件运输中",
                "2026-09-26 10:00:00", "[]", "", "INTERFACE5", "",
                1L, 2L, "INTERFACE5", "", "", "", true,
                "", "", "[]", "");
        assertEquals("MMKD 9071", ExpressWidgetPresentation.rowIdentity(rawCode));
        assertEquals("京东购物", ExpressItem.carrierLabel("京东购物"));
        assertEquals("快递", ExpressItem.carrierLabel(" "));
        assertEquals("快递", ExpressItem.carrierLabel(null));
    }

    private static ExpressItem projectedOrder(String projectedCompany) {
        return new ExpressItem(
                2L, "", "3630448013829999", "JDKD", "京东购物",
                StatusSemantic.TRANSIT, "运输中", "订单运输中",
                "2026-09-26 10:00:00", "[]", "", "I5-JD", "",
                1L, 2L, "I5-JD", "I5-JD", "v5",
                "https://example.jd.com/detail", true,
                "YT1234567894547", projectedCompany, "[]", "JingDong");
    }
}
