package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.Test;

public final class ManualTimelineIntegrationContractTest {
    @Test public void entryPointsUseTheSharedCoordinatorAndPersistOneFinalBatch() throws Exception {
        String list=source("feature/express/ExpressListActivity.java");
        String sync=source("background/ExpressSyncEngine.java");
        String detail=source("feature/express/ExpressDetailActivity.java");
        assertTrue(list.contains("ExpressDetailActivity.manualQueryIntent("));
        assertFalse(list.contains("ManualQueryCoordinator.queryOnlineFirst("));
        assertTrue(sync.contains("ManualQueryCoordinator.queryOnlineFirst("));
        assertTrue(detail.contains("ManualQueryCoordinator.queryOnlineFirst("));
        assertFalse((list+sync+detail).contains("queryMoto("));
        assertFalse((list+sync+detail).contains("queryWithPhones("));
        assertTrue(sync.contains("saveClaimedManualQueryBatch("));
        assertTrue(sync.contains("savePendingManualQueryBatch("));
        assertTrue(detail.contains("repository.saveClaimedManualQueryBatch("));
        assertTrue(detail.contains("partial -> publishFirstManualPreview(partial, cancellation)"));
        assertFalse(detail.contains("ensureKuaidi100Presentation("));
    }

    @Test public void automaticH5UsesNativeCaptureWhileDetailPullReusesOnlineObservation() throws Exception {
        String detail=source("feature/express/ExpressDetailActivity.java");
        assertTrue(detail.contains("ExpressAutomaticTimelineCapture.capture("));
        assertTrue(detail.contains("allowsJingDongCapture(owner)"));
        assertTrue(detail.contains("allowsPrimaryKuaidi100(queryOwner)"));
        assertTrue(detail.contains("repository.manualTimelineCandidate(queryOwner, TimelineSlot.V6_QUERY)"));
        String refresh=detail.substring(detail.indexOf("private void refreshLocalTimelineInBackground"),
                detail.indexOf("private void renderRefreshedDetail"));
        assertFalse(refresh.contains("queryManual("));
        assertTrue(detail.contains("if (!detailPull && usesInterface5Automatic(expected)"));
        assertFalse(detail.contains("showKuaidi100WebDetail("));
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
