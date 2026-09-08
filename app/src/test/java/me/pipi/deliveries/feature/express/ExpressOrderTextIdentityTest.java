package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** Xiaomi JD order text naming a carrier waybill is read directly instead of opening the H5. */
public final class ExpressOrderTextIdentityTest {
    private static final String TRACKS = "["
            + "{\"time\":\"2026-09-03 17:49:00\",\"context\":\"【DK江门维达网点】的谭秀文（18128210371）已取件\"},"
            + "{\"time\":\"2026-09-03 17:22:00\",\"context\":\"您的订单由第三方卖家拣货完成，待出库交付极兔速递，运单号为JT4006839564547\"},"
            + "{\"time\":\"2026-09-03 14:49:00\",\"context\":\"最快9月3日发货，9月4日(周五)送达\"}]";

    /** 用户定 2026-09-08：文案里只允许读运单号，承运商只认内置表与快递100 识别。 */
    @Test
    public void onlyTheWaybillIsReadFromTheShippedMessage() {
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

    /** 文案里写着承运商也不读它：这一行投影出运单号后由承运商识别决定展示名。 */
    @Test
    public void carrierNameInTheTextIsNeverRead() {
        ExpressOrderTextIdentity.Identity identity =
                ExpressOrderTextIdentity.fromDetail("待出库交付某某物流，运单号为 AB12345678", "1");
        assertEquals("AB12345678", identity.waybill);
        for (java.lang.reflect.Field field
                : ExpressOrderTextIdentity.Identity.class.getFields()) {
            org.junit.Assert.assertNotEquals("companyName", field.getName());
        }
    }
}
