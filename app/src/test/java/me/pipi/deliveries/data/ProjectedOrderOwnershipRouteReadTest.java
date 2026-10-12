package me.pipi.deliveries.data;

import static org.junit.Assert.*;
import static me.pipi.deliveries.FixtureDay.at;

import android.app.Application;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import me.pipi.deliveries.BuildConfig;
import me.pipi.deliveries.model.CainiaoRoute;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;
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

/** The beta audit retains the canonical row decoder without opening unused detail routes. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class,
        shadows = ProjectedOrderOwnershipRouteReadTest.SyntheticSecretBox.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ProjectedOrderOwnershipRouteReadTest {
    private static final String PHONE = "13800000579";
    private static final String ORDER = "3630448013820579";
    private static final String WAYBILL = "YT1234567897051";
    private static final String ROUTE = "https://order.jd.com/detail?token=synthetic-audit";
    private static final String RESTORE_ROUTE = "https://order.jd.com/detail?token=synthetic-restore";
    private ProjectedOrderOwnershipRepairTest fixture;
    private ExpressRepository repository;
    private ExpressDatabase database;

    @Before public void setUp() {
        Context context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("express_detail_selection", 0).edit().clear().commit();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "detailSelections", null);
        fixture = new ProjectedOrderOwnershipRepairTest();
        fixture.setUp();
        repository = ReflectionHelpers.getField(fixture, "repository");
        database = ReflectionHelpers.getField(fixture, "database");
        SyntheticSecretBox.calls.clear();
        SyntheticSecretBox.fail = false;
    }

    @After public void tearDown() { fixture.tearDown(); }

    @Test public void betaDryRunSkipsTheUnusedRouteOfAHealthyParcel() {
        ExpressItem parcel = fixtureParcel();
        setRoute(parcel.rowId, ROUTE);
        List<String> before = snapshot();
        SyntheticSecretBox.calls.clear();

        ExpressRepository.OwnershipRepairResult result = repository.repairProjectedOrderOwnership(false);

        assertEquals(0, result.found);
        assertEquals(0, result.applied);
        assertEquals(0, result.pending);
        assertEquals(before, snapshot());
        assertEquals(BuildConfig.VERSION_NAME.contains("-beta") ? 0 : 1, calls(ROUTE));
        assertFullRoute(repository.find(parcel.rowId), ROUTE);
        assertEquals(encrypted(ROUTE), column(ExpressDatabase.EXPRESS_TABLE,
                "routeCredential", "_id", Long.toString(parcel.rowId)));
    }

    @Test public void betaDryRunSkipsRejectedManualOrderCandidates() {
        Object damaged = damaged();
        long orderRowId = ReflectionHelpers.getField(damaged, "orderRowId");
        ContentValues manual = new ContentValues();
        try (Cursor cursor = db().query(ExpressDatabase.EXPRESS_TABLE, null, "_id=?",
                new String[]{Long.toString(orderRowId)}, null, null, null)) {
            assertTrue(cursor.moveToFirst());
            DatabaseUtils.cursorRowToContentValues(cursor, manual);
        }
        manual.remove("_id");
        manual.put("data3", "manual");
        manual.put("routeCredential", encrypted(ROUTE));
        db().insertOrThrow(ExpressDatabase.EXPRESS_TABLE, null, manual);
        List<String> before = snapshot();
        SyntheticSecretBox.calls.clear();

        ExpressRepository.OwnershipRepairResult result = repository.repairProjectedOrderOwnership(false);

        assertEquals(1, result.found);
        assertEquals(0, result.applied);
        assertEquals(0, result.pending);
        assertEquals(before, snapshot());
        assertEquals(BuildConfig.VERSION_NAME.contains("-beta") ? 0 : 1, calls(ROUTE));
        assertRepairAction("restore_waybill_from_package");
    }

    @Test public void betaDryRunDefersThePendingOrderRouteAndKeepsTheSamePlan() {
        Object damaged = damaged();
        long rowId = ReflectionHelpers.getField(damaged, "rowId");
        setRoute(rowId, ROUTE);
        List<String> before = snapshot();
        SyntheticSecretBox.calls.clear();

        ExpressRepository.OwnershipRepairResult result = repository.repairProjectedOrderOwnership(false);

        assertEquals(1, result.found);
        assertEquals(0, result.applied);
        assertEquals(0, result.pending);
        int auditCalls = BuildConfig.VERSION_NAME.contains("-beta") ? 0 : 1;
        assertEquals(auditCalls, calls(ROUTE));
        assertEquals(before, snapshot());
        assertRepairAction("restore_waybill_from_package");
        assertFullRoute(repository.find(rowId), ROUTE);
        assertEquals(auditCalls + 1, calls(ROUTE));
    }

    @Test public void anUnreadablePendingOrderRouteDoesNotEnterTheBetaAuditClient() {
        Object damaged = damaged();
        long rowId = ReflectionHelpers.getField(damaged, "rowId");
        setRoute(rowId, ROUTE);
        List<String> before = snapshot();
        SyntheticSecretBox.calls.clear();
        SyntheticSecretBox.fail = true;

        ExpressRepository.OwnershipRepairResult result = repository.repairProjectedOrderOwnership(false);

        assertEquals(1, result.found);
        assertEquals(0, result.applied);
        assertEquals(0, result.pending);
        assertEquals(BuildConfig.VERSION_NAME.contains("-beta") ? 0 : 1, calls(ROUTE));
        assertEquals(before, snapshot());
        assertRepairAction("restore_waybill_from_package");
        SyntheticSecretBox.fail = false;
        assertFullRoute(repository.find(rowId), ROUTE);
    }

    @Test public void appliedRepairStillReadsAndRestoresCompleteRoutes() {
        Object damaged = damaged();
        long rowId = ReflectionHelpers.getField(damaged, "rowId");
        setRoute(rowId, ROUTE);
        ContentValues observation = new ContentValues();
        observation.put("route_credential", encrypted(RESTORE_ROUTE));
        observation.put("route_interface", "v5");
        observation.put("detail_url", CainiaoRoute.token("v5"));
        assertEquals(1, db().update(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE, observation,
                "record_key=?", new String[]{WAYBILL}));
        SyntheticSecretBox.calls.clear();

        ExpressRepository.OwnershipRepairResult result = repository.repairProjectedOrderOwnership(true);

        assertEquals(1, result.found);
        assertEquals(1, result.applied);
        assertEquals(0, result.pending);
        assertEquals(1, calls(ROUTE));
        assertTrue(calls(RESTORE_ROUTE) > 0);
        ExpressItem restored = repository.find(rowId);
        assertEquals(WAYBILL, restored.waybill);
        assertFullRoute(restored, RESTORE_ROUTE);
        assertEquals(encrypted(RESTORE_ROUTE), column(ExpressDatabase.EXPRESS_TABLE,
                "routeCredential", "_id", Long.toString(rowId)));
    }

    @Test public void dryRunKeepsLegacyForeignCleanupAndPendingOrderRoutes() throws Exception {
        verifyForeignCleanup(false);
    }

    @Test public void appliedAuditKeepsTheSameLegacyForeignCleanup() throws Exception {
        verifyForeignCleanup(true);
    }

    private void verifyForeignCleanup(boolean apply) throws Exception {
        ExpressItem owner = fixtureOrder();
        repository.rememberDetailSelection(owner, TimelineSlot.K100_H5);
        long origin = ExpressSourcePolicy.parseEventTime(at("2026-09-23 12:30:00"));
        long old = origin - 3L * 86_400_000L;
        String oldTime = java.time.format.DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm:ss")
                .withZone(java.time.ZoneId.of("Asia/Shanghai"))
                .format(java.time.Instant.ofEpochMilli(old));
        String tracks = new JSONArray().put(new JSONObject().put("time", oldTime)
                .put("context", "Synthetic foreign parcel delivered")).toString();
        ContentValues foreign = new ContentValues();
        foreign.put("owner_row_id", owner.rowId);
        foreign.put("normalized_waybill", ORDER);
        foreign.put("binding_source", "interface5");
        foreign.put("provider", TimelineSlot.K100_H5);
        foreign.put("waybill", ORDER);
        foreign.put("status_code", StatusSemantic.COMPLETED.storageCode);
        foreign.put("status_event_time", old);
        foreign.put("structured_status", 1);
        foreign.put("latest_time", oldTime);
        foreign.put("latest_detail", "Synthetic foreign parcel delivered");
        foreign.put("tracks_json", tracks);
        foreign.put("success_at", origin);
        db().insertOrThrow(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null, foreign);
        ContentValues route = new ContentValues();
        route.put("owner_row_id", owner.rowId);
        route.put("normalized_waybill", ORDER);
        route.put("owner_source", owner.source);
        route.put("owner_source_provider", owner.sourceProvider);
        route.put("binding_source", "interface5");
        route.put("binding_generation", repository.bindingGeneration(PHONE, "interface5"));
        route.put("provider", TimelineSlot.K100_H5);
        route.put("detail_url", "https://www.kuaidi100.com/synthetic");
        route.put("success_at", origin);
        db().insertOrThrow(ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE, null, route);
        ContentValues latch = new ContentValues();
        latch.put("signedRetainedAt", old);
        latch.put("listOriginAtMs", origin);
        latch.put("routeCredential", encrypted(ROUTE));
        db().update(ExpressDatabase.EXPRESS_TABLE, latch, "_id=?",
                new String[]{Long.toString(owner.rowId)});
        ContentValues ownership = new ContentValues();
        ownership.put("normalized_waybill", ORDER);
        ownership.put("owner_provider", "INTERFACE5");
        ownership.put("owner_phone", PHONE);
        ownership.put("owner_binding_generation", repository.bindingGeneration(PHONE, "interface5"));
        ownership.put("owner_row_id", owner.rowId);
        ownership.put("owner_record_key", ORDER);
        ownership.put("display_frozen", 1);
        db().insertWithOnConflict(ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, null, ownership,
                SQLiteDatabase.CONFLICT_REPLACE);
        SyntheticSecretBox.calls.clear();

        ExpressRepository.OwnershipRepairResult result = repository.repairProjectedOrderOwnership(apply);

        assertEquals(0, result.found);
        assertEquals(0, result.applied);
        assertEquals(0, result.pending);
        int auditCalls = !apply && BuildConfig.VERSION_NAME.contains("-beta") ? 0 : 1;
        assertEquals(auditCalls, calls(ROUTE));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE));
        assertEquals("", ExpressRepository.preferredDetailProvider(owner));
        assertEquals("0", column(ExpressDatabase.EXPRESS_TABLE,
                "signedRetainedAt", "_id", Long.toString(owner.rowId)));
        assertEquals("0", column(ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE,
                "display_frozen", "owner_row_id", Long.toString(owner.rowId)));
        assertEquals(encrypted(ROUTE), column(ExpressDatabase.EXPRESS_TABLE,
                "routeCredential", "_id", Long.toString(owner.rowId)));
        assertEquals(ORDER, column(ExpressDatabase.EXPRESS_TABLE,
                "mailNo", "_id", Long.toString(owner.rowId)));
        assertFullRoute(repository.find(owner.rowId), ROUTE);
        assertEquals(auditCalls + 1, calls(ROUTE));
    }

    private ExpressItem fixtureParcel() {
        String[][] tracks = ReflectionHelpers.callStaticMethod(ProjectedOrderOwnershipRepairTest.class,
                "parcelTransit");
        return ReflectionHelpers.callInstanceMethod(fixture, "parcel",
                ClassParameter.from(StatusSemantic.class, StatusSemantic.TRANSIT),
                ClassParameter.from(String[][].class, tracks));
    }

    private ExpressItem fixtureOrder() {
        String[][] tracks = ReflectionHelpers.callStaticMethod(ProjectedOrderOwnershipRepairTest.class,
                "orderNodes");
        return ReflectionHelpers.callInstanceMethod(fixture, "order",
                ClassParameter.from(String.class, ORDER),
                ClassParameter.from(StatusSemantic.class, StatusSemantic.TRANSIT),
                ClassParameter.from(String[][].class, tracks));
    }

    private Object damaged() {
        return ReflectionHelpers.callInstanceMethod(fixture, "overwrittenWaybillRow");
    }

    private List<String> snapshot() {
        return ReflectionHelpers.callInstanceMethod(fixture, "snapshot",
                ClassParameter.from(String[].class, new String[0]));
    }

    private void assertRepairAction(String action) {
        String line = ReflectionHelpers.callInstanceMethod(fixture, "onlyRepairLine",
                ClassParameter.from(String.class, "ownership.repair.dry_run"));
        assertTrue(line, line.contains(" action=" + action + " "));
    }

    private SQLiteDatabase db() { return database.getWritableDatabase(); }

    private void setRoute(long rowId, String route) {
        ContentValues value = new ContentValues();
        value.put("routeCredential", encrypted(route));
        assertEquals(1, db().update(ExpressDatabase.EXPRESS_TABLE, value, "_id=?",
                new String[]{Long.toString(rowId)}));
    }

    private int count(String table) {
        return (int) DatabaseUtils.longForQuery(db(), "SELECT COUNT(*) FROM " + table, null);
    }

    private String column(String table, String column, String key, String value) {
        try (Cursor cursor = db().query(table, new String[]{column}, key + "=?",
                new String[]{value}, null, null, null)) {
            assertTrue(cursor.moveToFirst());
            return cursor.getString(0);
        }
    }

    private static void assertFullRoute(ExpressItem item, String route) {
        assertNotNull(item);
        assertTrue(item.routeCredentialAvailable);
        assertEquals(route, item.routeCredential);
    }

    private static int calls(String route) {
        return SyntheticSecretBox.calls.getOrDefault(encoded(route), 0);
    }

    private static String encoded(String value) {
        return Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static String encrypted(String value) { return "enc:v1:" + encoded(value); }

    @Implements(KeystoreSecretBox.class)
    public static final class SyntheticSecretBox {
        static final Map<String, Integer> calls = new HashMap<>();
        static boolean fail;
        @Implementation public static String encrypt(String ignored, String value) { return encoded(value); }
        @Implementation public static String decrypt(String ignored, String value) {
            calls.put(value, calls.getOrDefault(value, 0) + 1);
            if (fail) throw new IllegalStateException("Synthetic route decryption unavailable");
            return new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);
        }
    }
}
