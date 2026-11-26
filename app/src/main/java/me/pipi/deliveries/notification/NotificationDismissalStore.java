package me.pipi.deliveries.notification;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Persists an explicit user dismissal until visible content changes or the launcher is opened.
 */
public final class NotificationDismissalStore {
    static final String EXTRA_KEY = "notification_key";
    static final String EXTRA_ID = "notification_id";
    static final String EXTRA_FINGERPRINT = "notification_fingerprint";
    static final String EXTRA_TOKEN = "notification_generation";

    private static final int MAX_RECENT_TOKENS = 128;

    private static final Object MEMORY_LOCK = new Object();
    private static final Map<String, String> ACTIVE_FINGERPRINTS = new HashMap<>();
    private static final Map<String, String> ACTIVE_TOKENS = new HashMap<>();
    private static final Map<String, String> RECENTLY_DISMISSED_BY_KEY = new HashMap<>();
    private static final LinkedHashMap<String, Boolean> RECENTLY_DISMISSED_TOKENS =
            new LinkedHashMap<String, Boolean>(32, 0.75f, true) {
                @Override protected boolean removeEldestEntry(Map.Entry<String, Boolean> eldest) {
                    return size() > MAX_RECENT_TOKENS;
                }
            };

    private NotificationDismissalStore() {}

    /** Pipi and Lite keep separate files, named after the running app (see NotificationHost). */
    private static android.content.SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(
                NotificationHost.isDeliveries(context)
                        ? "deliveries_notification_dismissals"
                        : "pipi_notification_dismissals",
                Context.MODE_PRIVATE);
    }

    private static String uriScheme(Context context) {
        return NotificationHost.isDeliveries(context) ? "deliveries" : "pipi";
    }

    @SuppressLint("ApplySharedPref")
    public static boolean prepare(Context context, Notification.Builder builder,
                                  NotificationKey key, String fingerprint) {
        if (context == null || builder == null || key == null) return false;
        String stableFingerprint = fingerprint == null ? "" : fingerprint;
        if (isDismissed(context, key, stableFingerprint)) return false;
        android.content.SharedPreferences prefs = prefs(context);
        String persistenceKey = key.persistenceKey();
        String activeKey = persistenceKey + ":active";
        String tokenKey = persistenceKey + ":token";
        String storedActive = prefs.getString(activeKey, null);
        String storedToken = prefs.getString(tokenKey, null);
        String token = storedToken == null ? "" : storedToken;
        boolean unchanged = stableFingerprint.equals(storedActive)
                && !token.isEmpty()
                && token.equals(storedToken);
        if (!unchanged) {
            if (!stableFingerprint.equals(storedActive) || token.isEmpty()) {
                token = UUID.randomUUID().toString();
            }
            // SystemUI can outlive this process; its delete intent must have a durable identity first.
            if (!prefs.edit()
                    .putString(activeKey, stableFingerprint)
                    .putString(tokenKey, token)
                    .commit()) {
                return false;
            }
        }
        synchronized (MEMORY_LOCK) {
            ACTIVE_FINGERPRINTS.put(persistenceKey, stableFingerprint);
            ACTIVE_TOKENS.put(persistenceKey, token);
            String memDismissed = RECENTLY_DISMISSED_BY_KEY.get(persistenceKey);
            if (memDismissed != null && !memDismissed.equals(stableFingerprint)) {
                RECENTLY_DISMISSED_BY_KEY.remove(persistenceKey);
            }
        }
        Intent intent = new Intent(context, NotificationDismissedReceiver.class)
                .setAction(NotificationDismissedReceiver.ACTION_DISMISSED)
                .setData(Uri.parse(uriScheme(context) + "://notification-dismissed/"
                        + key.id + "/" + token))
                .putExtra(EXTRA_KEY, persistenceKey)
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
        String expected = fingerprint == null ? "" : fingerprint;
        synchronized (MEMORY_LOCK) {
            String memDismissed = RECENTLY_DISMISSED_BY_KEY.get(key.persistenceKey());
            if (memDismissed != null && memDismissed.equals(expected)) return true;
        }
        String dismissed = prefs(context).getString(key.persistenceKey(), null);
        return dismissed != null && dismissed.equals(expected);
    }

    /** Opening the launcher is the one explicit action that restores unchanged live surfaces. */
    public static void clearAll(Context context) {
        synchronized (MEMORY_LOCK) {
            ACTIVE_FINGERPRINTS.clear();
            ACTIVE_TOKENS.clear();
            RECENTLY_DISMISSED_BY_KEY.clear();
            RECENTLY_DISMISSED_TOKENS.clear();
        }
        if (context == null) return;
        prefs(context).edit().clear().apply();
    }

    static void clear(Context context, NotificationKey key) {
        if (key != null) {
            String persistenceKey = key.persistenceKey();
            synchronized (MEMORY_LOCK) {
                ACTIVE_FINGERPRINTS.remove(persistenceKey);
                ACTIVE_TOKENS.remove(persistenceKey);
                RECENTLY_DISMISSED_BY_KEY.remove(persistenceKey);
            }
        }
        if (context == null || key == null) return;
        prefs(context).edit()
                .remove(key.persistenceKey())
                .remove(key.persistenceKey() + ":active")
                .remove(key.persistenceKey() + ":token")
                .apply();
    }

    /**
     * Records an explicit user swipe immediately in process memory on the BroadcastReceiver main
     * thread before asynchronous disk persistence runs, returning {@code true} when the swipe
     * belongs to the current active publication for {@code key}.
     */
    static boolean markDismissedInMemory(NotificationKey key, String fingerprint, String token) {
        if (key == null) return false;
        String persistenceKey = key.persistenceKey();
        String safeFingerprint = fingerprint == null ? "" : fingerprint;
        synchronized (MEMORY_LOCK) {
            if (token != null && !token.isEmpty()) {
                RECENTLY_DISMISSED_TOKENS.put(token, Boolean.TRUE);
                String activeToken = ACTIVE_TOKENS.get(persistenceKey);
                if (activeToken != null && !token.equals(activeToken)) return false;
                String activeFp = ACTIVE_FINGERPRINTS.get(persistenceKey);
                if (activeFp != null && fingerprint != null && !safeFingerprint.equals(activeFp)) {
                    return false;
                }
            }
            RECENTLY_DISMISSED_BY_KEY.put(persistenceKey, safeFingerprint);
            return true;
        }
    }

    static String activeFingerprint(Context context, NotificationKey key) {
        if (key == null) return null;
        String persistenceKey = key.persistenceKey();
        synchronized (MEMORY_LOCK) {
            String known = ACTIVE_FINGERPRINTS.get(persistenceKey);
            if (known != null) return known;
        }
        if (context == null) return null;
        return prefs(context).getString(persistenceKey + ":active", null);
    }

    static String activeToken(Context context, NotificationKey key) {
        if (key == null) return null;
        String persistenceKey = key.persistenceKey();
        synchronized (MEMORY_LOCK) {
            String known = ACTIVE_TOKENS.get(persistenceKey);
            if (known != null) return known;
        }
        if (context == null) return null;
        return prefs(context).getString(persistenceKey + ":token", null);
    }

    static boolean wasDismissedForProbe(
            Context context, NotificationKey key, String expectedFingerprint, String expectedToken) {
        if (key == null) return false;
        String persistenceKey = key.persistenceKey();
        synchronized (MEMORY_LOCK) {
            if (expectedToken != null && !expectedToken.isEmpty()
                    && RECENTLY_DISMISSED_TOKENS.containsKey(expectedToken)) {
                return true;
            }
            String memDismissed = RECENTLY_DISMISSED_BY_KEY.get(persistenceKey);
            if (memDismissed != null && expectedFingerprint != null
                    && memDismissed.equals(expectedFingerprint)) {
                return true;
            }
        }
        if (context == null) return false;
        android.content.SharedPreferences prefs = prefs(context);
        String diskDismissed = prefs.getString(persistenceKey, null);
        if (diskDismissed == null) return false;
        if (expectedFingerprint != null) return diskDismissed.equals(expectedFingerprint);
        String activeFp = prefs.getString(persistenceKey + ":active", null);
        return activeFp != null && diskDismissed.equals(activeFp);
    }

    @SuppressLint("ApplySharedPref")
    static void record(Context context, NotificationKey key, String fingerprint) {
        if (context == null || key == null) return;
        String safeFingerprint = fingerprint == null ? "" : fingerprint;
        synchronized (MEMORY_LOCK) {
            RECENTLY_DISMISSED_BY_KEY.put(key.persistenceKey(), safeFingerprint);
        }
        prefs(context)
                .edit()
                .putString(key.persistenceKey(), safeFingerprint)
                .commit();
    }

    @SuppressLint("ApplySharedPref")
    static boolean recordIfCurrent(Context context, NotificationKey key, String fingerprint, String token) {
        if (context == null || key == null || token == null || fingerprint == null) return false;
        android.content.SharedPreferences prefs = prefs(context);
        String persistenceKey = key.persistenceKey();
        // A delayed swipe callback must not dismiss another parcel or a foreground-restored activity.
        if (!token.equals(prefs.getString(persistenceKey + ":token", null))
                || !fingerprint.equals(prefs.getString(persistenceKey + ":active", null))) {
            return false;
        }
        synchronized (MEMORY_LOCK) {
            RECENTLY_DISMISSED_TOKENS.put(token, Boolean.TRUE);
            RECENTLY_DISMISSED_BY_KEY.put(persistenceKey, fingerprint);
        }
        return prefs.edit().putString(persistenceKey, fingerprint).commit();
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
