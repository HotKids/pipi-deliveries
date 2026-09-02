package me.pipi.deliveries.background;

import android.content.Context;
import android.util.Log;

import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.PendingExpressQuery;
import me.pipi.deliveries.network.ExpressApi;
import me.pipi.deliveries.network.ExpressAccountSource;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressSubscriptionClient;
import me.pipi.deliveries.network.ManualQueryCoordinator;
import me.pipi.deliveries.network.ManualQueryRoutingPolicy;

import java.util.HashSet;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
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
        ExpressApi localApi = new ExpressApi(context);
        String bindingSource = ExpressAccountSource.bindingSource(context);
        boolean useInterface5 = "interface5".equals(bindingSource);
        ExpressDiscoveryClient discovery = useInterface5
                ? new ExpressDiscoveryClient() : null;
        ExpressSubscriptionClient subscription = new ExpressSubscriptionClient();
        Set<String> syncedSubscriptionWaybills = new HashSet<>();
        List<String> boundPhones = repository.phones(bindingSource);
        Map<String, String> bindingGenerations =
                repository.bindingGenerations(bindingSource);
        refreshPendingManualQueries(
                context, repository, discovery, subscription, localApi, bindingSource);
        if (!boundPhones.isEmpty()) {
            network[0]++;
            try {
                if (useInterface5) {
                    discovery.sync(context, boundPhones);
                    repository.recordAutomaticRefreshExecuted(
                            "INTERFACE5",
                            discovery.syncedWaybillsByGeneration(),
                            System.currentTimeMillis());
                } else {
                    List<ExpressQueryResult> subscriptionResults = subscription.query(context);
                    Map<String, Set<String>> seenByGeneration = new HashMap<>();
                    for (ExpressQueryResult result : subscriptionResults) {
                        String normalizedWaybill = normalizeWaybill(result.waybill);
                        syncedSubscriptionWaybills.add(normalizedWaybill);
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
                        String generation = bindingGenerations.get(
                                boundPhone.replaceAll("\\D", ""));
                        if (generation == null || generation.isEmpty()) continue;
                        seenByGeneration
                                .computeIfAbsent(generation, ignored -> new HashSet<>())
                                .add(normalizedWaybill);
                        repository.saveInterface6(result, boundPhone, generation);
                    }
                    repository.recordAutomaticRefreshExecuted(
                            "INTERFACE6",
                            seenByGeneration, System.currentTimeMillis());
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
                            || (item.usesInterface5AccountTimeline()
                            && !repository.hasAccountTimeline(
                                    item.waybill, "interface5")))) {
                        network[0]++;
                        String bindingGeneration = repository.bindingGeneration(
                                item.phone, "interface5");
                        ExpressQueryResult refreshed = discovery.refreshKnown(context, item);
                        if (refreshed != null
                                && !ExpressStatusNormalizer.isProviderErrorDetail(
                                refreshed.latestDetail)) {
                            boolean realTimeline = Kuaidi100TimelinePolicy
                                    .hasRealTracking(refreshed);
                            if (item.isAccountOrder()) {
                                repository.saveInterface5Order(
                                        refreshed, item.phone, bindingGeneration);
                            } else {
                                repository.saveInterface5(
                                        refreshed, item.phone, bindingGeneration);
                            }
                            ExpressItem persisted = repository.findByWaybill(
                                    refreshed.waybill, "interface5");
                            if (persisted != null && (!realTimeline
                                    || !persisted.usesInterface5AccountTimeline()
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
                    String bindingGeneration = repository.bindingGeneration(
                            item.phone, "interface6");
                    ExpressQueryResult refreshed = subscription.queryWaybill(
                            context, item.waybill, item.courierCode);
                    if (hasUsableInformation(refreshed)) {
                        repository.saveInterface6(
                                refreshed, item.phone, bindingGeneration);
                        network[1]++;
                    }
                }
                ExpressItem current = repository.findByWaybill(item.waybill, bindingSource);
                if (needsProjectedCarrierRecognition(current)) {
                    try {
                        String carrierName = recognizedProjectedCarrier(
                                localApi.detect(current.projectedWaybill));
                        if (!carrierName.isEmpty() && repository.saveOrderProjectionCarrier(
                                current, bindingSource, current.projectedWaybill,
                                carrierName)) {
                            current = repository.find(current.rowId);
                        }
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw interrupted;
                    } catch (Throwable failure) {
                        // Recognition owns its normalized-waybill cooldown and paid-call memory.
                        // A carrier-label failure must not suppress the normal manual supplement.
                        Log.w(TAG, "Projected carrier recognition failed: "
                                + failure.getClass().getSimpleName());
                    }
                }
                ExpressRepository.ManualTimelinePollClaim manualClaim =
                        usesSharedManualTimeline(current)
                        && manualChainRequired(repository, current)
                                ? repository.claimManualTimelinePoll(
                                current, System.currentTimeMillis()) : null;
                if (manualClaim != null) {
                    network[0]++;
                    ExpressItem manualOwner = current;
                    ExpressRepository.ManualQueryOwnerClaim ownerClaim =
                            repository.captureManualQueryOwner(manualOwner);
                    try {
                        ManualQueryCoordinator.Batch manualBatch =
                                ManualQueryCoordinator.queryPickerFirst(
                                        () -> subscription.queryManual(
                                                context, manualOwner.displayWaybill(), null),
                                        repository.manualTimelineCandidate(
                                                manualOwner, "meizu"),
                                        () -> localApi.queryMoto(
                                                manualOwner.displayWaybill(),
                                                manualOwner.courierCode, null),
                                        ManualQueryRoutingPolicy.includesMoto(manualOwner));
                        repository.saveOwnerManualQueryBatch(
                                manualOwner, ownerClaim, manualBatch.successes,
                                manualOwner.phone, bindingSource);
                        if (!manualBatch.successes.isEmpty()) {
                            network[1]++;
                            current = repository.find(manualOwner.rowId);
                        }
                    } finally {
                        repository.releaseManualTimelinePoll(manualClaim);
                    }
                }
                if (current == null) continue;
                if (!isAccountOwned(current)
                        && !current.semantic.terminal()
                        && isLocalTimelineSource(current.source)) {
                    network[0]++;
                    ExpressItem manualOwner = current;
                    ExpressRepository.ManualQueryOwnerClaim ownerClaim =
                            repository.captureManualQueryOwner(manualOwner);
                    ManualQueryCoordinator.Batch batch =
                            ManualQueryCoordinator.queryPickerFirst(
                                    () -> subscription.queryManual(
                                            context, manualOwner.displayWaybill(), null),
                                    repository.manualTimelineCandidate(
                                            manualOwner, "meizu"),
                                    () -> localApi.queryMoto(
                                            manualOwner.displayWaybill(),
                                            manualOwner.courierCode, null),
                                    ManualQueryRoutingPolicy.includesMoto(manualOwner));
                    repository.saveManualQueryBatch(
                            manualOwner, ownerClaim, batch.successes,
                            manualOwner.phone, bindingSource);
                    if (!batch.successes.isEmpty()) network[1]++;
                }
            } catch (Throwable failure) {
                Log.w(TAG, "Express refresh failed", failure);
            }
        }
        ensureSomeSourceSucceeded(network);
    }

    /** Reuses the available Android sources before promoting a hidden manual item. */
    private static void refreshPendingManualQueries(
            Context context, ExpressRepository repository,
            ExpressDiscoveryClient discovery, ExpressSubscriptionClient subscription,
            ExpressApi localApi, String bindingSource) {
        for (PendingExpressQuery pending : repository.claimPendingManualQueries(
                System.currentTimeMillis(), bindingSource)) {
            try {
                if (repository.findByWaybill(
                        pending.waybill, pending.bindingSource) != null) {
                    repository.removePendingManual(pending.waybill, pending.bindingSource);
                    continue;
                }
                ManualQueryCoordinator.Batch batch =
                        ManualQueryCoordinator.queryPickerFirst(
                        () -> subscription.queryManual(
                                context, pending.waybill, null),
                        null,
                        () -> localApi.queryMoto(
                                pending.waybill, pending.courierCode, null),
                        true);
                repository.savePendingManualQueryBatch(pending, batch.successes);
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

    static boolean usesSharedManualTimeline(ExpressItem item) {
        return item != null && item.usesSourceManualTakeover()
                && (!item.isAccountOrder() || !item.projectedWaybill.isEmpty());
    }

    static boolean needsProjectedCarrierRecognition(ExpressItem item) {
        return item != null && item.isAccountOrder()
                && !normalizeWaybill(item.projectedWaybill).isEmpty()
                && CarrierRegistry.resolveName(item.projectedCompanyName) == null;
    }

    static String recognizedProjectedCarrier(String kuaidi100Code) {
        CarrierRegistry.Carrier carrier =
                CarrierRegistry.resolveKuaidi100Code(kuaidi100Code);
        return carrier == null ? "" : carrier.companyName;
    }

    static boolean manualChainRequired(
            ExpressRepository repository, ExpressItem item) {
        if (item == null || item.isCainiaoSource() || item.semantic.terminal()) return false;
        return !item.isJingDongSource()
                || repository == null || !repository.sourceTimelineHasStart(item);
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
