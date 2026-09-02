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

        assertTrue(list.contains("ManualQueryCoordinator.queryPickerFirst("));
        assertTrue(sync.contains("ManualQueryCoordinator.queryPickerFirst("));
        assertTrue(detail.contains("ManualQueryCoordinator.queryPickerFirst("));
        assertFalse(list.contains("OppoManualTimelineClient"));
        assertFalse(sync.contains("OppoManualTimelineClient"));
        assertFalse(detail.contains("OppoManualTimelineClient"));
        assertTrue(list.contains("new ExpressSubscriptionClient()"));
        assertTrue(sync.contains("ExpressSubscriptionClient subscription ="
                + " new ExpressSubscriptionClient()"));
        assertTrue(detail.contains("new ExpressSubscriptionClient()"));
        assertTrue((list + sync + detail).contains("queryMoto("));
        assertTrue((list + sync + detail).contains("queryManual("));
        assertFalse((list + sync + detail).contains("queryWithPhones("));
        assertTrue(coordinator.contains("new ActivatedSource(\"local\", local, false)"));
        assertTrue(coordinator.contains("new ActivatedSource(\"route\", route, false)"));
        assertFalse(coordinator.contains("new ActivatedSource(\"fallback\""));
        assertTrue(coordinator.contains("Executors.newFixedThreadPool"));
        assertFalse(coordinator.contains("includeFallback"));
        assertTrue(sync.contains("manualOwner.displayWaybill()"));
        assertTrue(sync.contains("manualOwner.courierCode"));
        assertFalse(sync.contains("manualOwner.displayCourierCode()"));
        assertFalse(sync.contains("saveProjectedOrderTimeline("));
        assertTrue(detail.contains("requestItem.displayWaybill()"));
        assertTrue(detail.contains("? \"\" : requestItem.courierCode"));
        assertTrue(detail.contains("requestItem.isInterface5ProjectedOrder()"));
        assertFalse(detail.contains("saveProjectedOrderTimeline(\n"
                + "                                        success.result"));
        assertTrue(sync.contains("network.ManualQueryCoordinator"));
        assertTrue(list.contains("saveManualQueryBatch("));
        assertTrue(list.contains("ExpressDetailActivity.transientPickerPreviewIntent("));
        assertTrue(list.contains("pickerPreview -> runOnUiThread("));
        assertTrue(detail.contains("EXTRA_TRANSIENT_PICKER_PREVIEW"));
        assertTrue(detail.contains(
                "String kuaidi100Url = transientPickerPreview ? \"\" : kuaidi100FallbackUrl();"));
        assertTrue(sync.contains("saveOwnerManualQueryBatch("));
        assertTrue(sync.contains("saveManualQueryBatch("));
        assertTrue(sync.contains("savePendingManualQueryBatch("));
        assertTrue(detail.contains("saveOwnerManualQueryBatch("));
        assertFalse((list + sync + detail).contains(
                "for (ManualQueryCoordinator.Success"));
        assertFalse((list + sync + detail).contains("queryForBindingSource("));
    }

    @Test
    public void providerH5DetailsDoNotBecomeLocalTimelineCapture()
            throws Exception {
        String list = compact(source("feature/express/ExpressListActivity.java"));
        String sync = source("background/ExpressSyncEngine.java");
        String detail = compact(source("feature/express/ExpressDetailActivity.java"));
        String coordinator = source("network/ManualQueryCoordinator.java");

        int pickerFirst = list.indexOf("ManualQueryCoordinator.queryPickerFirst(");
        int picker = list.indexOf("meizuApi.queryManual(", pickerFirst);
        int detect = list.indexOf("manualApi.detect(", pickerFirst);
        int localSource = list.lastIndexOf("() -> {", detect);
        int moto = list.indexOf("manualApi.queryMoto(", detect);
        int includesMoto = list.indexOf(
                "ManualQueryRoutingPolicy.includesMoto(existing)", moto);
        assertTrue(pickerFirst >= 0);
        assertTrue(picker > pickerFirst);
        assertTrue(localSource > picker);
        assertFalse(list.substring(pickerFirst, localSource).contains("manualApi.detect("));
        assertTrue(detect > localSource);
        assertTrue(moto > detect);
        assertTrue(includesMoto > moto);
        assertTrue(detail.contains("showJingDongWebDetail(jingDongUrl);"));
        assertFalse(detail.contains("startProjectedOrderTimelineRefresh"));
        assertFalse(detail.contains("projectedOrderTimelineCapture"));
        assertFalse(detail.contains("saveProjectedOrderTimeline("));
        assertTrue(detail.contains("ManualQueryRoutingPolicy.includesMoto(requestItem)"));
        assertTrue(detail.contains("showKuaidi100WebDetail(kuaidi100Url)"));
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
