package me.pipi.deliveries.notification;

import android.content.Context;

/**
 * Tells which app runs the shared notification classes.
 *
 * <p>Pipi and Deliveries Lite run the same notification sources (mirrored by
 * {@code tools/sync_android_shared_classes.py}) and keep their notification state under
 * separate names. The answer comes from the running package. A class's own package cannot be
 * used: R8 moves classes into the unnamed package in minified builds, and
 * {@code Class#getPackageName()} only exists from API 31, while Lite's compat flavour starts at
 * API 29.</p>
 */
final class NotificationHost {
    static final String DELIVERIES_PACKAGE = "me.pipi.deliveries";

    private NotificationHost() {}

    /** Whether {@code context} belongs to Deliveries Lite ({@code me.pipi.deliveries}). */
    static boolean isDeliveries(Context context) {
        String packageName = context == null ? null : context.getPackageName();
        return packageName != null
                && (packageName.equals(DELIVERIES_PACKAGE)
                        || packageName.startsWith(DELIVERIES_PACKAGE + "."));
    }
}
