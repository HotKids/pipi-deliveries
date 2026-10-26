package me.pipi.deliveries.notification;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import java.util.List;
import me.pipi.deliveries.R;
import me.pipi.deliveries.feature.express.ExpressDetailActivity;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

/** One derived live notification; shipment records remain owned by the repository. */
public final class ExpressLiveNotifications {
    static final String CHANNEL = "express_live";
    // Ordinary Lite notification IDs are nonnegative row IDs.
    static final int LIVE_ID = 0xc4000000;
    private static final NotificationKey KEY = NotificationKey.singleton("express.live", LIVE_ID);
    private static final String PREFS = "express_live_settings";
    private static final String DELIVERY = "delivery";
    private static final String PICKUP = "pickup";

    private ExpressLiveNotifications() {}

    public static boolean deliveryEnabled(Context context) {
        return context.getSharedPreferences(PREFS, 0).getBoolean(DELIVERY, true);
    }

    public static boolean pickupEnabled(Context context) {
        return context.getSharedPreferences(PREFS, 0).getBoolean(PICKUP, true);
    }

    public static void setDeliveryEnabled(Context context, boolean enabled) {
        context.getSharedPreferences(PREFS, 0).edit().putBoolean(DELIVERY, enabled).apply();
    }

    public static void setPickupEnabled(Context context, boolean enabled) {
        context.getSharedPreferences(PREFS, 0).edit().putBoolean(PICKUP, enabled).apply();
    }

    public static void ensureChannel(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel existing = manager.getNotificationChannel(CHANNEL);
        if (existing == null) {
            existing = new NotificationChannel(CHANNEL, context.getString(R.string.notification_channel_live),
                    NotificationManager.IMPORTANCE_DEFAULT);
            existing.setSound(null, null);
            existing.enableVibration(false);
        }
        existing.setName(context.getString(R.string.notification_channel_live));
        existing.setDescription(context.getString(R.string.notification_channel_live_description));
        manager.createNotificationChannel(existing);
    }

    public static synchronized void restoreOnForeground(Context context) {
        NotificationDismissalStore.clearAll(context);
    }

    public static synchronized void cancel(Context context) {
        cancelPublication(context);
        NotificationDismissalStore.clear(context, KEY);
    }

    /** Invalidates a stale publication without ending an unchanged dismissal lifecycle. */
    public static synchronized void cancelPublication(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) PromotedNotificationPublisher.cancel(manager, KEY);
    }

    static synchronized void onDismissed(Context context, String fingerprint, String token) {
        if (NotificationDismissalStore.recordIfCurrent(context, KEY, fingerprint, token)) {
            // The OS swipe can precede this asynchronous callback and an unchanged repost.
            cancelPublication(context);
        }
    }

    public static synchronized boolean sync(Context context, List<ExpressItem> visible) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return false;
        ExpressNotifications.clearReplacedDeliveryNotifications(context);
        ExpressLivePresentation spec = ExpressLivePresentation.from(visible,
                deliveryEnabled(context), pickupEnabled(context));
        if (spec == null) {
            cancel(context);
            return true;
        }
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) return false;
        ensureChannel(context);
        Notification.Builder enhanced = builder(context, spec);
        if (!NotificationDismissalStore.prepare(context, enhanced, KEY, spec.fingerprint())) {
            return NotificationDismissalStore.isDismissed(context, KEY, spec.fingerprint());
        }
        PromotedNotificationPublisher.configureEnhanced(context, enhanced, spec.capsule);
        SamsungNowBarCompat.addChipColorIfAllowed(context, enhanced, spec.accent);
        SamsungNowBarCompat.applyIfAllowed(context, enhanced, spec.smallIcon, spec.capsule,
                spec.title, ExpressNotifications.breakableText(fullDetail(spec)), spec.accent);
        Notification enhancedNotification = enhanced.build();
        Notification.Builder generic = builder(context, spec);
        generic.setDeleteIntent(enhancedNotification.deleteIntent);
        PromotedNotificationPublisher.configureGeneric(generic, spec.capsule);
        PromotedNotificationPublisher.post(context, manager, KEY, enhancedNotification, generic.build());
        return true;
    }

    private static Notification.Builder builder(Context context, ExpressLivePresentation spec) {
        Intent open = new Intent(context, ExpressDetailActivity.class)
                .setAction("me.pipi.deliveries.express.OPEN_LIVE")
                .setData(Uri.parse("deliveries://express/live/" + spec.primary.rowId))
                .putExtra(ExpressDetailActivity.EXTRA_ROW_ID, spec.primary.rowId)
                .putExtra(ExpressDetailActivity.EXTRA_MISSING_OPENS_LIST, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP
                        | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
        PendingIntent pending = PendingIntent.getActivity(context, LIVE_ID, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        int semantic = spec.primary.semantic == StatusSemantic.WAITING_PICKUP
                ? Notification.SEMANTIC_STYLE_CAUTION : Notification.SEMANTIC_STYLE_SAFE;
        return new Notification.Builder(context, CHANNEL)
                .setSmallIcon(spec.smallIcon).setColor(spec.accent).setColorized(false)
                .setContentTitle(SemanticText.annotate(spec.title, semantic, 0,
                        spec.labelLength))
                .setContentText(ExpressNotifications.breakableText(
                        Build.VERSION.SDK_INT >= 37 ? spec.summary : spec.detail))
                .setStyle(new Notification.BigTextStyle().bigText(
                        ExpressNotifications.breakableText(fullDetail(spec))))
                .setContentIntent(pending).setOngoing(true).setOnlyAlertOnce(true)
                .setShowWhen(false).setCategory(Notification.CATEGORY_STATUS);
    }

    private static String fullDetail(ExpressLivePresentation spec) {
        return spec.detail.isEmpty() ? spec.summary : spec.summary + "\n" + spec.detail;
    }
}
