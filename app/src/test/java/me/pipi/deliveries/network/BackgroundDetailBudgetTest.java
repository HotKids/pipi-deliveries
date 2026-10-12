package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

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
 * Audit R6 (user default of 2026-09-25): a background per-parcel account detail request runs under
 * the client's 10-second budget; it used to wait on the transport alone (15 s connect + 25 s read).
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class BackgroundDetailBudgetTest {
    private static final String PHONE = "13900000066";
    private Context context;
    private ExpressRepository repository;
    private final List<Integer> detailBudgets = new ArrayList<>();
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
                return post(path, payload, null);
            }
            @Override public HttpClient.Response post(String path, JSONObject payload,
                    ExpressQueryCancellation cancellation) throws Exception {
                JSONObject data;
                if ("/api/express/accounts/sync".equals(path)) {
                    data = new JSONObject().put("expressList", list);
                } else {
                    detailBudgets.add(cancellation == null ? -1
                            : cancellation.remainingTimeoutMillis(Integer.MAX_VALUE));
                    data = null;
                }
                JSONObject body = new JSONObject().put("code", 0);
                if (data != null) body.put("data", data);
                return new HttpClient.Response(200, body.toString().getBytes(StandardCharsets.UTF_8));
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

    @Test public void aKnownRowsBackgroundDetailRequestRunsUnderTenSeconds() throws Exception {
        ExpressItem row = new ExpressItem(1L, PHONE, "ZT7000000000061", "ZTO", "中通快递",
                StatusSemantic.TRANSIT, "运输中", "快件已发往上海", "2026-09-26 08:00:00", "[]", "",
                "INTERFACE5", "", 1L, 1L, "INTERFACE5", "");
        client.refreshKnown(context, row);
        assertBudget();
    }

    @Test public void aListUpdateDetailRequestRunsUnderTenSeconds() throws Exception {
        list = new JSONArray().put(new JSONObject().put("mailNo", "CN7000000000062")
                .put("cpCode", "ZTO").put("name", "中通快递").put("provider", "CaiNiao")
                .put("phone", PHONE).put("stateNum", 104).put("details", new JSONArray()
                        .put(new JSONObject().put("time", "2026-09-26 08:00:00")
                                .put("desc", "快件已发往上海"))));
        client.sync(context, Collections.singletonList(PHONE), true);
        assertBudget();
    }

    private void assertBudget() {
        assertEquals(1, detailBudgets.size());
        int remaining = detailBudgets.get(0);
        assertTrue("budgeted: " + remaining, remaining > 5_000
                && remaining <= ExpressDiscoveryClient.ACCOUNT_DETAIL_BUDGET_MS);
        assertEquals(10_000L, ExpressDiscoveryClient.ACCOUNT_DETAIL_BUDGET_MS);
    }

    private static void singleton(ExpressRepository value) throws Exception {
        java.lang.reflect.Field singleton = ExpressRepository.class.getDeclaredField("instance");
        singleton.setAccessible(true);
        singleton.set(null, value);
    }
}
