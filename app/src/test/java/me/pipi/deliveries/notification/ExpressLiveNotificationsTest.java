package me.pipi.deliveries.notification;

import static org.junit.Assert.*;
import android.app.Application;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import java.util.List;
import me.pipi.deliveries.feature.express.ExpressDetailActivity;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public class ExpressLiveNotificationsTest {
    Context context;
    NotificationManager manager;
    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        Shadows.shadowOf((Application) context).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        context.getSharedPreferences("express_live_settings", 0).edit().clear().commit();
        ExpressLiveNotifications.restoreOnForeground(context);
        manager = context.getSystemService(NotificationManager.class);
        manager.cancelAll();
    }

    @Test public void liveUsesExistingStatusOrderAndOmitsCodeActions() {
        ExpressItem delivery = item(1, StatusSemantic.DELIVERY);
        ExpressItem pickup = item(2, StatusSemantic.WAITING_PICKUP);
        ExpressLiveNotifications.sync(context, List.of(delivery, pickup, item(3, StatusSemantic.WAITING_PICKUP)));
        Notification live = live();
        assertEquals("待取件 2 件", live.extras.getCharSequence(Notification.EXTRA_TITLE).toString());
        assertTrue((live.flags & Notification.FLAG_ONGOING_EVENT) != 0);
        assertNull(live.actions);
        assertTrue(live.extras.getBoolean("android.requestPromotedOngoing"));
        assertFalse(live.extras.getBoolean(Notification.EXTRA_COLORIZED));
        Intent open = Shadows.shadowOf(live.contentIntent).getSavedIntent();
        assertEquals(2, open.getLongExtra(ExpressDetailActivity.EXTRA_ROW_ID, -1));
        assertTrue(open.getBooleanExtra(ExpressDetailActivity.EXTRA_MISSING_OPENS_LIST, false));
        assertEquals(ExpressDetailActivity.class.getName(), open.getComponent().getClassName());
    }

    @Test public void filtersAreIndependentAndCarrierPendingDoesNotEnterCounts() {
        ExpressItem pending = new ExpressItem(3, "", "TEST3", "", "", StatusSemantic.WAITING_PICKUP,
                "", "", "", "[]", "", "INTERFACE5", "");
        assertTrue(pending.carrierPending());
        List<ExpressItem> items = List.of(item(1, StatusSemantic.DELIVERY), item(2, StatusSemantic.WAITING_PICKUP), pending);
        ExpressLiveNotifications.setPickupEnabled(context, false);
        ExpressLiveNotifications.sync(context, items);
        assertEquals("派送中 1 件", title());
        ExpressLiveNotifications.setDeliveryEnabled(context, false);
        ExpressLiveNotifications.sync(context, items);
        assertNull(live());
        ExpressLiveNotifications.setPickupEnabled(context, true);
        ExpressLiveNotifications.sync(context, items);
        assertEquals("待取件 1 件", title());
    }

    @Test public void dismissalSurvivesUnchangedReplayAndInvalidationButNotNewPrimary() {
        List<ExpressItem> items = List.of(item(1, StatusSemantic.DELIVERY));
        ExpressLiveNotifications.sync(context, items);
        Intent deleted = deletion();
        dismiss(deleted);
        assertNull(live());
        ExpressLiveNotifications.sync(context, items);
        assertNull(live());
        ExpressLiveNotifications.cancelPublication(context);
        ExpressLiveNotifications.sync(context, items);
        assertNull(live());
        ExpressLiveNotifications.sync(context, List.of(item(2, StatusSemantic.DELIVERY)));
        assertNotNull(live());
        dismiss(deleted);
        assertNotNull("A late callback belongs to the old primary", live());
    }

    @Test public void delayedSwipeCancelsAnUnchangedRepost() {
        List<ExpressItem> items = List.of(item(1, StatusSemantic.DELIVERY));
        ExpressLiveNotifications.sync(context, items);
        Intent deleted = deletion();
        manager.cancel(ExpressLiveNotifications.LIVE_ID);
        ExpressLiveNotifications.sync(context, items);
        assertNotNull(live());
        dismiss(deleted);
        assertNull(live());
        ExpressLiveNotifications.sync(context, items);
        assertNull(live());
    }

    @Test public void foregroundAndEndedLifecycleRestoreWithoutAcceptingOldCallbacks() {
        List<ExpressItem> items = List.of(item(1, StatusSemantic.DELIVERY));
        ExpressLiveNotifications.sync(context, items);
        Intent old = deletion();
        dismiss(old);
        ExpressLiveNotifications.restoreOnForeground(context);
        ExpressLiveNotifications.sync(context, items);
        dismiss(old);
        assertNotNull(live());
        dismiss(deletion());
        ExpressLiveNotifications.sync(context, List.of());
        ExpressLiveNotifications.sync(context, items);
        assertNotNull("Ending the activity ends its old dismissal lifecycle", live());
    }

    @Test public void foregroundFingerprintExcludesUpdateClockButIncludesPrimaryIdentity() {
        ExpressItem first = item(1, StatusSemantic.DELIVERY);
        ExpressItem clockOnly = new ExpressItem(1, "", "TEST0001", "SF", "顺丰速运", StatusSemantic.DELIVERY,
                "派送中", "Synthetic parcel", "", "[]", "", "INTERFACE5", "", 0, 100, "INTERFACE5", "");
        assertEquals(ExpressLivePresentation.from(List.of(first), true, true).fingerprint(),
                ExpressLivePresentation.from(List.of(clockOnly), true, true).fingerprint());
        ExpressItem sameTextOtherRow = new ExpressItem(2, "", "TEST0001", "SF", "顺丰速运", StatusSemantic.DELIVERY,
                "派送中", "Synthetic parcel", "", "[]", "", "INTERFACE5", "");
        assertNotEquals(ExpressLivePresentation.from(List.of(first), true, true).fingerprint(),
                ExpressLivePresentation.from(List.of(sameTextOtherRow), true, true).fingerprint());
    }

    @Test public void upgradeRemovesOnlyTheReplacedDeliveryChannelEvenWithNoEligibleRows() {
        manager.createNotificationChannel(new NotificationChannel(ExpressNotifications.CHANNEL_DELIVERY, "old delivery", 3));
        manager.createNotificationChannel(new NotificationChannel(ExpressNotifications.CHANNEL_WAITING_PICKUP, "pickup", 3));
        manager.notify(10, new Notification.Builder(context, ExpressNotifications.CHANNEL_DELIVERY).setSmallIcon(android.R.drawable.ic_dialog_info).build());
        manager.notify(11, new Notification.Builder(context, ExpressNotifications.CHANNEL_WAITING_PICKUP).setSmallIcon(android.R.drawable.ic_dialog_info).build());
        ExpressLiveNotifications.sync(context, List.of());
        assertEquals(1, manager.getActiveNotifications().length);
        assertEquals(11, manager.getActiveNotifications()[0].getId());
    }

    @Test public void ordinaryDeliveryIsConsumedWithLiveOffWhilePickupStillPosts() {
        ExpressLiveNotifications.setDeliveryEnabled(context, false);
        assertTrue(ExpressNotifications.post(context, item(1, StatusSemantic.DELIVERY)));
        assertEquals(0, manager.getActiveNotifications().length);
        assertTrue(ExpressNotifications.post(context, item(2, StatusSemantic.WAITING_PICKUP)));
        assertEquals(1, manager.getActiveNotifications().length);
        assertEquals(ExpressNotifications.CHANNEL_WAITING_PICKUP,
                manager.getActiveNotifications()[0].getNotification().getChannelId());
    }

    @Test public void deliveryReplacesOnlyItsRowsEarlierOrdinaryNotification() {
        for (StatusSemantic previous : new StatusSemantic[]{StatusSemantic.TRANSIT, StatusSemantic.PICKED}) {
            for (boolean enabled : new boolean[]{true, false}) {
                manager.cancelAll();
                ExpressLiveNotifications.setDeliveryEnabled(context, enabled);
                assertTrue(ExpressNotifications.post(context, item(1, previous)));
                assertTrue(ExpressNotifications.post(context, item(2, StatusSemantic.WAITING_PICKUP)));
                assertTrue(ExpressLiveNotifications.sync(context, List.of(item(2, StatusSemantic.WAITING_PICKUP))));
                assertNotNull(Shadows.shadowOf(manager).getNotification(1));
                assertEquals(3, manager.getActiveNotifications().length);

                assertTrue(ExpressNotifications.post(context, item(1, StatusSemantic.DELIVERY)));
                assertNull(Shadows.shadowOf(manager).getNotification(1));
                assertNotNull(Shadows.shadowOf(manager).getNotification(2));
                assertNotNull(live());
                assertTrue(ExpressNotifications.post(context, item(1, StatusSemantic.DELIVERY)));
                assertEquals(2, manager.getActiveNotifications().length);
            }
        }
    }

    @Test public void deliveryEventCancelsTheRowWithoutCancellingAnotherRowsDeliveryChannel() {
        assertTrue(ExpressNotifications.post(context, item(1, StatusSemantic.TRANSIT)));
        manager.createNotificationChannel(new NotificationChannel(ExpressNotifications.CHANNEL_DELIVERY, "legacy", 3));
        manager.notify(2, new Notification.Builder(context, ExpressNotifications.CHANNEL_DELIVERY)
                .setSmallIcon(android.R.drawable.ic_dialog_info).build());

        assertTrue(ExpressNotifications.post(context, item(1, StatusSemantic.TRANSIT), StatusSemantic.DELIVERY));
        assertNull(Shadows.shadowOf(manager).getNotification(1));
        assertNotNull(Shadows.shadowOf(manager).getNotification(2));
    }

    @Test public void pickupEventStillPostsWhenTheVisibleRowIsDelivery() {
        assertTrue(ExpressNotifications.post(context, item(1, StatusSemantic.DELIVERY), StatusSemantic.WAITING_PICKUP));
        Notification notification = Shadows.shadowOf(manager).getNotification(1);
        assertNotNull(notification);
        assertEquals(ExpressNotifications.CHANNEL_WAITING_PICKUP, notification.getChannelId());
    }

    @Test public void existingChannelPreferencesArePreserved() {
        NotificationChannel channel = new NotificationChannel(ExpressLiveNotifications.CHANNEL, "user", 1);
        channel.setSound(android.net.Uri.parse("content://synthetic/tone"), null);
        manager.createNotificationChannel(channel);
        ExpressLiveNotifications.ensureChannel(context);
        NotificationChannel after = manager.getNotificationChannel(ExpressLiveNotifications.CHANNEL);
        assertEquals(1, after.getImportance());
        assertEquals(channel.getSound(), after.getSound());
    }

    @Test public void failedDismissalIdentityCommitDoesNotPublishAndCanRetry() {
        boolean[] fail = {true};
        Context failing = new android.content.ContextWrapper(context) {
            @Override public android.content.SharedPreferences getSharedPreferences(String name, int mode) {
                android.content.SharedPreferences delegate = super.getSharedPreferences(name, mode);
                if (!name.equals("deliveries_notification_dismissals")) return delegate;
                return (android.content.SharedPreferences) java.lang.reflect.Proxy.newProxyInstance(
                        getClassLoader(), new Class[]{android.content.SharedPreferences.class}, (proxy, method, args) -> {
                    Object value = method.invoke(delegate, args);
                    if (!method.getName().equals("edit")) return value;
                    android.content.SharedPreferences.Editor editor = (android.content.SharedPreferences.Editor) value;
                    return java.lang.reflect.Proxy.newProxyInstance(getClassLoader(),
                            new Class[]{android.content.SharedPreferences.Editor.class}, (editorProxy, editMethod, editArgs) -> {
                        if (editMethod.getName().equals("commit") && fail[0]) return false;
                        Object result = editMethod.invoke(editor, editArgs);
                        return result instanceof android.content.SharedPreferences.Editor ? editorProxy : result;
                    });
                });
            }
        };
        assertFalse(ExpressLiveNotifications.sync(failing, List.of(item(1, StatusSemantic.DELIVERY))));
        assertNull(live());
        fail[0] = false;
        assertTrue(ExpressLiveNotifications.sync(failing, List.of(item(1, StatusSemantic.DELIVERY))));
        assertNotNull(live());
    }

    static ExpressItem item(long id, StatusSemantic status) {
        return new ExpressItem(id, "", "TEST000" + id, "SF", "顺丰速运", status,
                status.label, "Synthetic parcel", "", "[]", "", "INTERFACE5", "");
    }
    Notification live() { return Shadows.shadowOf(manager).getNotification(ExpressLiveNotifications.LIVE_ID); }
    String title() { return live().extras.getCharSequence(Notification.EXTRA_TITLE).toString(); }
    Intent deletion() { return Shadows.shadowOf(live().deleteIntent).getSavedIntent(); }
    void dismiss(Intent intent) {
        ExpressLiveNotifications.onDismissed(context, intent.getStringExtra(NotificationDismissalStore.EXTRA_FINGERPRINT),
                intent.getStringExtra(NotificationDismissalStore.EXTRA_TOKEN));
    }
}
