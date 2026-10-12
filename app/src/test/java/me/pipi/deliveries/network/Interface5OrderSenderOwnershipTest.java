package me.pipi.deliveries.network;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.Context;
import java.nio.charset.StandardCharsets;
import java.util.List;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class Interface5OrderSenderOwnershipTest {
    private static final String PHONE = "13900006363", OTHER = "13800007272";
    private static final String ORDER = "1234567890123456";
    private Context context;
    private ExpressRepository repository;
    private JSONObject order;
    private ExpressDiscoveryClient client;

    @Before public void setUp() throws Exception {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        context.getSharedPreferences("express_interface5_sync_v2", 0).edit().clear().commit();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        client = new ExpressDiscoveryClient(new ExpressGatewayTransport() {
            @Override public boolean configured() { return true; }
            @Override public HttpClient.Response post(String path, JSONObject payload) throws Exception {
                assertEquals("/api/express/accounts/sync", path);
                return new HttpClient.Response(200, new JSONObject().put("code", 0)
                        .put("data", new JSONObject().put("expressList", new JSONArray().put(order)))
                        .toString().getBytes(StandardCharsets.UTF_8));
            }
        }, new JSONObject().put("synthetic", true));
    }

    @After public void close() {
        ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void orderSummaryUsesItsMatchedSenderInsteadOfAnotherReceiver() throws Exception {
        order = order(OTHER, PHONE);
        assertEquals(1, client.sync(context, List.of(PHONE), false));
        ExpressItem row = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(row);
        assertTrue(row.isAccountOrder());
        assertEquals(PHONE, row.phone);
        assertEquals(PHONE, row.senderPhone);
        assertTrue(row.sender);
        assertEquals(StatusSemantic.ORDERED, row.sourceSemantic);
        assertEquals(1, repository.listVisibleForHome("interface5").size());
    }

    @Test public void receiverOwnedSummaryKeepsItsFieldsAndHasNoSenderBadge() throws Exception {
        order = order(PHONE, "");
        assertEquals(1, client.sync(context, List.of(PHONE), false));
        ExpressItem row = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(row);
        assertEquals(PHONE, row.phone);
        assertFalse(row.sender);
        assertEquals("商家正在处理订单", row.latestDetail);
    }

    @Test public void detailParsingWithoutAMatchedListOwnerKeepsItsOriginalReceiver() throws Exception {
        order = order(OTHER, PHONE);
        ExpressQueryResult detail = ExpressDiscoveryClient.parseAccountOrder(order, true, false);
        assertEquals(OTHER, detail.phone);
        assertEquals(PHONE, detail.senderPhone);
    }

    private static JSONObject order(String receiver, String sender) throws Exception {
        String time = java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
                .withZone(java.time.ZoneId.of("Asia/Shanghai"))
                .format(java.time.Instant.ofEpochMilli(System.currentTimeMillis() - 60_000));
        return new JSONObject().put("mailNo", ORDER).put("cpCode", "JDKD").put("name", "京东商品快递")
                .put("provider", "JingDong").put("phone", receiver).put("sendPhone", sender)
                .put("stateNum", 101).put("lastLogisticDetail", "商家正在处理订单")
                .put("logisticsUpdateTime", time);
    }
}
