package me.pipi.deliveries.background;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ExpressSyncEngineTest {
    @Test
    public void placeholderOnlyInterface5ResultAllowsFallback() {
        ExpressQueryResult result = new ExpressQueryResult(
                "YT001", "YTO", "圆通速递", StatusSemantic.UNKNOWN,
                "", "暂无物流信息", "[]");

        assertFalse(ExpressSyncEngine.hasUsableInformation(result));
    }

    @Test
    public void structuredOrMeaningfulInterface5ResultWins() {
        ExpressQueryResult structured = new ExpressQueryResult(
                "YT001", "YTO", "圆通速递", StatusSemantic.TRANSIT,
                "", "", "[]");
        ExpressQueryResult detail = new ExpressQueryResult(
                "YT001", "YTO", "圆通速递", StatusSemantic.UNKNOWN,
                "", "快件已到达杭州转运中心", "[]");

        assertTrue(ExpressSyncEngine.hasUsableInformation(structured));
        assertTrue(ExpressSyncEngine.hasUsableInformation(detail));
    }

    @Test
    public void structuredProviderErrorsNeverBecomeTimelineText() {
        ExpressQueryResult noResult = new ExpressQueryResult(
                "YT001", "YTO", "圆通速递", StatusSemantic.TRANSIT,
                "", "no result", "[]");
        ExpressQueryResult verification = new ExpressQueryResult(
                "SF001", "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "", "验证码错误", "[]");

        assertFalse(ExpressSyncEngine.hasUsableInformation(noResult));
        assertFalse(ExpressSyncEngine.hasUsableInformation(verification));
    }

    @Test
    public void removedPhoneCannotMatchFutureMaskedServerRows() {
        assertEquals("13800138000", ExpressSyncEngine.matchedBoundPhone(
                "****8000", Arrays.asList("13900001111", "13800138000")));
        assertEquals("", ExpressSyncEngine.matchedBoundPhone(
                "****8098", Arrays.asList("13900001111", "13800138000")));
        assertEquals("", ExpressSyncEngine.matchedBoundPhone(
                "****8000", Arrays.asList("13900008000", "13800138000")));
    }

    @Test
    public void sharedManualRefreshUsesExactSfOrJdSourceAcrossAccountInterfaces() {
        assertTrue(ExpressSyncEngine.usesSharedManualTimeline(
                sourceItem("INTERFACE5", "ShunFeng", "ZTO", "中通快递")));
        assertFalse(ExpressSyncEngine.usesSharedManualTimeline(
                sourceItem("INTERFACE5", "CaiNiao", "SF", "顺丰速运")));
        assertFalse(ExpressSyncEngine.usesSharedManualTimeline(
                sourceItem("INTERFACE5", "", "SF", "顺丰速运")));
        assertTrue(ExpressSyncEngine.usesSharedManualTimeline(
                sourceItem("INTERFACE6", "ShunFeng", "SF", "顺丰速运")));
        assertTrue(ExpressSyncEngine.usesSharedManualTimeline(
                sourceItem("INTERFACE6", "JingDong", "JD", "京东快递")));
    }

    @Test
    public void backgroundDoesNotFetchProjectedOrderTimeline() throws Exception {
        Path path = Path.of(
                "app/src/main/java/me/pipi/deliveries/background/ExpressSyncEngine.java");
        if (!Files.isRegularFile(path)) {
            path = Path.of(
                    "src/main/java/me/pipi/deliveries/background/ExpressSyncEngine.java");
        }
        String source = Files.readString(path, StandardCharsets.UTF_8);

        assertFalse(source.contains("shouldRefreshProjectedOrder("));
        assertFalse(source.contains("saveProjectedOrderTimeline("));
    }

    @Test
    public void onlyAnUnresolvedProjectedCarrierUsesSharedWorkerRecognition() {
        ExpressItem missingCarrier = projectedOrder("");
        ExpressItem genericCarrier = projectedOrder("快递");
        ExpressItem resolvedCarrier = projectedOrder("顺丰速运");
        ExpressItem unprojected = accountOrder("");

        assertTrue(ExpressSyncEngine.needsProjectedCarrierRecognition(missingCarrier));
        assertTrue(ExpressSyncEngine.needsProjectedCarrierRecognition(genericCarrier));
        assertFalse(ExpressSyncEngine.needsProjectedCarrierRecognition(resolvedCarrier));
        assertFalse(ExpressSyncEngine.needsProjectedCarrierRecognition(unprojected));
        assertEquals("顺丰速运", ExpressSyncEngine.recognizedProjectedCarrier("shunfeng"));
        assertEquals("", ExpressSyncEngine.recognizedProjectedCarrier("unknown-provider"));
    }

    private static ExpressItem sourceItem(
            String owner, String provider, String courierCode, String companyName) {
        return new ExpressItem(
                1L, "", "TEST123456", courierCode, companyName,
                StatusSemantic.TRANSIT, "运输中", "快件运输中",
                "2026-08-24 10:00:00", "[]", "", owner, "",
                1L, 2L, owner, "", "", "", true,
                "", "", "", provider);
    }

    private static ExpressItem projectedOrder(String projectedCompany) {
        return new ExpressItem(
                2L, "", "JDORDER123456", "JD", "京东购物",
                StatusSemantic.TRANSIT, "运输中", "订单运输中",
                "2026-08-24 10:00:00", "[]", "", "I5-JD", "",
                1L, 2L, "I5-JD", "I5-JD", "v5",
                "https://example.jd.com/detail", true,
                "SFPROJECTED123", projectedCompany, "[]", "JingDong");
    }

    private static ExpressItem accountOrder(String projectedWaybill) {
        return new ExpressItem(
                3L, "", "JDORDER654321", "JD", "京东购物",
                StatusSemantic.TRANSIT, "运输中", "订单运输中",
                "2026-08-24 10:00:00", "[]", "", "I5-JD", "",
                1L, 2L, "I5-JD", "I5-JD", "v5",
                "https://example.jd.com/detail", true,
                projectedWaybill, "", "[]", "JingDong");
    }

}
