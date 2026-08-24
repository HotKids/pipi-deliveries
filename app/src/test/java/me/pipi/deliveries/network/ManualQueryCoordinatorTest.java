package me.pipi.deliveries.network;

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
    public void ordinaryManualQueryKeepsAcceptingAnUntimedRealNode() throws Exception {
        List<String> calls = new ArrayList<>();
        ExpressQueryResult untimed = new ExpressQueryResult(
                "TEST123456", "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "", "快件已揽收", "[{\"context\":\"快件已揽收\"}]",
                "", "", "interface5");

        ExpressQueryResult result = ManualQueryCoordinator.query(
                () -> {
                    calls.add("source");
                    return untimed;
                },
                () -> {
                    calls.add("k100");
                    return tracked("kuaidi100", "K100 轨迹");
                });

        assertSame(untimed, result);
        assertEquals(Collections.singletonList("source"), calls);
    }

    @Test
    public void timedStateLabelIsAcceptedWithoutCallingAnotherProvider() throws Exception {
        List<String> calls = new ArrayList<>();
        ExpressQueryResult completed = new ExpressQueryResult(
                "SFTEST501", "SF", "顺丰速运", StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "已签收",
                "[{\"time\":\"2026-08-24 12:00:00\","
                        + "\"context\":\"已签收\",\"statusCode\":\"501\"}]",
                "", "", "kuaidi100");

        ExpressQueryResult result = ManualQueryCoordinator.query(
                () -> {
                    calls.add("source");
                    return completed;
                },
                () -> {
                    calls.add("fallback");
                    return tracked("interface5", "另一来源轨迹");
                });

        assertSame(completed, result);
        assertEquals(Collections.singletonList("source"), calls);
    }

    @Test
    public void kuaidi100FirstKeepsCompletedTimedPackageWithoutCallingAccountSource()
            throws Exception {
        List<String> calls = new ArrayList<>();
        ExpressQueryResult completed = new ExpressQueryResult(
                "SFTEST501", "SF", "顺丰速运", StatusSemantic.COMPLETED,
                1_777_171_200_000L,
                "2026-04-28 12:00:00", "快件已到合作点",
                "[{\"time\":\"2026-04-28 12:00:00\","
                        + "\"context\":\"快件已到合作点\",\"statusCode\":\"501\","
                        + "\"_pipiStatusSource\":\"kuaidi100\"}]",
                "", "", "kuaidi100", "", "", "");

        ExpressQueryResult result = ManualQueryCoordinator.queryKuaidi100First(
                () -> {
                    calls.add("k100");
                    return completed;
                },
                () -> {
                    calls.add("account");
                    return tracked("interface5", "接口来源仍为待取件");
                });

        assertSame(completed, result);
        assertEquals(StatusSemantic.COMPLETED, result.semantic);
        assertEquals(Collections.singletonList("k100"), calls);
    }

    @Test
    public void kuaidi100FirstConsultsAccountSourceOnlyWithoutUsableTimedTracking()
            throws Exception {
        List<String> calls = new ArrayList<>();
        ExpressQueryResult account = tracked("interface5", "接口来源轨迹");

        ExpressQueryResult result = ManualQueryCoordinator.queryKuaidi100First(
                () -> {
                    calls.add("k100");
                    return untracked("kuaidi100");
                },
                () -> {
                    calls.add("account");
                    return account;
                });

        assertSame(account, result);
        assertEquals(Arrays.asList("k100", "account"), calls);
    }

    @Test
    public void bindingSourceSelectsOnlyItsOwnAccountInterfaceBeforeK100() throws Exception {
        List<String> calls = new ArrayList<>();
        ExpressQueryResult interface6 = tracked("interface6", "接口 6 轨迹");

        ExpressQueryResult result = ManualQueryCoordinator.queryForBindingSource(
                "interface6", false,
                () -> {
                    calls.add("interface5");
                    return tracked("interface5", "错误接口轨迹");
                },
                () -> {
                    calls.add("interface6");
                    return interface6;
                },
                () -> {
                    calls.add("k100");
                    return tracked("kuaidi100", "K100 轨迹");
                });

        assertSame(interface6, result);
        assertEquals(Collections.singletonList("interface6"), calls);
    }

    @Test
    public void bindingSourceK100FirstFallsBackOnlyToItsOwnAccountInterface()
            throws Exception {
        List<String> calls = new ArrayList<>();
        ExpressQueryResult interface5 = tracked("interface5", "接口 5 轨迹");

        ExpressQueryResult result = ManualQueryCoordinator.queryForBindingSource(
                "interface5", true,
                () -> {
                    calls.add("interface5");
                    return interface5;
                },
                () -> {
                    calls.add("interface6");
                    return tracked("interface6", "错误接口轨迹");
                },
                () -> {
                    calls.add("k100");
                    return untracked("kuaidi100");
                });

        assertSame(interface5, result);
        assertEquals(Arrays.asList("k100", "interface5"), calls);
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
