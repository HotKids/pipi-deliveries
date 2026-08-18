package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.ExpressItem;

import org.junit.Test;

public final class ExpressSourcePolicyTest {
    @Test
    public void waybillIdentityIsNormalizedBeforeMerge() {
        assertEquals("YT123ABC", ExpressSourcePolicy.normalizeWaybill(" yt-123 abc "));
    }

    @Test
    public void selectedAccountInterfacesHaveEqualStateAuthority() {
        assertEquals(ExpressSourcePolicy.SOURCE_INTERFACE6,
                ExpressSourcePolicy.source("interface6"));
        assertEquals(ExpressSourcePolicy.SOURCE_INTERFACE5,
                ExpressSourcePolicy.source("interface5"));
        assertEquals(ExpressSourcePolicy.stateRank("INTERFACE5"),
                ExpressSourcePolicy.stateRank("INTERFACE6"));
        assertTrue(ExpressSourcePolicy.stateRank("INTERFACE5")
                > ExpressSourcePolicy.stateRank("KD-100"));
        assertEquals(ExpressSourcePolicy.stateRank("INTERFACE5"),
                ExpressSourcePolicy.stateRank("I5-JD"));
        assertFalse(ExpressSourcePolicy.shouldApplyState(
                "INTERFACE5", StatusSemantic.TRANSIT, 100L,
                "DISCOVERY", StatusSemantic.WAITING_PICKUP, 200L));
    }

    @Test
    public void orderProjectionOwnersAreExplicitlyPartitioned() {
        assertTrue(ExpressSourcePolicy.isAccountOrderOwner("I5-JD"));
        assertTrue(ExpressSourcePolicy.isAccountOrderOwner("i6-jd"));
        assertFalse(ExpressSourcePolicy.isAccountOrderOwner("INTERFACE5"));
        assertFalse(ExpressSourcePolicy.isAccountOrderOwner("INTERFACE6"));
        assertEquals("interface5", ExpressSourcePolicy.bindingSourceForOwner("I5-JD"));
        assertEquals("interface6", ExpressSourcePolicy.bindingSourceForOwner("I6-JD"));
    }

    @Test
    public void completedShipmentCannotRegress() {
        assertFalse(ExpressSourcePolicy.shouldApplyState(
                "INTERFACE5", StatusSemantic.COMPLETED, 100L,
                "INTERFACE5", StatusSemantic.TRANSIT, 200L));
    }

    @Test
    public void missingProviderTimeCannotEraseKnownEventTimeOrHeadline() {
        assertFalse(ExpressSourcePolicy.shouldApplyState(
                "INTERFACE5", StatusSemantic.COMPLETED, 200L,
                "INTERFACE5", StatusSemantic.COMPLETED, 0L));
        assertFalse(ExpressSourcePolicy.shouldApplyHeadline(
                "INTERFACE5", 200L, "INTERFACE5", 0L));
    }

    @Test
    public void waitingAndDeliveryOnlySwitchOnNewerInterface5Event() {
        assertFalse(ExpressSourcePolicy.shouldApplyState(
                "INTERFACE5", StatusSemantic.WAITING_PICKUP, 200L,
                "INTERFACE5", StatusSemantic.DELIVERY, 100L));
        assertTrue(ExpressSourcePolicy.shouldApplyState(
                "INTERFACE5", StatusSemantic.WAITING_PICKUP, 200L,
                "INTERFACE5", StatusSemantic.DELIVERY, 300L));
    }

    @Test
    public void routeRequiresCredentialedCainiaoAndIsPreserved() {
        String credentialed = "https://page.cainiao.com/guoguo/logistic_detail.html"
                + "?mailNo=123&secretKey=-123456789&from=INTERFACE5";
        assertEquals("", ExpressSourcePolicy.selectDetailUrl(
                "", "https://page.cainiao.com/guoguo/logistic_detail.html?mailNo=123"));
        assertEquals(credentialed, ExpressSourcePolicy.selectDetailUrl("", credentialed));
        assertEquals(credentialed, ExpressSourcePolicy.selectDetailUrl(
                credentialed, "https://m.kuaidi100.com/app/query/?nu=123"));
        assertEquals("pipi-route:v5", ExpressSourcePolicy.selectDetailUrl(
                credentialed, "pipi-route:v5"));
        assertTrue(ExpressSourcePolicy.isCredentialedCainiao("pipi-route:v5"));
        assertFalse(ExpressSourcePolicy.isCredentialedCainiao(
                "https://cainiao.com.evil.example/detail?secretKey=123"));
    }

    @Test
    public void visibleListMatchesPipiStatusGroupOrder() {
        assertTrue(ExpressRepository.visibleStatusRank(StatusSemantic.WAITING_PICKUP)
                < ExpressRepository.visibleStatusRank(StatusSemantic.DELIVERY));
        assertTrue(ExpressRepository.visibleStatusRank(StatusSemantic.DELIVERY)
                < ExpressRepository.visibleStatusRank(StatusSemantic.TRANSIT));
        assertTrue(ExpressRepository.visibleStatusRank(StatusSemantic.TRANSIT)
                < ExpressRepository.visibleStatusRank(StatusSemantic.PICKED));
        assertTrue(ExpressRepository.visibleStatusRank(StatusSemantic.CANCELLED)
                < ExpressRepository.visibleStatusRank(StatusSemantic.COMPLETED));
    }

    @Test
    public void manualFallbackKeepsTheInterfaceThatStartedTheLookup() {
        ExpressItem backup = item("INTERFACE5");
        ExpressItem backupManual = item("I5-K100");
        ExpressItem main = item("INTERFACE6");
        ExpressItem manual = item("KD-100");

        assertEquals("I5-K100",
                ExpressSourcePolicy.kuaidi100FallbackSource("interface5"));
        assertEquals("KD-100",
                ExpressSourcePolicy.kuaidi100FallbackSource("interface6"));
        assertEquals(ExpressSourcePolicy.stateRank("I5-K100"),
                ExpressSourcePolicy.stateRank("KD-100"));
        assertEquals("interface5",
                ExpressSourcePolicy.bindingSourceForOwner("I5-K100"));
        assertEquals("interface6",
                ExpressSourcePolicy.bindingSourceForOwner("KD-100"));
        assertTrue(ExpressSourcePolicy.belongsToBindingSource(backup, "interface5"));
        assertTrue(ExpressSourcePolicy.belongsToBindingSource(backupManual, "interface5"));
        assertFalse(ExpressSourcePolicy.belongsToBindingSource(main, "interface5"));
        assertFalse(ExpressSourcePolicy.belongsToBindingSource(manual, "interface5"));
        assertTrue(ExpressSourcePolicy.belongsToBindingSource(main, "interface6"));
        assertTrue(ExpressSourcePolicy.belongsToBindingSource(manual, "interface6"));
        assertFalse(ExpressSourcePolicy.belongsToBindingSource(backup, "interface6"));
        assertFalse(ExpressSourcePolicy.belongsToBindingSource(
                backupManual, "interface6"));
        assertTrue(ExpressSourcePolicy.belongsToBindingSource("KD-100", "interface6"));
        assertTrue(ExpressSourcePolicy.belongsToBindingSource("V4", "interface6"));
        assertFalse(ExpressSourcePolicy.belongsToBindingSource("I5-K100", "interface6"));
    }

    private static ExpressItem item(String owner) {
        return new ExpressItem(
                1L, "", "TEST123456", "ZTO", "中通快递",
                StatusSemantic.TRANSIT, "运输中", "已到达转运中心", "", "[]", "",
                owner, "", 0L, 0L, owner, "");
    }
}
