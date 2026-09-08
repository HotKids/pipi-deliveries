package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class CarrierRegistryTest {
    @Test
    public void postbAndParcelAliasUsePostalParcelPresentation() {
        assertEquals("邮政快递", CarrierRegistry.companyName("POSTB", "包裹信件"));
        assertEquals("邮政快递", CarrierRegistry.companyName("", "邮政包裹"));
        assertEquals("youzhengguonei", CarrierRegistry.queryCode("POSTB", "包裹信件"));
    }

    @Test
    public void finalRegistryHasExactlySeventeenEntriesAndFieldAliases() {
        assertEquals(
                "6e4ec3e45a460dbea446093a9b7ccb81b2da80f716f57369bc32572d640dda0e",
                CarrierRegistry.AUTHORITY_VERSION);
        assertEquals("embedded-transition", CarrierRegistry.AUTHORITY_SOURCE);
        assertEquals(17, CarrierRegistry.sizeForTesting());
        assertNull(CarrierRegistry.resolve("EMSGJ"));
        assertNull(CarrierRegistry.resolve("KYE"));
        assertNull(CarrierRegistry.resolve("JITU"));
        assertNull(CarrierRegistry.resolve("JDLEX"));
        assertNull(CarrierRegistry.resolve("EYB"));
        assertNull(CarrierRegistry.resolve("ZMKM"));
        assertEquals("KYSY", CarrierRegistry.resolveCpCode("KYE").standardCode);
        assertEquals("JTSD", CarrierRegistry.resolveCpCode("JITU").standardCode);
        assertEquals("JD", CarrierRegistry.resolveCpCode("JDLEX").standardCode);
        assertEquals("JDKY", CarrierRegistry.resolve("JDKY").standardCode);
        assertEquals("JD", CarrierRegistry.resolveCpCode("JDKY").standardCode);
        assertEquals("JD", CarrierRegistry.resolveCpCode("JDVD").standardCode);
        assertEquals("JD", CarrierRegistry.resolveCpCode("jd_future").standardCode);
        assertEquals("EMS", CarrierRegistry.resolveCpCode("EYB").standardCode);
        assertEquals("ems", CarrierRegistry.queryCode("EYB", ""));
        assertEquals("debangkuaidi", CarrierRegistry.queryCode("debangwuliu", ""));
        assertEquals("", CarrierRegistry.hotline("HTKY", "百世快递"));
        assertEquals("邮政快递", CarrierRegistry.resolveCpCode("POSTB").companyName);
        assertEquals("丹鸟速递", CarrierRegistry.resolveCpCode("ZMKMKD").companyName);
        assertEquals("丹鸟速递", CarrierRegistry.resolveCpCode("ZMKM").companyName);
        assertTrue(CarrierRegistry.resolve("ZTO").requiresPhoneTail);
        assertTrue(CarrierRegistry.resolve("JD").requiresPhoneTail);
        assertTrue(CarrierRegistry.resolve("KYSY").requiresPhoneTail);
    }

    @Test
    public void danniaoAliasesUsePipiPresentationAndKuaidi100Code() {
        assertEquals("丹鸟速递", CarrierRegistry.companyName("ZMKMKD", "丹鸟快递"));
        assertEquals("丹鸟速递", CarrierRegistry.companyName("", "菜鸟直送（丹鸟）"));
        assertEquals("danniao", CarrierRegistry.queryCode("ZMKMKD", ""));
        assertEquals("danniao", CarrierRegistry.queryCode("ZMKM", ""));
        assertEquals(me.pipi.deliveries.R.drawable.danniao,
                CarrierRegistry.icon("ZMKMKD", "丹鸟快递"));
    }

    @Test
    public void huitongUsesTheFinalJituPresentationWithoutChangingItsProtocolCode() {
        assertEquals("极兔速递", CarrierRegistry.companyName("HTKY", "百世快递"));
        assertEquals("极兔速递", CarrierRegistry.displayName("HTKY", "百世快递"));
        assertEquals("极兔速递", CarrierRegistry.displayName("BESTQJT", "汇通"));
        assertEquals("huitongkuaidi", CarrierRegistry.queryCode("BEST", ""));
        assertEquals(me.pipi.deliveries.R.drawable.jtsd,
                CarrierRegistry.icon("HTKY", "百世快递"));
    }

    @Test
    public void onlyTheApprovedJdCpCodePrefixActsAsAWildcard() {
        assertNull(CarrierRegistry.resolve("VIVO_SF"));
        assertNull(CarrierRegistry.resolve("SF1234567890"));
        assertNull(CarrierRegistry.resolve("JD1234567890"));
        assertEquals("JD", CarrierRegistry.resolveCpCode("JD1234567890").standardCode);
        assertNull(CarrierRegistry.resolveCpCode("XJD"));
        assertNull(CarrierRegistry.resolveCpCode("J.DVD"));
        assertNull(CarrierRegistry.resolveCpCode("J DVD"));
        assertNull(CarrierRegistry.resolveCpCode("J.D.L.E.X"));
        assertNull(CarrierRegistry.resolveCpCode("J D L E X"));
        assertEquals("JTSD", CarrierRegistry.resolveCpCode("J&T").standardCode);
        assertNull(CarrierRegistry.resolve("S-F"));
        assertNull(CarrierRegistry.resolve("J.D.L.E.X"));
        assertNull(CarrierRegistry.resolve("J&T"));
        assertEquals("JTSD", CarrierRegistry.resolveCpCode("J&T").standardCode);
    }

    @Test
    public void duplicateDisplayNameUsesTheFirstTableEntry() {
        assertEquals("JTSD", CarrierRegistry.resolveName("极兔速递").standardCode);
        assertEquals("JTSD", CarrierRegistry.resolveName("极兔").standardCode);
        assertEquals("HTKY", CarrierRegistry.resolveName("百世快递").standardCode);
        assertNull(CarrierRegistry.resolve("极兔速递"));
        assertNull(CarrierRegistry.resolveCpCode("极兔速递"));
        assertNull(CarrierRegistry.resolveKuaidi100Code("极兔速递"));
    }
}
