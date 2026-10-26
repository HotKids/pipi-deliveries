package me.pipi.deliveries.notification;

/** Pure timing policy kept separate so the SystemUI probe boundary is unit-testable. */
final class PromotedNotificationPolicy {
    static final float SAMSUNG_FALLBACK_ICON_SCALE = 0.80f;

    private PromotedNotificationPolicy() {}

    static boolean hasProbeWindow(long timeoutAfterMillis, long probeDelayMillis,
                                  long deliveryMarginMillis) {
        if (timeoutAfterMillis <= 0L) return true;
        return timeoutAfterMillis > probeDelayMillis + deliveryMarginMillis;
    }

    static int fallbackIconContentSize(int canvasSize) {
        int boundedSize = Math.max(1, canvasSize);
        return Math.max(1, Math.round(
                boundedSize * SAMSUNG_FALLBACK_ICON_SCALE));
    }
}
