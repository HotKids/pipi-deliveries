package me.pipi.deliveries.data;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ManualQuerySuccess;
import me.pipi.deliveries.model.StatusSemantic;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.Collections;
import java.util.Date;
import java.util.Locale;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

/**
 * A carrier reusing an old waybill number (user decisions 2026-10-01/02, all four clients): 「C 新件优先（含 A）」,
 * 「至少晚 24 小时」, 「当新件初次出现，不通知」, details 「全部按推荐」. Synthetic waybills and phones only.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class,
        shadows = ExpressSignedRetentionTest.CountingNotifications.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class WaybillReuseTest {
    private static final long HOUR = 3600000L;
    private static final long DAY = 24L * HOUR;
    private final String phone = "13800000001";
    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;
    private long now;
    private long signed;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        context.getSharedPreferences("express_detail_selection", 0).edit().clear().commit();
        context.getSharedPreferences("carrier_recognition_v1", 0).edit().clear().commit();
        context.getSharedPreferences("carrier_recognition_deferred_v1", 0).edit().clear().commit();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        repository.bindPhoneLocally(phone, "interface5");
        now = System.currentTimeMillis() / 1000L * 1000L;
        signed = now - 5 * DAY;
        ExpressSignedRetentionTest.CountingNotifications.attempts = 0;
    }

    @After public void tearDown() {
        database.close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void aNewParcelADayAndAnHourAfterSigningTakesTheRowSilentlyWithNothingOfTheOld() throws Exception {
        String id = "YTREUSE000000001";
        ExpressItem old = signedOldParcel(id, "CaiNiao");
        repository.saveAccountTimeline(record(id, StatusSemantic.TRANSIT, signed - DAY, "CaiNiao"), "interface5");
        repository.saveV4Timeline(record(id, StatusSemantic.TRANSIT, signed - DAY, "CaiNiao"));
        repository.saveKuaidi100Timeline(record(id, StatusSemantic.COMPLETED, signed, "CaiNiao"));
        ContentValues remark = new ContentValues();
        remark.put("remark", "synthetic remark");
        database.getWritableDatabase().update(ExpressDatabase.EXPRESS_TABLE, remark, "_id=?",
                new String[]{Long.toString(old.rowId)});
        repository.rememberDetailSelection(repository.find(old.rowId), TimelineSlot.K100_H5);
        String recognitionKey = recognitionKey(id);
        context.getSharedPreferences("carrier_recognition_v1", 0).edit()
                .putString(recognitionKey, "{\"standardCode\":\"YTO\",\"terminal\":false}").commit();
        context.getSharedPreferences("carrier_recognition_deferred_v1", 0).edit()
                .putString(recognitionKey, "{\"mark\":1,\"atMs\":1}").commit();
        assertTrue(anchor(old.rowId) > 0L);
        ExpressSignedRetentionTest.CountingNotifications.attempts = 0;

        long arrived = signed + DAY + HOUR;
        save(id, StatusSemantic.PICKED, arrived, "CaiNiao", "揽收 synthetic new parcel");

        ExpressItem current = repository.findByWaybill(id, "interface5");
        assertNotNull(current);
        assertNull("the old record's row is gone", repository.find(old.rowId));
        assertEquals(StatusSemantic.PICKED, current.semantic);
        assertEquals("揽收 synthetic new parcel", current.latestDetail);
        assertFalse("only the new parcel's timeline", current.tracksJson.contains(time(signed)));
        assertFalse(current.tracksJson.contains(time(signed - DAY)));
        assertEquals("the signed latch is cleared", 0L, anchor(current.rowId));
        assertEquals("the remark is cleared", "", current.remark);
        assertEquals("", ExpressRepository.preferredDetailProvider(current));
        assertFalse(context.getSharedPreferences("express_detail_selection", 0).getAll().keySet().stream()
                .anyMatch(key -> key.startsWith(old.rowId + "\u0000")));
        assertFalse("carrier recognition is forgotten",
                context.getSharedPreferences("carrier_recognition_v1", 0).contains(recognitionKey));
        assertTrue("the recognition deferral mark only orders a round and stays (coordinator 2026-10-02)",
                context.getSharedPreferences("carrier_recognition_deferred_v1", 0).contains(recognitionKey));
        for (String table : new String[]{ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE,
                ExpressDatabase.V4_TIMELINE_TABLE, ExpressDatabase.KUAIDI100_TIMELINE_TABLE,
                ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE}) {
            assertEquals(table, 0, count(table));
        }
        assertEquals("the takeover is a first sighting", 0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
        assertEquals(0, ExpressSignedRetentionTest.CountingNotifications.attempts);
        assertEquals(1, repository.listVisible("interface5").size());

        save(id, StatusSemantic.DELIVERY, arrived + HOUR, "CaiNiao", "派送中 synthetic new parcel",
                arrived, "揽收 synthetic new parcel");
        assertEquals("the new parcel's next status change notifies",
                1, ExpressSignedRetentionTest.CountingNotifications.attempts);
    }

    /**
     * 优化 1、3、5 续（用户 2026-10-03）：the old parcel's row ledger (the anchor its recognition sent, its alignment set, its
     * signed union page) goes with the old row when a reused number's new parcel takes it; the new parcel starts a fresh
     * anchor, its own earliest node, recorded at its first recognition.
     */
    @Test public void aReusedNumbersNewParcelStartsAFreshLedger() {
        String id = "YTREUSE000000091";
        ExpressItem old = signedOldParcel(id, "CaiNiao");
        assertEquals(signed - DAY, repository.parcelAnchor(old));
        assertTrue(repository.claimLedger(old.rowId, ExpressRepository.LEDGER_STATUS_ALIGNMENT, "1|2|3"));
        repository.recordSignedUnionPage(old);
        assertFalse(repository.ledgerValue(old.rowId, ExpressRepository.LEDGER_SIGNED_UNION_PAGE).isEmpty());

        long arrived = signed + DAY + HOUR;
        save(id, StatusSemantic.PICKED, arrived, "CaiNiao", "揽收 synthetic new parcel");

        ExpressItem current = repository.findByWaybill(id, "interface5");
        assertNotNull(current);
        assertNotEquals(old.rowId, current.rowId);
        for (String entry : new String[]{ExpressRepository.LEDGER_PARCEL_ANCHOR,
                ExpressRepository.LEDGER_STATUS_ALIGNMENT, ExpressRepository.LEDGER_SIGNED_UNION_PAGE}) {
            assertEquals(entry, "", repository.ledgerValue(old.rowId, entry));
            assertEquals(entry, "", repository.ledgerValue(current.rowId, entry));
        }
        assertEquals("the new parcel's own earliest node", arrived, repository.parcelAnchor(current));
        assertEquals(Long.toString(arrived),
                repository.ledgerValue(current.rowId, ExpressRepository.LEDGER_PARCEL_ANCHOR));
    }

    @Test public void twentyThreeHoursAfterSigningKeepsTheSignedParcel() {
        String id = "YTREUSE000000002";
        ExpressItem old = signedOldParcel(id, "CaiNiao");
        long latch = anchor(old.rowId);
        save(id, StatusSemantic.PICKED, signed + 23 * HOUR, "CaiNiao", "揽收 synthetic too early");
        ExpressItem current = repository.findByWaybill(id, "interface5");
        assertEquals(old.rowId, current.rowId);
        assertEquals(StatusSemantic.COMPLETED, current.semantic);
        assertEquals(latch, anchor(current.rowId));
        assertEquals(0, ExpressSignedRetentionTest.CountingNotifications.attempts);
    }

    @Test public void jingDongSourcesAreNeverTakenOver() {
        String id = "JDREUSE000000003";
        ExpressItem old = signedOldParcel(id, "JingDong");
        long latch = anchor(old.rowId);
        save(id, StatusSemantic.PICKED, signed + 3 * DAY, "JingDong", "揽收 synthetic jd");
        ExpressItem current = repository.findByWaybill(id, "interface5");
        assertEquals(old.rowId, current.rowId);
        assertEquals(StatusSemantic.COMPLETED, current.semantic);
        assertEquals(latch, anchor(current.rowId));
    }

    /** A JD order projected onto the number makes it a JD purchase's waybill: the existing rules stay. */
    @Test public void aJingDongOrderProjectedOntoTheNumberKeepsTheExistingRules() {
        String id = "YTREUSE000000012";
        ExpressItem old = signedOldParcel(id, "CaiNiao");
        long latch = anchor(old.rowId);
        String order = "3630448013820012";
        repository.saveInterface5OrderSummary(new ExpressQueryResult(order, "JDKD", "京东商品快递",
                StatusSemantic.TRANSIT, signed - DAY, time(signed - DAY), "您的订单已出库",
                tracks(signed - DAY, "您的订单已出库"), "", phone, "interface5", "", "", "JingDong"), phone);
        ExpressItem orderRow = repository.findByWaybill(order, "interface5");
        assertNotNull(orderRow);
        assertTrue(repository.saveOrderProjection(orderRow, "interface5", id, "圆通速递"));
        save(id, StatusSemantic.PICKED, signed + 2 * DAY, "CaiNiao", "揽收 synthetic new parcel");
        ExpressItem current = repository.find(old.rowId);
        assertNotNull("no takeover while a JD order holds the number", current);
        assertEquals(latch, anchor(old.rowId));
    }

    @Test public void theOldRecordAfterTheTakeoverIsIgnoredSoTheRowNeverFlips() {
        String id = "YTREUSE000000004";
        signedOldParcel(id, "CaiNiao");
        long arrived = signed + 2 * DAY;
        save(id, StatusSemantic.PICKED, arrived, "CaiNiao", "揽收 synthetic new parcel");
        ExpressItem taken = repository.findByWaybill(id, "interface5");
        // The upstream list still carries the old record: it is ignored in either order.
        saveOldRecord(id, "CaiNiao");
        ExpressItem after = repository.findByWaybill(id, "interface5");
        assertEquals(taken.rowId, after.rowId);
        assertEquals(StatusSemantic.PICKED, after.semantic);
        assertEquals("揽收 synthetic new parcel", after.latestDetail);
        assertEquals(0L, anchor(after.rowId));
        save(id, StatusSemantic.PICKED, arrived, "CaiNiao", "揽收 synthetic new parcel");
        saveOldRecord(id, "CaiNiao");
        assertEquals(StatusSemantic.PICKED, repository.findByWaybill(id, "interface5").semantic);
        assertEquals(0, ExpressSignedRetentionTest.CountingNotifications.attempts);
    }

    @Test public void dayTwentyOneOfTheOldSigningKeepsTheNewRow() throws Exception {
        String id = "YTREUSE000000005";
        signedOldParcel(id, "CaiNiao");
        save(id, StatusSemantic.PICKED, signed + 2 * DAY, "CaiNiao", "揽收 synthetic new parcel");
        ExpressItem current = repository.findByWaybill(id, "interface5");
        prune(signed + 21 * DAY);
        assertNotNull(repository.find(current.rowId));
        assertEquals(1, repository.listVisible("interface5").size());
    }

    @Test public void aSignedManualRowIsTakenOverWithoutItsManualTimelines() {
        String id = "YTREUSE000000006";
        ExpressQueryResult manual = new ExpressQueryResult(id, "YTO", "圆通速递", StatusSemantic.COMPLETED,
                signed, time(signed), "已签收 synthetic manual", tracks(signed, "已签收 synthetic manual"),
                "", "", "kuaidi100", "", "", "").withManualStatusEvidence("已签收", true);
        ExpressItem owner = repository.saveManualQueryBatch(null,
                Collections.singletonList(new ManualQuerySuccess("kuaidi100", manual, now, true)), "", "interface5");
        assertNotNull(owner);
        assertTrue(owner.manuallyAdded);
        ExpressSignedRetentionTest.CountingNotifications.attempts = 0;
        assertTrue(count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE) + count(ExpressDatabase.KUAIDI100_TIMELINE_TABLE) > 0);
        save(id, StatusSemantic.PICKED, signed + 2 * DAY, "CaiNiao", "揽收 synthetic automatic");
        ExpressItem current = repository.findByWaybill(id, "interface5");
        assertNotNull(current);
        assertFalse(current.manuallyAdded);
        assertEquals(StatusSemantic.PICKED, current.semantic);
        assertFalse(current.tracksJson.contains("synthetic manual"));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE));
        assertEquals(0, count(ExpressDatabase.KUAIDI100_TIMELINE_TABLE));
        assertEquals(0, ExpressSignedRetentionTest.CountingNotifications.attempts);
    }

    @Test public void aRecordWithNoTimeIsNeverJudgedReused() {
        String id = "YTREUSE000000007";
        ExpressItem old = signedOldParcel(id, "CaiNiao");
        repository.saveInterface5(new ExpressQueryResult(id, "YTO", "圆通速递", StatusSemantic.PICKED, 0L, "",
                "揽收 synthetic untimed", "[]", "", phone, "interface5", "", "", "CaiNiao"), phone);
        ExpressItem current = repository.findByWaybill(id, "interface5");
        assertEquals(old.rowId, current.rowId);
        assertEquals(StatusSemantic.COMPLETED, current.semantic);
    }

    @Test public void aRecordWithoutNodesIsAnchoredOnItsStatusTime() {
        String id = "YTREUSE000000008";
        ExpressItem old = signedOldParcel(id, "CaiNiao");
        long arrived = signed + 2 * DAY;
        repository.saveInterface5(new ExpressQueryResult(id, "YTO", "圆通速递", StatusSemantic.PICKED, arrived, "",
                "", "[]", "", phone, "interface5", "", "", "CaiNiao"), phone);
        ExpressItem current = repository.findByWaybill(id, "interface5");
        assertNull(repository.find(old.rowId));
        assertEquals(StatusSemantic.PICKED, current.semantic);
        assertEquals(0, ExpressSignedRetentionTest.CountingNotifications.attempts);
    }

    /** Interface 6 records carry no nodes: the anchor is the record's own status time; the old record never returns. */
    @Test public void interfaceSixRecordsWithoutNodesTakeOverAndTheOldOneIsIgnored() {
        String v6Phone = "13800000002";
        repository.bindPhoneLocally(v6Phone, "interface6");
        String id = "ZTREUSE000000011";
        ExpressQueryResult oldSigned = new ExpressQueryResult(id, "ZTO", "中通快递", StatusSemantic.COMPLETED, signed,
                time(signed), "已签收 synthetic v6", "[]", "", v6Phone, "interface6", "", "", "CaiNiao");
        repository.saveInterface6(oldSigned, v6Phone);
        ExpressItem old = repository.findByWaybill(id, "interface6");
        assertNotNull(old);
        assertEquals(StatusSemantic.COMPLETED, old.semantic);
        ExpressSignedRetentionTest.CountingNotifications.attempts = 0;
        long arrived = signed + 2 * DAY;
        repository.saveInterface6(new ExpressQueryResult(id, "ZTO", "中通快递", StatusSemantic.TRANSIT, arrived,
                time(arrived), "运输中 synthetic v6 new", "[]", "", v6Phone, "interface6", "", "", "CaiNiao"), v6Phone);
        ExpressItem current = repository.findByWaybill(id, "interface6");
        assertNull(repository.find(old.rowId));
        assertEquals(StatusSemantic.TRANSIT, current.semantic);
        repository.saveInterface6(oldSigned, v6Phone);
        assertEquals(StatusSemantic.TRANSIT, repository.findByWaybill(id, "interface6").semantic);
        assertEquals(0L, anchor(current.rowId));
        assertEquals(0, ExpressSignedRetentionTest.CountingNotifications.attempts);
    }

    @Test public void aCancelledOldRecordIsTakenOverToo() {
        String id = "YTREUSE000000009";
        save(id, StatusSemantic.TRANSIT, signed - DAY, "CaiNiao", "运输中 synthetic old");
        save(id, StatusSemantic.CANCELLED, signed, "CaiNiao", "已取消 synthetic old",
                signed - DAY, "运输中 synthetic old");
        ExpressItem old = repository.findByWaybill(id, "interface5");
        assertEquals(StatusSemantic.CANCELLED, old.semantic);
        save(id, StatusSemantic.PICKED, signed + 2 * DAY, "CaiNiao", "揽收 synthetic new parcel");
        ExpressItem current = repository.findByWaybill(id, "interface5");
        assertNull(repository.find(old.rowId));
        assertEquals(StatusSemantic.PICKED, current.semantic);
    }

    @Test public void thePolicyReadsTheEarliestTimedNodeAndTheTerminalTime() {
        ExpressQueryResult old = record("YTREUSE000000010", StatusSemantic.COMPLETED, signed, "CaiNiao");
        ExpressQueryResult early = new ExpressQueryResult("YTREUSE000000010", "YTO", "圆通速递",
                StatusSemantic.DELIVERY, signed + 3 * DAY, time(signed + 3 * DAY), "派送中",
                twoTracks(signed + 3 * DAY, "派送中", signed - DAY, "揽收"), "", phone, "interface5", "", "", "CaiNiao");
        assertFalse("its earliest node is the old parcel's history", WaybillReusePolicy.supersedes(old, early, now));
        ExpressQueryResult later = record("YTREUSE000000010", StatusSemantic.PICKED, signed + 25 * HOUR, "CaiNiao");
        assertTrue(WaybillReusePolicy.supersedes(old, later, now));
        assertFalse(WaybillReusePolicy.supersedes(later, old, now));
        ExpressQueryResult future = record("YTREUSE000000010", StatusSemantic.PICKED, now + DAY, "CaiNiao");
        assertFalse("a time in the future is no time", WaybillReusePolicy.supersedes(old, future, now));
        ExpressQueryResult laterNode = new ExpressQueryResult("YTREUSE000000010", "YTO", "圆通速递",
                StatusSemantic.COMPLETED, signed, time(signed), "已签收",
                twoTracks(signed + 10 * HOUR, "签收后的补充说明 synthetic", signed, "已签收"),
                "", phone, "interface5", "", "", "CaiNiao");
        assertFalse("the terminal time is the latest of status, shown and node times",
                WaybillReusePolicy.supersedes(laterNode, later, now));
    }

    private ExpressItem signedOldParcel(String id, String source) {
        save(id, StatusSemantic.TRANSIT, signed - DAY, source, "运输中 synthetic old");
        save(id, StatusSemantic.COMPLETED, signed, source, "已签收 synthetic old",
                signed - DAY, "运输中 synthetic old");
        ExpressItem old = repository.findByWaybill(id, "interface5");
        assertNotNull(old);
        assertEquals(StatusSemantic.COMPLETED, old.semantic);
        ExpressSignedRetentionTest.CountingNotifications.attempts = 0;
        return old;
    }

    private void saveOldRecord(String id, String source) {
        repository.saveInterface5(new ExpressQueryResult(id, "YTO", "圆通速递", StatusSemantic.COMPLETED, signed,
                time(signed), "已签收 synthetic old",
                twoTracks(signed, "已签收 synthetic old", signed - DAY, "运输中 synthetic old"),
                "", phone, "interface5", "", "", source), phone);
    }

    private void save(String id, StatusSemantic state, long at, String source, String text) {
        repository.saveInterface5(new ExpressQueryResult(id, "YTO", "圆通速递", state, at, time(at), text,
                tracks(at, text), "", phone, "interface5", "", "", source), phone);
    }

    private void save(String id, StatusSemantic state, long at, String source, String text,
            long earlierAt, String earlierText) {
        repository.saveInterface5(new ExpressQueryResult(id, "YTO", "圆通速递", state, at, time(at), text,
                twoTracks(at, text, earlierAt, earlierText), "", phone, "interface5", "", "", source), phone);
    }

    private ExpressQueryResult record(String id, StatusSemantic state, long at, String source) {
        return new ExpressQueryResult(id, "YTO", "圆通速递", state, at, time(at), state.label,
                tracks(at, state.label), "", phone, "interface5", "", "", source);
    }

    private static String tracks(long at, String text) {
        return "[{\"time\":\"" + time(at) + "\",\"context\":\"" + text + "\"}]";
    }

    private static String twoTracks(long at, String text, long earlierAt, String earlierText) {
        return "[{\"time\":\"" + time(at) + "\",\"context\":\"" + text + "\"},"
                + "{\"time\":\"" + time(earlierAt) + "\",\"context\":\"" + earlierText + "\"}]";
    }

    private static String time(long at) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT);
        format.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Shanghai"));
        return format.format(new Date(at));
    }

    private long anchor(long rowId) {
        try (Cursor cursor = database.getReadableDatabase().rawQuery("SELECT signedRetainedAt FROM "
                + ExpressDatabase.EXPRESS_TABLE + " WHERE _id=?", new String[]{Long.toString(rowId)})) {
            return cursor.moveToFirst() ? cursor.getLong(0) : -1L;
        }
    }

    private int count(String table) {
        try (Cursor cursor = database.getReadableDatabase().rawQuery("SELECT COUNT(*) FROM " + table, null)) {
            assertTrue(cursor.moveToFirst());
            return cursor.getInt(0);
        }
    }

    private void prune(long at) throws Exception {
        Method method = ExpressRepository.class.getDeclaredMethod("pruneExpiredShipments", long.class);
        method.setAccessible(true);
        method.invoke(repository, at);
    }

    private static String recognitionKey(String waybill) throws Exception {
        String canonical = waybill.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", "");
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(canonical.getBytes(StandardCharsets.UTF_8));
        StringBuilder value = new StringBuilder();
        for (byte item : digest) value.append(String.format("%02x", item & 0xff));
        return value.toString();
    }
}
