package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import android.app.Application;
import android.content.Context;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Collections;

import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressItem;
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
import org.robolectric.annotation.SQLiteMode;

/**
 * User 2026-10-02, detail 5 of the reused-waybill rule: when the interface-5 list carries both records of a reused
 * number, the new one wins whatever their order, and the old one is ignored. Synthetic waybills and phones only.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class WaybillReuseListTest {
    private static final String PHONE = "13900000012";
    private static final long HOUR = 3600000L;
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            .withZone(ZoneId.of("Asia/Shanghai"));
    private Context context;
    private ExpressRepository repository;
    private JSONArray list = new JSONArray();
    private ExpressDiscoveryClient client;

    @Before public void setup() throws Exception {
        context = RuntimeEnvironment.getApplication();
        singleton(null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        context.getSharedPreferences("express_interface5_sync_v2", 0).edit().clear().commit();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        client = new ExpressDiscoveryClient(new ExpressGatewayTransport() {
            @Override public boolean configured() { return true; }
            @Override public HttpClient.Response post(String path, JSONObject payload) throws Exception {
                if (!"/api/express/accounts/sync".equals(path)) {
                    throw new java.io.IOException("no per-parcel query in these cases");
                }
                return new HttpClient.Response(200, new JSONObject().put("code", 0)
                        .put("data", new JSONObject().put("expressList", list)).toString()
                        .getBytes(StandardCharsets.UTF_8));
            }
        }, new JSONObject().put("synthetic", true));
    }

    @After public void close() throws Exception {
        java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
        helper.setAccessible(true);
        ((ExpressDatabase) helper.get(repository)).close();
        singleton(null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void theNewRecordWinsWhenItComesSecond() throws Exception {
        String id = "YT7000000000101";
        list = new JSONArray().put(oldRecord(id));
        sync();
        assertEquals(StatusSemantic.COMPLETED, repository.findByWaybill(id, "interface5").semantic);
        list = new JSONArray().put(oldRecord(id)).put(newRecord(id));
        sync();
        assertNew(id);
        sync();
        assertNew(id);
    }

    @Test public void theNewRecordWinsWhenItComesFirst() throws Exception {
        String id = "YT7000000000102";
        list = new JSONArray().put(oldRecord(id));
        sync();
        list = new JSONArray().put(newRecord(id)).put(oldRecord(id));
        sync();
        assertNew(id);
        sync();
        assertNew(id);
    }

    @Test public void theListKeepsTheNewRecordIndexInEitherOrder() throws Exception {
        String id = "YT7000000000103";
        long now = System.currentTimeMillis();
        JSONArray oldFirst = new JSONArray().put(oldRecord(id)).put(newRecord(id));
        assertEquals(Integer.valueOf(1), ExpressDiscoveryClient.listedRecordIndexes(oldFirst, now).get(id));
        JSONArray newFirst = new JSONArray().put(newRecord(id)).put(oldRecord(id));
        assertEquals(Integer.valueOf(0), ExpressDiscoveryClient.listedRecordIndexes(newFirst, now).get(id));
        JSONArray twoUpdates = new JSONArray()
                .put(record(id, 104, hoursAgo(30), "第一条：快件已发往上海", hoursAgo(40), "已揽收"))
                .put(record(id, 105, hoursAgo(1), "第二条：快件派送中", hoursAgo(40), "已揽收"));
        assertEquals("without a reuse the first record stays",
                Integer.valueOf(0), ExpressDiscoveryClient.listedRecordIndexes(twoUpdates, now).get(id));
    }

    private void assertNew(String id) {
        ExpressItem row = repository.findByWaybill(id, "interface5");
        assertNotNull(row);
        assertEquals(StatusSemantic.PICKED, row.semantic);
        assertEquals("揽收 synthetic new parcel", row.latestDetail);
    }

    private static JSONObject oldRecord(String id) throws Exception {
        return record(id, 107, hoursAgo(5 * 24), "已签收 synthetic old", hoursAgo(6 * 24), "运输中 synthetic old");
    }

    private static JSONObject newRecord(String id) throws Exception {
        return record(id, 103, hoursAgo(2 * 24), "揽收 synthetic new parcel", "", "");
    }

    private static JSONObject record(String waybill, int state, String time, String text,
            String earlierTime, String earlierText) throws Exception {
        JSONArray details = new JSONArray().put(new JSONObject().put("time", time).put("desc", text));
        if (!earlierTime.isEmpty()) {
            details.put(new JSONObject().put("time", earlierTime).put("desc", earlierText));
        }
        return new JSONObject().put("mailNo", waybill).put("cpCode", "YTO")
                .put("name", "圆通速递").put("provider", "CaiNiao").put("phone", PHONE)
                .put("stateNum", state).put("details", details);
    }

    private void sync() throws Exception {
        client.sync(context, Collections.singletonList(PHONE), true);
    }

    private static String hoursAgo(long hours) {
        return TIME.format(Instant.ofEpochMilli(System.currentTimeMillis() - hours * HOUR));
    }

    private static void singleton(ExpressRepository value) throws Exception {
        java.lang.reflect.Field singleton = ExpressRepository.class.getDeclaredField("instance");
        singleton.setAccessible(true);
        singleton.set(null, value);
    }
}
