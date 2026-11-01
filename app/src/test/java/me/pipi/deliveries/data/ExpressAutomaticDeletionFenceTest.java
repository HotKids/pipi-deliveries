package me.pipi.deliveries.data;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.Context;
import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.List;
import java.util.TimeZone;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressAutomaticDeletionFenceTest {
    private static final String PHONE = "13900001234";
    private static final String WAYBILL = "ZTOAUTO000001";
    private Context context;
    private ExpressDatabase helper;
    private ExpressRepository repository;
    private long now;

    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        helper = new ExpressDatabase(context);
        repository = new ExpressRepository(context, helper);
        now = System.currentTimeMillis() / 1000L * 1000L;
        repository.bindPhoneLocally(PHONE, "interface5");
        repository.bindPhoneLocally(PHONE, "interface6");
    }
    @After public void cleanup() { helper.close(); context.deleteDatabase(ExpressDatabase.DATABASE); }

    private static String time(long value) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));
        return value <= 0L ? "" : format.format(new java.util.Date(value));
    }
    private ExpressQueryResult packet(String source, long at, String detail) {
        return packet(WAYBILL, source, at, detail,
                "[{\"time\":\"" + time(at) + "\",\"context\":\"" + detail + "\"}]");
    }
    private ExpressQueryResult packet(String waybill, String source, long at, String detail, String tracks) {
        return new ExpressQueryResult(waybill, "ZTO", "中通快递", StatusSemantic.TRANSIT,
                at, time(at), detail, tracks, "", PHONE, source, "", "", "ZhongTong");
    }
    private void save(String source, ExpressQueryResult packet) {
        if ("interface5".equals(source)) repository.saveInterface5(packet, PHONE);
        else repository.saveInterface6(packet, PHONE);
    }
    private void remove(ExpressQueryResult packet, String source) {
        save(source, packet);
        ExpressItem row = repository.findByWaybill(packet.waybill, source);
        assertNotNull(row);
        repository.delete(row.rowId);
        assertNull(repository.findByWaybill(packet.waybill, source));
    }

    @Test public void unchangedAutomaticFeedStaysDeletedAfterDatabaseReopen() {
        ExpressQueryResult old = packet("interface5", now - 60_000L, "运输中心发出");
        remove(old, "interface5");
        helper.close(); helper = new ExpressDatabase(context);
        repository = new ExpressRepository(context, helper);
        save("interface5", old);
        assertNull("A repeated provider observation must not undo a user deletion",
                repository.findByWaybill(WAYBILL, "interface5"));
    }

    private int fences() {
        try (android.database.Cursor rows = helper.getReadableDatabase().rawQuery(
                "SELECT COUNT(*) FROM " + ExpressAutomaticDeletionFence.TABLE, null)) {
            assertTrue(rows.moveToFirst()); return rows.getInt(0);
        }
    }
    private String tracks(long at, String detail) {
        return "[{\"time\":\"" + time(at) + "\",\"context\":\"" + detail + "\"}]";
    }

    @Test public void interface6UsesTheSameDurableDeletionAndRealUpdateRules() {
        remove(packet("interface6", now - 60_000L, "运输中心发出"), "interface6");
        save("interface6", packet("interface6", now - 60_000L, "运输中心发出"));
        assertNull(repository.findByWaybill(WAYBILL, "interface6")); assertEquals(1, fences());
        save("interface6", packet("interface6", now - 10_000L, "到达分拨中心"));
        assertNotNull(repository.findByWaybill(WAYBILL, "interface6")); assertEquals(0, fences());
    }

    @Test public void statusCarrierAndResponseMetadataDoNotReleaseTheDeletion() {
        remove(packet("interface5", now - 60_000L, "运输中心发出"), "interface5");
        ExpressQueryResult changed = new ExpressQueryResult(WAYBILL, "YD", "韵达快递", StatusSemantic.WAITING_PICKUP,
                now - 1_000L, time(now - 60_000L), "运输中心发出", tracks(now - 60_000L, "运输中心发出"),
                "", PHONE, "interface5", "", "", "CaiNiao");
        save("interface5", changed);
        assertNull(repository.findByWaybill(WAYBILL, "interface5")); assertEquals(1, fences());
    }

    @Test public void firstAcceptedNewTimedNodeReappearsAndResumesOrdinaryUpdates() {
        remove(packet("interface5", now - 60_000L, "运输中心发出"), "interface5");
        save("interface5", packet("interface5", now - 30_000L, "到达分拨中心"));
        ExpressItem restored = repository.findByWaybill(WAYBILL, "interface5");
        assertNotNull(restored); assertFalse(restored.manuallyAdded); assertEquals(0, fences());
        save("interface5", packet("interface5", now - 10_000L, "分拨中心发出"));
        assertEquals("分拨中心发出", repository.findByWaybill(WAYBILL, "interface5").latestDetail);
    }

    @Test public void aRealTextCorrectionAtTheLatestEventTimeReleasesTheDeletion() {
        remove(packet("interface5", now - 60_000L, "运输中心发出"), "interface5");
        save("interface5", packet("interface5", now - 60_000L, "运输中心发往下一站"));
        assertNotNull(repository.findByWaybill(WAYBILL, "interface5")); assertEquals(0, fences());
    }

    @Test public void olderHistoryReorderingAndCanonicalNearDuplicatesDoNotReleaseTheDeletion() {
        long latest = now - 60_000L;
        remove(packet("interface5", latest, "您的快件运输中心发出。"), "interface5");
        String history = "[{\"time\":\"" + time(latest - 600_000L) + "\",\"context\":\"更早的揽收节点\"},"
                + "{\"time\":\"" + time(latest + 1000L) + "\",\"context\":\"您的包裹 运输中心发出!\"}]";
        save("interface5", packet(WAYBILL, "interface5", latest + 1000L, "您的包裹 运输中心发出!", history));
        assertNull(repository.findByWaybill(WAYBILL, "interface5")); assertEquals(1, fences());
        save("interface5", packet("interface5", latest - 600_000L, "更早的揽收节点"));
        assertNull(repository.findByWaybill(WAYBILL, "interface5"));
    }

    @Test public void knownTrajectoryFromAnotherBoundInterfaceDoesNotRestoreTheParcel() {
        remove(packet("interface5", now - 60_000L, "运输中心发出"), "interface5");
        save("interface6", packet("interface6", now - 60_000L, "运输中心发出"));
        assertNull(repository.findByWaybill(WAYBILL, "interface6")); assertEquals(1, fences());
        save("interface6", packet("interface6", now - 10_000L, "到达分拨中心"));
        assertNotNull(repository.findByWaybill(WAYBILL, "interface6")); assertEquals(0, fences());
    }

    @Test public void undatedFutureEmptyAndForeignSourceNodesCannotReleaseTheDeletion() {
        remove(packet("interface5", now - 60_000L, "运输中心发出"), "interface5");
        for (ExpressQueryResult invalid : List.of(packet("interface5", 0L, "没有时间的新节点"),
                packet("interface5", now + 600_000L, "未来节点"),
                packet(WAYBILL, "interface5", 0L, "", "[]"),
                packet(WAYBILL, "interface5", now - 1_000L, "其他来源的节点",
                        "[{\"time\":\"" + time(now - 1_000L) + "\",\"context\":\"其他来源的节点\",\"_pipiStatusSource\":\"kuaidi100\"}]"))) {
            save("interface5", invalid); assertNull(repository.findByWaybill(WAYBILL, "interface5"));
        }
        assertEquals(1, fences());
    }

    @Test public void firstReliableDatedNodeCanRestoreAnOriginallyUndatedParcel() {
        remove(packet("interface5", 0L, "没有时间的旧节点"), "interface5");
        save("interface5", packet("interface5", 0L, "没有时间的新节点"));
        assertNull(repository.findByWaybill(WAYBILL, "interface5"));
        save("interface5", packet("interface5", now - 30_000L, "第一次有效时间节点"));
        assertNotNull(repository.findByWaybill(WAYBILL, "interface5")); assertEquals(0, fences());
    }

    @Test public void invalidBindingOrUnqualifiedOwnerCannotConsumeNewTrajectoryEvidence() {
        remove(packet("interface5", now - 60_000L, "运输中心发出"), "interface5");
        ExpressQueryResult newer = packet("interface5", now - 10_000L, "到达分拨中心");
        repository.saveInterface5(newer, PHONE, "outdated-generation");
        ExpressQueryResult unqualified = new ExpressQueryResult(WAYBILL, "", "", StatusSemantic.TRANSIT,
                now - 10_000L, time(now - 10_000L), "到达分拨中心", tracks(now - 10_000L, "到达分拨中心"),
                "", PHONE, "interface5", "", "", "ZhongTong");
        save("interface5", unqualified);
        assertNull(repository.findByWaybill(WAYBILL, "interface5")); assertEquals(1, fences());
        save("interface5", newer);
        assertNotNull(repository.findByWaybill(WAYBILL, "interface5")); assertEquals(0, fences());
    }

    @Test public void aChangedSourceTagDoesNotTurnKnownMeizuNodesIntoAnUpdate() {
        ExpressQueryResult old = packet(WAYBILL, "interface6", now - 60_000L, "运输中心发出",
                "[{\"time\":\"" + time(now - 60_000L) + "\",\"context\":\"运输中心发出\",\"_pipiStatusSource\":\"meizu\"}]");
        remove(old, "interface6"); save("interface6", old);
        assertNull(repository.findByWaybill(WAYBILL, "interface6"));
        save("interface6", packet(WAYBILL, "interface6", now - 10_000L, "到达分拨中心",
                "[{\"time\":\"" + time(now - 10_000L) + "\",\"context\":\"到达分拨中心\",\"_pipiStatusSource\":\"meizu\"}]"));
        assertNotNull(repository.findByWaybill(WAYBILL, "interface6")); assertEquals(0, fences());
    }

    @Test public void explicitManualAddWorksWithoutConsumingTheAutomaticDeletion() {
        ExpressQueryResult old = packet("interface5", now - 60_000L, "运输中心发出"); remove(old, "interface5");
        ExpressQueryResult manual = packet(WAYBILL, "kuaidi100", now - 60_000L, "运输中心发出", old.tracksJson);
        repository.saveManualQueryResult(manual, PHONE, "interface5", now, true);
        ExpressItem added = repository.findByWaybill(WAYBILL, "interface5");
        assertNotNull(added); assertTrue(added.manuallyAdded); assertEquals(1, fences());
        save("interface5", old);
        assertTrue(repository.findByWaybill(WAYBILL, "interface5").manuallyAdded); assertEquals(1, fences());
    }

    @Test public void deletingAManualRowDoesNotIntroduceAnAutomaticFence() {
        ExpressQueryResult manual = packet("kuaidi100", now - 60_000L, "运输中心发出");
        repository.saveManualQueryResult(manual, PHONE, "interface5", now, true);
        ExpressItem added = repository.findByWaybill(WAYBILL, "interface5"); assertTrue(added.manuallyAdded);
        repository.delete(added.rowId); assertEquals(0, fences());
        save("interface5", packet("interface5", now - 60_000L, "运输中心发出"));
        assertNotNull(repository.findByWaybill(WAYBILL, "interface5"));
    }

    @Test public void failedFenceStorageRollsBackTheExistingRowAndOwnerDeletion() {
        save("interface5", packet("interface5", now - 60_000L, "运输中心发出"));
        ExpressItem old = repository.findByWaybill(WAYBILL, "interface5");
        helper.getWritableDatabase().execSQL("CREATE TRIGGER ignore_auto_deletion BEFORE INSERT ON "
                + ExpressAutomaticDeletionFence.TABLE + " BEGIN SELECT RAISE(IGNORE); END");
        assertThrows(IllegalStateException.class, () -> repository.delete(old.rowId));
        assertNotNull(repository.find(old.rowId)); assertEquals(0, fences());
        helper.getWritableDatabase().execSQL("DROP TRIGGER ignore_auto_deletion");
        repository.delete(old.rowId); assertNull(repository.find(old.rowId)); assertEquals(1, fences());
    }

    @Test public void failedFenceReleaseRollsBackTheNewAutomaticRow() {
        remove(packet("interface5", now - 60_000L, "运输中心发出"), "interface5");
        helper.getWritableDatabase().execSQL("CREATE TRIGGER ignore_auto_release BEFORE DELETE ON "
                + ExpressAutomaticDeletionFence.TABLE + " BEGIN SELECT RAISE(IGNORE); END");
        assertThrows(IllegalStateException.class, () -> save("interface5", packet("interface5", now - 10_000L, "到达分拨中心")));
        assertNull(repository.findByWaybill(WAYBILL, "interface5")); assertEquals(1, fences());
        helper.getWritableDatabase().execSQL("DROP TRIGGER ignore_auto_release");
        save("interface5", packet("interface5", now - 10_000L, "到达分拨中心"));
        assertNotNull(repository.findByWaybill(WAYBILL, "interface5")); assertEquals(0, fences());
    }

    @Test public void aDistinctRealWaybillIsNotHiddenByAnotherParcelsDeletion() {
        remove(packet("interface5", now - 60_000L, "运输中心发出"), "interface5");
        String sibling = "ZTOAUTO000002";
        save("interface5", packet(sibling, "interface5", now - 60_000L, "运输中心发出", tracks(now - 60_000L, "运输中心发出")));
        assertNotNull(repository.findByWaybill(sibling, "interface5")); assertEquals(1, fences());
        assertNull(repository.findByWaybill(WAYBILL, "interface5"));
    }

    private ExpressQueryResult order(String id, long at, String detail) {
        return new ExpressQueryResult(id, "JD", "京东快递", StatusSemantic.TRANSIT,
                at, time(at), detail, tracks(at, detail), "", PHONE, "interface5", "", "", "JingDong");
    }

    @Test public void deletedOrderKeepsItsOwnProjectionHistoryWithoutHidingAnExistingRealSibling() {
        String orderId = "3618000000000001";
        repository.saveInterface5OrderSummary(order(orderId, now - 60_000L, "订单运输节点"), PHONE);
        ExpressItem owner = repository.findByWaybill(orderId, "interface5"); assertNotNull(owner);
        assertTrue(repository.saveOrderProjection(owner, "interface5", WAYBILL, "中通快递"));
        save("interface5", packet("interface5", now - 60_000L, "真实运单运输节点"));
        assertNotNull(repository.findByWaybill(WAYBILL, "interface5"));
        repository.delete(owner.rowId);
        assertNull(repository.findByWaybill(orderId, "interface5"));
        repository.saveInterface5OrderSummary(order(orderId, now - 60_000L, "订单运输节点"), PHONE);
        assertNull(repository.findByWaybill(orderId, "interface5")); assertEquals(1, fences());
        save("interface5", packet("interface5", now - 10_000L, "真实运单的新节点"));
        assertNotNull(repository.findByWaybill(WAYBILL, "interface5")); assertEquals(1, fences());
        repository.saveInterface5OrderSummary(order(orderId, now - 5_000L, "订单自己的新节点"), PHONE);
        assertNotNull(repository.findByWaybill(orderId, "interface5")); assertEquals(0, fences());
    }

    @Test public void aRealWaybillFenceDoesNotBorrowTheKeyOfAnotherOrderOnTheSameParcel() {
        save("interface5", packet("interface5", now - 60_000L, "真实运单运输节点"));
        ExpressItem actual = repository.findByWaybill(WAYBILL, "interface5"); assertNotNull(actual);
        String orderId = "3618000000000002";
        repository.saveInterface5OrderSummary(order(orderId, now - 60_000L, "订单运输节点"), PHONE);
        ExpressItem owner = repository.findByWaybill(orderId, "interface5"); assertNotNull(owner);
        assertTrue(repository.saveOrderProjection(owner, "interface5", WAYBILL, "中通快递"));
        repository.delete(actual.rowId);
        assertNotNull(repository.find(owner.rowId));
        save("interface5", packet("interface5", now - 60_000L, "真实运单运输节点"));
        assertNull(repository.find(actual.rowId)); assertEquals(1, fences());
        repository.saveInterface5OrderSummary(order(orderId, now - 10_000L, "订单自己的新节点"), PHONE);
        assertNotNull(repository.find(owner.rowId)); assertEquals(1, fences());
    }
}
