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

/** One durable two-level carrier-recognition attempt for non-sync waybills. */
final class CarrierRecognitionCoordinator {
    static final long RETRY_DELAY_MS = 15L * 60L * 1000L;
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
    private static final Map<Object, Map<String, Pending>> IN_FLIGHT =
            new IdentityHashMap<>();

    private static final class Pending {
        final ExpressQueryCancellation cancellation = new ExpressQueryCancellation(SHARED_REQUEST_BUDGET_MS);
        FutureTask<Outcome> task;
        int consumers;
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

        Snapshot(
                CarrierNormalization success, int networkFailures,
                long retryAt, boolean terminal) {
            this.success = success == null ? CarrierNormalization.NONE : success;
            this.networkFailures = Math.max(0, networkFailures);
            this.retryAt = Math.max(0L, retryAt);
            this.terminal = terminal;
        }

        static Snapshot empty() {
            return new Snapshot(CarrierNormalization.NONE, 0, 0L, false);
        }
    }

    static final class Outcome {
        final List<CarrierNormalization> candidates;
        final boolean deferred;
        final boolean terminal;

        Outcome(List<CarrierNormalization> candidates, boolean deferred, boolean terminal) {
            this.candidates = candidates == null
                    ? Collections.emptyList() : Collections.unmodifiableList(candidates);
            this.deferred = deferred;
            this.terminal = terminal;
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
        String number = clean(waybill);
        String identity = identity(number);
        if (number.length() < 6 || identity.isEmpty()) {
            return new Outcome(Collections.emptyList(), false, true);
        }
        if (cancellation != null) cancellation.throwIfCancelled();
        Object scope = state.coordinationKey();
        Pending work;
        boolean owner;
        synchronized (IN_FLIGHT) {
            Map<String, Pending> pending = IN_FLIGHT.computeIfAbsent(scope, key -> new HashMap<>());
            work = pending.get(identity);
            owner = work == null;
            if (owner) {
                Pending created = new Pending();
                created.task = new FutureTask<>(() -> {
                    try {
                        return recognizeOwned(number, identity, created.cancellation);
                    } finally {
                        removePending(scope, identity, created);
                        created.cancellation.close();
                    }
                });
                pending.put(identity, created);
                work = created;
            }
            work.consumers++;
        }
        Pending observed = work;
        AtomicBoolean detached = new AtomicBoolean();
        Runnable leave = () -> releaseConsumer(scope, identity, observed, detached);
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

    private static void releaseConsumer(Object scope, String identity, Pending work, AtomicBoolean detached) {
        if (!detached.compareAndSet(false, true)) return;
        synchronized (IN_FLIGHT) {
            if (--work.consumers != 0 || work.task.isDone()) return;
            // Fence old cache writes before a replacement can claim the same identity.
            work.cancellation.cancel();
            work.task.cancel(true);
            removePending(scope, identity, work);
        }
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
            ExpressQueryCancellation cancellation) throws Exception {
        cancellation.throwIfCancelled();
        Snapshot previous = state.load(identity);
        CarrierNormalization healed = currentNormalization(previous.success);
        if (healed != null) {
            saveIfActive(identity, new Snapshot(healed, 0, 0L, false), cancellation);
            return new Outcome(Collections.singletonList(healed), false, false);
        }
        if (previous.success.present()) previous = Snapshot.empty();
        if (previous.terminal) {
            return new Outcome(Collections.emptyList(), false, true);
        }
        long now = clock.now();
        if (previous.retryAt > now) {
            return new Outcome(Collections.emptyList(), true, false);
        }

        final List<String> publicCandidates;
        try {
            publicCandidates = publicDetector.detectCandidates(number, cancellation);
        } catch (InterruptedException interrupted) {
            throw interrupted;
        } catch (Exception networkFailure) {
            recordNetworkFailure(identity, previous, now, cancellation);
            throw networkFailure;
        }

        ArrayList<CarrierNormalization> recognized = new ArrayList<>();
        for (String candidate : publicCandidates) {
            CarrierRegistry.Carrier carrier = CarrierRegistry.resolveKuaidi100Code(candidate);
            if (carrier == null) continue;
            recognized.add(localNormalization(carrier));
        }
        if (!recognized.isEmpty()) {
            saveIfActive(identity, new Snapshot(recognized.get(0), 0, 0L, false), cancellation);
            return new Outcome(recognized, false, false);
        }

        try {
            CarrierNormalization fallback = classifySecondLevel(
                    number, cancellation);
            CarrierNormalization resolved = currentNormalization(fallback);
            if (resolved != null) {
                saveIfActive(identity, new Snapshot(resolved, 0, 0L, false), cancellation);
                return new Outcome(Collections.singletonList(resolved), false, false);
            }
            saveIfActive(identity, new Snapshot(CarrierNormalization.NONE, 0, 0L, true), cancellation);
            return new Outcome(Collections.emptyList(), false, true);
        } catch (RecognitionPending pending) {
            saveIfActive(identity, new Snapshot(CarrierNormalization.NONE,
                    previous.networkFailures, Math.min(pending.retryAt, now + RETRY_DELAY_MS), false), cancellation);
            return new Outcome(Collections.emptyList(), true, false);
        } catch (InterruptedException interrupted) {
            throw interrupted;
        } catch (Exception networkFailure) {
            recordNetworkFailure(identity, previous, now, cancellation);
            throw networkFailure;
        }
    }

    private CarrierNormalization classifySecondLevel(
            String waybill, ExpressQueryCancellation cancellation) throws Exception {
        cancellation.throwIfCancelled();
        JSONObject payload = new JSONObject()
                .put("waybill", waybill)
                .put("firstStageCompleted", true);
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
        CarrierNormalization rootNormalization = AccountCarrierNormalizer.parse(root);
        if (rootNormalization.recognized()) return rootNormalization;
        JSONArray values = root.optJSONArray("auto");
        if (values == null) return CarrierNormalization.NONE;
        for (int index = 0; index < values.length(); index++) {
            JSONObject value = values.optJSONObject(index);
            if (value == null) continue;
            CarrierNormalization normalization = AccountCarrierNormalizer.parse(value);
            if (normalization.recognized()) return normalization;
            CarrierRegistry.Carrier carrier = CarrierRegistry.resolveKuaidi100Code(
                    value.optString("comCode", ""));
            if (carrier == null) {
                carrier = CarrierRegistry.resolveName(value.optString("name", ""));
            }
            if (carrier != null) return localNormalization(carrier);
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
            ExpressQueryCancellation cancellation) throws InterruptedException {
        int failures = previous.networkFailures + 1;
        boolean terminal = failures >= MAX_NETWORK_FAILURES;
        saveIfActive(identity, new Snapshot(
                CarrierNormalization.NONE, failures,
                terminal ? 0L : now + RETRY_DELAY_MS, terminal), cancellation);
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
                        value.optLong("retryAt", 0L), value.optBoolean("terminal", false));
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
