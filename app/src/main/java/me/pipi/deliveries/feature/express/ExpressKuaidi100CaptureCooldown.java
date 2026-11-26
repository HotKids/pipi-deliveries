package me.pipi.deliveries.feature.express;

import android.content.Context;
import android.content.SharedPreferences;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

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
        return due(lastWaybillOnlyAttempt(context, waybill), now);
    }

    static boolean due(Context context, String provider, String waybill,
            List<String> phones, long now) {
        // JT takes no 30-minute lock and does not occupy the K100 waybill key.
        if (me.pipi.deliveries.data.TimelineSlot.JT_H5.equals(provider)) return true;
        return due(lastAttempt(context, waybill, phones), now);
    }

    static void record(Context context, String provider, String waybill,
            List<String> phones, long now) {
        if (me.pipi.deliveries.data.TimelineSlot.JT_H5.equals(provider)) return;
        recordScoped(context, waybill, phones, now);
    }

    static void record(Context context, String waybill, long now) {
        String key = waybillOnlyKey(waybill);
        if (context == null || key.isEmpty()) return;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putLong(key, now).apply();
    }

    static void clear(Context context, String provider, String waybill, List<String> phones) {
        if (me.pipi.deliveries.data.TimelineSlot.JT_H5.equals(provider)) return;
        String key = scopedKey(waybill, phones);
        if (context == null || key.isEmpty()) return;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().remove(key).apply();
    }

    private static void recordScoped(Context context, String waybill, List<String> phones, long now) {
        String key = scopedKey(waybill, phones);
        if (context == null || key.isEmpty()) return;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putLong(key, now).apply();
    }

    private static long lastWaybillOnlyAttempt(Context context, String waybill) {
        String key = waybillOnlyKey(waybill);
        if (context == null || key.isEmpty()) return 0L;
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(key, 0L);
    }

    private static long lastAttempt(Context context, String waybill, List<String> phones) {
        String scoped = scopedKey(waybill, phones);
        if (context == null || scoped.isEmpty()) return 0L;
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return Math.max(prefs.getLong(scoped, 0L), prefs.getLong(waybillOnlyKey(waybill), 0L));
    }

    private static String waybillOnlyKey(String waybill) {
        String clean = waybill == null ? "" : waybill.trim().toUpperCase(Locale.ROOT);
        return clean.isEmpty() ? "" : "attempt:" + clean;
    }

    private static String scopedKey(String waybill, List<String> phones) {
        String clean = waybill == null ? "" : waybill.trim().toUpperCase(Locale.ROOT);
        if (clean.isEmpty()) return "";
        String fingerprint = phoneFingerprint(clean, phones);
        return "attempt:" + clean + ":" + (fingerprint.isEmpty() ? "none" : fingerprint);
    }

    private static String phoneFingerprint(String cleanWaybill, List<String> phones) {
        if (phones == null || phones.isEmpty()) return "";
        Set<String> normalized = new LinkedHashSet<>();
        for (String phone : phones) {
            if (phone == null) continue;
            String digits = phone.replaceAll("\\D", "");
            if (digits.length() >= 4) {
                normalized.add(digits.substring(digits.length() - 4));
            }
        }
        if (normalized.isEmpty()) return "";
        List<String> sorted = new ArrayList<>(normalized);
        Collections.sort(sorted);
        String material = cleanWaybill + "\0" + String.join(",", sorted);
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(material.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(24);
            for (int i = 0; i < 12 && i < digest.length; i++) {
                int v = digest[i] & 0xFF;
                if (v < 16) hex.append('0');
                hex.append(Integer.toHexString(v));
            }
            return hex.toString();
        } catch (Exception unavailable) {
            return Integer.toUnsignedString(material.hashCode(), 16);
        }
    }
}
