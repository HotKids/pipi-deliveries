package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.Test;

/**
 * Audit R5 (user 2026-09-25, as on iOS): a Home order projection that saves commits only its own
 * row. It used to enqueue another full sync each time (ExpressScheduler.requestNow, REPLACE), which
 * replaced a running immediate sync — the user's pull included — and could drop a pull not yet
 * started. Home keeps only the foreground refresh and the explicit pull.
 */
public final class HomeProjectionSyncGuardTest {
    @Test
    public void homeNeverEnqueuesAFullSyncAfterAProjection() throws Exception {
        String relative = "me/pipi/deliveries/feature/express/ExpressListActivity.java";
        Path file = Path.of("src/main/java").resolve(relative);
        if (!Files.isRegularFile(file)) file = Path.of("app/src/main/java").resolve(relative);
        String home = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
        assertFalse(home.contains("ExpressScheduler.requestNow("));
        assertTrue(home.contains("ExpressScheduler.requestPullRefresh(this)"));
        assertTrue(home.contains("ExpressScheduler.requestForeground(this)"));
    }
}
