package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.app.Application;
import android.content.Context;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.concurrent.ExecutorService;

import me.pipi.deliveries.data.ExpressAutomaticDetailPersistenceTest.SyntheticSecretBox;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.ManualTimelineAuthorityPolicy;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.CainiaoRoute;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressQueryCancellation;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

/**
 * 用户 2026-09-27 对清单 X1 的回答：「菜鸟不是会直接返回运单号吗 当然要补轨迹啊」。接口 5 菜鸟来源、还没投影的订单行，
 * 进详情和下拉照旧打开菜鸟页，页面轨迹存进这一行自己的 cn_h5 槽；页面不用来取号（AGENTS §9「谁需要自己取运单号」，
 * 用户 2026-09-26：只有小米京东件自己取号）。菜鸟页解析器本来就不从页面读运单号，包挂在行上显示的单号下。
 * 此前 T23e 让这类行不开菜鸟页，是助手的决定，不是用户的；已按上面的回答撤回。
 *
 * <p>小米列表只把京东来源判为订单行（order-scope-cases.v1.json），真实数据里这类行不该出现，这里直接构造。
 * 走真实的进详情流程，只把页面本身换成替身：计数，并把一份页面数据交给真实的菜鸟页解析器。</p>
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        shadows = {SyntheticSecretBox.class, CainiaoOrderPageTimelineTest.QueryShadow.class,
                CainiaoOrderPageTimelineTest.CaptureShadow.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class CainiaoOrderPageTimelineTest {
    private static final String PHONE = "13800004660";
    private static final String ROUTE = "https://page.cainiao.com/detail?secretkey=synthetic4660";
    private static final String PAGE_NODE = "【杭州市】快件已揽收";
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            .withZone(ZoneId.of("Asia/Shanghai"));

    private Context context;
    private ExpressRepository repository;
    private ExpressDetailActivity detail;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        CaptureShadow.pages = 0;
        CaptureShadow.providers.setLength(0);
    }

    @After public void tearDown() throws Exception {
        if (detail != null) ((ExecutorService) ReflectionHelpers.getField(detail, "worker")).shutdownNow();
        java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
        helper.setAccessible(true);
        ((ExpressDatabase) helper.get(repository)).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void anUnprojectedCainiaoOrderOpensItsPageAndKeepsTheTimeline() throws Exception {
        ExpressItem order = cainiaoRow("3630448013824660", true);
        assertTrue(order.isAccountOrder());
        assertTrue(order.projectedWaybill.isEmpty());
        assertFalse("its trusted Cainiao route is there", ExpressDetailActivity.safeCainiaoUrl(order).isEmpty());
        refresh(order, false);
        assertEquals("the detail entry opens the page", 1, CaptureShadow.pages);
        assertEquals(TimelineSlot.CN_H5, CaptureShadow.providers.toString());
        ManualTimelineAuthorityPolicy.Candidate kept =
                repository.manualTimelineCandidate(repository.find(order.rowId), TimelineSlot.CN_H5);
        assertNotNull("the page timeline is kept", kept);
        assertTrue(kept.result.tracksJson.contains(PAGE_NODE));
        refresh(order, true);
        assertEquals("a pull opens it again", 2, CaptureShadow.pages);
        ExpressItem after = repository.find(order.rowId);
        assertEquals("the page takes no waybill", "", after.projectedWaybill);
        assertEquals(order.waybill, after.displayWaybill());
    }

    @Test public void anotherCainiaoRowStillOpensItsPageForTheTimeline() throws Exception {
        ExpressItem parcel = cainiaoRow("YT1234567894660", false);
        assertFalse(parcel.isAccountOrder());
        assertFalse(ExpressDetailActivity.safeCainiaoUrl(parcel).isEmpty());
        refresh(parcel, true);
        assertEquals(1, CaptureShadow.pages);
        assertEquals(TimelineSlot.CN_H5, CaptureShadow.providers.toString());
    }

    private void refresh(ExpressItem owner, boolean pull) {
        if (detail == null) detail = Robolectric.buildActivity(ExpressDetailActivity.class).get();
        ReflectionHelpers.callInstanceMethod(detail, "refreshAutomaticDetail",
                ClassParameter.from(ExpressRepository.class, repository),
                ClassParameter.from(ExpressItem.class, repository.find(owner.rowId)),
                ClassParameter.from(ExpressQueryCancellation.class, new ExpressQueryCancellation(5_000L)),
                ClassParameter.from(boolean.class, pull),
                ClassParameter.from(boolean.class, pull));
    }

    /** An interface-5 Cainiao-source row — an order row or a waybill row — in transit, with its own route. */
    private ExpressItem cainiaoRow(String id, boolean order) throws Exception {
        String time = TIME.format(Instant.ofEpochMilli(System.currentTimeMillis() - 90L * 60_000L));
        String detail = "【上海市】快件已到达 上海转运中心";
        ExpressQueryResult feed = new ExpressQueryResult(id, order ? "JDKD" : "YTO",
                order ? "京东商品快递" : "圆通速递", StatusSemantic.TRANSIT, ExpressTimeline.parseTime(time),
                time, detail, new JSONArray().put(new JSONObject().put("time", time).put("context", detail))
                        .toString(), CainiaoRoute.token("v5"), PHONE, TimelineSlot.V5_QUERY, "v5", ROUTE, "CaiNiao");
        if (order) {
            repository.saveInterface5OrderSummary(feed, PHONE);
        } else {
            repository.saveInterface5(feed, PHONE);
        }
        ExpressItem row = repository.findByWaybill(id, "interface5");
        assertNotNull(row);
        assertTrue(repository.saveRecoveredOwnerRoute(row, repository.captureManualQueryOwner(row), feed));
        return repository.find(row.rowId);
    }

    @Implements(value = ExpressDiscoveryClient.class, isInAndroidSdk = false)
    public static class QueryShadow {
        @Implementation protected ExpressQueryResult refreshKnown(Context ignored,
                ExpressItem owner, boolean force, ExpressQueryCancellation cancellation) {
            return null;
        }
    }

    /**
     * The page itself: the detail's blocking capture counts every page it would open, and hands one page read to
     * the real Cainiao parser, as the capture's poll does.
     */
    @Implements(value = ExpressAutomaticTimelineCapture.class, isInAndroidSdk = false)
    public static class CaptureShadow {
        static volatile int pages;
        static final StringBuffer providers = new StringBuffer();

        @Implementation protected static ExpressAutomaticTimelineCapture.Result capture(
                Activity host, ExpressItem owner, String route, String provider,
                ExpressQueryCancellation cancellation) {
            pages++;
            providers.append(provider);
            String time = TIME.format(Instant.ofEpochMilli(System.currentTimeMillis() - 120L * 60_000L));
            String payload;
            try {
                payload = new JSONObject().put("extractionSource", "vue").put("statusText", "运输中")
                        .put("tracks", new JSONArray().put(new JSONObject()
                                .put("timeText", time).put("detail", PAGE_NODE)))
                        .toString();
            } catch (org.json.JSONException impossible) {
                throw new AssertionError(impossible);
            }
            ExpressQueryResult parsed = ExpressCainiaoTimelineParser.parse(payload, owner);
            return parsed == null ? null : new ExpressAutomaticTimelineCapture.Result(parsed, false, false);
        }
    }
}
