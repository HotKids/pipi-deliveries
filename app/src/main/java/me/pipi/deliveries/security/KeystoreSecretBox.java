package me.pipi.deliveries.security;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.InvalidAlgorithmParameterException;
import java.security.InvalidKeyException;
import java.security.KeyStore;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import javax.crypto.BadPaddingException;
import javax.crypto.Cipher;
import javax.crypto.IllegalBlockSizeException;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** AES-GCM envelope backed by a non-exportable per-install Android Keystore key. */
public final class KeystoreSecretBox {
    private static final Map<String, SecretKey> KEY_CACHE = new ConcurrentHashMap<>();

    /** The persisted envelope cannot be recovered because its Android Keystore alias is gone. */
    public static final class MissingKeyException extends GeneralSecurityException {
        public MissingKeyException() {
            super("encrypted secret key is missing");
        }
    }

    /** The persisted envelope is structurally invalid or failed authenticated decryption. */
    public static final class InvalidCiphertextException extends GeneralSecurityException {
        public InvalidCiphertextException() {
            super("invalid encrypted secret");
        }

        private InvalidCiphertextException(Throwable cause) {
            super("invalid encrypted secret", cause);
        }
    }

    private KeystoreSecretBox() {}

    public static String encrypt(String alias, String plainText) throws Exception {
        String cleanAlias = requireAlias(alias);
        return retryAfterInvalidKey(
                cleanAlias, true, () -> encryptOnce(cleanAlias, plainText));
    }

    public static String decrypt(String alias, String encoded) throws Exception {
        String cleanAlias = requireAlias(alias);
        // Never replace a key while decrypting: doing so would make every existing envelope
        // permanently unreadable. A failed decrypt is surfaced so persistence can preserve it.
        return retryAfterInvalidKey(
                cleanAlias, false, () -> decryptOnce(cleanAlias, encoded));
    }

    private static String encryptOnce(String alias, String plainText) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(alias, true));
        byte[] ciphertext = cipher.doFinal(clean(plainText).getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        byte[] packed = new byte[1 + iv.length + ciphertext.length];
        packed[0] = (byte) iv.length;
        System.arraycopy(iv, 0, packed, 1, iv.length);
        System.arraycopy(ciphertext, 0, packed, 1 + iv.length, ciphertext.length);
        return Base64.encodeToString(packed, Base64.NO_WRAP);
    }

    private static String decryptOnce(String alias, String encoded) throws Exception {
        final byte[] packed;
        try {
            packed = Base64.decode(clean(encoded), Base64.NO_WRAP);
        } catch (IllegalArgumentException malformed) {
            throw new InvalidCiphertextException(malformed);
        }
        if (packed.length < 2) throw new InvalidCiphertextException();
        int ivLength = packed[0] & 0xff;
        // A GCM envelope always includes a 128-bit authentication tag, even for empty plaintext.
        if (ivLength < 8 || ivLength > 32 || packed.length < 1 + ivLength + 16) {
            throw new InvalidCiphertextException();
        }
        byte[] iv = new byte[ivLength];
        byte[] ciphertext = new byte[packed.length - 1 - ivLength];
        System.arraycopy(packed, 1, iv, 0, ivLength);
        System.arraycopy(packed, 1 + ivLength, ciphertext, 0, ciphertext.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        try {
            cipher.init(Cipher.DECRYPT_MODE, key(alias, false), new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        } catch (InvalidAlgorithmParameterException
                | BadPaddingException
                | IllegalBlockSizeException invalidEnvelope) {
            throw new InvalidCiphertextException(invalidEnvelope);
        }
    }

    private static SecretKey key(String alias, boolean createIfMissing) throws Exception {
        SecretKey cached = KEY_CACHE.get(alias);
        if (cached != null) return cached;
        synchronized (KEY_CACHE) {
            cached = KEY_CACHE.get(alias);
            if (cached != null) return cached;
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            KeyStore.Entry entry = store.getEntry(alias, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                cached = ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            } else {
                if (!createIfMissing) throw new MissingKeyException();
                KeyGenerator generator = KeyGenerator.getInstance(
                        KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                generator.init(new KeyGenParameterSpec.Builder(
                        alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .build());
                cached = generator.generateKey();
            }
            KEY_CACHE.put(alias, cached);
            return cached;
        }
    }

    private static <T> T retryAfterInvalidKey(
            String alias, boolean replaceInvalidKey, CheckedOperation<T> operation)
            throws Exception {
        try {
            return operation.run();
        } catch (InvalidKeyException invalidKey) {
            if (replaceInvalidKey) replaceKey(alias);
            else KEY_CACHE.remove(alias);
            return operation.run();
        }
    }

    private static void replaceKey(String alias) throws Exception {
        synchronized (KEY_CACHE) {
            KEY_CACHE.remove(alias);
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (store.containsAlias(alias)) store.deleteEntry(alias);
        }
    }

    private static String requireAlias(String alias) {
        String cleanAlias = clean(alias);
        if (cleanAlias.isEmpty()) throw new IllegalArgumentException("key alias is empty");
        return cleanAlias;
    }

    private interface CheckedOperation<T> { T run() throws Exception; }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
