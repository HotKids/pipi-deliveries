package me.pipi.deliveries.notification;

import android.app.Notification;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.graphics.drawable.Icon;
import android.util.Log;

/**
 * Safe Samsung Now Bar visual hints layered on the standard promoted notification.
 *
 * <p>Do not attach Samsung's private {@code style=1}: current One UI builds can
 * reject that private template and remove the live notification entirely. The
 * standard Android promoted style already enters Now Bar; these two extras only
 * provide its dedicated foreground icon and semantic background color.</p>
 */
public final class SamsungNowBarCompat {
    private static final String TAG = "PipiNowBar";
    private static final String COMPAT_PREF = "deliveries_systemui_compat";
    private static final String COMPAT_FINGERPRINT = "fingerprint";
    private static final String COMPAT_FAILURES = "failures";
    private static final String COMPAT_FALLBACK = "fallback";
    private static final String COMPAT_PROBE_PASSED = "probe_passed";
    private static final int COMPAT_SCHEMA = 2;
    // Diagnostic kill switch only. Normal builds retain the Samsung SystemUI
    // protection and reset its learned result after every APK installation.
    static final boolean SYSTEM_UI_ERROR_FALLBACK_ENABLED = true;

    private SamsungNowBarCompat() {}

    public static boolean applyIfAllowed(Context context, Notification.Builder builder,
                                         int smallIcon, CharSequence chipText,
                                         CharSequence primary, CharSequence secondary,
                                         int color) {
        return applyIfAllowed(context, builder,
                Icon.createWithResource(context, smallIcon),
                chipText, primary, secondary, color);
    }

    public static boolean applyIfAllowed(Context context, Notification.Builder builder,
                                         Icon smallIcon, CharSequence chipText,
                                         CharSequence primary, CharSequence secondary,
                                         int color) {
        if (!applyStandardVisuals(context, builder, smallIcon, color)) return false;
        Bundle extras = new Bundle();
        if (primary != null && primary.length() > 0) {
            extras.putCharSequence("android.ongoingActivityNoti.nowbarPrimaryInfo", primary);
        }
        if (secondary != null && secondary.length() > 0) {
            extras.putCharSequence("android.ongoingActivityNoti.nowbarSecondaryInfo", secondary);
        }
        builder.addExtras(extras);
        return true;
    }

    public static boolean applyStandardVisuals(Context context, Notification.Builder builder,
                                               int foregroundIcon, int backgroundColor) {
        return applyStandardVisuals(context, builder,
                Icon.createWithResource(context, foregroundIcon), backgroundColor);
    }

    public static boolean applyStandardVisuals(Context context, Notification.Builder builder,
                                               Icon foregroundIcon, int backgroundColor) {
        if (!shouldTrySamsungEnhancement(context)) return false;
        if (foregroundIcon == null) return false;
        try {
            // Keep Notification.smallIcon untouched so the capsule and normal
            // notification retain their white foreground. The expanded Now Bar
            // gets an independent white icon on a semantic-colored background.
            Bundle extras = new Bundle();
            extras.putParcelable("android.ongoingActivityNoti.nowbarIcon", foregroundIcon);
            extras.putInt("android.sreminder.leftIconBgColor", backgroundColor);
            builder.addExtras(extras);
            Log.i(TAG, "Using white nowbarIcon on semantic leftIconBgColor");
            return true;
        } catch (Throwable error) {
            Log.w(TAG, "Unable to apply colored expanded Now Bar background", error);
            return false;
        }
    }

    public static boolean addChipColorIfAllowed(Context context, Notification.Builder builder,
                                                int backgroundColor) {
        if (!shouldTrySamsungEnhancement(context)) return false;
        Bundle extras = new Bundle();
        extras.putInt("android.ongoingActivityNoti.chipBgColor", backgroundColor);
        builder.addExtras(extras);
        return true;
    }

    static boolean shouldTrySamsungEnhancement(Context context) {
        return shouldProbe(context) && !useGenericFallback(context);
    }

    static boolean shouldProbe(Context context) {
        return isSamsung(context) && Build.VERSION.SDK_INT >= 36;
    }

    static boolean shouldProbeDelivery(Context context) {
        if (!shouldProbe(context) || useGenericFallback(context)) return false;
        return !compatPrefs(context).getBoolean(COMPAT_PROBE_PASSED, false);
    }

    static String fingerprint(Context context) {
        String value = Build.FINGERPRINT;
        String firmware = value == null || value.isEmpty()
                ? Build.BRAND + "/" + Build.MODEL + "/" + Build.ID : value;
        return firmware + "/app@" + packageLastUpdateTime(context)
                + "/compat@" + COMPAT_SCHEMA;
    }

    private static long packageLastUpdateTime(Context context) {
        try {
            return context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0)
                    .lastUpdateTime;
        } catch (Throwable error) {
            Log.w(TAG, "Unable to read APK update time for compatibility probe", error);
            return 0L;
        }
    }

    private static android.content.SharedPreferences compatPrefs(Context context) {
        android.content.SharedPreferences prefs = context.getApplicationContext()
                .getSharedPreferences(COMPAT_PREF, Context.MODE_PRIVATE);
        String current = fingerprint(context);
        synchronized (SamsungNowBarCompat.class) {
            String previous = prefs.getString(COMPAT_FINGERPRINT, "");
            if (!current.equals(previous)) {
                prefs.edit().clear().putString(COMPAT_FINGERPRINT, current).apply();
                Log.i(TAG, "APK or firmware changed; Samsung enhancement probe reset: "
                        + current);
            }
        }
        return prefs;
    }

    static boolean useGenericFallback(Context context) {
        return SYSTEM_UI_ERROR_FALLBACK_ENABLED
                && shouldProbe(context)
                && compatPrefs(context).getBoolean(COMPAT_FALLBACK, false);
    }

    static int recordProbe(Context context, boolean survived) {
        if (!SYSTEM_UI_ERROR_FALLBACK_ENABLED) return 0;
        synchronized (SamsungNowBarCompat.class) {
            android.content.SharedPreferences prefs = compatPrefs(context);
            if (survived) {
                if (!prefs.getBoolean(COMPAT_FALLBACK, false)) {
                    prefs.edit()
                            .putInt(COMPAT_FAILURES, 0)
                            .putBoolean(COMPAT_PROBE_PASSED, true)
                            .apply();
                }
                return 0;
            }
            int failures = prefs.getInt(COMPAT_FAILURES, 0) + 1;
            android.content.SharedPreferences.Editor editor =
                    prefs.edit()
                            .putInt(COMPAT_FAILURES, failures)
                            .putBoolean(COMPAT_PROBE_PASSED, false);
            if (failures >= 2) editor.putBoolean(COMPAT_FALLBACK, true);
            editor.apply();
            return failures;
        }
    }

    private static boolean isSamsung(Context context) {
        return context != null && "samsung".equalsIgnoreCase(Build.MANUFACTURER);
    }
}
