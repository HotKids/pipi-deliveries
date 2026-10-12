package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static me.pipi.deliveries.FixtureDay.at;

import android.app.Application;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import me.pipi.deliveries.BuildConfig;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.WorkerStatusProjection;
import me.pipi.deliveries.network.ExpressLog;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.shadows.ShadowLog;

/**
 * 归属-8（用户 2026-09-25 采纳「预演」）：Lite 旧版本把投影订单写进别人的行，这些行一次性修复（不推送、不删行、不动缓存）。
 * 这一版只预演：beta 包逐行记下会修哪一行、怎么修（行号与哈希后的单号，不写完整单号），什么都不改；真正的修复在
 * {@link ExpressRepository#APPLY_PROJECTED_ORDER_OWNERSHIP_REPAIR} 之后，保持关闭。这里按旧版本留下的三种损坏形态造库：
 * 预演不改库、日志正确；开关打开（只在测试里）时按方案修。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ProjectedOrderOwnershipRepairTest {
    private static final String PHONE = "13800000579";
    private static final String ORDER = "3630448013820579";
    private static final String SECOND_ORDER = "3630448013829999";
    private static final String WAYBILL = "YT1234567897051";
    private static final String PARCEL_PICKUP = "【上海市】圆通速递 已揽收";
    private static final String PARCEL_TRANSIT = "【上海市】快件已发往 上海转运中心";
    private static final String ORDER_PICKUP = "您的订单已由圆通速递揽收";
    private static final String ORDER_ARRIVED = "您的订单已到达【上海转运中心】";
    private static final String SECOND_ARRIVED = "另一单：您的订单已到达【杭州分拨中心】";
    private static final String[] COPIED = {"subPhone", "senderPhone", "mailNo", "normalizedMailNo",
            "cpCode", "cpName", "logsiticsStatus", "logisticsStatusDesc", "lastLogisticDetail",
            "logisticsGmtModified", "packageDyn", "moreInfoUrl", "fromCp", "stateOwner",
            "routeOwner", "routeInterface", "routeCredential", "data1", "data2", "data3",
            "statusEventTime", "updatedAt", "listOriginAtMs"};

    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        repository.bindPhoneLocally(PHONE, "interface5");
        ShadowLog.clear();
    }

    @After public void tearDown() {
        database.close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void theRealRepairStaysOffInThisBuild() {
        assertFalse(ExpressRepository.APPLY_PROJECTED_ORDER_OWNERSHIP_REPAIR);
    }

    /** 形态一：运单行先占号，旧版本把订单写了进去。预演：一行日志、库不变。 */
    @Test public void dryRunReportsAnOverwrittenWaybillRowWithoutChangingIt() throws Exception {
        Damaged damaged = overwrittenWaybillRow();
        List<String> before = snapshot();

        ExpressRepository.OwnershipRepairResult result =
                repository.repairProjectedOrderOwnership(false);

        assertEquals(before, snapshot());
        assertEquals(1, result.found);
        assertEquals(0, result.applied);
        String line = onlyRepairLine("ownership.repair.dry_run");
        assertTrue(line, line.contains(" rowId=" + damaged.rowId + " "));
        assertTrue(line, line.contains(" shape=waybill_row_overwritten "));
        assertTrue(line, line.contains(" action=restore_waybill_from_package "));
        assertTrue(line, line.contains(" waybillHash=" + hash(WAYBILL) + " "));
        assertTrue(line, line.contains(" orderHash=" + hash(ORDER) + " "));
        assertTrue(line, line.contains(" restoreHash=" + hash(WAYBILL) + " "));
        assertNoFullNumbers(line);
        assertTrue(summaryLine("ownership.repair.dry_run.summary")
                .contains(" found=1 repaired=0 waiting=0"));
    }

    /** 开关打开时：恢复运单号，用观测表里运单记录自己的整包重建内容；订单行挂靠；不推送、不删行、不动缓存。 */
    @Test public void theRepairRestoresTheWaybillRowFromItsOwnPackage() throws Exception {
        Damaged damaged = overwrittenWaybillRow();
        List<String> untouched = snapshot(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                ExpressDatabase.ORDER_PROJECTION_TABLE, ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE, ExpressDatabase.KUAIDI100_TIMELINE_TABLE);
        int rows = count(ExpressDatabase.EXPRESS_TABLE, null);

        ExpressRepository.OwnershipRepairResult result =
                repository.repairProjectedOrderOwnership(true);

        assertEquals(1, result.applied);
        assertEquals(0, result.pending);
        ExpressItem shown = onlyListedRow();
        assertEquals(damaged.rowId, shown.rowId);
        assertEquals(WAYBILL, shown.waybill);
        assertEquals("CaiNiao", shown.sourceProvider);
        assertEquals("INTERFACE5", shown.stateOwner);
        assertEquals(PARCEL_TRANSIT, shown.latestDetail);
        assertEquals(WAYBILL, ownership("owner_record_key"));
        assertEquals(Long.toString(damaged.rowId), ownership("owner_row_id"));
        assertEquals("0", ownership("display_frozen"));
        assertEquals("no row removed", rows, count(ExpressDatabase.EXPRESS_TABLE, null));
        assertEquals("no notification", 0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null));
        assertEquals("caches untouched", untouched, snapshot(
                ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, ExpressDatabase.ORDER_PROJECTION_TABLE,
                ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE, ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE,
                ExpressDatabase.KUAIDI100_TIMELINE_TABLE));
        assertEquals(ORDER, repository.find(damaged.orderRowId).waybill);
        assertTrue(summaryLine("ownership.repair.applied.summary")
                .contains(" found=1 repaired=1 waiting=0"));

        // Afterwards the rows stay apart: the next round writes each record's own row.
        listParcel(StatusSemantic.TRANSIT, parcelTransit());
        listOrder(ORDER, StatusSemantic.TRANSIT, new String[][]{
                {at("2026-09-23 19:00:00"), "您的订单已离开【上海转运中心】"},
                {at("2026-09-23 12:30:00"), ORDER_ARRIVED},
                {at("2026-09-22 17:30:00"), ORDER_PICKUP}});
        assertEquals(PARCEL_TRANSIT, onlyListedRow().latestDetail);
        assertEquals(0, repository.repairProjectedOrderOwnership(false).found);
    }

    /** 运单记录已经不在任何列表里、观测表里也没有它的整包：只报告，不编造，等下一轮菜鸟包。 */
    @Test public void aWaybillRowWithoutItsPackageIsReportedNotInvented() throws Exception {
        Damaged damaged = overwrittenWaybillRow();
        database.getWritableDatabase().delete(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                "record_key=?", new String[]{WAYBILL});
        List<String> before = snapshot();

        String dryRun = dryRunLine();
        assertTrue(dryRun, dryRun.contains(" rowId=" + damaged.rowId + " "));
        assertTrue(dryRun, dryRun.contains(" action=wait_for_waybill_package "));
        ExpressRepository.OwnershipRepairResult applied =
                repository.repairProjectedOrderOwnership(true);

        assertEquals(before, snapshot());
        assertEquals(1, applied.found);
        assertEquals(0, applied.applied);
        assertEquals(1, applied.pending);
    }

    /**
     * 形态二：归属晚于投影——手动行被旧版本写成了订单（手动标记已丢，无法可靠恢复）。预演报「归属转给订单自己的行」；
     * 开关打开时只移归属，那一行一个字段都不改。
     */
    @Test public void aManualRowOverwrittenAfterTheProjectionMovesOwnershipToTheOrderRow()
            throws Exception {
        Damaged damaged = overwrittenManualRow();
        List<String> before = snapshot();

        String line = dryRunLine();
        assertEquals(before, snapshot());
        assertTrue(line, line.contains(" rowId=" + damaged.rowId + " "));
        assertTrue(line, line.contains(" shape=manual_or_order_row_overwritten "));
        assertTrue(line, line.contains(" action=move_owner_to_order_row "));
        assertTrue(line, line.contains(" targetRowId=" + damaged.orderRowId + " "));
        assertNoFullNumbers(line);

        String damagedRow = rawRow(damaged.rowId);
        ExpressRepository.OwnershipRepairResult result =
                repository.repairProjectedOrderOwnership(true);
        assertEquals(1, result.applied);
        assertEquals(Long.toString(damaged.orderRowId), ownership("owner_row_id"));
        assertEquals(ORDER, ownership("owner_record_key"));
        assertEquals("the overwritten row is left as it is", damagedRow, rawRow(damaged.rowId));
        assertEquals(damaged.orderRowId, onlyListedRow().rowId);
        assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null));
    }

    /** 形态三：两单一运单，先占号的订单那一行被后到的订单写走，它自己的单号在表里一行都没有：那一行就是它的。 */
    @Test public void theFirstOrdersOverwrittenRowIsGivenBack() throws Exception {
        Damaged damaged = overwrittenFirstOrderRow();
        List<String> before = snapshot();

        String line = dryRunLine();
        assertEquals(before, snapshot());
        assertTrue(line, line.contains(" rowId=" + damaged.rowId + " "));
        assertTrue(line, line.contains(" shape=first_order_row_overwritten "));
        assertTrue(line, line.contains(" action=restore_order_from_package "));
        assertTrue(line, line.contains(" orderHash=" + hash(SECOND_ORDER) + " "));
        assertTrue(line, line.contains(" restoreHash=" + hash(ORDER) + " "));
        assertNoFullNumbers(line);

        ExpressRepository.OwnershipRepairResult result =
                repository.repairProjectedOrderOwnership(true);
        assertEquals(1, result.applied);
        ExpressItem shown = onlyListedRow();
        assertEquals(damaged.rowId, shown.rowId);
        assertEquals(ORDER, shown.waybill);
        assertEquals(WAYBILL, shown.displayWaybill());
        assertEquals(ORDER_ARRIVED, shown.latestDetail);
        assertEquals(ORDER, ownership("owner_record_key"));
        assertEquals(SECOND_ORDER, repository.find(damaged.orderRowId).waybill);
        assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null));
    }

    @Test public void aFirstOrderRowWithoutItsPackageWaits() throws Exception {
        Damaged damaged = overwrittenFirstOrderRow();
        database.getWritableDatabase().delete(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                "record_key=?", new String[]{ORDER});
        List<String> before = snapshot();

        String line = dryRunLine();
        assertTrue(line, line.contains(" rowId=" + damaged.rowId + " "));
        assertTrue(line, line.contains(" action=wait_for_order_package "));
        assertEquals(1, repository.repairProjectedOrderOwnership(true).pending);
        assertEquals(before, snapshot());
    }

    /** 新版本自己的状态不是损坏形态：运单行占号、订单挂靠；订单先占号；手动行被订单接管。都不报。 */
    @Test public void healthyOwnershipIsNeverReported() throws Exception {
        ExpressItem parcel = parcel(StatusSemantic.TRANSIT, parcelTransit());
        ExpressItem order = order(ORDER, StatusSemantic.TRANSIT, orderNodes());
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
        ExpressItem second = order(SECOND_ORDER, StatusSemantic.TRANSIT, secondNodes());
        assertTrue(repository.saveOrderProjection(second, "interface5", "JT1234567890123", "极兔速递"));
        assertEquals(parcel.rowId, onlyListedRowFor(WAYBILL).rowId);

        ExpressRepository.OwnershipRepairResult result =
                repository.repairProjectedOrderOwnership(false);
        assertEquals(0, result.found);
        assertTrue(repairLines("ownership.repair.dry_run ").isEmpty());
    }

    /**
     * 维护入口：开关关着，库不变；只有 beta 包记预演日志，正式包什么都不做（单测是正式版本号时不记）。
     */
    @Test public void maintenanceOnlyDryRunsInBetaAndNeverWrites() throws Exception {
        overwrittenWaybillRow();
        // The earlier one-time migrations are done; only the repair gate is left to run.
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit()
                .putBoolean("canonical_v2", true).putBoolean("hashed_deletions_v1", true)
                .putBoolean("route_credentials_v1", true).putBoolean("local_icons_v3", true)
                .putBoolean("account_sidecar_feed_split_v1", true).commit();
        List<String> before = snapshot();
        ShadowLog.clear();

        repository.runPendingMigrations();
        repository.runPendingMigrations();

        assertEquals(before, snapshot());
        List<String> lines = repairLines("ownership.repair.dry_run ");
        if (BuildConfig.VERSION_NAME.contains("-beta")) {
            assertEquals("once per process", 1, lines.size());
        } else {
            assertTrue(lines.isEmpty());
            assertTrue(repairLines("ownership.repair").isEmpty());
        }
    }

    private static final class Damaged {
        final long rowId;
        final long orderRowId;

        Damaged(long rowId, long orderRowId) {
            this.rowId = rowId;
            this.orderRowId = orderRowId;
        }
    }

    /** The CaiNiao waybill row owned the number first; an older build wrote the order into it. */
    private Damaged overwrittenWaybillRow() throws Exception {
        ExpressItem parcel = parcel(StatusSemantic.TRANSIT, parcelTransit());
        ExpressItem order = order(ORDER, StatusSemantic.TRANSIT, orderNodes());
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
        copyRow(order.rowId, parcel.rowId);
        long projectedAt = projectedAt(ORDER);
        ContentValues owner = new ContentValues();
        owner.put("owner_record_key", ORDER);
        owner.put("claimed_at", projectedAt - 60L * 60L * 1000L);
        writable().update(ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, owner,
                "normalized_waybill=?", new String[]{WAYBILL});
        return new Damaged(parcel.rowId, order.rowId);
    }

    /** A manual row an older build took over with the order's first qualified packet. */
    private Damaged overwrittenManualRow() throws Exception {
        String time = at("2026-09-22 18:00:00");
        repository.saveManualQueryResult(new ExpressQueryResult(WAYBILL, "YTO", "圆通速递",
                StatusSemantic.PICKED, ExpressSourcePolicy.parseEventTime(time), time,
                PARCEL_PICKUP, tracks(new String[][]{{time, PARCEL_PICKUP}}),
                "", PHONE, "meizu", "", "", "")
                .withManualStatusEvidence(StatusSemantic.PICKED.label, true), PHONE, "interface5");
        ExpressItem manual = repository.findByWaybill(WAYBILL, "interface5");
        assertNotNull(manual);
        assertTrue(manual.manuallyAdded);
        repository.saveInterface5OrderSummary(orderPacket(ORDER, "", "",
                StatusSemantic.TRANSIT, orderNodes()), PHONE);
        ExpressItem order = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(order);
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, ""));
        copyRow(order.rowId, manual.rowId);
        ContentValues owner = new ContentValues();
        owner.put("normalized_waybill", WAYBILL);
        owner.put("owner_provider", "INTERFACE5");
        owner.put("owner_phone", PHONE);
        owner.put("owner_binding_generation", repository.bindingGeneration(PHONE, "interface5"));
        owner.put("owner_row_id", manual.rowId);
        owner.put("claimed_at", projectedAt(ORDER) + 60L * 60L * 1000L);
        owner.put("last_observed_at", projectedAt(ORDER) + 60L * 60L * 1000L);
        owner.put("owner_record_key", ORDER);
        writable().insertOrThrow(ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, null, owner);
        return new Damaged(manual.rowId, order.rowId);
    }

    /** Two orders on one waybill: the second order's packets overwrote the first order's owner row. */
    private Damaged overwrittenFirstOrderRow() throws Exception {
        ExpressItem first = order(ORDER, StatusSemantic.TRANSIT, orderNodes());
        ExpressItem second = order(SECOND_ORDER, StatusSemantic.TRANSIT, secondNodes());
        assertTrue(repository.saveOrderProjection(first, "interface5", WAYBILL, "圆通速递"));
        assertTrue(repository.saveOrderProjection(
                repository.find(second.rowId), "interface5", WAYBILL, "圆通速递"));
        listOrder(ORDER, StatusSemantic.TRANSIT, orderNodes());
        copyRow(second.rowId, first.rowId);
        ContentValues owner = new ContentValues();
        owner.put("owner_record_key", SECOND_ORDER);
        writable().update(ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, owner,
                "normalized_waybill=?", new String[]{WAYBILL});
        return new Damaged(first.rowId, second.rowId);
    }

    /** What an older build's write did: the source record's identity and content in another row. */
    private void copyRow(long sourceRowId, long targetRowId) {
        ContentValues values = new ContentValues();
        try (Cursor cursor = writable().query(ExpressDatabase.EXPRESS_TABLE, COPIED, "_id=?",
                new String[]{Long.toString(sourceRowId)}, null, null, null)) {
            assertTrue(cursor.moveToFirst());
            for (String column : COPIED) {
                int index = cursor.getColumnIndexOrThrow(column);
                if (cursor.getType(index) == Cursor.FIELD_TYPE_INTEGER) {
                    values.put(column, cursor.getLong(index));
                } else {
                    values.put(column, cursor.getString(index));
                }
            }
        }
        assertEquals(1, writable().update(ExpressDatabase.EXPRESS_TABLE, values, "_id=?",
                new String[]{Long.toString(targetRowId)}));
    }

    private long projectedAt(String order) {
        try (Cursor cursor = writable().query(ExpressDatabase.ORDER_PROJECTION_TABLE,
                new String[]{"updated_at"}, "normalized_source_id=?", new String[]{order},
                null, null, null)) {
            assertTrue(cursor.moveToFirst());
            return cursor.getLong(0);
        }
    }

    private ExpressItem parcel(StatusSemantic semantic, String[][] nodes) {
        listParcel(semantic, nodes);
        ExpressItem parcel = repository.findByWaybill(WAYBILL, "interface5");
        assertNotNull(parcel);
        return parcel;
    }

    private ExpressItem order(String order, StatusSemantic semantic, String[][] nodes) {
        listOrder(order, semantic, nodes);
        ExpressItem row = repository.findByWaybill(order, "interface5");
        assertNotNull(row);
        assertTrue(row.isAccountOrder());
        return row;
    }

    private void listParcel(StatusSemantic semantic, String[][] nodes) {
        long eventAt = ExpressSourcePolicy.parseEventTime(nodes[0][0]);
        repository.saveInterface5(new ExpressQueryResult(WAYBILL, "YTO", "圆通速递",
                semantic, eventAt, nodes[0][0], nodes[0][1], tracks(nodes),
                "", PHONE, TimelineSlot.V5_QUERY, "", "", "CaiNiao")
                .withWorkerStatus(status("SHIPMENT", semantic, eventAt)), PHONE);
    }

    private void listOrder(String order, StatusSemantic semantic, String[][] nodes) {
        repository.saveInterface5OrderSummary(
                orderPacket(order, "JDKD", "京东商品快递", semantic, nodes), PHONE);
    }

    private static ExpressQueryResult orderPacket(String order, String code, String name,
            StatusSemantic semantic, String[][] nodes) {
        long eventAt = ExpressSourcePolicy.parseEventTime(nodes[0][0]);
        return new ExpressQueryResult(order, code, name, semantic, eventAt, nodes[0][0],
                nodes[0][1], tracks(nodes), "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(status("ORDER", semantic, eventAt));
    }

    private static String[][] parcelTransit() {
        return new String[][]{
                {at("2026-09-23 18:00:00"), PARCEL_TRANSIT},
                {at("2026-09-22 18:00:00"), PARCEL_PICKUP}};
    }

    private static String[][] orderNodes() {
        return new String[][]{
                {at("2026-09-23 12:30:00"), ORDER_ARRIVED},
                {at("2026-09-22 17:30:00"), ORDER_PICKUP}};
    }

    private static String[][] secondNodes() {
        return new String[][]{
                {at("2026-09-23 12:40:00"), SECOND_ARRIVED},
                {at("2026-09-22 17:40:00"), "另一单：您的订单已出库"}};
    }

    private ExpressItem onlyListedRow() {
        List<ExpressItem> rows = repository.listVisible("interface5");
        assertEquals("one parcel, one row", 1, rows.size());
        return rows.get(0);
    }

    private ExpressItem onlyListedRowFor(String waybill) {
        ExpressItem found = null;
        for (ExpressItem row : repository.listVisible("interface5")) {
            if (!waybill.equals(row.displayWaybill())) continue;
            assertEquals(null, found);
            found = row;
        }
        assertNotNull(found);
        return found;
    }

    private String dryRunLine() {
        ShadowLog.clear();
        repository.repairProjectedOrderOwnership(false);
        return onlyRepairLine("ownership.repair.dry_run");
    }

    private String onlyRepairLine(String event) {
        List<String> lines = repairLines(event + " ");
        assertEquals(lines.toString(), 1, lines.size());
        return lines.get(0) + " ";
    }

    private String summaryLine(String event) {
        List<String> lines = repairLines(event + " ");
        assertEquals(1, lines.size());
        return lines.get(0);
    }

    private static List<String> repairLines(String prefix) {
        ArrayList<String> lines = new ArrayList<>();
        for (ShadowLog.LogItem item : ShadowLog.getLogsForTag(ExpressLog.TAG)) {
            if (item.msg.contains(" " + prefix)) lines.add(item.msg);
        }
        return lines;
    }

    private static void assertNoFullNumbers(String line) {
        for (String number : new String[]{WAYBILL, ORDER, SECOND_ORDER}) {
            assertFalse(line, line.contains(number));
        }
    }

    private static String hash(String number) {
        return ExpressRepository.waybillHash(number).substring(0, 12);
    }

    private String ownership(String column) {
        try (Cursor cursor = writable().query(ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE,
                new String[]{column}, "normalized_waybill=?", new String[]{WAYBILL},
                null, null, null)) {
            assertTrue(cursor.moveToFirst());
            return cursor.getString(0);
        }
    }

    private String rawRow(long rowId) {
        StringBuilder row = new StringBuilder();
        try (Cursor cursor = writable().query(ExpressDatabase.EXPRESS_TABLE, null, "_id=?",
                new String[]{Long.toString(rowId)}, null, null, null)) {
            assertTrue(cursor.moveToFirst());
            for (int index = 0; index < cursor.getColumnCount(); index++) {
                row.append(cursor.getColumnName(index)).append('=')
                        .append(cursor.getString(index)).append(';');
            }
        }
        return row.toString();
    }

    /** Every row of every table (or of the given tables), sorted. */
    private List<String> snapshot(String... tables) {
        ArrayList<String> names = new ArrayList<>();
        if (tables.length > 0) {
            Collections.addAll(names, tables);
        } else {
            try (Cursor cursor = writable().rawQuery("SELECT name FROM sqlite_master"
                    + " WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                    + " AND name<>'android_metadata' ORDER BY name", null)) {
                while (cursor.moveToNext()) names.add(cursor.getString(0));
            }
        }
        ArrayList<String> rows = new ArrayList<>();
        for (String table : names) {
            try (Cursor cursor = writable().query(table, null, null, null, null, null, null)) {
                while (cursor.moveToNext()) {
                    StringBuilder row = new StringBuilder(table).append(':');
                    for (int index = 0; index < cursor.getColumnCount(); index++) {
                        row.append(cursor.getColumnName(index)).append('=')
                                .append(cursor.getString(index)).append(';');
                    }
                    rows.add(row.toString());
                }
            }
        }
        Collections.sort(rows);
        return rows;
    }

    private int count(String table, String selection, String... args) {
        try (Cursor cursor = writable().query(table, null, selection,
                selection == null ? null : args, null, null, null)) {
            return cursor.getCount();
        }
    }

    private SQLiteDatabase writable() {
        return database.getWritableDatabase();
    }

    private static WorkerStatusProjection status(String scope, StatusSemantic semantic, long eventAt) {
        try {
            return WorkerStatusProjection.read(new JSONObject()
                    .put("normalizedStatus", new JSONObject().put("version", 1)
                            .put("scope", scope).put("semantic", semantic.name())
                            .put("code", "SERVER_ENUM").put("text", semantic.label).put("priority", 0)
                            .put("eventAtMs", eventAt).put("structured", true)));
        } catch (org.json.JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static String tracks(String[][] nodes) {
        try {
            JSONArray value = new JSONArray();
            for (String[] node : nodes) {
                value.put(new JSONObject().put("time", node[0]).put("context", node[1]));
            }
            return value.toString();
        } catch (org.json.JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
