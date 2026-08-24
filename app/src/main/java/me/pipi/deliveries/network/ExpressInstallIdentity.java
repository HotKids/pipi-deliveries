package me.pipi.deliveries.network;

import android.content.Context;
import android.content.SharedPreferences;

import me.pipi.deliveries.security.KeystoreSecretBox;

import org.json.JSONException;
import org.json.JSONObject;

import java.security.SecureRandom;
import java.util.Locale;

/** Stable, encrypted, per-install identity for the current account interface. */
final class ExpressInstallIdentity {
    private static final Object LOCK = new Object();
    private static final String PREFS = "express_account_identity_v2";
    private static final String VALUE = "encrypted_identity";
    private static final String KEY_ALIAS = "pipi_deliveries_account_identity_v2";
    private static final String LEGACY_PREFS = "express_discovery";
    private static final SecretBox ANDROID_KEYSTORE = new SecretBox() {
        @Override
        public String decrypt(String encoded) throws Exception {
            return KeystoreSecretBox.decrypt(KEY_ALIAS, encoded);
        }

        @Override
        public String encrypt(String plainText) throws Exception {
            return KeystoreSecretBox.encrypt(KEY_ALIAS, plainText);
        }
    };

    private ExpressInstallIdentity() {}

    static JSONObject get(Context context) throws Exception {
        Context app = context.getApplicationContext();
        synchronized (LOCK) {
            SharedPreferences preferences = app.getSharedPreferences(PREFS, 0);
            String encrypted = preferences.getString(VALUE, "");
            Resolution resolution = resolve(
                    encrypted,
                    ANDROID_KEYSTORE,
                    encoded -> preferences.edit().putString(VALUE, encoded).commit(),
                    new SecureRandom());
            if (resolution.created) {
                // The previous UUID identity is intentionally not migrated into the new contract.
                app.getSharedPreferences(LEGACY_PREFS, 0).edit()
                        .remove("oaid")
                        .remove("vaid")
                        .apply();
            }
            return resolution.identity;
        }
    }

    static Resolution resolve(
            String encrypted,
            SecretBox secretBox,
            EncodedIdentityWriter writer,
            SecureRandom random) throws Exception {
        if (encrypted != null && !encrypted.isEmpty()) {
            try {
                JSONObject restored = new JSONObject(secretBox.decrypt(encrypted));
                if (isValid(restored)) return new Resolution(restored, false);
            } catch (KeystoreSecretBox.MissingKeyException
                    | KeystoreSecretBox.InvalidCiphertextException
                    | JSONException unrecoverable) {
                // Replacing this identity changes the interface-5 account namespace. Existing
                // phone bindings cannot be carried over and must be bound again by the user.
            }
        }

        JSONObject created = generate(random);
        String encoded = secretBox.encrypt(created.toString());
        if (!writer.write(encoded)) {
            throw new IllegalStateException("安装身份保存失败，请稍后重试");
        }
        return new Resolution(created, true);
    }

    static JSONObject generate(SecureRandom random) throws Exception {
        StringBuilder userId = new StringBuilder(10);
        for (int index = 0; index < 10; index++) userId.append(random.nextInt(10));
        JSONObject result = new JSONObject()
                .put("userId", userId.toString())
                .put("oaid", randomHex(random, 8))
                .put("vaid", randomHex(random, 8));
        if (!isValid(result)) throw new IllegalStateException("无法生成安装身份");
        return result;
    }

    static boolean isValid(JSONObject value) {
        if (value == null) return false;
        return value.optString("userId", "").matches("^\\d{10}$")
                && value.optString("oaid", "").matches("^[0-9a-f]{16}$")
                && value.optString("vaid", "").matches("^[0-9a-f]{16}$");
    }

    interface SecretBox {
        String decrypt(String encoded) throws Exception;
        String encrypt(String plainText) throws Exception;
    }

    interface EncodedIdentityWriter {
        boolean write(String encoded);
    }

    static final class Resolution {
        final JSONObject identity;
        final boolean created;

        Resolution(JSONObject identity, boolean created) {
            this.identity = identity;
            this.created = created;
        }
    }

    private static String randomHex(SecureRandom random, int byteCount) {
        byte[] bytes = new byte[byteCount];
        random.nextBytes(bytes);
        StringBuilder output = new StringBuilder(byteCount * 2);
        for (byte value : bytes) {
            output.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        }
        return output.toString();
    }
}
