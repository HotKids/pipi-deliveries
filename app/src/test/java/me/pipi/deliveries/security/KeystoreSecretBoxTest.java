package me.pipi.deliveries.security;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.util.Base64;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.util.concurrent.atomic.AtomicInteger;

import javax.crypto.AEADBadTagException;
import javax.crypto.BadPaddingException;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public final class KeystoreSecretBoxTest {
    @Test
    public void encryptReloadsStaleKeyWithoutDeletingAlias() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        AtomicInteger deletes = new AtomicInteger();

        String value = KeystoreSecretBox.retryAfterInvalidKey(
                "test-alias",
                true,
                alias -> deletes.incrementAndGet(),
                () -> {
                    if (attempts.incrementAndGet() == 1) {
                        throw new InvalidKeyException("stale cached key");
                    }
                    return "encrypted";
                });

        assertEquals("encrypted", value);
        assertEquals(2, attempts.get());
        assertEquals(0, deletes.get());
    }

    @Test
    public void encryptReplacesPermanentlyInvalidatedKeyOnce() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        AtomicInteger deletes = new AtomicInteger();

        String value = KeystoreSecretBox.retryAfterInvalidKey(
                "test-alias",
                true,
                alias -> deletes.incrementAndGet(),
                () -> {
                    if (attempts.incrementAndGet() == 1) {
                        throw new KeyPermanentlyInvalidatedException();
                    }
                    return "encrypted";
                });

        assertEquals("encrypted", value);
        assertEquals(2, attempts.get());
        assertEquals(1, deletes.get());
    }

    @Test
    public void decryptNeverDeletesPermanentlyInvalidatedKey() {
        AtomicInteger attempts = new AtomicInteger();
        AtomicInteger deletes = new AtomicInteger();

        assertThrows(KeyPermanentlyInvalidatedException.class, () ->
                KeystoreSecretBox.retryAfterInvalidKey(
                        "test-alias",
                        false,
                        alias -> deletes.incrementAndGet(),
                        () -> {
                            attempts.incrementAndGet();
                            throw new KeyPermanentlyInvalidatedException();
                        }));

        assertEquals(2, attempts.get());
        assertEquals(0, deletes.get());
    }

    @Test
    public void truncatedEnvelopeShorterThanGcmTagIsRejected() {
        byte[] truncated = new byte[1 + 12 + KeystoreSecretBox.GCM_TAG_BYTES - 1];
        truncated[0] = 12;
        String encoded = Base64.encodeToString(truncated, Base64.NO_WRAP);

        assertThrows(KeystoreSecretBox.InvalidCiphertextException.class,
                () -> KeystoreSecretBox.unpackEnvelope(encoded));
    }

    @Test
    public void invalidCiphertextExceptionPreservesCauseAndWhitespace() {
        AEADBadTagException tagFailure = new AEADBadTagException("tag mismatch");
        KeystoreSecretBox.InvalidCiphertextException wrapped =
                new KeystoreSecretBox.InvalidCiphertextException(tagFailure);
        assertTrue(wrapped instanceof BadPaddingException);
        assertSame(tagFailure, wrapped.getCause());

        String credential = "  secret with spaces  ";
        assertEquals(credential, new String(
                KeystoreSecretBox.plaintextBytes(credential), StandardCharsets.UTF_8));
    }
}
