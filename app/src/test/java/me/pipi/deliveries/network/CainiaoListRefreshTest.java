package me.pipi.deliveries.network;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.Context;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
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

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class CainiaoListRefreshTest {
    private static final String PHONE = "13900000001";
    private static final String FIRST = "CN_SYNTHETIC_001";
    private static final String SECOND = "CN_SYNTHETIC_002";
    private static final String OLD = "2026-09-12 09:00:00";
    private static final String NEW = "2026-09-12 10:00:00";
    private static final String GENERIC = "快递状态已更新，点击查看>>";
    private Context context;
    private ExpressRepository repository;
    private FakeGateway gateway;
    private ExpressDiscoveryClient client;

    @Before public void setup() throws Exception {
        context = RuntimeEnvironment.getApplication();
        singleton(null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        context.getSharedPreferences("express_interface5_sync_v2", 0).edit().clear().commit();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        gateway = new FakeGateway();
        client = new ExpressDiscoveryClient(gateway, new JSONObject().put("synthetic", true));
    }

    @After public void close() throws Exception {
        java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
        helper.setAccessible(true);
        ((ExpressDatabase) helper.get(repository)).close();
        singleton(null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void newParcelQueriesOnceAndIdenticalListNeverRetriesEvenAfterFailure()
            throws Exception {
        gateway.failQuery = true;
        gateway.list = new JSONArray().put(item(FIRST, 104, OLD, GENERIC));
        sync();
        assertEquals(Collections.singletonList(FIRST), gateway.queried);
        gateway.queried.clear();
        sync();
        sync();
        assertTrue(gateway.queried.isEmpty());
        ExpressQueryResult source = source(FIRST);
        assertEquals(ExpressTimeline.parseTime(OLD), source.statusEventTime);
        assertEquals("", source.latestDetail);
    }

    @Test public void onlyTheParcelWithAnAdvancedListClockQueries() throws Exception {
        gateway.list = new JSONArray().put(item(FIRST, 104, OLD, GENERIC))
                .put(item(SECOND, 104, OLD, GENERIC));
        sync();
        gateway.queried.clear();
        gateway.list = new JSONArray().put(item(FIRST, 104, NEW, GENERIC))
                .put(item(SECOND, 104, OLD, GENERIC));
        sync();
        assertEquals(Collections.singletonList(FIRST), gateway.queried);
        gateway.queried.clear();
        sync();
        assertTrue(gateway.queried.isEmpty());
    }

    @Test public void sameClockGenericToRealHydrationDoesNotQueryAgain() throws Exception {
        gateway.list = new JSONArray().put(item(FIRST, 104, OLD, GENERIC));
        sync();
        gateway.queried.clear();
        gateway.list = new JSONArray().put(item(FIRST, 104, OLD, "快件已到达转运中心"));
        sync();
        assertTrue(gateway.queried.isEmpty());
        assertEquals("快件已到达转运中心", source(FIRST).latestDetail);
    }

    @Test public void stateChangeAtSameClockQueriesOnceIncludingNewCompletion() throws Exception {
        gateway.list = new JSONArray().put(item(FIRST, 104, OLD, GENERIC));
        sync();
        gateway.queried.clear();
        gateway.list = new JSONArray().put(item(FIRST, 107, OLD, GENERIC));
        sync();
        assertEquals(Collections.singletonList(FIRST), gateway.queried);
        gateway.queried.clear();
        sync();
        assertTrue(gateway.queried.isEmpty());
    }

    @Test public void failedOrEmptyQueryKeepsRealHeadlineAndNewSourceClock() throws Exception {
        gateway.list = new JSONArray().put(item(FIRST, 104, OLD, "快件已到达转运中心"));
        sync();
        gateway.queried.clear();
        gateway.emptyQuery = true;
        gateway.list = new JSONArray().put(item(FIRST, 105, NEW, GENERIC));
        sync();
        ExpressItem visible = repository.listVisible("interface5").get(0);
        assertEquals("快件已到达转运中心", visible.latestDetail);
        assertEquals(OLD, visible.latestTime);
        assertEquals(StatusSemantic.DELIVERY, source(FIRST).semantic);
        assertEquals(ExpressTimeline.parseTime(NEW), source(FIRST).statusEventTime);
        assertFalse(visible.latestDetail.contains("快递状态已更新"));
        gateway.queried.clear();
        sync();
        assertTrue(gateway.queried.isEmpty());
    }

    @Test public void queryClockIsNotTheListBaseline() throws Exception {
        gateway.queryTime = NEW;
        gateway.list = new JSONArray().put(item(FIRST, 104, OLD, GENERIC));
        sync();
        assertEquals(ExpressTimeline.parseTime(OLD), source(FIRST).statusEventTime);
        gateway.queried.clear();
        gateway.list = new JSONArray().put(item(FIRST, 104, NEW, GENERIC));
        sync();
        assertEquals(Collections.singletonList(FIRST), gateway.queried);
    }

    @Test public void failedQueryKeepsThePreviousRealQueryDescription() throws Exception {
        gateway.list = new JSONArray().put(item(FIRST, 104, OLD, GENERIC));
        sync();
        gateway.failQuery = true;
        gateway.list = new JSONArray().put(item(FIRST, 105, NEW, GENERIC));
        sync();
        ExpressItem visible = repository.listVisible("interface5").get(0);
        assertEquals("快件已到达转运中心", visible.latestDetail);
        assertEquals(OLD, visible.latestTime);
        assertEquals(StatusSemantic.DELIVERY, visible.semantic);
        assertEquals(ExpressTimeline.parseTime(NEW), source(FIRST).statusEventTime);
        assertEquals("[]", source(FIRST).tracksJson);
        gateway.queried.clear();
        sync();
        assertTrue(gateway.queried.isEmpty());
    }

    @Test public void olderListPacketDoesNotRegressTheComparisonBaseline() throws Exception {
        gateway.list = new JSONArray().put(item(FIRST, 105, NEW, GENERIC));
        sync();
        gateway.queried.clear();
        gateway.list = new JSONArray().put(item(FIRST, 104, OLD, GENERIC));
        sync();
        gateway.list = new JSONArray().put(item(FIRST, 105, NEW, GENERIC));
        sync();
        assertTrue(gateway.queried.isEmpty());
        assertEquals(ExpressTimeline.parseTime(NEW), source(FIRST).statusEventTime);
    }

    @Test public void backgroundAndOtherImmediateRunsQueryNewCompletionOnce() throws Exception {
        gateway.list = new JSONArray().put(item(FIRST, 107, OLD, GENERIC));
        client.sync(context, Collections.singletonList(PHONE));
        assertEquals(Collections.singletonList(FIRST), gateway.queried);
        gateway.queried.clear();
        client.sync(context, Collections.singletonList(PHONE), false);
        assertTrue(gateway.queried.isEmpty());
        gateway.list = new JSONArray().put(item(FIRST, 107, NEW, GENERIC));
        client.sync(context, Collections.singletonList(PHONE), false);
        assertTrue("A trusted completed owner remains frozen", gateway.queried.isEmpty());
    }

    @Test public void allListEntriesKeepJingdongAndShunfengOffV5Query() throws Exception {
        gateway.failQuery = true;
        gateway.list = new JSONArray()
                .put(item("1234567890123456", 104, OLD, "快件运输中").put("provider", "JingDong"))
                .put(item(SECOND, 104, OLD, "快件运输中").put("provider", "ShunFeng"));
        for (boolean pull : new boolean[]{false, true}) {
            client.sync(context, Collections.singletonList(PHONE), pull);
            assertTrue(gateway.queried.isEmpty());
        }
    }

    @Test public void explicitPullMergesJingdongOrdersAndWaybillsWithoutQuery() throws Exception {
        String order = "1234567890123456";
        String waybill = "JD_SYNTHETIC_001";
        gateway.list = new JSONArray()
                .put(item(order, 104, OLD, "快件运输中").put("provider", "JingDong"))
                .put(item(waybill, 104, OLD, "快件运输中").put("provider", "JingDong"));
        sync();
        assertTrue(gateway.queried.isEmpty());
        gateway.list = new JSONArray()
                .put(item(order, 105, NEW, "快件正在派送").put("provider", "JingDong"))
                .put(item(waybill, 105, NEW, "快件正在派送").put("provider", "JingDong"));
        sync();
        sync();
        assertTrue(gateway.queried.isEmpty());
        for (String id : new String[]{order, waybill}) {
            ExpressItem visible = repository.findByWaybill(id, "interface5");
            assertNotNull(visible);
            assertEquals("快件正在派送", visible.latestDetail);
            assertEquals(NEW, visible.latestTime);
            assertEquals(StatusSemantic.DELIVERY, visible.semantic);
            assertFalse(visible.tracksJson.contains("快件运输中"));
        }
    }

    @Test public void homeJingdongDoesNotChangeCainiaoOrShunfengQueries() throws Exception {
        gateway.failQuery = true;
        gateway.list = new JSONArray()
                .put(item("1234567890123456", 104, OLD, "快件运输中").put("provider", "JingDong"))
                .put(item(FIRST, 104, OLD, GENERIC))
                .put(item(SECOND, 104, OLD, "快件运输中").put("provider", "ShunFeng"));
        sync();
        assertEquals(Collections.singletonList(FIRST), gateway.queried);
        gateway.queried.clear();
        sync();
        assertTrue(gateway.queried.isEmpty());
    }

    @Test public void explicitDetailStillQueriesJingdongAfterHomeList() throws Exception {
        String order = "1234567890123456";
        gateway.list = new JSONArray().put(
                item(order, 104, OLD, "快件运输中").put("provider", "JingDong"));
        sync();
        assertTrue(gateway.queried.isEmpty());
        ExpressQueryResult detail = client.refreshKnown(context,
                repository.findByWaybill(order, "interface5"), true);
        assertEquals(Collections.singletonList(order), gateway.queried);
        assertNotNull(detail);
        assertEquals("快件已到达转运中心", detail.latestDetail);
    }

    @Test public void cancelledCainiaoNeverStartsTheQueuedQuery() throws Exception {
        gateway.list = new JSONArray().put(item(FIRST, 111, NEW, GENERIC));
        sync();
        assertTrue(gateway.queried.isEmpty());
    }

    @Test public void deletionBeforeTheSecondQueuedQueryStopsThatRequest() throws Exception {
        gateway.list = new JSONArray().put(item(FIRST, 104, OLD, GENERIC))
                .put(item(SECOND, 104, OLD, GENERIC));
        gateway.onFirstQuery = () -> repository.delete(
                repository.findByWaybill(SECOND, "interface5").rowId);
        sync();
        assertEquals(Collections.singletonList(FIRST), gateway.queried);
        assertNull(repository.findByWaybill(SECOND, "interface5"));
    }

    @Test public void unbindBeforeTheSecondQueuedQueryStopsThatRequest() throws Exception {
        gateway.list = new JSONArray().put(item(FIRST, 104, OLD, GENERIC))
                .put(item(SECOND, 104, OLD, GENERIC));
        gateway.onFirstQuery = () -> repository.unbindPhone(PHONE, "interface5");
        sync();
        assertEquals(Collections.singletonList(FIRST), gateway.queried);
        assertTrue(repository.phones("interface5").isEmpty());
    }

    @Test public void aReboundAccountCannotReceiveTheOldQueuedQuery() throws Exception {
        gateway.list = new JSONArray().put(item(FIRST, 104, OLD, GENERIC))
                .put(item(SECOND, 104, OLD, GENERIC));
        ExpressQueryResult rebound = ExpressDiscoveryClient.parseExpress(
                item(SECOND, 104, OLD, GENERIC), "", PHONE);
        gateway.onFirstQuery = () -> {
            repository.unbindPhone(PHONE, "interface5");
            repository.bindPhoneLocally(PHONE, "interface5");
            repository.saveInterface5(rebound, PHONE);
        };
        sync();
        assertNotNull(repository.findByWaybill(SECOND, "interface5"));
        assertEquals(Collections.singletonList(FIRST), gateway.queried);
    }

    @Test public void changedProviderCannotReceiveTheQueuedCainiaoQuery() throws Exception {
        gateway.list = new JSONArray().put(item(FIRST, 104, OLD, GENERIC))
                .put(item(SECOND, 104, OLD, GENERIC));
        ExpressQueryResult changed = ExpressDiscoveryClient.parseExpress(
                item(SECOND, 104, NEW, "快件运输中").put("provider", "ShunFeng"), "", PHONE);
        gateway.onFirstQuery = () -> repository.saveInterface5(changed, PHONE);
        sync();
        assertEquals("ShunFeng", repository.findByWaybill(SECOND, "interface5").sourceProvider);
        assertEquals(Collections.singletonList(FIRST), gateway.queried);
    }

    private void sync() throws Exception {
        client.sync(context, Collections.singletonList(PHONE), true);
    }

    private ExpressQueryResult source(String waybill) {
        ExpressItem row = repository.findByWaybill(waybill, "interface5");
        assertNotNull(row);
        return repository.automaticSourceTimeline(row);
    }

    private static void singleton(ExpressRepository value) throws Exception {
        java.lang.reflect.Field singleton = ExpressRepository.class.getDeclaredField("instance");
        singleton.setAccessible(true);
        singleton.set(null, value);
    }

    private static JSONObject item(String waybill, int state, String time, String text)
            throws Exception {
        return new JSONObject().put("mailNo", waybill).put("cpCode", "ZTO")
                .put("name", "中通快递").put("provider", "CaiNiao").put("phone", PHONE)
                .put("stateNum", state).put("details", new JSONArray().put(new JSONObject()
                        .put("time", time).put("desc", text)));
    }

    private static final class FakeGateway implements ExpressGatewayTransport {
        JSONArray list = new JSONArray();
        final List<String> queried = new ArrayList<>();
        boolean failQuery;
        boolean emptyQuery;
        Runnable onFirstQuery;
        String queryTime = OLD;

        @Override public boolean configured() { return true; }

        @Override public HttpClient.Response post(String path, JSONObject payload) throws Exception {
            JSONObject data;
            if ("/api/express/accounts/sync".equals(path)) {
                data = new JSONObject().put("expressList", list);
            } else {
                assertEquals("/api/express/timeline/source", path);
                assertEquals("v5", payload.getString("interface"));
                assertEquals("detail", payload.getString("mode"));
                JSONObject record = payload.getJSONObject("record");
                String waybill = record.getString("waybill");
                for (int index = 0; index < list.length(); index++) {
                    JSONObject source = list.getJSONObject(index);
                    if (waybill.equals(source.getString("mailNo"))) {
                        assertEquals(source.getString("provider"), record.getString("provider"));
                    }
                }
                queried.add(waybill);
                if (onFirstQuery != null) {
                    Runnable callback = onFirstQuery;
                    onFirstQuery = null;
                    callback.run();
                }
                if (failQuery) throw new java.io.IOException("synthetic query failure");
                data = item(waybill, 104, queryTime, "快件已到达转运中心")
                        .put("provider", record.getString("provider"));
                if (emptyQuery) data.put("details", new JSONArray());
            }
            return new HttpClient.Response(200,
                    new JSONObject().put("code", 0).put("data", data).toString()
                            .getBytes(StandardCharsets.UTF_8));
        }
    }
}
