package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressApi;

import org.junit.Test;

public final class ManualQueryCoordinatorTest {
    @Test
    public void realPrimaryTimelineDoesNotCallFallback() throws Exception {
        List<String> calls = new ArrayList<>();
        ExpressQueryResult primary = tracked("interface5", "首选来源轨迹");

        ExpressQueryResult result = ManualQueryCoordinator.query(
                () -> {
                    calls.add("source");
                    return primary;
                },
                () -> {
                    calls.add("k100");
                    return tracked("kuaidi100", "K100 轨迹");
                });

        assertSame(primary, result);
        assertEquals(Collections.singletonList("source"), calls);
    }

    @Test
    public void emptyPrimaryTimelineCallsK100Fallback() throws Exception {
        List<String> calls = new ArrayList<>();
        ExpressQueryResult fallback = tracked("kuaidi100", "K100 轨迹");

        ExpressQueryResult result = ManualQueryCoordinator.query(
                () -> {
                    calls.add("source");
                    return untracked("interface5");
                },
                () -> {
                    calls.add("k100");
                    return fallback;
                });

        assertSame(fallback, result);
        assertEquals(Arrays.asList("source", "k100"), calls);
        assertEquals("kuaidi100", result.timelineProvider);
    }

    @Test
    public void failedPrimaryRequestCallsK100Fallback() throws Exception {
        List<String> calls = new ArrayList<>();
        ExpressQueryResult fallback = tracked("kuaidi100", "K100 轨迹");

        ExpressQueryResult result = ManualQueryCoordinator.query(
                () -> {
                    calls.add("source");
                    throw new IllegalStateException("source unavailable");
                },
                () -> {
                    calls.add("k100");
                    return fallback;
                });

        assertSame(fallback, result);
        assertEquals(Arrays.asList("source", "k100"), calls);
    }

    @Test
    public void failedFallbackPreservesUncollectedPrimaryForQueueing() throws Exception {
        ExpressQueryResult primary = untracked("interface5");

        ExpressQueryResult result = ManualQueryCoordinator.query(
                () -> primary,
                () -> { throw new IllegalStateException("network unavailable"); });

        assertSame(primary, result);
    }

    @Test
    public void emptyFallbackDoesNotDiscardPrimaryRouteMetadata() throws Exception {
        ExpressQueryResult primary = new ExpressQueryResult(
                "TEST123456", "ZTO", "中通快递", StatusSemantic.UNKNOWN,
                "", "暂无轨迹", "[]", "pipi-route:v5", "", "interface5",
                "v5", "route-token");

        ExpressQueryResult result = ManualQueryCoordinator.query(
                () -> primary,
                () -> untracked("kuaidi100"));

        assertSame(primary, result);
    }

    @Test
    public void phoneTailRequirementFromFallbackIsNotHiddenByPrimaryMetadata() {
        try {
            ManualQueryCoordinator.query(
                    () -> untracked("interface5"),
                    () -> { throw ExpressApi.QueryException.phoneTailRequired(
                            "请输入手机尾号"); });
            org.junit.Assert.fail("Expected phone-tail requirement");
        } catch (ExpressApi.QueryException expected) {
            assertTrue(expected.needsPhoneTail());
        } catch (Exception unexpected) {
            throw new AssertionError(unexpected);
        }
    }

    @Test
    public void interruptionStopsWithoutCallingFallback() {
        final boolean[] fallbackCalled = {false};
        try {
            ManualQueryCoordinator.query(
                    () -> { throw new InterruptedException("cancelled"); },
                    () -> {
                        fallbackCalled[0] = true;
                        return tracked("kuaidi100", "K100 轨迹");
                    });
            org.junit.Assert.fail("Expected InterruptedException");
        } catch (InterruptedException expected) {
            assertTrue(Thread.currentThread().isInterrupted());
        } catch (Exception unexpected) {
            throw new AssertionError(unexpected);
        } finally {
            Thread.interrupted();
        }
        assertFalse(fallbackCalled[0]);
    }

    @Test(expected = AssertionError.class)
    public void fatalErrorIsNotConvertedIntoAnotherNetworkRequest() throws Exception {
        ManualQueryCoordinator.query(
                () -> { throw new AssertionError("fatal"); },
                () -> tracked("kuaidi100", "K100 轨迹"));
    }

    private static ExpressQueryResult tracked(String provider, String detail) {
        return new ExpressQueryResult(
                "TEST123456", "ZTO", "中通快递", StatusSemantic.TRANSIT,
                "2026-08-22 00:00:00", detail,
                "[{\"time\":\"2026-08-22 00:00:00\",\"context\":\"" + detail + "\"}]",
                "", "", provider);
    }

    private static ExpressQueryResult untracked(String provider) {
        return new ExpressQueryResult(
                "TEST123456", "ZTO", "中通快递", StatusSemantic.UNKNOWN,
                "", "暂无轨迹", "[]", "", "", provider);
    }
}
