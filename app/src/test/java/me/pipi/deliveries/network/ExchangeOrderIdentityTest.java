package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;

import java.util.List;
import java.util.stream.Collectors;

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
 * 2026-09-24：12 位换货单 351100058925 过去只按 16 位认订单，被存成承运商为空的包裹。
 * 改认订单之后，已经存下的那一行必须原地变成「京东购物」，不能多出第二行。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExchangeOrderIdentityTest {
    private static final String PHONE = "13900000924";
    private static final String ORDER = "351100058925";

    private Context context;
    private ExpressRepository repository;

    @Before public void setup() throws Exception {
        context = RuntimeEnvironment.getApplication();
        singleton(null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
    }

    @After public void close() throws Exception {
        java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
        helper.setAccessible(true);
        ((ExpressDatabase) helper.get(repository)).close();
        singleton(null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void aStoredExchangeOrderBecomesTheSameRowAsAnOrder() throws Exception {
        JSONObject record = new JSONObject()
                .put("mailNo", ORDER)
                .put("cpCode", "JDKD")
                .put("name", "京东商品快递")
                .put("provider", "JingDong")
                .put("phone", PHONE)
                .put("stateNum", 103)
                .put("state", "已揽件")
                .put("logisticsUpdateTime", "2026-09-23 16:16:35")
                .put("details", new JSONArray().put(new JSONObject()
                        .put("time", "2026-09-23 16:16:35")
                        .put("desc", "预计9月24日发货，9月26日(周六)送达")));

        // 旧口径下列表把它当包裹存下（ExpressDiscoveryClient.persistExpress 那条路）。现在的
        // parseExpress 已经把它认成订单、不再给出包裹结果，所以这里直接写出旧口径下的那条包裹。
        String time = "2026-09-23 16:16:35";
        String tracks = new JSONArray().put(new JSONObject()
                .put("time", time).put("context", "预计9月24日发货，9月26日(周六)送达")).toString();
        repository.saveInterface5(new ExpressQueryResult(
                ORDER, "JDKD", "京东商品快递", StatusSemantic.PICKED,
                1790151395000L, time,
                "预计9月24日发货，9月26日(周六)送达", tracks,
                "", PHONE, "interface5", "", "", "JingDong"), PHONE);
        assertEquals(1, rows().size());
        assertTrue(!rows().get(0).isAccountOrder());

        // 新口径下同一条记录走订单摘要那条路。
        assertTrue(ExpressDiscoveryClient.isAccountOrderRecord(record));
        repository.saveInterface5OrderSummary(ExpressDiscoveryClient.parseAccountOrder(record), PHONE);

        List<ExpressItem> rows = rows();
        assertEquals(1, rows.size());
        assertTrue(rows.get(0).isAccountOrder());
        assertEquals("京东购物", rows.get(0).displayCompany());
    }

    private List<ExpressItem> rows() {
        return repository.listVisible("interface5").stream()
                .filter(item -> ORDER.equals(item.waybill))
                .collect(Collectors.toList());
    }

    private static void singleton(ExpressRepository value) throws Exception {
        java.lang.reflect.Field singleton = ExpressRepository.class.getDeclaredField("instance");
        singleton.setAccessible(true);
        singleton.set(null, value);
    }
}
