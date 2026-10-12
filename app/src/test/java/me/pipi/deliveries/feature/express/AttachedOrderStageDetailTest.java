package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static me.pipi.deliveries.FixtureDay.at;

import android.app.Application;
import android.content.Context;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.ManualTimelineAuthorityPolicy;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
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
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

/**
 * 归属-2（用户 2026-09-25，已登记为允许差异）：可见运单行的详情页接上挂靠订单早于归属包最早节点的订单阶段节点，
 * 沿用 09-17 D-8 的口径，只在详情页。这里走详情页自己的两条取包路径（DetailState 与 detailShown）。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class AttachedOrderStageDetailTest {
    private static final String PHONE = "13800000579";
    private static final String ORDER = "3630448013820579";
    private static final String WAYBILL = "YT1234567897051";
    private static final String PARCEL_PICKUP = "【上海市】圆通速递 已揽收";
    private static final String PARCEL_TRANSIT = "【上海市】快件已发往 上海转运中心";
    private static final String ORDER_SUBMITTED = "您提交了订单，请等待系统确认";
    private static final String ORDER_OUTBOUND = "您的订单已出库";
    private static final String ORDER_PICKUP = "您的订单已由圆通速递揽收";

    private Context context;
    private ExpressRepository repository;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
    }

    @After public void tearDown() throws Exception {
        java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
        helper.setAccessible(true);
        ((ExpressDatabase) helper.get(repository)).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void theWaybillRowsSheetShowsTheAttachedOrdersEarlierStage() throws Exception {
        String[][] parcel = {
                {at("2026-09-23 18:00:00"), PARCEL_TRANSIT},
                {at("2026-09-22 18:00:00"), PARCEL_PICKUP}};
        long parcelAt = ExpressTimeline.parseTime(parcel[0][0]);
        repository.saveInterface5(new ExpressQueryResult(WAYBILL, "YTO", "圆通速递",
                StatusSemantic.TRANSIT, parcelAt, parcel[0][0], parcel[0][1], tracks(parcel),
                "", PHONE, TimelineSlot.V5_QUERY, "", "", "CaiNiao"), PHONE);
        String[][] order = {
                {at("2026-09-23 09:00:00"), ORDER_PICKUP},
                {at("2026-09-21 20:00:00"), ORDER_OUTBOUND},
                {at("2026-09-21 10:00:00"), ORDER_SUBMITTED}};
        long orderAt = ExpressTimeline.parseTime(order[0][0]);
        repository.saveInterface5OrderSummary(new ExpressQueryResult(ORDER, "JDKD", "京东商品快递",
                StatusSemantic.TRANSIT, orderAt, order[0][0], order[0][1], tracks(order),
                "", PHONE, "interface5", "", "", "JingDong"), PHONE);
        ExpressItem orderRow = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(orderRow);
        assertTrue(repository.saveOrderProjection(orderRow, "interface5", WAYBILL, "圆通速递"));
        List<ExpressItem> listed = repository.listVisible("interface5");
        assertEquals(1, listed.size());
        ExpressItem owner = listed.get(0);
        assertEquals(WAYBILL, owner.waybill);
        List<String> expected = Arrays.asList(
                PARCEL_TRANSIT, PARCEL_PICKUP, ORDER_OUTBOUND, ORDER_SUBMITTED);

        assertEquals(expected, details(ExpressDetailActivity.detailShown(repository, owner)));
        Object state = ReflectionHelpers.callConstructor(
                Class.forName(ExpressDetailActivity.class.getName() + "$DetailState"),
                ClassParameter.from(ExpressRepository.class, repository),
                ClassParameter.from(ExpressItem.class, owner),
                ClassParameter.from(String.class, "interface5"));
        ManualTimelineAuthorityPolicy.Candidate selected = ReflectionHelpers.getField(state, "selected");
        ExpressQueryResult sheet = selected == null
                ? ReflectionHelpers.getField(state, "source")
                : ReflectionHelpers.getField(state, "displayed");
        assertEquals(expected, details(sheet));

        assertFalse("the list row stays the owner's own", owner.tracksJson.contains(ORDER_SUBMITTED));
        List<String> attachedSheet = details(ExpressDetailActivity.detailShown(
                repository, repository.find(orderRow.rowId)));
        assertFalse(attachedSheet.contains(PARCEL_TRANSIT));
    }

    private static List<String> details(ExpressQueryResult result) {
        ArrayList<String> details = new ArrayList<>();
        assertNotNull(result);
        for (ExpressTimeline.Track track : ExpressTimeline.parse(result.tracksJson, "", "")) {
            details.add(track.detail);
        }
        return details;
    }

    private static String tracks(String[][] nodes) throws Exception {
        JSONArray value = new JSONArray();
        for (String[] node : nodes) {
            value.put(new JSONObject().put("time", node[0]).put("context", node[1]));
        }
        return value.toString();
    }
}
