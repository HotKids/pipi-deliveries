package me.pipi.deliveries.network;

import me.pipi.deliveries.data.TimelineSlot;
import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import me.pipi.deliveries.data.ExpressPhoneBindingPolicy;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.WorkerStatusProjection;
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
    private final ExpressGatewayTransport transport;
    private final JSONObject identity;
    private final Set<String> syncedWaybills = new HashSet<>();
    private final Map<String, Set<String>> syncedWaybillsByGeneration = new HashMap<>();

    public ExpressDiscoveryClient() {
        this(null, null);
    }

    ExpressDiscoveryClient(ExpressGatewayTransport transport, JSONObject identity) {
        this.transport = transport;
        this.identity = identity;
    }

    private ExpressGatewayTransport transport(Context context) {
        return transport == null ? new ExpressGatewayClient(context) : transport;
    }

    private JSONObject identity(Context context) throws Exception {
        return identity == null ? ExpressInstallIdentity.get(context) : identity;
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

    /**
     * 代码 5（用户 2026-10-03「照 Pipi / iOS 的做法改」）：the list's parcel records that would add new rows with a carrier still
     * to recognise wait until the rest of the list (every order summary included) is stored; their carriers are then
     * recognised and they are stored with them, in list order.
     */
    public interface NewRecordCarriers {
        /** Whether this parcel record adds a new row whose carrier is recognised before it is stored. */
        boolean recognizedFirst(ExpressQueryResult record);

        /** The carrier each of these records is stored with, by normalized waybill; absent ones are stored as they came. */
        Map<String, me.pipi.deliveries.model.CarrierNormalization> recognize(List<ExpressQueryResult> records)
                throws InterruptedException;
    }

    /** A parcel record of the list kept back until its carrier is recognised (代码 5). */
    private static final class HeldRecord {
        final JSONObject item;
        final ExpressQueryResult parsed;
        final String associatedPhone;
        final String bindingGeneration;

        HeldRecord(JSONObject item, ExpressQueryResult parsed, String associatedPhone, String bindingGeneration) {
            this.item = item;
            this.parsed = parsed;
            this.associatedPhone = associatedPhone;
            this.bindingGeneration = bindingGeneration;
        }
    }

    private NewRecordCarriers newRecordCarriers;

    /** The sync round's recognition of new records ({@link NewRecordCarriers}); none recognises nothing first. */
    public void recognizeNewRecordsWith(NewRecordCarriers carriers) {
        newRecordCarriers = carriers;
    }

    public int sync(Context context, List<String> phones) throws Exception {
        return sync(context, phones, false);
    }

    public int sync(Context context, List<String> phones, boolean userPull) throws Exception {
        ArrayList<String> normalizedPhones = normalizedPhones(phones);
        if (normalizedPhones.isEmpty()) return 0;
        ExpressRepository repository = ExpressRepository.get(context);
        Map<String, String> bindingGenerations =
                repository.bindingGenerations("interface5");
        syncedWaybills.clear();
        syncedWaybillsByGeneration.clear();
        SharedPreferences prefs = context.getSharedPreferences(PREFS, 0);
        pruneDetailCache(prefs, System.currentTimeMillis());
        JSONObject request = new JSONObject()
                .put("interface", "v5")
                .put("identity", identity(context))
                .put("phones", new JSONArray(normalizedPhones));
        HttpClient.Response response = transport(context).post(
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
            throw new IllegalStateException("同步响应缺少 data");
        }
        JSONArray list = payload.optJSONArray("expressList");
        if (list == null) {
            JSONObject data = payload.optJSONObject("data");
            list = data == null ? null : data.optJSONArray("expressList");
        }
        if (list == null) {
            throw new IllegalStateException("同步响应缺少 expressList");
        }

        // Audit L11 (user 2026-09-25, aligned with iOS parseAccountSyncResult): a list with a record
        // that is not an object or names no identity is refused whole, before anything is saved;
        // a repeated identity keeps its first record.
        for (int index = 0; index < list.length(); index++) {
            JSONObject item = list.optJSONObject(index);
            if (item == null || item.length() == 0 || itemIdentity(item).isEmpty()) {
                throw new IllegalStateException("同步响应包含无法识别的记录");
            }
        }
        Map<String, Integer> listedRecords = listedRecordIndexes(list, System.currentTimeMillis());
        NewRecordCarriers carriers = newRecordCarriers;
        ArrayList<HeldRecord> held = new ArrayList<>();
        ArrayList<JSONObject> discovered = new ArrayList<>();
        Map<String, Integer> changedCainiao = new HashMap<>();
        Map<String, ExpressItem> existingBeforeSync = new HashMap<>();
        Set<String> importedWaybills = new HashSet<>();
        int imported = 0;
        for (int index = 0; index < list.length(); index++) {
            JSONObject item = list.optJSONObject(index);
            String waybill = itemIdentity(item);
            String normalizedWaybill = normalize(waybill);
            Integer listed = listedRecords.get(normalizedWaybill);
            if (listed == null || listed != index) continue;
            boolean suppressed = repository.hasUnboundPhoneAssociation(
                    waybill, "interface5");
            String associatedPhone = matchedPhone(
                    item, normalizedPhones, !suppressed);
            String bindingGeneration = bindingGenerations.get(
                    associatedPhone.replaceAll("\\D", ""));
            if (ExpressRepository.shouldSuppressAutomaticImport(
                    suppressed, associatedPhone) || bindingGeneration == null) continue;
            syncedWaybills.add(normalizedWaybill);
            syncedWaybillsByGeneration
                    .computeIfAbsent(bindingGeneration, ignored -> new HashSet<>())
                    .add(normalizedWaybill);
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
                ExpressQueryResult jd = parseAccountOrder(item, false, true, associatedPhone);
                if (jd == null) continue;
                repository.saveInterface5OrderSummary(
                        jd, associatedPhone, bindingGeneration);
                if (previous == null
                        && repository.findByWaybill(waybill, "interface5") != null
                        && importedWaybills.add(normalizedWaybill)) imported++;
                continue;
            }
            if (carriers != null) {
                ExpressQueryResult parsed = storedExpress(item, associatedPhone, true);
                if (parsed != null && carriers.recognizedFirst(parsed)) {
                    held.add(new HeldRecord(item, parsed, associatedPhone, bindingGeneration));
                    continue;
                }
            }
            if (persistParcel(repository, item, associatedPhone, bindingGeneration, null,
                    discovered, changedCainiao) && importedWaybills.add(normalizedWaybill)) imported++;
        }
        // 代码 5: the new rows' carriers are recognised once the rest of the list is stored, and each is stored with it.
        if (!held.isEmpty()) {
            ArrayList<ExpressQueryResult> records = new ArrayList<>();
            for (HeldRecord record : held) records.add(record.parsed);
            Map<String, me.pipi.deliveries.model.CarrierNormalization> recognized = carriers.recognize(records);
            for (HeldRecord record : held) {
                if (persistParcel(repository, record.item, record.associatedPhone, record.bindingGeneration,
                        recognized, discovered, changedCainiao)
                        && importedWaybills.add(normalize(itemIdentity(record.item)))) imported++;
            }
        }
        // Persist the list signal before querying. A failed Cainiao query does not turn an
        // identical future list into another update; query completion is not the list baseline.
        for (JSONObject item : discovered) {
            String waybill = itemIdentity(item);
            try {
                boolean suppressed = repository.hasUnboundPhoneAssociation(
                        waybill, "interface5");
                String associatedPhone = matchedPhone(
                        item, normalizedPhones, !suppressed);
                String bindingGeneration = bindingGenerations.get(
                        associatedPhone.replaceAll("\\D", ""));
                if (ExpressRepository.shouldSuppressAutomaticImport(
                        suppressed, associatedPhone) || bindingGeneration == null) continue;
                ExpressItem queryOwner = repository.findByWaybill(waybill, "interface5");
                if (isCainiaoListItem(item)
                        && (queryOwner == null || !isInterface5Owned(queryOwner)
                        || !queryOwner.isCainiaoSource()
                        || queryOwner.semantic == StatusSemantic.CANCELLED
                        || !bindingGeneration.equals(repository.bindingGeneration(
                                queryOwner.phone, "interface5")))) continue;
                JSONObject queried;
                try (ExpressQueryCancellation budget =
                        new ExpressQueryCancellation(ACCOUNT_DETAIL_BUDGET_MS)) {
                    queried = queryDetails(context, item, associatedPhone, budget);
                }
                if (queried == null) continue;
                if (!detailMatchesRequestedIdentity(queried, waybill)) continue;
                JSONObject completeItem = overlay(item, queried);
                boolean accountOrder = isAccountOrderRecord(item);
                ExpressQueryResult detailed = accountOrder
                        ? parseAccountOrder(completeItem)
                        : storedExpress(completeItem, associatedPhone, false);
                if (detailed == null
                        || !normalize(waybill).equals(normalize(detailed.waybill))) continue;
                if (isCainiaoListItem(item)
                        && !Kuaidi100TimelinePolicy.hasRealTracking(detailed)) continue;
                if (!repository.saveInterface5Query(detailed, queryOwner, bindingGeneration)) continue;
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
                ExpressLog.line("v5", "v5_query", "", "failed", ExpressLog.errorDetails(failure));
            }
        }
        ExpressLog.line("v5", "v5_list", "", "succeeded",
                "records", list.length(), "imported", imported);
        return imported;
    }

    private static boolean isCainiaoListItem(JSONObject item) {
        return "CaiNiao".equalsIgnoreCase(first(item, "provider", "providerName"));
    }

    static boolean hasCainiaoListUpdate(ExpressQueryResult previous, ExpressQueryResult current) {
        if (current == null || !"CaiNiao".equalsIgnoreCase(current.sourceProvider)) return false;
        if (previous == null || !"CaiNiao".equalsIgnoreCase(previous.sourceProvider)) return true;
        if (current.statusEventTime < previous.statusEventTime) return false;
        return current.statusEventTime > previous.statusEventTime
                || current.semantic != StatusSemantic.UNKNOWN && current.semantic != previous.semantic;
    }

    public boolean wasSynced(String waybill) {
        return syncedWaybills.contains(normalize(waybill));
    }

    public Map<String, Set<String>> syncedWaybillsByGeneration() {
        Map<String, Set<String>> result = new HashMap<>();
        for (Map.Entry<String, Set<String>> entry
                : syncedWaybillsByGeneration.entrySet()) {
            result.put(entry.getKey(), new HashSet<>(entry.getValue()));
        }
        return result;
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
            throw new ExpressApi.NoTrackException();
        }
        JSONObject item = findDetailObject(outer);
        if (item == null) throw new ExpressApi.NoTrackException();
        String credential = cainiaoDetailUrl(item);
        ExpressQueryResult result = parseExpress(
                item, credential.isEmpty() ? "" : CainiaoRoute.token("v5"), "");
        if (result == null) throw new ExpressApi.NoTrackException();
        return result;
    }

    /**
     * Per-parcel account detail budget (AGENTS §9 三端预算 and audit R6, user default of 2026-09-25):
     * 10 s on the client, the Worker's own upstream wait being 8 s. Background per-parcel requests
     * used to wait on the transport alone (15 s connect + 25 s read).
     */
    public static final long ACCOUNT_DETAIL_BUDGET_MS = 10_000L;

    /** Refreshes an existing interface 5 row even when the latest list omits it. */
    public ExpressQueryResult refreshKnown(Context context, ExpressItem item) throws Exception {
        try (ExpressQueryCancellation budget = new ExpressQueryCancellation(ACCOUNT_DETAIL_BUDGET_MS)) {
            return refreshKnown(context, item, false, budget);
        }
    }

    /**
     * 接口 5 按件详情（`/cpa/express/v2/query`，京东行用订单号）。{@code force} 是详情页主动拉：
     * 用户定 2026-09-05，京东详情**优先展示这条拉回的轨迹**，不受 6 小时签名缓存和「列表这轮
     * 已同步过」的闸门约束——那两道闸是给后台轮询省请求的，不该让用户在详情页看不到全量。
     */
    public ExpressQueryResult refreshKnown(
            Context context, ExpressItem item, boolean force) throws Exception {
        return refreshKnown(context, item, force, null);
    }

    public ExpressQueryResult refreshKnown(Context context, ExpressItem item,
            boolean force, ExpressQueryCancellation cancellation) throws Exception {
        if (item == null || !isInterface5Owned(item)) return null;
        if (!force && (!Kuaidi100TimelinePolicy.shouldRefresh(
                item, null, System.currentTimeMillis()) || wasSynced(item.waybill))) return null;
        SharedPreferences prefs = context.getSharedPreferences(PREFS, 0);
        JSONObject summary = itemSummary(item);
        String key = detailCacheKey(itemIdentity(summary));
        if (!force && !shouldRefreshKnownOrder(
                item.semantic,
                detailSignature(summary),
                prefs.getString(DETAIL_SIGNATURE_PREFIX + key, ""),
                prefs.getLong(DETAIL_REFRESH_PREFIX + key, 0L),
                System.currentTimeMillis())) {
            return null;
        }
        JSONObject queried = queryDetails(context, summary, item.phone, cancellation);
        if (queried == null) return null;
        if (!detailMatchesRequestedIdentity(queried, item.waybill)) return null;
        JSONObject complete = overlay(summary, queried);
        // An account order answers as an order even when the reply names it otherwise (audit L4).
        boolean accountOrder = item.isAccountOrder() || isAccountOrderRecord(complete);
        ExpressQueryResult result = accountOrder
                ? parseAccountOrder(complete, item.isAccountOrder())
                : parseExpress(complete, cainiaoUrl(complete, item.waybill, item.courierCode),
                        item.phone);
        if (result != null) {
            ExpressLog.write("manual.query.completed", "waybillTail", tail(item.displayWaybill()),
                    "sourceProvider", ExpressLog.source(item.sourceProvider, false),
                    "timelineProvider", TimelineSlot.V5_QUERY, "selectionScope", "query_response",
                    "statusSemantic", result.semantic, "statusEventAtMs", result.statusEventTime,
                    "structuredStatus", result.structuredStatusEvidence,
                    "statusScope", result.workerStatus == null ? "" : result.workerStatus.scope,
                    "rawStateNumber", queried.optInt("stateNum", 0),
                    "rawStateSemantic", StatusSemantic.fromAccountState(
                            first(queried, "stateNum"), first(queried, "state")),
                    "rawStatePresent", !first(queried, "state").isEmpty(),
                    "rawStateTextSemantic", StatusSemantic.fromAccountState("", first(queried, "state")),
                    "rawOrderCompleted", "订单已完成".equals(first(queried, "state").replaceAll("\\s", "")),
                    "rawLogisticsUpdatePresent", !first(queried, "logisticsUpdateTime").isEmpty(),
                    "rawLogisticsUpdateNumber", queried.optLong("logisticsUpdateTime", 0L),
                    "rawLogisticsUpdateAtMs", ExpressTimeline.parseTime(first(queried, "logisticsUpdateTime")),
                    "rawTimePresent", !first(queried, "time").isEmpty(),
                    "rawTimeNumber", queried.optLong("time", 0L),
                    "rawTimeAtMs", ExpressTimeline.parseTime(first(queried, "time")),
                    "effectiveTrackCount", Kuaidi100TimelinePolicy.timedTrackCount(result));
        }
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
                result.routeCredential, sourceProvider, result.carrierNormalization)
                .withCarrierIdentityEvidence(result.carrierIdentityEvidence)
                .withManualStatusEvidence(
                        result.statusDescription, result.structuredStatusEvidence);
    }

    /** Records a known-item detail refresh only after its caller has persisted the result. */
    public void rememberKnownRefresh(Context context, ExpressItem item) throws Exception {
        if (context == null || item == null) return;
        rememberDetailRefresh(context.getSharedPreferences(PREFS, 0), itemSummary(item));
    }

    /**
     * Stores one parcel record of the list (a Cainiao record also notes a list update for its detail query); true when
     * it added a new row. {@code recognized}: the carriers recognised for the held new records (代码 5), or null.
     */
    private boolean persistParcel(ExpressRepository repository, JSONObject item, String associatedPhone,
            String bindingGeneration, Map<String, me.pipi.deliveries.model.CarrierNormalization> recognized,
            ArrayList<JSONObject> discovered, Map<String, Integer> changedCainiao) {
        if (!isCainiaoListItem(item)) {
            return persistExpress(repository, item, associatedPhone, bindingGeneration, recognized);
        }
        String waybill = itemIdentity(item);
        String normalizedWaybill = normalize(waybill);
        synchronized (repository) {
            ExpressItem before = repository.findByWaybill(waybill, "interface5");
            ExpressQueryResult previousSource = before == null ? null
                    : repository.automaticSourceTimeline(before);
            boolean added = persistExpress(repository, item, associatedPhone, bindingGeneration, recognized);
            ExpressItem current = repository.findByWaybill(waybill, "interface5");
            ExpressQueryResult currentSource = current == null ? null
                    : repository.automaticSourceTimeline(current);
            if (hasCainiaoListUpdate(previousSource, currentSource)) {
                Integer pending = changedCainiao.get(normalizedWaybill);
                if (pending == null) {
                    changedCainiao.put(normalizedWaybill, discovered.size());
                    discovered.add(item);
                } else {
                    discovered.set(pending, item);
                }
            }
            return added;
        }
    }

    private boolean persistExpress(
            ExpressRepository repository, JSONObject item, String phone,
            String bindingGeneration,
            Map<String, me.pipi.deliveries.model.CarrierNormalization> recognized) {
        String waybill = itemIdentity(item);
        ExpressQueryResult result = storedExpress(item, phone, true);
        if (result == null) return false;
        me.pipi.deliveries.model.CarrierNormalization carrier = recognized == null ? null
                : recognized.get(normalize(result.waybill));
        if (carrier != null) result = result.withCarrierNormalization(carrier);
        JSONArray rawTracks = item.optJSONArray("details");
        ExpressLog.line("v5", "v5_list", ExpressLog.source(result.sourceProvider, false), "parsed",
                "tail", tail(waybill), "rawNodes", rawTracks == null ? 0 : rawTracks.length(),
                "nodes", ExpressTimeline.parse(result.tracksJson, "", "").size(),
                "headlinePresent", !first(item, "lastLogisticDetail", "context", "message").isEmpty(),
                "semantic", result.semantic.name());
        ExpressItem previous = repository.findByWaybill(waybill, "interface5");
        repository.saveInterface5(result, phone, bindingGeneration);
        return previous == null
                && repository.findByWaybill(waybill, "interface5") != null;
    }

    private static ExpressQueryResult storedExpress(
            JSONObject item, String phone, boolean listRecord) {
        String routeUrl = cainiaoDetailUrl(item);
        String link = routeUrl.isEmpty() ? "" : CainiaoRoute.token("v5");
        return parseExpress(item, link, phone, listRecord);
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

    private JSONObject queryDetails(
            Context context, JSONObject summary, String fallbackPhone) throws Exception {
        return queryDetails(context, summary, fallbackPhone, null);
    }

    private JSONObject queryDetails(Context context, JSONObject summary,
            String fallbackPhone, ExpressQueryCancellation cancellation) throws Exception {
        JSONObject request = new JSONObject()
                .put("interface", "v5")
                .put("mode", "detail")
                .put("identity", identity(context))
                .put("record", detailRecord(summary, fallbackPhone));
        HttpClient.Response response = transport(context).post(
                "/api/express/timeline/source", request, cancellation);
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
        JSONObject sent = request.optJSONObject("record");
        String sentIdentity = sent == null ? "" : sent.optString("waybill", "");
        if (detail != null) {
            JSONArray details = detail.optJSONArray("details");
            // 尾号 + 送出去的身份三件套 + 回来的节点数：只为对照「接口 5 按件详情是否拉到全量」，
            // 不落任何完整单号或手机号。
            ExpressLog.line("v5", "v5_query",
                    ExpressLog.source(sent == null ? "" : sent.optString("provider", ""), false),
                    "succeeded",
                    "tail", tail(sentIdentity),
                    "nodes", details == null ? 0 : details.length(),
                    "cp", sent == null ? "" : sent.optString("companyCode", ""),
                    "returnedTail", tail(detail.optString("mailNo", "")));
        } else {
            ExpressLog.line("v5", "v5_query", "", "failed",
                    "tail", tail(sentIdentity), "reason", "no_result");
        }
        return detail;
    }

    private static boolean shouldQueryDetails(
            SharedPreferences prefs, JSONObject item, me.pipi.deliveries.model.ExpressItem existing,
            ExpressRepository repository) {
        String key = detailCacheKey(itemIdentity(item));
        String signature = detailSignature(item);
        String previous = prefs.getString(DETAIL_SIGNATURE_PREFIX + key, "");
        long refreshedAt = prefs.getLong(DETAIL_REFRESH_PREFIX + key, 0L);
        return shouldQueryDetails(
                signature, previous, existing, refreshedAt, System.currentTimeMillis(),
                existing != null && repository.accountDetailComplete(existing));
    }

    /** A trusted signature stops background queries even when its cached history is incomplete. */
    static boolean shouldQueryDetails(
            String signature, String previous, ExpressItem existing,
            long refreshedAt, long now, boolean detailComplete) {
        if (!Kuaidi100TimelinePolicy.shouldRefresh(existing, null, now)) return false;
        if (!signature.equals(previous)) return true;
        if (existing == null) return true;
        if (ExpressStatusNormalizer.isHeadlinePlaceholder(
                existing.latestDetail, existing.semantic)) return true;
        if (detailComplete) return false;
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
        boolean jingDongOrder = isAccountOrderRecord(item);
        return new JSONObject()
                .put("waybill", itemIdentity(item))
                .put("companyCode", jingDongOrder
                        ? JING_DONG_ACCOUNT_CP_CODE : item.optString("cpCode", ""))
                .put("name", jingDongOrder
                        ? JING_DONG_ACCOUNT_NAME : item.optString("name", ""))
                .put("provider", jingDongOrder
                        ? JING_DONG_ACCOUNT_PROVIDER
                        : first(item, "provider", "providerName"))
                .put("stateNumber", item.optInt("stateNum", 0))
                .put("updateTime", updateTime)
                .put("phone", phone)
                .put("channel", item.has("channel") ? item.opt("channel") : 1);
    }

    /**
     * 接口 5 京东来源那一行在上游的身份（用户定 2026-09-05，实网口径；iOS 的同位实现是
     * account-sync.ts 的 detailRecord）。{@code mailNo} 本来就是京东内部的 16 位 {@code wlOrderId}
     * （原始合同 §8.6），不是承运商运单号；联合页回填出来的真实承运商只属于展示层，拿它去问
     * 接口 5，上游不认这一行。所以这三个值按来源固定，不跟着展示层走。
     */
    static final String JING_DONG_ACCOUNT_PROVIDER = "JingDong";
    static final String JING_DONG_ACCOUNT_CP_CODE = "JDKD";
    static final String JING_DONG_ACCOUNT_NAME = "京东商品快递";

    static JSONObject accountOrderSummary(ExpressItem item) throws Exception {
        return itemSummary(item);
    }

    /**
     * The per-parcel request rebuilt from a stored row. An account order asks with the order's own
     * upstream identity (JDKD / 京东商品快递 / JingDong, iOS detailRecord), whatever the carrier table
     * later made of its stored company name: audit L4 (user 2026-09-25), the 12-digit exchange order
     * 351100058925 is only recognized as an order under that identity, and its stored name had become
     * 京东快递, so it was asked for and parsed as an ordinary parcel.
     */
    static JSONObject itemSummary(ExpressItem item) throws Exception {
        boolean jd = item.isAccountOrder();
        String provider = jd ? JING_DONG_ACCOUNT_PROVIDER : item.sourceProvider;
        return new JSONObject()
                .put("mailNo", item.waybill)
                .put("cpCode", jd ? JING_DONG_ACCOUNT_CP_CODE : item.courierCode)
                .put("name", jd ? JING_DONG_ACCOUNT_NAME : item.companyName)
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
        JSONObject merged = new JSONObject(detail.toString());
        // Only request identity is carried across; missing query fields are not feed evidence.
        for (String key : new String[]{"mailNo", "orderNo", "orderId", "orderCode", "provider"}) {
            merged.remove(key);
            if (summary.has(key)) merged.put(key, summary.get(key));
        }
        for (String key : new String[]{"cpCode", "name", "phone", "providerName"}) {
            if (!merged.has(key) && summary.has(key)) merged.put(key, summary.get(key));
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
        return parseExpress(item, detailUrl, fallbackPhone, false);
    }

    /**
     * {@code listRecord}: a record of the account list itself (audit L11, user 2026-09-25, aligned
     * with iOS parseParcel): without usable details it falls back to its own headline and time and
     * is kept even with no status. A per-parcel query answer keeps its stricter reading — an empty
     * answer is no answer.
     */
    static ExpressQueryResult parseExpress(
            JSONObject item, String detailUrl, String fallbackPhone, boolean listRecord) {
        if (item == null || isAccountOrderRecord(item)) return null;
        String waybill = item.optString("mailNo", "").trim();
        if (waybill.isEmpty()) return null;
        StatusSemantic semantic = interface5Semantic(item);
        boolean cainiao = isCainiaoListItem(item);
        long sourceEventTime = 0L;
        JSONArray details = item.optJSONArray("details");
        JSONArray tracks = new JSONArray();
        if (details != null) {
            for (int index = 0; index < details.length(); index++) {
                JSONObject detail = details.optJSONObject(index);
                if (detail == null) continue;
                String description = detail.optString("desc",
                        detail.optString("context", "")).trim();
                if (cainiao && !description.isEmpty()
                        && (isGenericUpdate(description)
                        || !ExpressStatusNormalizer.isNonEventDetail(description))) {
                    sourceEventTime = Math.max(sourceEventTime,
                            ExpressTimeline.parseTime(first(detail, "time", "date", "ftime")));
                }
                if (isGenericUpdate(description)
                        || ExpressStatusNormalizer.isNonEventDetail(description)) continue;
                try {
                    JSONObject track = new JSONObject()
                            .put("time", first(detail, "time", "date", "ftime"))
                            .put("context", description)
                            .put("_pipiStatusSource", "interface5");
                    copyStatusFields(detail, track);
                    tracks.put(track);
                } catch (Throwable ignored) {
                    // Keep earlier same-source nodes when one malformed row cannot be projected.
                }
            }
        }
        List<ExpressTimeline.Track> parsed = ExpressTimeline.parse(tracks.toString(), "", "");
        ExpressTimeline.Track latest = parsed.isEmpty() ? null : parsed.get(0);
        String latestDetail = latest != null ? latest.detail : listRecord ? listHeadline(item) : "";
        String latestTime = latest != null ? latest.time : listRecord ? listHeadlineTime(item) : "";
        if (!listRecord && semantic == StatusSemantic.UNKNOWN && latestDetail.isEmpty()) return null;
        String routeCredential = cainiaoDetailUrl(item);
        String phone = first(item, "phone");
        if (listRecord && fallbackPhone != null) {
            String matchedPhone = fallbackPhone.replaceAll("\\D", "");
            if (matchedPhone.matches("^1[3-9]\\d{9}$")) {
                // The matched account binding owns persistence even when the receiver is someone else.
                phone = matchedPhone;
            }
        }
        if (phone.isEmpty()) phone = fallbackPhone == null ? "" : fallbackPhone.trim();
        String rawCompanyName = item.optString("name", "");
        ExpressQueryResult result = new ExpressQueryResult(
                waybill,
                item.optString("cpCode", ""),
                rawCompanyName,
                semantic,
                cainiao ? sourceEventTime : ExpressTimeline.parseTime(latestTime),
                latestTime,
                latestDetail,
                tracks.toString(),
                detailUrl,
                phone,
                TimelineSlot.V5_QUERY,
                CainiaoRoute.interfaceFromToken(detailUrl),
                routeCredential,
                first(item, "provider", "providerName"));
        result = result.withRawCarrierNameEvidence(rawCompanyName)
                .withManualStatusEvidence(semantic.label, trustedAccountStatus(item, semantic));
        return AccountCarrierNormalizer.apply(item, result)
                .withWorkerStatus(WorkerStatusProjection.read(item)).withAccountListMetadata(
                first(item, "sendPhone", "senderPhone"),
                ExpressTimeline.accountListOriginAtMillis(result.tracksJson));
    }

    /** Account-order rows expose a stable order id instead of a carrier waybill. */
    static ExpressQueryResult parseAccountOrder(JSONObject item) {
        return parseAccountOrder(item, false, false);
    }

    static ExpressQueryResult parseAccountOrder(JSONObject item, boolean knownOrder) {
        return parseAccountOrder(item, knownOrder, false);
    }

    /**
     * {@code knownOrder}: the stored row is an account order, so its own detail answer reads as
     * one even when the answer names it otherwise (audit L4).
     */
    static ExpressQueryResult parseAccountOrder(
            JSONObject item, boolean knownOrder, boolean listRecord) {
        return parseAccountOrder(item, knownOrder, listRecord, "");
    }

    private static ExpressQueryResult parseAccountOrder(
            JSONObject item, boolean knownOrder, boolean listRecord, String fallbackPhone) {
        if (item == null || !(knownOrder || isAccountOrderRecord(item))) return null;
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
                // Only an empty line, the update placeholder and provider error lines are dropped
                // (AGENTS §9). A node that reads just a status word (已签收, 运输中) is an ordinary node:
                // audit D2 (user 2026-09-25) found no approval for dropping it on order rows.
                if (isGenericUpdate(description)
                        || ExpressStatusNormalizer.isNonEventDetail(description)) continue;
                JSONObject track = new JSONObject();
                try {
                    track.put("time", first(detail, "time", "date", "ftime"));
                    track.put("context", description);
                    track.put("_pipiStatusSource", "interface5");
                    copyStatusFields(detail, track);
                    tracks.put(track);
                } catch (Throwable ignored) {
                    // Keep any earlier valid account-source nodes.
                }
            }
        }
        List<ExpressTimeline.Track> parsed = ExpressTimeline.parse(tracks.toString(), "", "");
        ExpressTimeline.Track latest = parsed.isEmpty() ? null : parsed.get(0);
        String latestDetail = latest != null ? latest.detail : listRecord ? listHeadline(item) : "";
        String latestTime = latest != null ? latest.time : listRecord ? listHeadlineTime(item) : "";
        if (semantic == StatusSemantic.UNKNOWN && WorkerStatusProjection.read(item) == null) {
            semantic = ExpressStatusNormalizer.inferAccountOrderStatus(
                    latestDetail, tracks.toString());
        }
        // JingDong identifies the business source, not the carrier. Keep the carrier evidence raw;
        // the order card supplies its own display label until H5 resolves the real parcel.
        String code = item.optString("cpCode", "").trim();
        String route = accountOrderH5Url(item, knownOrder);
        String rawCompanyName = item.optString("name", "").trim();
        String phone = first(item, "phone", "sendPhone");
        String matched = fallbackPhone == null ? "" : fallbackPhone.replaceAll("\\D", "");
        if (listRecord && matched.matches("^1[3-9]\\d{9}$")) phone = matched;
        return new ExpressQueryResult(
                orderNo,
                code,
                rawCompanyName,
                semantic,
                ExpressTimeline.parseTime(latestTime),
                latestTime,
                latestDetail,
                tracks.toString(),
                route.isEmpty() ? "" : CainiaoRoute.token("v5"),
                phone,
                TimelineSlot.V5_QUERY,
                route.isEmpty() ? "" : "v5",
                route,
                first(item, "provider", "providerName"))
                .withRawCarrierNameEvidence(rawCompanyName)
                .withManualStatusEvidence(semantic.label, trustedAccountStatus(item, semantic))
                .withWorkerStatus(WorkerStatusProjection.read(item))
                .withAccountListMetadata(first(item, "sendPhone", "senderPhone"),
                        ExpressTimeline.accountListOriginAtMillis(tracks.toString()));
    }

    /**
     * Audit L11 (user 2026-09-25, iOS parseParcel): a list record without usable details still has
     * its own headline and time, never the update placeholder or a provider error line.
     */
    private static String listHeadline(JSONObject item) {
        String headline = first(item, "lastLogisticDetail", "context", "message");
        return isGenericUpdate(headline) || ExpressStatusNormalizer.isNonEventDetail(headline)
                ? "" : headline;
    }

    private static String listHeadlineTime(JSONObject item) {
        return first(item, "logisticsGmtModified", "logisticsUpdateTime", "time");
    }

    private static boolean trustedAccountStatus(JSONObject item, StatusSemantic semantic) {
        return semantic != StatusSemantic.UNKNOWN
                && semantic == StatusSemantic.fromAccountState(item.optString("stateNum", ""), "");
    }

    /** Returns the account row's own raw H5 capability without rebuilding or reordering it. */
    static String accountOrderH5Url(JSONObject item) {
        return accountOrderH5Url(item, false);
    }

    private static String accountOrderH5Url(JSONObject item, boolean knownOrder) {
        if (item == null || !(knownOrder || isAccountOrderRecord(item))) return "";
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
        WorkerStatusProjection status = WorkerStatusProjection.read(item);
        if (status != null) return status.semantic;
        return StatusSemantic.fromAccountState(
                item.optString("stateNum", ""), item.optString("state", ""));
    }

    static boolean isAccountOrderRecord(JSONObject item) {
        if (item == null) return false;
        // Audit L6 (user 2026-09-25): the Worker's scope (normalizedStatus.scope, on v5 also
        // normalizedStatusScope) is the single order-row rule; the local rule below only reads rows
        // stored before a Worker projection existed. Shared fixture: order-scope-cases.v1.json.
        String scope = workerScope(item);
        if (!scope.isEmpty()) return "ORDER".equals(scope);
        String mailNo = first(item, "mailNo");
        String provider = first(item, "provider", "providerName");
        if (!"JingDong".equals(provider)) return false;
        if (mailNo.matches("^[0-9]{16}$")) return true;
        // 12 位纯数字的换货单（351100058925）带的是订单行的身份 cpCode=JDKD、name=京东商品快递，不是承运商；
        // 只看位数时它被当成包裹，列表上承运商名是空的（2026-09-24）。用户定 2026-09-24：12 位纯数字要 JDKD
        // 且 name 就是「京东商品快递」才是订单；同样挂 JDKD、名字是「京东快递」这类承运商名的仍是包裹，
        // R-20 下挂在真实运单号（JT…、JDVD…）上的也是包裹。
        return mailNo.matches("^[0-9]{12}$")
                && JING_DONG_ACCOUNT_CP_CODE.equalsIgnoreCase(first(item, "cpCode"))
                && JING_DONG_ACCOUNT_NAME.equals(first(item, "name"));
    }

    private static String workerScope(JSONObject item) {
        WorkerStatusProjection status = WorkerStatusProjection.read(item);
        String scope = status != null ? status.scope : first(item, "normalizedStatusScope");
        return "ORDER".equals(scope) || "SHIPMENT".equals(scope) ? scope : "";
    }

    private static String tail(String value) {
        String clean = value == null ? "" : value.trim();
        return clean.length() <= 4 ? clean : clean.substring(clean.length() - 4);
    }

    private static String itemIdentity(JSONObject item) {
        return first(item, "mailNo", "orderNo", "orderId", "orderCode");
    }

    /**
     * The one record each listed identity keeps: the first, except that a list carrying both records of a reused
     * waybill number keeps the new one whatever their order (user 2026-10-02, detail 5; {@link
     * me.pipi.deliveries.data.WaybillReusePolicy}). Account-order records keep their first record.
     */
    static Map<String, Integer> listedRecordIndexes(JSONArray list, long now) {
        Map<String, Integer> kept = new HashMap<>();
        Map<String, ExpressQueryResult> keptRecords = new HashMap<>();
        for (int index = 0; list != null && index < list.length(); index++) {
            JSONObject item = list.optJSONObject(index);
            String identity = normalize(itemIdentity(item));
            ExpressQueryResult record = parseExpress(item, "", "", true);
            if (!kept.containsKey(identity)) {
                kept.put(identity, index);
                keptRecords.put(identity, record);
            } else if (me.pipi.deliveries.data.WaybillReusePolicy.supersedes(
                    keptRecords.get(identity), record, now)) {
                kept.put(identity, index);
                keptRecords.put(identity, record);
            }
        }
        return kept;
    }

    private static String first(JSONObject item, String... keys) {
        for (String key : keys) {
            String value = item.optString(key, "").trim();
            if (!value.isEmpty() && !"null".equalsIgnoreCase(value)) return value;
        }
        return "";
    }

    private static void copyStatusFields(JSONObject source, JSONObject target) {
        if (source == null || target == null) return;
        WorkerStatusProjection projected = WorkerStatusProjection.read(source);
        if (projected != null) {
            try { target.put("normalizedStatus", projected.toJson()); }
            catch (org.json.JSONException invalid) { throw new IllegalArgumentException(invalid); }
        }
        for (String key : new String[]{
                "logisticsStatus", "logisticsStatusDesc", "statusCode", "status", "state"
        }) {
            Object value = source.opt(key);
            if (value instanceof String || value instanceof Number) {
                try {
                    target.put(key, value);
                } catch (Throwable ignored) {
                    // Status metadata is optional; the timed event remains usable without it.
                }
            }
        }
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

    /** An empty line or the update placeholder in any of its four forms (user 2026-09-12 / 09-26). */
    private static boolean isGenericUpdate(String detail) {
        String value = detail == null ? "" : detail.replaceAll("\\s+", "").trim();
        return value.isEmpty() || ExpressStatusNormalizer.isUpdateSummary(value);
    }

    private static String normalize(String waybill) {
        return waybill == null ? "" : waybill.trim().toUpperCase(Locale.ROOT)
                .replaceAll("[^A-Z0-9]", "");
    }

}
