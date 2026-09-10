package me.pipi.deliveries.data;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.Context;
import android.database.Cursor;

import me.pipi.deliveries.model.CainiaoRoute;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.ManualQuerySuccess;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

import java.lang.reflect.Method;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressAccountQueryCommitTest {
    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;
    private final String phone = "13800000001";
    private final String order = "3999999000000084";
    private final String real = "JD9990000000084";

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        database = new ExpressDatabase(context);
        database.getWritableDatabase();
        repository = new ExpressRepository(context, database);
        repository.bindPhoneLocally(phone, "interface5");
    }

    @After
    public void tearDown() {
        database.close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test
    public void staleOrderDetailCannotWriteAfterRebind() {
        String now = time(1000);
        String stale = repository.bindingGeneration(phone, "interface5");
        ExpressQueryResult feed = result(order, StatusSemantic.TRANSIT, now,
                "Current feed", tracks(now, "Current feed"));
        repository.saveInterface5OrderSummary(feed, phone, stale);
        repository.unbindPhone(phone, "interface5");
        repository.bindPhoneLocally(phone, "interface5");
        String current = repository.bindingGeneration(phone, "interface5");
        assertNotEquals(stale, current);
        repository.saveInterface5OrderSummary(feed, phone, current);
        ExpressItem owner = repository.findByWaybill(order, "interface5");
        assertNotNull(owner);
        assertFalse(repository.saveInterface5Query(result(order, StatusSemantic.TRANSIT, now,
                "Stale detail", tracks(now, "Stale detail")), owner, stale));
        assertNull(repository.accountTimeline(order, "interface5"));
        assertTrue(repository.saveInterface5Query(result(order, StatusSemantic.TRANSIT, now,
                "Current detail", tracks(now, "Current detail")), owner, current));
        assertTrue(repository.accountTimeline(order, "interface5").tracksJson.contains("Current detail"));
    }

    @Test
    public void deletedAndRecreatedOwnerRejectsOldQueryWithoutUnbinding() {
        String now = time(1000);
        ExpressQueryResult feed = result(order, StatusSemantic.TRANSIT, now,
                "Current feed", tracks(now, "Current feed"));
        repository.saveInterface5OrderSummary(feed, phone);
        ExpressItem old = repository.findByWaybill(order, "interface5");
        repository.delete(old.rowId);
        repository.saveInterface5OrderSummary(feed, phone);
        assertNotEquals(old.rowId, repository.findByWaybill(order, "interface5").rowId);
        assertFalse(repository.saveInterface5Query(feed, old,
                repository.bindingGeneration(phone, "interface5")));
        assertNull(repository.accountTimeline(order, "interface5"));
    }

    @Test
    public void signedBackgroundQueryStopsBeforeCacheAgeChecks() throws Exception {
        String now = time(1000);
        repository.saveInterface5(result(real, StatusSemantic.COMPLETED, now, "已签收", "[]"), phone);
        ExpressItem owner = repository.findByWaybill(real, "interface5");
        assertNotNull(owner);
        Method gate = Class.forName("me.pipi.deliveries.network.ExpressDiscoveryClient")
                .getDeclaredMethod("shouldQueryDetails", String.class, String.class,
                        ExpressItem.class, long.class, long.class, boolean.class);
        gate.setAccessible(true);
        long clock = System.currentTimeMillis();
        assertEquals(Boolean.FALSE, gate.invoke(null, "same", "same", owner,
                clock - 7 * 3600000L, clock, false));
    }

    @Test
    public void listFeedCannotCreateIndependentQuerySlot() {
        String now = time(1000);
        ExpressQueryResult list = cainiao(real, StatusSemantic.TRANSIT, now,
                "List-only feed node");
        repository.saveInterface5(list, phone);
        assertNull(repository.accountTimeline(real, "interface5"));
        ExpressItem owner = repository.findByWaybill(real, "interface5");
        assertTrue(repository.saveInterface5Query(cainiao(real, StatusSemantic.COMPLETED, now,
                "Query-only node").withManualStatusEvidence("Signed", true),
                owner, repository.bindingGeneration(phone, "interface5")));
        ExpressQueryResult sidecar = repository.accountTimeline(real, "interface5");
        assertFalse(sidecar.tracksJson.contains("List-only feed node"));
        assertTrue(sidecar.tracksJson.contains("Query-only node"));
        ExpressItem after = repository.findByWaybill(real, "interface5");
        assertEquals(StatusSemantic.TRANSIT, after.sourceSemantic);
        assertEquals(owner.latestDetail, after.latestDetail);
        assertEquals(owner.statusEventTime, after.statusEventTime);
        assertEquals(owner.tracksJson, after.tracksJson);
    }

    @Test
    public void signedPartialDisplayReceivesExplicitHistory() throws Exception {
        verifyProjectedSignedDetail(true);
    }

    @Test
    public void structuredQueryStatusSurvivesReloadAndOnlyFillsMissingOwnerStatus() {
        ExpressItem owner = unknownOwner();
        String queryTime = time(1000);
        ExpressQueryResult query = cainiao(real, StatusSemantic.DELIVERY, queryTime,
                "Query event").withManualStatusEvidence("Out for delivery", true);
        assertTrue(repository.saveInterface5Query(query, owner,
                repository.bindingGeneration(phone, "interface5")));
        database.close();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        ExpressQueryResult cached = repository.accountTimeline(real, "interface5");
        assertTrue("The query status enum must survive persistence", cached.structuredStatusEvidence);
        assertEquals(query.statusEventTime, cached.statusEventTime);
        assertEquals(query.statusDescription, cached.statusDescription);
        for (ExpressItem shown : new ExpressItem[]{repository.find(owner.rowId),
                repository.listVisible("interface5").get(0)}) {
            assertEquals(StatusSemantic.DELIVERY, shown.semantic);
            assertEquals(query.statusEventTime, shown.statusEventTime);
            assertEquals(StatusSemantic.UNKNOWN, shown.sourceSemantic);
            assertEquals(owner.latestDetail, shown.latestDetail);
            assertEquals(owner.tracksJson, shown.tracksJson);
        }
        assertEquals(StatusSemantic.UNKNOWN, repository.automaticSourceTimeline(owner).semantic);
    }

    @Test
    public void undatedStatusOnlyQueryDoesNotBorrowTheHeadlineTime() {
        ExpressItem owner = unknownOwner();
        ExpressQueryResult query = new ExpressQueryResult(real, "ZTO", "中通快递",
                StatusSemantic.COMPLETED, 0L, time(1000), "", "[]", "", phone,
                "v5_query", "", "", "CaiNiao").withManualStatusEvidence("Signed", true);
        assertTrue(repository.saveInterface5Query(query, owner,
                repository.bindingGeneration(phone, "interface5")));
        assertTrue(repository.saveInterface5Query(query, owner,
                repository.bindingGeneration(phone, "interface5")));
        assertEquals(0L, repository.accountTimeline(real, "interface5").statusEventTime);
        assertEquals(StatusSemantic.COMPLETED, repository.find(owner.rowId).semantic);
        assertEquals(0L, repository.find(owner.rowId).statusEventTime);
        long retainedAt = repository.find(owner.rowId).signedRetainedAt;
        assertTrue(retainedAt > 0L);
        ExpressQueryResult newer = cainiao(real, StatusSemantic.TRANSIT, time(0), "Later transit")
                .withManualStatusEvidence("Transit", true);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess("v6_query", newer,
                        System.currentTimeMillis(), false)), phone, "interface5");
        database.close();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        assertEquals(StatusSemantic.COMPLETED, repository.find(owner.rowId).semantic);
        assertEquals(0L, repository.find(owner.rowId).statusEventTime);
        assertEquals(retainedAt, repository.find(owner.rowId).signedRetainedAt);
    }

    @Test
    public void newestStructuredDonorWinsWhenQueryAndManualBothHaveStatus() {
        ExpressItem owner = unknownOwner();
        ExpressQueryResult manual = cainiao(real, StatusSemantic.DELIVERY, time(1000), "Manual event")
                .withManualStatusEvidence("Delivery", true);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess("v6_query", manual,
                        System.currentTimeMillis(), false)), phone, "interface5");
        ExpressQueryResult query = cainiao(real, StatusSemantic.TRANSIT, time(2000), "Older query")
                .withManualStatusEvidence("Transit", true);
        assertTrue(repository.saveInterface5Query(query, owner,
                repository.bindingGeneration(phone, "interface5")));
        assertEquals(StatusSemantic.DELIVERY, repository.find(owner.rowId).semantic);
        assertEquals(manual.statusEventTime, repository.find(owner.rowId).statusEventTime);
        assertEquals(manual.statusEventTime, repository.listVisible("interface5").get(0).statusEventTime);
    }

    @Test
    public void queryProseWithoutStructuredEvidenceCannotFillOwnerStatus() {
        ExpressItem owner = unknownOwner();
        assertTrue(repository.saveInterface5Query(cainiao(real, StatusSemantic.COMPLETED,
                time(1000), "Delivery prose"), owner,
                repository.bindingGeneration(phone, "interface5")));
        assertEquals(StatusSemantic.UNKNOWN, repository.find(owner.rowId).semantic);
        assertEquals(StatusSemantic.UNKNOWN, repository.listVisible("interface5").get(0).semantic);
    }

    private ExpressItem unknownOwner() {
        repository.saveInterface5(cainiao(real, StatusSemantic.TRANSIT, time(2000), "Feed event"), phone);
        database.getWritableDatabase().execSQL("UPDATE " + ExpressDatabase.EXPRESS_TABLE
                + " SET logsiticsStatus='',logisticsStatusDesc='',statusEventTime=0");
        ExpressItem owner = repository.findByWaybill(real, "interface5");
        assertEquals(StatusSemantic.UNKNOWN, owner.semantic);
        return owner;
    }

    @Test
    public void oldQueryTableKeepsHistoryWithoutInventingStructuredStatus() {
        ExpressItem owner = unknownOwner();
        String stamp = time(1000);
        repository.saveAccountTimeline(cainiao(real, StatusSemantic.DELIVERY, stamp, "Old query"), "interface5");
        database.getWritableDatabase().execSQL("ALTER TABLE " + ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE
                + " RENAME TO old_query");
        database.getWritableDatabase().execSQL("CREATE TABLE " + ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE
                + " AS SELECT normalized_waybill,waybill,courier_code,company_name,status_code,latest_time,"
                + "latest_detail,tracks_json,updated_at FROM old_query");
        database.getWritableDatabase().execSQL("DROP TABLE old_query");
        database.close();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        ExpressQueryResult query = repository.accountTimeline(real, "interface5");
        assertNotNull(query);
        assertTrue(query.tracksJson.contains("Old query"));
        assertFalse(query.structuredStatusEvidence);
        assertEquals(0L, query.statusEventTime);
        assertEquals(StatusSemantic.UNKNOWN, repository.find(owner.rowId).semantic);
    }

    @Test
    public void signedEmptyDisplayReceivesExplicitHistory() throws Exception {
        verifyProjectedSignedDetail(false);
    }

    @Test
    public void secondKeyFailureRollsBackFirstKeyAndCleanup() {
        String now = time(1000);
        ExpressQueryResult feed = result(order, StatusSemantic.TRANSIT, now,
                "Feed", tracks(now, "Feed"));
        repository.saveInterface5OrderSummary(feed, phone);
        ExpressItem owner = repository.findByWaybill(order, "interface5");
        assertTrue(repository.saveOrderProjection(owner, "interface5", real, "京东快递"));
        owner = repository.findByWaybill(order, "interface5");
        repository.saveKuaidi100Timeline(result(order, StatusSemantic.TRANSIT, now,
                "Old query", tracks(now, "Old query")));
        database.getWritableDatabase().execSQL("CREATE TRIGGER reject_display_query BEFORE INSERT ON "
                + ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE + " WHEN NEW.normalized_waybill='" + real + "' "
                + "BEGIN SELECT RAISE(ABORT, 'Synthetic second-key failure'); END");
        assertThrows(RuntimeException.class, () -> repository.saveInterface5Query(feed,
                repository.findByWaybill(order, "interface5"),
                repository.bindingGeneration(phone, "interface5")));
        assertNull(repository.accountTimeline(order, "interface5"));
        assertNull(repository.accountTimeline(real, "interface5"));
        assertEquals(1, count(ExpressDatabase.KUAIDI100_TIMELINE_TABLE));
    }

    @Test
    public void version22UpgradeInvalidatesOnlyUnprovenV5QueryCache() {
        String now = time(1000);
        repository.saveInterface5(cainiao(real, StatusSemantic.TRANSIT, now, "Feed"), phone);
        repository.saveAccountTimeline(cainiao(real, StatusSemantic.TRANSIT, now, "Mixed cache"), "interface5");
        repository.bindPhoneLocally(phone, "interface6");
        ExpressQueryResult other = new ExpressQueryResult("ZTOTHER0001", "ZTO", "中通快递",
                StatusSemantic.TRANSIT, ExpressSourcePolicy.parseEventTime(now), now, "Other source",
                tracks(now, "Other source"), CainiaoRoute.token("v6"), phone,
                "interface6", "v6", "", "CaiNiao");
        repository.saveInterface6(other, phone);
        assertNotNull(repository.findByWaybill(other.waybill, "interface6"));
        repository.saveAccountTimeline(other, "interface6");
        database.getWritableDatabase().setVersion(22);
        database.close();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        assertEquals(0, count(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE));
        assertEquals(1, count(ExpressDatabase.ACCOUNT_V6_TIMELINE_TABLE));
        assertEquals("Feed", repository.findByWaybill(real, "interface5").latestDetail);
        assertFalse(repository.bindingGeneration(phone, "interface5").isEmpty());
    }

    private void verifyProjectedSignedDetail(boolean partialDisplay) throws Exception {
        String picked = time(3 * 3600000L), transit = time(2 * 3600000L), signed = time(3600000L);
        repository.saveInterface5OrderSummary(result(order, StatusSemantic.PICKED, picked,
                "已揽收", tracks(picked, "已揽收")), phone);
        if (partialDisplay) repository.saveAccountTimeline(result(real, StatusSemantic.TRANSIT,
                transit, "运输中", tracks(transit, "运输中")), "interface5");
        repository.saveInterface5OrderSummary(result(order, StatusSemantic.COMPLETED, signed,
                "已签收", tracks(signed, "已签收")), phone);
        ExpressItem owner = repository.findByWaybill(order, "interface5");
        assertEquals(StatusSemantic.COMPLETED, owner.sourceSemantic);
        assertTrue(repository.saveOrderProjection(owner, "interface5", real, "京东快递"));
        owner = repository.findByWaybill(order, "interface5");
        String full = "[" + node(signed, "已签收") + "," + node(transit, "运输中")
                + "," + node(picked, "已揽收") + "]";
        assertTrue(repository.saveInterface5Query(result(order, StatusSemantic.COMPLETED, signed,
                "已签收", full), owner, repository.bindingGeneration(phone, "interface5")));
        Method select = Class.forName("me.pipi.deliveries.feature.express.ExpressDetailActivity")
                .getDeclaredMethod("accountTimelineFor", ExpressRepository.class,
                        ExpressItem.class, String.class, String.class);
        select.setAccessible(true);
        ExpressQueryResult shown = (ExpressQueryResult) select.invoke(null, repository, owner, real, "interface5");
        assertNotNull(shown);
        ExpressQueryResult byDisplay = repository.accountTimeline(real, "interface5");
        assertNotNull(byDisplay);
        assertTrue(byDisplay.tracksJson.contains("已揽收"));
        assertEquals(byDisplay.tracksJson, shown.tracksJson);
        assertEquals(repository.accountTimeline(order, "interface5").tracksJson, shown.tracksJson);
        assertEquals(StatusSemantic.COMPLETED, repository.findByWaybill(order, "interface5").sourceSemantic);
    }

    private int count(String table) {
        try (Cursor cursor = database.getReadableDatabase().rawQuery("SELECT COUNT(*) FROM " + table, null)) {
            assertTrue(cursor.moveToFirst());
            return cursor.getInt(0);
        }
    }

    private static String time(long ago) {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT)
                .format(new Date(System.currentTimeMillis() - ago));
    }

    private static String node(String time, String text) {
        return "{\"time\":\"" + time + "\",\"context\":\"" + text + "\"}";
    }

    private static String tracks(String time, String text) {
        return "[" + node(time, text) + "]";
    }

    private ExpressQueryResult result(String id, StatusSemantic state, String time, String text, String tracks) {
        return new ExpressQueryResult(id, "JD", "京东快递", state,
                ExpressSourcePolicy.parseEventTime(time), time, text, tracks,
                "", phone, "interface5", "", "", "JingDong");
    }

    private ExpressQueryResult cainiao(String id, StatusSemantic state, String time, String text) {
        return new ExpressQueryResult(id, "ZTO", "中通快递", state,
                ExpressSourcePolicy.parseEventTime(time), time, text, tracks(time, text),
                CainiaoRoute.token("v5"), phone, "interface5", "v5", "", "CaiNiao");
    }
}
