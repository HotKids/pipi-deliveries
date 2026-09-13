package me.pipi.deliveries.background;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.feature.express.ExpressOrderTextIdentity;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = android.app.Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressSyncEngineTest {
    @Test public void explicitHomePullKeepsTrustedCompletionFrozenButQueriesUndatedCompletion() {
        me.pipi.deliveries.data.ExpressRepository repository =
                me.pipi.deliveries.data.ExpressRepository.get(RuntimeEnvironment.getApplication());
        long now = System.currentTimeMillis();
        for (long signedAt : new long[]{now - 60_000L, 0L}) {
            String waybill = "HOMESIGNED" + signedAt;
            ExpressQueryResult result = new ExpressQueryResult(waybill, "SF", "SF",
                    StatusSemantic.COMPLETED, signedAt, "2026-09-01 10:00:00", "Carrier update",
                    "[{\"time\":\"2026-09-01 10:00:00\",\"context\":\"Carrier update\"}]",
                    "", "", "k100_h5", "", "", "").withManualStatusEvidence("Delivered", true);
            ExpressItem owner = repository.saveManualQueryBatch(null, null,
                    java.util.List.of(new me.pipi.deliveries.model.ManualQuerySuccess(
                            "k100_h5", result, now, true)), "", "interface5");
            assertNotNull(owner);
            me.pipi.deliveries.data.ExpressRepository.ManualTimelinePollClaim claim =
                    ExpressSyncEngine.claimListManualTimelinePoll(repository, owner, now, true);
            if (signedAt > 0L) assertNull(claim);
            else assertNotNull(claim);
            repository.releaseManualTimelinePoll(claim);
        }
    }
    @Test public void omittedV5SfDoesNotIssueAccountQuery() {
        ExpressItem sf = new ExpressItem(1L, "", "SFTEST123456", "SF", "顺丰速运",
                StatusSemantic.TRANSIT, "运输中", "运输中", "2026-09-01 10:00:00", "[]",
                "", "INTERFACE5", "", 1L, 2L, "INTERFACE5", "", "", "", true,
                "", "", "[]", "ShunFeng");
        assertFalse(ExpressSyncEngine.shouldRefreshMissingAccountRow(sf, true, 100L, false));
        assertFalse(ExpressSyncEngine.shouldRefreshMissingAccountRow(sf, true, 100L, true));
        assertTrue(ExpressSyncEngine.usesSharedManualTimeline(sf, false));
    }

    @Test public void omittedV6RowsDoNotAddASecondAccountQuery() {
        for (String provider : new String[]{"ShunFeng", "CaiNiao", ""}) {
            ExpressItem owner = sourceItem("INTERFACE6", provider, "SF", "顺丰速运");
            assertFalse(ExpressSyncEngine.shouldRefreshMissingAccountRow(owner, false, 1L, false));
            assertFalse(ExpressSyncEngine.shouldRefreshMissingAccountRow(owner, true, 1L, true));
        }
        assertTrue(ExpressSyncEngine.usesSharedManualTimeline(
                sourceItem("INTERFACE6", "ShunFeng", "SF", "顺丰速运"), true));
    }

    @Test
    public void missingAccountRowUsesSignatureEvidenceInsteadOfCachePresence() {
        long now = java.time.Instant.parse("2026-09-08T12:00:00Z").toEpochMilli();
        ExpressItem signed = new ExpressItem(
                9L, "13800138000", "JD0000000000009", "JD", "京东快递",
                StatusSemantic.COMPLETED, "已签收", "已签收",
                "2026-09-08 10:00:00", "[]", "", "interface5", "");
        ExpressItem missingTime = new ExpressItem(
                9L, "13800138000", "JD0000000000009", "JD", "京东快递",
                StatusSemantic.COMPLETED, "已签收", "已签收", "", "[]", "", "interface5", "");
        for (boolean missingCache : new boolean[]{false, true}) {
            assertFalse(ExpressSyncEngine.shouldRefreshMissingAccountRow(signed, missingCache, now, false));
            assertTrue(ExpressSyncEngine.shouldRefreshMissingAccountRow(missingTime, missingCache, now, false));
        }
        ExpressItem cancelled = new ExpressItem(
                9L, "13800138000", "JD0000000000009", "JD", "京东快递",
                StatusSemantic.CANCELLED, "已取消", "已取消", "", "[]", "", "interface5", "");
        assertFalse(ExpressSyncEngine.shouldRefreshMissingAccountRow(cancelled, false, now, false));
        assertTrue(ExpressSyncEngine.shouldRefreshMissingAccountRow(cancelled, true, now, false));
    }

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
    public void listOnlineUsesSfOrMissingV5AutomaticInformation() {
        assertTrue(ExpressSyncEngine.usesSharedManualTimeline(
                sourceItem("INTERFACE5", "ShunFeng", "ZTO", "中通快递"), false));
        assertFalse(ExpressSyncEngine.usesSharedManualTimeline(
                sourceItem("INTERFACE5", "CaiNiao", "SF", "顺丰速运"), false));
        assertTrue(ExpressSyncEngine.usesSharedManualTimeline(
                sourceItem("INTERFACE5", "", "SF", "顺丰速运"), false));
        assertTrue(ExpressSyncEngine.usesSharedManualTimeline(
                sourceItem("INTERFACE6", "ShunFeng", "SF", "顺丰速运"), false));
        assertFalse(ExpressSyncEngine.usesSharedManualTimeline(
                sourceItem("INTERFACE6", "JingDong", "JD", "京东快递"), false));
    }

    @Test public void explicitPullNeverQueriesMissingCainiaoOrEntersItsManualChain() {
        ExpressItem cainiao = sourceItem("INTERFACE5", "CaiNiao", "ZTO", "中通快递");
        assertFalse(ExpressSyncEngine.shouldRefreshMissingAccountRow(cainiao, true, 1L, true));
        assertFalse(ExpressSyncEngine.usesSharedManualTimeline(cainiao, true));
        assertFalse(ExpressSyncEngine.shouldRefreshMissingAccountRow(cainiao, true, 1L, false));
        assertFalse(ExpressSyncEngine.usesSharedManualTimeline(cainiao, false));
        assertTrue(ExpressSyncEngine.usesSharedManualTimeline(
                sourceItem("INTERFACE5", "ShunFeng", "SF", "顺丰速运"), true));
        assertFalse(ExpressSyncEngine.shouldRefreshMissingAccountRow(
                sourceItem("INTERFACE6", "CaiNiao", "ZTO", "中通快递"), true, 1L, true));
    }

    @Test public void explicitPullNeverQueriesMissingJingdongOrEntersItsManualChain() {
        ExpressItem waybill = sourceItem("INTERFACE5", "JingDong", "ZTO", "中通快递");
        ExpressItem projected = accountOrder("JD_SYNTHETIC_001");
        for (ExpressItem item : new ExpressItem[]{waybill, projected, accountOrder("")}) {
            assertFalse(ExpressSyncEngine.shouldRefreshMissingAccountRow(item, true, 1L, true));
            assertFalse(ExpressSyncEngine.usesSharedManualTimeline(item, true));
            assertFalse(ExpressSyncEngine.shouldRefreshMissingAccountRow(item, true, 1L, false));
        }
        assertFalse(ExpressSyncEngine.usesSharedManualTimeline(waybill, false));
        assertFalse(ExpressSyncEngine.usesSharedManualTimeline(projected, false));
        assertFalse(ExpressSyncEngine.shouldRefreshMissingAccountRow(
                sourceItem("INTERFACE6", "JingDong", "JD", "京东快递"), true, 1L, true));
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

        assertTrue(AccountCarrierRecognition.needsRecognition(missingCarrier));
        assertTrue(AccountCarrierRecognition.needsRecognition(genericCarrier));
        assertFalse(AccountCarrierRecognition.needsRecognition(resolvedCarrier));
        assertFalse(AccountCarrierRecognition.needsRecognition(unprojected));
    }

    @Test
    public void backgroundSyncReadsTheWaybillNamedByOrderTrackText() {
        String tracks = "[{\"time\":\"2026-09-06 11:24:29\",\"context\":"
                + "\"您的订单由第三方卖家拣货完成，待出库交付申通快递，运单号为770018906334362\"},"
                + "{\"time\":\"2026-09-06 00:19:43\",\"context\":\"预计9月6日发货\"}]";

        ExpressOrderTextIdentity.Identity identity = ExpressSyncEngine.textProjectionIdentity(
                accountOrder("", StatusSemantic.PICKED, tracks));

        assertEquals("770018906334362", identity.waybill);
    }

    @Test
    public void textProjectionIgnoresStatusAndNeverRepeatsOrLeavesAccountOrders() {
        String tracks = "[{\"time\":\"2026-09-06 11:24:29\",\"context\":"
                + "\"待出库交付申通快递，运单号为770018906334362\"}]";

        // A returned waybill is identity evidence even before pickup.
        assertEquals("770018906334362", ExpressSyncEngine.textProjectionIdentity(
                accountOrder("", StatusSemantic.ORDERED, tracks)).waybill);
        assertEquals("770018906334362", ExpressSyncEngine.textProjectionIdentity(
                accountOrder("", StatusSemantic.SHIPPED, tracks)).waybill);
        // An already projected order keeps its projection.
        assertNull(ExpressSyncEngine.textProjectionIdentity(
                accountOrder("770018906334362", StatusSemantic.PICKED, tracks)));
        // Text that names no waybill projects nothing.
        assertNull(ExpressSyncEngine.textProjectionIdentity(
                accountOrder("", StatusSemantic.PICKED, "[{\"context\":\"已揽收\"}]")));
        // A plain carrier waybill row is not an account order.
        assertNull(ExpressSyncEngine.textProjectionIdentity(
                sourceItem("INTERFACE5", "", "ZTO", "中通快递")));
        assertNull(ExpressSyncEngine.textProjectionIdentity(null));
    }

    @Test
    public void orderTextProjectionIsExclusiveToInterface5() {
        String tracks = "[{\"time\":\"2026-09-09 10:00:00\",\"context\":"
                + "\"交付申通快递，运单号为770018906334362\"}]";
        ExpressItem unsupported = new ExpressItem(
                4L, "", "3613448003874424", "JD", "京东购物",
                StatusSemantic.PICKED, "已揽收", "订单进行中",
                "2026-09-09 10:00:00", tracks, "", "I6-JD", "",
                1L, 2L, "I6-JD", "I6-JD", "v6", "", true,
                "", "", "[]", "JingDong");
        assertNull(ExpressSyncEngine.textProjectionIdentity(unsupported));
        assertEquals("770018906334362", ExpressSyncEngine.textProjectionIdentity(
                accountOrder("", StatusSemantic.PICKED, tracks)).waybill);
    }

    private static ExpressItem accountOrder(
            String projectedWaybill, StatusSemantic semantic, String tracksJson) {
        return new ExpressItem(
                4L, "", "3613448003874424", "JD", "京东购物",
                semantic, semantic.label, "订单进行中",
                "2026-09-06 11:24:29", tracksJson, "", "I5-JD", "",
                1L, 2L, "I5-JD", "I5-JD", "v5",
                "https://example.jd.com/detail", true,
                projectedWaybill, "", "[]", "JingDong");
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
