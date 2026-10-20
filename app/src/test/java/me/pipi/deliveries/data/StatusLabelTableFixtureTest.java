package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;

import java.util.List;

import me.pipi.deliveries.SharedExpressFixtures;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.WorkerStatusProjection;

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

/**
 * Audits L5 and L1 (user defaults of 2026-09-25): one status label table behind one display
 * function, DANGER reads 异常件 and UNKNOWN reads 暂无状态 on every surface, and an order row without
 * a real waybill shows 已下单 for PICKED and SHIPPED while an explicit Worker UNKNOWN stays UNKNOWN.
 * The expectations are the Worker-generated shared fixture status-labels.v1.json.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class StatusLabelTableFixtureTest {
    private static final String PHONE = "13800000001";
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
        CarrierRegistry.resetForTesting();
    }

    @After public void tearDown() {
        CarrierRegistry.resetForTesting();
        database.close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void theBundledTableIsTheSharedFixtureTable() throws Exception {
        ExpressStatusLabels fixture = ExpressStatusLabels.parse(
                SharedExpressFixtures.load("status-labels.v1.json").getJSONObject("table"));
        ExpressStatusLabels bundled = ExpressStatusLabels.bundled();
        assertEquals(fixture.labels(), bundled.labels());
        assertEquals(fixture.orderLabels(), bundled.orderLabels());
        assertEquals(fixture.subtypes().size(), bundled.subtypes().size());
        for (int index = 0; index < fixture.subtypes().size(); index++) {
            ExpressStatusLabels.Subtype expected = fixture.subtypes().get(index);
            ExpressStatusLabels.Subtype actual = bundled.subtypes().get(index);
            assertEquals(expected.semantic, actual.semantic);
            assertEquals(expected.code, actual.code);
            assertEquals(expected.label, actual.label);
            assertEquals(expected.priority, actual.priority);
        }
        assertEquals(fixture.unprojectedOrderScope(), bundled.unprojectedOrderScope());
        assertEquals(fixture.unprojectedOrderSemantics(), bundled.unprojectedOrderSemantics());
        assertEquals(bundled.labels(), CarrierRegistry.statusLabels().labels());
    }

    /** Every case read back from the database: the stored row's semantic and its one display word. */
    @Test public void everySharedDisplayCaseReadsBackAsTheFixtureSays() throws Exception {
        JSONArray cases = SharedExpressFixtures.load("status-labels.v1.json").getJSONArray("cases");
        assertTrue(cases.length() >= 20);
        long eventAt = System.currentTimeMillis() - 60L * 60L * 1000L;
        String time = ExpressTimeFormat.format(eventAt);
        for (int index = 0; index < cases.length(); index++) {
            JSONObject value = cases.getJSONObject(index);
            boolean order = "ORDER".equals(value.getString("scope"));
            StatusSemantic semantic = StatusSemantic.valueOf(value.getString("semantic"));
            WorkerStatusProjection status = WorkerStatusProjection.read(new JSONObject()
                    .put("normalizedStatus", new JSONObject().put("version", 1)
                            .put("scope", value.getString("scope")).put("semantic", semantic.name())
                            .put("code", value.getString("code"))
                            .put("text", value.getString("workerText"))
                            .put("priority", value.getInt("workerPriority"))
                            .put("eventAtMs", eventAt).put("structured", true)));
            assertNotNull(status);
            String id = order ? "36104480028782" + String.format("%02d", index)
                    : "YT70000000000" + String.format("%02d", index);
            String detail = "第" + index + "条节点";
            String tracks = new JSONArray().put(new JSONObject().put("time", time)
                    .put("context", detail)).toString();
            ExpressQueryResult packet = new ExpressQueryResult(id, order ? "JDKD" : "YTO",
                    order ? "京东商品快递" : "圆通速递", semantic, eventAt, time, detail, tracks,
                    "", PHONE, TimelineSlot.V5_QUERY, "", "", order ? "JingDong" : "CaiNiao")
                    .withWorkerStatus(status);
            if (order) repository.saveInterface5OrderSummary(packet, PHONE);
            else repository.saveInterface5(packet, PHONE);
            ExpressItem row = repository.findByWaybill(id, "interface5");
            String message = value.getString("scope") + " " + semantic + " " + value.getString("code");
            JSONObject display = value.getJSONObject("display");
            if (row == null) {
                // The feed does not store an ordinary parcel that has no status at all; the display
                // function still reads such a row the same way.
                assertTrue(message, !order && semantic == StatusSemantic.UNKNOWN);
                row = new ExpressItem(1L, PHONE, id, "YTO", "圆通速递", semantic, "",
                        detail, time, WorkerStatusProjection.attach(tracks, status), "",
                        "INTERFACE5", "", eventAt, eventAt, "INTERFACE5", "");
            }
            assertEquals(message, display.getString("semantic"), row.semantic.name());
            assertEquals(message, display.getString("label"), row.displayStatus());
            ExpressItem listed = listed(row.rowId);
            if (listed != null) assertEquals(message, display.getString("label"), listed.displayStatus());
        }
    }

    /**
     * Rows stored while the Worker still sent other words (DANGER as 运输异常, UNKNOWN as empty text)
     * and UNKNOWN rows carrying a provider description read the table word now, never the old text.
     */
    @Test public void olderStoredStatusTextIsNeverShown() throws Exception {
        long eventAt = 5L;
        ExpressItem danger = new ExpressItem(1L, PHONE, "YT7000000000098", "YTO", "圆通速递",
                StatusSemantic.DANGER, "运输异常", "", "", WorkerStatusProjection.attach("[]",
                        WorkerStatusProjection.read(new JSONObject().put("normalizedStatus",
                                new JSONObject().put("version", 1).put("scope", "SHIPMENT")
                                        .put("semantic", "DANGER").put("code", "EXCEPTION")
                                        .put("text", "运输异常").put("priority", 0)
                                        .put("eventAtMs", eventAt).put("structured", true)))),
                "", "INTERFACE5", "", eventAt, eventAt, "INTERFACE5", "");
        assertEquals("异常件", danger.displayStatus());
        ExpressItem described = new ExpressItem(2L, PHONE, "YT7000000000097", "YTO", "圆通速递",
                StatusSemantic.UNKNOWN, "揽件中", "", "", "[]", "", "INTERFACE5", "");
        assertEquals("暂无状态", described.displayStatus());
    }

    @Test public void orderCancellationDelegatesToTheSameTablesOrdinaryLabel() throws Exception {
        JSONObject raw = SharedExpressFixtures.load("status-labels.v1.json").getJSONObject("table");
        raw.getJSONObject("orderLabels").put("CANCELLED", "订单已取消");
        raw.getJSONObject("labels").put("CANCELLED", "Synthetic cancellation label");
        ExpressStatusLabels table = ExpressStatusLabels.parse(raw);

        assertEquals("订单已取消", table.orderLabels().get(StatusSemantic.CANCELLED));
        assertEquals(table.label(StatusSemantic.CANCELLED), table.orderLabel(StatusSemantic.CANCELLED));
        assertEquals("Synthetic cancellation label", table.orderLabel(StatusSemantic.CANCELLED));
        assertEquals("已完成", table.orderLabel(StatusSemantic.COMPLETED));
    }

    @Test public void anOlderServedOrderCancellationWordNormalizesAnExistingStoredOrder()
            throws Exception {
        JSONObject table = SharedExpressFixtures.load("status-labels.v1.json").getJSONObject("table");
        table.getJSONObject("orderLabels").put("CANCELLED", "订单已取消");
        CarrierRegistry.installAuthority(CarrierRegistry.prepareAuthority(
                CarrierAuthorityFixture.payload().put("statusLabels", table)));
        assertEquals("订单已取消", CarrierRegistry.statusLabels().orderLabels()
                .get(StatusSemantic.CANCELLED));
        long eventAt = System.currentTimeMillis() - 60_000L;
        String time = ExpressTimeFormat.format(eventAt);
        String orderId = "3610448002878297";
        String detail = "Synthetic cancelled order timeline";
        String tracks = new JSONArray().put(new JSONObject().put("time", time)
                .put("context", detail)).toString();
        WorkerStatusProjection projection = WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1).put("scope", "ORDER")
                        .put("semantic", "CANCELLED").put("code", "SERVER_ENUM")
                        .put("text", "订单已取消").put("priority", 0)
                        .put("eventAtMs", eventAt).put("structured", true)));
        ExpressQueryResult packet = new ExpressQueryResult(orderId, "JDKD", "京东商品快递",
                StatusSemantic.CANCELLED, eventAt, time, detail, tracks,
                "", PHONE, TimelineSlot.V5_QUERY, "", "", "JingDong").withWorkerStatus(projection);
        repository.saveInterface5OrderSummary(packet, PHONE);
        ExpressItem row = repository.findByWaybill(orderId, "interface5");
        assertNotNull(row);
        String storedTracks = row.tracksJson;
        assertEquals(StatusSemantic.CANCELLED, row.semantic);
        assertEquals("已取消", row.displayStatus());
        ExpressItem listed = listed(row.rowId);
        assertNotNull(listed);
        assertEquals("已取消", listed.displayStatus());
        assertEquals(storedTracks, repository.findByWaybill(orderId, "interface5").tracksJson);
        assertEquals("订单已取消", WorkerStatusProjection.cached(row.tracksJson).text);
    }

    @Test public void theWorkerSnapshotCarriesTheTable() throws Exception {
        JSONObject table = SharedExpressFixtures.load("status-labels.v1.json").getJSONObject("table");
        table.getJSONObject("labels").put("TRANSIT", "在路上").put("UNKNOWN", "状态未知");
        CarrierRegistry.installAuthority(CarrierRegistry.prepareAuthority(
                CarrierAuthorityFixture.payload().put("statusLabels", table)));
        assertEquals("在路上", item(StatusSemantic.TRANSIT).displayStatus());
        assertEquals("状态未知", item(StatusSemantic.UNKNOWN).displayStatus());

        CarrierRegistry.installAuthority(CarrierRegistry.prepareAuthority(
                CarrierAuthorityFixture.payload()));
        assertEquals("a snapshot without statusLabels keeps the bundled table",
                "运输中", item(StatusSemantic.TRANSIT).displayStatus());
    }

    @Test public void cancellationSubtypesCannotOverrideTheOrdinaryCancellationLabel()
            throws Exception {
        JSONObject table = SharedExpressFixtures.load("status-labels.v1.json").getJSONObject("table");
        table.getJSONObject("labels").put("CANCELLED", "Synthetic cancellation label");
        table.getJSONArray("subtypes").put(new JSONObject().put("semantic", "CANCELLED")
                .put("code", "LEGACY_CANCELLED").put("label", "订单已取消").put("priority", 1));
        CarrierRegistry.installAuthority(CarrierRegistry.prepareAuthority(
                CarrierAuthorityFixture.payload().put("statusLabels", table)));
        long eventAt = System.currentTimeMillis() - 60_000L;
        String time = ExpressTimeFormat.format(eventAt);
        for (String scope : new String[]{"ORDER", "SHIPMENT"}) {
            boolean order = "ORDER".equals(scope);
            String id = order ? "3610448002878296" : "YT7000000000096";
            WorkerStatusProjection projection = WorkerStatusProjection.read(new JSONObject()
                    .put("normalizedStatus", new JSONObject().put("version", 1).put("scope", scope)
                            .put("semantic", "CANCELLED").put("code", "LEGACY_CANCELLED")
                            .put("text", "订单已取消").put("priority", 1)
                            .put("eventAtMs", eventAt).put("structured", true)));
            ExpressQueryResult packet = new ExpressQueryResult(id, order ? "JDKD" : "YTO",
                    order ? "京东商品快递" : "圆通速递", StatusSemantic.CANCELLED, eventAt,
                    time, "Synthetic cancelled timeline", "[]", "", PHONE,
                    TimelineSlot.V5_QUERY, "", "", order ? "JingDong" : "CaiNiao")
                    .withWorkerStatus(projection);
            if (order) repository.saveInterface5OrderSummary(packet, PHONE);
            else repository.saveInterface5(packet, PHONE);
            ExpressItem row = repository.findByWaybill(id, "interface5");
            assertNotNull(scope, row);
            assertEquals(scope, "Synthetic cancellation label", row.displayStatus());
            assertEquals(scope, "Synthetic cancellation label", listed(row.rowId).displayStatus());
            assertEquals("订单已取消", WorkerStatusProjection.cached(row.tracksJson).text);
        }
    }

    @Test public void aMalformedTableRejectsTheWholeSnapshot() throws Exception {
        JSONObject table = SharedExpressFixtures.load("status-labels.v1.json").getJSONObject("table");
        table.getJSONObject("labels").remove("UNKNOWN");
        JSONObject payload = CarrierAuthorityFixture.payload().put("statusLabels", table);
        CarrierAuthorityFixture.entry(payload, "YTO").put("displayName", "不会装上的名字");
        assertThrows(IllegalArgumentException.class, () -> CarrierRegistry.prepareAuthority(payload));
        assertEquals("圆通速递", CarrierRegistry.companyName("YTO", ""));
    }

    private ExpressItem listed(long rowId) {
        List<ExpressItem> rows = repository.listVisible("interface5");
        for (ExpressItem row : rows) if (row.rowId == rowId) return row;
        return null;
    }

    private static ExpressItem item(StatusSemantic semantic) {
        return new ExpressItem(1L, PHONE, "YT7000000000099", "YTO", "圆通速递", semantic,
                semantic.label, "", "", "[]", "", "INTERFACE5", "");
    }

    /** Asia/Shanghai wall clock, as the providers write it. */
    private static final class ExpressTimeFormat {
        static String format(long atMs) {
            java.text.SimpleDateFormat format =
                    new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.ROOT);
            format.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Shanghai"));
            return format.format(new java.util.Date(atMs));
        }
    }
}
