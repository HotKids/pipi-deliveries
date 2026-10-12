package me.pipi.deliveries.background;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * Audit R4 (user default of 2026-09-25): 回前台刷新 + 去抖（2 分钟，用户 2026-10-02；原 30 秒） on every client. Home's onStart runs on
 * each return (a return from a detail page included); within the window of the last foreground refresh it
 * enqueues nothing, and a cold start (a fresh process) always refreshes.
 */
public final class ForegroundRefreshDebounceTest {
    @Before public void setUp() { ExpressScheduler.resetForegroundRefreshForTesting(); }
    @After public void tearDown() { ExpressScheduler.resetForegroundRefreshForTesting(); }

    @Test public void aReturnWithinTheDebounceWindowDoesNotRefreshAgain() {
        long start = 5_000_000L;
        assertTrue("the first foreground start refreshes", ExpressScheduler.claimForegroundRefresh(start));
        assertFalse(ExpressScheduler.claimForegroundRefresh(start + 1L));
        assertFalse(ExpressScheduler.claimForegroundRefresh(
                start + ExpressScheduler.FOREGROUND_REFRESH_DEBOUNCE_MS - 1L));
        assertTrue(ExpressScheduler.claimForegroundRefresh(
                start + ExpressScheduler.FOREGROUND_REFRESH_DEBOUNCE_MS));
        assertFalse(ExpressScheduler.claimForegroundRefresh(
                start + ExpressScheduler.FOREGROUND_REFRESH_DEBOUNCE_MS + 10_000L));
    }

    @Test public void aClockThatWentBackwardsDoesNotBlockTheRefresh() {
        assertTrue(ExpressScheduler.claimForegroundRefresh(9_000_000L));
        assertTrue(ExpressScheduler.claimForegroundRefresh(8_000_000L));
    }

    /**
     * 优化 8-1（用户 2026-10-03「Lite 照 Pipi：启动刷过就不再刷」）：the process started for a sync round (a periodic or widget
     * round); the first return to Home right after it does not refresh again, and, as Pipi's first resume does, it starts
     * the two-minute window.
     */
    @Test public void theFirstReturnRightAfterTheProcessStartRoundDoesNotRefreshAgain() {
        long started = 5_000_000L;
        ExpressScheduler.recordRoundStarted(started);
        long firstReturn = started + 30_000L;
        assertFalse("the start round already refreshed", ExpressScheduler.claimForegroundRefresh(firstReturn));
        assertFalse(ExpressScheduler.claimForegroundRefresh(
                firstReturn + ExpressScheduler.FOREGROUND_REFRESH_DEBOUNCE_MS - 1L));
        assertTrue("the window runs from that first return", ExpressScheduler.claimForegroundRefresh(
                firstReturn + ExpressScheduler.FOREGROUND_REFRESH_DEBOUNCE_MS));
    }

    /** 优化 8-1：a start round older than the window, or none at all (a launch from the launcher), refreshes as before. */
    @Test public void aStaleOrMissingStartRoundStillRefreshes() {
        long started = 5_000_000L;
        ExpressScheduler.recordRoundStarted(started);
        assertTrue(ExpressScheduler.claimForegroundRefresh(started + ExpressScheduler.FOREGROUND_REFRESH_DEBOUNCE_MS));

        ExpressScheduler.resetForegroundRefreshForTesting();
        assertTrue("a cold start from the launcher has no earlier round", ExpressScheduler.claimForegroundRefresh(started));
    }

    /** 优化 8-1：only the process's first round counts, and only for the first return; later rounds change nothing. */
    @Test public void onlyTheFirstRoundAndTheFirstReturnAreAffected() {
        long launch = 5_000_000L;
        assertTrue(ExpressScheduler.claimForegroundRefresh(launch));
        ExpressScheduler.recordRoundStarted(launch + 1_000L);
        long later = launch + ExpressScheduler.FOREGROUND_REFRESH_DEBOUNCE_MS + 1L;
        ExpressScheduler.recordRoundStarted(later - 1_000L);
        assertTrue("an ordinary return after the window refreshes", ExpressScheduler.claimForegroundRefresh(later));
    }
}
