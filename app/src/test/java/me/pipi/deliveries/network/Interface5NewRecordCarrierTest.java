package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;

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
 * 代码 5（用户 2026-10-03「照 Pipi / iOS 的做法改」）：the interface 5 list holds back the parcel records the round recognises
 * first (new rows with a carrier to recognise), stores the rest of the list — every order summary included, as the list
 * sync requires — then hands the held records to the recognition and stores each with the carrier recognised for it; a
 * record the round did not recognise is stored as it came. Synthetic waybills and phones only.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class Interface5NewRecordCarrierTest {
    private static final String PHONE = "13900005151";
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            .withZone(ZoneId.of("Asia/Shanghai"));
    private Context context;
    private ExpressRepository repository;
    private JSONArray list = new JSONArray();
    private ExpressDiscoveryClient client;

    @Before public void setUp() throws Exception {
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
                if (!"/api/express/accounts/sync".equals(path)) throw new java.io.IOException("no per-parcel query");
                return new HttpClient.Response(200, new JSONObject().put("code", 0)
                        .put("data", new JSONObject().put("expressList", list)).toString()
                        .getBytes(StandardCharsets.UTF_8));
            }
        }, new JSONObject().put("synthetic", true));
    }

    @After public void tearDown() throws Exception {
        java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
        helper.setAccessible(true);
        ((ExpressDatabase) helper.get(repository)).close();
        singleton(null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void theListsRecordsAreRecognisedBeforeAnyIsStored() throws Exception {
        list = new JSONArray()
                .put(record("YT7700510001", minutesAgo(30)))
                .put(record("YT7700510002", minutesAgo(20)))
                .put(new JSONObject().put("mailNo", "3630448013825101").put("cpCode", "JDKD")
                        .put("name", "京东商品快递").put("provider", "JingDong").put("phone", PHONE)
                        .put("stateNum", 103).put("lastLogisticDetail", "您的订单已出库")
                        .put("logisticsUpdateTime", minutesAgo(10)));
        List<String> asked = new ArrayList<>();
        List<String> handed = new ArrayList<>();
        List<Boolean> storedWhenHanded = new ArrayList<>();
        boolean[] orderStoredFirst = {false};
        client.recognizeNewRecordsWith(new ExpressDiscoveryClient.NewRecordCarriers() {
            @Override public boolean recognizedFirst(ExpressQueryResult record) {
                asked.add(record.waybill);
                return true;
            }

            @Override public Map<String, CarrierNormalization> recognize(List<ExpressQueryResult> records) {
                orderStoredFirst[0] = repository.findByWaybill("3630448013825101", "interface5") != null;
                Map<String, CarrierNormalization> recognized = new HashMap<>();
                for (ExpressQueryResult record : records) {
                    handed.add(record.waybill);
                    storedWhenHanded.add(repository.findByWaybill(record.waybill, "interface5") != null);
                }
                recognized.put("YT7700510001", new CarrierNormalization("YTO", "圆通速递", "yuantong", true, ""));
                return recognized;
            }
        });

        client.sync(context, Collections.singletonList(PHONE), false);

        assertEquals("the parcels, not the order", List.of("YT7700510001", "YT7700510002"), asked);
        assertEquals(asked, handed);
        assertEquals(List.of(false, false), storedWhenHanded);
        assertTrue("the order summary is stored before any recognition", orderStoredFirst[0]);
        ExpressItem recognised = repository.findByWaybill("YT7700510001", "interface5");
        assertNotNull(recognised);
        assertFalse(recognised.carrierPending());
        assertEquals("圆通速递", recognised.displayCompany());
        ExpressItem asItCame = repository.findByWaybill("YT7700510002", "interface5");
        assertNotNull("a record not recognised is stored as it came", asItCame);
        assertTrue(asItCame.carrierPending());
        assertNotNull(repository.findByWaybill("3630448013825101", "interface5"));
    }

    @Test public void withoutARecognitionTheListIsStoredAsBefore() throws Exception {
        list = new JSONArray().put(record("YT7700510003", minutesAgo(30)));
        client.sync(context, Collections.singletonList(PHONE), false);
        ExpressItem row = repository.findByWaybill("YT7700510003", "interface5");
        assertNotNull(row);
        assertTrue(row.carrierPending());
        assertNull(repository.findByWaybill("YT7700510004", "interface5"));
    }

    private static JSONObject record(String waybill, String time) throws Exception {
        return new JSONObject().put("mailNo", waybill).put("cpCode", "UNKNOWNCODE")
                .put("provider", "DouYin").put("phone", PHONE)
                .put("stateNum", 104).put("details", new JSONArray().put(new JSONObject()
                        .put("time", time).put("desc", "快件运输中")));
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
