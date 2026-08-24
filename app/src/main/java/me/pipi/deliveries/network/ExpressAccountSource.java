package me.pipi.deliveries.network;

import android.content.Context;
import android.content.SharedPreferences;

/** Device-local account source selection. The production default is interface 6. */
public final class ExpressAccountSource {
    public static final String V5 = "v5";
    public static final String V6 = "v6";
    private static final String PREFS = "express_account_source";
    private static final String KEY_ACTIVE = "active_interface";

    private ExpressAccountSource() {}

    public static String current(Context context) {
        SharedPreferences preferences = context.getApplicationContext()
                .getSharedPreferences(PREFS, 0);
        return normalize(preferences.getString(KEY_ACTIVE, V6));
    }

    public static String toggle(Context context) {
        String selected = next(current(context));
        if (!context.getApplicationContext().getSharedPreferences(PREFS, 0)
                .edit().putString(KEY_ACTIVE, selected).commit()) {
            throw new IllegalStateException("无法切换接口，请稍后重试");
        }
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
