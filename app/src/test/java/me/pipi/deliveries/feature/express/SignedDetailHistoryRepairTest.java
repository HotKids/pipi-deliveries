package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.app.Application;
import android.content.Context;

import com.google.android.material.progressindicator.LinearProgressIndicator;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;

import me.pipi.deliveries.R;
import me.pipi.deliveries.data.ExpressAutomaticDetailPersistenceTest.SyntheticSecretBox;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.data.ManualTimelineAuthorityPolicy;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.WorkerStatusProjection;
import me.pipi.deliveries.network.ExpressQueryCancellation;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

/** Explicit detail pulls repair missing history without changing the shared signed freeze. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        shadows = {SyntheticSecretBox.class, SignedDetailHistoryRepairTest.Page.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class SignedDetailHistoryRepairTest {
    private static final String PHONE = "13800006464";
    private static final String SF = "SF7000006464";
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            .withZone(ZoneId.of("Asia/Shanghai"));

    private Context context;
    private ExpressRepository repository;
    private ExpressDetailActivity activity;
    private long signedAt;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("express_k100_capture_cooldown", 0).edit().clear().commit();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        activity = Robolectric.buildActivity(ExpressDetailActivity.class).get();
        activity.setTheme(R.style.AppTheme);
        ((ExecutorService) ReflectionHelpers.getField(activity, "worker")).shutdownNow();
        signedAt = (System.currentTimeMillis() - 60_000L) / 1000L * 1000L;
        Page.calls = 0;
        Page.fail = false;
        Page.answer = null;
    }

    @After public void tearDown() {
        ((ExecutorService) ReflectionHelpers.getField(activity, "worker")).shutdownNow();
        ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void aFrozenPartialOnlineHistoryCanBeRepairedByAnExplicitPull() throws Exception {
        ExpressItem owner = sfOnline(false);
        assertFalse(complete(owner));
        assertTrue(repository.signedFrozen(owner));
        Page.answer = packet(SF, "SF", TimelineSlot.K100_H5, true, "ShunFeng");

        run(owner, true);

        assertEquals(1, Page.calls);
        ExpressItem settled = repository.find(owner.rowId);
        assertTrue(complete(settled));
        assertEquals(TimelineSlot.K100_H5, repository.manualDetailTimelineAuthority(settled).provider);
        assertEquals(2, Kuaidi100TimelinePolicy.timedTrackCount(
                repository.manualDetailTimelineAuthority(settled).result));
        assertTrue("the shared freeze still applies after repair", repository.signedFrozen(settled));
    }

    @Test public void aCompleteSignedOnlineHistoryStillStopsThePull() throws Exception {
        ExpressItem owner = sfOnline(true);
        assertTrue(complete(owner));
        assertTrue(repository.signedFrozen(owner));

        run(owner, true);

        assertEquals(0, Page.calls);
        assertEquals(TimelineSlot.V6_QUERY, repository.manualDetailTimelineAuthority(owner).provider);
        assertTrue(repository.signedFrozen(owner));
    }

    @Test public void anSfEntryStillOnlyDisplaysTheCachedPartialHistory() throws Exception {
        ExpressItem owner = sfOnline(false);
        assertTrue(repository.signedFrozen(owner));

        run(owner, false);

        assertEquals(0, Page.calls);
        assertFalse(complete(owner));
        assertTrue(repository.signedFrozen(owner));
    }

    @Test public void aCaptureCompleteFlagWithoutPickupDoesNotStopTheDetailPull() throws Exception {
        ExpressItem owner = feed(SF, "SF", "ShunFeng");
        repository.saveOwnerManualTimeline(owner,
                packet(SF, "SF", TimelineSlot.K100_H5, false, "ShunFeng"),
                PHONE, "interface5", System.currentTimeMillis(), true);
        owner = repository.find(owner.rowId);
        assertTrue(repository.manualDetailTimelineAuthority(owner).complete);
        assertFalse(complete(owner));
        assertTrue(repository.signedFrozen(owner));

        run(owner, true);

        assertEquals(1, Page.calls);
        assertFalse(complete(repository.find(owner.rowId)));
        assertTrue(repository.signedFrozen(repository.find(owner.rowId)));
    }

    @Test public void aFailedPageLeavesTheFrozenPartialOnlineCacheIntact() throws Exception {
        ExpressItem owner = sfOnline(false);
        String before = repository.manualDetailTimelineAuthority(owner).result.tracksJson;
        Page.fail = true;

        run(owner, true);

        assertEquals(1, Page.calls);
        ExpressItem settled = repository.find(owner.rowId);
        assertEquals(before, repository.manualDetailTimelineAuthority(settled).result.tracksJson);
        assertEquals(TimelineSlot.V6_QUERY, repository.manualDetailTimelineAuthority(settled).provider);
        assertFalse(complete(settled));
        assertTrue(repository.signedFrozen(settled));
    }

    @Test public void differentPartialDisplayAndPollingAuthoritiesKeepTheExistingClaimBoundary() throws Exception {
        ExpressItem owner = sfOnline(false);
        ExpressQueryResult page = packet(SF, "SF", TimelineSlot.K100_H5, false, "ShunFeng");
        JSONArray nodes = new JSONObject(page.tracksJson).getJSONArray("data")
                .put(node(signedAt - 600_000L, "Intermediate node", "0"))
                .put(node(signedAt - 1_200_000L, "Earlier intermediate node", "0"));
        repository.saveOwnerManualTimeline(owner, page.withTracksJson(nodes.toString()),
                PHONE, "interface5", System.currentTimeMillis(), false);
        owner = repository.find(owner.rowId);
        repository.rememberDetailSelection(owner, TimelineSlot.K100_H5);
        assertEquals(TimelineSlot.K100_H5, repository.manualDetailTimelineAuthority(owner).provider);
        assertEquals(TimelineSlot.V6_QUERY, repository.manualTimelineAuthority(owner).provider);
        assertFalse(complete(owner));
        assertTrue(repository.signedFrozen(owner));
        Page.fail = true;

        run(owner, true);

        assertEquals(1, Page.calls);
        assertEquals(TimelineSlot.K100_H5, repository.manualDetailTimelineAuthority(owner).provider);
        assertEquals(TimelineSlot.V6_QUERY, repository.manualTimelineAuthority(owner).provider);
        assertTrue(repository.signedFrozen(owner));
    }

    @Test public void anActiveForegroundLeaseStillStopsARepairPull() throws Exception {
        ExpressItem owner = sfOnline(false);
        ExpressRepository.ManualTimelinePollClaim claim = repository.claimForegroundManualTimelinePoll(
                owner, System.currentTimeMillis(), true);
        assertNotNull(claim);
        try {
            run(owner, true);
            assertEquals(0, Page.calls);
            assertNull(repository.claimForegroundManualTimelinePoll(owner, System.currentTimeMillis(), true));
            assertTrue(repository.signedFrozen(owner));
        } finally {
            repository.releaseManualTimelinePoll(claim);
        }
    }

    @Test public void aNonSfSignedSummaryIsRepairableOnlyThroughTheExplicitPull() throws Exception {
        ExpressItem owner = feed("ZT7000006464", "ZTO", "ZhongTong");
        assertFalse(complete(owner));
        assertTrue(repository.signedFrozen(owner));

        run(owner, false);
        assertEquals(0, Page.calls);
        run(owner, true);

        assertEquals(1, Page.calls);
        assertTrue(repository.signedFrozen(owner));
    }

    private ExpressItem sfOnline(boolean pickup) throws Exception {
        ExpressItem owner = feed(SF, "SF", "ShunFeng");
        repository.saveOwnerManualTimeline(owner, packet(SF, "SF", TimelineSlot.V6_QUERY, pickup, "ShunFeng"),
                PHONE, "interface5", System.currentTimeMillis(), false);
        ExpressItem stored = repository.find(owner.rowId);
        assertEquals(TimelineSlot.V6_QUERY, repository.manualDetailTimelineAuthority(stored).provider);
        return stored;
    }

    private ExpressItem feed(String waybill, String carrier, String source) throws Exception {
        repository.saveInterface5(packet(waybill, carrier, "interface5", false, source), PHONE);
        ExpressItem owner = repository.findByWaybill(waybill, "interface5");
        assertNotNull(owner);
        return owner;
    }

    private ExpressQueryResult packet(String waybill, String carrier, String provider, boolean pickup,
            String source) throws Exception {
        boolean account = "interface5".equals(provider);
        JSONArray nodes = new JSONArray().put(node(signedAt, "Signed node", account ? "107" : "3"));
        if (pickup) nodes.put(node(signedAt - 3_600_000L, "Pickup node", account ? "103" : "1"));
        WorkerStatusProjection status = WorkerStatusProjection.read(new JSONObject().put("normalizedStatus",
                new JSONObject().put("version", 1).put("scope", "SHIPMENT").put("semantic", "COMPLETED")
                        .put("code", "SERVER_ENUM").put("text", "已签收").put("priority", 0)
                        .put("eventAtMs", signedAt).put("structured", true)));
        assertNotNull(status);
        return new ExpressQueryResult(waybill, carrier, "Synthetic carrier", StatusSemantic.COMPLETED,
                signedAt, TIME.format(Instant.ofEpochMilli(signedAt)), "Signed node", nodes.toString(), "", PHONE,
                provider, "", "", source).withWorkerStatus(status);
    }

    private static JSONObject node(long at, String detail, String status) throws Exception {
        return new JSONObject().put("time", TIME.format(Instant.ofEpochMilli(at)))
                .put("context", detail).put("statusCode", status);
    }

    private boolean complete(ExpressItem owner) {
        return ExpressDetailActivity.currentDetailComplete(owner, repository.automaticSourceTimeline(owner),
                repository.manualDetailTimelineAuthority(owner));
    }

    /** Run the real background refresh while fencing off unrelated view rendering. */
    private void run(ExpressItem owner, boolean pull) {
        QueuedExecutor worker = new QueuedExecutor();
        ReflectionHelpers.setField(activity, "worker", worker);
        ReflectionHelpers.setField(activity, "item", owner);
        ReflectionHelpers.setField(activity, "nativeProgress", new LinearProgressIndicator(activity));
        ReflectionHelpers.setField(activity, "detailEntryObserved", false);
        ReflectionHelpers.setField(activity, "localRefreshInFlight", false);
        ReflectionHelpers.setField(activity, "pullRefreshRequested", pull);
        ReflectionHelpers.callInstanceMethod(activity, "refreshLocalTimelineInBackground",
                ClassParameter.from(boolean.class, false));
        int generation = ReflectionHelpers.getField(activity, "localRefreshGeneration");
        ReflectionHelpers.setField(activity, "localRefreshGeneration", generation + 1);
        for (Runnable task : new ArrayList<>(worker.tasks)) task.run();
    }

    @Implements(value = ExpressAutomaticTimelineCapture.class, isInAndroidSdk = false)
    public static class Page {
        static int calls;
        static boolean fail;
        static ExpressQueryResult answer;

        @Implementation protected static ExpressAutomaticTimelineCapture.Result capture(Activity host,
                ExpressItem owner, String route, String provider, List<String> phones,
                ExpressQueryCancellation cancellation) {
            calls++;
            if (fail) throw new IllegalStateException("Synthetic capture failure");
            return answer == null ? null : new ExpressAutomaticTimelineCapture.Result(answer, true, false);
        }
    }

    private static final class QueuedExecutor extends AbstractExecutorService {
        final List<Runnable> tasks = new ArrayList<>();
        private boolean stopped;
        @Override public void execute(Runnable task) { tasks.add(task); }
        @Override public void shutdown() { stopped = true; }
        @Override public List<Runnable> shutdownNow() { stopped = true; return tasks; }
        @Override public boolean isShutdown() { return stopped; }
        @Override public boolean isTerminated() { return stopped; }
        @Override public boolean awaitTermination(long timeout, TimeUnit unit) { return stopped; }
    }
}
