package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import me.pipi.deliveries.data.ManualTimelineAuthorityPolicy;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ManualQueryCoordinatorTest {
    @Test
    public void enabledLocalCapabilitiesRunConcurrently() throws Exception {
        CountDownLatch started = new CountDownLatch(2);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger concurrent = new AtomicInteger();
        AtomicInteger maximum = new AtomicInteger();

        ManualQueryCoordinator.Batch batch = ManualQueryCoordinator.queryActivatedAndroid(
                () -> concurrentResult("local", started, release, concurrent, maximum), true,
                () -> concurrentResult("route", started, release, concurrent, maximum), true,
                () -> 100L);

        assertEquals(2, batch.successes.size());
        assertEquals(2, maximum.get());
    }

    @Test
    public void disabledCapabilityIsNeverQueried() throws Exception {
        List<String> calls = Collections.synchronizedList(new ArrayList<>());

        ManualQueryCoordinator.Batch batch = ManualQueryCoordinator.queryActivatedAndroid(
                () -> {
                    calls.add("local");
                    return tracked("local", "local");
                }, false,
                () -> {
                    calls.add("route");
                    return tracked("route", "route");
                }, true,
                () -> 200L);

        assertEquals(Collections.singletonList("route"), calls);
        assertEquals(1, batch.successes.size());
    }

    @Test
    public void oneFailureDoesNotDiscardTheOtherTimedResult() throws Exception {
        ManualQueryCoordinator.Batch batch = ManualQueryCoordinator.queryActivatedAndroid(
                () -> { throw new IllegalStateException("local unavailable"); }, true,
                () -> tracked("route", "route"), true,
                () -> 300L);

        assertEquals(1, batch.successes.size());
        assertEquals("route", batch.selected().latestDetail);
    }

    @Test
    public void untimedResultRemainsAvailableAsBestEffort() throws Exception {
        ExpressQueryResult untimed = untracked("route");
        ManualQueryCoordinator.Batch batch = ManualQueryCoordinator.queryActivatedAndroid(
                () -> { throw new IllegalStateException("local unavailable"); }, true,
                () -> untimed, true,
                () -> 400L);

        assertTrue(batch.successes.isEmpty());
        assertEquals(untimed, batch.selected());
    }

    @Test
    public void bothFailuresSurfaceAFailureWithoutAnyFallbackCall() {
        try {
            ManualQueryCoordinator.queryActivatedAndroid(
                    () -> { throw new IllegalStateException("local unavailable"); }, true,
                    () -> { throw new IllegalArgumentException("route unavailable"); }, true);
            org.junit.Assert.fail("Expected a source failure");
        } catch (Exception expected) {
            assertTrue(expected.getMessage().contains("unavailable"));
        }
    }

    @Test
    public void pickerStartStopsBeforeStartingThePrimaryRound() throws Exception {
        List<String> calls = Collections.synchronizedList(new ArrayList<>());
        ExpressQueryResult picker = new ExpressQueryResult(
                "TEST123456", "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "2026-08-22 12:00:00", "运输中",
                "[{\"time\":\"2026-08-22 12:00:00\",\"context\":\"运输中\"},"
                        + "{\"time\":\"2026-08-22 10:00:00\",\"context\":\"快件已揽收\"}]",
                "", "", "meizu");

        ManualQueryCoordinator.Batch batch = ManualQueryCoordinator.queryPickerFirst(
                () -> {
                    calls.add("meizu");
                    return picker;
                }, null,
                () -> {
                    calls.add("v4");
                    return tracked("v4", "v4");
                }, true, () -> 500L);

        assertEquals(Collections.singletonList("meizu"), calls);
        assertEquals("meizu", batch.selected().timelineProvider);
    }

    @Test
    public void physicalSfOwnerNeverEntersMotoOrReplacesThePickerFailure() {
        AtomicInteger motoCalls = new AtomicInteger();
        ExpressItem owner = automaticOwner("CaiNiao", "SF", "顺丰速运");

        try {
            ManualQueryCoordinator.queryPickerFirst(
                    () -> { throw new IllegalStateException("picker unavailable"); },
                    null,
                    () -> {
                        motoCalls.incrementAndGet();
                        throw new IllegalArgumentException("moto must stay disabled");
                    },
                    ManualQueryRoutingPolicy.includesMoto(owner),
                    () -> 550L);
            org.junit.Assert.fail("Expected the Picker failure");
        } catch (Exception expected) {
            assertEquals("picker unavailable", expected.getMessage());
        }
        assertEquals(0, motoCalls.get());
    }

    @Test
    public void pickerWithoutStartRunsLocalButKeepsEquivalentDetail() throws Exception {
        ExpressQueryResult picker = tracked("meizu", "Picker 运输中");
        ExpressQueryResult local = tracked("v4", "本地完整轨迹");

        ManualQueryCoordinator.Batch batch = ManualQueryCoordinator.queryPickerFirst(
                () -> picker, null, () -> local, true, () -> 600L);

        assertEquals("meizu", batch.selected().timelineProvider);
        assertEquals("meizu", batch.detailSelected().timelineProvider);
    }

    @Test
    public void pickerKuaidi100RouteIsDurableInputButNotATimelineCandidate() throws Exception {
        String route = "https://m.kuaidi100.com/result.jsp?nu=TEST123456";
        ExpressQueryResult picker = new ExpressQueryResult(
                "TEST123456", "ZTO", "中通快递", StatusSemantic.UNKNOWN,
                "", "", "[]", route, "", "meizu");

        ManualQueryCoordinator.Batch batch = ManualQueryCoordinator.queryPickerFirst(
                () -> picker, null, () -> null, false, () -> 700L);

        assertEquals(1, batch.successes.size());
        assertEquals("meizu", batch.successes.get(0).provider);
        assertTrue(batch.selectionSuccessesForTesting().isEmpty());
        assertEquals(picker, batch.detailSelected());
    }

    @Test
    public void timedPickerPreviewRunsBeforeTheLocalStageAndUsesMergedPickerCache()
            throws Exception {
        List<String> calls = Collections.synchronizedList(new ArrayList<>());
        List<ExpressQueryResult> previews = new ArrayList<>();
        ExpressQueryResult cachedResult = trackedAt(
                "meizu", "旧轨迹", "2026-08-21 00:00:00");
        ManualTimelineAuthorityPolicy.Candidate cached =
                new ManualTimelineAuthorityPolicy.Candidate(
                        "meizu", cachedResult, 100L, false);

        ManualQueryCoordinator.queryPickerFirst(
                () -> {
                    calls.add("meizu");
                    return trackedAt("meizu", "新轨迹", "2026-08-22 00:00:00");
                }, cached,
                () -> {
                    calls.add("v4");
                    return tracked("v4", "本地完整轨迹");
                }, true,
                result -> {
                    calls.add("preview");
                    previews.add(result);
                }, () -> 800L);

        assertEquals(List.of("meizu", "preview", "v4"), calls);
        assertEquals(1, previews.size());
        assertTrue(previews.get(0).tracksJson.contains("新轨迹"));
        assertTrue(previews.get(0).tracksJson.contains("旧轨迹"));
    }

    @Test
    public void cachedPickerStartStillRefreshesPickerThenStopsThePrimaryRound() throws Exception {
        List<String> calls = Collections.synchronizedList(new ArrayList<>());
        ManualTimelineAuthorityPolicy.Candidate cached = new ManualTimelineAuthorityPolicy.Candidate(
                "meizu", trackedAt("meizu", "订单已提交", "2026-08-21 00:00:00"), 100L, false);
        ManualQueryCoordinator.Batch batch = ManualQueryCoordinator.queryPickerFirst(
                () -> { calls.add("picker"); return tracked("meizu", "运输中"); }, cached,
                () -> { calls.add("local"); return tracked("v4", "运输中"); }, true);
        assertEquals(Collections.singletonList("picker"), calls);
        assertTrue(batch.selected().tracksJson.contains("订单已提交"));
        assertTrue(batch.selected().tracksJson.contains("运输中"));
    }

    @Test
    public void interruptingPickerCannotLeaveAPrimaryProviderRunning() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread coordinator = new Thread(() -> {
            try {
                ManualQueryCoordinator.queryPickerFirst(
                        () -> { throw new InterruptedException("cancelled"); }, null,
                        () -> { calls.incrementAndGet(); return tracked("v4", "运输中"); }, true);
                org.junit.Assert.fail("Picker interruption must propagate");
            } catch (InterruptedException expected) {
                if (!Thread.currentThread().isInterrupted()) {
                    failure.set(new AssertionError("The interrupt flag must remain set"));
                }
            } catch (Throwable unexpected) {
                failure.set(unexpected);
            }
        });
        coordinator.start();
        coordinator.join(1000L);
        assertTrue(!coordinator.isAlive());
        org.junit.Assert.assertNull(failure.get());
        assertEquals(0, calls.get());
    }

    @Test
    public void eligiblePrimarySourcesRunConcurrentlyAfterPickerPreview() throws Exception {
        ExpressQueryResult picker = tracked("meizu", "运输中");
        CountDownLatch started = new CountDownLatch(2);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger concurrent = new AtomicInteger();
        AtomicInteger maximum = new AtomicInteger();
        List<String> calls = new ArrayList<>();
        ManualQueryCoordinator.Batch batch = ManualQueryCoordinator.queryPickerFirst(
                () -> { calls.add("picker"); return picker; }, null,
                () -> concurrentResult("v4", started, release, concurrent, maximum), true,
                fresh -> {
                    org.junit.Assert.assertSame(picker, fresh);
                    calls.add("primary");
                    return () -> concurrentResult("kuaidi100", started, release, concurrent, maximum);
                }, preview -> calls.add("preview"));
        assertEquals(List.of("picker", "preview", "primary"), calls);
        assertEquals(2, maximum.get());
        assertEquals(3, batch.successes.size());
        for (ManualQueryCoordinator.Success success : batch.successes) {
            org.junit.Assert.assertFalse(success.complete);
        }
    }

    @Test
    public void pickerStartDoesNotCreateTheKuaidi100PrimarySource() throws Exception {
        AtomicInteger creations = new AtomicInteger();
        ManualQueryCoordinator.queryPickerFirst(
                () -> tracked("meizu", "订单已提交"), null, null, false,
                fresh -> { creations.incrementAndGet(); return () -> tracked("kuaidi100", "运输中"); },
                null);
        assertEquals(0, creations.get());
    }

    @Test
    public void interruptingPrimaryRoundInterruptsEveryActualProviderTask() throws Exception {
        CountDownLatch started = new CountDownLatch(2);
        CountDownLatch cancelled = new CountDownLatch(2);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        ManualQueryCoordinator.Source blocking = () -> {
            started.countDown();
            try {
                new CountDownLatch(1).await();
                throw new AssertionError("The source must be interrupted");
            } catch (InterruptedException expected) {
                cancelled.countDown();
                throw expected;
            }
        };
        Thread coordinator = new Thread(() -> {
            try {
                ManualQueryCoordinator.queryPickerFirst(
                        () -> tracked("meizu", "运输中"), null, blocking, true,
                        fresh -> blocking, null);
                throw new AssertionError("Coordinator interruption must propagate");
            } catch (InterruptedException expected) {
                if (!Thread.currentThread().isInterrupted()) {
                    failure.set(new AssertionError("The interrupt flag must remain set"));
                }
            } catch (Throwable unexpected) {
                failure.set(unexpected);
            }
        });
        coordinator.start();
        try {
            assertTrue(started.await(2, TimeUnit.SECONDS));
        } finally {
            coordinator.interrupt();
            coordinator.join(2000L);
        }
        assertTrue(cancelled.await(2, TimeUnit.SECONDS));
        assertTrue(!coordinator.isAlive());
        org.junit.Assert.assertNull(failure.get());
    }

    @Test
    public void routeOnlyPickerDoesNotOpenATransientPreview() throws Exception {
        List<ExpressQueryResult> previews = new ArrayList<>();
        ExpressQueryResult routeOnly = new ExpressQueryResult(
                "TEST123456", "ZTO", "中通快递", StatusSemantic.UNKNOWN,
                "", "", "[]",
                "https://m.kuaidi100.com/result.jsp?nu=TEST123456",
                "", "meizu");

        ManualQueryCoordinator.queryPickerFirst(
                () -> routeOnly, null, () -> null, false,
                previews::add, () -> 900L);

        assertTrue(previews.isEmpty());
    }

    @Test
    public void firstUsablePrimaryResultPreviewsWhenPickerWasEmpty() throws Exception {
        List<ExpressQueryResult> previews = new ArrayList<>();
        ExpressQueryResult local = tracked("v4", "运输中");
        ManualQueryCoordinator.Batch batch = ManualQueryCoordinator.queryPickerFirst(
                () -> untracked("meizu"), null, () -> local, true, previews::add);
        assertEquals(List.of(local), previews);
        assertEquals(local, batch.detailSelected());
    }

    @Test
    public void explicitStatusQueryKeepsAStatusOnlySuccessWithoutPreviewingEmptyTracks() throws Exception {
        ExpressQueryResult status = new ExpressQueryResult("TEST123456", "ZTO", "中通快递",
                StatusSemantic.COMPLETED, 0L, "", "", "[]", "", "", "v4", "", "", "")
                .withManualStatusEvidence("已签收", true);
        List<ExpressQueryResult> previews = new ArrayList<>();
        ManualQueryCoordinator.Batch explicit = ManualQueryCoordinator.queryPickerFirst(
                () -> null, null, () -> status, true, null, previews::add, true);
        assertEquals(1, explicit.successes.size());
        assertEquals(status, explicit.successes.get(0).result);
        assertTrue(previews.isEmpty());
        ManualQueryCoordinator.Batch background = ManualQueryCoordinator.queryPickerFirst(
                () -> null, null, () -> status, true);
        assertTrue(background.successes.isEmpty());
    }

    @Test
    public void completeDetailStatusOnlyModeStopsAtStructuredPickerButFirstQueryStillGetsHistory() throws Exception {
        ExpressQueryResult status = new ExpressQueryResult("TEST123456", "ZTO", "中通快递",
                StatusSemantic.COMPLETED, 0L, "", "", "[]", "", "", "meizu", "", "", "")
                .withManualStatusEvidence("已签收", true);
        AtomicInteger calls = new AtomicInteger();
        ManualQueryCoordinator.queryPickerFirst(() -> status, null,
                () -> { calls.incrementAndGet(); return tracked("v4", "已揽收"); },
                true, null, null, true, true);
        assertEquals(0, calls.get());
        ManualQueryCoordinator.queryPickerFirst(() -> status, null,
                () -> { calls.incrementAndGet(); return tracked("v4", "已揽收"); },
                true, null, null, true);
        assertEquals(1, calls.get());
    }

    @Test
    public void explicitMissingStatusQueryContinuesPastCompleteUnknownPicker() throws Exception {
        AtomicInteger localCalls = new AtomicInteger();
        ExpressQueryResult unknown = new ExpressQueryResult("TEST123456", "ZTO", "中通快递",
                StatusSemantic.UNKNOWN, "2026-08-22 00:00:00", "已揽收",
                "[{\"time\":\"2026-08-22 00:00:00\",\"context\":\"已揽收\"}]");
        ExpressQueryResult structured = tracked("v4", "运输中")
                .withManualStatusEvidence("运输中", true);
        ManualQueryCoordinator.queryPickerFirst(() -> unknown, null,
                () -> { localCalls.incrementAndGet(); return structured; }, true, null, null, true);
        assertEquals(1, localCalls.get());
        localCalls.set(0);
        ManualQueryCoordinator.queryPickerFirst(() -> unknown, null,
                () -> { localCalls.incrementAndGet(); return structured; }, true);
        assertEquals("background history-only calls keep their original gate", 0, localCalls.get());
        ExpressQueryResult known = new ExpressQueryResult("TEST123456", "ZTO", "中通快递",
                StatusSemantic.PICKED, "2026-08-22 00:00:00", "已揽收", unknown.tracksJson)
                .withManualStatusEvidence("已揽收", true);
        ManualQueryCoordinator.queryPickerFirst(() -> known, null,
                () -> { localCalls.incrementAndGet(); return structured; }, true, null, null, true);
        assertEquals("a structured Picker status still stops the explicit chain", 0, localCalls.get());
    }

    @Test
    public void completePrimaryPreviewsBeforeSlowPeerAndCannotRegressToPartial() throws Exception {
        CountDownLatch localStarted = new CountDownLatch(1);
        CountDownLatch releaseLocal = new CountDownLatch(1);
        CountDownLatch completePreview = new CountDownLatch(1);
        ExpressQueryResult complete = tracked("kuaidi100", "已揽收");
        List<ExpressQueryResult> previews = Collections.synchronizedList(new ArrayList<>());
        AtomicReference<ManualQueryCoordinator.Batch> result = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread coordinator = new Thread(() -> {
            try {
                result.set(ManualQueryCoordinator.queryPickerFirst(
                        () -> untracked("meizu"), null,
                        () -> {
                            localStarted.countDown();
                            assertTrue(releaseLocal.await(3, TimeUnit.SECONDS));
                            return tracked("v4", "派送中");
                        }, true,
                        picker -> () -> {
                            assertTrue(localStarted.await(1, TimeUnit.SECONDS));
                            return complete;
                        }, preview -> {
                            previews.add(preview);
                            if (preview == complete) completePreview.countDown();
                        }));
            } catch (Throwable error) { failure.set(error); }
        });
        coordinator.start();
        try {
            assertTrue("K100 must preview while the earlier Moto future is still pending",
                    completePreview.await(1, TimeUnit.SECONDS));
            assertTrue("all started providers must finish before final commit", coordinator.isAlive());
        } finally {
            releaseLocal.countDown();
            coordinator.join(2000L);
        }
        org.junit.Assert.assertNull(failure.get());
        assertEquals(List.of(complete), previews);
        assertEquals(2, result.get().successes.size());
        assertEquals(complete, result.get().detailSelected());
    }

    private static ExpressQueryResult concurrentResult(
            String provider, CountDownLatch started, CountDownLatch release,
            AtomicInteger concurrent, AtomicInteger maximum) throws Exception {
        int active = concurrent.incrementAndGet();
        maximum.accumulateAndGet(active, Math::max);
        started.countDown();
        if (started.getCount() == 0) release.countDown();
        assertTrue(release.await(1, TimeUnit.SECONDS));
        concurrent.decrementAndGet();
        return tracked(provider, provider);
    }

    private static ExpressQueryResult tracked(String provider, String detail) {
        return trackedAt(provider, detail, "2026-08-22 00:00:00");
    }

    private static ExpressQueryResult trackedAt(
            String provider, String detail, String time) {
        return new ExpressQueryResult(
                "TEST123456", "ZTO", "中通快递", StatusSemantic.TRANSIT,
                time, detail,
                "[{\"time\":\"" + time + "\",\"context\":\"" + detail + "\"}]",
                "", "", provider);
    }

    private static ExpressQueryResult untracked(String provider) {
        return new ExpressQueryResult(
                "TEST123456", "ZTO", "中通快递", StatusSemantic.UNKNOWN,
                "", "暂无轨迹", "[]", "", "", provider);
    }

    private static ExpressItem automaticOwner(
            String provider, String courierCode, String companyName) {
        return new ExpressItem(
                1L, "", "TEST123456", courierCode, companyName,
                StatusSemantic.TRANSIT, "运输中", "快件运输中",
                "2026-08-24 10:00:00", "[]", "", "INTERFACE5", "",
                1L, 2L, "INTERFACE5", "", "", "", true,
                "", "", "", provider);
    }
}
