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

/** One durable two-level carrier-recognition attempt for non-sync waybills. */
final class CarrierRecognitionCoordinator {
    static final long RETRY_DELAY_MS = 15L * 60L * 1000L;
    static final int MAX_NETWORK_FAILURES = 3;
    private static final String PREFS = "carrier_recognition_v1";

    interface Clock {
        long now();
    }

    interface State {
        Snapshot load(String identity);
        void save(String identity, Snapshot snapshot);
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
            private final Map<String, Snapshot> values = new HashMap<>();

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
        Snapshot previous = state.load(identity);
        CarrierNormalization healed = currentNormalization(previous.success);
        if (healed != null) {
            state.save(identity, new Snapshot(healed, 0, 0L, false));
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
            recordNetworkFailure(identity, previous, now);
            throw networkFailure;
        }

        ArrayList<CarrierNormalization> recognized = new ArrayList<>();
        for (String candidate : publicCandidates) {
            CarrierRegistry.Carrier carrier = CarrierRegistry.resolveKuaidi100Code(candidate);
            if (carrier == null) continue;
            recognized.add(localNormalization(carrier));
        }
        if (!recognized.isEmpty()) {
            state.save(identity, new Snapshot(recognized.get(0), 0, 0L, false));
            return new Outcome(recognized, false, false);
        }

        try {
            CarrierNormalization fallback = classifySecondLevel(
                    number, cancellation);
            CarrierNormalization resolved = currentNormalization(fallback);
            if (resolved != null) {
                state.save(identity, new Snapshot(resolved, 0, 0L, false));
                return new Outcome(Collections.singletonList(resolved), false, false);
            }
            state.save(identity, new Snapshot(CarrierNormalization.NONE, 0, 0L, true));
            return new Outcome(Collections.emptyList(), false, true);
        } catch (InterruptedException interrupted) {
            throw interrupted;
        } catch (Exception networkFailure) {
            recordNetworkFailure(identity, previous, now);
            throw networkFailure;
        }
    }

    private CarrierNormalization classifySecondLevel(
            String waybill, ExpressQueryCancellation cancellation) throws Exception {
        JSONObject payload = new JSONObject()
                .put("waybill", waybill)
                .put("firstStageCompleted", true);
        HttpClient.Response response = gateway.post(
                "/api/express/classify", payload, cancellation);
        if (!response.successful()) {
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

    private void recordNetworkFailure(String identity, Snapshot previous, long now) {
        int failures = previous.networkFailures + 1;
        boolean terminal = failures >= MAX_NETWORK_FAILURES;
        state.save(identity, new Snapshot(
                CarrierNormalization.NONE, failures,
                terminal ? 0L : now + RETRY_DELAY_MS, terminal));
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

    private static final class PreferencesState implements State {
        private final SharedPreferences preferences;

        PreferencesState(SharedPreferences preferences) {
            this.preferences = preferences;
        }

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
                preferences.edit().putString(identity, value.toString()).apply();
            } catch (Throwable ignored) {
                // A failed cache write may cause a later retry but never changes query semantics.
            }
        }
    }
}
