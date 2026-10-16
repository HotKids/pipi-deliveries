package me.pipi.deliveries.data;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class AutomaticOwnershipPolicyTest {
    @Test
    public void rawCarrierCodeSatisfiesTheFirstOwnershipGate() {
        assertTrue(AutomaticOwnershipPolicy.isQualified(
                ExpressSourcePolicy.SOURCE_INTERFACE5,
                packet("ZTO", "", StatusSemantic.TRANSIT, "interface5")));
    }

    @Test
    public void providerRawChineseNameSatisfiesTheFirstOwnershipGate() {
        ExpressQueryResult result = packet(
                "", "顺丰速运", StatusSemantic.TRANSIT, "interface5")
                .withRawCarrierNameEvidence("顺丰速运");

        assertTrue(AutomaticOwnershipPolicy.isQualified(
                ExpressSourcePolicy.SOURCE_INTERFACE5, result));
    }

    @Test
    public void displayOnlyNamesDoNotManufactureRawCarrierEvidence() {
        assertFalse(AutomaticOwnershipPolicy.isQualified(
                ExpressSourcePolicy.SOURCE_INTERFACE5,
                packet("", "顺丰速运", StatusSemantic.TRANSIT, "interface5")));
    }

    @Test
    public void currentProviderRawEnglishNameSatisfiesTheFirstOwnershipGate() {
        assertTrue(AutomaticOwnershipPolicy.isQualified(
                ExpressSourcePolicy.SOURCE_INTERFACE5,
                packet("", "SF Express", StatusSemantic.TRANSIT, "interface5")
                        .withRawCarrierNameEvidence("SF Express")));
    }

    @Test
    public void exactRawPlaceholderCodesAndNamesCannotEstablishOwnership() {
        for (String placeholder : new String[]{null, "", "  ", "null", "UNKNOWN", " unknown ",
                "OTHER", " other ", "未知", "其他"}) {
            for (String owner : new String[]{"INTERFACE5", "INTERFACE6"}) {
                String provider = owner.toLowerCase(java.util.Locale.ROOT);
                assertFalse(String.valueOf(placeholder), AutomaticOwnershipPolicy.isQualified(owner,
                        packet(placeholder, "", StatusSemantic.TRANSIT, provider)));
                assertFalse(String.valueOf(placeholder), AutomaticOwnershipPolicy.isQualified(owner,
                        packet("", placeholder, StatusSemantic.TRANSIT, provider)
                                .withRawCarrierNameEvidence(placeholder)));
            }
        }
        assertTrue(AutomaticOwnershipPolicy.isQualified("INTERFACE5",
                packet("OTHER", "SF Express", StatusSemantic.TRANSIT, "interface5")
                        .withRawCarrierNameEvidence("SF Express")));
        assertTrue(AutomaticOwnershipPolicy.isQualified("INTERFACE5",
                packet("ZTO", "未知", StatusSemantic.TRANSIT, "interface5")
                        .withRawCarrierNameEvidence("未知")));
        assertTrue(AutomaticOwnershipPolicy.isQualified("INTERFACE5",
                packet("", "Other Express", StatusSemantic.TRANSIT, "interface5")
                        .withRawCarrierNameEvidence("Other Express")));
    }

    @Test
    public void knownStateAndMatchingLocalTimelineOwnerRemainRequired() {
        assertFalse(AutomaticOwnershipPolicy.isQualified(
                ExpressSourcePolicy.SOURCE_INTERFACE5,
                packet("ZTO", "中通快递", StatusSemantic.UNKNOWN, "interface5")));
        assertFalse(AutomaticOwnershipPolicy.isQualified(
                ExpressSourcePolicy.SOURCE_INTERFACE5,
                packet("ZTO", "中通快递", StatusSemantic.TRANSIT, "interface6")));
    }

    private static ExpressQueryResult packet(
            String code, String name, StatusSemantic semantic, String timelineProvider) {
        return new ExpressQueryResult(
                "TEST123", code, name, semantic,
                "2026-08-30 12:00:00", "运输中", "[]",
                "", "13800000000", timelineProvider, "", "", "CaiNiao");
    }
}
