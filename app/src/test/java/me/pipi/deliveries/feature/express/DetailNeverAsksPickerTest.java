package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
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
import java.util.concurrent.TimeUnit;

import me.pipi.deliveries.R;
import me.pipi.deliveries.data.ExpressAutomaticDetailPersistenceTest.SyntheticSecretBox;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.ManualQuerySuccess;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import me.pipi.deliveries.network.ExpressSubscriptionClient;

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

/**
 * 规则冲突 1（用户 2026-10-03「三端都不问」）：Lite's detail page — opened or pulled — asks no v6_query (Picker / Online) for a
 * manual row or an SF row; their stored v6_query package is only read. The status alignment's forced refresh still asks
 * the Picker (10-02「保持现状」, see ExpressStatusAlignmentTest), and the list round's Picker is unchanged. Synthetic data.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class, shadows = {
        SyntheticSecretBox.class, DetailNeverAsksPickerTest.Picker.class, DetailNeverAsksPickerTest.Page.class,
        DetailNeverAsksPickerTest.Account.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class DetailNeverAsksPickerTest {
    private static final String PHONE = "13800005252";
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            .withZone(ZoneId.of("Asia/Shanghai"));

    private Context context;
    private ExpressRepository repository;
    private ExpressDetailActivity activity;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("express_k100_capture_cooldown", 0).edit().clear().commit();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        activity = Robolectric.buildActivity(ExpressDetailActivity.class).get();
        activity.setTheme(R.style.AppTheme);
        Picker.calls = 0;
        Page.calls = 0;
    }

    @After public void tearDown() throws Exception {
        java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
        helper.setAccessible(true);
        ((ExpressDatabase) helper.get(repository)).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void aManualRowsDetailNeverAsksThePicker() throws Exception {
        String time = minutesAgo(40);
        ExpressQueryResult partial = new ExpressQueryResult("ZT7000005252", "ZTO", "中通快递", StatusSemantic.TRANSIT,
                ExpressTimeline.parseTime(time), time, "快件运输中", tracks(time, "快件运输中"), "", PHONE,
                TimelineSlot.V6_QUERY, "", "", "").withManualStatusEvidence("运输中", true);
        ExpressItem row = repository.saveManualQueryBatch(null, null, List.of(new ManualQuerySuccess(
                TimelineSlot.V6_QUERY, partial, System.currentTimeMillis() - 60_000L, false)), PHONE, "interface5");
        assertNotNull(row);
        assertTrue(row.manuallyAdded);

        run(row, false);
        run(repository.find(row.rowId), true);

        assertEquals("neither the open nor the pull asks v6_query", 0, Picker.calls);
        assertEquals("the pull still runs its primary page", 1, Page.calls);
    }

    @Test public void anSfRowsDetailNeverAsksThePicker() throws Exception {
        String time = minutesAgo(40);
        repository.saveInterface5(new ExpressQueryResult("SF7000005252", "SF", "顺丰速运", StatusSemantic.TRANSIT,
                ExpressTimeline.parseTime(time), time, "快件运输中", tracks(time, "快件运输中"), "", PHONE,
                "interface5", "", "", "ShunFeng"), PHONE);
        ExpressItem row = repository.findByWaybill("SF7000005252", "interface5");
        assertNotNull(row);

        run(row, false);
        run(repository.find(row.rowId), true);

        assertEquals(0, Picker.calls);
    }

    /** One open ({@code pull} false) or pull through the page's own background refresh, run on this thread. */
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

    private static String minutesAgo(long minutes) {
        return TIME.format(Instant.ofEpochMilli(System.currentTimeMillis() - minutes * 60_000L));
    }

    private static String tracks(String time, String detail) throws Exception {
        return new JSONArray().put(new JSONObject().put("time", time).put("context", detail)).toString();
    }

    @Implements(value = ExpressSubscriptionClient.class, isInAndroidSdk = false)
    public static class Picker {
        static int calls;

        @Implementation protected ExpressQueryResult queryManual(Context context, String waybill,
                ExpressQueryCancellation cancellation) {
            calls++;
            return null;
        }

        @Implementation protected List<ExpressQueryResult> query(Context context, ExpressQueryCancellation cancellation) {
            return List.of();
        }
    }

    @Implements(value = ExpressAutomaticTimelineCapture.class, isInAndroidSdk = false)
    public static class Page {
        static int calls;

        @Implementation protected static ExpressAutomaticTimelineCapture.Result capture(
                Activity host, ExpressItem owner, String route, String provider, List<String> phones,
                ExpressQueryCancellation cancellation) {
            calls++;
            return null;
        }

        @Implementation protected static ExpressAutomaticTimelineCapture.Result capture(
                Activity host, ExpressItem owner, String route, String provider,
                ExpressQueryCancellation cancellation) {
            calls++;
            return null;
        }
    }

    @Implements(value = ExpressDiscoveryClient.class, isInAndroidSdk = false)
    public static class Account {
        @Implementation protected ExpressQueryResult refreshKnown(Context ignored, ExpressItem owner, boolean force,
                ExpressQueryCancellation cancellation) {
            return null;
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
