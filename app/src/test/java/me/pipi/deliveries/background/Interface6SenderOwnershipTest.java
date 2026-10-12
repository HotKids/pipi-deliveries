package me.pipi.deliveries.background;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.Context;
import java.lang.reflect.Method;
import java.util.List;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.network.ExpressApi;
import me.pipi.deliveries.network.ExpressSubscriptionClient;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import org.robolectric.util.ReflectionHelpers;

/** Real account parsing and sync retain the uniquely matched binding through SQLite publication. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class,
        shadows = {Interface6SenderOwnershipTest.Subscription.class, Interface6SenderOwnershipTest.Api.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class Interface6SenderOwnershipTest {
    private static final String PHONE = "13900006262", OTHER = "13800007171";
    private static final String WAYBILL = "SFSYNTHETICV6SENDER";
    private Context context;
    private ExpressRepository repository;
    private static JSONObject account;
    private static Runnable beforeResponse;
    private static ExpressRepository currentRepository;
    private static int recognitionCalls;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        context.getSharedPreferences("express_account_source", 0).edit().clear().commit();
        repository = ExpressRepository.get(context);
        currentRepository = repository;
        recognitionCalls = 0;
        repository.bindPhoneLocally(PHONE, "interface6");
        beforeResponse = null;
    }

    @After public void close() {
        ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void foreignReceiverAndBoundSenderAreStoredUnderTheSender() throws Exception {
        account = account(OTHER, PHONE);
        sync();
        assertStored(true);
    }

    @Test public void maskedSenderUsesTheFullBindingWithoutInventingAnExactSenderBadge() throws Exception {
        account = account(OTHER, "139****6262");
        sync();
        assertStored(false);
    }

    @Test public void aSenderUpdateKeepsItsRowAndAdvancesItsAccountState() throws Exception {
        account = account(PHONE, PHONE);
        account.getJSONObject("normalizedStatus").put("semantic", "TRANSIT").put("code", "TRANSPORT")
                .put("text", "运输中").put("eventAtMs", System.currentTimeMillis() - 600_000);
        sync();
        ExpressItem before = repository.findByWaybill(WAYBILL, "interface6");
        assertNotNull(before);
        assertEquals(StatusSemantic.TRANSIT, before.sourceSemantic);
        account = account(OTHER, PHONE);
        sync();
        assertEquals(before.rowId, assertStored(true).rowId);
    }

    @Test public void heldCarrierRecognitionPreservesTheMatchedSenderUntilPublication() throws Exception {
        account = account(OTHER, PHONE).put("cpCode", "SYNTHETIC_UNKNOWN").put("cpName", "");
        sync();
        assertEquals(1, recognitionCalls);
        ExpressItem row = assertStored(true);
        assertEquals("SYNTHETIC_UNKNOWN", row.courierCode);
        assertEquals("SF", row.carrierNormalization.standardCode);
    }

    @Test public void receiverOnlyKeepsItsOriginalOwnership() throws Exception {
        account = account(PHONE, "");
        sync();
        assertStored(false);
    }

    @Test public void emptyReceiverKeepsTheMatchedSenderAndBadge() throws Exception {
        account = account("", PHONE);
        sync();
        assertStored(true);
    }

    @Test public void anUnusableSenderKeepsTheExistingSingleBindingFallback() throws Exception {
        account = account("", "12");
        sync();
        assertStored(false);
    }

    @Test public void aUsableUnboundSenderCannotClaimTheOnlyOtherBinding() throws Exception {
        account = account("", OTHER);
        sync();
        assertNull(repository.findByWaybill(WAYBILL, "interface6"));
    }

    @Test public void twoDifferentBoundMatchesRemainUnassigned() throws Exception {
        repository.bindPhoneLocally(OTHER, "interface6");
        account = account(OTHER, PHONE);
        sync();
        assertNull(repository.findByWaybill(WAYBILL, "interface6"));
    }

    @Test public void rebindDuringTheResponseRejectsTheCapturedGeneration() throws Exception {
        account = account(OTHER, PHONE);
        beforeResponse = () -> {
            repository.unbindPhone(PHONE, "interface6");
            repository.bindPhoneLocally(PHONE, "interface6");
        };
        sync();
        assertNull(repository.findByWaybill(WAYBILL, "interface6"));
    }

    private void sync() { ExpressSyncEngine.syncAll(context, new int[3], false, "background"); }

    private ExpressItem assertStored(boolean sender) {
        ExpressItem row = repository.findByWaybill(WAYBILL, "interface6");
        assertNotNull(row);
        assertEquals(PHONE, row.phone);
        assertEquals(StatusSemantic.COMPLETED, row.sourceSemantic);
        assertEquals(account.optString("senderPhone"), row.senderPhone);
        assertEquals(sender, row.sender);
        assertEquals(1, repository.listVisibleForHome("interface6").size());
        assertEquals(row.rowId, repository.listVisibleForHome("interface6").get(0).rowId);
        return row;
    }

    private static JSONObject account(String receiver, String sender) throws Exception {
        String time = java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
                .withZone(java.time.ZoneId.of("Asia/Shanghai"))
                .format(java.time.Instant.ofEpochMilli(System.currentTimeMillis() - 60_000));
        return new JSONObject().put("mailNo", WAYBILL).put("cpCode", "SF").put("cpName", "顺丰速运")
                .put("provider", "ShunFeng").put("receiverPhone", receiver).put("senderPhone", sender)
                .put("logsiticsStatus", "SIGNED").put("logisticsStatusDesc", "已签收")
                .put("lastLogisticDetail", "快件已签收").put("logisticsGmtModified", time)
                .put("normalizedStatus", new JSONObject().put("version", 1).put("scope", "SHIPMENT")
                        .put("semantic", "COMPLETED").put("code", "SIGNED").put("text", "已签收")
                        .put("priority", 5).put("eventAtMs", System.currentTimeMillis() - 60_000)
                        .put("structured", true));
    }

    @Implements(value = ExpressSubscriptionClient.class, isInAndroidSdk = false, callThroughByDefault = true)
    public static class Subscription {
        @Implementation protected List<ExpressQueryResult> query(Context context) throws Exception {
            if (beforeResponse != null) beforeResponse.run();
            Method parse = ExpressSubscriptionClient.class.getDeclaredMethod(
                    "parseExpress", JSONObject.class, String.class, String.class);
            parse.setAccessible(true);
            return List.of((ExpressQueryResult) parse.invoke(null, account, "", ""));
        }
        @Implementation protected ExpressQueryResult queryWaybill(Context context, String waybill, String code) {
            return null;
        }
        @Implementation protected ExpressQueryResult queryManual(
                Context context, String waybill, ExpressQueryCancellation cancellation) { return null; }
    }

    @Implements(value = ExpressApi.class, isInAndroidSdk = false, callThroughByDefault = true)
    public static class Api {
        @Implementation protected void __constructor__(Context ignored) {}
        @Implementation protected CarrierNormalization recognizeCarrierInSyncRound(
                String waybill, boolean excludeJd) {
            assertEquals(WAYBILL, waybill);
            assertNull(currentRepository.findByWaybill(WAYBILL, "interface6"));
            recognitionCalls++;
            return new CarrierNormalization("SF", "顺丰速运", "shunfeng", true, "");
        }
    }
}
