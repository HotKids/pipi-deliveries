package me.pipi.deliveries.data;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.ContentValues;
import android.content.Context;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ManualQuerySuccess;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressApi;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
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

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class Wave1LiteRegressionTest {
    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;
    private final String phone = "13800000001";

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        repository.bindPhoneLocally(phone, "interface5");
    }

    @After
    public void tearDown() {
        database.close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test
    public void deletingProjectedJdOrderReleasesOwnershipAndRestoresHiddenManualSibling() throws Exception {
        long now = System.currentTimeMillis();
        String waybill = "YT998877665544";
        String orderId = "2998877665544";
        String recentTime = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.CHINA)
                .format(new java.util.Date(now - 60_000L));

        ExpressQueryResult manualQuery = new ExpressQueryResult(
                waybill, "YTO", "圆通速递", StatusSemantic.TRANSIT,
                recentTime, "快件已发车",
                new JSONArray().put(new JSONObject().put("time", recentTime).put("context", "快件已发车")).toString(),
                "", "", TimelineSlot.V6_QUERY);
        ExpressItem manualRow = repository.saveManualQueryBatch(
                null,
                Collections.singletonList(new ManualQuerySuccess(TimelineSlot.V6_QUERY, manualQuery, now, true)),
                "", "interface5");
        assertNotNull(manualRow);
        assertEquals(1, repository.listVisible("interface5").size());

        String orderTracks = new JSONArray()
                .put(new JSONObject().put("time", recentTime).put("context", "订单已发出，正在运输中"))
                .toString();
        repository.saveInterface5OrderSummary(new ExpressQueryResult(
                orderId, "JDKD", "京东商品快递", StatusSemantic.TRANSIT, now - 60_000L,
                recentTime, "订单已发出，正在运输中", orderTracks,
                "https://wq.jd.com/order", phone, "interface5", "", "", "JingDong"), phone);
        ExpressItem orderRow = repository.listVisible("interface5").stream()
                .filter(item -> orderId.equals(item.waybill))
                .findFirst().orElse(null);
        assertNotNull(orderRow);

        ContentValues proj = new ContentValues();
        proj.put("source_id", orderId);
        proj.put("normalized_source_id", orderId);
        proj.put("binding_source", "interface5");
        proj.put("display_waybill", waybill);
        proj.put("normalized_display_waybill", waybill);
        proj.put("carrier_name", "圆通速递");
        proj.put("tracks_json", "[]");
        proj.put("updated_at", now + 2_000L);
        database.getWritableDatabase().insertOrThrow(ExpressDatabase.ORDER_PROJECTION_TABLE, null, proj);

        ContentValues own = new ContentValues();
        own.put("normalized_waybill", waybill);
        own.put("owner_provider", ExpressSourcePolicy.SOURCE_INTERFACE5);
        own.put("owner_phone", phone);
        own.put("owner_binding_generation", repository.bindingGeneration(phone, "interface5"));
        own.put("owner_row_id", orderRow.rowId);
        own.put("claimed_at", now + 2_000L);
        own.put("last_observed_at", now + 2_000L);
        own.put("owner_record_key", orderId);
        database.getWritableDatabase().insertOrThrow(ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, null, own);

        List<ExpressItem> whileProjected = repository.listVisible("interface5");
        assertEquals(1, whileProjected.size());
        assertEquals(orderRow.rowId, whileProjected.get(0).rowId);

        repository.delete(orderRow.rowId);

        List<ExpressItem> afterOrderDeleted = repository.listVisible("interface5");
        assertEquals("Manual sibling must become visible again after projected order is deleted",
                1, afterOrderDeleted.size());
        assertEquals(manualRow.rowId, afterOrderDeleted.get(0).rowId);
        assertEquals(waybill, afterOrderDeleted.get(0).displayWaybill());
    }

    @Test
    public void awaitPendingPublicationsAndPhoneTailMismatchWorkAsExpected() {
        AtomicBoolean ran = new AtomicBoolean(false);
        ExpressRepository customRepo = new ExpressRepository(context, database, command -> {
            new Thread(() -> {
                try { Thread.sleep(40L); } catch (InterruptedException ignored) { }
                ran.set(true);
                command.run();
            }).start();
        });
        customRepo.delete(999999L);
        customRepo.awaitPendingPublications(2_000L);
        assertTrue(ran.get());

        ExpressApi.QueryException mismatch = ExpressApi.QueryException.phoneTailMismatch("手机号后四位不匹配");
        assertTrue(mismatch.needsPhoneTail());
        assertTrue(mismatch.phoneTailMismatch());
    }
}
