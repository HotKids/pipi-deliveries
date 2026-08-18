package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public final class CarrierRegistryTest {
    @Test
    public void postbAndParcelAliasUsePostalParcelPresentation() {
        assertEquals("邮政包裹", CarrierRegistry.companyName("POSTB", "包裹信件"));
        assertEquals("邮政包裹", CarrierRegistry.companyName("", "包裹信件"));
        assertEquals("youzhengguonei", CarrierRegistry.queryCode("POSTB", "包裹信件"));
    }

    @Test
    public void danniaoAliasesUsePipiPresentationAndKuaidi100Code() {
        assertEquals("丹鸟速递", CarrierRegistry.companyName("ZMKMKD", "丹鸟快递"));
        assertEquals("丹鸟速递", CarrierRegistry.companyName("", "菜鸟直送（丹鸟）"));
        assertEquals("danniao", CarrierRegistry.queryCode("ZMKMKD", ""));
        assertEquals(me.pipi.deliveries.R.drawable.danniao,
                CarrierRegistry.icon("ZMKMKD", "丹鸟快递"));
    }

    @Test
    public void huitongKeepsProtocolIdentityButUsesJtPresentation() {
        assertEquals("百世快递", CarrierRegistry.companyName("HTKY", "百世快递"));
        assertEquals("极兔速递", CarrierRegistry.displayName("HTKY", "百世快递"));
        assertEquals("极兔速递", CarrierRegistry.displayName("BESTQJT", "汇通"));
        assertEquals("huitongkuaidi", CarrierRegistry.queryCode("BEST", ""));
        assertEquals(me.pipi.deliveries.R.drawable.jtsd,
                CarrierRegistry.icon("HTKY", "百世快递"));
    }

    @Test
    public void onlyUnambiguousAlphabeticWaybillsAreGuessedLocally() {
        assertEquals("SF", CarrierRegistry.guessByWaybill("SF1234567890").standardCode);
        assertEquals("YTO", CarrierRegistry.guessByWaybill("yt1234567890").standardCode);
        assertEquals("JTSD", CarrierRegistry.guessByWaybill("JT1234567890").standardCode);
        assertEquals("JD", CarrierRegistry.guessByWaybill("JD1234567890").standardCode);
        assertNull(CarrierRegistry.guessByWaybill("7731234567890"));
    }
}
