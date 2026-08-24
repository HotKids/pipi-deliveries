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

        assertTrue(list.contains("ManualQueryCoordinator.queryForBindingSource("));
        assertTrue(sync.contains("ManualQueryCoordinator.queryKuaidi100First("));
        assertTrue(detail.contains("ManualQueryCoordinator.queryForBindingSource("));
        assertFalse(list.contains("ManualQueryCoordinator.queryRequiringTimedTracking("));
        assertFalse(sync.contains("ManualQueryCoordinator.queryRequiringTimedTracking("));
        assertFalse(detail.contains("ManualQueryCoordinator.queryRequiringTimedTracking("));
        assertTrue(sync.contains("network.ManualQueryCoordinator"));
        assertTrue(sync.contains("saveOwnerManualTimeline("));
        assertTrue(detail.contains("saveOwnerManualTimeline("));
        assertTrue(detail.contains(
                "Kuaidi100TimelinePolicy.hasTimedTracking(previewResult)"));
        assertTrue(sync.contains(
                "Kuaidi100TimelinePolicy.hasTimedTracking(refreshed)"));
        assertFalse(sync.contains("ShunFengManualClient"));
        assertFalse(detail.contains("ShunFengManualClient"));
    }

    private static String source(String relative) throws Exception {
        Path path = Path.of("src/main/java/me/pipi/deliveries", relative);
        if (!Files.isRegularFile(path)) {
            path = Path.of("app/src/main/java/me/pipi/deliveries", relative);
        }
        return Files.readString(path, StandardCharsets.UTF_8);
    }
}
