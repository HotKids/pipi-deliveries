package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.util.Log;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLog;

/**
 * Audit R10 (user 2026-09-25): Lite had WARNING but no ERROR. The events iOS and Pipi log at ERROR
 * — a failed refresh round, the account list failing, a failed manual query — reach logcat at ERROR.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class)
public final class ExpressLogErrorLevelTest {
    @Test public void anErrorEventIsLoggedAtErrorLevel() {
        ShadowLog.clear();
        ExpressLog.error("manual.query.failed", "stage", "pending_manual", "errorCategory", "IllegalStateException");
        List<ShadowLog.LogItem> rows = ShadowLog.getLogsForTag(ExpressLog.TAG);
        assertEquals(1, rows.size());
        assertEquals(Log.ERROR, rows.get(0).type);
        assertTrue(rows.get(0).msg, rows.get(0).msg.contains(" ERROR manual.query.failed "));
        ShadowLog.clear();
        ExpressLog.write("refresh.stage.failed", "stage", "enrichment");
        assertEquals("a stage failure stays WARNING", Log.WARN,
                ShadowLog.getLogsForTag(ExpressLog.TAG).get(0).type);
    }

    /** The three sync failures iOS / Pipi log at ERROR are written with ExpressLog.error. */
    @Test public void theSyncFailuresUseTheErrorLevel() throws Exception {
        Path path = Path.of("app/src/main/java/me/pipi/deliveries/background/ExpressSyncEngine.java");
        if (!Files.isRegularFile(path)) {
            path = Path.of("src/main/java/me/pipi/deliveries/background/ExpressSyncEngine.java");
        }
        String source = Files.readString(path, StandardCharsets.UTF_8);
        for (String event : new String[]{"refresh.failed", "refresh.account.failed", "manual.query.failed"}) {
            assertTrue(event, source.contains("ExpressLog.error(\"" + event + "\""));
            assertTrue(event, !source.contains("ExpressLog.write(\"" + event + "\""));
        }
    }
}
