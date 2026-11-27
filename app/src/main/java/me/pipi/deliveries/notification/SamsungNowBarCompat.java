package me.pipi.deliveries.notification;

import android.app.Notification;
import android.content.Context;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.widget.RemoteViews;

/**
 * Samsung Now Bar visual hints layered on the standard promoted notification.
 *
 * <p>One UI can remove a notification that uses its private template. The pickup
 * pilot supplies that template on a separate candidate so rejection can restore
 * the established promoted notification.</p>
 */
public final class SamsungNowBarCompat {
    private static final String TAG = "PipiNowBar";
    private static final String COMPAT_FINGERPRINT = "fingerprint";
    private static final String COMPAT_FAILURES = "failures";
    private static final String COMPAT_FALLBACK = "fallback";
    private static final String COMPAT_PROBE_PASSED = "probe_passed";
    private static final String COMPAT_PICKUP_NOW_BAR_REJECTED = "pickup_now_bar_rejected";
    private static final String COMPAT_NOW_BAR_REJECTED_PREFIX = "now_bar_rejected:";
    private static final double MIN_WHITE_CHIP_CONTRAST = 4.5;
    private static final int COMPAT_SCHEMA = 3;
    // Diagnostic kill switch only. Normal builds retain the Samsung SystemUI
    // protection and reset its learned result after every APK installation.
    static final boolean SYSTEM_UI_ERROR_FALLBACK_ENABLED = true;

    private static volatile String cachedUpdatePackage;
    private static volatile long cachedUpdateTime = -1L;

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
            Log.w(TAG, "Unable to apply colored expanded Now Bar background" + " kind=" + error.getClass().getSimpleName());
            return false;
        }
    }

    public static boolean addChipColorIfAllowed(Context context, Notification.Builder builder,
                                                int backgroundColor) {
        if (!shouldTrySamsungEnhancement(context)) return false;
        Bundle extras = new Bundle();
        extras.putInt(
                "android.ongoingActivityNoti.chipBgColor",
                clampChipBackgroundForWhiteText(backgroundColor));
        builder.addExtras(extras);
        return true;
    }

    static int clampChipBackgroundForWhiteText(int backgroundColor) {
        int opaque = 0xff000000 | backgroundColor;
        if (contrastWithWhite(opaque) >= MIN_WHITE_CHIP_CONTRAST) return opaque;
        int r = (opaque >> 16) & 0xff;
        int g = (opaque >> 8) & 0xff;
        int b = opaque & 0xff;
        float lo = 0f;
        float hi = 1f;
        for (int step = 0; step < 24; step++) {
            float mid = (lo + hi) * 0.5f;
            if (contrastWithWhite(scaleRgb(r, g, b, mid)) >= MIN_WHITE_CHIP_CONTRAST) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        return scaleRgb(r, g, b, lo);
    }

    private static int scaleRgb(int r, int g, int b, float scale) {
        int nr = Math.min(255, Math.max(0, Math.round(r * scale)));
        int ng = Math.min(255, Math.max(0, Math.round(g * scale)));
        int nb = Math.min(255, Math.max(0, Math.round(b * scale)));
        return 0xff000000 | (nr << 16) | (ng << 8) | nb;
    }

    static double contrastWithWhite(int color) {
        double luminance = relativeLuminance(color);
        return 1.05 / (luminance + 0.05);
    }

    private static double relativeLuminance(int color) {
        double r = linearize(((color >> 16) & 0xff) / 255.0);
        double g = linearize(((color >> 8) & 0xff) / 255.0);
        double b = linearize((color & 0xff) / 255.0);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    private static double linearize(double channel) {
        return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    }

    public static boolean shouldTryPickupNowBar(Context context) {
        return shouldTryNowBarTemplate(context, "pickup.live");
    }

    public static boolean shouldTryNowBarTemplate(Context context) {
        return shouldTryNowBarTemplate(context, "");
    }

    public static boolean shouldTryNowBarTemplate(Context context, String namespace) {
        if (!shouldTrySamsungEnhancement(context)) return false;
        android.content.SharedPreferences prefs = compatPrefs(context);
        if (prefs.getBoolean(rejectionKey(namespace), false)) return false;
        return !("pickup.live".equals(namespace) || namespace == null || namespace.isEmpty())
                || !prefs.getBoolean(COMPAT_PICKUP_NOW_BAR_REJECTED, false);
    }

    public static Notification pickupNowBarCandidate(Notification enhanced, String capsule,
                                                     String primary, String secondary,
                                                     RemoteViews expanded) {
        return nowBarCandidate(enhanced, capsule, primary, secondary, expanded);
    }

    public static Notification nowBarCandidate(Notification enhanced, CharSequence capsule,
                                               CharSequence primary, CharSequence secondary,
                                               RemoteViews expanded) {
        Notification candidate = enhanced.clone();
        Bundle extras = candidate.extras;
        extras.putInt("android.ongoingActivityNoti.style", 1);
        extras.putCharSequence("android.ongoingActivityNoti.nowbarPrimaryInfo",
                primary == null ? "" : primary);
        extras.putCharSequence("android.ongoingActivityNoti.nowbarSecondaryInfo",
                secondary == null ? "" : secondary);
        if (primary != null && primary.length() > 0) {
            extras.putCharSequence("android.ongoingActivityNoti.primaryInfo", primary);
        }
        if (capsule != null && capsule.length() > 0) {
            extras.putCharSequence("android.ongoingActivityNoti.chipExpandedText", capsule);
        }
        extras.putParcelable("android.ongoingActivityNoti.chipIcon", candidate.getSmallIcon());
        if (expanded != null) {
            extras.putParcelable("android.ongoingActivityNoti.expandedRemoteView", expanded);
        }
        CharSequence bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT);
        CharSequence statusSecondary = bigText != null && bigText.length() > 0 ? bigText : secondary;
        if (statusSecondary != null && statusSecondary.length() > 0) {
            extras.putCharSequence("android.ongoingActivityNoti.secondaryInfo", statusSecondary);
        }
        if (candidate.actions != null && candidate.actions.length > 0) {
            extras.putInt("android.ongoingActivityNoti.actionType", 1);
            extras.putInt("android.ongoingActivityNoti.actionPrimarySet",
                    candidate.actions.length - 1);
        }
        return candidate;
    }

    public static Notification tripNowBarCandidate(
            Notification enhanced,
            CharSequence capsule,
            CharSequence primary,
            CharSequence secondary,
            int progressPercent,
            float[] segmentStarts,
            int[] segmentColors,
            int progressColor,
            Icon trackerIcon) {
        Notification candidate = nowBarCandidate(enhanced, capsule, primary, secondary, null);
        if (segmentStarts == null || segmentColors == null
                || segmentStarts.length == 0
                || segmentStarts.length != segmentColors.length) {
            return candidate;
        }
        Bundle extras = candidate.extras;
        extras.putInt("android.ongoingActivityNoti.progressMax", 100);
        extras.putInt("android.ongoingActivityNoti.progress",
                Math.max(0, Math.min(100, progressPercent)));
        Bundle[] segments = new Bundle[segmentStarts.length];
        for (int index = 0; index < segmentStarts.length; index++) {
            Bundle segment = new Bundle();
            segment.putFloat("android.ongoingActivityNoti.progressSegments.segmentStart",
                    Math.max(0f, Math.min(0.999f, segmentStarts[index])));
            segment.putInt("android.ongoingActivityNoti.progressSegments.segmentColor",
                    segmentColors[index]);
            segments[index] = segment;
        }
        extras.putParcelableArray("android.ongoingActivityNoti.progressSegments", segments);
        extras.putInt("android.ongoingActivityNoti.progressSegments.progressColor", progressColor);
        if (trackerIcon != null) {
            extras.putParcelable("android.ongoingActivityNoti.progressSegments.icon", trackerIcon);
        }
        return candidate;
    }

    static String namespaceOf(NotificationKey key) {
        if (key == null) return "";
        String persisted = key.persistenceKey();
        if (persisted == null) return "";
        int colon = persisted.indexOf(':');
        return colon < 0 ? persisted : persisted.substring(0, colon);
    }

    private static String rejectionKey(String namespace) {
        String clean = namespace == null ? "" : namespace.trim();
        return COMPAT_NOW_BAR_REJECTED_PREFIX + (clean.isEmpty() ? "default" : clean);
    }

    static void recordPickupNowBarRejection(Context context) {
        recordNowBarRejection(context, "pickup.live");
    }

    static void recordNowBarRejection(Context context, String namespace) {
        synchronized (SamsungNowBarCompat.class) {
            android.content.SharedPreferences.Editor editor = compatPrefs(context).edit()
                    .putBoolean(rejectionKey(namespace), true);
            if ("pickup.live".equals(namespace) || namespace == null || namespace.isEmpty()) {
                editor.putBoolean(COMPAT_PICKUP_NOW_BAR_REJECTED, true);
            }
            editor.apply();
        }
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
        if (context == null) return 0L;
        String pkg = context.getPackageName();
        long known = cachedUpdateTime;
        if (known >= 0L && pkg != null && pkg.equals(cachedUpdatePackage)) {
            return known;
        }
        try {
            long resolved = context.getPackageManager()
                    .getPackageInfo(pkg, 0)
                    .lastUpdateTime;
            cachedUpdatePackage = pkg;
            cachedUpdateTime = resolved;
            return resolved;
        } catch (Throwable error) {
            Log.w(TAG, "Unable to read APK update time for compatibility probe" + " kind=" + error.getClass().getSimpleName());
            return 0L;
        }
    }

    static void resetCacheForTest() {
        cachedUpdatePackage = null;
        cachedUpdateTime = -1L;
    }

    private static android.content.SharedPreferences compatPrefs(Context context) {
        Context app = context.getApplicationContext();
        // Pipi and Lite keep separate files, named after the running app (see NotificationHost).
        android.content.SharedPreferences prefs = app.getSharedPreferences(
                NotificationHost.isDeliveries(app)
                        ? "deliveries_systemui_compat" : "pipi_systemui_compat",
                Context.MODE_PRIVATE);
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
