package me.pipi.deliveries.network;

import android.content.Context;
import android.content.SharedPreferences;

/** Device-local account source selection. The production default is interface 6. */
public final class ExpressAccountSource {
    public static final String V5 = "v5";
    public static final String V6 = "v6";
    private static final String PREFS = "express_account_source";
    private static final String KEY_ACTIVE = "active_interface";
    private static final Object CACHE_LOCK = new Object();
    private static volatile Context cachedContext;
    private static volatile SharedPreferences cachedPreferences;
    private static volatile String cachedActive;
    private static final SharedPreferences.OnSharedPreferenceChangeListener PREFS_LISTENER =
            (preferences, key) -> {
                if (key == null || KEY_ACTIVE.equals(key)) {
                    cachedActive = normalize(preferences.getString(KEY_ACTIVE, V6));
                }
            };

    private ExpressAccountSource() {}

    public static String current(Context context) {
        Context app = context.getApplicationContext();
        Context key = app == null ? context : app;
        String active = cachedActive;
        if (key == cachedContext && active != null) {
            return active;
        }
        synchronized (CACHE_LOCK) {
            if (key == cachedContext && cachedActive != null) {
                return cachedActive;
            }
            if (cachedPreferences != null) {
                cachedPreferences.unregisterOnSharedPreferenceChangeListener(PREFS_LISTENER);
            }
            SharedPreferences preferences = key.getSharedPreferences(PREFS, 0);
            preferences.registerOnSharedPreferenceChangeListener(PREFS_LISTENER);
            String resolved = normalize(preferences.getString(KEY_ACTIVE, V6));
            cachedPreferences = preferences;
            cachedActive = resolved;
            cachedContext = key;
            return resolved;
        }
    }

    public static String toggle(Context context) {
        String selected = next(current(context));
        Context app = context.getApplicationContext();
        Context key = app == null ? context : app;
        synchronized (CACHE_LOCK) {
            if (!key.getSharedPreferences(PREFS, 0)
                    .edit().putString(KEY_ACTIVE, selected).commit()) {
                throw new IllegalStateException("无法切换接口，请稍后重试");
            }
            cachedActive = selected;
            cachedContext = key;
        }
        return selected;
    }

    /** Updates the volatile active source immediately and commits persistence off the UI thread. */
    public static String toggleAsync(Context context, java.util.concurrent.Executor executor) {
        String selected = next(current(context));
        Context app = context.getApplicationContext();
        Context key = app == null ? context : app;
        synchronized (CACHE_LOCK) {
            cachedActive = selected;
            cachedContext = key;
        }
        executor.execute(() -> {
            synchronized (CACHE_LOCK) {
                key.getSharedPreferences(PREFS, 0)
                        .edit().putString(KEY_ACTIVE, cachedActive != null ? cachedActive : selected)
                        .commit();
            }
        });
        return selected;
    }

    public static boolean isV5(Context context) {
        return V5.equals(current(context));
    }

    public static String owner(Context context) {
        return isV5(context) ? "INTERFACE5" : "INTERFACE6";
    }

    public static String bindingSource(Context context) {
        return isV5(context) ? "interface5" : "interface6";
    }

    /** Resolves the immutable row owner instead of whichever interface is selected now. */
    public static String bindingSourceForOwner(String owner) {
        String value = owner == null ? "" : owner.trim().toUpperCase(java.util.Locale.ROOT);
        return value.equals("INTERFACE5") || value.equals("I5-JD")
                || value.equals("I5-K100") ? "interface5" : "interface6";
    }

    public static String displayName(String value) {
        return V5.equals(normalize(value)) ? "备用接口" : "主接口";
    }

    static String normalize(String value) {
        return V5.equalsIgnoreCase(value == null ? "" : value.trim()) ? V5 : V6;
    }

    static String next(String value) {
        return V5.equals(normalize(value)) ? V6 : V5;
    }
}
