package me.pipi.deliveries.model;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.fail;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;

public final class ExpressTimelineReadScopeTest {
    private static final String TRACKS = "[{\"time\":\"2026-09-06 00:19:45\","
            + "\"context\":\"运输中\",\"statusCode\":102}]";

    @Test
    public void repeatedProjectionUsesImmutableNodesWithinOneRead() {
        ExpressTimeline.withParsedTracks(() -> {
            List<ExpressTimeline.Track> first = parse(TRACKS);
            assertSame(first, parse(new String(TRACKS)));
            try {
                first.clear();
                fail("Parsed nodes must remain immutable");
            } catch (UnsupportedOperationException expected) {
                assertEquals(1, first.size());
            }
            return null;
        });
    }

    @Test
    public void subsequentReadsAndUnscopedCallsParseAgain() {
        List<ExpressTimeline.Track> first = ExpressTimeline.withParsedTracks(() -> parse(TRACKS));
        List<ExpressTimeline.Track> next = ExpressTimeline.withParsedTracks(() -> parse(TRACKS));
        assertNotSame(first, next);
        assertNotSame(next, parse(TRACKS));
        assertNotSame(parse(TRACKS), parse(TRACKS));
    }

    @Test
    public void eachOriginalArgumentRemainsPartOfTheIdentity() {
        ExpressTimeline.withParsedTracks(() -> {
            List<ExpressTimeline.Track> base = ExpressTimeline.parse(TRACKS, "", "", "");
            assertNotSame(base, ExpressTimeline.parse(TRACKS, null, "", ""));
            assertNotSame(base, ExpressTimeline.parse(TRACKS, "", null, ""));
            assertNotSame(base, ExpressTimeline.parse(TRACKS, "", "", null));
            assertNotSame(base, ExpressTimeline.parse(TRACKS, "", "", "v5_query"));
            assertNotSame(base, ExpressTimeline.parse(TRACKS, "", "", "kdniao"));
            assertNotSame(base, ExpressTimeline.parse("[]", "", "", ""));
            assertSame(base, ExpressTimeline.parse(TRACKS, "", "", ""));
            return null;
        });
    }

    @Test
    public void fallbackTimeAndDetailStayIndependent() {
        ExpressTimeline.withParsedTracks(() -> {
            List<ExpressTimeline.Track> first = ExpressTimeline.parse("[]", "2026-09-06 00:19:45", "运输中");
            List<ExpressTimeline.Track> nextTime = ExpressTimeline.parse("[]", "2026-09-06 00:20:45", "运输中");
            List<ExpressTimeline.Track> nextDetail = ExpressTimeline.parse("[]", "2026-09-06 00:19:45", "已揽收");
            assertEquals("2026-09-06 00:20:45", nextTime.get(0).time);
            assertEquals("已揽收", nextDetail.get(0).detail);
            assertNotSame(first, nextTime);
            assertNotSame(first, nextDetail);
            return null;
        });
    }

    @Test
    public void nestedReadsRestoreTheOuterRead() {
        ExpressTimeline.withParsedTracks(() -> {
            List<ExpressTimeline.Track> outer = parse(TRACKS);
            List<ExpressTimeline.Track> inner = ExpressTimeline.withParsedTracks(() -> parse(TRACKS));
            assertNotSame(outer, inner);
            assertSame(outer, parse(TRACKS));
            return null;
        });
    }

    @Test
    public void failedOperationDoesNotLeaveAReadBehind() {
        AtomicReference<List<ExpressTimeline.Track>> observed = new AtomicReference<>();
        try {
            ExpressTimeline.withParsedTracks(() -> {
                observed.set(parse(TRACKS));
                throw new IllegalStateException("Synthetic read failure");
            });
            fail("The read failure must propagate");
        } catch (IllegalStateException expected) {
            assertEquals("Synthetic read failure", expected.getMessage());
        }
        assertNotSame(observed.get(), parse(TRACKS));
    }

    @Test
    public void malformedRootKeepsEveryRecoveryAttempt() {
        ExpressTimeline.withParsedTracks(() -> {
            List<ExpressTimeline.Track> before = parse(TRACKS);
            List<ExpressTimeline.Track> first = ExpressTimeline.parse("{", "2026-09-06 00:19:45", "运输中");
            List<ExpressTimeline.Track> next = ExpressTimeline.parse("{", "2026-09-06 00:19:45", "运输中");
            assertEquals(1, first.size());
            assertEquals("运输中", next.get(0).detail);
            assertNotSame(first, next);
            assertNotSame(before, parse(TRACKS));
            return null;
        });
    }

    @Test
    public void nestedDecodeRecoveryDoesNotRetainItsRecoveredResult() {
        String envelope = "{\"data\":\"{\",\"traces\":" + TRACKS + "}";
        ExpressTimeline.withParsedTracks(() -> {
            List<ExpressTimeline.Track> before = parse(TRACKS);
            List<ExpressTimeline.Track> first = parse(envelope);
            List<ExpressTimeline.Track> next = parse(envelope);
            assertEquals(1, first.size());
            assertEquals("运输中", next.get(0).detail);
            assertNotSame(first, next);
            assertNotSame(before, parse(TRACKS));
            return null;
        });
    }

    @Test
    public void concurrentReadersNeverShareTheScope() throws Exception {
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            ExpressTimeline.withParsedTracks(() -> {
                List<ExpressTimeline.Track> local = parse(TRACKS);
                try {
                    List<ExpressTimeline.Track> remote = worker.submit(
                            () -> ExpressTimeline.withParsedTracks(() -> parse(TRACKS)))
                            .get(30, TimeUnit.SECONDS);
                    assertNotSame(local, remote);
                    assertSame(local, parse(TRACKS));
                } catch (Exception failure) {
                    throw new AssertionError(failure);
                }
                return null;
            });
        } finally {
            worker.shutdownNow();
        }
    }

    private static List<ExpressTimeline.Track> parse(String tracks) {
        return ExpressTimeline.parse(tracks, "", "");
    }
}
