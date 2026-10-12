package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public final class CarrierRegistryAuthorityTest {
    @Before
    public void setUp() {
        CarrierRegistry.resetForTesting();
    }

    @After
    public void tearDown() {
        CarrierRegistry.resetForTesting();
    }

    @Test
    public void validatedTableReplacesEveryIndexInOnePublication() throws Exception {
        JSONObject payload = CarrierAuthorityFixture.payload();
        JSONObject yto = CarrierAuthorityFixture.entry(payload, "YTO");
        yto.put("displayName", "圆通测试名");
        yto.getJSONArray("codeAliases").put("YTO_REMOTE");
        yto.getJSONArray("nameAliases").put("圆通测试别名");

        CarrierRegistry.PreparedAuthority prepared = CarrierRegistry.prepareAuthority(payload);
        assertEquals("圆通速递", CarrierRegistry.companyName("YTO", ""));
        assertNull(CarrierRegistry.resolve("YTO_REMOTE"));

        CarrierRegistry.installAuthority(prepared);

        assertEquals("圆通测试名", CarrierRegistry.companyName("YTO", ""));
        assertNull(CarrierRegistry.resolve("YTO_REMOTE"));
        assertEquals("YTO", CarrierRegistry.resolveCpCode("YTO_REMOTE").standardCode);
        assertEquals("YTO", CarrierRegistry.resolveName("圆通测试别名").standardCode);
        assertEquals("yuantong", CarrierRegistry.queryCode("YTO_REMOTE", ""));
        assertEquals(me.pipi.deliveries.R.drawable.yto,
                CarrierRegistry.icon("YTO_REMOTE", ""));
        assertTrue(CarrierRegistry.resolve("JD").requiresPhoneTail);
    }

    @Test
    public void kuaidi100AliasesStayInTheirOwnReverseLookupNamespace() throws Exception {
        JSONObject payload = CarrierAuthorityFixture.payload();
        CarrierAuthorityFixture.entry(payload, "DBL")
                .getJSONArray("kuaidi100CodeAliases").put("dbl-k100-only");

        CarrierRegistry.installAuthority(CarrierRegistry.prepareAuthority(payload));

        assertNull(CarrierRegistry.resolve("dbl-k100-only"));
        assertNull(CarrierRegistry.resolveCpCode("dbl-k100-only"));
        assertEquals("DBL", CarrierRegistry.resolveKuaidi100Code(
                "dbl-k100-only").standardCode);
        assertNull(CarrierRegistry.resolveKuaidi100Code("KYE"));
        assertNull(CarrierRegistry.resolveKuaidi100Code("ZMKM"));
        assertEquals("debangkuaidi", CarrierRegistry.queryCode("DBL", ""));
        assertEquals("DBL", CarrierRegistry.resolveCpCode("debangwuliu").standardCode);
    }

    /**
     * An alias naming another carrier's Kuaidi100 code can never displace it. Since audit C5 (user
     * 2026-09-25, shared fixture case 「a reverse alias that is another carrier's code」) such a table
     * is a namespace conflict and is refused whole, as the Worker refuses it; it used to be accepted
     * with the alias ignored. The active table keeps SF on its own code.
     */
    @Test
    public void kuaidi100AliasCannotDisplaceAnotherCarriersCanonicalCode() throws Exception {
        JSONObject payload = CarrierAuthorityFixture.payload();
        CarrierAuthorityFixture.entry(payload, "YTO")
                .getJSONArray("kuaidi100CodeAliases").put("shunfeng");

        assertThrows(IllegalArgumentException.class,
                () -> CarrierRegistry.prepareAuthority(payload));

        assertEquals("SF", CarrierRegistry.resolveKuaidi100Code("shunfeng").standardCode);
        assertEquals("YTO", CarrierRegistry.resolveKuaidi100Code("yuantong").standardCode);
    }

    @Test
    public void malformedOrConflictingTableCannotChangeTheActiveSnapshot() throws Exception {
        JSONObject valid = CarrierAuthorityFixture.payload();
        CarrierAuthorityFixture.entry(valid, "YTO").put("displayName", "已安装名称");
        CarrierRegistry.installAuthority(CarrierRegistry.prepareAuthority(valid));

        JSONObject collision = CarrierAuthorityFixture.payload();
        CarrierAuthorityFixture.entry(collision, "YTO")
                .getJSONArray("codeAliases").put("SF");
        assertThrows(IllegalArgumentException.class,
                () -> CarrierRegistry.prepareAuthority(collision));

        JSONObject wrongArrayType = CarrierAuthorityFixture.payload();
        CarrierAuthorityFixture.entry(wrongArrayType, "YTO").put("nameAliases", "圆通");
        assertThrows(IllegalArgumentException.class,
                () -> CarrierRegistry.prepareAuthority(wrongArrayType));

        JSONObject wrongPhoneContract = CarrierAuthorityFixture.payload();
        CarrierAuthorityFixture.entry(wrongPhoneContract, "JD")
                .put("requiresPhoneTail", "true");
        assertThrows(IllegalArgumentException.class,
                () -> CarrierRegistry.prepareAuthority(wrongPhoneContract));

        assertEquals("已安装名称", CarrierRegistry.companyName("YTO", ""));
    }
}
