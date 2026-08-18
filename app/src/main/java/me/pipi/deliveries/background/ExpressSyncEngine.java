package me.pipi.deliveries.background;

import android.content.Context;
import android.util.Log;

import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.PendingExpressQuery;
import me.pipi.deliveries.network.ExpressApi;
import me.pipi.deliveries.network.ExpressAccountSource;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressSubscriptionClient;

import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Synchronizes the selected account source, then refreshes independent local fallbacks. */
final class ExpressSyncEngine {
    private static final String TAG = "ExpressSyncEngine";

    private ExpressSyncEngine() {}

    static void syncAll(Context context) {
        ExpressRepository repository = ExpressRepository.get(context);
        repository.runInChangeBatch(() -> syncAllUnbatched(context, repository));
    }

    private static void syncAllUnbatched(
            Context context, ExpressRepository repository) {
        int[] network = {0, 0};
        ExpressApi kuaidi100 = new ExpressApi(context);
        String bindingSource = ExpressAccountSource.bindingSource(context);
        boolean useInterface5 = "interface5".equals(bindingSource);
        ExpressDiscoveryClient discovery = useInterface5
                ? new ExpressDiscoveryClient() : null;
        ExpressSubscriptionClient subscription = useInterface5
                ? null : new ExpressSubscriptionClient();
        Set<String> syncedSubscriptionWaybills = new HashSet<>();
        List<String> boundPhones = repository.phones(bindingSource);
        refreshPendingManualQueries(repository, kuaidi100, bindingSource);
        if (!boundPhones.isEmpty()) {
            network[0]++;
            try {
                if (useInterface5) {
                    discovery.sync(context, boundPhones);
                } else {
                    for (ExpressQueryResult result : subscription.query(context)) {
                        if (!hasUsableInformation(result)) continue;
                        String association = result.phone.isEmpty()
                                ? repository.associatedPhone(result.waybill, bindingSource)
                                : result.phone;
                        String boundPhone = matchedBoundPhone(association, boundPhones);
                        boolean suppressed = repository.hasUnboundPhoneAssociation(
                                result.waybill, bindingSource);
                        if (boundPhone.isEmpty() && association.isEmpty()
                                && boundPhones.size() == 1 && !suppressed) {
                            boundPhone = boundPhones.get(0);
                        }
                        if (ExpressRepository.shouldSuppressAutomaticImport(
                                suppressed, boundPhone) || boundPhone.isEmpty()) continue;
                        repository.saveInterface6(result, boundPhone);
                        syncedSubscriptionWaybills.add(normalizeWaybill(result.waybill));
                    }
                }
                network[1]++;
            } catch (Throwable failure) {
                Log.w(TAG, "Account refresh failed", failure);
            }
        }
        for (ExpressItem item : repository.listVisible(bindingSource)) {
            try {
                // Account-order rows use an order id, not a K100-compatible carrier waybill.
                if (useInterface5 && isInterface5Owned(item)) {
                    if (!discovery.wasSynced(item.waybill)
                            && (!item.semantic.terminal()
                            || !repository.hasAccountTimeline(
                                    item.waybill, "interface5"))) {
                        network[0]++;
                        ExpressQueryResult refreshed = discovery.refreshKnown(context, item);
                        if (refreshed != null
                                && !ExpressStatusNormalizer.isProviderErrorDetail(
                                refreshed.latestDetail)) {
                            boolean realTimeline = Kuaidi100TimelinePolicy
                                    .hasRealTracking(refreshed);
                            if (item.isAccountOrder()) {
                                repository.saveInterface5Order(refreshed, item.phone);
                            } else {
                                repository.saveInterface5(refreshed, item.phone);
                            }
                            ExpressItem persisted = repository.findByWaybill(
                                    refreshed.waybill, "interface5");
                            if (persisted != null && (!realTimeline
                                    || repository.hasAccountTimeline(
                                    refreshed.waybill, "interface5"))) {
                                discovery.rememberKnownRefresh(context, persisted);
                            }
                            network[1]++;
                        }
                    }
                } else if (!useInterface5 && isInterface6Owned(item)
                        && !syncedSubscriptionWaybills.contains(normalizeWaybill(item.waybill))
                        && !item.semantic.terminal()) {
                    network[0]++;
                    ExpressQueryResult refreshed = subscription.queryWaybill(
                            context, item.waybill, item.courierCode);
                    if (hasUsableInformation(refreshed)) {
                        repository.saveInterface6(refreshed, item.phone);
                        network[1]++;
                    }
                }
                if (!isAccountOwned(item)
                        && !item.semantic.terminal() && isLocalTimelineSource(item.source)) {
                    network[0]++;
                    ExpressQueryResult refreshed = kuaidi100.queryWithPhones(
                            item.waybill, item.courierCode,
                            repository.phoneCandidates(item.phone, bindingSource));
                    if (isInterface5Kuaidi100Owned(item)) {
                        repository.saveManualKuaidi100(
                                refreshed, item.phone, "interface5");
                    } else {
                        ExpressQueryResult selected = repository.saveKuaidi100Timeline(refreshed);
                        if (selected == null) selected = refreshed;
                        repository.saveQuery(
                                selected, item.phone, ExpressApi.listSource(selected));
                    }
                    network[1]++;
                }
                ExpressItem current = repository.findByWaybill(item.waybill, bindingSource);
                if (current != null && !"KD-100".equals(current.source)
                        && !current.isAccountOrder()
                        && repository.needsKuaidi100Headline(current)) {
                    ExpressQueryResult cached = repository.kuaidi100Timeline(current.waybill);
                    if (cached != null) {
                        repository.saveKuaidi100HeadlineFallback(cached, bindingSource);
                    }
                    network[0]++;
                    ExpressQueryResult k100 = kuaidi100.queryWithPhones(
                            current.waybill, current.courierCode,
                            repository.phoneCandidates(current.phone, bindingSource));
                    repository.saveKuaidi100HeadlineFallback(k100, bindingSource);
                    network[1]++;
                }
            } catch (Throwable failure) {
                Log.w(TAG, "Express refresh failed", failure);
            }
        }
        ensureSomeSourceSucceeded(network);
    }

    /** Promotes a hidden manual item only when K100 returns its first real tracking node. */
    private static void refreshPendingManualQueries(
            ExpressRepository repository, ExpressApi kuaidi100, String bindingSource) {
        for (PendingExpressQuery pending : repository.claimPendingManualQueries(
                System.currentTimeMillis(), bindingSource)) {
            try {
                if (repository.findByWaybill(
                        pending.waybill, pending.bindingSource) != null) {
                    repository.removePendingManual(pending.waybill, pending.bindingSource);
                    continue;
                }
                ExpressQueryResult queried = kuaidi100.queryWithPhones(
                        pending.waybill, pending.courierCode,
                        repository.phoneCandidates(pending.phone, pending.bindingSource));
                ExpressQueryResult refreshed = new ExpressQueryResult(
                        queried.waybill,
                        queried.courierCode.isEmpty() ? pending.courierCode : queried.courierCode,
                        queried.companyName.isEmpty() ? pending.companyName : queried.companyName,
                        queried.semantic, queried.latestTime, queried.latestDetail,
                        queried.tracksJson, pending.detailUrl, queried.phone,
                        queried.timelineProvider, pending.routeInterface,
                        pending.routeCredential);
                if (!Kuaidi100TimelinePolicy.hasRealTracking(refreshed)) continue;
                String phone = refreshed.phone.isEmpty() ? pending.phone : refreshed.phone;
                repository.saveManualKuaidi100(
                        refreshed, phone, pending.bindingSource);
                if (repository.findByWaybill(
                        pending.waybill, pending.bindingSource) != null) {
                    repository.removePendingManual(pending.waybill, pending.bindingSource);
                }
            } catch (Throwable failure) {
                // Keep the claimed item hidden. Its next periodic attempt is rate-limited.
                Log.w(TAG, "Pending manual express refresh failed", failure);
            }
        }
    }

    private static void ensureSomeSourceSucceeded(int[] network) {
        if (network[0] > 0 && network[1] == 0) {
            throw new IllegalStateException("All delivery sources failed");
        }
    }

    private static boolean isLocalTimelineSource(String source) {
        return "KD-100".equalsIgnoreCase(source)
                || "I5-K100".equalsIgnoreCase(source)
                || "V4".equalsIgnoreCase(source);
    }

    private static boolean isAccountOwned(ExpressItem item) {
        return isInterface5Owned(item) || isInterface6Owned(item);
    }

    private static boolean isInterface5Owned(ExpressItem item) {
        return item != null && ("INTERFACE5".equalsIgnoreCase(item.source)
                || "INTERFACE5".equalsIgnoreCase(item.stateOwner)
                || item.isAccountOrder());
    }

    private static boolean isInterface5Kuaidi100Owned(ExpressItem item) {
        return item != null && ("I5-K100".equalsIgnoreCase(item.source)
                || "I5-K100".equalsIgnoreCase(item.stateOwner));
    }

    private static boolean isInterface6Owned(ExpressItem item) {
        return item != null && ("INTERFACE6".equalsIgnoreCase(item.source)
                || "INTERFACE6".equalsIgnoreCase(item.stateOwner));
    }

    private static String normalizeWaybill(String value) {
        return value == null ? "" : value.trim().toUpperCase(Locale.ROOT)
                .replaceAll("[^A-Z0-9]", "");
    }

    static boolean hasUsableInformation(ExpressQueryResult result) {
        if (result == null) return false;
        if (ExpressStatusNormalizer.isProviderErrorDetail(result.latestDetail)) return false;
        if (result.semantic != null
                && result.semantic != me.pipi.deliveries.model.StatusSemantic.UNKNOWN) {
            return true;
        }
        String detail = result.latestDetail == null ? ""
                : result.latestDetail.replaceAll("\\s+", "").trim();
        return !detail.isEmpty();
    }

    static String matchedBoundPhone(String candidate, List<String> boundPhones) {
        String wanted = normalizePhone(candidate);
        if (wanted.isEmpty() || boundPhones == null) return "";
        String match = "";
        for (String phone : boundPhones) {
            String bound = normalizePhone(phone);
            if (bound.isEmpty()) continue;
            boolean same = wanted.length() >= 11
                    ? wanted.equals(bound)
                    : wanted.length() >= 4 && bound.endsWith(
                            wanted.substring(wanted.length() - 4));
            if (!same) continue;
            if (!match.isEmpty()) return "";
            match = phone;
        }
        return match;
    }

    private static String normalizePhone(String phone) {
        String digits = phone == null ? "" : phone.replaceAll("\\D", "");
        return digits.length() == 13 && digits.startsWith("86")
                ? digits.substring(2) : digits;
    }
}
