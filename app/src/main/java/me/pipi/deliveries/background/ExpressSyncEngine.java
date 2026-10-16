package me.pipi.deliveries.background;

import me.pipi.deliveries.data.TimelineSlot;
import android.content.Context;
import android.util.Log;

import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.model.CarrierNormalization;
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
            java.util.concurrent.atomic.AtomicReference<Throwable> sourceFailure =
                    new java.util.concurrent.atomic.AtomicReference<>();
            try {
                ExpressRepository repository = ExpressRepository.get(context);
                repository.runInChangeBatch(() -> syncAllUnbatched(
                        context, repository, network, userPull, capturedSource, sourceFailure));
                if (network[2] == 1 || "background".equals(refreshTrigger) && network[1] > 0) {
                    ExpressScheduler.recordNetworkSuccess(context, capturedSource);
                }
                ExpressLog.write("refresh.succeeded", "durationMs", System.currentTimeMillis() - startedAt,
                        "attempted", network[0], "succeeded", network[1], "failed", Math.max(0, network[0] - network[1]),
                        "result", network[0] == network[1] ? "succeeded" : "partial");
            } catch (RuntimeException | Error failure) {
                // 用户 2026-09-28：every source failing reports the first source's own failure, not the
                // round's synthetic "All delivery sources failed".
                ExpressLog.error("refresh.failed", ExpressLog.errorDetails(
                        failure instanceof AllSourcesFailed && sourceFailure.get() != null
                                ? sourceFailure.get() : failure,
                        "durationMs", System.currentTimeMillis() - startedAt,
                        "attempted", network[0], "succeeded", network[1], "failed", Math.max(0, network[0] - network[1]),
                        "result", "failed"));
                throw failure;
            }
        }
    }

    /** The round's own failure when no source succeeded; its message and type are unchanged for callers. */
    static final class AllSourcesFailed extends IllegalStateException {
        AllSourcesFailed() {
            super("All delivery sources failed");
        }
    }

    private static void syncAllUnbatched(
            Context context, ExpressRepository repository, int[] network, boolean userPull, String bindingSource,
            java.util.concurrent.atomic.AtomicReference<Throwable> sourceFailure) {
        ExpressApi localApi = new ExpressApi(context);
        boolean useInterface5 = "interface5".equals(bindingSource);
        ExpressDiscoveryClient discovery = useInterface5
                ? new ExpressDiscoveryClient() : null;
        ExpressSubscriptionClient subscription = new ExpressSubscriptionClient();
        List<String> boundPhones = repository.phones(bindingSource);
        Map<String, String> bindingGenerations =
                repository.bindingGenerations(bindingSource);
        // 用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒。这一轮所有落库前 / 补识别的调用（新件落库前的识别、订单投影前的
        // 识别、账号行与手动件的补识别）共用这一份，只计等识别的时间；用光后剩下的运单这一轮照 T23 压着，下一轮再识别。
        AccountCarrierRecognition.Budget recognitionBudget = new AccountCarrierRecognition.Budget();
        // 用户 2026-09-27 第二轮清单：截断排后。上一轮被预算截断的运单这一轮排到后面（请求自身超时的同样算被取消的一类，
        // 不计失败：用户 2026-09-27 提交前核对答复四），其余照列表顺序；每一行自己的步骤
        // 不变。整行一起排后、没发请求的在前、到点被取消的最后：截断排后细则，用户 2026-09-27 提交前核对答「这样做」。
        CarrierRecognitionDeferrals deferrals = CarrierRecognitionDeferrals.get(context);
        // 代码 5（用户 2026-10-03「照 Pipi / iOS 的做法改」，其余裁决 28）：账号列表里会新建一行的记录先识别承运商再落库、上列表。
        NewRowCarrierRecognition newRows =
                new NewRowCarrierRecognition(repository, localApi, recognitionBudget, deferrals);
        refreshPendingManualQueries(
                context, repository, discovery, subscription, localApi, bindingSource);
        if (!boundPhones.isEmpty()) {
            network[0]++;
            long accountStartedAt = System.currentTimeMillis();
            try {
                if (useInterface5) {
                    discovery.recognizeNewRecordsWith(new ExpressDiscoveryClient.NewRecordCarriers() {
                        @Override public boolean recognizedFirst(ExpressQueryResult record) {
                            return newRows.recognizedFirst(record, "interface5");
                        }

                        @Override public Map<String, CarrierNormalization> recognize(
                                List<ExpressQueryResult> records) throws InterruptedException {
                            return newRows.recognize(records, "interface5");
                        }
                    });
                    try {
                        discovery.sync(context, boundPhones, userPull);
                    } finally {
                        newRows.rememberAnchors(bindingSource);
                    }
                    repository.recordAutomaticRefreshExecuted(
                            "INTERFACE5",
                            discovery.syncedWaybillsByGeneration(),
                            System.currentTimeMillis());
                } else {
                    List<ExpressQueryResult> subscriptionResults = subscription.query(context);
                    Map<String, Set<String>> seenByGeneration = new HashMap<>();
                    // 代码 5: a record that adds a new row with a carrier to recognise waits until the rest of the list
                    // is stored; its carrier is then recognised and it is stored with it, in list order.
                    java.util.ArrayList<ExpressQueryResult> held = new java.util.ArrayList<>();
                    for (ExpressQueryResult result : subscriptionResults) {
                        String normalizedWaybill = normalizeWaybill(result.waybill);
                        String boundPhone = interface6BoundPhone(
                                repository, result, bindingSource, boundPhones, bindingGenerations);
                        if (boundPhone.isEmpty()) continue;
                        String generation = bindingGenerations.get(
                                boundPhone.replaceAll("\\D", ""));
                        seenByGeneration
                                .computeIfAbsent(generation, ignored -> new HashSet<>())
                                .add(normalizedWaybill);
                        if (newRows.recognizedFirst(result, bindingSource)) {
                            held.add(result);
                            continue;
                        }
                        repository.saveInterface6(result.withPhone(boundPhone), boundPhone, generation);
                    }
                    if (!held.isEmpty()) {
                        Map<String, CarrierNormalization> recognized = newRows.recognize(held, bindingSource);
                        for (ExpressQueryResult result : held) {
                            String boundPhone = interface6BoundPhone(
                                    repository, result, bindingSource, boundPhones, bindingGenerations);
                            if (boundPhone.isEmpty()) continue;
                            repository.saveInterface6(NewRowCarrierRecognition.withRecognized(result, recognized)
                                            .withPhone(boundPhone),
                                    boundPhone, bindingGenerations.get(boundPhone.replaceAll("\\D", "")));
                        }
                        newRows.rememberAnchors(bindingSource);
                    }
                    repository.recordAutomaticRefreshExecuted(
                            "INTERFACE6",
                            seenByGeneration, System.currentTimeMillis());
                }
                network[1]++;
                network[2] = 1;
            } catch (Throwable failure) {
                sourceFailure.compareAndSet(null, failure);
                ExpressLog.error("refresh.account.failed", ExpressLog.errorDetails(failure,
                        "durationMs", System.currentTimeMillis() - accountStartedAt));
            }
        }
        java.util.ArrayList<ExpressRepository.ManualTimelinePollClaim> activeClaims = new java.util.ArrayList<>();
        // 用户 2026-10-02「头条 状态 详情页 都推进到了签收状态…就冻结快递 后续不再进行任何刷新」，弹窗「只停本机发起的请求」：
        // read once the account list above has landed; the rows' per-parcel query and Picker below stop for these,
        // while their recognition and order projection (identity) go on. A failed read freezes nothing this round.
        Set<Long> signedFrozen;
        try {
            signedFrozen = repository.signedFrozenRows(bindingSource);
        } catch (RuntimeException failure) {
            Log.w(TAG, "Signed freeze read failed: " + failure.getClass().getSimpleName());
            signedFrozen = new HashSet<>();
        }
        try (ExpressRefreshQueue requests = new ExpressRefreshQueue()) {
        for (ExpressItem item : recognitionOrder(
                repository, deferrals, repository.listVisibleAsStored(bindingSource))) {
            try {
                // Account-order rows use an order id, not a K100-compatible carrier waybill.
                if (useInterface5 && isInterface5Owned(item)) {
                    if (!discovery.wasSynced(item.waybill)
                            && shouldRefreshMissingAccountRow(item,
                            item.usesInterface5AccountTimeline() && !repository.hasAccountTimeline(
                                    item, item.waybill, "interface5"), System.currentTimeMillis(), userPull)
                            && !skippedSignedFrozen(signedFrozen, item, "v5", TimelineSlot.V5_QUERY)) {
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
                                    persisted, refreshed.waybill, "interface5"))) {
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
                // 只取运单号（用户 2026-09-26，其余裁决 7）；T23（其余裁决 28）：先识别承运商，对上才投影，
                // 对不上这一票保持原样、不推送，下一轮再补识别。已存的 v5_query 文案与暂存的京粉页运单号同样在这里补。
                ExpressRepository.PendingProjection pending = repository.pendingProjection(current);
                if (pending != null) {
                    try {
                        ExpressItem order = current;
                        // 优化 5: the paid level carries the row's own reuse anchor.
                        ExpressApi parcel = localApi.forParcel(AccountCarrierRecognition.parcelAnchor(repository, order));
                        if (AccountCarrierRecognition.projectPending(repository, order, pending,
                                deferrals.tracking(AccountCarrierRecognition.bounded(recognitionBudget,
                                        waybill -> parcel.recognizeCarrierInSyncRound(waybill,
                                                AccountCarrierRecognition.excludesJd(order, waybill)))),
                                null)) {
                            current = repository.find(current.rowId);
                        }
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw interrupted;
                    }
                }
                if ((isInterface5Owned(current) || isInterface6Owned(current)
                        || current != null && current.manuallyAdded)
                        && AccountCarrierRecognition.needsRecognition(current)
                        // 代码 5: a new row this round already asked for before it was stored waits for the next round.
                        && !newRows.asked(current.displayWaybill())) {
                    // §3.1 裁决 A: the free Kuaidi100 level runs on the client for account rows
                    // the Worker's built-in-table sidecar left unresolved; T23 entry G adds manual
                    // rows whose carrier is still unmatched.
                    try {
                        ExpressItem owner = current;
                        // 优化 5: the paid level carries the row's own reuse anchor.
                        ExpressApi parcel = localApi.forParcel(AccountCarrierRecognition.parcelAnchor(repository, owner));
                        if (AccountCarrierRecognition.recognize(repository, owner,
                                deferrals.tracking(AccountCarrierRecognition.bounded(recognitionBudget,
                                        waybill -> parcel.recognizeCarrierInSyncRound(waybill,
                                                AccountCarrierRecognition.excludesJd(owner, waybill)))))) {
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
                                && !pickerSignedFrozen(repository, signedFrozen, current)
                                ? claimListManualTimelinePoll(repository, current,
                                        System.currentTimeMillis(), userPull) : null;
                if (manualClaim != null) {
                    activeClaims.add(manualClaim);
                    enqueueManualRefresh(context, repository, subscription, requests, network,
                            current, bindingSource, true, manualClaim, sourceFailure);
                }
                if (current == null) continue;
                if (!isAccountOwned(current)
                        && isLocalTimelineSource(current.source)
                        && !pickerSignedFrozen(repository, signedFrozen, current)) {
                    ExpressRepository.ManualTimelinePollClaim claim = claimListManualTimelinePoll(
                            repository, current, System.currentTimeMillis(), userPull);
                    if (claim == null) continue;
                    activeClaims.add(claim);
                    enqueueManualRefresh(context, repository, subscription, requests, network,
                            current, bindingSource, false, claim, sourceFailure);
                }
            } catch (Throwable failure) {
                sourceFailure.compareAndSet(null, failure);
                ExpressLog.write("refresh.stage.failed", ExpressLog.errorDetails(failure, "stage", "enrichment"));
            }
        }
        requests.drain();
        } finally {
            for (ExpressRepository.ManualTimelinePollClaim claim : activeClaims) repository.releaseManualTimelinePoll(claim);
        }
        ensureSomeSourceSucceeded(network);
    }

    /**
     * 用户 2026-09-27 第二轮清单：截断排后。The round's rows with those whose waybill the previous budget
     * truncated moved after the rest (see {@link CarrierRecognitionDeferrals}); a mark left on a waybill no
     * row needs to recognise any more (recognised on another screen, or given a table carrier) is dropped.
     */
    static List<ExpressItem> recognitionOrder(ExpressRepository repository,
            CarrierRecognitionDeferrals deferrals, List<ExpressItem> rows) {
        Map<ExpressItem, String> waybills = new java.util.IdentityHashMap<>();
        Set<String> needed = new HashSet<>();
        for (ExpressItem row : rows) {
            String waybill = recognitionWaybill(repository, row);
            waybills.put(row, waybill);
            if (!waybill.isEmpty()) needed.add(normalizeWaybill(waybill));
        }
        for (ExpressItem row : rows) {
            if (row == null || !waybills.get(row).isEmpty()) continue;
            String shown = row.displayWaybill();
            if (!needed.contains(normalizeWaybill(shown))) deferrals.clear(shown);
        }
        return deferrals.recognitionLast(rows, waybills::get);
    }

    /** The waybill this round would recognise for {@code row}, as the loop below decides it; "" for none. */
    private static String recognitionWaybill(ExpressRepository repository, ExpressItem row) {
        if (row == null) return "";
        ExpressRepository.PendingProjection pending = repository.pendingProjection(row);
        if (pending != null) return pending.waybill;
        return (isInterface5Owned(row) || isInterface6Owned(row) || row.manuallyAdded)
                && AccountCarrierRecognition.needsRecognition(row) ? row.displayWaybill() : "";
    }

    private static void enqueueManualRefresh(Context context, ExpressRepository repository,
            ExpressSubscriptionClient subscription, ExpressRefreshQueue requests, int[] network,
            ExpressItem owner, String bindingSource, boolean automatic,
            ExpressRepository.ManualTimelinePollClaim claim,
            java.util.concurrent.atomic.AtomicReference<Throwable> sourceFailure) {
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
                return () -> {
                    sourceFailure.compareAndSet(null, failure);
                    ExpressLog.write("refresh.stage.failed", ExpressLog.errorDetails(failure, "stage", "manual_refresh",
                            "requestProvider", TimelineSlot.V6_QUERY, "waybillTail", ExpressLog.tail(owner.displayWaybill())));
                };
            }
        });
    }

    /**
     * Whether {@code row} is one of the round's signed-frozen rows ({@link ExpressRepository#signedFrozenRows}); its
     * request at {@code level} is then not made and a skip with {@link ExpressRepository#SIGNED_FROZEN} is logged.
     */
    static boolean skippedSignedFrozen(Set<Long> signedFrozen, ExpressItem row, String iface, String level) {
        if (row == null || signedFrozen == null || !signedFrozen.contains(row.rowId)) return false;
        ExpressLog.line(iface, level, ExpressLog.source(row.sourceProvider, row.manuallyAdded), "skipped",
                "tail", ExpressLog.tail(row.displayWaybill()), "reason", ExpressRepository.SIGNED_FROZEN);
        return true;
    }

    /**
     * The Picker poll of a signed-frozen row is not claimed. The skip is logged only where the signed freeze of
     * 2026-09-04 ({@link ExpressRepository#backgroundTimelineRefreshAllowed}) would have let the poll through, so the
     * rows that freeze already holds stay as quiet as before.
     */
    static boolean pickerSignedFrozen(ExpressRepository repository, Set<Long> signedFrozen, ExpressItem row) {
        if (row == null || signedFrozen == null || !signedFrozen.contains(row.rowId)) return false;
        if (ExpressRepository.backgroundTimelineRefreshAllowed(row, repository.manualTimelineAuthority(row),
                System.currentTimeMillis())) {
            skippedSignedFrozen(signedFrozen, row, "", TimelineSlot.V6_QUERY);
        }
        return true;
    }

    /** A Home pull bypasses cadence, but only explicit detail may reopen trusted signed history. */
    static ExpressRepository.ManualTimelinePollClaim claimListManualTimelinePoll(
            ExpressRepository repository, ExpressItem owner, long now, boolean userPull) {
        if (!ExpressRepository.backgroundTimelineRefreshAllowed(owner,
                repository.manualTimelineAuthority(owner), now)) return null;
        return userPull ? repository.claimForegroundManualTimelinePoll(owner, now, true)
                : repository.claimManualTimelinePoll(owner, now);
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
                ExpressLog.error("manual.query.failed", ExpressLog.errorDetails(failure, "stage", "pending_manual"));
            }
        }
    }

    private static void ensureSomeSourceSucceeded(int[] network) {
        if (network[0] > 0 && network[1] == 0) {
            throw new AllSourcesFailed();
        }
    }

    static boolean isLocalTimelineSource(String source) {
        return "KD-100".equalsIgnoreCase(source)
                || "I5-K100".equalsIgnoreCase(source)
                || "V4".equalsIgnoreCase(source);
    }

    static boolean isAccountOwned(ExpressItem item) {
        return isInterface5Owned(item) || isInterface6Owned(item);
    }

    static boolean isInterface5Owned(ExpressItem item) {
        return item != null && ("INTERFACE5".equalsIgnoreCase(item.source)
                || "INTERFACE5".equalsIgnoreCase(item.stateOwner)
                || item.isAccountOrder());
    }

    static boolean usesSharedManualTimeline(ExpressItem item, boolean userPull) {
        return !(isInterface5Owned(item)
                && (item.isCainiaoSource() || item.isJingDongSource()))
                && ExpressRepository.automaticListQueryRequired(item);
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

    /**
     * The bound phone an interface 6 record of the list is stored under, or "" when it is not stored (no usable
     * information, no bound phone or binding generation for it, or an unbound association suppresses it).
     */
    private static String interface6BoundPhone(ExpressRepository repository, ExpressQueryResult result,
            String bindingSource, List<String> boundPhones, Map<String, String> bindingGenerations) {
        if (!hasUsableInformation(result)) return "";
        String association = result.phone.isEmpty()
                ? repository.associatedPhone(result.waybill, bindingSource)
                : result.phone;
        String receiver = matchedBoundPhone(association, boundPhones);
        String sender = matchedBoundPhone(result.senderPhone, boundPhones);
        if (!receiver.isEmpty() && !sender.isEmpty() && !receiver.equals(sender)) return "";
        String boundPhone = receiver.isEmpty() ? sender : receiver;
        boolean suppressed = repository.hasUnboundPhoneAssociation(
                result.waybill, bindingSource);
        if (boundPhone.isEmpty() && association.isEmpty() && normalizePhone(result.senderPhone).length() < 4
                && boundPhones.size() == 1 && !suppressed) {
            boundPhone = boundPhones.get(0);
        }
        if (ExpressRepository.shouldSuppressAutomaticImport(
                suppressed, boundPhone) || boundPhone.isEmpty()) return "";
        String generation = bindingGenerations.get(boundPhone.replaceAll("\\D", ""));
        return generation == null || generation.isEmpty() ? "" : boundPhone;
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
