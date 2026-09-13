package me.pipi.deliveries.background;

import me.pipi.deliveries.data.TimelineSlot;
import android.content.Context;
import android.util.Log;

import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.PendingExpressQuery;
import me.pipi.deliveries.network.ExpressApi;
import me.pipi.deliveries.network.ExpressLog;
import me.pipi.deliveries.network.ExpressAccountSource;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressSubscriptionClient;
import me.pipi.deliveries.feature.express.ExpressOrderTextIdentity;
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

    static void syncAll(Context context, int[] network, boolean userPull) {
        syncAll(context, network, userPull, userPull ? "list_pull" : "background");
    }

    static void syncAll(Context context, int[] network, boolean userPull, String trigger) {
        String capturedSource = ExpressAccountSource.bindingSource(context);
        String refreshTrigger = trigger == null || trigger.isEmpty() ? userPull ? "list_pull" : "background" : trigger;
        long startedAt = System.currentTimeMillis();
        try (ExpressLog.Scope diagnostics = ExpressLog.scope(ExpressLog.newFlowId("refresh"),
                refreshTrigger, "interface5".equals(capturedSource) ? "v5" : "v6")) {
            ExpressLog.write("refresh.started", "executionBoundary", "work_manager");
            try {
                ExpressRepository repository = ExpressRepository.get(context);
                repository.runInChangeBatch(() -> syncAllUnbatched(context, repository, network, userPull, capturedSource));
                if (network[2] == 1 || "background".equals(refreshTrigger) && network[1] > 0) {
                    ExpressScheduler.recordNetworkSuccess(context, capturedSource);
                }
                ExpressLog.write("refresh.succeeded", "durationMs", System.currentTimeMillis() - startedAt,
                        "attempted", network[0], "succeeded", network[1], "failed", Math.max(0, network[0] - network[1]),
                        "result", network[0] == network[1] ? "succeeded" : "partial");
            } catch (RuntimeException | Error failure) {
                ExpressLog.write("refresh.failed", "durationMs", System.currentTimeMillis() - startedAt,
                        "attempted", network[0], "succeeded", network[1], "failed", Math.max(0, network[0] - network[1]),
                        "result", "failed", "errorCategory", failure.getClass().getSimpleName());
                throw failure;
            }
        }
    }

    private static void syncAllUnbatched(
            Context context, ExpressRepository repository, int[] network, boolean userPull, String bindingSource) {
        ExpressApi localApi = new ExpressApi(context);
        boolean useInterface5 = "interface5".equals(bindingSource);
        ExpressDiscoveryClient discovery = useInterface5
                ? new ExpressDiscoveryClient() : null;
        ExpressSubscriptionClient subscription = new ExpressSubscriptionClient();
        List<String> boundPhones = repository.phones(bindingSource);
        Map<String, String> bindingGenerations =
                repository.bindingGenerations(bindingSource);
        refreshPendingManualQueries(
                context, repository, discovery, subscription, localApi, bindingSource);
        if (!boundPhones.isEmpty()) {
            network[0]++;
            try {
                if (useInterface5) {
                    discovery.sync(context, boundPhones, userPull);
                    repository.recordAutomaticRefreshExecuted(
                            "INTERFACE5",
                            discovery.syncedWaybillsByGeneration(),
                            System.currentTimeMillis());
                } else {
                    List<ExpressQueryResult> subscriptionResults = subscription.query(context);
                    Map<String, Set<String>> seenByGeneration = new HashMap<>();
                    for (ExpressQueryResult result : subscriptionResults) {
                        String normalizedWaybill = normalizeWaybill(result.waybill);
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
                network[2] = 1;
            } catch (Throwable failure) {
                ExpressLog.write("refresh.account.failed", "errorCategory", failure.getClass().getSimpleName());
            }
        }
        java.util.ArrayList<ExpressRepository.ManualTimelinePollClaim> activeClaims = new java.util.ArrayList<>();
        try (ExpressRefreshQueue requests = new ExpressRefreshQueue()) {
        for (ExpressItem item : repository.listVisible(bindingSource)) {
            try {
                // Account-order rows use an order id, not a K100-compatible carrier waybill.
                if (useInterface5 && isInterface5Owned(item)) {
                    if (!discovery.wasSynced(item.waybill)
                            && shouldRefreshMissingAccountRow(item,
                            item.usesInterface5AccountTimeline() && !repository.hasAccountTimeline(
                                    item.waybill, "interface5"), System.currentTimeMillis(), userPull)) {
                        network[0]++;
                        String bindingGeneration = repository.bindingGeneration(
                                item.phone, "interface5");
                        ExpressQueryResult refreshed = discovery.refreshKnown(context, item);
                        if (refreshed != null
                                && !ExpressStatusNormalizer.isProviderErrorDetail(
                                refreshed.latestDetail)) {
                            boolean realTimeline = Kuaidi100TimelinePolicy
                                    .hasRealTracking(refreshed);
                            if (!repository.saveInterface5Query(refreshed, item, bindingGeneration)) continue;
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
                }
                ExpressItem current = repository.findByWaybill(item.waybill, bindingSource);
                // AGENTS §103: the account feed's own order text may already name the carrier
                // waybill ("…交付申通快递，运单号为770018906334362"). iOS reads it at parse time for
                // every order; Lite used to read it only while the list screen was open, so a
                // background sync left the order unprojected until the user looked at the list.
                ExpressOrderTextIdentity.Identity textIdentity = textProjectionIdentity(current);
                if (textIdentity != null) {
                    String owner = current.stateOwner.isEmpty()
                            ? current.source : current.stateOwner;
                    if (repository.saveOrderProjection(
                            current, ExpressAccountSource.bindingSourceForOwner(owner),
                            textIdentity.waybill, "")) {
                        current = repository.find(current.rowId);
                    }
                }
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
                if ((isInterface5Owned(current) || isInterface6Owned(current))
                        && AccountCarrierRecognition.needsRecognition(current)) {
                    // §3.1 裁决 A: the free Kuaidi100 level runs on the client for account rows
                    // the Worker's built-in-table sidecar left unresolved.
                    try {
                        ExpressItem owner = current;
                        if (AccountCarrierRecognition.recognize(repository, owner,
                                waybill -> localApi.recognizeCarrier(waybill, null))) {
                            current = repository.find(current.rowId);
                        }
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw interrupted;
                    } catch (Throwable failure) {
                        Log.w(TAG, "Account carrier recognition failed: "
                                + failure.getClass().getSimpleName());
                    }
                }
                ExpressRepository.ManualTimelinePollClaim manualClaim =
                        usesSharedManualTimeline(current, userPull)
                                ? userPull ? repository.claimForegroundManualTimelinePoll(
                                current, System.currentTimeMillis(), true)
                                : repository.claimManualTimelinePoll(current, System.currentTimeMillis()) : null;
                if (manualClaim != null) {
                    activeClaims.add(manualClaim);
                    enqueueManualRefresh(context, repository, subscription, requests, network,
                            current, bindingSource, true, manualClaim);
                }
                if (current == null) continue;
                if (!isAccountOwned(current)
                        && !current.semantic.terminal()
                        && isLocalTimelineSource(current.source)) {
                    ExpressRepository.ManualTimelinePollClaim claim = userPull
                            ? repository.claimForegroundManualTimelinePoll(current, System.currentTimeMillis(), true)
                            : repository.claimManualTimelinePoll(current, System.currentTimeMillis());
                    if (claim == null) continue;
                    activeClaims.add(claim);
                    enqueueManualRefresh(context, repository, subscription, requests, network,
                            current, bindingSource, false, claim);
                }
            } catch (Throwable failure) {
                ExpressLog.write("refresh.stage.failed", "stage", "enrichment", "errorCategory", failure.getClass().getSimpleName());
            }
        }
        requests.drain();
        } finally {
            for (ExpressRepository.ManualTimelinePollClaim claim : activeClaims) repository.releaseManualTimelinePoll(claim);
        }
        ensureSomeSourceSucceeded(network);
    }

    private static void enqueueManualRefresh(Context context, ExpressRepository repository,
            ExpressSubscriptionClient subscription, ExpressRefreshQueue requests, int[] network,
            ExpressItem owner, String bindingSource, boolean automatic,
            ExpressRepository.ManualTimelinePollClaim claim) {
        ExpressRepository.ManualQueryOwnerClaim ownerClaim = repository.captureManualQueryOwner(owner);
        if (ownerClaim == null) return;
        var cached = repository.manualTimelineCandidate(owner, TimelineSlot.V6_QUERY);
        network[0]++;
        requests.submit(() -> {
            try {
                ManualQueryCoordinator.Batch batch = ManualQueryCoordinator.queryOnlineFirst(
                        () -> subscription.queryManual(context, owner.displayWaybill(), null),
                        cached, null, false, null, null, owner.semantic == StatusSemantic.UNKNOWN);
                return () -> {
                    repository.saveClaimedManualQueryBatch(owner, ownerClaim, batch.successes,
                            owner.phone, bindingSource, automatic, claim, null);
                    if (!batch.successes.isEmpty()) network[1]++;
                };
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw interrupted;
            } catch (Exception failure) {
                return () -> ExpressLog.write("refresh.stage.failed", "stage", "manual_refresh",
                        "requestProvider", TimelineSlot.V6_QUERY, "waybillTail", ExpressLog.tail(owner.displayWaybill()),
                        "errorCategory", failure.getClass().getSimpleName());
            }
        });
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
                        ManualQueryCoordinator.queryOnlineFirst(
                        () -> subscription.queryManual(
                                context, pending.waybill, null),
                        null,
                        null, false);
                repository.savePendingManualQueryBatch(pending, batch.successes);
            } catch (Throwable failure) {
                // Keep the claimed item hidden. Its next periodic attempt is rate-limited.
                ExpressLog.write("manual.query.failed", "stage", "pending_manual", "errorCategory", failure.getClass().getSimpleName());
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

    static boolean usesSharedManualTimeline(ExpressItem item, boolean userPull) {
        return !(isInterface5Owned(item)
                && (item.isCainiaoSource() || item.isJingDongSource()))
                && ExpressRepository.automaticListQueryRequired(item);
    }

    /**
     * A named waybill resolves identity independently of status, H5 and history completeness.
     */
    static ExpressOrderTextIdentity.Identity textProjectionIdentity(ExpressItem current) {
        if (current == null || !current.isAccountOrder()
                || !"interface5".equals(ExpressAccountSource.bindingSourceForOwner(
                        current.stateOwner.isEmpty() ? current.source : current.stateOwner))
                || !current.projectedWaybill.isEmpty()) {
            return null;
        }
        return ExpressOrderTextIdentity.fromTracksJson(current.tracksJson, current.waybill);
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

    private static boolean isInterface6Owned(ExpressItem item) {
        return item != null && ("INTERFACE6".equalsIgnoreCase(item.source)
                || "INTERFACE6".equalsIgnoreCase(item.stateOwner));
    }

    private static String normalizeWaybill(String value) {
        return value == null ? "" : value.trim().toUpperCase(Locale.ROOT)
                .replaceAll("[^A-Z0-9]", "");
    }

    static boolean shouldRefreshMissingAccountRow(
            ExpressItem item, boolean accountTimelineMissing, long now, boolean userPull) {
        if (isInterface6Owned(item) || isInterface5Owned(item)
                && (item.isCainiaoSource() || item.isJingDongSource() || item.isShunFengSource())) return false;
        if (item.semantic == StatusSemantic.COMPLETED) {
            return Kuaidi100TimelinePolicy.shouldRefresh(item, null, now);
        }
        return !item.semantic.terminal() || accountTimelineMissing;
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
