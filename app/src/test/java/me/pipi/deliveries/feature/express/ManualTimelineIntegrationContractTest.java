package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.Test;

public final class ManualTimelineIntegrationContractTest {
    @Test
    public void foregroundBackgroundAndDetailReuseTheSameManualCoordinator() throws Exception {
        String list = source("feature/express/ExpressListActivity.java");
        String sync = source("background/ExpressSyncEngine.java");
        String detail = source("feature/express/ExpressDetailActivity.java");
        String coordinator = source("network/ManualQueryCoordinator.java");

        assertTrue(list.contains("ExpressDetailActivity.manualQueryIntent("));
        assertFalse(list.contains("ManualQueryCoordinator.queryPickerFirst("));
        assertTrue(sync.contains("ManualQueryCoordinator.queryPickerFirst("));
        assertTrue(detail.contains("ManualQueryCoordinator.queryPickerFirst("));
        assertFalse(list.contains("OppoManualTimelineClient"));
        assertFalse(sync.contains("OppoManualTimelineClient"));
        assertFalse(detail.contains("OppoManualTimelineClient"));
        assertTrue(detail.contains("new ExpressSubscriptionClient()"));
        assertTrue(sync.contains("ExpressSubscriptionClient subscription ="
                + " new ExpressSubscriptionClient()"));
        assertTrue(detail.contains("new ExpressSubscriptionClient()"));
        assertTrue((list + sync + detail).contains("queryMoto("));
        assertTrue((list + sync + detail).contains("queryManual("));
        assertFalse((list + sync + detail).contains("queryWithPhones("));
        assertTrue(coordinator.contains("new ActivatedSource(\"local\", local)"));
        assertTrue(coordinator.contains("new ActivatedSource(\"route\", route)"));
        assertFalse(coordinator.contains("new ActivatedSource(\"fallback\""));
        assertTrue(coordinator.contains("Executors.newFixedThreadPool"));
        assertFalse(coordinator.contains("includeFallback"));
        assertTrue(sync.contains("manualOwner.displayWaybill()"));
        assertTrue(sync.contains("manualOwner.courierCode"));
        assertFalse(sync.contains("manualOwner.displayCourierCode()"));
        assertFalse(sync.contains("saveProjectedOrderTimeline("));
        assertTrue(detail.contains("queryOwner.displayWaybill()"));
        assertTrue(detail.contains("queryOwner.projectedWaybill.isEmpty() ? queryOwner.courierCode : \"\""));
        assertTrue(detail.contains("queryOwner.isAccountOrder()"));
        assertFalse(detail.contains("saveProjectedOrderTimeline(\n"
                + "                                        success.result"));
        assertTrue(sync.contains("network.ManualQueryCoordinator"));
        assertTrue(detail.contains("repository.saveClaimedManualQueryBatch("));
        assertFalse(list.contains("ExpressDetailActivity.transientPickerPreviewIntent("));
        assertTrue(detail.contains("partial -> publishFirstManualPreview(partial, cancellation)"));
        assertTrue(detail.contains("R.string.loading_complete_logistics"));
        assertTrue(detail.contains("EXTRA_TRANSIENT_PICKER_PREVIEW"));
        // 用户定 2026-09-05（傍晚，取代上午「直接打开 picker 返回的 K100 H5」）：手动件详情先原生，
        // 优先级 picker 增量 → K100 H5 本地抓取 → K100 H5 网页兜底；查完自动进的那次也走这条链。
        assertTrue(detail.contains("ensureKuaidi100Presentation(previewResult, \"preview\")"));
        assertTrue(detail.contains("ensureKuaidi100Presentation(detail, \"after_manual_refresh\")"));
        assertFalse(detail.contains("else showKuaidi100WebDetail(kuaidi100Url);"));
        assertTrue(detail.contains(
                "String cainiaoUrl = transientPickerPreview ? \"\" : safeCainiaoUrl(item);"));
        assertTrue(sync.contains("saveClaimedManualQueryBatch("));
        assertTrue(sync.contains("saveClaimedManualQueryBatch("));
        assertTrue(sync.contains("savePendingManualQueryBatch("));
        assertTrue(detail.contains("saveClaimedManualQueryBatch("));
        assertFalse((list + sync + detail).contains(
                "for (ManualQueryCoordinator.Success"));
        assertFalse((list + sync + detail).contains("queryForBindingSource("));
    }

    @Test
    public void automaticH5DetailsUseTheInterface5CaptureBoundary()
            throws Exception {
        String list = compact(source("feature/express/ExpressListActivity.java"));
        String sync = source("background/ExpressSyncEngine.java");
        String detail = compact(source("feature/express/ExpressDetailActivity.java"));
        String coordinator = source("network/ManualQueryCoordinator.java");

        int pickerFirst = detail.indexOf("ManualQueryCoordinator.queryPickerFirst(");
        int picker = detail.indexOf("meizuApi.queryManual(", pickerFirst);
        int detect = detail.indexOf("manualApi.detect(", pickerFirst);
        int moto = detail.indexOf("manualApi.queryMoto(", detect);
        assertTrue(pickerFirst >= 0);
        assertTrue(picker > pickerFirst);
        assertTrue(detect > picker);
        assertTrue(moto > detect);
        assertTrue(detail.contains("ManualQueryRoutingPolicy.includesMoto(existing)"));
        assertFalse(detail.contains("showJingDongWebDetail("));
        assertTrue(detail.contains("ExpressAutomaticTimelineCapture.capture("));
        assertTrue(detail.contains("allowsJingDongCapture(owner)"));
        assertTrue(detail.contains("allowsPrimaryKuaidi100(queryOwner)"));
        assertFalse(detail.contains("startProjectedOrderTimelineRefresh"));
        assertFalse(detail.contains("projectedOrderTimelineCapture"));
        assertFalse(detail.contains("saveProjectedOrderTimeline("));
        assertTrue(detail.contains("ManualQueryRoutingPolicy.includesMoto(queryOwner)"));
        assertTrue(detail.contains("showKuaidi100WebDetail(route)"));
        assertFalse(detail.contains("manualApi.queryWithPhones("));
        assertFalse(sync.contains("queryWithPhones("));
        assertFalse(coordinator.substring(
                coordinator.indexOf("public static Batch queryActivatedAndroid("),
                coordinator.indexOf("private static QueryOutcome"))
                .contains("bindingSource"));
        assertFalse(sync.contains("saveProjectedOrderTimeline("));
    }

    private static String compact(String value) {
        return value.replaceAll("\\s+", " ").trim();
    }

    private static String source(String relative) throws Exception {
        Path path = Path.of("src/main/java/me/pipi/deliveries", relative);
        if (!Files.isRegularFile(path)) {
            path = Path.of("app/src/main/java/me/pipi/deliveries", relative);
        }
        return Files.readString(path, StandardCharsets.UTF_8);
    }
}
