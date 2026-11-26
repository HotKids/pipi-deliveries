package me.pipi.deliveries.data;

import android.util.Log;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

import me.pipi.deliveries.security.KeystoreSecretBox;

/** Encrypts dynamic provider detail routes before SQLite persistence. */
final class EncryptedExpressFields {
    private static final String TAG = "EncryptedExpressFields";
    private static final String KEY_ALIAS = "pipi_deliveries_provider_fields_v1";
    private static final String PREFIX = "enc:v1:";
    private static final AtomicBoolean ENCRYPTION_WARNING_LOGGED = new AtomicBoolean();
    private static final AtomicBoolean DECRYPTION_WARNING_LOGGED = new AtomicBoolean();
    private static final ThreadLocal<Map<String, Result>> DECODE_SCOPE = new ThreadLocal<>();
    private static final ThreadLocal<Map<String, Result>> COMMIT_DECODE_SCOPE = new ThreadLocal<>();
    private static final ThreadLocal<Map<String, Result>> COMMIT_ENCODE_SCOPE = new ThreadLocal<>();

    private EncryptedExpressFields() {}

    static final class CommitScope implements AutoCloseable {
        private final boolean opened;

        private CommitScope(boolean opened) {
            this.opened = opened;
        }

        @Override
        public void close() {
            if (!opened) return;
            COMMIT_DECODE_SCOPE.remove();
            COMMIT_ENCODE_SCOPE.remove();
        }
    }

    /** Opens this thread's Keystore decode/encode cache scope; joins an already-open scope. */
    static CommitScope openCommitScope() {
        if (COMMIT_DECODE_SCOPE.get() != null) return new CommitScope(false);
        COMMIT_DECODE_SCOPE.set(new HashMap<>());
        COMMIT_ENCODE_SCOPE.set(new HashMap<>());
        return new CommitScope(true);
    }

    static <T> T withDecodeCache(Supplier<T> reader) {
        Map<String, Result> existing = DECODE_SCOPE.get();
        if (existing != null) return reader.get();
        DECODE_SCOPE.set(new HashMap<>());
        try {
            return reader.get();
        } finally {
            DECODE_SCOPE.remove();
        }
    }

    static Result tryEncode(String value) {
        String clean = clean(value);
        if (clean.isEmpty() || clean.startsWith(PREFIX)) return Result.available(clean);
        Map<String, Result> commitEncodes = COMMIT_ENCODE_SCOPE.get();
        if (commitEncodes != null) {
            Result cached = commitEncodes.get(clean);
            if (cached != null) return cached;
        }
        try {
            Result encoded = Result.available(PREFIX + KeystoreSecretBox.encrypt(KEY_ALIAS, clean));
            if (commitEncodes != null) commitEncodes.put(clean, encoded);
            Map<String, Result> commitDecodes = COMMIT_DECODE_SCOPE.get();
            if (commitDecodes != null) commitDecodes.put(encoded.value, Result.available(clean));
            return encoded;
        } catch (Throwable error) {
            if (ENCRYPTION_WARNING_LOGGED.compareAndSet(false, true)) {
                Log.w(TAG, "Provider credential encryption is temporarily unavailable" + " kind=" + error.getClass().getSimpleName());
            }
            return Result.unavailable();
        }
    }

    static Result tryDecode(String value) {
        return tryDecode("", value);
    }

    static Result tryDecode(String cacheScope, String value) {
        String clean = clean(value);
        if (clean.isEmpty() || !clean.startsWith(PREFIX)) return Result.available(clean);
        Map<String, Result> commitDecodes = COMMIT_DECODE_SCOPE.get();
        if (commitDecodes != null) {
            Result cached = commitDecodes.get(clean);
            if (cached != null) return cached;
        }
        Map<String, Result> scope = DECODE_SCOPE.get();
        String cacheKey = scope == null ? null
                : (cacheScope == null || cacheScope.isEmpty() ? clean : cacheScope + '\u0000' + clean);
        if (scope != null) {
            Result cached = scope.get(cacheKey);
            if (cached != null) {
                if (commitDecodes != null) commitDecodes.put(clean, cached);
                return cached;
            }
        }
        try {
            Result decoded = Result.available(
                    KeystoreSecretBox.decrypt(KEY_ALIAS, clean.substring(PREFIX.length())));
            if (commitDecodes != null) commitDecodes.put(clean, decoded);
            if (scope != null) scope.put(cacheKey, decoded);
            return decoded;
        } catch (Throwable error) {
            // Callers must distinguish an unreadable ciphertext from a genuinely empty field so a
            // transient AndroidKeyStore failure can never overwrite the persisted envelope.
            if (DECRYPTION_WARNING_LOGGED.compareAndSet(false, true)) {
                Log.w(TAG, "Provider credential decryption is temporarily unavailable" + " kind=" + error.getClass().getSimpleName());
            }
            return Result.unavailable();
        }
    }

    static final class Result {
        final String value;
        final boolean available;

        private Result(String value, boolean available) {
            this.value = clean(value);
            this.available = available;
        }

        static Result available(String value) {
            return new Result(value, true);
        }

        static Result unavailable() {
            return new Result("", false);
        }
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
