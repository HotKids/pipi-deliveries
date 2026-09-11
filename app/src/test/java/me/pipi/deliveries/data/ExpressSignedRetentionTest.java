package me.pipi.deliveries.data;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.ManualQuerySuccess;
import java.util.Collections;
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
public final class ExpressSignedRetentionTest {
    private static final long DAY = 86400000L;
    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;
    private long now;
    private final String phone = "13800000001";

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        repository.bindPhoneLocally(phone, "interface5");
        now = System.currentTimeMillis();
    }
    @After public void tearDown() { database.close(); context.deleteDatabase(ExpressDatabase.DATABASE); }

    @Test public void hiddenOwnerKeepsIdentityAndAllQueryHistoryUntilDayTwentyOne() throws Exception {
        String id = "ZTRETENTION0001";
        long signed = now - 15 * DAY;
        save(id, StatusSemantic.TRANSIT, signed - DAY);
        save(id, StatusSemantic.COMPLETED, signed);
        ExpressItem owner = repository.findByWaybill(id, "interface5");
        assertNotNull(owner);
        repository.saveAccountTimeline(result(id, StatusSemantic.TRANSIT, signed - DAY), "interface5");
        repository.saveV4Timeline(result(id, StatusSemantic.TRANSIT, signed - DAY));
        repository.saveKuaidi100Timeline(result(id, StatusSemantic.TRANSIT, signed - DAY));
        assertTrue(repository.listVisible("interface5").isEmpty());
        prune(now);
        assertNotNull("Day 15 hides without deleting the owner", repository.find(owner.rowId));
        assertTrue(repository.saveInterface5Query(result(id, StatusSemantic.COMPLETED, now), owner,
                repository.bindingGeneration(phone, "interface5")));
        save(id, StatusSemantic.COMPLETED, now);
        assertEquals(owner.rowId, repository.findByWaybill(id, "interface5").rowId);
        assertEquals(signed, anchor(owner.rowId));
        assertTrue(repository.listVisible("interface5").isEmpty());
        assertTrue(repository.accountTimeline(id, "interface5").tracksJson.contains(time(signed - DAY)));
        prune(signed + 21 * DAY - 1);
        assertNotNull(repository.find(owner.rowId));
        prune(signed + 21 * DAY);
        assertNull(repository.find(owner.rowId));
        for (String table : new String[]{ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE,
                ExpressDatabase.V4_TIMELINE_TABLE, ExpressDatabase.KUAIDI100_TIMELINE_TABLE}) {
            assertEquals(0, count(table));
        }
    }

    @Test public void unknownTimeIsAnchoredOnceAndNeverBecomesFreezeEvidence() throws Exception {
        String id = "ZTRETENTION0002";
        save(id, StatusSemantic.COMPLETED, 0L);
        ExpressItem owner = repository.findByWaybill(id, "interface5");
        long first = anchor(owner.rowId);
        assertTrue(first >= now && first <= System.currentTimeMillis());
        assertTrue(Kuaidi100TimelinePolicy.shouldRefresh(repository.find(owner.rowId), null, now));
        ContentValues update = new ContentValues();
        update.put("updatedAt", now + 10 * DAY);
        database.getWritableDatabase().update(ExpressDatabase.EXPRESS_TABLE, update, "_id=?",
                new String[]{Long.toString(owner.rowId)});
        save(id, StatusSemantic.COMPLETED, 0L);
        assertEquals(first, anchor(owner.rowId));
        prune(first + 21 * DAY);
        assertNull(repository.find(owner.rowId));
        save(id, StatusSemantic.COMPLETED, now);
        ExpressItem recreated = repository.findByWaybill(id, "interface5");
        assertNotNull(recreated);
        assertNotEquals(owner.rowId, recreated.rowId);
        assertEquals(now, anchor(recreated.rowId));
    }

    @Test public void upgradeUsesLocalConfirmationOnceAndPreservesV23QueryCache() {
        save("ZTRETENTION0003", StatusSemantic.COMPLETED, 0L);
        ExpressItem owner = repository.findByWaybill("ZTRETENTION0003", "interface5");
        ContentValues legacy = new ContentValues();
        legacy.put("updatedAt", now - 15 * DAY);
        // Simulate an old row, whether the pre-fix schema has the new column or not.
        try (Cursor cursor = database.getReadableDatabase().rawQuery("PRAGMA table_info("
                + ExpressDatabase.EXPRESS_TABLE + ")", null)) {
            while (cursor.moveToNext()) if ("signedRetainedAt".equals(cursor.getString(1))) {
                legacy.put("signedRetainedAt", 0L);
            }
        }
        database.getWritableDatabase().update(ExpressDatabase.EXPRESS_TABLE, legacy, "_id=?",
                new String[]{Long.toString(owner.rowId)});
        repository.saveAccountTimeline(result(owner.waybill, StatusSemantic.TRANSIT, now), "interface5");
        removeAnchorColumnForV23Fixture();
        database.getWritableDatabase().setVersion(23);
        database.close();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        assertNotNull(repository.find(owner.rowId));
        long first = anchor(owner.rowId);
        assertTrue(first >= now && first <= System.currentTimeMillis());
        assertNotNull(repository.accountTimeline(owner.waybill, "interface5"));
        assertEquals(1, repository.listVisible("interface5").size());
        save(owner.waybill, StatusSemantic.COMPLETED, 0L);
        assertEquals(first, anchor(owner.rowId));
    }

    @Test @Config(shadows = CountingNotifications.class)
    public void firstDiscoveryDuringHiddenWeekRetainsOriginalAnchorAndCache() throws Exception {
        String id = "ZTRETENTION0013";
        long signed = now - 15 * DAY;
        CountingNotifications.attempts = 0;
        save(id, StatusSemantic.COMPLETED, signed);
        ExpressItem owner = repository.findByWaybill(id, "interface5");
        assertNotNull(owner);
        assertEquals(signed, anchor(owner.rowId));
        assertTrue(repository.listVisible("interface5").isEmpty());
        assertTrue(owner.tracksJson.contains(time(signed)));
        repository.saveAccountTimeline(result(id, StatusSemantic.COMPLETED, signed), "interface5");
        save(id, StatusSemantic.COMPLETED, now);
        assertEquals(owner.rowId, repository.findByWaybill(id, "interface5").rowId);
        assertEquals(signed, anchor(owner.rowId));
        assertTrue(repository.listVisible("interface5").isEmpty());
        assertEquals(0, CountingNotifications.attempts);
        assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
        prune(signed + 21 * DAY - 1L);
        assertNotNull(repository.find(owner.rowId));
        assertNotNull(repository.accountTimeline(id, "interface5"));
        prune(signed + 21 * DAY);
        assertNull(repository.find(owner.rowId));
        assertEquals(0, count(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE));
        repository.saveAutomaticObservation(result(id, StatusSemantic.COMPLETED, signed), phone,
                ExpressSourcePolicy.SOURCE_INTERFACE5, repository.bindingGeneration(phone, "interface5"),
                signed + 21 * DAY);
        assertNull(repository.findByWaybill(id, "interface5"));
    }

    @Test public void firstDiscoveryAtDeletionDeadlineIsRejectedAndCancellationKeepsFourHours() throws Exception {
        save("ZTRETENTION0004", StatusSemantic.COMPLETED, now - 21 * DAY);
        assertNull(repository.findByWaybill("ZTRETENTION0004", "interface5"));
        save("ZTRETENTION0005", StatusSemantic.TRANSIT, now - DAY);
        save("ZTRETENTION0005", StatusSemantic.CANCELLED, now - 4 * 3600000L);
        ExpressItem cancelled = repository.findByWaybill("ZTRETENTION0005", "interface5");
        assertNotNull(cancelled);
        prune(now);
        assertNull(repository.find(cancelled.rowId));
    }

    @Test public void manualBatchAuthorityCannotRestartRetentionOrSurviveDayTwentyOne() throws Exception {
        String id = "ZTRETENTION0006";
        long signed = now - 15 * DAY;
        ExpressQueryResult initial = manual(id, signed);
        ExpressItem owner = repository.saveManualQueryBatch(null,
                Collections.singletonList(new ManualQuerySuccess("kuaidi100", initial, now, true)), "", "interface5");
        assertNotNull(owner);
        assertEquals(StatusSemantic.COMPLETED, owner.semantic);
        assertEquals(signed, anchor(owner.rowId));
        assertTrue(repository.listVisible("interface5").isEmpty());
        ExpressItem refreshed = repository.saveManualQueryBatch(owner,
                Collections.singletonList(new ManualQuerySuccess("kuaidi100", manual(id, now), now, true)), "", "interface5");
        assertEquals(signed, anchor(refreshed.rowId));
        prune(signed + 21 * DAY - 1);
        assertNotNull(repository.find(owner.rowId));
        prune(signed + 21 * DAY);
        assertNull(repository.find(owner.rowId));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE));
        assertEquals(0, count(ExpressDatabase.KUAIDI100_TIMELINE_TABLE));
    }

    @Test public void projectedKeysSurviveUpgradeAndHiddenWeekThenAllExpireTogether() throws Exception {
        String order = "3999999000000099", real = "JDRETENTION0099";
        long signed = now - 15 * DAY;
        ExpressQueryResult feed = new ExpressQueryResult(order, "JD", "京东快递",
                StatusSemantic.COMPLETED, signed, time(signed), "已签收", tracks(signed),
                "", phone, "interface5", "", "", "JingDong");
        repository.saveInterface5OrderSummary(new ExpressQueryResult(order, "JD", "京东快递",
                StatusSemantic.TRANSIT, now - 16 * DAY, time(now - 16 * DAY), "运输中",
                tracks(now - 16 * DAY), "", phone, "interface5", "", "", "JingDong"), phone);
        repository.saveInterface5OrderSummary(feed, phone);
        ExpressItem owner = repository.findByWaybill(order, "interface5");
        assertTrue(repository.saveOrderProjection(owner, "interface5", real, "京东快递"));
        owner = repository.findByWaybill(order, "interface5");
        assertTrue(repository.saveInterface5Query(feed, owner, repository.bindingGeneration(phone, "interface5")));
        repository.saveV4Timeline(result(real, StatusSemantic.TRANSIT, signed));
        repository.saveAccountTimeline(result(real, StatusSemantic.TRANSIT, signed), "interface6");
        repository.saveKuaidi100Timeline(result(real, StatusSemantic.TRANSIT, signed));
        database.getWritableDatabase().setVersion(23);
        database.close();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        assertEquals(signed, anchor(owner.rowId));
        assertNotNull(repository.accountTimeline(real, "interface5"));
        assertNotNull(repository.accountTimeline(real, "interface6"));
        prune(now);
        assertNotNull(repository.find(owner.rowId));
        prune(signed + 21 * DAY);
        assertNull(repository.find(owner.rowId));
        for (String table : new String[]{ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE,
                ExpressDatabase.ACCOUNT_V6_TIMELINE_TABLE, ExpressDatabase.V4_TIMELINE_TABLE,
                ExpressDatabase.KUAIDI100_TIMELINE_TABLE, ExpressDatabase.ORDER_PROJECTION_TABLE,
                ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE}) {
            assertEquals(table, 0, count(table));
        }
    }

    @Test public void upgradePrefersTrustedTerminalTimeAndRejectsFutureEvidence() throws Exception {
        long old = now - 15 * DAY;
        for (String id : new String[]{"ZTRETENTION0007", "ZTRETENTION0008"}) {
            save(id, StatusSemantic.TRANSIT, old - DAY);
            save(id, StatusSemantic.COMPLETED, id.endsWith("7") ? old : now + DAY);
        }
        removeAnchorColumnForV23Fixture();
        database.getWritableDatabase().setVersion(23);
        database.close();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        ExpressItem trusted = repository.findByWaybill("ZTRETENTION0007", "interface5");
        ExpressItem future = repository.findByWaybill("ZTRETENTION0008", "interface5");
        assertEquals(old, anchor(trusted.rowId));
        assertTrue(anchor(future.rowId) >= now && anchor(future.rowId) <= System.currentTimeMillis());
        assertFalse(Kuaidi100TimelinePolicy.shouldRefresh(trusted, null, now));
        assertTrue(Kuaidi100TimelinePolicy.shouldRefresh(future, null, now));
        prune(now);
        assertNotNull(repository.find(trusted.rowId));
        assertEquals(1, repository.listVisible("interface5").size());
    }

    @org.robolectric.annotation.Implements(android.app.NotificationManager.class)
    public static class CountingNotifications extends org.robolectric.shadows.ShadowNotificationManager {
        static int attempts;
        @org.robolectric.annotation.Implementation
        @Override public void notify(int id, android.app.Notification notification) { attempts++; }
    }

    @Test @Config(shadows = CountingNotifications.class)
    public void hiddenCommitCannotCreateNotificationOutbox() {
        String id = "ZTRETENTION0009";
        save(id, StatusSemantic.TRANSIT, now - 16 * DAY);
        save(id, StatusSemantic.COMPLETED, now - 15 * DAY);
        CountingNotifications.attempts = 0;
        repository.runInChangeBatch(() -> {
            repository.saveInterface5(new ExpressQueryResult(id, "ZTO", "中通快递",
                    StatusSemantic.COMPLETED, now, time(now), "已签收，售后服务更新", tracks(now),
                    "", phone, "interface5", "", "", "CaiNiao"), phone);
            assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
        });
        assertEquals(0, CountingNotifications.attempts);
        assertNotNull(repository.findByWaybill(id, "interface5"));
    }

    @Test @Config(shadows = CountingNotifications.class)
    public void hiddenPendingNotificationIsConsumedAndVisibleUpdateStillPosts() {
        String id = "ZTRETENTION0010";
        save(id, StatusSemantic.TRANSIT, now - 16 * DAY);
        save(id, StatusSemantic.COMPLETED, now - 15 * DAY);
        ExpressItem hidden = repository.findByWaybill(id, "interface5");
        ContentValues pending = new ContentValues();
        pending.put("owner_row_id", hidden.rowId);
        pending.put("event_token", "synthetic-before-hide");
        database.getWritableDatabase().insertOrThrow(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null, pending);
        CountingNotifications.attempts = 0;
        repository.replayPendingNotifications();
        assertEquals(0, CountingNotifications.attempts);
        assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
        save("ZTRETENTION0011", StatusSemantic.TRANSIT, now - 3600000L);
        save("ZTRETENTION0011", StatusSemantic.COMPLETED, now);
        assertEquals(1, CountingNotifications.attempts);
    }

    @Test @Config(shadows = CountingNotifications.class)
    public void cancellationAfterSignatureKeepsFourHourRetentionAndNotificationPolicy() throws Exception {
        String id = "ZTRETENTION0012";
        save(id, StatusSemantic.TRANSIT, now - 16 * DAY);
        save(id, StatusSemantic.COMPLETED, now - 15 * DAY);
        ExpressItem signed = repository.findByWaybill(id, "interface5");
        long first = anchor(signed.rowId);
        CountingNotifications.attempts = 0;
        save(id, StatusSemantic.CANCELLED, now - 5 * 3600000L);
        ExpressItem cancelled = repository.find(signed.rowId);
        assertEquals(StatusSemantic.CANCELLED, cancelled.semantic);
        assertEquals(first, anchor(cancelled.rowId));
        assertEquals(1, CountingNotifications.attempts);
        assertTrue(repository.listVisible("interface5").isEmpty());
        prune(now);
        assertNull(repository.find(cancelled.rowId));
    }

    private void removeAnchorColumnForV23Fixture() {
        android.database.sqlite.SQLiteDatabase db = database.getWritableDatabase();
        String schema;
        try (Cursor cursor = db.rawQuery("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
                new String[]{ExpressDatabase.EXPRESS_TABLE})) {
            assertTrue(cursor.moveToFirst()); schema = cursor.getString(0);
        }
        java.util.ArrayList<String> columns = new java.util.ArrayList<>();
        try (Cursor cursor = db.rawQuery("PRAGMA table_info(" + ExpressDatabase.EXPRESS_TABLE + ")", null)) {
            while (cursor.moveToNext()) if (!"signedRetainedAt".equals(cursor.getString(1))) {
                columns.add(cursor.getString(1));
            }
        }
        String names = String.join(",", columns);
        db.execSQL(schema.replace(ExpressDatabase.EXPRESS_TABLE, "legacy_retention_rows")
                .replace("signedRetainedAt INTEGER DEFAULT 0,", ""));
        db.execSQL("INSERT INTO legacy_retention_rows(" + names + ") SELECT " + names
                + " FROM " + ExpressDatabase.EXPRESS_TABLE);
        db.execSQL("DROP TABLE " + ExpressDatabase.EXPRESS_TABLE);
        db.execSQL("ALTER TABLE legacy_retention_rows RENAME TO " + ExpressDatabase.EXPRESS_TABLE);
    }

    private ExpressQueryResult manual(String id, long at) {
        return new ExpressQueryResult(id, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                at, time(at), "已签收", tracks(at), "", "", "kuaidi100", "", "", "")
                .withManualStatusEvidence("已签收", true);
    }
    private static String tracks(long at) {
        return "[{\"time\":\"" + time(at) + "\",\"context\":\"已签收\"}]";
    }

    private void save(String id, StatusSemantic state, long at) {
        repository.saveInterface5(result(id, state, at), phone);
    }
    private ExpressQueryResult result(String id, StatusSemantic state, long at) {
        String date = at <= 0L ? "" : time(at);
        String text = state.label;
        return new ExpressQueryResult(id, "ZTO", "中通快递", state, at, date, text,
                at <= 0L ? "[]" : "[{\"time\":\"" + date + "\",\"context\":\"" + text + "\"}]",
                "", phone, "interface5", "", "", "CaiNiao");
    }
    private static String time(long at) {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).format(new Date(at));
    }
    private long anchor(long rowId) {
        try (Cursor cursor = database.getReadableDatabase().rawQuery("SELECT signedRetainedAt FROM "
                + ExpressDatabase.EXPRESS_TABLE + " WHERE _id=?", new String[]{Long.toString(rowId)})) {
            assertTrue(cursor.moveToFirst()); return cursor.getLong(0);
        }
    }
    private int count(String table) {
        try (Cursor cursor = database.getReadableDatabase().rawQuery("SELECT COUNT(*) FROM " + table, null)) {
            assertTrue(cursor.moveToFirst()); return cursor.getInt(0);
        }
    }
    private void prune(long at) throws Exception {
        Method method = ExpressRepository.class.getDeclaredMethod("pruneExpiredShipments", long.class);
        method.setAccessible(true); method.invoke(repository, at);
    }
}
