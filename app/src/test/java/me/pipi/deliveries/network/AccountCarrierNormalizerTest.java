package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

import org.json.JSONObject;
import org.junit.Test;

public final class AccountCarrierNormalizerTest {
    @Test
    public void nestedWorkerContractProjectsAllFieldsWithoutChangingRawIdentity()
            throws Exception {
        JSONObject record = new JSONObject().put("carrierNormalization", new JSONObject()
                .put("standardCode", "SF")
                .put("displayName", "顺丰速运")
                .put("kuaidi100Code", "shunfeng")
                .put("isBuiltIn", true)
                .put("tableVersion", "sha256:abc"));
        ExpressQueryResult raw = result("KYE", "raw carrier");

        ExpressQueryResult normalized = AccountCarrierNormalizer.apply(record, raw);

        assertEquals("KYE", normalized.courierCode);
        assertEquals("raw carrier", normalized.companyName);
        assertEquals("SF", normalized.carrierNormalization.standardCode);
        assertEquals("顺丰速运", normalized.carrierNormalization.displayName);
        assertEquals("shunfeng", normalized.carrierNormalization.kuaidi100Code);
        assertEquals(Boolean.TRUE, normalized.carrierNormalization.builtIn);
        assertEquals("sha256:abc", normalized.carrierNormalization.tableVersion);
    }

    @Test
    public void legacyTopLevelContractRemainsReadable() throws Exception {
        JSONObject record = new JSONObject()
                .put("normalizedCarrierCode", "JTSD")
                .put("normalizedCarrierName", "极兔速递")
                .put("carrierBuiltIn", "1");

        ExpressQueryResult normalized = AccountCarrierNormalizer.apply(
                record, result("JITU", "JITU"));

        assertTrue(normalized.carrierNormalization.recognized());
        assertEquals("JTSD", normalized.carrierNormalization.standardCode);
        assertEquals("极兔速递", normalized.carrierNormalization.displayName);
    }

    @Test
    public void currentTopLevelContractWinsWhenFutureNestedShapeAlsoExists()
            throws Exception {
        JSONObject record = new JSONObject()
                .put("normalizedCarrierCode", "SF")
                .put("normalizedCarrierName", "顺丰速运")
                .put("carrierBuiltIn", true)
                .put("carrierNormalization", new JSONObject()
                        .put("standardCode", "JD")
                        .put("displayName", "京东快递")
                        .put("isBuiltIn", true));

        ExpressQueryResult normalized = AccountCarrierNormalizer.apply(
                record, result("RAW", "RAW"));

        assertEquals("SF", normalized.carrierNormalization.standardCode);
    }

    @Test
    public void missingMetadataDoesNotUseTheLocalRegistryAsSyncAuthority()
            throws Exception {
        ExpressQueryResult raw = result("KYE", "跨越速运");

        ExpressQueryResult untouched = AccountCarrierNormalizer.apply(
                new JSONObject().put("cpCode", "KYE").put("cpName", "跨越速运"), raw);

        assertSame(raw, untouched);
        assertFalse(untouched.carrierNormalization.present());
    }

    @Test
    public void workerBuiltInClaimMustMatchTheSeventeenEntryContract() throws Exception {
        JSONObject record = new JSONObject()
                .put("normalizedCarrierCode", "NOT_A_CARRIER")
                .put("normalizedCarrierName", "伪造承运商")
                .put("normalizedKuaidi100Code", "fake")
                .put("carrierBuiltIn", true);

        ExpressQueryResult untouched = AccountCarrierNormalizer.apply(
                record, result("RAW", "原始承运商"));

        assertFalse(untouched.carrierNormalization.present());
    }

    @Test
    public void workerBuiltInFieldsMustAgreeWithTheirCanonicalCode() throws Exception {
        JSONObject record = new JSONObject()
                .put("normalizedCarrierCode", "HTKY")
                .put("normalizedCarrierName", "极兔速递")
                .put("normalizedKuaidi100Code", "huitongkuaidi")
                .put("carrierBuiltIn", true);

        assertTrue(AccountCarrierNormalizer.apply(
                record, result("HTKY", "百世快递"))
                .carrierNormalization.present());
    }

    private static ExpressQueryResult result(String code, String company) {
        return new ExpressQueryResult(
                "TEST123456", code, company, StatusSemantic.TRANSIT, 123L,
                "2026-08-29 12:00:00", "快件运输中", "[]",
                "pipi-route:v5", "13800138000", "interface5", "v5",
                "https://example.com/opaque", "CaiNiao");
    }
}
