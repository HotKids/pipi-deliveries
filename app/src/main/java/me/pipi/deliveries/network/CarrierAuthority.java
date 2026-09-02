package me.pipi.deliveries.network;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.AtomicFile;

import me.pipi.deliveries.data.CarrierRegistry;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** Loads the last-good carrier table and refreshes it through the authenticated Worker route. */
public final class CarrierAuthority {
    static final long REFRESH_INTERVAL_MS = 24L * 60L * 60L * 1_000L;

    private static final int CACHE_SCHEMA = 1;
    private static final int MAX_CACHE_BYTES = 1024 * 1024;
    private static final String ROUTE = "/api/express/carriers";
    private static final String CACHE_FILE = "carrier-authority-v2.json";
    private static final String PREFS = "deliveries_carrier_authority";
    private static final String LAST_ATTEMPT = "last_attempt_ms";

    private static boolean initialized;

    private CarrierAuthority() {}

    /** Loads synchronously so every first-frame consumer sees one complete table. */
    public static synchronized void initialize(Context context) {
        if (initialized) return;
        if (context == null) throw new IllegalArgumentException("context is required");
        Context application = context.getApplicationContext();
        AndroidStorage storage = new AndroidStorage(application);
        loadCached(storage);
        initialized = true;

        Thread refresh = new Thread(
                () -> refreshIfDue(
                        storage, new ExpressGatewayClient(application), System::currentTimeMillis),
                "carrier-authority-refresh");
        refresh.start();
    }

    /** Periodic worker hook; failure is intentionally independent from shipment synchronization. */
    public static boolean refreshIfDue(Context context) {
        if (context == null) return false;
        Context application = context.getApplicationContext();
        return refreshIfDue(
                new AndroidStorage(application),
                new ExpressGatewayClient(application),
                System::currentTimeMillis);
    }

    static boolean loadCached(Storage storage) {
        if (storage == null) return false;
        try {
            String raw = storage.readSnapshot();
            if (raw == null || raw.isEmpty()
                    || raw.getBytes(StandardCharsets.UTF_8).length > MAX_CACHE_BYTES) return false;
            JSONObject envelope = new JSONObject(raw);
            Object schema = envelope.opt("cacheSchema");
            Object fetchedAt = envelope.opt("fetchedAtMs");
            Object payload = envelope.opt("payload");
            if (!(schema instanceof Number) || ((Number) schema).intValue() != CACHE_SCHEMA
                    || ((Number) schema).doubleValue() != CACHE_SCHEMA
                    || !isNonNegativeInteger(fetchedAt)
                    || !(payload instanceof JSONObject)) return false;
            CarrierRegistry.PreparedAuthority prepared =
                    CarrierRegistry.prepareAuthority((JSONObject) payload);
            CarrierRegistry.installAuthority(prepared);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    static synchronized boolean refreshIfDue(
            Storage storage, ExpressGatewayTransport gateway, Clock clock) {
        if (storage == null || gateway == null || clock == null) return false;
        long now = Math.max(0L, clock.now());
        long lastAttempt = Math.max(0L, storage.lastAttemptMs());
        if (lastAttempt > 0L
                && (lastAttempt > now || now - lastAttempt < REFRESH_INTERVAL_MS)) return false;
        if (!storage.recordAttemptMs(now)) return false;
        try {
            if (!gateway.configured()) return false;
            HttpClient.Response response = gateway.post(ROUTE, new JSONObject());
            if (response.status != 200 || response.body.length == 0
                    || response.body.length > MAX_CACHE_BYTES) return false;
            JSONObject payload = new JSONObject(response.utf8());
            CarrierRegistry.PreparedAuthority prepared =
                    CarrierRegistry.prepareAuthority(payload);
            JSONObject envelope = new JSONObject()
                    .put("cacheSchema", CACHE_SCHEMA)
                    .put("fetchedAtMs", now)
                    .put("payload", payload);
            String serialized = envelope.toString();
            if (serialized.getBytes(StandardCharsets.UTF_8).length > MAX_CACHE_BYTES
                    || !storage.writeSnapshot(serialized)) return false;
            CarrierRegistry.installAuthority(prepared);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    interface Clock {
        long now();
    }

    interface Storage {
        String readSnapshot();

        boolean writeSnapshot(String value);

        long lastAttemptMs();

        boolean recordAttemptMs(long value);
    }

    private static boolean isNonNegativeInteger(Object value) {
        if (!(value instanceof Number)) return false;
        Number number = (Number) value;
        long integer = number.longValue();
        double decimal = number.doubleValue();
        return integer >= 0L && Double.isFinite(decimal) && decimal == (double) integer;
    }

    private static final class AndroidStorage implements Storage {
        private final AtomicFile cache;
        private final SharedPreferences preferences;

        AndroidStorage(Context context) {
            File directory = new File(context.getNoBackupFilesDir(), "express");
            cache = new AtomicFile(new File(directory, CACHE_FILE));
            preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        }

        @Override public String readSnapshot() {
            try (InputStream input = cache.openRead();
                    ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int total = 0;
                int count;
                while ((count = input.read(buffer)) != -1) {
                    total += count;
                    if (total > MAX_CACHE_BYTES) return null;
                    output.write(buffer, 0, count);
                }
                byte[] bytes = output.toByteArray();
                if (bytes.length == 0) return null;
                return new String(bytes, StandardCharsets.UTF_8);
            } catch (Throwable ignored) {
                return null;
            }
        }

        @Override public boolean writeSnapshot(String value) {
            File parent = cache.getBaseFile().getParentFile();
            if ((parent == null || (!parent.isDirectory() && !parent.mkdirs()))
                    || value == null) return false;
            byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
            if (bytes.length == 0 || bytes.length > MAX_CACHE_BYTES) return false;
            FileOutputStream output = null;
            try {
                output = cache.startWrite();
                output.write(bytes);
                cache.finishWrite(output);
                return true;
            } catch (Throwable ignored) {
                if (output != null) cache.failWrite(output);
                return false;
            }
        }

        @Override public long lastAttemptMs() {
            return preferences.getLong(LAST_ATTEMPT, 0L);
        }

        @Override public boolean recordAttemptMs(long value) {
            return preferences.edit().putLong(LAST_ATTEMPT, value).commit();
        }
    }
}
