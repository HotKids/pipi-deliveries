package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

import android.app.Application;

import org.json.JSONObject;
import org.junit.Test;
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
    public void orderProbePostsIdentityOnlyAndKeepsTheQueueFallback() {
        String probe = ExpressDetailActivity.orderProjectionProbeScript();
        String reader = ExpressDetailActivity.orderProjectionReadScript();

        assertTrue(probe.contains("__deliveriesOrderProjections"));
        assertTrue(probe.contains("q.length>16"));
        assertTrue(probe.contains("window.deliveriesOrderProjection"));
        assertTrue(probe.contains("bridge.postMessage"));
        assertTrue(probe.contains("function bounded("));
        assertTrue(probe.contains("add(info.waybillCode,carrier)"));
        assertTrue(probe.contains("add(candidate.waybillCode"));
        assertTrue(probe.contains("identities.push({waybillCode:way"));
        assertTrue(probe.contains("emit({identities:identities})"));
        assertFalse(probe.contains("traceList:selected"));
        assertFalse(probe.contains("if(!way){for"));
        assertTrue(reader.contains("q.shift()"));
    }

    @Test
    public void bridgeRejectsNonStringSubframeOversizeAndUntrustedMessages() {
        String valid = "{\"waybillCode\":\"SF123456789\",\"carrierName\":\"\"}";

        assertEquals(valid, ExpressOrderProjectionBridge.validatedPayload(
                true, valid, "https://jingfen.jd.com", true));
        assertEquals("", ExpressOrderProjectionBridge.validatedPayload(
                false, valid, "https://jingfen.jd.com", true));
        assertEquals("", ExpressOrderProjectionBridge.validatedPayload(
                true, valid, "https://jingfen.jd.com", false));
        assertEquals("", ExpressOrderProjectionBridge.validatedPayload(
                true, valid, "https://jd.com.evil.invalid", true));
        assertEquals("", ExpressOrderProjectionBridge.validatedPayload(
                true, "界".repeat(ExpressOrderProjectionBridge.MAX_PAYLOAD_BYTES / 2),
                "https://jd.com", true));
    }

    @Test
    public void nativeCandidateSelectionSkipsTheOrderIdAndAcceptsTheTraceWaybill() {
        String sourceOrder = "350365030147";

        assertEquals(null, ExpressOrderProjectionBridge.candidate(
                "{\"waybillCode\":\"350365030147\",\"carrierName\":\"商城\"}",
                sourceOrder));
        ExpressOrderProjectionBridge.Candidate trace =
                ExpressOrderProjectionBridge.candidate(
                        "{\"waybillCode\":\"SF1234567890\",\"carrierName\":\"顺丰速运\"}",
                        sourceOrder);
        assertEquals("SF1234567890", trace.waybill);
        assertEquals("顺丰速运", trace.carrier);
    }

    @Test
    public void nativeCandidateValidatesAllWaybillsFromOneProviderResponseAtomically() {
        String sourceOrder = "350365030147";
        ExpressOrderProjectionBridge.Candidate projected =
                ExpressOrderProjectionBridge.candidate(
                        "{\"identities\":["
                                + "{\"waybillCode\":\"350365030147\",\"carrierName\":\"商城\"},"
                                + "{\"waybillCode\":\"JDVA1234567890\",\"carrierName\":\"京东快递\"}]}",
                        sourceOrder);

        assertEquals("JDVA1234567890", projected.waybill);
        assertEquals("京东快递", projected.carrier);
        assertEquals(null, ExpressOrderProjectionBridge.candidate(
                "{\"identities\":["
                        + "{\"waybillCode\":\"JDVA1234567890\",\"carrierName\":\"京东快递\"},"
                        + "{\"waybillCode\":\"SF1234567890\",\"carrierName\":\"顺丰速运\"}]}",
                sourceOrder));
    }

    @Test
    public void detailProjectionIgnoresAnyH5TimelinePayload() {
        ExpressOrderProjectionBridge.Candidate projection =
                ExpressOrderProjectionBridge.candidate(
                        "{\"waybillCode\":\"SF1234567890\","
                                + "\"carrierName\":\"顺丰速运\","
                                + "\"traceList\":[{"
                                + "\"waybillCode\":\"SF1234567890\","
                                + "\"time\":\"2026-08-31 10:00:00\","
                                + "\"desc\":\"快件运输中\",\"status\":\"TRANSIT\"}]} ",
                        "JDORDER123456");

        assertEquals("SF1234567890", projection.waybill);
        assertEquals("顺丰速运", projection.carrier);
        assertFalse(detailActivitySourceUnchecked().contains("saveProjectedOrderTimeline("));
    }

    @Test
    public void unresolvedOrderDetailAttemptsIdentityH5OnceWithoutAutomaticPaidFallback()
            throws Exception {
        String source = detailActivitySource();
        String automaticStart = method(
                source, "private void startOrderProjectionCaptureIfDue()",
                "private void waitForOrderProjectionAttempt");
        String capture = method(
                source, "private boolean startOrderProjectionCapture(String detailUrl)",
                "private void startOrderProjectionCaptureIfDue()");

        assertTrue(automaticStart.contains("detailIdentityProjectionAttempted"));
        assertTrue(automaticStart.contains(
                "if (attemptRetained) detailIdentityProjectionAttempted = true;"));
        assertTrue(capture.contains("failOrderProjectionAttempt();"));
        assertFalse(capture.contains("projectedOrderTimelineCapture"));
        assertFalse(automaticStart.contains("refreshLocalTimeline("));
    }

    @Test
    public void providerH5RoutesOpenInsideTheSharedWebContainerWithoutInventingUrls()
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
        assertTrue(ExpressDetailActivity.allowsKuaidi100Route(
                jingDong, null, true));
        assertFalse(ExpressDetailActivity.allowsKuaidi100Route(
                interfaceItem("INTERFACE5", "CaiNiao", "ZTO", "中通快递"),
                null,
                true));
        assertFalse(ExpressDetailActivity.allowsKuaidi100Route(
                interfaceItem("INTERFACE5", "CaiNiao", "ZTO", "中通快递"), null));
        assertFalse(ExpressDetailActivity.allowsKuaidi100Route(
                interfaceItem("INTERFACE6", "DouYin", "ZTO", "中通快递"), null));

        String source = detailActivitySource();
        assertTrue(source.contains("showJingDongWebDetail(jingDongUrl)"));
        assertTrue(source.contains("setContentView(R.layout.activity_express_web)"));
        assertFalse(source.contains("startProjectedOrderTimelineRefresh"));
        assertFalse(source.contains("saveProjectedOrderTimeline("));
    }

    @Test
    public void visibleJingDongDetailReusesItsWebViewForIdentityProjection() throws Exception {
        String source = detailActivitySource();
        String visibleDetail = method(
                source, "private void showJingDongWebDetail(String detailUrl)",
                "private void showKuaidi100WebDetail(String detailUrl)");
        String capture = method(
                source, "private boolean startOrderProjectionCapture(String detailUrl)",
                "private void startOrderProjectionCaptureIfDue()");

        assertTrue(visibleDetail.contains("installOrderProjectionBridge(webView);"));
        assertTrue(visibleDetail.contains("injectOrderProjectionProbe(view);"));
        assertTrue(capture.contains(
                "if (reuseVisibleOrderProjectionCapture(detailUrl)) return true;"));
        assertTrue(capture.indexOf("reuseVisibleOrderProjectionCapture(detailUrl)")
                < capture.indexOf("new WebView(this)"));
        assertFalse(source.contains("saveProjectedOrderTimeline("));
    }

    @Test
    public void jingDongFullProgressUsesTheVerifiedOfficialControlWithoutReadingTimeline() {
        String probe = ExpressDetailActivity.jingDongFullProgressExpansionScript();

        assertTrue(probe.contains(".logistics-button"));
        assertTrue(probe.contains(".logistics-button-text"));
        assertTrue(probe.contains("完整物流进度"));
        assertTrue(probe.contains("button.click()"));
        assertFalse(probe.contains("location.href"));
        assertFalse(probe.contains("document.cookie"));
        assertFalse(probe.contains("outerHTML"));
        assertFalse(probe.contains("innerHTML"));
        assertFalse(probe.contains("traceList"));
    }

    @Test
    public void jingDongLoginRedirectBlocksEveryPathOnTheExactLoginHost() {
        assertTrue(ExpressDetailActivity.isBlockedJingDongLogin(
                android.net.Uri.parse("https://plogin.m.jd.com/login/login")));
        assertTrue(ExpressDetailActivity.isBlockedJingDongLogin(
                android.net.Uri.parse("https://plogin.m.jd.com/login/login?returnurl=opaque")));
        assertTrue(ExpressDetailActivity.isBlockedJingDongLogin(
                android.net.Uri.parse("https://plogin.m.jd.com/login/other")));
        assertTrue(ExpressDetailActivity.isBlockedJingDongLogin(
                android.net.Uri.parse("https://plogin.m.jd.com/")));
        assertFalse(ExpressDetailActivity.isBlockedJingDongLogin(
                android.net.Uri.parse("https://jingfen.jd.com/item")));
        assertFalse(ExpressDetailActivity.isBlockedJingDongLogin(
                android.net.Uri.parse("http://plogin.m.jd.com/login/login")));
        assertFalse(ExpressDetailActivity.isBlockedJingDongLogin(
                android.net.Uri.parse("https://plogin.m.jd.com.evil.invalid/login/login")));
        assertTrue(ExpressDetailActivity.shouldBlockJingDongNavigation(
                android.net.Uri.parse("https://plogin.m.jd.com/login/other"), true));
        assertFalse(ExpressDetailActivity.shouldBlockJingDongNavigation(
                android.net.Uri.parse("https://plogin.m.jd.com/login/other"), false));
        assertTrue(ExpressDetailActivity.shouldBlockJingDongNavigation(
                android.net.Uri.parse("https://evil.invalid/redirect"), false));
        assertTrue(ExpressDetailActivity.isJingDongLogisticsPage(
                android.net.Uri.parse("https://jingfen.jd.com/item?opaque=signed")));
        assertFalse(ExpressDetailActivity.isJingDongLogisticsPage(
                android.net.Uri.parse("https://jingfen.jd.com/other")));
        assertFalse(ExpressDetailActivity.isJingDongLogisticsPage(
                android.net.Uri.parse("https://plogin.m.jd.com/login/login")));

        String visibleDetail = method(
                detailActivitySourceUnchecked(),
                "private void showJingDongWebDetail(String detailUrl)",
                "private void showKuaidi100WebDetail(String detailUrl)");
        assertTrue(visibleDetail.contains("request.isForMainFrame()"));
        assertTrue(visibleDetail.contains("fallbackJingDongWebDetail(view, progress);"));
    }

    @Test
    public void jingDongWebFailureUsesPickerK100BeforeNativeDetail() throws Exception {
        String source = detailActivitySource();

        assertTrue(source.contains("fallbackJingDongWebDetail(view, progress);"));
        assertTrue(source.contains("String fallbackUrl = kuaidi100FallbackUrl();"));
        assertTrue(source.contains("showKuaidi100WebDetail(fallbackUrl);"));
    }

    @Test
    public void evaluationCallbackAcceptsOnlyEncodedStrings() {
        String projection = "{\"waybillCode\":\"TEST123456\",\"carrierName\":\"快递\"}";

        assertEquals(projection, ExpressDetailActivity.decodeEvaluationString(
                JSONObject.quote(projection)));
        assertEquals("", ExpressDetailActivity.decodeEvaluationString("null"));
        assertEquals("", ExpressDetailActivity.decodeEvaluationString("{}"));
        assertEquals("", ExpressDetailActivity.decodeEvaluationString("not-json"));
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

    private static String detailActivitySourceUnchecked() {
        try {
            return detailActivitySource();
        } catch (Exception failure) {
            throw new AssertionError(failure);
        }
    }

    private static String method(String source, String start, String end) {
        int startIndex = source.indexOf(start);
        int endIndex = source.indexOf(end, startIndex);
        assertTrue(startIndex >= 0);
        assertTrue(endIndex > startIndex);
        return source.substring(startIndex, endIndex);
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
    public void partialOwnerTriggersManualSupplementAndCompleteSidecarStopsIt() {
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
        assertFalse(ExpressDetailActivity.needsManualSupplement(cainiao, partial, null));
        assertFalse(ExpressDetailActivity.needsManualSupplement(owner, partial, complete));
        assertFalse(ExpressDetailActivity.needsManualSupplement(owner, complete, null));
    }

    @Test
    public void accountOrderWaitsForItsProjectedWaybillBeforeLocalLookup() {
        assertFalse(ExpressDetailActivity.canRefreshLocalTimeline(
                accountOrder("")));
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
        assertTrue(ExpressDetailActivity.usesSharedManualTimeline(
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
