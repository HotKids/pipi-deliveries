package me.pipi.deliveries.background;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.database.Cursor;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.WorkerStatusProjection;
import me.pipi.deliveries.network.CarrierRecognitionTimeoutException;
import me.pipi.deliveries.network.ExpressApi;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressQueryCancellation;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.util.ReflectionHelpers;

/**
 * 用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒。一次同步轮里的承运商识别总共最多等一份预算；超出的运单这一轮
 * 不再发请求、照 T23 压着（订单行保持原样、通知挂着），到点时正在等的那一次被取消，下一轮识别出来再放行。
 * 预算在这里缩短到毫秒级，请求的耗时由 {@link Api} 模拟。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class, shadows = {
        ExpressSyncRecognitionBudgetTest.Discovery.class, ExpressSyncRecognitionBudgetTest.Api.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressSyncRecognitionBudgetTest {
    private static final String PHONE = "13900002424";
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            .withZone(ZoneId.of("Asia/Shanghai"));
    private static final CarrierNormalization YTO =
            new CarrierNormalization("YTO", "圆通速递", "yuantong", true, "budget");

    private Context context;
    private ExpressRepository repository;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        for (String name : new String[]{"deliveries_repository_migrations", "express_account_source",
                "express_network_success", CarrierRecognitionDeferrals.PREFS}) {
            context.getSharedPreferences(name, 0).edit().clear().commit();
        }
        context.getSharedPreferences("express_account_source", 0).edit()
                .putString("active_interface", "v5").commit();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        context.getSystemService(NotificationManager.class).cancelAll();
        Api.reset();
    }

    private static void awaitPublications() throws Exception {
        // Notification assertions observe the real queued publication, outside the recognition budget.
        ExecutorService worker = ReflectionHelpers.getStaticField(ExpressRepository.class, "PUBLICATION_WORKER");
        worker.submit(() -> {}).get(3L, TimeUnit.SECONDS);
    }

    @After public void tearDown() throws Exception {
        awaitPublications();
        AccountCarrierRecognition.budgetMillisOverride = 0L;
        Api.reset();
        ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    /**
     * At the budget's end the round stops waiting: the request in flight is cancelled, the waybill left
     * over asks nothing, both rows keep their held notifications, and the next round recognises and
     * releases them.
     */
    @Test public void aRoundStopsAtItsBudgetAndHoldsTheRestForTheNextRound() throws Exception {
        AccountCarrierRecognition.budgetMillisOverride = 400L;
        ExpressItem first = heldParcel("YT7700189163");
        ExpressItem second = heldParcel("YT7700189164");
        int posted = postedTitles().size();
        assertEquals(2, outbox());

        Api.delayMillis = 3_000L;
        long started = System.nanoTime();
        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");
        long tookMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        awaitPublications();
        assertTrue("the round stops waiting at its budget, took " + tookMs + " ms", tookMs < 2_000L);
        assertFalse("the round's own thread is not left interrupted",
                Thread.currentThread().isInterrupted());
        assertEquals("the waybill left over asks nothing this round", 1, Api.calls.get());
        assertTrue("the request in flight at the budget's end is cancelled", awaitAborted(1));
        assertTrue(repository.find(first.rowId).carrierPending());
        assertTrue(repository.find(second.rowId).carrierPending());
        assertEquals("both notifications stay held", 2, outbox());
        assertEquals(posted, postedTitles().size());

        Api.delayMillis = 0L;
        Api.answer = YTO;
        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");
        awaitPublications();
        assertFalse(repository.find(first.rowId).carrierPending());
        assertFalse(repository.find(second.rowId).carrierPending());
        assertEquals(0, outbox());
        List<String> titles = postedTitles();
        assertEquals("the next round releases both into one live activity", posted + 1, titles.size());
        assertEquals("派送中 2 件", titles.get(titles.size() - 1));
        Notification live = Shadows.shadowOf(context.getSystemService(NotificationManager.class))
                .getAllNotifications().stream().filter(n -> "express_live".equals(n.getChannelId()))
                .findFirst().orElseThrow();
        String body = live.extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString().replace("\u200B", "");
        assertTrue(body, body.startsWith("圆通速递 · YT7700189164"));
    }

    /**
     * The order projected before its carrier matched and the account row recognised afterwards draw on
     * one budget: the second recognition of the round gets only what the first left of it.
     */
    @Test public void everyRecognitionOfARoundDrawsOnOneBudget() throws Exception {
        AccountCarrierRecognition.budgetMillisOverride = 1_500L;
        ExpressItem order = orderNamingItsWaybill("3630448013822611", "770018906334611");
        ExpressItem parcel = heldParcel("YT7700189172");

        Api.delayMillis = 1_000L;
        Api.answer = YTO;
        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");
        boolean orderProjected = !repository.find(order.rowId).projectedWaybill.isEmpty();
        boolean parcelMatched = !repository.find(parcel.rowId).carrierPending();
        assertTrue("the first recognition of the round is answered", orderProjected || parcelMatched);
        assertFalse("the second one waits only for what is left of the same budget",
                orderProjected && parcelMatched);
        assertEquals(2, Api.calls.get());
        assertTrue("the second request is cancelled at the budget's end", awaitAborted(1));

        Api.delayMillis = 0L;
        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");
        assertEquals("770018906334611", repository.find(order.rowId).projectedWaybill);
        assertFalse(repository.find(parcel.rowId).carrierPending());
    }

    /**
     * 用户 2026-09-27 第二轮清单：截断排后。The waybill whose request the budget cut off goes last in the
     * next round, after the one the spent budget left unasked (截断排后细则，用户 2026-09-27 提交前核对答
     * 「这样做」); a waybill not truncated goes first. None of them is counted as a failure: each is asked again.
     */
    @Test public void aWaybillCutAtTheBudgetGoesLastInTheNextRound() throws Exception {
        AccountCarrierRecognition.budgetMillisOverride = 400L;
        heldParcel("YT7700189263", 60);
        heldParcel("YT7700189264", 60);
        List<ExpressItem> listed = repository.listVisible("interface5");
        String first = listed.get(0).displayWaybill();
        String second = listed.get(1).displayWaybill();
        Api.hanging.add(first);
        Api.answer = YTO;
        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");
        assertEquals(List.of(first), Api.asked());
        CarrierRecognitionDeferrals deferrals = CarrierRecognitionDeferrals.get(context);
        assertEquals("cut in flight", CarrierRecognitionDeferrals.CUT, deferrals.mark(first));
        assertEquals("left unasked", CarrierRecognitionDeferrals.SKIPPED, deferrals.mark(second));
        assertTrue(awaitAborted(1));

        // A waybill the budget did not truncate goes first, although the list shows it last.
        ExpressItem third = heldParcel("YT7700189265", 300);
        assertEquals(third.rowId, repository.listVisible("interface5").get(2).rowId);
        Api.clearAsked();
        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");
        assertEquals(List.of(normalized(third.displayWaybill()), second, first), Api.asked());
        assertFalse(repository.find(third.rowId).carrierPending());
        assertFalse("its turn came before the cut waybill's",
                repository.findByWaybill(second, "interface5").carrierPending());
        assertTrue(repository.findByWaybill(first, "interface5").carrierPending());
        assertEquals(CarrierRecognitionDeferrals.CUT, deferrals.mark(first));
        assertEquals(CarrierRecognitionDeferrals.NONE, deferrals.mark(second));
    }

    /** The mark goes once the waybill is recognised, or once recognition gives up on it (terminal). */
    @Test public void aMarkClearsWhenItsWaybillIsRecognisedOrGivenUpOn() throws Exception {
        AccountCarrierRecognition.budgetMillisOverride = 400L;
        heldParcel("YT7700189273", 60);
        heldParcel("YT7700189274", 60);
        List<ExpressItem> listed = repository.listVisible("interface5");
        String first = listed.get(0).displayWaybill();
        String second = listed.get(1).displayWaybill();
        Api.hanging.add(first);
        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");
        CarrierRecognitionDeferrals deferrals = CarrierRecognitionDeferrals.get(context);
        assertEquals(CarrierRecognitionDeferrals.CUT, deferrals.mark(first));
        assertEquals(CarrierRecognitionDeferrals.SKIPPED, deferrals.mark(second));
        assertTrue(awaitAborted(1));

        Api.hanging.clear();
        Api.answers.put(first, YTO);
        Api.answers.put(second, CarrierNormalization.exhausted());
        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");
        assertFalse(repository.findByWaybill(first, "interface5").carrierPending());
        assertFalse("released at the terminal verdict",
                repository.findByWaybill(second, "interface5").carrierPending());
        assertEquals("recognised", CarrierRecognitionDeferrals.NONE, deferrals.mark(first));
        assertEquals("given up on", CarrierRecognitionDeferrals.NONE, deferrals.mark(second));
    }

    /**
     * 用户 2026-09-27 提交前核对答复四：in a sync round a request that times out on its own is no failure; it is
     * marked cut off, goes last in the next round, and this round goes on with what is left of its budget.
     */
    @Test public void aRequestThatTimesOutInTheRoundGoesLastWithoutAFailure() throws Exception {
        heldParcel("YT7700189293", 60);
        heldParcel("YT7700189294", 60);
        List<ExpressItem> listed = repository.listVisible("interface5");
        String first = listed.get(0).displayWaybill();
        String second = listed.get(1).displayWaybill();
        Api.timingOut.add(first);
        Api.answer = YTO;
        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");
        assertEquals("the round goes on after the timeout", List.of(first, second), Api.asked());
        CarrierRecognitionDeferrals deferrals = CarrierRecognitionDeferrals.get(context);
        assertEquals(CarrierRecognitionDeferrals.CUT, deferrals.mark(first));
        assertTrue(repository.findByWaybill(first, "interface5").carrierPending());
        assertFalse(repository.findByWaybill(second, "interface5").carrierPending());

        ExpressItem third = heldParcel("YT7700189295", 300);
        Api.clearAsked();
        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");
        assertEquals(List.of(normalized(third.displayWaybill()), first), Api.asked());
        assertEquals(CarrierRecognitionDeferrals.CUT, deferrals.mark(first));
    }

    /** A mark on a waybill recognised elsewhere (the detail screen, a table carrier) goes at the next round. */
    @Test public void aMarkOnAWaybillRecognisedElsewhereGoesAtTheNextRound() throws Exception {
        ExpressItem row = heldParcel("YT7700189283", 60);
        CarrierRecognitionDeferrals deferrals = CarrierRecognitionDeferrals.get(context);
        deferrals.defer(row.displayWaybill(), true);
        assertTrue(repository.saveRecognizedCarrier(repository.find(row.rowId), YTO));
        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");
        assertEquals("nothing left to recognise", 0, Api.calls.get());
        assertEquals(CarrierRecognitionDeferrals.NONE, deferrals.mark(row.displayWaybill()));
    }

    private ExpressItem heldParcel(String waybill) throws Exception {
        return heldParcel(waybill, 60);
    }

    private ExpressItem heldParcel(String waybill, long minutesAgo) throws Exception {
        parcel(waybill, StatusSemantic.TRANSIT, minutesAgo(minutesAgo + 60), "快件运输中");
        ExpressItem row = parcel(waybill, StatusSemantic.DELIVERY, minutesAgo(minutesAgo), "快递员正在派送");
        assertTrue("the raw code is shown, not a carrier", row.carrierPending());
        return row;
    }

    private ExpressItem parcel(String waybill, StatusSemantic semantic, String time, String detail)
            throws Exception {
        repository.saveInterface5(new ExpressQueryResult(waybill, "UNKNOWNCODE", "",
                semantic, ExpressTimeline.parseTime(time), time, detail,
                tracks(new String[][]{{time, detail}}), "", PHONE, "interface5", "", "", "")
                .withCarrierNormalization(CarrierNormalization.NONE), PHONE);
        ExpressItem row = repository.findByWaybill(waybill, "interface5");
        assertNotNull(row);
        return row;
    }

    private ExpressItem orderNamingItsWaybill(String orderId, String waybill) throws Exception {
        String text = "您的订单由第三方卖家拣货完成，待出库交付圆通速递，运单号为" + waybill;
        String time = minutesAgo(90);
        long eventAt = ExpressTimeline.parseTime(time);
        repository.saveInterface5OrderSummary(new ExpressQueryResult(orderId, "JDKD",
                "京东商品快递", StatusSemantic.PICKED, eventAt, time, text,
                tracks(new String[][]{{time, text}}), "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(WorkerStatusProjection.read(new JSONObject().put("normalizedStatus",
                        new JSONObject().put("version", 1).put("scope", "ORDER")
                                .put("semantic", "PICKED").put("code", "SERVER_ENUM")
                                .put("text", "已揽件").put("priority", 0)
                                .put("eventAtMs", eventAt).put("structured", true)))), PHONE);
        ExpressItem order = repository.findByWaybill(orderId, "interface5");
        assertNotNull(order);
        assertEquals("", order.projectedWaybill);
        assertNotNull("the order text names its waybill", repository.pendingProjection(order));
        return order;
    }

    private static String normalized(String waybill) {
        return waybill.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", "");
    }

    private static boolean awaitAborted(int expected) throws InterruptedException {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (System.nanoTime() - until < 0L) {
            if (Api.aborted.get() >= expected) return true;
            Thread.sleep(10L);
        }
        return Api.aborted.get() >= expected;
    }

    private int outbox() {
        ExpressDatabase database = (ExpressDatabase) ReflectionHelpers.getField(repository, "helper");
        try (Cursor cursor = database.getReadableDatabase().query(
                ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null, null, null, null, null, null)) {
            return cursor.getCount();
        }
    }

    private List<String> postedTitles() {
        List<String> titles = new ArrayList<>();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        for (Notification notification : Shadows.shadowOf(manager).getAllNotifications()) {
            CharSequence title = notification.extras.getCharSequence(Notification.EXTRA_TITLE);
            titles.add(title == null ? "" : title.toString());
        }
        return titles;
    }

    private static String minutesAgo(long minutes) {
        return TIME.format(Instant.ofEpochMilli(System.currentTimeMillis() - minutes * 60_000L));
    }

    private static String tracks(String[][] nodes) throws Exception {
        JSONArray value = new JSONArray();
        for (String[] node : nodes) {
            value.put(new JSONObject().put("time", node[0]).put("context", node[1]));
        }
        return value.toString();
    }

    @Implements(value = ExpressDiscoveryClient.class, isInAndroidSdk = false)
    public static class Discovery {
        @Implementation protected int sync(Context ignored, List<String> phones, boolean userPull) {
            return 0;
        }

        @Implementation protected boolean wasSynced(String waybill) {
            return true;
        }

        @Implementation protected Map<String, Set<String>> syncedWaybillsByGeneration() {
            return Collections.emptyMap();
        }
    }

    /**
     * A recognition request that answers after {@link #delayMillis} (a waybill in {@link #hanging} never
     * does), or is cancelled before it. A waybill in {@link #timingOut} times out on its own: asked by a sync
     * round it reports the timeout, asked by anyone else it fails as a network failure, as ExpressApi does.
     */
    @Implements(value = ExpressApi.class, isInAndroidSdk = false)
    public static class Api {
        static final AtomicInteger calls = new AtomicInteger();
        static final AtomicInteger aborted = new AtomicInteger();
        static final Set<String> hanging = ConcurrentHashMap.newKeySet();
        static final Set<String> timingOut = ConcurrentHashMap.newKeySet();
        static final Map<String, CarrierNormalization> answers = new ConcurrentHashMap<>();
        private static final List<String> asked = Collections.synchronizedList(new ArrayList<>());
        static volatile long delayMillis;
        static volatile CarrierNormalization answer = CarrierNormalization.NONE;

        static void reset() {
            calls.set(0);
            aborted.set(0);
            hanging.clear();
            timingOut.clear();
            answers.clear();
            asked.clear();
            delayMillis = 0L;
            answer = CarrierNormalization.NONE;
        }

        /** The waybills asked, normalised, in the order they were asked. */
        static List<String> asked() {
            synchronized (asked) {
                return new ArrayList<>(asked);
            }
        }

        static void clearAsked() {
            asked.clear();
        }

        @Implementation protected void __constructor__(Context ignored) {}

        @Implementation protected CarrierNormalization recognizeCarrier(
                String waybill, ExpressQueryCancellation cancellation) throws Exception {
            return respond(waybill, cancellation, false);
        }

        @Implementation protected CarrierNormalization recognizeCarrier(
                String waybill, ExpressQueryCancellation cancellation, boolean excludeJd)
                throws Exception {
            return respond(waybill, cancellation, false);
        }

        @Implementation protected CarrierNormalization recognizeCarrierInSyncRound(
                String waybill, boolean excludeJd) throws Exception {
            return respond(waybill, null, true);
        }

        private static CarrierNormalization respond(
                String waybill, ExpressQueryCancellation cancellation, boolean syncRound)
                throws Exception {
            calls.incrementAndGet();
            String number = normalized(waybill);
            asked.add(number);
            if (timingOut.contains(number)) {
                if (syncRound) throw new CarrierRecognitionTimeoutException();
                throw new IllegalStateException("网络异常，请稍后重试");
            }
            long delay = hanging.contains(number) ? 3_000L : delayMillis;
            long until = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(delay);
            try {
                while (System.nanoTime() - until < 0L) {
                    if (cancellation != null) cancellation.throwIfCancelled();
                    Thread.sleep(5L);
                }
            } catch (InterruptedException cancelled) {
                aborted.incrementAndGet();
                // As ExpressApi does for its caller.
                Thread.currentThread().interrupt();
                throw cancelled;
            }
            return answers.getOrDefault(number, answer);
        }
    }
}
