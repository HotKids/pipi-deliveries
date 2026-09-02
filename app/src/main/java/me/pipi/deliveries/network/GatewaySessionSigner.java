package me.pipi.deliveries.network;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.cert.Certificate;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/** Owns the hardware-attested session and signs each Android gateway request. */
final class GatewaySessionSigner {
    private static final String PREFS = "pipi_deliveries_gateway_session";
    private static final String KEY_ALIAS = "pipi_deliveries_gateway_attested_release_v1";
    private static final String SESSION = "session";
    private static final String EXPIRES = "expires";
    private static final long MIN_VALIDITY_SECONDS = 60L;
    private static final Object LOCK = new Object();

    private final Context context;
    private final String gatewayUrl;

    GatewaySessionSigner(Context context, String gatewayUrl) {
        this.context = context;
        this.gatewayUrl = stripTrailingSlash(gatewayUrl);
    }

    SignedHeaders headers(
            String route, String body, ExpressQueryCancellation cancellation) throws Exception {
        Session current = session(cancellation);
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String timestamp = Long.toString(System.currentTimeMillis());
        String nonce = UUID.randomUUID().toString().toLowerCase(Locale.ROOT);
        KeyStore keyStore = keyStore();
        PrivateKey privateKey = (PrivateKey) keyStore.getKey(KEY_ALIAS, null);
        Certificate certificate = keyStore.getCertificate(KEY_ALIAS);
        PublicKey publicKey = certificate == null ? null : certificate.getPublicKey();
        if (privateKey == null || publicKey == null) {
            throw new IllegalStateException("gateway attested key unavailable");
        }
        Signature signature = Signature.getInstance("SHA256withRSA");
        signature.initSign(privateKey);
        signature.update(canonicalRequest(timestamp, nonce, route, bytes)
                .getBytes(StandardCharsets.UTF_8));
        Base64.Encoder encoder = Base64.getUrlEncoder().withoutPadding();
        LinkedHashMap<String, String> values = new LinkedHashMap<>();
        values.put("X-Pipi-Session", current.value);
        values.put("X-Pipi-Timestamp", timestamp);
        values.put("X-Pipi-Nonce", nonce);
        values.put("X-Pipi-Public-Key", encoder.encodeToString(publicKey.getEncoded()));
        values.put("X-Pipi-Signature", encoder.encodeToString(signature.sign()));
        return new SignedHeaders(current.value, values);
    }

    void invalidate(String rejectedSession) throws Exception {
        synchronized (LOCK) {
            SharedPreferences preferences = preferences();
            if (!clean(preferences.getString(SESSION, "")).equals(clean(rejectedSession))) return;
            preferences.edit().clear().commit();
            KeyStore store = keyStore();
            if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS);
        }
    }

    private Session session(ExpressQueryCancellation cancellation) throws Exception {
        synchronized (LOCK) {
            SharedPreferences preferences = preferences();
            String value = clean(preferences.getString(SESSION, ""));
            long expires = preferences.getLong(EXPIRES, 0L);
            long now = System.currentTimeMillis() / 1000L;
            KeyStore store = keyStore();
            if (!value.isEmpty() && expires > now + MIN_VALIDITY_SECONDS
                    && store.containsAlias(KEY_ALIAS)) {
                return new Session(value);
            }
            preferences.edit().clear().commit();
            if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS);
            return enroll(preferences, cancellation);
        }
    }

    private Session enroll(
            SharedPreferences preferences, ExpressQueryCancellation cancellation) throws Exception {
        if (cancellation != null) cancellation.throwIfCancelled();
        HttpClient.Response challengeResponse = post(
                "/api/auth/challenge", new JSONObject().toString(), cancellation);
        if (!challengeResponse.successful()) {
            throw new IllegalStateException("gateway challenge failed");
        }
        JSONObject challengePayload = new JSONObject(challengeResponse.utf8());
        byte[] challenge = Base64.getUrlDecoder().decode(
                clean(challengePayload.optString("challenge")));
        String token = clean(challengePayload.optString("token"));
        if (challenge.length != 32 || token.isEmpty()) {
            throw new IllegalStateException("gateway challenge invalid");
        }

        KeyPairGenerator generator = KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore");
        generator.initialize(new KeyGenParameterSpec.Builder(
                KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
                .setKeySize(2048)
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
                .setAttestationChallenge(challenge.clone())
                .setUserAuthenticationRequired(false)
                .build());
        generator.generateKeyPair();

        Certificate[] chain = keyStore().getCertificateChain(KEY_ALIAS);
        if (chain == null || chain.length < 2) {
            throw new IllegalStateException("hardware attestation unavailable");
        }
        JSONArray encodedChain = new JSONArray();
        Base64.Encoder encoder = Base64.getEncoder();
        for (Certificate certificate : chain) {
            encodedChain.put(encoder.encodeToString(certificate.getEncoded()));
        }
        JSONObject request = new JSONObject().put("token", token).put("chain", encodedChain);
        HttpClient.Response sessionResponse = post(
                "/api/auth/session", request.toString(), cancellation);
        if (!sessionResponse.successful()) {
            keyStore().deleteEntry(KEY_ALIAS);
            throw new IllegalStateException("gateway attestation failed");
        }
        JSONObject response = new JSONObject(sessionResponse.utf8());
        String session = clean(response.optString(SESSION));
        long expires = response.optLong(EXPIRES, 0L);
        long now = System.currentTimeMillis() / 1000L;
        if (session.isEmpty() || expires <= now + MIN_VALIDITY_SECONDS) {
            keyStore().deleteEntry(KEY_ALIAS);
            throw new IllegalStateException("gateway session invalid");
        }
        if (!preferences.edit().putString(SESSION, session)
                .putLong(EXPIRES, expires).commit()) {
            keyStore().deleteEntry(KEY_ALIAS);
            throw new IllegalStateException("gateway session was not saved");
        }
        return new Session(session);
    }

    private HttpClient.Response post(
            String route, String body, ExpressQueryCancellation cancellation) throws Exception {
        return cancellation == null
                ? HttpClient.postJson(gatewayUrl + route, body, Map.of(), false)
                : HttpClient.postJson(gatewayUrl + route, body, Map.of(), false, cancellation);
    }

    static String canonicalRequest(
            String timestamp, String nonce, String route, byte[] body) throws Exception {
        return clean(timestamp) + "\n" + clean(nonce) + "\nPOST\n" + clean(route)
                + "\n" + sha256Hex(body == null ? new byte[0] : body);
    }

    static String sha256Hex(byte[] value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
        StringBuilder output = new StringBuilder(digest.length * 2);
        for (byte item : digest) {
            output.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        }
        return output.toString();
    }

    private SharedPreferences preferences() {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static KeyStore keyStore() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        return store;
    }

    private static String stripTrailingSlash(String value) {
        String result = clean(value);
        while (result.endsWith("/")) result = result.substring(0, result.length() - 1);
        return result;
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    static final class SignedHeaders {
        final String session;
        final Map<String, String> values;

        SignedHeaders(String session, Map<String, String> values) {
            this.session = session;
            this.values = values;
        }
    }

    static final class RejectedSession extends Exception {
        final String session;

        RejectedSession(String session) {
            this.session = session;
        }
    }

    private static final class Session {
        final String value;

        Session(String value) {
            this.value = value;
        }
    }
}
