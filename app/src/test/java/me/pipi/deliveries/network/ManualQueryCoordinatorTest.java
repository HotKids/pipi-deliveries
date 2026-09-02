package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

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
    public void pickerStartSkipsLocalForTheCurrentRun() throws Exception {
        List<String> calls = new ArrayList<>();
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
        List<String> calls = new ArrayList<>();
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
