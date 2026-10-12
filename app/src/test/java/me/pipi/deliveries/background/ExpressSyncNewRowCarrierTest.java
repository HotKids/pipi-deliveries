package me.pipi.deliveries.background;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressApi;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import me.pipi.deliveries.network.ExpressSubscriptionClient;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.RealObject;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.util.ReflectionHelpers;

/**
 * 代码 5（用户 2026-10-03「照 Pipi / iOS 的做法改」；其余裁决 28、37、42）：an account record that adds a new row is recognised
 * before the round stores its list, so the row is listed with its carrier from the start; a record not recognised this
 * round is stored as it came (raw code, held), and the next round recognises it as an existing row. Existing rows keep
 * today's order (stored, then recognised). Synthetic waybills and phones only.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class, shadows = {
        ExpressSyncNewRowCarrierTest.Subscription.class, ExpressSyncNewRowCarrierTest.Api.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressSyncNewRowCarrierTest {
    private static final String PHONE = "13900005050";
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            .withZone(ZoneId.of("Asia/Shanghai"));
    private static final CarrierNormalization YTO =
            new CarrierNormalization("YTO", "圆通速递", "yuantong", true, "");

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
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface6");
        Subscription.list = new ArrayList<>();
        Api.reset();
    }

    @After public void tearDown() {
        AccountCarrierRecognition.budgetMillisOverride = 0L;
        Api.reset();
        ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void aNewRowIsRecognisedBeforeItIsStoredAndListed() throws Exception {
        String waybill = "YT7700500001";
        Subscription.list = List.of(record(waybill, 30));
        Api.answer = YTO;

        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");

        assertEquals("asked once, before the row existed", List.of(waybill), Api.asked);
        assertEquals(List.of(false), Api.rowExisted);
        ExpressItem row = repository.findByWaybill(waybill, "interface6");
        assertNotNull(row);
        assertFalse(row.carrierPending());
        assertEquals("圆通速递", row.displayCompany());
        assertEquals("the list shows the carrier from its first appearance", "圆通速递",
                listed(row.rowId).displayCompany());
    }

    /** No answer this round: stored as it came (raw code, held), and the next round recognises the existing row. */
    @Test public void aNewRowNotRecognisedIsStoredAsBeforeAndRecognisedNextRound() throws Exception {
        String waybill = "YT7700500002";
        Subscription.list = List.of(record(waybill, 30));
        Api.answer = CarrierNormalization.NONE;

        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");

        assertEquals("not asked again after it was stored this round", List.of(waybill), Api.asked);
        ExpressItem row = repository.findByWaybill(waybill, "interface6");
        assertNotNull("the row is still stored and listed", row);
        assertTrue("its raw code is held as no carrier", row.carrierPending());
        assertEquals("UNKNOWNCODE", row.displayCompany());

        Api.answer = YTO;
        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");
        assertEquals(List.of(waybill, waybill), Api.asked);
        assertEquals("an existing row is recognised after its save, as before", List.of(false, true),
                Api.rowExisted);
        assertFalse(repository.findByWaybill(waybill, "interface6").carrierPending());
    }

    /**
     * 优化 5 续（用户 2026-10-03「第一次识别时记下锚点，之后不变」）：the anchor the row's first recognition sent (its earliest
     * node then) is the one every later recognition sends, though its earliest node moves more than 24 hours; a real
     * deletion clears it.
     */
    @Test public void theAnchorSentStaysTheOneOfTheFirstRecognition() throws Exception {
        String waybill = "YT7700500005";
        String first = minutesAgo(10L * 60L);
        Subscription.list = List.of(new ExpressQueryResult(waybill, "UNKNOWNCODE", "", StatusSemantic.TRANSIT,
                ExpressTimeline.parseTime(first), first, "快件运输中", tracks(first, "快件运输中"), "", PHONE,
                TimelineSlot.V6_LIST, "", "", "DouYin"));
        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");
        long anchor = ExpressTimeline.parseTime(first);
        assertEquals(List.of(anchor), Api.anchors);

        String older = minutesAgo(60L * 60L);
        String newer = minutesAgo(5L);
        Subscription.list = List.of(new ExpressQueryResult(waybill, "UNKNOWNCODE", "", StatusSemantic.TRANSIT,
                ExpressTimeline.parseTime(newer), newer, "快件派送中", new JSONArray()
                .put(new JSONObject().put("time", newer).put("context", "快件派送中"))
                .put(new JSONObject().put("time", first).put("context", "快件运输中"))
                .put(new JSONObject().put("time", older).put("context", "快件已揽收")).toString(), "", PHONE,
                TimelineSlot.V6_LIST, "", "", "DouYin"));
        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");
        ExpressItem row = repository.findByWaybill(waybill, "interface6");
        assertEquals("the row's earliest node moved 50 hours earlier", ExpressTimeline.parseTime(older),
                me.pipi.deliveries.data.WaybillReusePolicy.parcelAnchorAt(row, System.currentTimeMillis()));
        assertEquals("the anchor sent is unchanged", List.of(anchor, anchor), Api.anchors);

        repository.delete(row.rowId);
        assertEquals("", repository.ledgerValue(row.rowId, ExpressRepository.LEDGER_PARCEL_ANCHOR));
    }

    /** The round's 30 s budget is shared: a new row the spent budget cuts off is stored as it came and marked. */
    @Test public void aNewRowCutOffByTheRoundBudgetIsStoredAsItCame() throws Exception {
        AccountCarrierRecognition.budgetMillisOverride = 300L;
        String waybill = "YT7700500003";
        Subscription.list = List.of(record(waybill, 30));
        Api.answer = YTO;
        Api.delayMillis = 3_000L;
        long started = System.nanoTime();

        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");

        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 2_500L);
        ExpressItem row = repository.findByWaybill(waybill, "interface6");
        assertNotNull(row);
        assertTrue(row.carrierPending());
        assertEquals(CarrierRecognitionDeferrals.CUT, CarrierRecognitionDeferrals.get(context).mark(waybill));
        assertEquals("asked once in the round", 1, Api.asked.size());
    }

    /** A record outside the retention window is never stored, so it is not recognised either. */
    @Test public void anExpiredFirstSightingIsNotRecognised() throws Exception {
        String waybill = "YT7700500004";
        String time = minutesAgo(22L * 24L * 60L);
        Subscription.list = List.of(new ExpressQueryResult(waybill, "UNKNOWNCODE", "", StatusSemantic.COMPLETED,
                ExpressTimeline.parseTime(time), time, "已签收", tracks(time, "已签收"), "", PHONE,
                TimelineSlot.V6_LIST, "", "", "DouYin"));
        Api.answer = YTO;

        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");

        assertTrue(Api.asked.isEmpty());
        assertNull(repository.findByWaybill(waybill, "interface6"));
    }

    private ExpressQueryResult record(String waybill, long minutesAgo) throws Exception {
        String time = minutesAgo(minutesAgo);
        return new ExpressQueryResult(waybill, "UNKNOWNCODE", "", StatusSemantic.TRANSIT,
                ExpressTimeline.parseTime(time), time, "快件运输中", tracks(time, "快件运输中"), "", PHONE,
                TimelineSlot.V6_LIST, "", "", "DouYin");
    }

    private ExpressItem listed(long rowId) {
        for (ExpressItem item : repository.listVisible("interface6")) if (item.rowId == rowId) return item;
        throw new AssertionError("the row is not listed");
    }

    private static String minutesAgo(long minutes) {
        return TIME.format(Instant.ofEpochMilli(System.currentTimeMillis() - minutes * 60_000L));
    }

    private static String tracks(String time, String detail) throws Exception {
        return new JSONArray().put(new JSONObject().put("time", time).put("context", detail)).toString();
    }

    @Implements(value = ExpressSubscriptionClient.class, isInAndroidSdk = false)
    public static class Subscription {
        static volatile List<ExpressQueryResult> list = Collections.emptyList();

        @Implementation protected List<ExpressQueryResult> query(Context context) {
            return list;
        }

        @Implementation protected ExpressQueryResult queryManual(Context context, String waybill,
                ExpressQueryCancellation cancellation) {
            return null;
        }
    }

    /** The sync round's recognition: answers {@link #answer} after {@link #delayMillis}, noting whether the row existed. */
    @Implements(value = ExpressApi.class, isInAndroidSdk = false)
    public static class Api {
        static final List<String> asked = new CopyOnWriteArrayList<>();
        static final List<Boolean> rowExisted = new CopyOnWriteArrayList<>();
        /** The parcelAnchorAtMs each recognition would send with its paid request (优化 5). */
        static final List<Long> anchors = new CopyOnWriteArrayList<>();
        @RealObject private ExpressApi real;
        static final Map<String, CarrierNormalization> answers = new ConcurrentHashMap<>();
        static volatile CarrierNormalization answer = CarrierNormalization.NONE;
        static volatile long delayMillis;

        static void reset() {
            asked.clear();
            rowExisted.clear();
            anchors.clear();
            answers.clear();
            answer = CarrierNormalization.NONE;
            delayMillis = 0L;
        }

        @Implementation protected void __constructor__(Context ignored) {}

        @Implementation protected CarrierNormalization recognizeCarrierInSyncRound(String waybill, boolean excludeJd)
                throws Exception {
            String number = waybill.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", "");
            asked.add(number);
            anchors.add(ReflectionHelpers.<Long>getField(real, "parcelAnchorAtMs"));
            rowExisted.add(ExpressRepository.get(RuntimeEnvironment.getApplication())
                    .findByWaybill(number, "interface6") != null);
            long until = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(delayMillis);
            while (System.nanoTime() - until < 0L) Thread.sleep(5L);
            return answers.getOrDefault(number, answer);
        }
    }
}
