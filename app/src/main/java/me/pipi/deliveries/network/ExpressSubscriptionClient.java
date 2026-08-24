package me.pipi.deliveries.network;

import android.content.Context;
import android.util.Log;

import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.model.CainiaoRoute;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Interface 6 phone subscription and tracking client routed through the shared gateway. */
public final class ExpressSubscriptionClient {
    private static final String TAG = "ExpressSubscription";
    public void sendCode(Context context, String phone) throws Exception {
        requestBind(context, phone, "");
    }

    public void bind(Context context, String phone, String code) throws Exception {
        requestBind(context, phone, code);
    }

    public List<ExpressQueryResult> query(Context context) throws Exception {
        JSONObject payload = new JSONObject()
                .put("interface", "v6")
                .put("identity", identity(context));
        HttpClient.Response response = new ExpressGatewayClient(context).post(
                "/api/express/accounts/sync", payload);
        if (!response.successful()) {
            throw GatewayHttpErrors.forResponse(response, "快递同步失败");
        }
        Object root = unwrap(response.utf8(), "快递同步失败");
        JSONArray list = findExpressArray(root);
        ArrayList<ExpressQueryResult> results = new ArrayList<>();
        if (list == null) return results;
        for (int index = 0; index < list.length(); index++) {
            JSONObject value = list.optJSONObject(index);
            if (value == null) continue;
            ExpressQueryResult parsed = parseExpress(value, "", "");
            if (parsed != null) results.add(parsed);
        }
        return results;
    }

    /** Refreshes one known identity through the mail-number endpoint. */
    public ExpressQueryResult queryWaybill(
            Context context, String waybill, String courierCode) throws Exception {
        String number = waybill == null ? "" : waybill.trim();
        if (number.isEmpty()) return null;
        JSONObject payload = new JSONObject()
                .put("interface", "v6")
                .put("mode", "refresh")
                .put("waybill", number);
        HttpClient.Response response = new ExpressGatewayClient(context).post(
                "/api/express/timeline/source", payload);
        if (!response.successful()) {
            throw GatewayHttpErrors.forResponse(response, "主接口刷新失败");
        }
        Object root = unwrap(response.utf8(), "主接口刷新失败");
        JSONObject value = findExpressObject(root);
        String company = courierCode == null ? "" : courierCode.trim();
        return value == null ? null : parseExpress(value, number, company);
    }

    /**
     * Original app-compatible manual lookup. This endpoint recognizes the carrier from the
     * waybill and returns its code/name with the latest event and detail URL.
     */
    public ExpressQueryResult queryManual(Context context, String waybill) throws Exception {
        return queryManual(context, waybill, null);
    }

    public ExpressQueryResult queryManual(
            Context context, String waybill, ExpressQueryCancellation cancellation)
            throws Exception {
        String number = waybill == null ? "" : waybill.trim();
        if (number.length() < 6) throw new IllegalArgumentException("请输入正确的快递单号");
        android.content.pm.PackageInfo info = context.getPackageManager()
                .getPackageInfo(context.getPackageName(), 0);
        String versionName = info.versionName == null ? "" : info.versionName;
        long versionCode = info.getLongVersionCode();
        JSONObject payload = new JSONObject()
                .put("interface", "v6")
                .put("mode", "manual")
                .put("waybill", number)
                .put("clientVersion", versionName)
                .put("clientBuild", versionCode);
        HttpClient.Response response = new ExpressGatewayClient(context).post(
                "/api/express/timeline/source", payload, cancellation);
        if (!response.successful()) {
            throw GatewayHttpErrors.forResponse(response, "查询失败，请稍后重试");
        }
        return parseManualResponse(response.utf8(), number);
    }

    static ExpressQueryResult parseManualResponse(String body, String fallbackWaybill)
            throws Exception {
        Object payload = unwrap(body, "查询失败，请稍后重试");
        JSONObject value = findManualObject(payload);
        if (value == null) throw new IllegalStateException("暂未查询到物流信息");
        String responseNumber = first(value, "nu", "mailNo");
        String code = first(value, "com", "cpCode");
        String name = first(value, "name", "cpName");
        String stateName = first(value, "stateName", "logisticsStatusDesc");
        String status = first(value, "status", "state", "logsiticsStatus");
        String time = first(value, "time", "logisticsGmtModified");
        String detail = first(value, "context", "lastLogisticDetail", "message");
        JSONArray tracks = value.optJSONArray("data");
        if (tracks == null) tracks = value.optJSONArray("traces");
        if (tracks == null) {
            tracks = new JSONArray();
            if (!time.isEmpty() || !detail.isEmpty()) {
                tracks.put(new JSONObject().put("time", time).put("context", detail));
            }
        }
        List<ExpressTimeline.Track> parsed = ExpressTimeline.parse(
                tracks.toString(), time, detail);
        if (!parsed.isEmpty()) {
            ExpressTimeline.Track latest = parsed.get(0);
            if (time.isEmpty()) time = latest.time;
            if (detail.isEmpty()) detail = latest.detail;
        }
        return new ExpressQueryResult(
                responseNumber.isEmpty() ? fallbackWaybill : responseNumber,
                code,
                CarrierRegistry.companyName(code, name),
                StatusSemantic.fromStored(status, stateName),
                time,
                detail,
                tracks.toString(),
                first(value, "detailUrl", "url"),
                first(value, "subPhone", "receiverPhone"),
                "interface6");
    }

    private JSONObject requestBind(Context context, String phone, String code) throws Exception {
        String value = normalizedPhone(phone);
        boolean sending = code == null || code.trim().isEmpty();
        String operation = sending ? "send" : "bind";
        JSONObject payload = accountPayload(
                value, sending ? "" : code,
                DeviceIdentity.imei(context), DeviceIdentity.clientIp());
        Log.i(TAG, operation + " request routed through express gateway");
        HttpClient.Response response = new ExpressGatewayClient(context).post(
                sending ? "/api/express/accounts/code" : "/api/express/accounts/bind",
                payload);
        if (!response.successful()) {
            throw GatewayHttpErrors.forResponse(response, "验证失败，请稍后重试");
        }
        JSONObject result = GatewayHttpErrors.parseObject(
                response, "验证失败，请稍后重试");
        int responseCode = result.optInt("code", result.optInt("status", -1));
        String safeMessage = GatewayHttpErrors.safeMessage(result.toString());
        Log.i(TAG, operation + " http=" + response.status + " code=" + responseCode
                + (safeMessage.isEmpty() ? "" : " message=" + safeMessage));
        if (responseCode != 0 && responseCode != 200) {
            throw GatewayHttpErrors.forPayload(result, "验证失败，请稍后重试");
        }
        return result;
    }

    static JSONObject accountPayload(
            String phone, String code, String imei, String clientIp) throws Exception {
        JSONObject payload = new JSONObject()
                .put("interface", "v6")
                .put("phone", normalizedPhone(phone))
                .put("identity", new JSONObject()
                        .put("imei", imei == null ? "" : imei.trim())
                        .put("clientIp", clientIp == null ? "" : clientIp.trim()));
        if (code != null && !code.trim().isEmpty()) payload.put("code", code.trim());
        return payload;
    }

    private static JSONObject identity(Context context) throws Exception {
        return new JSONObject()
                .put("imei", DeviceIdentity.imei(context))
                .put("clientIp", DeviceIdentity.clientIp());
    }

    private static String normalizedPhone(String phone) {
        String value = phone == null ? "" : phone.replaceAll("\\D", "");
        if (!value.matches("^1[3-9]\\d{9}$")) {
            throw new IllegalArgumentException("请输入有效的手机号");
        }
        return value;
    }

    private static JSONArray findExpressArray(Object node) {
        if (node instanceof JSONArray) {
            JSONArray array = (JSONArray) node;
            if (array.length() == 0) return null;
            JSONObject first = array.optJSONObject(0);
            if (first != null && first.has("mailNo")) return array;
            for (int index = 0; index < array.length(); index++) {
                JSONArray found = findExpressArray(array.opt(index));
                if (found != null) return found;
            }
        } else if (node instanceof JSONObject) {
            JSONObject object = (JSONObject) node;
            String[] preferred = {"expressList", "serverExpressList", "list", "data"};
            for (String key : preferred) {
                if (!object.has(key)) continue;
                JSONArray found = findExpressArray(object.opt(key));
                if (found != null) return found;
            }
            java.util.Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                JSONArray found = findExpressArray(object.opt(keys.next()));
                if (found != null) return found;
            }
        } else if (node instanceof String) {
            Object decoded = decodeJsonString((String) node);
            if (decoded != node) return findExpressArray(decoded);
        }
        return null;
    }

    private static JSONObject findExpressObject(Object node) {
        if (node instanceof JSONObject) {
            JSONObject object = (JSONObject) node;
            if (object.has("mailNo")) return object;
            java.util.Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                JSONObject found = findExpressObject(object.opt(keys.next()));
                if (found != null) return found;
            }
        } else if (node instanceof JSONArray) {
            JSONArray array = (JSONArray) node;
            for (int index = 0; index < array.length(); index++) {
                JSONObject found = findExpressObject(array.opt(index));
                if (found != null) return found;
            }
        } else if (node instanceof String) {
            Object decoded = decodeJsonString((String) node);
            if (decoded != node) return findExpressObject(decoded);
        }
        return null;
    }

    private static JSONObject findManualObject(Object node) {
        if (node instanceof JSONObject) {
            JSONObject object = (JSONObject) node;
            if (object.has("nu") || object.has("mailNo")) return object;
            java.util.Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                JSONObject found = findManualObject(object.opt(keys.next()));
                if (found != null) return found;
            }
        } else if (node instanceof JSONArray) {
            JSONArray array = (JSONArray) node;
            for (int index = 0; index < array.length(); index++) {
                JSONObject found = findManualObject(array.opt(index));
                if (found != null) return found;
            }
        } else if (node instanceof String) {
            Object decoded = decodeJsonString((String) node);
            if (decoded != node) return findManualObject(decoded);
        }
        return null;
    }

    private static Object unwrap(String body, String fallback) throws Exception {
        Object root;
        try {
            root = new org.json.JSONTokener(body).nextValue();
        } catch (Throwable malformed) {
            throw new IllegalStateException(fallback);
        }
        if (!(root instanceof JSONObject)) return root;
        JSONObject envelope = (JSONObject) root;
        if (envelope.has("code")) {
            int code = envelope.optInt("code", -1);
            if (code != 0 && code != 200) {
                throw GatewayHttpErrors.forPayload(envelope, fallback);
            }
        }
        Object value = envelope.has("value") ? envelope.opt("value") : envelope.opt("data");
        if (value == null || value == JSONObject.NULL || value.toString().isEmpty()) return root;
        return value instanceof String ? decodeJsonString((String) value) : value;
    }

    private static Object decodeJsonString(String value) {
        String clean = value == null ? "" : value.trim();
        if (!(clean.startsWith("{") || clean.startsWith("["))) return value;
        try {
            return new org.json.JSONTokener(clean).nextValue();
        } catch (Throwable ignored) {
            return value;
        }
    }

    private static String first(JSONObject object, String... keys) {
        for (String key : keys) {
            String value = object.optString(key, "").trim();
            if (!value.isEmpty() && !"null".equalsIgnoreCase(value)) return value;
        }
        return "";
    }

    static ExpressQueryResult parseExpress(
            JSONObject value, String fallbackWaybill, String fallbackCode) {
        String waybill = value.optString("mailNo", fallbackWaybill).trim();
        if (waybill.isEmpty()) return null;
        String code = value.optString("cpCode", fallbackCode).trim();
        String description = value.optString("logisticsStatusDesc", "");
        String detail = value.optString("lastLogisticDetail", "");
        StatusSemantic semantic = StatusSemantic.fromStored(
                value.optString("logsiticsStatus",
                        value.optString("logisticsStatus", "")), description);
        // packageDyn is delivery metadata and can contain the route secret. The gateway
        // converts that secret into a complete direct H5; never persist the raw metadata as a
        // local timeline.
        String tracksJson = "[]";
        String latestTime = value.optString("logisticsGmtModified", "");
        boolean providerError = ExpressStatusNormalizer.isProviderErrorDetail(detail);
        if (ExpressStatusNormalizer.isHeadlinePlaceholder(detail, semantic)) {
            // packageDyn is metadata (arrival estimate/secretKey), not a history array.
            detail = "";
            latestTime = "";
        }
        if (providerError && detail.isEmpty()) return null;
        String upstreamDetailUrl = first(value, "detailUrl", "moreInfoUrl", "url");
        String routeUrl = CainiaoRoute.isLegacyCredentialedUrl(upstreamDetailUrl)
                ? upstreamDetailUrl : "";
        String detailUrl = routeUrl.isEmpty() ? "" : CainiaoRoute.token("v6");
        return new ExpressQueryResult(
                waybill,
                code,
                CarrierRegistry.companyName(code, value.optString("cpName", "")),
                semantic,
                latestTime,
                detail,
                tracksJson,
                detailUrl,
                first(value, "subPhone", "receiverPhone"),
                "",
                routeUrl.isEmpty() ? "" : "v6",
                routeUrl);
    }

}
