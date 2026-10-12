package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

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
import me.pipi.deliveries.model.ExpressQueryResult;
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
 * Audit L11 (user 2026-09-25): three interface-5 list edges read as iOS parseAccountSyncResult /
 * parseParcel reads them — a record without an identity refuses the whole list, a repeated identity
 * keeps its first record, and a record without details falls back to its own headline and time
 * instead of being dropped.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class Interface5ListEdgesTest {
    private static final String PHONE = "13900000011";
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

    @Test public void aRecordWithoutAnIdentityRefusesTheWholeList() throws Exception {
        list = new JSONArray().put(record("ZT7000000000001", 104, minutesAgo(30), "快件已发往上海"))
                .put(new JSONObject().put("cpCode", "ZTO").put("stateNum", 104));
        try {
            sync();
            fail("a list with an unreadable record is refused");
        } catch (IllegalStateException expected) {
            // Nothing from that list is saved.
        }
        assertNull(repository.findByWaybill("ZT7000000000001", "interface5"));
    }

    @Test public void aRepeatedIdentityKeepsItsFirstRecord() throws Exception {
        list = new JSONArray()
                .put(record("ZT7000000000002", 104, minutesAgo(30), "第一条：快件已发往上海"))
                .put(record("ZT7000000000002", 105, minutesAgo(10), "第二条：快件派送中"));
        sync();
        ExpressItem row = repository.findByWaybill("ZT7000000000002", "interface5");
        assertNotNull(row);
        assertEquals("第一条：快件已发往上海", row.latestDetail);
        assertEquals(StatusSemantic.TRANSIT, row.semantic);
    }

    @Test public void aRecordWithoutDetailsFallsBackToItsOwnHeadlineAndTime() throws Exception {
        String time = minutesAgo(20);
        list = new JSONArray().put(new JSONObject().put("mailNo", "ZT7000000000003")
                .put("cpCode", "ZTO").put("name", "中通快递").put("provider", "CaiNiao")
                .put("phone", PHONE).put("stateNum", 104)
                .put("lastLogisticDetail", "快件已到达【上海转运中心】")
                .put("logisticsUpdateTime", time).put("details", new JSONArray()));
        sync();
        ExpressItem row = repository.findByWaybill("ZT7000000000003", "interface5");
        assertNotNull(row);
        assertEquals("快件已到达【上海转运中心】", row.latestDetail);
        assertEquals(time, row.latestTime);
    }

    /** Parse-level: the list keeps an UNKNOWN record without details; a query answer still does not. */
    @Test public void onlyTheListKeepsARecordWithNeitherStatusNorDetails() throws Exception {
        JSONObject bare = new JSONObject().put("mailNo", "ZT7000000000004").put("cpCode", "ZTO")
                .put("name", "中通快递").put("provider", "CaiNiao")
                .put("lastLogisticDetail", "快递状态已更新，点击查看")
                .put("logisticsUpdateTime", minutesAgo(5)).put("details", new JSONArray());
        ExpressQueryResult listed = ExpressDiscoveryClient.parseExpress(bare, "", PHONE, true);
        assertNotNull(listed);
        assertEquals("the placeholder is not a headline", "", listed.latestDetail);
        assertNull(ExpressDiscoveryClient.parseExpress(bare, "", PHONE));
        JSONObject order = new JSONObject().put("mailNo", "3610448002878299").put("cpCode", "JDKD")
                .put("name", "京东商品快递").put("provider", "JingDong").put("stateNum", 103)
                .put("lastLogisticDetail", "您的订单已出库").put("logisticsUpdateTime", minutesAgo(5));
        assertEquals("您的订单已出库",
                ExpressDiscoveryClient.parseAccountOrder(order, false, true).latestDetail);
        assertEquals("", ExpressDiscoveryClient.parseAccountOrder(order).latestDetail);
    }

    private void sync() throws Exception {
        client.sync(context, Collections.singletonList(PHONE), true);
    }

    private static JSONObject record(String waybill, int state, String time, String text)
            throws Exception {
        return new JSONObject().put("mailNo", waybill).put("cpCode", "ZTO")
                .put("name", "中通快递").put("provider", "CaiNiao").put("phone", PHONE)
                .put("stateNum", state).put("details", new JSONArray().put(new JSONObject()
                        .put("time", time).put("desc", text)));
    }

    private static String minutesAgo(long minutes) {
        return TIME.format(Instant.ofEpochMilli(System.currentTimeMillis() - minutes * 60_000L));
    }

    private static void singleton(ExpressRepository value) throws Exception {
        java.lang.reflect.Field singleton = ExpressRepository.class.getDeclaredField("instance");
        singleton.setAccessible(true);
        singleton.set(null, value);
    }
}
