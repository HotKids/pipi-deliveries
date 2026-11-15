package me.pipi.deliveries.security;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.InvalidAlgorithmParameterException;
import java.security.InvalidKeyException;
import java.security.KeyStore;
import java.security.UnrecoverableKeyException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import javax.crypto.BadPaddingException;
import javax.crypto.Cipher;
import javax.crypto.IllegalBlockSizeException;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Small AES-GCM envelope backed by a non-exportable Android Keystore key. */
public final class KeystoreSecretBox {
    static final int GCM_TAG_BYTES = 16;
    private static final Map<String, SecretKey> KEY_CACHE = new ConcurrentHashMap<>();

    /** The persisted envelope cannot be recovered because its Android Keystore alias is gone. */
    public static final class MissingKeyException extends UnrecoverableKeyException {
        public MissingKeyException() {
            super("encrypted secret key is missing");
        }

        public MissingKeyException(String alias) {
            super("keystore key is missing for alias " + alias);
        }
    }

    /** The persisted envelope is structurally invalid or failed authenticated decryption. */
    public static final class InvalidCiphertextException extends BadPaddingException {
        public InvalidCiphertextException() {
            super("invalid encrypted secret");
        }

        public InvalidCiphertextException(Throwable cause) {
            super("invalid encrypted secret");
            initCause(cause);
        }
    }

    private KeystoreSecretBox() {}

    public static String encrypt(String alias, String plainText) throws Exception {
        String cleanAlias = requireAlias(alias);
        return retryAfterInvalidKey(
                cleanAlias, true, KeystoreSecretBox::deleteKey,
                () -> encryptOnce(cleanAlias, plainText));
    }

    private static String encryptOnce(String alias, String plainText) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(alias, true));
        byte[] ciphertext = cipher.doFinal(plaintextBytes(plainText));
        byte[] iv = cipher.getIV();
        byte[] packed = new byte[1 + iv.length + ciphertext.length];
        packed[0] = (byte) iv.length;
        System.arraycopy(iv, 0, packed, 1, iv.length);
        System.arraycopy(ciphertext, 0, packed, 1 + iv.length, ciphertext.length);
        return Base64.encodeToString(packed, Base64.NO_WRAP);
    }

    public static String decrypt(String alias, String encoded) throws Exception {
        String cleanAlias = requireAlias(alias);
        // Never replace a key while decrypting: doing so would make every existing envelope
        // permanently unreadable. A failed decrypt is surfaced so persistence can preserve it.
        return retryAfterInvalidKey(
                cleanAlias, false, KeystoreSecretBox::deleteKey,
                () -> decryptOnce(cleanAlias, encoded));
    }

    /** Checks persisted alias metadata without creating or replacing key material. */
    public static boolean hasPersistedKey(String alias) throws Exception {
        String cleanAlias = requireAlias(alias);
        synchronized (KEY_CACHE) {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            KeyStore.Entry entry = store.getEntry(cleanAlias, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                return true;
            }
            KEY_CACHE.remove(cleanAlias);
            return false;
        }
    }

    private static String decryptOnce(String alias, String encoded) throws Exception {
        byte[] packed = unpackEnvelope(encoded);
        int ivLength = packed[0] & 0xff;
        byte[] iv = new byte[ivLength];
        byte[] ciphertext = new byte[packed.length - 1 - ivLength];
        System.arraycopy(packed, 1, iv, 0, ivLength);
        System.arraycopy(packed, 1 + ivLength, ciphertext, 0, ciphertext.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        SecretKey secretKey = key(alias, false);
        try {
            cipher.init(Cipher.DECRYPT_MODE, secretKey, new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        } catch (InvalidAlgorithmParameterException
                | BadPaddingException
                | IllegalBlockSizeException invalidEnvelope) {
            throw new InvalidCiphertextException(invalidEnvelope);
        }
    }

    static byte[] unpackEnvelope(String encoded) throws InvalidCiphertextException {
        final byte[] packed;
        try {
            packed = Base64.decode(clean(encoded), Base64.NO_WRAP);
        } catch (IllegalArgumentException malformed) {
            throw new InvalidCiphertextException(malformed);
        }
        if (packed == null || packed.length < 2) {
            throw new InvalidCiphertextException();
        }
        int ivLength = packed[0] & 0xff;
        // A GCM envelope always includes a 128-bit authentication tag, even for empty plaintext.
        if (ivLength < 8 || ivLength > 32 || packed.length < 1 + ivLength + GCM_TAG_BYTES) {
            throw new InvalidCiphertextException();
        }
        return packed;
    }

    private static SecretKey key(String alias, boolean createIfMissing) throws Exception {
        String cleanAlias = requireAlias(alias);
        SecretKey cached = KEY_CACHE.get(cleanAlias);
        if (cached != null) {
            return cached;
        }
        synchronized (KEY_CACHE) {
            cached = KEY_CACHE.get(cleanAlias);
            if (cached != null) {
                return cached;
            }
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            KeyStore.Entry entry = store.getEntry(cleanAlias, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                cached = ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            } else {
                if (!createIfMissing) {
                    throw new MissingKeyException(cleanAlias);
                }
                KeyGenerator generator = KeyGenerator.getInstance(
                        KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                generator.init(new KeyGenParameterSpec.Builder(
                        cleanAlias,
                        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .build());
                cached = generator.generateKey();
            }
            KEY_CACHE.put(cleanAlias, cached);
            return cached;
        }
    }

    /** Deletes an obsolete alias only after its owning lifecycle has released all dependents. */
    public static void deleteKey(String alias) throws Exception {
        String cleanAlias = requireAlias(alias);
        synchronized (KEY_CACHE) {
            KEY_CACHE.remove(cleanAlias);
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (store.containsAlias(cleanAlias)) {
                store.deleteEntry(cleanAlias);
            }
        }
    }

    static <T> T retryAfterInvalidKey(String alias, CheckedOperation<T> operation)
            throws Exception {
        return retryAfterInvalidKey(alias, false, KeystoreSecretBox::deleteKey, operation);
    }

    static <T> T retryAfterInvalidKey(
            String alias,
            boolean replacePermanentlyInvalidated,
            CheckedKeyCleaner keyCleaner,
            CheckedOperation<T> operation) throws Exception {
        String cleanAlias = requireAlias(alias);
        try {
            return operation.run();
        } catch (InvalidKeyException invalidKey) {
            if (replacePermanentlyInvalidated
                    && invalidKey instanceof KeyPermanentlyInvalidatedException) {
                keyCleaner.delete(cleanAlias);
                return operation.run();
            }
            // Reload once from AndroidKeyStore first so a stale provider handle never deletes
            // readable key material; replace only when the reloaded key is permanently invalidated.
            KEY_CACHE.remove(cleanAlias);
            try {
                return operation.run();
            } catch (KeyPermanentlyInvalidatedException invalidated) {
                if (!replacePermanentlyInvalidated) {
                    throw invalidated;
                }
                keyCleaner.delete(cleanAlias);
                return operation.run();
            }
        }
    }

    static byte[] plaintextBytes(String value) {
        return (value == null ? "" : value).getBytes(StandardCharsets.UTF_8);
    }

    private static String requireAlias(String alias) {
        String cleanAlias = clean(alias);
        if (cleanAlias.isEmpty()) {
            throw new IllegalArgumentException("key alias is empty");
        }
        return cleanAlias;
    }

    @FunctionalInterface
    interface CheckedOperation<T> {
        T run() throws Exception;
    }

    @FunctionalInterface
    interface CheckedKeyCleaner {
        void delete(String alias) throws Exception;
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
