package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

import android.app.Application;

import org.junit.Test;
import me.pipi.deliveries.data.ManualTimelineAuthorityPolicy;
import me.pipi.deliveries.data.TimelineSlot;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class)
public final class ExpressDetailScriptTest {
    @Test
    public void activeShunFengHistoryDoesNotFreezeDetailRefresh() {
        ExpressItem active = interfaceItem("INTERFACE5", "ShunFeng", "SF", "顺丰速运");
        assertFalse(ExpressDetailActivity.shouldSkipCompleteCache(active, true));
        assertTrue(ExpressDetailActivity.shouldSkipCompleteCache(
                interfaceItem("INTERFACE5", "CaiNiao", "SF", "顺丰速运"), true));
        ExpressItem signed = new ExpressItem(active.rowId, active.phone, active.waybill,
                active.courierCode, active.companyName, StatusSemantic.COMPLETED,
                "已签收", active.latestDetail, active.latestTime, active.tracksJson,
                active.detailUrl, active.source, active.remark, active.statusEventTime, active.updatedAt,
                active.stateOwner, "", "", "", false, "", "", "[]", "ShunFeng");
        assertTrue(ExpressDetailActivity.shouldSkipCompleteCache(signed, true));
        assertFalse(ExpressDetailActivity.shouldSkipCompleteCache(signed, false));
    }

    @Test
    public void shunFengAccountPickupCannotCloseTheManualHistoryGate() {
        ExpressItem owner = new ExpressItem(10L, "", "TEST123456", "SF", "顺丰速运",
                StatusSemantic.TRANSIT, "运输中", "运输中", "2026-08-24 10:00:00",
                "[{\"time\":\"2026-08-24 10:00:00\",\"context\":\"运输中\"}]",
                "", "INTERFACE5", "", 1L, 2L, "INTERFACE5", "", "", "", false,
                "", "", "[]", "ShunFeng", false, "", 0L);
        ExpressQueryResult account = new ExpressQueryResult(owner.waybill, "SF", "顺丰速运",
                StatusSemantic.TRANSIT, owner.latestTime, "运输中",
                "[{\"time\":\"" + owner.latestTime + "\",\"context\":\"运输中\"},"
                        + "{\"time\":\"2026-08-24 09:00:00\",\"context\":\"已揽收\"}]",
                "", "", TimelineSlot.V5_QUERY);
        for (String provider : new String[]{TimelineSlot.V5_QUERY, TimelineSlot.CN_H5}) {
            assertFalse(ExpressDetailActivity.currentDetailComplete(owner, account,
                    new ManualTimelineAuthorityPolicy.Candidate(provider, account, 100L, true)));
        }
        assertTrue(ExpressDetailActivity.currentDetailComplete(owner, account,
                new ManualTimelineAuthorityPolicy.Candidate(TimelineSlot.V6_QUERY, account, 100L, true)));
    }

    @Test
    public void completeSelectedCacheStopsRefreshWhenJingDongQueryStillLacksPickup() throws Exception {
        ExpressItem owner = new ExpressItem(
                1L, "", "JDORDER123456", "JD", "京东购物",
                StatusSemantic.TRANSIT, "运输中", "订单正在配送", "2026-08-22 10:00:00",
                "[{\"time\":\"2026-08-22 10:00:00\",\"context\":\"订单正在配送\"}]",
                "", "I5-JD", "", 1L, 2L, "I5-JD", "", "v5", "route", true,
                "JDWAYBILL123", "", "[]", "JingDong");
        ExpressQueryResult account = result("interface5", "运输中");
        ExpressQueryResult complete = new ExpressQueryResult(
                owner.displayWaybill(), "JD", "京东快递", StatusSemantic.TRANSIT,
                owner.latestTime, "运输中",
                "[{\"time\":\"" + owner.latestTime + "\",\"context\":\"运输中\"},"
                        + "{\"time\":\"2026-08-22 09:00:00\",\"context\":\"已揽收\"}]",
                "", "", TimelineSlot.V6_QUERY);
        ManualTimelineAuthorityPolicy.Candidate selected = new ManualTimelineAuthorityPolicy.Candidate(
                TimelineSlot.V6_QUERY, complete, 100L, true);
        assertTrue(ExpressDetailActivity.currentDetailComplete(owner, account, selected));
        assertFalse(ExpressDetailActivity.currentDetailComplete(owner, account, null));
    }

    @Test
    public void jingDongCaptureFillsMissingIdentityRegardlessOfQueryTimeline() {
        ExpressItem projected = jingDongWebItem("https://jingfen.jd.com/item", "", 0L);
        assertFalse(ExpressDetailActivity.allowsJingDongCapture(projected));
        ExpressItem unresolved = interfaceItem("I5-JD", "JingDong", "JD", "京东购物");
        assertTrue(ExpressDetailActivity.allowsJingDongCapture(unresolved));
        assertFalse(ExpressDetailActivity.shouldSkipCompleteCache(unresolved, true));
        assertFalse(ExpressDetailActivity.allowsJingDongCapture(
                interfaceItem("I6-JD", "JingDong", "JD", "京东购物")));
        assertFalse(ExpressDetailActivity.allowsPrimaryKuaidi100(unresolved));
        assertTrue(ExpressDetailActivity.allowsPrimaryKuaidi100(
                interfaceItem("INTERFACE5", "ShunFeng", "SF", "顺丰速运")));
        assertTrue(ExpressDetailActivity.allowsPrimaryKuaidi100(
                interfaceItem("INTERFACE5", "CaiNiao", "ZTO", "中通快递")));
        assertFalse(ExpressDetailActivity.allowsPrimaryKuaidi100(
                interfaceItem("INTERFACE6", "CaiNiao", "ZTO", "中通快递")));
    }

    @Test
    public void interface6JingDongHasNoPageOrNativeQueryRoute() {
        ExpressItem unsupported = interfaceItem(
                "INTERFACE6", "JingDong", "JD", "京东快递");
        assertFalse(ExpressDetailActivity.usesDirectAutomaticH5(unsupported));
        assertFalse(ExpressDetailActivity.allowsJingDongRoute(unsupported));
        assertFalse(ExpressDetailActivity.canRefreshLocalTimeline(unsupported));
        assertFalse(ExpressDetailActivity.canRefreshLocalTimeline(
                accountOrder("I6-JD", "JDWAYBILL123")));
        assertFalse(ExpressDetailActivity.needsManualSupplement(
                unsupported, result("interface6", "运输中"), null));
        assertTrue(ExpressDetailActivity.usesDirectAutomaticH5(
                interfaceItem("INTERFACE6", "CaiNiao", "ZTO", "中通快递")));
    }

    @Test
    public void cainiaoRedirectErrorBlankAndTimeoutFallBackToNative() throws Exception {
        Path path = Path.of(
                "app/src/main/java/me/pipi/deliveries/feature/express/ExpressDetailActivity.java");
        if (!Files.isRegularFile(path)) {
            path = Path.of(
                    "src/main/java/me/pipi/deliveries/feature/express/ExpressDetailActivity.java");
        }
        String source = Files.readString(path, StandardCharsets.UTF_8);

        assertTrue(source.contains(
                "if (blocked && (request == null || request.isForMainFrame()))"));
        assertTrue(source.contains("fallbackWebDetailToNative(view, progress);"));
        assertTrue(source.contains("revealCainiaoPageOrFallback("));
        assertTrue(source.contains("if (!\"true\".equals(value))"));
        assertTrue(source.contains("webView.getVisibility() != View.VISIBLE"));
        assertFalse(source.contains(
                "if (!isFinishing() && !isDestroyed()) revealWebView(webView, progress);"));
    }

    @Test
    public void pickerDetailRouteAcceptsOnlyHttpsKuaidi100Hosts() {
        String trusted = "https://m.kuaidi100.com/result.jsp?nu=TEST123456";

        assertEquals(trusted, ExpressDetailActivity.safeKuaidi100Url(trusted));
        assertEquals("", ExpressDetailActivity.safeKuaidi100Url(
                "http://m.kuaidi100.com/result.jsp?nu=TEST123456"));
        assertEquals("", ExpressDetailActivity.safeKuaidi100Url(
                "https://kuaidi100.com.evil.invalid/result.jsp?nu=TEST123456"));
        assertEquals("", ExpressDetailActivity.safeKuaidi100Url(
                "https://example.invalid/result.jsp?nu=TEST123456"));
    }







    @Test
    public void providerH5RoutesRemainExactAndInterface5JingDongUsesAutomaticCapture()
            throws Exception {
        String trustedJd = "https://jingfen.jd.com/detail?opaque=signed";
        ExpressItem jingDong = jingDongWebItem(trustedJd, "", 0L);
        ExpressItem jingDongWithManual = jingDongWebItem(
                trustedJd, "kuaidi100", 100L);

        assertEquals(trustedJd, ExpressDetailActivity.safeOrderH5Url(jingDong));
        assertEquals(trustedJd, ExpressDetailActivity.safeOrderH5Url(jingDongWithManual));
        assertTrue(ExpressDetailActivity.allowsKuaidi100Route(
                interfaceItem("INTERFACE5", "ShunFeng", "SF", "顺丰速运"), null));
        assertTrue(ExpressDetailActivity.allowsKuaidi100Route(
                manualAuthorityItem(true, "I6-K100"), null));
        assertFalse(ExpressDetailActivity.allowsKuaidi100Route(jingDong, null));
        assertFalse(ExpressDetailActivity.allowsKuaidi100Route(
                interfaceItem("INTERFACE5", "CaiNiao", "ZTO", "中通快递"), null));
        assertFalse(ExpressDetailActivity.allowsKuaidi100Route(
                interfaceItem("INTERFACE6", "DouYin", "ZTO", "中通快递"), null));

        String source = detailActivitySource();
        assertFalse(source.contains("showJingDongWebDetail("));
        assertFalse(source.contains("orderProjectionProbeScript("));
        assertTrue(source.contains("ExpressAutomaticTimelineCapture.capture("));
        assertTrue(source.contains("setContentView(R.layout.activity_express_web)"));
        assertFalse(source.contains("startProjectedOrderTimelineRefresh"));
        assertFalse(source.contains("saveProjectedOrderTimeline("));
    }






    @Test
    public void jingDongCaptureRouteRequiresHttpsAndTheExactJdDomain() {
        assertTrue(ExpressDetailActivity.allowedOrderHost(
                android.net.Uri.parse("https://jingfen.jd.com/item")));
        assertTrue(ExpressDetailActivity.allowedOrderHost(
                android.net.Uri.parse("https://jd.com/")));
        assertFalse(ExpressDetailActivity.allowedOrderHost(
                android.net.Uri.parse("http://jingfen.jd.com/item")));
        assertFalse(ExpressDetailActivity.allowedOrderHost(
                android.net.Uri.parse("https://jd.com.evil.invalid/item")));
        assertFalse(ExpressDetailActivity.allowedOrderHost(
                android.net.Uri.parse("https://evil.invalid/item")));
    }

    private static String detailActivitySource() throws Exception {
        Path path = Path.of(
                "app/src/main/java/me/pipi/deliveries/feature/express/ExpressDetailActivity.java");
        if (!Files.isRegularFile(path)) {
            path = Path.of(
                    "src/main/java/me/pipi/deliveries/feature/express/ExpressDetailActivity.java");
        }
        return Files.readString(path, StandardCharsets.UTF_8);
    }



    @Test
    public void ordinaryAccountRowsCanOwnACompleteCachedTimeline() {
        assertEquals("interface5", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE5", "", "ZTO", "中通快递", "pipi-route:v5")));
        assertEquals("interface6", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE6", "")));
    }

    @Test
    public void interface5TimelineRoutingFollowsTheRecordSource() {
        assertEquals("", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE5", "", "SF", "顺丰速运")));
        assertEquals("", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE5", "", "ZTO", "中通快递")));
        assertEquals("interface5", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE5", "", "ZTO", "中通快递", "pipi-route:v5")));
        assertEquals("interface5", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE5", "", "SF", "顺丰速运", "pipi-route:v5")));
        assertEquals("interface5", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE5", "", "ZTO", "中通快递",
                        "https://detail.cainiao.com/parcel?secretKey=test&from=interface5")));
        assertEquals("interface5", ExpressDetailActivity.accountTimelineSource(
                accountOrder("I5-JD", "SFPROJECTED123")));
        assertEquals("", ExpressDetailActivity.accountTimelineSource(
                accountOrder("I6-JD", "SFPROJECTED456")));
        assertEquals("interface6", ExpressDetailActivity.accountTimelineSource(
                item("INTERFACE6", "", "SF", "顺丰速运")));
    }

    @Test
    public void projectedOrderReadsOnlyTheRealCarrierIdentity() {
        ExpressItem order = accountOrder("I5-JD", "SFPROJECTED123");

        assertEquals("SFPROJECTED123", ExpressDetailActivity.accountTimelineWaybill(order));
        assertEquals("TEST123456", ExpressDetailActivity.accountTimelineWaybill(
                item("INTERFACE5", "", "SF", "顺丰速运")));
    }

    @Test
    public void completeAccountTimelineWinsAndMissingAccountFallsBack() {
        ExpressQueryResult account = result("interface6", "主来源轨迹");
        ExpressQueryResult publicTimeline = result("v4", "公共查询轨迹");
        ExpressQueryResult kuaidi100 = result("kuaidi100", "兜底轨迹");

        assertEquals(account, ExpressDetailActivity.preferredDetailTimeline(
                account, publicTimeline, kuaidi100));
        assertEquals(publicTimeline, ExpressDetailActivity.preferredDetailTimeline(
                null, publicTimeline, kuaidi100));
        assertEquals(kuaidi100, ExpressDetailActivity.preferredDetailTimeline(
                null, null, kuaidi100));
    }

    @Test
    public void projectedOrderRequiresTimedAccountTimelineBeforeSuppressingFallback() {
        ExpressQueryResult untimed = new ExpressQueryResult(
                "SFPROJECTED123", "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "", "快件已揽收", "[{\"context\":\"快件已揽收\"}]",
                "", "", "interface5");

        assertFalse(ExpressDetailActivity.accountTimelineUsable(
                accountOrder("I5-JD", "SFPROJECTED123"), untimed));
        assertTrue(ExpressDetailActivity.accountTimelineUsable(
                item("INTERFACE5", "", "SF", "顺丰速运"), untimed));
    }

    @Test
    public void missingLocalCacheShowsLoadingOnlyWhileARefreshCanRun() {
        assertEquals(ExpressDetailActivity.InitialTimelinePresentation.LOADING,
                ExpressDetailActivity.initialTimelinePresentation(false, true));
        assertEquals(ExpressDetailActivity.InitialTimelinePresentation.TRACKS,
                ExpressDetailActivity.initialTimelinePresentation(true, true));
        assertEquals(ExpressDetailActivity.InitialTimelinePresentation.EMPTY,
                ExpressDetailActivity.initialTimelinePresentation(false, false));
    }

    @Test
    public void manualSidecarCannotStandInForTheAutomaticPickupGate() {
        ExpressItem owner = item("INTERFACE6", "");
        ExpressItem cainiao = interfaceItem(
                "INTERFACE5", "CaiNiao", "ZTO", "中通快递");
        ExpressQueryResult partial = result("interface6", "主来源只有头条");
        ExpressQueryResult complete = new ExpressQueryResult(
                "TEST123456", "ZTO", "中通快递", StatusSemantic.TRANSIT,
                "2026-08-22 10:00:00", "快件运输中",
                "[{\"time\":\"2026-08-22 10:00:00\",\"context\":\"快件运输中\"},"
                        + "{\"time\":\"2026-08-22 09:00:00\",\"context\":\"快件已揽收\"}]",
                "", "", "kuaidi100");

        assertTrue(ExpressDetailActivity.needsManualSupplement(owner, partial, null));
        assertTrue(ExpressDetailActivity.needsManualSupplement(cainiao, partial, null));
        assertTrue(ExpressDetailActivity.needsManualSupplement(owner, partial, complete));
        assertFalse(ExpressDetailActivity.needsManualSupplement(owner, complete, null));
    }

    @Test
    public void explicitUnknownStatusContinuesDespiteCompleteFeedHistory() throws Exception {
        ExpressQueryResult complete = new ExpressQueryResult("TEST123456", "ZTO", "中通快递",
                StatusSemantic.UNKNOWN, "2026-09-09 09:00:00", "快件已揽收",
                "[{\"time\":\"2026-09-09 09:00:00\",\"context\":\"快件已揽收\"}]",
                "", "", "interface5");
        ExpressItem owner = new ExpressItem(1L, "", "TEST123456", "ZTO", "中通快递",
                StatusSemantic.UNKNOWN, "", complete.latestDetail, complete.latestTime,
                complete.tracksJson, "", "INTERFACE5", "", 0L, 2L,
                "INTERFACE5", "", "", "", true, "", "", "[]", "DouYin");
        assertTrue(ExpressDetailActivity.needsManualSupplement(owner, complete, null));
        assertFalse(ExpressDetailActivity.needsManualSupplement(
                interfaceItem("INTERFACE5", "DouYin", "ZTO", "中通快递"), complete, null));
        String source = detailActivitySource();
        assertTrue(source.contains("shouldSkipCompleteCache(requestItem, currentDetailComplete(requestItem))"));
        assertTrue(source.contains("if (item.semantic == StatusSemantic.UNKNOWN || allowsJingDongCapture(item)) refreshLocalTimeline(false);"));
        assertTrue(source.contains("queryOwner.semantic == StatusSemantic.UNKNOWN && currentDetailComplete(queryOwner)"));
    }

    @Test
    public void accountOrderWaitsForItsProjectedWaybillBeforeLocalLookup() {
        // 用户定 2026-09-05：接口 5 的京东订单详情优先按件详情（订单号查 /v2/query），
        // 所以未投影出运单号也能刷——刷的是账号时间线，不是本地手动链。
        assertTrue(ExpressDetailActivity.canRefreshLocalTimeline(
                accountOrder("")));
        assertTrue(ExpressDetailActivity.prefersAccountTimeline(accountOrder("")));
        assertFalse(ExpressDetailActivity.prefersAccountTimeline(accountOrder("I6-JD", "")));
        assertTrue(ExpressDetailActivity.canRefreshLocalTimeline(
                accountOrder("JDWAYBILL123")));
        assertFalse(ExpressDetailActivity.canRefreshLocalTimeline(
                accountOrder("I6-JD", "")));
        assertTrue(ExpressDetailActivity.canRefreshLocalTimeline(
                item("V4", "")));
    }

    @Test
    public void providerRoutesRequireTheirExactProviderBeforeAndAfterAuthority() {
        ExpressItem before = sourceOwnedItem("", 0L);
        ExpressItem after = sourceOwnedItem("kuaidi100", 100L);
        ExpressItem cainiao = interfaceItem(
                "INTERFACE5", "CaiNiao", "SF", "顺丰速运");
        ExpressItem cainiaoWithStaleManual = interfaceItemWithManualTimeline(
                "INTERFACE6", "CaiNiao", "kuaidi100", 100L);
        ExpressItem jingDong = interfaceItem(
                "I5-JD", "JingDong", "JD", "京东购物");
        ExpressItem unknown = interfaceItem(
                "INTERFACE5", "", "SF", "顺丰速运");
        ExpressItem manual = manualAuthorityItem(true, "I6-K100");
        ExpressItem promoted = manualAuthorityItem(false, "INTERFACE6");

        assertFalse(ExpressDetailActivity.allowsCainiaoRoute(before));
        assertFalse(ExpressDetailActivity.allowsCainiaoRoute(after));
        assertTrue(ExpressDetailActivity.allowsCainiaoRoute(cainiao));
        assertTrue(ExpressDetailActivity.allowsCainiaoRoute(cainiaoWithStaleManual));
        assertFalse(ExpressDetailActivity.allowsCainiaoRoute(jingDong));
        assertFalse(ExpressDetailActivity.allowsCainiaoRoute(unknown));
        assertFalse(ExpressDetailActivity.allowsCainiaoRoute(manual));
        assertFalse(ExpressDetailActivity.allowsCainiaoRoute(promoted));
        assertFalse(ExpressDetailActivity.allowsJingDongRoute(before));
        assertFalse(ExpressDetailActivity.allowsJingDongRoute(after));
        assertFalse(ExpressDetailActivity.allowsJingDongRoute(cainiao));
        assertTrue(ExpressDetailActivity.allowsJingDongRoute(jingDong));
        assertFalse(ExpressDetailActivity.allowsJingDongRoute(unknown));
        assertFalse(ExpressDetailActivity.allowsJingDongRoute(manual));
        assertFalse(ExpressDetailActivity.allowsJingDongRoute(promoted));
        assertEquals(before.detailUrl, after.detailUrl);
        assertEquals(before.routeCredential, after.routeCredential);
    }

    @Test
    public void selectedManualPackageOwnsDetailForManualAndPromotedAccountRows() {
        assertTrue(ExpressDetailActivity.manualTimelineOwnsDetail(
                manualAuthorityItem(true, "I6-K100")));
        assertTrue(ExpressDetailActivity.manualTimelineOwnsDetail(
                manualAuthorityItem(false, "INTERFACE6")));
        assertFalse(ExpressDetailActivity.manualTimelineOwnsDetail(
                manualAuthorityItem(false, "INTERFACE6", "", 0L)));
    }

    @Test
    public void exactShunFengProviderUsesTheSharedManualDetailPathAcrossInterfaces() {
        assertTrue(ExpressDetailActivity.usesSharedManualTimeline(
                interfaceItem("INTERFACE5", "ShunFeng", "ZTO", "中通快递")));
        assertFalse(ExpressDetailActivity.usesSharedManualTimeline(
                interfaceItem("INTERFACE5", "CaiNiao", "SF", "顺丰速运")));
        assertFalse(ExpressDetailActivity.usesSharedManualTimeline(
                interfaceItem("INTERFACE5", "", "SF", "顺丰速运")));
        assertTrue(ExpressDetailActivity.usesSharedManualTimeline(
                interfaceItem("INTERFACE6", "ShunFeng", "SF", "顺丰速运")));
        assertFalse(ExpressDetailActivity.usesSharedManualTimeline(
                interfaceItem("INTERFACE6", "JingDong", "JD", "京东快递")));
    }

    private static ExpressItem accountOrder(String projectedWaybill) {
        return accountOrder("I5-JD", projectedWaybill);
    }

    private static ExpressItem accountOrder(String owner, String projectedWaybill) {
        return new ExpressItem(
                1L, "", "JDORDER123456", "JD", "京东购物",
                StatusSemantic.TRANSIT, "运输中", "订单正在配送",
                "2026-08-22 10:00:00", "[]", "", owner, "",
                1L, 2L, owner, "", "v5", "route", true,
                projectedWaybill, "", "[]");
    }

    private static ExpressItem item(String owner, String projectedWaybill) {
        return item(owner, projectedWaybill, "ZTO", "中通快递");
    }

    private static ExpressItem item(
            String owner, String projectedWaybill, String courierCode, String companyName) {
        return item(owner, projectedWaybill, courierCode, companyName, "");
    }

    private static ExpressItem item(
            String owner, String projectedWaybill, String courierCode, String companyName,
            String detailUrl) {
        return new ExpressItem(
                1L, "", "TEST123456", courierCode, companyName,
                StatusSemantic.TRANSIT, "运输中", "已到达转运中心",
                "2026-08-22 10:00:00", "[]", "", owner, detailUrl,
                1L, 2L, owner, "", "", "", true,
                projectedWaybill, "", "[]");
    }

    private static ExpressQueryResult result(String provider, String detail) {
        return new ExpressQueryResult(
                "TEST123456", "ZTO", "中通快递", StatusSemantic.TRANSIT,
                "2026-08-22 10:00:00", detail,
                "[{\"time\":\"2026-08-22 10:00:00\",\"context\":\""
                        + detail + "\"}]",
                "", "", provider);
    }

    private static ExpressItem sourceOwnedItem(String manualProvider, long successAt) {
        return new ExpressItem(
                8L, "", "SFTEST123456", "SF", "顺丰速运",
                StatusSemantic.TRANSIT, "运输中", "账号来源摘要",
                "2026-08-24 10:00:00", "[]", "", "INTERFACE5",
                "pipi-route:v5", 1L, 2L, "INTERFACE5", "INTERFACE5",
                "v5", "https://example.invalid/private-route", true,
                "", "", "", "ShunFeng", false, manualProvider, successAt);
    }

    private static ExpressItem interfaceItem(
            String owner, String sourceProvider, String courierCode, String companyName) {
        return new ExpressItem(
                10L, "", "TEST123456", courierCode, companyName,
                StatusSemantic.TRANSIT, "运输中", "账号来源摘要",
                "2026-08-24 10:00:00", "[]", "", owner,
                "pipi-route:v5", 1L, 2L, owner, owner,
                "v5", "route", true,
                "", "", "", sourceProvider, false, "", 0L);
    }

    private static ExpressItem interfaceItemWithManualTimeline(
            String owner, String sourceProvider, String manualProvider, long successAt) {
        return new ExpressItem(
                10L, "", "TEST123456", "ZTO", "中通快递",
                StatusSemantic.TRANSIT, "运输中", "账号来源摘要",
                "2026-08-24 10:00:00", "[]", "", owner,
                "pipi-route:v5", 1L, 2L, owner, owner,
                "v5", "route", true,
                "", "", "", sourceProvider, false, manualProvider, successAt);
    }

    private static ExpressItem manualAuthorityItem(boolean manual, String owner) {
        return manualAuthorityItem(manual, owner, "kuaidi100", 100L);
    }

    private static ExpressItem manualAuthorityItem(
            boolean manual, String owner, String provider, long successAt) {
        return new ExpressItem(
                9L, "13900000000", "SFTEST123456", "SF", "顺丰速运",
                StatusSemantic.COMPLETED, "已签收", "快件已签收",
                "2026-08-25 09:00:00",
                "[{\"time\":\"2026-08-25 09:00:00\","
                        + "\"context\":\"快件已签收\"}]",
                "", owner, "", 1L, 2L, owner, "", "", "", true,
                "", "", "", "", manual, provider, successAt);
    }

    private static ExpressItem jingDongWebItem(
            String route, String manualProvider, long successAt) {
        return new ExpressItem(
                11L, "", "JDORDER123456", "JD", "京东购物",
                StatusSemantic.TRANSIT, "运输中", "订单运输中",
                "2026-08-24 10:00:00", "[]", "", "I5-JD", route,
                1L, 2L, "I5-JD", "I5-JD", "v5", route, true,
                "JDPROJECTED123", "京东快递", "[]", "JingDong", false,
                manualProvider, successAt);
    }
}
