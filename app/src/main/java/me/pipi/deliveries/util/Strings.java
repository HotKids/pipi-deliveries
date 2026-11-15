package me.pipi.deliveries.util;

import org.json.JSONObject;

/** Shared null-safe trimming helpers for plain strings and JSON scalar values. */
public final class Strings {
    private Strings() {}

    public static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    public static String clean(Object value) {
        if (value == null || value == JSONObject.NULL) {
            return "";
        }
        return String.valueOf(value).trim();
    }

    public static boolean isBlank(String value) {
        return clean(value).isEmpty();
    }
}
