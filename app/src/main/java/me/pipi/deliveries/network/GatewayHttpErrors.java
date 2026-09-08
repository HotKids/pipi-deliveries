package me.pipi.deliveries.network;

import org.json.JSONObject;
import org.json.JSONTokener;

import java.util.Locale;

/** Maps transport failures and bounded gateway responses to user-safe messages. */
final class GatewayHttpErrors {
    private static final String NETWORK = "网络异常，请稍后重试";

    private GatewayHttpErrors() {}

    static IllegalStateException networkFailure() {
        return new IllegalStateException(NETWORK);
    }

    static IllegalStateException forResponse(HttpClient.Response response, String fallback) {
        String message = safeMessage(response == null ? "" : response.utf8());
        if (!message.isEmpty()) return new IllegalStateException(message);
        int status = response == null ? 0 : response.status;
        switch (status) {
            case 401:
                return new IllegalStateException("请求验证失败，请稍后重试");
            case 403:
                return new IllegalStateException("当前请求受限，请稍后重试");
            case 408:
            case 504:
                return new IllegalStateException("请求超时，请稍后重试");
            case 429:
                return new IllegalStateException("请求过于频繁，请稍后再试");
            default:
                if (status >= 500 && status <= 599) {
                    return new IllegalStateException("服务暂时不可用，请稍后重试");
                }
                return new IllegalStateException(cleanFallback(fallback));
        }
    }

    static IllegalStateException forPayload(JSONObject payload, String fallback) {
        String message = safeMessage(payload);
        return new IllegalStateException(
                message.isEmpty() ? cleanFallback(fallback) : message);
    }

    static JSONObject parseObject(HttpClient.Response response, String fallback) {
        try {
            return new JSONObject(response == null ? "" : response.utf8());
        } catch (Throwable malformed) {
            throw new IllegalStateException(cleanFallback(fallback));
        }
    }

    static String safeMessage(String body) {
        if (body == null || body.length() > 16 * 1024) return "";
        try {
            Object value = new JSONTokener(body).nextValue();
            return safeMessage(value);
        } catch (Throwable ignored) {
            return "";
        }
    }

    private static String safeMessage(Object value) {
        if (!(value instanceof JSONObject)) return "";
        JSONObject object = (JSONObject) value;
        for (String key : new String[]{"message", "msg", "userMessage", "errorMessage"}) {
            String message = sanitize(object.optString(key, ""));
            if (!message.isEmpty()) return message;
        }
        Object nestedError = object.opt("error");
        String errorMessage = safeMessage(nestedError);
        if (!errorMessage.isEmpty()) return errorMessage;
        Object nestedData = object.opt("data");
        return safeMessage(nestedData);
    }

    private static String sanitize(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty() || value.length() > 96 || !containsHan(value)) return "";
        String lower = value.toLowerCase(Locale.ROOT);
        if (lower.contains("http") || lower.contains("exception") || lower.contains("stack")
                || value.indexOf('\n') >= 0 || value.indexOf('\r') >= 0
                || value.matches(".*[\\\\/<>`{}\\[\\]@].*")) return "";
        if (!value.matches("[\\p{IsHan}A-Za-z0-9\\s，。！？、：；（）()“”‘’…—-]+")) return "";
        return value.replaceAll("\\d{4,}", "***");
    }

    private static boolean containsHan(String value) {
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character >= 0x4E00 && character <= 0x9FFF) return true;
        }
        return false;
    }

    private static String cleanFallback(String fallback) {
        String value = fallback == null ? "" : fallback.trim();
        return value.isEmpty() ? NETWORK : value;
    }
}
