package me.pipi.deliveries.network;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.Context;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.CarrierNormalization;
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

/** Synthetic account responses exercise the actual sync, persistence and Home path. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class Interface5SenderOwnershipTest {
    private static final String PHONE = "13900005252";
    private static final String OTHER = "13800006161";
    private static final String WAYBILL = "SFSYNTHETICSENDER01";
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            .withZone(ZoneId.of("Asia/Shanghai"));
    private Context context;
    private ExpressRepository repository;
    private ExpressDiscoveryClient client;
    private JSONArray list;
    private Runnable beforeResponse;

    @Before public void setUp() throws Exception {
        context = RuntimeEnvironment.getApplication();
        singleton(null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        context.getSharedPreferences("express_interface5_sync_v2", 0).edit().clear().commit();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        list = new JSONArray();
        client = new ExpressDiscoveryClient(new ExpressGatewayTransport() {
            @Override public boolean configured() { return true; }
            @Override public HttpClient.Response post(String path, JSONObject payload) throws Exception {
                assertEquals("/api/express/accounts/sync", path);
                if (beforeResponse != null) beforeResponse.run();
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

    @Test public void signedSenderWithAnotherReceiverIsImportedAndVisibleAtHome() throws Exception {
        JSONObject record = record(OTHER, PHONE, 107, 2);
        list.put(record);

        assertEquals(1, sync());

        assertStored(record, StatusSemantic.COMPLETED, true);
    }

    @Test public void senderListUpdateKeepsItsRowAndAdvancesTransitToSigned() throws Exception {
        JSONObject transit = record(PHONE, PHONE, 104, 30);
        list.put(transit);
        assertEquals(1, sync());
        ExpressItem before = repository.findByWaybill(WAYBILL, "interface5");
        assertEquals(StatusSemantic.TRANSIT, before.sourceSemantic);
        JSONObject signed = record(OTHER, PHONE, 107, 2);
        list = new JSONArray().put(signed);

        assertEquals(0, sync());

        ExpressItem after = assertStored(signed, StatusSemantic.COMPLETED, true);
        assertEquals(before.rowId, after.rowId);
    }

    @Test public void heldSenderRetainsItsOwnerThroughCarrierRecognition() throws Exception {
        JSONObject record = record(OTHER, PHONE, 107, 2).put("cpCode", "SYNTHETIC_UNKNOWN");
        list.put(record);
        boolean[] recognized = {false};
        client.recognizeNewRecordsWith(new ExpressDiscoveryClient.NewRecordCarriers() {
            @Override public boolean recognizedFirst(ExpressQueryResult result) { return true; }
            @Override public java.util.Map<String, CarrierNormalization> recognize(
                    List<ExpressQueryResult> records) {
                assertEquals(1, records.size());
                assertEquals(WAYBILL, records.get(0).waybill);
                assertNull(repository.findByWaybill(WAYBILL, "interface5"));
                recognized[0] = true;
                return Collections.singletonMap(WAYBILL,
                        new CarrierNormalization("SF", "顺丰速运", "shunfeng", true, ""));
            }
        });

        assertEquals(1, sync());

        assertTrue(recognized[0]);
        ExpressItem row = assertStored(record, StatusSemantic.COMPLETED, true);
        assertEquals("SYNTHETIC_UNKNOWN", row.courierCode);
        assertEquals("SF", row.carrierNormalization.standardCode);
    }

    @Test public void receiverOnlyOwnershipStillImportsWithoutASenderBadge() throws Exception {
        JSONObject record = record(PHONE, "", 104, 2);
        list.put(record);
        assertEquals(1, sync());
        assertStored(record, StatusSemantic.TRANSIT, false);
    }

    @Test public void emptyReceiverUsesMatchedSenderWithoutLosingItsBadge() throws Exception {
        JSONObject record = record("", PHONE, 107, 2);
        list.put(record);
        assertEquals(1, sync());
        assertStored(record, StatusSemantic.COMPLETED, true);
    }

    @Test public void maskedSenderCanOwnAnEmptyReceiverWithoutAnExactSenderBadge() throws Exception {
        JSONObject record = record("", "139****5252", 107, 2);
        list.put(record);
        assertEquals(1, sync());
        assertStored(record, StatusSemantic.COMPLETED, false);
    }

    @Test public void differentBoundReceiverAndSenderRemainUnassigned() throws Exception {
        repository.bindPhoneLocally(OTHER, "interface5");
        list.put(record(OTHER, PHONE, 107, 2));
        assertEquals(0, client.sync(context, Arrays.asList(PHONE, OTHER), false));
        assertNull(repository.findByWaybill(WAYBILL, "interface5"));
        assertTrue(repository.listVisibleForHome("interface5").isEmpty());
    }

    @Test public void unbindingDuringTheAccountRequestRejectsItsOldGeneration() throws Exception {
        list.put(record(PHONE, PHONE, 107, 2));
        beforeResponse = () -> repository.unbindPhone(PHONE, "interface5");
        assertEquals(0, sync());
        assertNull(repository.findByWaybill(WAYBILL, "interface5"));
        assertTrue(repository.listVisibleForHome("interface5").isEmpty());
    }

    @Test public void rebindingDuringTheAccountRequestCannotAuthorizeItsOldGeneration() throws Exception {
        String oldGeneration = repository.bindingGeneration(PHONE, "interface5");
        list.put(record(PHONE, PHONE, 107, 2));
        beforeResponse = () -> {
            repository.unbindPhone(PHONE, "interface5");
            repository.bindPhoneLocally(PHONE, "interface5");
        };
        assertEquals(0, sync());
        assertNotEquals(oldGeneration, repository.bindingGeneration(PHONE, "interface5"));
        assertNull(repository.findByWaybill(WAYBILL, "interface5"));
        assertTrue(repository.listVisibleForHome("interface5").isEmpty());
    }

    @Test public void detailAndListDeduplicationParsingRetainTheirRawReceiverWithoutAMatchedOwner()
            throws Exception {
        JSONObject record = record(OTHER, PHONE, 107, 2);
        assertEquals(OTHER, ExpressDiscoveryClient.parseExpress(record, "", PHONE, false).phone);
        assertEquals(OTHER, ExpressDiscoveryClient.parseExpress(record, "", "", true).phone);
        assertEquals(Collections.singletonMap(WAYBILL, 0),
                ExpressDiscoveryClient.listedRecordIndexes(new JSONArray().put(record), System.currentTimeMillis()));
    }

    private ExpressItem assertStored(JSONObject record, StatusSemantic semantic, boolean sender)
            throws Exception {
        ExpressItem row = repository.findByWaybill(WAYBILL, "interface5");
        assertNotNull(row);
        assertEquals(PHONE, row.phone);
        assertEquals(semantic, row.sourceSemantic);
        assertEquals(semantic, row.semantic);
        assertEquals("ShunFeng", row.sourceProvider);
        assertEquals(record.getString("sendPhone"), row.senderPhone);
        assertEquals(sender, row.sender);
        assertEquals(ExpressTimeline.parseTime(record.getJSONArray("details").getJSONObject(0)
                .getString("time")), row.statusEventTime);
        assertEquals(record.getJSONArray("details").getJSONObject(0).getString("desc"),
                repository.automaticSourceTimeline(row).latestDetail);
        List<ExpressItem> home = repository.listVisibleForHome("interface5");
        assertEquals(1, home.size());
        assertEquals(row.rowId, home.get(0).rowId);
        assertEquals(row.phone, home.get(0).phone);
        assertEquals(row.semantic, home.get(0).semantic);
        assertEquals(row.sourceSemantic, home.get(0).sourceSemantic);
        assertEquals(row.tracksJson, home.get(0).tracksJson);
        assertEquals(row.senderPhone, home.get(0).senderPhone);
        assertEquals(row.sender, home.get(0).sender);
        return row;
    }

    private int sync() throws Exception {
        return client.sync(context, Collections.singletonList(PHONE), false);
    }

    private static JSONObject record(String receiver, String sender, int state, long minutesAgo)
            throws Exception {
        String time = TIME.format(Instant.ofEpochMilli(System.currentTimeMillis() - minutesAgo * 60_000L));
        return new JSONObject().put("mailNo", WAYBILL).put("cpCode", "SF")
                .put("name", "顺丰速运").put("provider", "ShunFeng")
                .put("phone", receiver).put("sendPhone", sender).put("stateNum", state)
                .put("details", new JSONArray().put(new JSONObject().put("time", time)
                        .put("desc", state == 107 ? "已签收 synthetic sender parcel" : "运输中 synthetic sender parcel")));
    }

    private static void singleton(ExpressRepository value) throws Exception {
        java.lang.reflect.Field field = ExpressRepository.class.getDeclaredField("instance");
        field.setAccessible(true);
        field.set(null, value);
    }
}
