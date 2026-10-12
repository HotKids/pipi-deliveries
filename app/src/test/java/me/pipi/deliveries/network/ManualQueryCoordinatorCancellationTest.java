package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.app.Application;

import java.util.List;
import java.util.stream.Collectors;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLog;

/**
 * 用户 2026-09-28：a provider query the coordinator started (the v6_query Online stage, a v4_query local
 * stage — background and pending refreshes) that is cut off mid-way still ends its stage, as a failure
 * with errorCategory=cancelled, before the cancellation propagates.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class)
public final class ManualQueryCoordinatorCancellationTest {
    @Before public void setUp() {
        ShadowLog.clear();
    }

    @After public void clearInterrupt() {
        Thread.interrupted();
    }

    @Test public void aCancelledOnlineQueryEndsItsStage() {
        try (ExpressLog.Scope ignored = ExpressLog.scope("refresh-test", "background", "v6")) {
            assertThrows(InterruptedException.class, () -> ManualQueryCoordinator.queryOnlineFirst(
                    () -> { throw new InterruptedException("Express query cancelled"); }, null, null, false));
        }
        Thread.interrupted();
        List<String> lines = lines();
        assertEquals(lines.toString(), 1, lines.stream().filter(line ->
                line.contains(" manual.source.started ") && line.contains(" level=v6_query ")).count());
        String ended = only(lines, " manual.source.failed ");
        assertTrue(ended, ended.contains(" WARNING manual.source.failed ") && ended.contains(" level=v6_query ")
                && ended.contains(" flowId=refresh-test ") && ended.endsWith(" errorCategory=cancelled"));
    }

    @Test public void aCancelledLocalQueryEndsItsStage() {
        try (ExpressLog.Scope ignored = ExpressLog.scope("pending-test", "background", "v6")) {
            assertThrows(InterruptedException.class, () -> ManualQueryCoordinator.queryOnlineFirst(
                    () -> null, null,
                    () -> { throw new InterruptedException("Express query cancelled"); }, true));
        }
        Thread.interrupted();
        List<String> lines = lines();
        String ended = lines.stream().filter(line -> line.contains(" manual.source.failed ")
                && line.contains(" level=v4_query ")).findFirst().orElseThrow(() -> new AssertionError(lines));
        assertTrue(ended, ended.contains(" flowId=pending-test ") && ended.endsWith(" errorCategory=cancelled"));
    }

    private static List<String> lines() {
        return ShadowLog.getLogsForTag(ExpressLog.TAG).stream().map(row -> row.msg).collect(Collectors.toList());
    }

    private static String only(List<String> lines, String marker) {
        List<String> found = lines.stream().filter(line -> line.contains(marker)).collect(Collectors.toList());
        assertEquals(lines.toString(), 1, found.size());
        return found.get(0);
    }
}
