package me.pipi.deliveries.data;

import static org.junit.Assert.*;

import android.app.Application;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.service.notification.StatusBarNotification;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressAccountSource;
import me.pipi.deliveries.notification.ExpressLiveNotifications;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.Shadows;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class ExpressLiveLifecycleTest {
    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;
    private NotificationManager notifications;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("express_account_source", 0).edit()
                .putString("active_interface", "v5").commit();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        notifications = context.getSystemService(NotificationManager.class);
        notifications.cancelAll();
        context.getSharedPreferences("express_live_settings", 0).edit().clear().commit();
        ExpressLiveNotifications.restoreOnForeground(context);
    }

    @After public void tearDown() {
        database.close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        notifications.cancelAll();
    }

    @Test public void firstImportedLiveStateIsPublishedWithoutANewOrdinaryEvent() {
        save("SFLIVE0001", StatusSemantic.DELIVERY);
        Notification live = live();
        assertNotNull("A committed visible delivery must restore its live surface", live);
        assertEquals("派送中 1 件", live.extras.getCharSequence(Notification.EXTRA_TITLE).toString());
        assertEquals(1, notifications.getActiveNotifications().length);
    }

    @Test public void waitingTakesOverAndDeletionReturnsToDeliveryThenCancels() {
        save("SFLIVE0001", StatusSemantic.DELIVERY);
        save("SFLIVE0002", StatusSemantic.WAITING_PICKUP);
        assertNotNull(live());
        assertEquals("待取件 1 件", live().extras.getCharSequence(Notification.EXTRA_TITLE).toString());
        ExpressItem waiting = repository.findByWaybill("SFLIVE0002", "interface5");
        repository.delete(waiting.rowId);
        assertEquals("派送中 1 件", live().extras.getCharSequence(Notification.EXTRA_TITLE).toString());
        repository.delete(repository.findByWaybill("SFLIVE0001", "interface5").rowId);
        assertNull(live());
    }

    @Test public void cachedRestoreDoesNotNeedAnOrdinaryOutboxEvent() {
        save("SFLIVE0001", StatusSemantic.DELIVERY);
        assertEquals(0, android.database.DatabaseUtils.queryNumEntries(database.getReadableDatabase(),
                ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
        notifications.cancelAll();
        ExpressRepository restored = new ExpressRepository(context, database);
        restored.reconcileLiveNotifications();
        assertNotNull(live());
    }

    @Test public void terminalTransitionEndsLiveAndPreservesTheOrdinaryCompletion() {
        save("SFLIVE0001", StatusSemantic.DELIVERY);
        save("SFLIVE0001", StatusSemantic.COMPLETED);
        assertNull(live());
        assertEquals(StatusSemantic.COMPLETED,
                repository.findByWaybill("SFLIVE0001", "interface5").semantic);
        assertEquals(1, notifications.getActiveNotifications().length);
    }

    @Test public void interfaceSwitchPreservesTheExistingDurableOwnerVisibility() throws Exception {
        saveAccount("TESTOWNER0001");
        assertNotNull(live());
        long version = repository.invalidationVersion();
        ExpressAccountSource.toggle(context);
        assertEquals(version, repository.invalidationVersion());
        assertEquals(1, repository.listVisible("interface6").size());
        repository.requestPendingNotificationReplay();
        assertNotNull(live());
    }

    @Test public void legacyUnownedRowsFollowInterfaceWithoutRepositoryInvalidation() throws Exception {
        saveAccount("TESTOWNER0001");
        // Legacy stores can contain feed rows before their durable automatic owner is established.
        database.getWritableDatabase().delete(ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, null, null);
        long version = repository.invalidationVersion();
        ExpressAccountSource.toggle(context);
        assertEquals(version, repository.invalidationVersion());
        assertTrue(repository.listVisible("interface6").isEmpty());
        repository.requestPendingNotificationReplay();
        assertNull(live());
        ExpressAccountSource.toggle(context);
        repository.requestPendingNotificationReplay();
        assertNotNull(live());
    }

    @Test public void manualParcelStaysVisibleAfterAccountSwitch() {
        save("SFLIVE0001", StatusSemantic.DELIVERY);
        ExpressAccountSource.toggle(context);
        repository.requestPendingNotificationReplay();
        assertNotNull(live());
    }

    @Test @Config(sdk = 33) public void grantedPermissionReplaysCachedLiveWithoutOutbox() {
        Shadows.shadowOf((Application) context).denyPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        save("SFLIVE0001", StatusSemantic.DELIVERY);
        assertNull(live());
        Shadows.shadowOf((Application) context).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        repository.requestPendingNotificationReplay();
        assertNotNull(live());
    }

    private void saveAccount(String waybill) throws Exception {
        String phone = "13800000001";
        repository.bindPhoneLocally(phone, "interface5");
        long now = System.currentTimeMillis() - 120_000L;
        org.json.JSONObject state = new org.json.JSONObject().put("version", 1).put("scope", "SHIPMENT")
                .put("semantic", "DELIVERY").put("code", "DELIVERY").put("text", "派送中")
                .put("priority", 3).put("eventAtMs", now).put("structured", true);
        repository.saveInterface5(new ExpressQueryResult(waybill, "SF", "顺丰速运", StatusSemantic.DELIVERY,
                now, "", "Synthetic delivery", "[]", "", phone, "interface5", "", "", "SF")
                .withWorkerStatus(me.pipi.deliveries.model.WorkerStatusProjection.read(
                        new org.json.JSONObject().put("normalizedStatus", state))), phone);
    }

    private void save(String waybill, StatusSemantic semantic) {
        long now = System.currentTimeMillis() - (semantic == StatusSemantic.COMPLETED ? 60_000L : 120_000L);
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA);
        format.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));
        String stamp = format.format(new Date(now));
        ExpressQueryResult result = new ExpressQueryResult(waybill, "SF", "顺丰速运", semantic,
                now, stamp, semantic.name(), "[{\"time\":\"" + stamp
                + "\",\"context\":\"" + semantic.name() + "\"}]", "", "",
                TimelineSlot.V4_QUERY, "", "", "").withManualStatusEvidence(semantic.label, true);
        repository.saveManualQueryResult(result, "", "interface5");
    }

    private Notification live() {
        for (StatusBarNotification posted : notifications.getActiveNotifications()) {
            if ("express_live".equals(posted.getNotification().getChannelId())) {
                return posted.getNotification();
            }
        }
        return null;
    }
}
