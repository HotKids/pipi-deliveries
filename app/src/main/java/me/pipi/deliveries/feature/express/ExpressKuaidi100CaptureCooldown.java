package me.pipi.deliveries.feature.express;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * K100 结果页抓取的按票冷却：同一运单 30 分钟内只抓一次——这是快递100 上游自己的限制，
 * 不是我们定的节流（三端同值，iOS/Pipi 的 K100 H5 那一级同一冷却）。
 */
final class ExpressKuaidi100CaptureCooldown {
    static final long COOLDOWN_MS = 30L * 60L * 1000L;
    private static final String PREFS = "express_k100_capture_cooldown";

    private ExpressKuaidi100CaptureCooldown() {}

    static boolean due(long lastAttemptAt, long now) {
        return lastAttemptAt <= 0L || now < lastAttemptAt || now - lastAttemptAt >= COOLDOWN_MS;
    }

    static boolean due(Context context, String waybill, long now) {
        return due(lastAttempt(context, waybill), now);
    }

    static boolean due(Context context, String provider, String waybill,
            java.util.List<String> phones, long now) {
        return due(context, scopedWaybill(provider, waybill, phones), now);
    }

    static void record(Context context, String provider, String waybill,
            java.util.List<String> phones, long now) {
        record(context, scopedWaybill(provider, waybill, phones), now);
    }

    /** Correcting a JT suffix changes the request; ordinary retries retain the attempt cooldown. */
    private static String scopedWaybill(String provider, String waybill, java.util.List<String> phones) {
        if (!me.pipi.deliveries.data.TimelineSlot.JT_H5.equals(provider)) return waybill;
        try {
            String input = String.join(",", ExpressKuaidi100TimelineCapture.phoneCandidates("", phones));
            byte[] hash = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(input.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte value : hash) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            return "jt_h5:" + waybill + ":" + hex;
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    static void record(Context context, String waybill, long now) {
        String key = key(waybill);
        if (context == null || key.isEmpty()) return;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putLong(key, now).apply();
    }

    private static long lastAttempt(Context context, String waybill) {
        String key = key(waybill);
        if (context == null || key.isEmpty()) return 0L;
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(key, 0L);
    }

    private static String key(String waybill) {
        String clean = waybill == null ? "" : waybill.trim().toUpperCase(java.util.Locale.ROOT);
        return clean.isEmpty() ? "" : "attempt:" + clean;
    }
}
