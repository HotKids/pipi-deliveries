package me.pipi.deliveries.network;

import android.content.Context;
import android.content.SharedPreferences;

import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.model.CarrierNormalization;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.IdentityHashMap;
import java.util.AbstractMap;
import java.util.Comparator;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;

/** One durable two-level carrier-recognition attempt for non-sync waybills. */
final class CarrierRecognitionCoordinator {
    static final long RETRY_DELAY_MS = 15L * 60L * 1000L;
    /** Matches the gateway's own terminal self-heal window. */
    static final long TERMINAL_TTL_MS = 24L * 60L * 60L * 1000L;
    static final int MAX_NETWORK_FAILURES = 3;
    static final int MAX_TRANSIENT_ENTRIES = 256;
    private static final String PREFS = "carrier_recognition_v1";
    // Two recognition levels retain HttpClient's 15-second connect + 25-second read budgets.
    private static final long SHARED_REQUEST_BUDGET_MS = 2L * (15_000L + 25_000L);
    private static final ExecutorService RECOGNITION_WORKERS = Executors.newFixedThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "express-carrier-recognition");
        thread.setDaemon(true);
        return thread;
    });
    /** Test seam: a shorter shared-request budget; 0 uses {@link #SHARED_REQUEST_BUDGET_MS}. */
    static volatile long sharedRequestBudgetOverrideMillis;
    private static final Map<Object, Map<String, Pending>> IN_FLIGHT =
            new IdentityHashMap<>();

    private static final class Pending {
        final ExpressQueryCancellation cancellation = new ExpressQueryCancellation(sharedRequestBudgetMillis());
        FutureTask<Outcome> task;
        int consumers;
        /** The waiting consumers that are sync rounds (用户 2026-09-27 提交前核对答复四). */
        int roundConsumers;
    }

    private static long sharedRequestBudgetMillis() {
        long override = sharedRequestBudgetOverrideMillis;
        return override > 0L ? override : SHARED_REQUEST_BUDGET_MS;
    }

    interface Clock {
        long now();
    }

    interface State {
        Snapshot load(String identity);
        void save(String identity, Snapshot snapshot);
        default Object coordinationKey() { return this; }
    }

    static final class Snapshot {
        final CarrierNormalization success;
        final int networkFailures;
        final long retryAt;
        final boolean terminal;
        /**
         * 其余裁决 29（用户 2026-09-26）：免费识别给出、内置表换不出标准码的承运商（快递100 的名字与码），付费级也没有
         * 内置结果时只作显示。iOS carrier-recognition.ts 把免费级候选留在 terminal / classify-stage retry 里同样用。
         */
        final CarrierNormalization offTable;

        Snapshot(
                CarrierNormalization success, int networkFailures,
                long retryAt, boolean terminal) {
            this(success, networkFailures, retryAt, terminal, CarrierNormalization.NONE);
        }

        Snapshot(
                CarrierNormalization success, int networkFailures,
                long retryAt, boolean terminal, CarrierNormalization offTable) {
            this.success = success == null ? CarrierNormalization.NONE : success;
            this.networkFailures = Math.max(0, networkFailures);
            this.retryAt = Math.max(0L, retryAt);
            this.terminal = terminal;
            this.offTable = offTable == null || offTable.offTableName().isEmpty()
                    ? CarrierNormalization.NONE : offTable;
        }

        static Snapshot empty() {
            return new Snapshot(CarrierNormalization.NONE, 0, 0L, false);
        }
    }

    static final class Outcome {
        final List<CarrierNormalization> candidates;
        final boolean deferred;
        final boolean terminal;
        /** The off-table carrier shown for display when no built-in candidate exists; NONE otherwise. */
        final CarrierNormalization offTable;

        Outcome(List<CarrierNormalization> candidates, boolean deferred, boolean terminal) {
            this(candidates, deferred, terminal, CarrierNormalization.NONE);
        }

        Outcome(List<CarrierNormalization> candidates, boolean deferred, boolean terminal,
                CarrierNormalization offTable) {
            this.candidates = candidates == null
                    ? Collections.emptyList() : Collections.unmodifiableList(candidates);
            this.deferred = deferred;
            this.terminal = terminal;
            this.offTable = this.candidates.isEmpty() && offTable != null
                    && !offTable.offTableName().isEmpty() ? offTable : CarrierNormalization.NONE;
        }
    }

    private final Kuaidi100CarrierDetector publicDetector;
    private final ExpressGatewayTransport gateway;
    private final State state;
    private final Clock clock;

    static CarrierRecognitionCoordinator create(Context context) {
        Context app = context.getApplicationContext();
        if (app == null) app = context;
        return new CarrierRecognitionCoordinator(
                new Kuaidi100CarrierDetector(), new ExpressGatewayClient(app),
                new PreferencesState(app.getSharedPreferences(PREFS, 0)),
                System::currentTimeMillis);
    }

    /**
     * Removes the number's durable recognition record (success, failures, cooldown, terminal, off-table name). The
     * recognition deferral mark ({@code background.CarrierRecognitionDeferrals}) stays: it only orders a round
     * (coordinator 2026-10-02, the same as Pipi).
     */
    static void forget(Context context, String waybill) {
        String identity = identity(waybill);
        if (identity.isEmpty()) return;
        Context app = context.getApplicationContext();
        if (app == null) app = context;
        SharedPreferences preferences = app.getSharedPreferences(PREFS, 0);
        synchronized (preferences) {
            preferences.edit().remove(identity).apply();
        }
    }

    static State transientState() {
        return new State() {
            private final Map<String, Snapshot> values = Collections.synchronizedMap(new HashMap<>());

            @Override public Snapshot load(String identity) {
                return values.getOrDefault(identity, Snapshot.empty());
            }

            @Override public void save(String identity, Snapshot snapshot) {
                values.put(identity, snapshot);
            }
        };
    }

    CarrierRecognitionCoordinator(
            Kuaidi100CarrierDetector publicDetector, ExpressGatewayTransport gateway,
            State state, Clock clock) {
        this.publicDetector = publicDetector;
        this.gateway = gateway;
        this.state = state;
        this.clock = clock;
    }

    Outcome recognize(String waybill, ExpressQueryCancellation cancellation) throws Exception {
        return recognize(waybill, cancellation, false);
    }

    /**
     * {@code excludeJd}: R-20 — on a JD-platform row whose waybill does not start with JD, 京东 is never
     * carrier evidence, so a JD candidate is skipped for the next one and for the paid level, and a
     * cached JD answer is not reused (T23 gap ②, user 2026-09-26: it used to be cached as a success,
     * rejected every round and never reached the paid level or a terminal verdict).
     */
    Outcome recognize(String waybill, ExpressQueryCancellation cancellation, boolean excludeJd)
            throws Exception {
        return recognize(waybill, cancellation, excludeJd, false);
    }

    /**
     * {@code syncRound}: the caller is a sync round. A time limit of the request's own — a connect or read timeout, or
     * {@link #SHARED_REQUEST_BUDGET_MS} — records nothing for the waybill, no failure, no cooldown and no terminal
     * verdict: in a sync round (用户 2026-09-27 提交前核对答复四，「四端对齐 iOS」) and outside one (用户 2026-09-27
     * 提交前核对答复五，「四端都不算失败（对齐 iOS）」). While a sync round waits for the shared request, every caller
     * waiting then is told so with {@link CarrierRecognitionTimeoutException} and the round marks the waybill cut off;
     * with no round waiting, the callers see the network failure they saw before and nothing is marked. Whether a round
     * waits is read at the moment the time limit ends the request, since a request is shared per waybill.
     */
    Outcome recognize(String waybill, ExpressQueryCancellation cancellation, boolean excludeJd,
            boolean syncRound) throws Exception {
        return recognize(waybill, cancellation, excludeJd, syncRound, 0L);
    }

    /**
     * {@code parcelAnchorAtMs}: 优化 5 — the asking parcel's reuse anchor, sent with the paid classify request when it is
     * valid. Callers of one waybill share one request; it carries the anchor of the caller that started it.
     */
    Outcome recognize(String waybill, ExpressQueryCancellation cancellation, boolean excludeJd,
            boolean syncRound, long parcelAnchorAtMs) throws Exception {
        String number = clean(waybill);
        String identity = identity(number);
        if (number.length() < 6 || identity.isEmpty()) {
            return new Outcome(Collections.emptyList(), false, true);
        }
        if (cancellation != null) cancellation.throwIfCancelled();
        Object scope = state.coordinationKey();
        String pendingKey = excludeJd ? identity + "#nojd" : identity;
        Pending work;
        boolean owner;
        synchronized (IN_FLIGHT) {
            Map<String, Pending> pending = IN_FLIGHT.computeIfAbsent(scope, key -> new HashMap<>());
            work = pending.get(pendingKey);
            owner = work == null;
            if (owner) {
                Pending created = new Pending();
                created.task = new FutureTask<>(ExpressLog.withCurrentScope(() -> {
                    try {
                        return recognizeOwned(number, identity, created.cancellation, excludeJd,
                                () -> roundWaiting(created), parcelAnchorAtMs);
                    } finally {
                        removePending(scope, pendingKey, created);
                        created.cancellation.close();
                    }
                }));
                pending.put(pendingKey, created);
                work = created;
            }
            work.consumers++;
            if (syncRound) work.roundConsumers++;
        }
        Pending observed = work;
        AtomicBoolean detached = new AtomicBoolean();
        Runnable leave = () -> releaseConsumer(scope, pendingKey, observed, detached, syncRound);
        try {
            if (cancellation != null) cancellation.attach(leave);
            if (owner) RECOGNITION_WORKERS.execute(work.task);
            while (true) {
                if (cancellation != null) cancellation.throwIfCancelled();
                try {
                    Outcome result = work.task.get(cancellation == null ? 100L
                            : cancellation.remainingTimeoutMillis(100), TimeUnit.MILLISECONDS);
                    if (cancellation != null) cancellation.throwIfCancelled();
                    return result;
                } catch (TimeoutException waiting) {
                    // Consumers keep independent deadlines; the final one leaving cancels transport.
                } catch (CancellationException cancelled) {
                    throw new InterruptedException("Carrier recognition cancelled");
                } catch (ExecutionException failed) {
                    if (cancellation != null) cancellation.throwIfCancelled();
                    Throwable cause = failed.getCause();
                    // 用户 2026-09-27 提交前核对答复四: the shared request's own budget ended it while this round
                    // waited (no consumer cancels it while one waits); the round is told it timed out, not interrupted.
                    if (syncRound && cause instanceof InterruptedException
                            && work.cancellation.isCancelled()) {
                        throw new CarrierRecognitionTimeoutException();
                    }
                    if (cause instanceof Exception) throw (Exception) cause;
                    if (cause instanceof Error) throw (Error) cause;
                    throw new IllegalStateException(cause);
                }
            }
        } finally {
            if (cancellation != null) cancellation.detach(leave);
            leave.run();
        }
    }

    private static void releaseConsumer(Object scope, String identity, Pending work, AtomicBoolean detached,
            boolean syncRound) {
        if (!detached.compareAndSet(false, true)) return;
        synchronized (IN_FLIGHT) {
            if (syncRound) work.roundConsumers--;
            if (--work.consumers != 0 || work.task.isDone()) return;
            // Fence old cache writes before a replacement can claim the same identity.
            work.cancellation.cancel();
            work.task.cancel(true);
            removePending(scope, identity, work);
        }
    }

    private static boolean roundWaiting(Pending work) {
        synchronized (IN_FLIGHT) {
            return work.roundConsumers > 0;
        }
    }

    /** A connect or read timeout of the request itself, however the transport wrapped it. */
    private static boolean requestTimedOut(Throwable failure) {
        Throwable cause = failure;
        for (int depth = 0; cause != null && depth < 8; depth++, cause = cause.getCause()) {
            if (cause instanceof java.net.SocketTimeoutException) return true;
        }
        return false;
    }

    private static void removePending(Object scope, String identity, Pending expected) {
        synchronized (IN_FLIGHT) {
            Map<String, Pending> pending = IN_FLIGHT.get(scope);
            if (pending == null || pending.get(identity) != expected) return;
            pending.remove(identity);
            if (pending.isEmpty()) IN_FLIGHT.remove(scope);
        }
    }

    private Outcome recognizeOwned(String number, String identity,
            ExpressQueryCancellation cancellation, boolean excludeJd, BooleanSupplier roundWaiting,
            long parcelAnchorAtMs) throws Exception {
        cancellation.throwIfCancelled();
        Snapshot previous = state.load(identity);
        CarrierNormalization healed = currentNormalization(previous.success);
        if (healed != null && !(excludeJd && isJd(healed))) {
            saveIfActive(identity, new Snapshot(healed, 0, 0L, false), cancellation);
            return new Outcome(Collections.singletonList(healed), false, false);
        }
        if (previous.success.present()) previous = Snapshot.empty();
        long now = clock.now();
        // A terminal verdict states what the upstream knew at one moment, not a permanent fact.
        // The gateway's own terminal record self-heals on this schedule; a terminal snapshot now
        // carries its expiry in the same retryAt field a retry uses, so the client stops
        // outliving the server it asks.
        if (previous.terminal && previous.retryAt > now) {
            return new Outcome(Collections.emptyList(), false, true, previous.offTable);
        }
        if (previous.terminal) previous = Snapshot.empty();
        if (previous.retryAt > now) {
            return new Outcome(Collections.emptyList(), true, false, previous.offTable);
        }

        final List<Kuaidi100CarrierDetector.Candidate> publicCandidates;
        try {
            publicCandidates = publicDetector.detectNamedCandidates(number, cancellation);
        } catch (InterruptedException interrupted) {
            throw interrupted;
        } catch (Exception networkFailure) {
            // The request's own timeout is no failure: in a sync round (用户 2026-09-27 提交前核对答复四), which is told
            // so to mark it cut off, and outside one (用户 2026-09-27 提交前核对答复五).
            if (requestTimedOut(networkFailure)) {
                if (roundWaiting.getAsBoolean()) throw new CarrierRecognitionTimeoutException();
                throw networkFailure;
            }
            recordNetworkFailure(identity, previous, now, cancellation, CarrierNormalization.NONE);
            throw networkFailure;
        }

        ArrayList<CarrierNormalization> recognized = new ArrayList<>();
        CarrierNormalization offTable = CarrierNormalization.NONE;
        for (Kuaidi100CarrierDetector.Candidate candidate : publicCandidates) {
            CarrierRegistry.Carrier carrier = CarrierRegistry.resolveKuaidi100Code(candidate.code);
            if (carrier == null) {
                // 其余裁决 29: the first named candidate the table cannot place is the display name.
                if (offTable.offTableName().isEmpty() && !candidate.name.isEmpty()
                        && !"快递".equals(candidate.name)) {
                    offTable = CarrierNormalization.offTable(candidate.name, candidate.code);
                }
                continue;
            }
            CarrierNormalization local = localNormalization(carrier);
            if (excludeJd && isJd(local)) continue;
            recognized.add(local);
        }
        if (!recognized.isEmpty()) {
            saveIfActive(identity, new Snapshot(recognized.get(0), 0, 0L, false), cancellation);
            return new Outcome(recognized, false, false);
        }

        try {
            CarrierNormalization fallback = classifySecondLevel(
                    number, cancellation, excludeJd, parcelAnchorAtMs);
            CarrierNormalization resolved = currentNormalization(fallback);
            if (resolved != null && !(excludeJd && isJd(resolved))) {
                saveIfActive(identity, new Snapshot(resolved, 0, 0L, false), cancellation);
                return new Outcome(Collections.singletonList(resolved), false, false);
            }
            // Same window as a network-failure terminal: an answer the built-in table could not
            // name is a statement about today's table, not about the waybill.
            saveIfActive(identity, new Snapshot(CarrierNormalization.NONE, 0,
                    clock.now() + TERMINAL_TTL_MS, true, offTable), cancellation);
            return new Outcome(Collections.emptyList(), false, true, offTable);
        } catch (RecognitionPending pending) {
            saveIfActive(identity, new Snapshot(CarrierNormalization.NONE,
                    previous.networkFailures, Math.min(pending.retryAt, now + RETRY_DELAY_MS), false,
                    offTable), cancellation);
            return new Outcome(Collections.emptyList(), true, false, offTable);
        } catch (InterruptedException interrupted) {
            throw interrupted;
        } catch (Exception networkFailure) {
            // The paid level's own timeout, likewise (用户 2026-09-27 提交前核对答复四、答复五).
            if (requestTimedOut(networkFailure)) {
                if (roundWaiting.getAsBoolean()) throw new CarrierRecognitionTimeoutException();
                throw networkFailure;
            }
            recordNetworkFailure(identity, previous, now, cancellation, offTable);
            throw networkFailure;
        }
    }

    private static boolean isJd(CarrierNormalization value) {
        return value != null && "JD".equals(value.standardCode);
    }

    private CarrierNormalization classifySecondLevel(
            String waybill, ExpressQueryCancellation cancellation, boolean excludeJd,
            long parcelAnchorAtMs) throws Exception {
        cancellation.throwIfCancelled();
        JSONObject payload = new JSONObject()
                .put("waybill", waybill)
                .put("firstStageCompleted", true);
        // 优化 5（协调方定的接口约定）：the parcel's reuse anchor, only when it is positive and not in the future.
        if (parcelAnchorAtMs > 0L && parcelAnchorAtMs <= clock.now()) {
            payload.put("parcelAnchorAtMs", parcelAnchorAtMs);
        }
        HttpClient.Response response = gateway.post(
                "/api/express/classify", payload, cancellation);
        cancellation.throwIfCancelled();
        if (!response.successful()) {
            if (response.status == 502) {
                JSONObject pending = GatewayHttpErrors.parseObject(response, "暂时无法识别承运商");
                Object value = pending.opt("retryAt");
                if ("recognition_pending".equals(pending.optString("error", ""))
                        && value instanceof Number) {
                    double retryAt = ((Number) value).doubleValue();
                    if (retryAt == Math.rint(retryAt) && retryAt > clock.now()
                            && retryAt <= 9_007_199_254_740_991L) {
                        throw new RecognitionPending((long) retryAt);
                    }
                }
            }
            throw GatewayHttpErrors.forResponse(response, "暂时无法识别承运商");
        }
        JSONObject root = GatewayHttpErrors.parseObject(
                response, "暂时无法识别承运商");
        // Audit C1 (user 2026-09-25): the Worker answers with carrier standard codes (KYSY, JTSD,
        // HTKY …), never Kuaidi100 codes; read them by exact standard code only. A Kuaidi100-code or
        // display-name lookup turned HTKY into JTSD (both are named 极兔速递) and threw away most
        // paid answers. Shared fixture: carrier-classify-responses.v1.json.
        JSONArray values = root.optJSONArray("auto");
        if (values == null) return CarrierNormalization.NONE;
        for (int index = 0; index < values.length(); index++) {
            JSONObject value = values.optJSONObject(index);
            if (value == null) continue;
            CarrierRegistry.Carrier carrier = CarrierRegistry.resolve(
                    value.optString("comCode", ""));
            if (carrier == null || excludeJd && "JD".equals(carrier.standardCode)) continue;
            return localNormalization(carrier);
        }
        return CarrierNormalization.NONE;
    }

    private static final class RecognitionPending extends Exception {
        final long retryAt;
        RecognitionPending(long retryAt) {
            super("carrier recognition pending");
            this.retryAt = retryAt;
        }
    }

    private void recordNetworkFailure(String identity, Snapshot previous, long now,
            ExpressQueryCancellation cancellation, CarrierNormalization offTable)
            throws InterruptedException {
        int failures = previous.networkFailures + 1;
        boolean terminal = failures >= MAX_NETWORK_FAILURES;
        saveIfActive(identity, new Snapshot(
                CarrierNormalization.NONE, failures,
                now + (terminal ? TERMINAL_TTL_MS : RETRY_DELAY_MS), terminal, offTable), cancellation);
    }

    private void saveIfActive(String identity, Snapshot snapshot,
            ExpressQueryCancellation cancellation) throws InterruptedException {
        if (!cancellation.commitIfActive(() -> state.save(identity, snapshot))) {
            throw new InterruptedException("Carrier recognition cancelled before cache commit");
        }
    }

    private static CarrierNormalization localNormalization(CarrierRegistry.Carrier carrier) {
        return new CarrierNormalization(
                carrier.standardCode, carrier.companyName, carrier.kuaidi100Code, true, "");
    }

    private static CarrierNormalization currentNormalization(CarrierNormalization value) {
        if (value == null || !Boolean.TRUE.equals(value.builtIn)
                || clean(value.standardCode).isEmpty()) return null;
        CarrierRegistry.Carrier carrier = CarrierRegistry.resolve(value.standardCode);
        return carrier == null ? null : localNormalization(carrier);
    }

    private static String identity(String waybill) {
        try {
            String canonical = clean(waybill).toUpperCase(java.util.Locale.ROOT)
                    .replaceAll("[^A-Z0-9]", "");
            if (canonical.length() < 6) return "";
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(
                    canonical.getBytes(StandardCharsets.UTF_8));
            StringBuilder value = new StringBuilder(digest.length * 2);
            for (byte item : digest) value.append(String.format("%02x", item & 0xff));
            return value.toString();
        } catch (Exception impossible) {
            return "";
        }
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    static final class PreferencesState implements State {
        private final SharedPreferences preferences;

        PreferencesState(SharedPreferences preferences) {
            this.preferences = preferences;
        }

        @Override public Object coordinationKey() { return preferences; }

        @Override public Snapshot load(String identity) {
            String raw = preferences.getString(identity, "");
            if (raw == null || raw.isEmpty()) return Snapshot.empty();
            try {
                JSONObject value = new JSONObject(raw);
                CarrierNormalization success = new CarrierNormalization(
                        value.optString("standardCode", ""),
                        value.optString("displayName", ""),
                        value.optString("kuaidi100Code", ""),
                        value.has("builtIn") ? value.optBoolean("builtIn") : null,
                        value.optString("tableVersion", ""));
                return new Snapshot(
                        success, value.optInt("networkFailures", 0),
                        value.optLong("retryAt", 0L), value.optBoolean("terminal", false),
                        CarrierNormalization.offTable(value.optString("offTableName", ""),
                                value.optString("offTableCode", "")));
            } catch (Throwable malformed) {
                return Snapshot.empty();
            }
        }

        @Override public void save(String identity, Snapshot snapshot) {
            JSONObject value = new JSONObject();
            try {
                if (snapshot.success.present()) {
                    value.put("standardCode", snapshot.success.standardCode);
                    value.put("displayName", snapshot.success.displayName);
                    value.put("kuaidi100Code", snapshot.success.kuaidi100Code);
                    if (snapshot.success.builtIn != null) {
                        value.put("builtIn", snapshot.success.builtIn);
                    }
                    value.put("tableVersion", snapshot.success.tableVersion);
                }
                value.put("networkFailures", snapshot.networkFailures);
                value.put("retryAt", snapshot.retryAt);
                value.put("terminal", snapshot.terminal);
                if (!snapshot.offTable.offTableName().isEmpty()) {
                    value.put("offTableName", snapshot.offTable.displayName);
                    value.put("offTableCode", snapshot.offTable.kuaidi100Code);
                }
                value.put("updatedAtMs", System.currentTimeMillis());
                synchronized (preferences) {
                    SharedPreferences.Editor editor = preferences.edit().putString(identity, value.toString());
                    if (!snapshot.success.recognized() && !snapshot.terminal) {
                        ArrayList<Map.Entry<String, Long>> transientEntries = new ArrayList<>();
                        for (Map.Entry<String, ?> stored : preferences.getAll().entrySet()) {
                            if (identity.equals(stored.getKey())) continue;
                            Snapshot previous = load(stored.getKey());
                            if (previous.success.recognized() || previous.terminal) continue;
                            long updatedAt = 0L;
                            try {
                                updatedAt = new JSONObject(String.valueOf(stored.getValue()))
                                        .optLong("updatedAtMs", 0L);
                            } catch (Exception malformed) {
                                // Legacy malformed/transient entries are the oldest eviction candidates.
                            }
                            transientEntries.add(new AbstractMap.SimpleImmutableEntry<>(stored.getKey(), updatedAt));
                        }
                        transientEntries.sort(Comparator.comparingLong(Map.Entry::getValue));
                        for (int index = 0; index <= transientEntries.size() - MAX_TRANSIENT_ENTRIES; index++) {
                            editor.remove(transientEntries.get(index).getKey());
                        }
                    }
                    editor.apply();
                }
            } catch (Throwable ignored) {
                // A failed cache write may cause a later retry but never changes query semantics.
            }
        }
    }
}
