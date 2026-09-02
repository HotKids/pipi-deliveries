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
    public void displayOnlyOrEnglishNamesDoNotManufactureRawCarrierEvidence() {
        assertFalse(AutomaticOwnershipPolicy.isQualified(
                ExpressSourcePolicy.SOURCE_INTERFACE5,
                packet("", "顺丰速运", StatusSemantic.TRANSIT, "interface5")));
        assertFalse(AutomaticOwnershipPolicy.isQualified(
                ExpressSourcePolicy.SOURCE_INTERFACE5,
                packet("", "SF Express", StatusSemantic.TRANSIT, "interface5")
                        .withRawCarrierNameEvidence("SF Express")));
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
