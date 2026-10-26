package me.pipi.deliveries.notification;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

/**
 * Persists an explicit user dismissal until visible content changes or the launcher is opened.
 */
public final class NotificationDismissalStore {
    static final String EXTRA_KEY = "notification_key";
    static final String EXTRA_ID = "notification_id";
    static final String EXTRA_FINGERPRINT = "notification_fingerprint";
    static final String EXTRA_TOKEN = "notification_generation";
    private static final String PREFS = "deliveries_notification_dismissals";

    private NotificationDismissalStore() {}

    @SuppressLint("ApplySharedPref")
    public static boolean prepare(Context context, Notification.Builder builder,
                                  NotificationKey key, String fingerprint) {
        if (context == null || builder == null || key == null) return false;
        String stableFingerprint = fingerprint == null ? "" : fingerprint;
        if (isDismissed(context, key, stableFingerprint)) return false;
        android.content.SharedPreferences prefs = context.getSharedPreferences(PREFS, 0);
        String activeKey = key.persistenceKey() + ":active";
        String tokenKey = key.persistenceKey() + ":token";
        String token = prefs.getString(tokenKey, "");
        if (!stableFingerprint.equals(prefs.getString(activeKey, null)) || token.isEmpty()) {
            token = java.util.UUID.randomUUID().toString();
        }
        // SystemUI can outlive this process; its delete intent must have a durable identity first.
        if (!prefs.edit().putString(activeKey, stableFingerprint).putString(tokenKey, token).commit()) return false;
        Intent intent = new Intent(context, NotificationDismissedReceiver.class)
                .setAction(NotificationDismissedReceiver.ACTION_DISMISSED)
                .setData(Uri.parse("deliveries://notification-dismissed/" + key.id + "/" + token))
                .putExtra(EXTRA_KEY, key.persistenceKey())
                .putExtra(EXTRA_ID, key.id)
                .putExtra(EXTRA_FINGERPRINT, stableFingerprint)
                .putExtra(EXTRA_TOKEN, token);
        PendingIntent deleted = PendingIntent.getBroadcast(
                context, key.id, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        builder.setDeleteIntent(deleted);
        return true;
    }

    public static boolean isDismissed(Context context, NotificationKey key,
                                      String fingerprint) {
        if (context == null || key == null) return false;
        String dismissed = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(key.persistenceKey(), null);
        return dismissed != null && dismissed.equals(fingerprint == null ? "" : fingerprint);
    }

    /** Opening the launcher is the one explicit action that restores unchanged live surfaces. */
    public static void clearAll(Context context) {
        if (context == null) return;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }

    static void clear(Context context, NotificationKey key) {
        context.getSharedPreferences(PREFS, 0).edit().remove(key.persistenceKey())
                .remove(key.persistenceKey() + ":active")
                .remove(key.persistenceKey() + ":token").apply();
    }

    @SuppressLint("ApplySharedPref")
    static boolean recordIfCurrent(Context context, NotificationKey key, String fingerprint, String token) {
        if (context == null || key == null || token == null || fingerprint == null) return false;
        android.content.SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        // A delayed swipe callback must not dismiss another parcel or a foreground-restored activity.
        if (!token.equals(prefs.getString(key.persistenceKey() + ":token", null))
                || !fingerprint.equals(prefs.getString(key.persistenceKey() + ":active", null))) return false;
        return prefs.edit().putString(key.persistenceKey(), fingerprint).commit();
    }

    public static String fingerprint(Object... values) {
        StringBuilder result = new StringBuilder();
        if (values == null) return result.toString();
        for (Object value : values) {
            String text = value == null ? "" : String.valueOf(value);
            result.append(text.length()).append(':').append(text).append('|');
        }
        return result.toString();
    }
}
