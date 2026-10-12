package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.os.Looper;
import android.webkit.WebView;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import me.pipi.deliveries.R;
import me.pipi.deliveries.background.ExpressScheduler;
import me.pipi.deliveries.data.ExpressAutomaticDetailPersistenceTest.SyntheticSecretBox;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.util.ReflectionHelpers;

/**
 * 用户采纳 2026-09-24：首页的京粉页在这一单的 30 秒预算用完之后才回话（强制 v5_query 吃掉了大半），回调以前直接
 * 返回、不收尾，首页一直挂着这一单的租约，下一单要等到 onStop。现在回调的每个出口都收尾一次。用真的页面（不打桩），
 * 预算按截止时刻用完，不是手动取消。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class, shadows = {
        SyntheticSecretBox.class,
        ExpressHomeProjectionBudgetTest.Query.class,
        ExpressHomeProjectionBudgetTest.Scheduler.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressHomeProjectionBudgetTest {
    private static final String PHONE = "13800001357";
    private static final String PICKED = "[{\"time\":\"2026-09-24 08:00:00\",\"context\":\"已揽收\"}]";
    private Context context;
    private ExpressRepository repository;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        for (String prefs : new String[]{"express_jd_h5_cooldown", "express_account_source",
                "deliveries_repository_migrations"}) {
            context.getSharedPreferences(prefs, 0).edit().clear().commit();
        }
        context.getSharedPreferences("express_account_source", 0).edit()
                .putString("active_interface", "v5").commit();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        ((Map<?, ?>) ReflectionHelpers.getStaticField(
                ExpressOrderProjectionRetryStore.class, "ACTIVE_ATTEMPTS")).clear();
        ((AtomicInteger) ReflectionHelpers.getStaticField(
                ExpressListActivity.class, "STARTED_HOMES")).set(0);
        Query.orders.clear();
    }

    @After public void tearDown() {
        ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void aPageThatAnswersAfterTheBudgetOrTheHostEndedFinishesTheCaptureOnce()
            throws Exception {
        for (boolean budgetSpent : new boolean[]{true, false}) {
            ExpressItem order = order(budgetSpent ? "3630448013828001" : "3630448013828002");
            ActivityController<Activity> hostController =
                    Robolectric.buildActivity(Activity.class).setup();
            Activity host = hostController.get();
            AtomicInteger finished = new AtomicInteger();
            AtomicBoolean saved = new AtomicBoolean(true);
            ExpressHomeOrderProjectionCapture capture = new ExpressHomeOrderProjectionCapture(
                    host, order, (done, committed) -> {
                        finished.incrementAndGet();
                        saved.set(committed);
                    });
            try {
                assertTrue(capture.start());
                pumpUntil(() -> ReflectionHelpers.getField(capture, "automaticCapture") != null);
                ExpressAutomaticTimelineCapture page = ReflectionHelpers.getField(capture, "automaticCapture");
                WebView view = ReflectionHelpers.getField(page, "view");
                assertNotNull("the union page is loading", view);
                assertNull("Home holds the order", ExpressOrderProjectionRetryStore.acquireAttempt(order));

                if (budgetSpent) spendBudget(capture);
                else host.finish();
                Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(250L));

                assertEquals("the capture finishes once", 1, finished.get());
                assertFalse(saved.get());
                assertTrue("the page is torn down", Shadows.shadowOf(view).wasDestroyCalled());
                assertNull(view.getParent());
                ExpressOrderProjectionRetryStore.AttemptToken lease =
                        ExpressOrderProjectionRetryStore.acquireAttempt(order);
                assertNotNull("the order's lease is released", lease);
                ExpressOrderProjectionRetryStore.releaseAttempt(lease);
                Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(30L));
                assertEquals("and never a second time", 1, finished.get());
            } finally {
                capture.cancel();
                if (!host.isFinishing()) host.finish();
            }
        }
    }

    @Test public void homeMovesOnToTheNextOrderWhenAnAttemptRunsOutOfBudget() throws Exception {
        ExpressItem first = order("3630448013828101");
        ExpressItem second = order("3630448013828102");
        ActivityController<ExpressListActivity> home = Robolectric.buildActivity(ExpressListActivity.class);
        home.get().setTheme(R.style.AppTheme);
        try {
            // Visible, as on a device: a page inside a window that was never attached never polls.
            home.setup();
            pumpUntil(() -> homeCapture(home) != null
                    && ReflectionHelpers.getField(homeCapture(home), "automaticCapture") != null);
            ExpressHomeOrderProjectionCapture stuck = homeCapture(home);
            assertEquals(1, Query.orders.size());
            String opened = Query.orders.get(0);
            String next = opened.equals(first.waybill) ? second.waybill : first.waybill;

            spendBudget(stuck);
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(250L));

            pumpUntil(() -> Query.orders.size() == 2);
            assertEquals("Home starts the next order", List.of(opened, next), Query.orders);
            assertNotSame(stuck, homeCapture(home));
            ExpressItem openedOrder = opened.equals(first.waybill) ? first : second;
            ExpressOrderProjectionRetryStore.AttemptToken lease =
                    ExpressOrderProjectionRetryStore.acquireAttempt(openedOrder);
            assertNotNull("the spent attempt released its order", lease);
            ExpressOrderProjectionRetryStore.releaseAttempt(lease);
        } finally {
            home.pause().stop().destroy();
        }
    }

    private static ExpressHomeOrderProjectionCapture homeCapture(
            ActivityController<ExpressListActivity> home) {
        return ReflectionHelpers.getField(home.get(), "orderProjectionCapture");
    }

    /** The attempt's 30-second deadline passes (as when the forced v5_query used most of it). */
    private static void spendBudget(ExpressHomeOrderProjectionCapture capture) {
        ExpressQueryCancellation budget = ReflectionHelpers.getField(capture, "cancellation");
        ReflectionHelpers.setField(budget, "deadlineNanos", System.nanoTime() - 1L);
        assertTrue(budget.isCancelled());
    }

    private ExpressItem order(String order) {
        String route = "https://jingfen.jd.com/item?fixture=" + order;
        String time = "2026-09-24 08:00:00";
        ExpressQueryResult feed = new ExpressQueryResult(order, "JD", "京东购物",
                StatusSemantic.TRANSIT, ExpressTimeline.parseTime(time), time, "订单运输中",
                PICKED, route, PHONE, "interface5", "v5", route, "JingDong");
        repository.saveInterface5OrderSummary(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(order, "interface5");
        assertNotNull(owner);
        assertTrue(repository.saveRecoveredOwnerRoute(owner, repository.captureManualQueryOwner(owner), feed));
        for (ExpressItem item : repository.listVisible("interface5")) {
            if (item.rowId == owner.rowId) {
                assertTrue(ExpressHomeOrderProjectionCapture.needsProjection(item));
                return item;
            }
        }
        throw new AssertionError("the order is not listed");
    }

    private static void pumpUntil(BooleanSupplier condition) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!condition.getAsBoolean()) {
            if (System.nanoTime() > until) throw new AssertionError("the condition was not reached");
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            Thread.sleep(5);
        }
    }

    @Implements(value = ExpressDiscoveryClient.class, isInAndroidSdk = false)
    public static class Query {
        static final List<String> orders = new CopyOnWriteArrayList<>();

        @Implementation protected ExpressQueryResult refreshKnown(Context ignored, ExpressItem owner,
                boolean force, ExpressQueryCancellation cancellation) {
            orders.add(owner.waybill);
            return null;
        }
    }

    @Implements(value = ExpressScheduler.class, isInAndroidSdk = false)
    public static class Scheduler {
        @Implementation protected static void requestForeground(Context ignored) {}

        @Implementation protected static UUID requestNow(Context ignored) {
            return UUID.randomUUID();
        }
    }
}
