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

    /**
     * The same failure as before, with the transport's exception kept as its cause so a sync round can tell a request's
     * own timeout from other failures (用户 2026-09-27 提交前核对答复四); message and type are unchanged.
     */
    static IllegalStateException networkFailure(Throwable cause) {
        return new IllegalStateException(NETWORK, cause);
    }

    static GatewayHttpException forResponse(HttpClient.Response response, String fallback) {
        String body = response == null ? "" : response.utf8();
        int status = response == null ? 0 : response.status;
        String code = gatewayCode(body);
        String message = safeMessage(body);
        if (!message.isEmpty()) return new GatewayHttpException(message, status, code);
        switch (status) {
            case 401:
                return new GatewayHttpException("请求验证失败，请稍后重试", status, code);
            case 403:
                return new GatewayHttpException("当前请求受限，请稍后重试", status, code);
            case 408:
            case 504:
                return new GatewayHttpException("请求超时，请稍后重试", status, code);
            case 429:
                return new GatewayHttpException("请求过于频繁，请稍后再试", status, code);
            default:
                if (status >= 500 && status <= 599) {
                    return new GatewayHttpException("服务暂时不可用，请稍后重试", status, code);
                }
                return new GatewayHttpException(cleanFallback(fallback), status, code);
        }
    }

    /**
     * iOS gateway.ts gatewayErrorCode: the Worker's top-level {@code error} string, lower case, only when
     * it is a plain code token; diagnostics further keep only the whitelisted ones.
     */
    static String gatewayCode(String body) {
        if (body == null || body.isEmpty() || body.length() > 4_096) return "";
        try {
            Object value = new JSONTokener(body).nextValue();
            if (!(value instanceof JSONObject)) return "";
            Object raw = ((JSONObject) value).opt("error");
            if (!(raw instanceof String)) return "";
            String code = ((String) raw).trim().toLowerCase(Locale.ROOT);
            return code.matches("[a-z_]{1,64}") ? code : "";
        } catch (Throwable ignored) {
            return "";
        }
    }

    static IllegalStateException forPayload(JSONObject payload, String fallback) {
        String message = safeMessage(payload);
        return new IllegalStateException(
                message.isEmpty() ? cleanFallback(fallback) : message);
    }

    static JSONObject parseObject(HttpClient.Response response, String fallback)
            throws ExpressApi.QueryException {
        try {
            JSONObject result = new JSONObject(response == null ? "" : response.utf8());
            checkNormalizedError(result, fallback);
            return result;
        } catch (org.json.JSONException malformed) {
            throw new IllegalStateException(cleanFallback(fallback));
        }
    }

    static void checkNormalizedError(JSONObject payload, String fallback)
            throws ExpressApi.QueryException {
        JSONObject error = payload == null ? null : payload.optJSONObject("normalizedError");
        if (error == null || error.optInt("version") != 1) return;
        String code = error.optString("code", "");
        String message;
        switch (code) {
            case "phone_verification_required":
                throw ExpressApi.QueryException.phoneTailRequired("请输入收件人手机号后四位");
            case "upstream_business_error":
            default: message = cleanFallback(fallback);
        }
        throw new IllegalStateException(message);
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
