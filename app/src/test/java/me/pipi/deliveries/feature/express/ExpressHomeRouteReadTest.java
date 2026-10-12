package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Set;

import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.WorkerStatusProjection;
import me.pipi.deliveries.security.KeystoreSecretBox;

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
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

/** Home can defer display-only routes without changing its existing order projection work. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class,
        shadows = ExpressHomeRouteReadTest.SyntheticSecretBox.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressHomeRouteReadTest {
    private static final String PHONE = "13800007771";
    private static final String ROUTE = "https://order.jd.com/detail?token=synthetic-home";
    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;
    private long eventAt;
    private String eventTime;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        database = new ExpressDatabase(context);
        repository = ReflectionHelpers.callConstructor(ExpressRepository.class,
                ClassParameter.from(Context.class, context),
                ClassParameter.from(ExpressDatabase.class, database));
        repository.bindPhoneLocally(PHONE, "interface5");
        repository.bindPhoneLocally(PHONE, "interface6");
        eventAt = (System.currentTimeMillis() / 1000L - 60L) * 1000L;
        eventTime = java.time.format.DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm:ss")
                .withZone(java.time.ZoneId.of("Asia/Shanghai"))
                .format(java.time.Instant.ofEpochMilli(eventAt));
        SyntheticSecretBox.decryptCalls = 0;
        SyntheticSecretBox.fail = false;
    }

    @After public void tearDown() {
        database.close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void ordinaryHomeDisplayDoesNotDecryptItsDetailRoute() throws Exception {
        long row = insert("ZTHOME0001", "INTERFACE5", "INTERFACE5", false,
                encrypted(ROUTE), "快件派送中", StatusSemantic.DELIVERY);

        ExpressItem shown = onlyHome();

        assertEquals("display does not need a credential client round trip", 0,
                SyntheticSecretBox.decryptCalls);
        assertEquals(row, shown.rowId);
        assertEquals("", shown.routeCredential);
        assertFalse("deferred fields are unavailable in the Home-only view",
                shown.routeCredentialAvailable);
        assertEquals(encrypted(ROUTE), storedRoute(row));
    }

    @Test public void sharedStoredAndDetailReadsStillCarryTheCompleteRoute() throws Exception {
        long row = insert("ZTHOME0002", "INTERFACE5", "INTERFACE5", false,
                encrypted(ROUTE), "快件派送中", StatusSemantic.DELIVERY);

        assertFullRoute(repository.listVisible("interface5").get(0));
        assertFullRoute(repository.listVisibleAsStored("interface5").get(0));
        assertFullRoute(repository.find(row));
        assertEquals("all three shared reads keep the original client path", 3,
                SyntheticSecretBox.decryptCalls);
        assertEquals(encrypted(ROUTE), storedRoute(row));
    }

    @Test public void pendingOrdersRetainRoutesForBothSourceAndOwnerTags() throws Exception {
        String[][] tags = {{"I5-JD", "INTERFACE5"}, {"INTERFACE5", "I5-JD"},
                {"I6-JD", "INTERFACE6"}, {"INTERFACE6", "I6-JD"},
                {" i5-jd ", "INTERFACE5"}, {"INTERFACE6", " i6-jd "}};
        for (int i = 0; i < tags.length; i++) {
            insert("3630448013827" + i, tags[i][0], tags[i][1], false,
                    encrypted(ROUTE), "您的订单已由承运商揽收", StatusSemantic.PICKED);
        }

        List<ExpressItem> home = repository.listVisibleForHome("");

        assertEquals(tags.length, home.size());
        assertEquals(tags.length, SyntheticSecretBox.decryptCalls);
        for (ExpressItem item : home) {
            assertTrue(item.isAccountOrder());
            assertEquals("", item.projectedWaybill);
            assertFullRoute(item);
        }
    }

    @Test public void manualRowsWithOrderTagsDeferRoutesAndStayNonOrders() throws Exception {
        insert("MANUALHOME0003", "I5-JD", "I5-JD", true,
                encrypted(ROUTE), "快件派送中", StatusSemantic.DELIVERY);

        ExpressItem shown = onlyHome();

        assertFalse(shown.isAccountOrder());
        assertEquals(0, SyntheticSecretBox.decryptCalls);
        assertEquals("", shown.routeCredential);
        assertFalse(shown.routeCredentialAvailable);
    }

    @Test public void anActualSavedWaybillProjectionDefersOnlyTheHomeRoute() throws Exception {
        long row = insert("3630448013827774", "I5-JD", "I5-JD", false,
                encrypted(ROUTE), "您的订单已由承运商揽收", StatusSemantic.PICKED);
        ExpressItem pending = repository.find(row);
        assertTrue(repository.saveOrderProjection(pending, "interface5", "STHOME7774", "申通快递"));
        SyntheticSecretBox.decryptCalls = 0;

        ExpressItem shown = onlyHome();

        assertTrue(shown.isAccountOrder());
        assertEquals("STHOME7774", shown.projectedWaybill);
        assertEquals("STHOME7774", shown.displayWaybill());
        assertEquals(0, SyntheticSecretBox.decryptCalls);
        assertFalse(shown.routeCredentialAvailable);
        assertEquals("", shown.routeCredential);
        assertFullRoute(repository.find(row));
    }

    @Test public void aTextIdentityPendingOrderKeepsItsProjectionGateAndRetryFingerprint() throws Exception {
        insert("3630448013827775", "I5-JD", "I5-JD", false,
                encrypted(ROUTE), "待出库交付申通快递，运单号为770018906334362", StatusSemantic.SHIPPED);
        ExpressItem original = repository.listVisible("interface5").get(0);
        SyntheticSecretBox.decryptCalls = 0;

        ExpressItem home = onlyHome();

        assertEquals(1, SyntheticSecretBox.decryptCalls);
        assertFullRoute(home);
        assertTrue(ExpressHomeOrderProjectionCapture.needsProjection(home, true));
        assertNotNull(ExpressOrderTextIdentity.fromTracksJson(home.tracksJson, home.waybill));
        assertEquals(ExpressOrderProjectionRetryStore.routeFingerprint(original),
                ExpressOrderProjectionRetryStore.routeFingerprint(home));
        assertEquals(attemptKey(original), attemptKey(home));
        assertSame(home, ExpressListActivity.nextOrderProjectionCandidate(List.of(home),
                new java.util.HashSet<>()));
    }

    @Test public void pendingEmptyAndUnreadableRoutesKeepTheirOriginalAvailability() throws Exception {
        long empty = insert("3630448013827776", "I5-JD", "I5-JD", false,
                "", "您的订单已由承运商揽收", StatusSemantic.PICKED);
        long unreadable = insert("3630448013827777", "I5-JD", "I5-JD", false,
                encrypted(ROUTE), "您的订单已由承运商揽收", StatusSemantic.PICKED);
        SyntheticSecretBox.fail = true;

        List<ExpressItem> home = repository.listVisibleForHome("interface5");

        assertEquals(2, home.size());
        assertEquals(1, SyntheticSecretBox.decryptCalls);
        for (ExpressItem item : home) {
            assertEquals("", item.routeCredential);
            assertEquals(item.rowId == empty, item.routeCredentialAvailable);
            assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(item, true));
        }
        assertEquals(encrypted(ROUTE), storedRoute(unreadable));
    }

    @Test public void homePreservesEveryOtherVisibleFieldAndCanonicalOrder() throws Exception {
        insert("ZTHOME7778", "INTERFACE5", "INTERFACE5", false,
                encrypted(ROUTE), "快件运输中", StatusSemantic.TRANSIT);
        insert("ZTHOME7779", "INTERFACE5", "INTERFACE5", false,
                encrypted(ROUTE), "快件派送中", StatusSemantic.DELIVERY);
        insert("3630448013827780", "I5-JD", "I5-JD", false,
                encrypted(ROUTE), "您的订单已由承运商揽收", StatusSemantic.PICKED);
        List<ExpressItem> original = repository.listVisible("interface5");

        List<ExpressItem> home = repository.listVisibleForHome("interface5");

        assertEquals(original.size(), home.size());
        for (int i = 0; i < original.size(); i++) {
            ExpressItem expected = original.get(i), actual = home.get(i);
            for (Field field : ExpressItem.class.getFields()) {
                if (Modifier.isStatic(field.getModifiers()) || Set.of("routeCredential",
                        "routeCredentialAvailable", "carrierNormalization").contains(field.getName())) continue;
                assertEquals(field.getName(), field.get(expected), field.get(actual));
            }
            for (Field field : expected.carrierNormalization.getClass().getFields()) {
                if (!Modifier.isStatic(field.getModifiers())) assertEquals(field.getName(),
                        field.get(expected.carrierNormalization), field.get(actual.carrierNormalization));
            }
            assertEquals(expected.displayStatus(), actual.displayStatus());
            assertEquals(expected.displayWaybill(), actual.displayWaybill());
        }
    }

    private long insert(String identity, String source, String owner, boolean manual,
            String storedRoute, String detail, StatusSemantic semantic) throws Exception {
        boolean order = source.trim().equalsIgnoreCase("I5-JD") || source.trim().equalsIgnoreCase("I6-JD")
                || owner.trim().equalsIgnoreCase("I5-JD") || owner.trim().equalsIgnoreCase("I6-JD");
        String tracks = new JSONArray().put(new JSONObject().put("time", eventTime)
                .put("context", detail).put("status", semantic.name())).toString();
        WorkerStatusProjection status = WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1)
                        .put("scope", order ? "ORDER" : "PARCEL").put("semantic", semantic.name())
                        .put("code", "SERVER_ENUM").put("text", semantic.label).put("priority", 0)
                        .put("eventAtMs", eventAt).put("structured", true)));
        ContentValues values = new ContentValues();
        values.put("mailNo", identity);
        values.put("normalizedMailNo", identity);
        values.put("subPhone", PHONE);
        values.put("senderPhone", PHONE);
        values.put("listOriginAtMs", eventAt - 60_000L);
        values.put("cpCode", order ? "JDKD" : "ZTO");
        values.put("cpName", order ? "京东购物" : "中通快递");
        values.put("fromCp", source);
        values.put("stateOwner", owner);
        values.put("data1", order ? "JingDong" : "ZhongTong");
        values.put("data3", manual ? "manual" : "");
        values.put("logsiticsStatus", semantic.storageCode);
        values.put("logisticsStatusDesc", semantic.label);
        values.put("statusEventTime", eventAt);
        values.put("logisticsGmtModified", eventTime);
        values.put("lastLogisticDetail", detail);
        values.put("packageDyn", WorkerStatusProjection.attach(tracks, status));
        values.put("routeOwner", owner);
        values.put("routeInterface", "v5");
        values.put("routeCredential", storedRoute);
        values.put("canShow", 1);
        values.put("isDeleted", 0);
        values.put("updatedAt", eventAt);
        return database.getWritableDatabase().insertOrThrow(ExpressDatabase.EXPRESS_TABLE, null, values);
    }

    private ExpressItem onlyHome() {
        List<ExpressItem> home = repository.listVisibleForHome("");
        assertEquals(1, home.size());
        return home.get(0);
    }

    private String storedRoute(long row) {
        try (Cursor cursor = database.getWritableDatabase().query(ExpressDatabase.EXPRESS_TABLE,
                new String[]{"routeCredential"}, "_id=?", new String[]{Long.toString(row)},
                null, null, null)) {
            assertTrue(cursor.moveToFirst());
            return cursor.getString(0);
        }
    }

    private static String attemptKey(ExpressItem item) {
        return ReflectionHelpers.callStaticMethod(ExpressListActivity.class, "orderProjectionAttemptKey",
                ClassParameter.from(ExpressItem.class, item));
    }

    private static void assertFullRoute(ExpressItem item) {
        assertNotNull(item);
        assertTrue(item.routeCredentialAvailable);
        assertEquals(ROUTE, item.routeCredential);
    }

    private static String encrypted(String text) {
        return "enc:v1:" + Base64.getEncoder().encodeToString(text.getBytes(StandardCharsets.UTF_8));
    }

    @Implements(KeystoreSecretBox.class)
    public static class SyntheticSecretBox {
        static int decryptCalls;
        static boolean fail;
        @Implementation public static String encrypt(String ignored, String value) {
            return Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8));
        }
        @Implementation public static String decrypt(String ignored, String value) {
            decryptCalls++;
            if (fail) throw new IllegalStateException("Synthetic route decryption unavailable");
            return new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);
        }
    }
}
