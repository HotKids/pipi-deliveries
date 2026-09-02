package me.pipi.deliveries.background;

import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public final class ExpressSyncWorkerContractTest {
    @Test
    public void completedSyncReconcilesEveryExistingWidgetBeforeAnnouncingCompletion()
            throws Exception {
        String source = Files.readString(sourcePath(
                "app/src/main/java/me/pipi/deliveries/background/ExpressSyncWorker.java",
                "src/main/java/me/pipi/deliveries/background/ExpressSyncWorker.java"),
                StandardCharsets.UTF_8);

        int refresh = source.indexOf("ExpressWidgetProvider.refreshAll(context);");
        int finished = source.indexOf("ExpressRepository.ACTION_SYNC_FINISHED");
        assertTrue("The sync completion boundary must reconcile home-screen widgets", refresh >= 0);
        assertTrue("Widgets must be reconciled before the list completion broadcast",
                finished >= 0 && refresh < finished);
    }

    @Test
    public void widgetReconciliationEnumeratesBothProviderClassesAndAllIds()
            throws Exception {
        String source = Files.readString(sourcePath(
                "app/src/main/java/me/pipi/deliveries/widget/ExpressWidgetProvider.java",
                "src/main/java/me/pipi/deliveries/widget/ExpressWidgetProvider.java"),
                StandardCharsets.UTF_8);

        assertTrue(source.contains(
                "new ComponentName(context, Express2x2WidgetProvider.class)"));
        assertTrue(source.contains(
                "new ComponentName(context, Express4x2WidgetProvider.class)"));
        assertTrue(source.contains("updateCompact(context, manager, compactIds, items)"));
        assertTrue(source.contains("updateWide(context, manager, wideIds, items)"));
    }

    private static Path sourcePath(String projectPath, String modulePath) {
        Path path = Path.of(projectPath);
        return Files.isRegularFile(path) ? path : Path.of(modulePath);
    }
}
