package me.pipi.deliveries.network;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import me.pipi.deliveries.data.ExpressPhoneBindingPolicy;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.CainiaoRoute;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.net.URI;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.security.MessageDigest;

/** Complete interface 5 account, list and same-source detail client. */
public final class ExpressDiscoveryClient {
    private static final String TAG = "Interface5Account";
    private static final String PREFS = "express_interface5_sync_v2";
    private static final String DETAIL_SIGNATURE_PREFIX = "detail_signature_";
    private static final String DETAIL_REFRESH_PREFIX = "detail_refresh_";
    private static final long DETAIL_MAX_AGE_MS = 6L * 60L * 60L * 1000L;
    private static final long DETAIL_CACHE_RETENTION_MS = 8L * 24L * 60L * 60L * 1000L;
    private final Set<String> syncedWaybills = new HashSet<>();

    public static final class CarrierMatch {
        public final String code;
        public final String name;

        CarrierMatch(String code, String name) {
            this.code = code == null ? "" : code.trim();
            this.name = name == null ? "" : name.trim();
        }
    }

    public void sendCode(Context context, String phone) throws Exception {
        requestAccount(context, "/api/express/accounts/code", phone, "");
    }

    public void bind(Context context, String phone, String code) throws Exception {
        String verificationCode = code == null ? "" : code.trim();
        if (!verificationCode.matches("^\\d{4,6}$")) {
            throw new IllegalArgumentException("请输入正确的验证码");
        }
        requestAccount(context, "/api/express/accounts/bind", phone, verificationCode);
    }

    private static void requestAccount(
            Context context, String route, String phone, String code) throws Exception {
        JSONObject request = new JSONObject()
                .put("interface", "v5")
                .put("identity", ExpressInstallIdentity.get(context))
                .put("phone", normalizedPhone(phone));
        if (!code.isEmpty()) request.put("code", code);
        HttpClient.Response response = new ExpressGatewayClient(context).post(route, request);
        if (!response.successful()) {
            throw GatewayHttpErrors.forResponse(response, "验证失败，请稍后重试");
        }
        JSONObject outer = GatewayHttpErrors.parseObject(
                response, "验证失败，请稍后重试");
        if (outer.optInt("code", -1) != 0) {
            throw GatewayHttpErrors.forPayload(outer, "验证失败，请稍后重试");
        }
    }

    public int sync(Context context, List<String> phones) throws Exception {
        ArrayList<String> normalizedPhones = normalizedPhones(phones);
        if (normalizedPhones.isEmpty()) return 0;
        SharedPreferences prefs = context.getSharedPreferences(PREFS, 0);
        pruneDetailCache(prefs, System.currentTimeMillis());
        JSONObject request = new JSONObject()
                .put("interface", "v5")
                .put("identity", ExpressInstallIdentity.get(context))
                .put("phones", new JSONArray(normalizedPhones));
        HttpClient.Response response = new ExpressGatewayClient(context).post(
                "/api/express/accounts/sync", request);
        if (!response.successful()) {
            throw GatewayHttpErrors.forResponse(response, "同步失败，请稍后重试");
        }
        JSONObject outer = GatewayHttpErrors.parseObject(
                response, "同步失败，请稍后重试");
        if (outer.optInt("code", -1) != 0) {
            throw GatewayHttpErrors.forPayload(outer, "同步失败，请稍后重试");
        }
        JSONObject payload = outer.optJSONObject("data");
        if (payload == null) {
            return 0;
        }
        JSONArray list = payload.optJSONArray("expressList");
        if (list == null) {
            JSONObject data = payload.optJSONObject("data");
            list = data == null ? null : data.optJSONArray("expressList");
        }
        if (list == null) {
            return 0;
        }

        ExpressRepository repository = ExpressRepository.get(context);
        ArrayList<JSONObject> discovered = new ArrayList<>();
        Map<String, ExpressItem> existingBeforeSync = new HashMap<>();
        Set<String> detailCandidates = new HashSet<>();
        Set<String> importedWaybills = new HashSet<>();
        int imported = 0;
        for (int index = 0; index < list.length(); index++) {
            JSONObject item = list.optJSONObject(index);
            if (item == null) continue;
            String waybill = itemIdentity(item);
            if (waybill.isEmpty()) continue;
            if (repository.isTombstoned(waybill)) continue;
            boolean suppressed = repository.hasUnboundPhoneAssociation(
                    waybill, "interface5");
            String associatedPhone = matchedPhone(
                    item, normalizedPhones, !suppressed);
            if (ExpressRepository.shouldSuppressAutomaticImport(
                    suppressed, associatedPhone)) continue;
            String normalizedWaybill = normalize(waybill);
            if (detailCandidates.add(detailCandidateKey(item))) {
                discovered.add(item);
            }
            syncedWaybills.add(normalizedWaybill);
            ExpressItem previous = existingBeforeSync.containsKey(normalizedWaybill)
                    ? existingBeforeSync.get(normalizedWaybill)
                    : repository.findByWaybill(waybill, "interface5");
            if (!existingBeforeSync.containsKey(normalizedWaybill)) {
                existingBeforeSync.put(normalizedWaybill, previous);
            }
            // The list operation is the only one that discovers account order ids. Persist every
            // summary before starting any slower per-item detail request, otherwise a killed
            // Worker can lose later order ids that getList may not repeat on the next refresh.
            if (isAccountOrderRecord(item)) {
                ExpressQueryResult jd = parseAccountOrder(item);
                if (jd == null) continue;
                repository.saveInterface5OrderSummary(jd, associatedPhone);
                if (previous == null
                        && repository.findByWaybill(waybill, "interface5") != null
                        && importedWaybills.add(normalizedWaybill)) imported++;
                continue;
            }
            if (persistExpress(repository, item, associatedPhone)
                    && importedWaybills.add(normalizedWaybill)) imported++;
        }
        // Detail enrichment is deliberately a second phase. A failure here leaves a complete
        // local discovery set that can be resumed through v2/query on a later Worker run.
        for (JSONObject item : discovered) {
            String waybill = itemIdentity(item);
            if (!shouldQueryDetails(
                    prefs, item, existingBeforeSync.get(normalize(waybill)))) continue;
            try {
                boolean suppressed = repository.hasUnboundPhoneAssociation(
                        waybill, "interface5");
                String associatedPhone = matchedPhone(
                        item, normalizedPhones, !suppressed);
                if (ExpressRepository.shouldSuppressAutomaticImport(
                        suppressed, associatedPhone)) continue;
                JSONObject queried = queryDetails(context, item, associatedPhone);
                if (queried == null) continue;
                if (!detailMatchesRequestedIdentity(queried, waybill)) continue;
                JSONObject completeItem = overlay(item, queried);
                boolean accountOrder = isAccountOrderRecord(item);
                ExpressQueryResult detailed = accountOrder
                        ? parseAccountOrder(completeItem)
                        : storedExpress(completeItem, associatedPhone);
                if (detailed == null
                        || !normalize(waybill).equals(normalize(detailed.waybill))) continue;
                if (accountOrder) repository.saveInterface5Order(detailed, associatedPhone);
                else repository.saveInterface5(detailed, associatedPhone);
                boolean realTimeline = Kuaidi100TimelinePolicy.hasRealTracking(detailed);
                ExpressItem persisted = repository.findByWaybill(waybill, "interface5");
                if (!ExpressStatusNormalizer.isProviderErrorDetail(detailed.latestDetail)
                        && persisted != null
                        && (!realTimeline
                        || !persisted.usesInterface5AccountTimeline()
                        || repository.hasAccountTimeline(waybill, "interface5"))) {
                    rememberDetailRefresh(prefs, item);
                }
            } catch (Throwable failure) {
                Log.w(TAG, "Single parcel detail unavailable; keeping list summary");
            }
        }
        Log.d(TAG, "Discovery summaries=" + list.length() + ", imported=" + imported);
        return imported;
    }

    public boolean wasSynced(String waybill) {
        return syncedWaybills.contains(normalize(waybill));
    }

    /** Uses only the selected account source to recognize a manually entered waybill. */
    public CarrierMatch detectManualCarrier(Context context, String waybill) throws Exception {
        return detectManualCarrier(context, waybill, null);
    }

    public CarrierMatch detectManualCarrier(
            Context context, String waybill, ExpressQueryCancellation cancellation)
            throws Exception {
        String number = normalizedWaybill(waybill);
        JSONObject request = new JSONObject()
                .put("interface", "v5")
                .put("mode", "match")
                .put("identity", ExpressInstallIdentity.get(context))
                .put("waybill", number)
                .put("phones", new JSONArray());
        HttpClient.Response response = new ExpressGatewayClient(context).post(
                "/api/express/timeline/source", request, cancellation);
        if (!response.successful()) {
            throw GatewayHttpErrors.forResponse(response, "暂时无法识别承运商");
        }
        JSONObject outer = GatewayHttpErrors.parseObject(
                response, "暂时无法识别承运商");
        JSONArray values = outer.optJSONArray("data");
        JSONObject match = values == null ? null : values.optJSONObject(0);
        if (outer.optInt("code", -1) != 0 || match == null) {
            throw new IllegalStateException("暂时无法识别承运商");
        }
        return new CarrierMatch(first(match, "cpCode"), first(match, "name"));
    }

    /** Manual lookup through interface 5 only, including its same-source official retry. */
    public ExpressQueryResult queryManual(
            Context context, String waybill, List<String> phones) throws Exception {
        return queryManual(context, waybill, phones, null);
    }

    public ExpressQueryResult queryManual(
            Context context, String waybill, List<String> phones,
            ExpressQueryCancellation cancellation) throws Exception {
        String number = normalizedWaybill(waybill);
        JSONObject request = new JSONObject()
                .put("interface", "v5")
                .put("mode", "manual")
                .put("identity", ExpressInstallIdentity.get(context))
                .put("waybill", number)
                .put("phones", new JSONArray(normalizedPhonesAllowEmpty(phones)));
        HttpClient.Response response = new ExpressGatewayClient(context).post(
                "/api/express/timeline/source", request, cancellation);
        if (!response.successful()) {
            throw GatewayHttpErrors.forResponse(response, "查询失败，请稍后重试");
        }
        JSONObject outer = GatewayHttpErrors.parseObject(
                response, "查询失败，请稍后重试");
        if (outer.optInt("code", -1) != 0) {
            throw new IllegalStateException("暂无轨迹");
        }
        JSONObject item = findDetailObject(outer);
        if (item == null) throw new IllegalStateException("暂无轨迹");
        String credential = cainiaoDetailUrl(item);
        ExpressQueryResult result = parseExpress(
                item, credential.isEmpty() ? "" : CainiaoRoute.token("v5"), "");
        if (result == null) throw new IllegalStateException("暂无轨迹");
        return result;
    }

    /** Refreshes an existing interface 5 row even when the latest list omits it. */
    public ExpressQueryResult refreshKnown(Context context, ExpressItem item) throws Exception {
        if (item == null || !isInterface5Owned(item) || wasSynced(item.waybill)) return null;
        SharedPreferences prefs = context.getSharedPreferences(PREFS, 0);
        JSONObject summary = itemSummary(item);
        String key = detailCacheKey(itemIdentity(summary));
        if (!shouldRefreshKnownOrder(
                item.semantic,
                detailSignature(summary),
                prefs.getString(DETAIL_SIGNATURE_PREFIX + key, ""),
                prefs.getLong(DETAIL_REFRESH_PREFIX + key, 0L),
                System.currentTimeMillis())) {
            return null;
        }
        JSONObject queried = queryDetails(context, summary, item.phone);
        if (queried == null) return null;
        if (!detailMatchesRequestedIdentity(queried, item.waybill)) return null;
        JSONObject complete = overlay(summary, queried);
        ExpressQueryResult result = isAccountOrderRecord(complete)
                ? parseAccountOrder(complete)
                : parseExpress(complete, cainiaoUrl(complete, item.waybill, item.courierCode),
                        item.phone);
        return withSourceProvider(result, item.sourceProvider);
    }

    static ExpressQueryResult withSourceProvider(
            ExpressQueryResult result, String sourceProvider) {
        if (result == null) return null;
        return new ExpressQueryResult(
                result.waybill, result.courierCode, result.companyName,
                result.semantic, result.statusEventTime,
                result.latestTime, result.latestDetail,
                result.tracksJson, result.detailUrl, result.phone,
                result.timelineProvider, result.routeInterface,
                result.routeCredential, sourceProvider);
    }

    /** Records a known-item detail refresh only after its caller has persisted the result. */
    public void rememberKnownRefresh(Context context, ExpressItem item) throws Exception {
        if (context == null || item == null) return;
        rememberDetailRefresh(context.getSharedPreferences(PREFS, 0), itemSummary(item));
    }

    private boolean persistExpress(
            ExpressRepository repository, JSONObject item, String phone) {
        String waybill = itemIdentity(item);
        ExpressQueryResult result = storedExpress(item, phone);
        if (result == null) return false;
        ExpressItem previous = repository.findByWaybill(waybill, "interface5");
        repository.saveInterface5(result, phone);
        return previous == null
                && repository.findByWaybill(waybill, "interface5") != null;
    }

    private static ExpressQueryResult storedExpress(JSONObject item, String phone) {
        String routeUrl = cainiaoDetailUrl(item);
        String link = routeUrl.isEmpty() ? "" : CainiaoRoute.token("v5");
        return parseExpress(item, link, phone);
    }

    static String normalizedPhone(String phone) {
        String value = phone == null ? "" : phone.replaceAll("\\D", "");
        if (!value.matches("^1[3-9]\\d{9}$")) {
            throw new IllegalArgumentException("请输入正确的手机号");
        }
        return value;
    }

    static ArrayList<String> normalizedPhones(List<String> phones) {
        ArrayList<String> result = new ArrayList<>();
        if (phones == null) return result;
        for (String phone : phones) {
            String normalized = normalizedPhone(phone);
            if (!result.contains(normalized)) result.add(normalized);
        }
        ExpressPhoneBindingPolicy.requireWithinLimit(result.size());
        return result;
    }

    private static ArrayList<String> normalizedPhonesAllowEmpty(List<String> phones) {
        ArrayList<String> result = new ArrayList<>();
        if (phones == null) return result;
        for (String phone : phones) {
            String value = phone == null ? "" : phone.replaceAll("\\D", "");
            if (value.isEmpty()) continue;
            String normalized = normalizedPhone(value);
            if (!result.contains(normalized)) result.add(normalized);
        }
        ExpressPhoneBindingPolicy.requireWithinLimit(result.size());
        return result;
    }

    private static String normalizedWaybill(String waybill) {
        String value = waybill == null ? "" : waybill.trim();
        if (value.length() < 6) throw new IllegalArgumentException("请输入正确的快递单号");
        return value;
    }

    private static JSONObject queryDetails(
            Context context, JSONObject summary, String fallbackPhone) throws Exception {
        JSONObject request = new JSONObject()
                .put("interface", "v5")
                .put("mode", "detail")
                .put("identity", ExpressInstallIdentity.get(context))
                .put("record", detailRecord(summary, fallbackPhone));
        HttpClient.Response response = new ExpressGatewayClient(context).post(
                "/api/express/timeline/source", request);
        if (!response.successful()) {
            throw GatewayHttpErrors.forResponse(response, "快递详情同步失败");
        }
        JSONObject outer = GatewayHttpErrors.parseObject(
                response, "快递详情同步失败");
        if (outer.optInt("code", -1) != 0) {
            throw GatewayHttpErrors.forPayload(outer, "快递详情同步失败");
        }
        Object payload = outer.opt("data");
        if (payload == null || payload == JSONObject.NULL) return null;
        JSONObject detail = findDetailObject(payload);
        if (detail != null) {
            JSONArray details = detail.optJSONArray("details");
            Log.d(TAG, "Single parcel detail nodes="
                    + (details == null ? 0 : details.length()));
        }
        return detail;
    }

    private static boolean shouldQueryDetails(
            SharedPreferences prefs, JSONObject item, me.pipi.deliveries.model.ExpressItem existing) {
        String key = detailCacheKey(itemIdentity(item));
        String signature = detailSignature(item);
        String previous = prefs.getString(DETAIL_SIGNATURE_PREFIX + key, "");
        long refreshedAt = prefs.getLong(DETAIL_REFRESH_PREFIX + key, 0L);
        return shouldQueryDetails(
                signature, previous, existing, refreshedAt, System.currentTimeMillis());
    }

    static boolean shouldQueryDetails(
            String signature, String previous, ExpressItem existing,
            long refreshedAt, long now) {
        if (!signature.equals(previous)) return true;
        if (existing == null) return true;
        if (ExpressStatusNormalizer.isHeadlinePlaceholder(
                existing.latestDetail, existing.semantic)) return true;
        return refreshedAt > now || now - refreshedAt >= DETAIL_MAX_AGE_MS;
    }

    private static void pruneDetailCache(SharedPreferences prefs, long now) {
        SharedPreferences.Editor editor = null;
        for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
            String name = entry.getKey();
            if (!name.startsWith(DETAIL_REFRESH_PREFIX)) continue;
            Object raw = entry.getValue();
            long refreshedAt = raw instanceof Long ? (Long) raw : 0L;
            if (retainDetailCache(refreshedAt, now)) continue;
            if (editor == null) editor = prefs.edit();
            String suffix = name.substring(DETAIL_REFRESH_PREFIX.length());
            editor.remove(name).remove(DETAIL_SIGNATURE_PREFIX + suffix);
        }
        if (editor != null) editor.apply();
    }

    static boolean retainDetailCache(long refreshedAt, long now) {
        return refreshedAt > 0L && refreshedAt <= now
                && now - refreshedAt < DETAIL_CACHE_RETENTION_MS;
    }

    static boolean shouldRefreshKnownOrder(
            StatusSemantic semantic, String currentSignature,
            String previousSignature, long refreshedAt, long now) {
        if (semantic == null || !semantic.terminal()) return true;
        return refreshedAt <= 0L || refreshedAt > now
                || !currentSignature.equals(previousSignature)
                || now - refreshedAt >= DETAIL_MAX_AGE_MS;
    }

    private static void rememberDetailRefresh(SharedPreferences prefs, JSONObject item) {
        String key = detailCacheKey(itemIdentity(item));
        prefs.edit()
                .putString(DETAIL_SIGNATURE_PREFIX + key, detailSignature(item))
                .putLong(DETAIL_REFRESH_PREFIX + key, System.currentTimeMillis())
                .apply();
    }

    private static String detailSignature(JSONObject item) {
        JSONArray details = item == null ? null : item.optJSONArray("details");
        JSONObject latest = details == null ? null : details.optJSONObject(0);
        return first(item, "cpCode") + '|' + first(item, "state") + '|'
                + (item == null ? 0 : item.optInt("stateNum", 0)) + '|'
                + first(item, "logisticsUpdateTime") + '|'
                + (latest == null ? "" : first(latest, "time", "date", "ftime")) + '|'
                + first(item, "secretKey");
    }

    static String detailCandidateKey(JSONObject item) {
        if (item == null) return "";
        // Only collapse byte-for-byte-equivalent summaries. Ownership evidence and routing
        // fields can legitimately differ between repeated rows for the same shipment.
        return normalize(itemIdentity(item)) + '|' + item.toString();
    }

    static boolean detailMatchesRequestedIdentity(JSONObject detail, String requestedIdentity) {
        String requested = normalize(requestedIdentity);
        if (detail == null || requested.isEmpty()) return false;
        boolean foundIdentity = false;
        for (String key : new String[]{"mailNo", "orderNo", "orderId", "orderCode"}) {
            Object raw = detail.opt(key);
            if (raw == null || raw == JSONObject.NULL) continue;
            String value = raw.toString().trim();
            if (value.isEmpty() || "null".equalsIgnoreCase(value)) continue;
            String candidate = normalize(value);
            if (candidate.isEmpty()) continue;
            foundIdentity = true;
            if (requested.equals(candidate)) return true;
        }
        // Some detail payloads contain only timeline fields; the signed request remains the
        // causal identity in that shape. A contradictory explicit identity is rejected.
        return !foundIdentity;
    }

    private static String detailCacheKey(String waybill) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(normalize(waybill).getBytes(StandardCharsets.UTF_8));
            StringBuilder output = new StringBuilder(24);
            for (int index = 0; index < 12; index++) {
                output.append(String.format(Locale.US, "%02x", digest[index] & 0xff));
            }
            return output.toString();
        } catch (Exception impossible) {
            return Integer.toHexString(normalize(waybill).hashCode());
        }
    }

    static JSONObject detailRecord(JSONObject item, String fallbackPhone) throws Exception {
        String matchedPhone = fallbackPhone == null
                ? "" : fallbackPhone.replaceAll("\\D", "");
        String phone = matchedPhone.matches("^1[3-9]\\d{9}$")
                ? matchedPhone : first(item, "phone");
        String updateTime = first(item, "logisticsUpdateTime");
        if (updateTime.isEmpty()) {
            JSONArray details = item.optJSONArray("details");
            JSONObject latest = details == null ? null : details.optJSONObject(0);
            if (latest != null) updateTime = first(latest, "time", "date", "ftime");
        }
        return new JSONObject()
                .put("waybill", itemIdentity(item))
                .put("companyCode", item.optString("cpCode", ""))
                .put("name", item.optString("name", ""))
                .put("provider", item.optString("provider", ""))
                .put("stateNumber", item.optInt("stateNum", 0))
                .put("updateTime", updateTime)
                .put("phone", phone)
                .put("channel", item.has("channel") ? item.opt("channel") : 1);
    }

    static JSONObject accountOrderSummary(ExpressItem item) throws Exception {
        return itemSummary(item);
    }

    static JSONObject itemSummary(ExpressItem item) throws Exception {
        boolean jd = item.isAccountOrder();
        String provider = item.sourceProvider.isEmpty()
                ? (jd ? "JingDong" : "CaiNiao") : item.sourceProvider;
        return new JSONObject()
                .put("mailNo", item.waybill)
                .put("cpCode", item.courierCode.isEmpty() && jd ? "JD" : item.courierCode)
                .put("name", item.companyName.isEmpty() && jd ? "京东购物" : item.companyName)
                .put("provider", provider)
                .put("state", item.sourceSemantic.label)
                .put("stateNum", interface5StateNumber(item.sourceSemantic))
                .put("logisticsUpdateTime", item.latestTime)
                .put("phone", item.phone)
                .put("channel", 1);
    }

    static int interface5StateNumber(StatusSemantic semantic) {
        if (semantic == null) return 0;
        switch (semantic) {
            case ORDERED: return 101;
            case SHIPPED: return 102;
            case PICKED: return 103;
            case TRANSIT: return 104;
            case DELIVERY: return 105;
            case WAITING_PICKUP: return 106;
            case COMPLETED: return 107;
            case DANGER: return 108;
            case CANCELLED: return 111;
            default: return 0;
        }
    }

    static JSONObject findDetailObject(Object node) {
        DetailCandidate candidate = findDetailCandidate(node);
        return candidate == null ? null : candidate.value;
    }

    private static DetailCandidate findDetailCandidate(Object node) {
        DetailCandidate best = null;
        if (node instanceof JSONObject) {
            JSONObject object = (JSONObject) node;
            JSONArray details = object.optJSONArray("details");
            if (details != null) {
                best = new DetailCandidate(object, meaningfulDetailCount(details));
            }
            java.util.Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                best = better(best, findDetailCandidate(object.opt(keys.next())));
            }
        } else if (node instanceof JSONArray) {
            JSONArray values = (JSONArray) node;
            for (int index = 0; index < values.length(); index++) {
                best = better(best, findDetailCandidate(values.opt(index)));
            }
        } else if (node instanceof String) {
            try {
                Object decoded = new org.json.JSONTokener((String) node).nextValue();
                if (!(decoded instanceof String && node.equals(decoded))) {
                    best = findDetailCandidate(decoded);
                }
            } catch (Throwable ignored) {
                // Plain provider strings are not detail containers.
            }
        }
        return best;
    }

    private static DetailCandidate better(
            DetailCandidate current, DetailCandidate candidate) {
        if (candidate == null) return current;
        return current == null || candidate.meaningfulNodes > current.meaningfulNodes
                ? candidate : current;
    }

    private static int meaningfulDetailCount(JSONArray details) {
        int count = 0;
        for (int index = 0; index < details.length(); index++) {
            JSONObject detail = details.optJSONObject(index);
            String description = detail == null ? ""
                    : first(detail, "desc", "context", "description");
            if (!isGenericUpdate(description)) count++;
        }
        return count;
    }

    private static final class DetailCandidate {
        final JSONObject value;
        final int meaningfulNodes;

        DetailCandidate(JSONObject value, int meaningfulNodes) {
            this.value = value;
            this.meaningfulNodes = meaningfulNodes;
        }
    }

    static JSONObject overlay(JSONObject summary, JSONObject detail) throws Exception {
        JSONObject merged = new JSONObject(summary.toString());
        java.util.Iterator<String> keys = detail.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if ("mailNo".equals(key) || "orderNo".equals(key)
                    || "orderId".equals(key) || "orderCode".equals(key)
                    || "provider".equals(key)) continue;
            Object value = detail.opt(key);
            if ("details".equals(key) && value instanceof JSONArray
                    && ((JSONArray) value).length() == 0) continue;
            if (value != null && value != JSONObject.NULL) merged.put(key, value);
        }
        return merged;
    }

    static String cainiaoUrl(JSONObject item, String waybill, String code) {
        return cainiaoDetailUrl(item).isEmpty() ? "" : CainiaoRoute.token("v5");
    }

    static String cainiaoDetailUrl(JSONObject item) {
        String value = item == null ? "" : first(
                item, "detailUrl", "moreInfoUrl", "cainiaoH5");
        return CainiaoRoute.isLegacyCredentialedUrl(value) ? value : "";
    }

    static ExpressQueryResult parseExpress(
            JSONObject item, String detailUrl, String fallbackPhone) {
        if (item == null || isAccountOrderRecord(item)) return null;
        String waybill = item.optString("mailNo", "").trim();
        if (waybill.isEmpty()) return null;
        StatusSemantic semantic = interface5Semantic(item);
        JSONArray details = item.optJSONArray("details");
        JSONArray tracks = new JSONArray();
        if (details != null) {
            for (int index = 0; index < details.length(); index++) {
                JSONObject detail = details.optJSONObject(index);
                if (detail == null) continue;
                String description = detail.optString("desc",
                        detail.optString("context", "")).trim();
                if (isGenericUpdate(description)) continue;
                try {
                    tracks.put(new JSONObject()
                            .put("time", first(detail, "time", "date", "ftime"))
                            .put("context", description));
                } catch (Throwable ignored) {
                    // Keep earlier same-source nodes when one malformed row cannot be projected.
                }
            }
        }
        List<ExpressTimeline.Track> parsed = ExpressTimeline.parse(tracks.toString(), "", "");
        ExpressTimeline.Track latest = parsed.isEmpty() ? null : parsed.get(0);
        String latestDetail = latest == null ? "" : latest.detail;
        String latestTime = latest == null ? "" : latest.time;
        if (semantic == StatusSemantic.UNKNOWN && latestDetail.isEmpty()) return null;
        String routeCredential = cainiaoDetailUrl(item);
        String phone = first(item, "phone");
        if (phone.isEmpty()) phone = fallbackPhone == null ? "" : fallbackPhone.trim();
        return new ExpressQueryResult(
                waybill,
                item.optString("cpCode", ""),
                item.optString("name", ""),
                semantic,
                latestTime,
                latestDetail,
                tracks.toString(),
                detailUrl,
                phone,
                "interface5",
                CainiaoRoute.interfaceFromToken(detailUrl),
                routeCredential,
                first(item, "provider"));
    }

    /** Account-order rows expose a stable order id instead of a carrier waybill. */
    static ExpressQueryResult parseAccountOrder(JSONObject item) {
        if (item == null || !isAccountOrderRecord(item)) return null;
        String orderNo = itemIdentity(item);
        if (orderNo.isEmpty()) return null;
        StatusSemantic semantic = interface5Semantic(item);
        JSONArray tracks = new JSONArray();
        JSONArray details = item.optJSONArray("details");
        if (details != null) {
            for (int index = 0; index < details.length(); index++) {
                JSONObject detail = details.optJSONObject(index);
                if (detail == null) continue;
                String description = first(detail, "desc", "context", "description");
                if (ExpressStatusNormalizer.isHeadlinePlaceholder(description, semantic)
                        || isGenericUpdate(description)) continue;
                JSONObject track = new JSONObject();
                try {
                    track.put("time", first(detail, "time", "date", "ftime"));
                    track.put("context", description);
                    tracks.put(track);
                } catch (Throwable ignored) {
                    // Keep any earlier valid account-source nodes.
                }
            }
        }
        List<ExpressTimeline.Track> parsed = ExpressTimeline.parse(tracks.toString(), "", "");
        ExpressTimeline.Track latest = parsed.isEmpty() ? null : parsed.get(0);
        if (semantic == StatusSemantic.UNKNOWN) {
            semantic = ExpressStatusNormalizer.inferAccountOrderStatus(
                    latest == null ? "" : latest.detail, tracks.toString());
        }
        String code = item.optString("cpCode", "").trim();
        if (code.isEmpty()) code = "JD";
        String route = accountOrderH5Url(item);
        return new ExpressQueryResult(
                orderNo,
                code,
                "京东购物",
                semantic,
                latest == null ? "" : latest.time,
                latest == null ? "" : latest.detail,
                tracks.toString(),
                route.isEmpty() ? "" : CainiaoRoute.token("v5"),
                first(item, "phone", "sendPhone"),
                "interface5",
                route.isEmpty() ? "" : "v5",
                route,
                first(item, "provider"));
    }

    /** Returns the account row's own raw H5 capability without rebuilding or reordering it. */
    static String accountOrderH5Url(JSONObject item) {
        if (!isAccountOrderRecord(item)) return "";
        JSONArray links = item.optJSONArray("jumpList");
        if (links == null) return "";
        for (int index = 0; index < links.length(); index++) {
            JSONObject candidate = links.optJSONObject(index);
            if (candidate == null
                    || !"h5".equalsIgnoreCase(first(candidate, "type"))) continue;
            String link = first(candidate, "link", "url");
            try {
                if ("https".equalsIgnoreCase(URI.create(link).getScheme())) return link;
            } catch (Throwable ignored) {
                // Ignore malformed raw capabilities without attempting to repair them.
            }
        }
        return "";
    }

    /** Account-source numeric state contract; text is used when the code is absent or unknown. */
    private static StatusSemantic interface5Semantic(JSONObject item) {
        if (item == null) return StatusSemantic.UNKNOWN;
        return StatusSemantic.fromAccountState(
                item.optString("stateNum", ""), item.optString("state", ""));
    }

    static boolean isAccountOrderRecord(JSONObject item) {
        if (item == null) return false;
        String mailNo = first(item, "mailNo");
        String provider = first(item, "provider", "providerName");
        return mailNo.matches("^[0-9]{16}$") && "JingDong".equals(provider);
    }

    private static String itemIdentity(JSONObject item) {
        return first(item, "mailNo", "orderNo", "orderId", "orderCode");
    }

    private static String first(JSONObject item, String... keys) {
        for (String key : keys) {
            String value = item.optString(key, "").trim();
            if (!value.isEmpty() && !"null".equalsIgnoreCase(value)) return value;
        }
        return "";
    }

    static String matchedPhone(
            JSONObject item, List<String> phones, boolean allowSingleBindingFallback) {
        // Receiver and sender numbers are independent ownership paths. A mismatch in one field
        // must not hide a valid match in the other, but two different matches stay unassigned.
        PhoneEvidence receiver = phoneEvidence(
                item == null ? "" : item.optString("phone", ""), phones);
        PhoneEvidence sender = phoneEvidence(
                item == null ? "" : item.optString("sendPhone", ""), phones);
        if (!receiver.match.isEmpty() && !sender.match.isEmpty()
                && !receiver.match.equals(sender.match)) return "";
        if (!receiver.match.isEmpty()) return receiver.match;
        if (!sender.match.isEmpty()) return sender.match;
        if (receiver.usable || sender.usable) return "";
        return allowSingleBindingFallback && phones != null && phones.size() == 1
                ? phones.get(0) : "";
    }

    private static PhoneEvidence phoneEvidence(String value, List<String> phones) {
        String candidate = normalizePhoneEvidence(value);
        if (candidate.length() < 4) return new PhoneEvidence(false, "");
        if (phones == null) return new PhoneEvidence(true, "");
        String match = "";
        for (String phone : phones) {
            String bound = normalizePhoneEvidence(phone);
            if (bound.length() != 11) continue;
            boolean same = candidate.length() == 11
                    ? candidate.equals(bound)
                    : candidate.length() < 11
                    && bound.endsWith(candidate.substring(candidate.length() - 4));
            if (!same) continue;
            if (!match.isEmpty() && !match.equals(phone)) {
                return new PhoneEvidence(true, "");
            }
            match = phone;
        }
        return new PhoneEvidence(true, match);
    }

    private static String normalizePhoneEvidence(String value) {
        String digits = value == null ? "" : value.replaceAll("\\D", "");
        return digits.length() == 13 && digits.startsWith("86")
                ? digits.substring(2) : digits;
    }

    private static final class PhoneEvidence {
        final boolean usable;
        final String match;

        PhoneEvidence(boolean usable, String match) {
            this.usable = usable;
            this.match = match == null ? "" : match;
        }
    }

    private static boolean isInterface5Owned(ExpressItem item) {
        return "INTERFACE5".equalsIgnoreCase(item.source)
                || "INTERFACE5".equalsIgnoreCase(item.stateOwner)
                || item.isAccountOrder();
    }

    private static boolean isGenericUpdate(String detail) {
        String value = detail == null ? "" : detail.replaceAll("\\s+", "").trim();
        return value.isEmpty() || value.equals("快递状态已更新")
                || value.equals("快递状态已更新，点击查看>>")
                || value.equals("快递状态已更新,点击查看>>");
    }

    private static String normalize(String waybill) {
        return waybill == null ? "" : waybill.trim().toUpperCase(Locale.ROOT)
                .replaceAll("[^A-Z0-9]", "");
    }

}
