package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;
import android.database.DatabaseUtils;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

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

/** The sync caller uses the real API, classifier parser and durable recognition cache. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class, shadows = {
        MissingAccountCarrierRecognitionTest.Subscription.class,
        MissingAccountCarrierRecognitionTest.Detector.class,
        MissingAccountCarrierRecognitionTest.Identity.class,
        MissingAccountCarrierRecognitionTest.Gateway.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class MissingAccountCarrierRecognitionTest {
    private static final String PHONE = "13900005051";
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            .withZone(ZoneId.of("Asia/Shanghai"));
    private Context context;
    private ExpressRepository repository;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        for (String name : new String[]{"deliveries_repository_migrations", "express_account_source",
                "express_network_success", "carrier_recognition_deferred_v1", "carrier_recognition_v1"}) {
            context.getSharedPreferences(name, 0).edit().clear().commit();
        }
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface6");
        Subscription.list = Collections.emptyList();
        Detector.requested.clear();
        Detector.rowExisted.clear();
        Detector.bindingSource = "interface6";
        Gateway.list = new JSONArray();
        Gateway.unexpected = 0;
    }

    @After public void tearDown() {
        ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void interface6CachesAMissingCarrierWithoutEstablishingOwnership() throws Exception {
        verifyMissingCarrierCache("interface6");
    }

    @Test public void interface5CachesAMissingCarrierWithoutEstablishingOwnership() throws Exception {
        ExpressAccountSource.toggle(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        verifyMissingCarrierCache("interface5");
    }

    private void verifyMissingCarrierCache(String bindingSource) throws Exception {
        String waybill = "YT7700500101";
        Detector.bindingSource = bindingSource;
        ExpressQueryResult missing = packet(waybill, "UNKNOWN", StatusSemantic.TRANSIT,
                TimelineSlot.forBindingSource(bindingSource), 30L);
        assertFalse(missing.carrierIdentityEvidence);
        assertFalse(repository.createsAutomaticRow(missing, bindingSource));
        feed(missing, bindingSource);
        sync();
        assertEquals(List.of(waybill), Detector.requested);
        assertEquals(List.of(false), Detector.rowExisted);
        assertAbsent(waybill, bindingSource);

        // A new sync round constructs a new API/coordinator and must reuse the durable cache.
        sync();
        assertEquals(List.of(waybill), Detector.requested);
        assertAbsent(waybill, bindingSource);

        ExpressQueryResult qualified = packet(waybill, "UNKNOWNCODE", StatusSemantic.TRANSIT,
                TimelineSlot.forBindingSource(bindingSource), 30L);
        assertTrue(qualified.carrierIdentityEvidence);
        assertTrue(repository.createsAutomaticRow(qualified, bindingSource));
        feed(qualified, bindingSource);
        sync();
        assertEquals(List.of(waybill), Detector.requested);
        ExpressItem row = repository.findByWaybill(waybill, bindingSource);
        assertNotNull(row);
        assertEquals("UNKNOWNCODE", row.courierCode);
        assertEquals("YTO", row.carrierNormalization.standardCode);
        assertEquals(1, repository.listVisible(bindingSource).size());
        assertEquals(0, Gateway.unexpected);
    }

    @Test public void anUnknownStateDoesNotStartRecognition() throws Exception {
        assertNoRecognition(packet("YT7700500102", "UNKNOWN", StatusSemantic.UNKNOWN,
                TimelineSlot.V6_LIST, 30L));
    }

    @Test public void aDifferentAccountSlotDoesNotStartRecognition() throws Exception {
        assertNoRecognition(packet("YT7700500103", "UNKNOWN", StatusSemantic.TRANSIT,
                TimelineSlot.V5_QUERY, 30L));
    }

    @Test public void anExpiredSignedOrCancelledPacketDoesNotStartRecognition() throws Exception {
        assertNoRecognition(packet("YT7700500104", "UNKNOWN", StatusSemantic.COMPLETED,
                TimelineSlot.V6_LIST, 22L * 24L * 60L));
        assertNoRecognition(packet("YT7700500105", "UNKNOWN", StatusSemantic.CANCELLED,
                TimelineSlot.V6_LIST, 5L * 60L));
    }

    @Test public void anExistingRowStillRecognizesAfterItsAccountSave() throws Exception {
        String waybill = "YT7700500106";
        repository.saveInterface6(packet(waybill, "UNKNOWNCODE", StatusSemantic.TRANSIT,
                TimelineSlot.V6_LIST, 30L), PHONE);
        ExpressItem before = repository.findByWaybill(waybill, "interface6");
        assertNotNull(before);
        feed(packet(waybill, "UNKNOWN", StatusSemantic.TRANSIT, TimelineSlot.V6_LIST, 30L),
                "interface6");
        sync();
        assertEquals(List.of(waybill), Detector.requested);
        assertEquals(List.of(true), Detector.rowExisted);
        ExpressItem after = repository.find(before.rowId);
        assertEquals("UNKNOWN", after.courierCode);
        assertEquals("YTO", after.carrierNormalization.standardCode);
    }

    private void assertNoRecognition(ExpressQueryResult packet) throws Exception {
        feed(packet, "interface6");
        sync();
        assertTrue(Detector.requested.isEmpty());
        assertAbsent(packet.waybill, "interface6");
    }

    private void assertAbsent(String waybill, String bindingSource) {
        assertNull(repository.findByWaybill(waybill, bindingSource));
        assertTrue(repository.listVisible(bindingSource).isEmpty());
        try (ExpressDatabase database = new ExpressDatabase(context)) {
            assertEquals(0L, DatabaseUtils.queryNumEntries(database.getReadableDatabase(),
                    ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE,
                    "normalized_waybill=?", new String[]{waybill}));
        }
    }

    private void feed(ExpressQueryResult packet, String bindingSource) throws Exception {
        Subscription.list = List.of(packet);
        if ("interface5".equals(bindingSource)) {
            Gateway.list = new JSONArray().put(new JSONObject()
                    .put("mailNo", packet.waybill).put("cpCode", packet.courierCode)
                    .put("name", "").put("provider", "DouYin").put("phone", PHONE)
                    .put("stateNum", 104).put("details", new JSONArray().put(new JSONObject()
                            .put("time", packet.latestTime).put("desc", "Synthetic event"))));
        }
    }

    private void sync() throws Exception {
        ReflectionHelpers.callStaticMethod(Class.forName("me.pipi.deliveries.background.ExpressSyncEngine"),
                "syncAll", ReflectionHelpers.ClassParameter.from(Context.class, context),
                ReflectionHelpers.ClassParameter.from(int[].class, new int[3]),
                ReflectionHelpers.ClassParameter.from(boolean.class, false),
                ReflectionHelpers.ClassParameter.from(String.class, "background"));
    }

    private static ExpressQueryResult packet(String waybill, String code, StatusSemantic semantic,
            String slot, long minutesAgo) throws Exception {
        String time = TIME.format(Instant.ofEpochMilli(System.currentTimeMillis() - minutesAgo * 60_000L));
        return new ExpressQueryResult(waybill, code, "", semantic, ExpressTimeline.parseTime(time),
                time, "Synthetic event", new JSONArray().put(new JSONObject().put("time", time)
                        .put("context", "Synthetic event")).toString(), "", PHONE, slot, "", "", "DouYin");
    }

    @Implements(ExpressSubscriptionClient.class)
    public static class Subscription {
        static List<ExpressQueryResult> list;
        @Implementation protected List<ExpressQueryResult> query(Context context) { return list; }
        @Implementation protected ExpressQueryResult queryManual(Context context, String waybill,
                ExpressQueryCancellation cancellation) { return null; }
    }

    @Implements(ExpressInstallIdentity.class)
    public static class Identity {
        @Implementation protected static JSONObject get(Context context) throws Exception {
            return new JSONObject().put("userId", "1234567890")
                    .put("oaid", "0123456789abcdef").put("vaid", "fedcba9876543210");
        }
    }

    @Implements(Kuaidi100CarrierDetector.class)
    public static class Detector {
        static final List<String> requested = new CopyOnWriteArrayList<>();
        static final List<Boolean> rowExisted = new CopyOnWriteArrayList<>();
        static String bindingSource;
        @RealObject private Kuaidi100CarrierDetector real;

        @Implementation protected void __constructor__() {
            ReflectionHelpers.setField(real, "transport", (Kuaidi100CarrierDetector.Transport) (url, cancellation) -> {
                cancellation.throwIfCancelled();
                String waybill = url.substring(url.indexOf("?text=") + 6);
                requested.add(waybill);
                rowExisted.add(ExpressRepository.get(RuntimeEnvironment.getApplication())
                        .findByWaybill(waybill, bindingSource) != null);
                return new HttpClient.Response(200,
                        "[{\"comCode\":\"yuantong\"}]".getBytes(StandardCharsets.UTF_8));
            });
        }
    }

    @Implements(ExpressGatewayClient.class)
    public static class Gateway {
        static JSONArray list;
        static int unexpected;
        @Implementation protected void __constructor__(Context context) {}
        @Implementation protected boolean configured() { return true; }
        @Implementation protected HttpClient.Response post(String path, JSONObject payload) throws Exception {
            return post(path, payload, null);
        }
        @Implementation protected HttpClient.Response post(String path, JSONObject payload,
                ExpressQueryCancellation cancellation) throws Exception {
            if ("/api/express/accounts/sync".equals(path)) {
                return new HttpClient.Response(200, new JSONObject().put("code", 0)
                        .put("data", new JSONObject().put("expressList", list))
                        .toString().getBytes(StandardCharsets.UTF_8));
            }
            unexpected++;
            throw new AssertionError("Unexpected gateway request in synthetic recognition test");
        }
    }
}
