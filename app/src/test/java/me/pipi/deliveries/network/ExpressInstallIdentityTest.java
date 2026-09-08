package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.security.KeystoreSecretBox;

import org.json.JSONObject;
import org.junit.Test;

import java.security.KeyStoreException;
import java.security.SecureRandom;

public final class ExpressInstallIdentityTest {
    @Test
    public void generatedIdentityMatchesTheInterface5Contract() throws Exception {
        JSONObject first = ExpressInstallIdentity.generate(new SecureRandom());
        JSONObject second = ExpressInstallIdentity.generate(new SecureRandom());

        assertTrue(ExpressInstallIdentity.isValid(first));
        assertTrue(ExpressInstallIdentity.isValid(second));
        assertTrue(first.getString("userId").matches("^\\d{10}$"));
        assertTrue(first.getString("oaid").matches("^[0-9a-f]{16}$"));
        assertTrue(first.getString("vaid").matches("^[0-9a-f]{16}$"));
        assertFalse(first.toString().equals(second.toString()));
    }

    @Test
    public void restorableIdentityKeepsTheExistingAccountAndBindings() throws Exception {
        FakeSecretBox secretBox = new FakeSecretBox();
        secretBox.decrypted = "{\"userId\":\"1234567890\","
                + "\"oaid\":\"0011223344556677\",\"vaid\":\"8899aabbccddeeff\"}";
        RecordingWriter writer = new RecordingWriter();

        ExpressInstallIdentity.Resolution resolution = ExpressInstallIdentity.resolve(
                "existing-envelope", secretBox, writer, new SecureRandom());

        assertFalse(resolution.created);
        assertEquals("1234567890", resolution.identity.getString("userId"));
        assertEquals(0, writer.writes);
    }

    @Test
    public void missingKeystoreAliasCreatesANewAccountIdentityThatRequiresRebinding()
            throws Exception {
        FakeSecretBox secretBox = new FakeSecretBox();
        secretBox.decryptFailure = new KeystoreSecretBox.MissingKeyException();
        RecordingWriter writer = new RecordingWriter();

        ExpressInstallIdentity.Resolution resolution = ExpressInstallIdentity.resolve(
                "old-envelope", secretBox, writer, new SecureRandom());

        assertTrue(resolution.created);
        assertTrue(ExpressInstallIdentity.isValid(resolution.identity));
        assertEquals("replacement-envelope", writer.encoded);
        assertEquals(resolution.identity.toString(), secretBox.lastPlainText);
    }

    @Test
    public void invalidCiphertextCreatesANewAccountIdentityThatRequiresRebinding()
            throws Exception {
        FakeSecretBox secretBox = new FakeSecretBox();
        secretBox.decryptFailure = new KeystoreSecretBox.InvalidCiphertextException();
        RecordingWriter writer = new RecordingWriter();

        ExpressInstallIdentity.Resolution resolution = ExpressInstallIdentity.resolve(
                "damaged-envelope", secretBox, writer, new SecureRandom());

        assertTrue(resolution.created);
        assertTrue(ExpressInstallIdentity.isValid(resolution.identity));
        assertEquals("replacement-envelope", writer.encoded);
    }

    @Test
    public void invalidDecryptedIdentityCreatesANewAccountThatRequiresRebinding()
            throws Exception {
        FakeSecretBox secretBox = new FakeSecretBox();
        secretBox.decrypted = "{\"userId\":\"invalid\",\"oaid\":\"00\",\"vaid\":\"11\"}";
        RecordingWriter writer = new RecordingWriter();

        ExpressInstallIdentity.Resolution resolution = ExpressInstallIdentity.resolve(
                "valid-envelope", secretBox, writer, new SecureRandom());

        assertTrue(resolution.created);
        assertTrue(ExpressInstallIdentity.isValid(resolution.identity));
        assertEquals("replacement-envelope", writer.encoded);
    }

    @Test
    public void temporaryKeystoreFailurePreservesTheStoredIdentity() {
        FakeSecretBox secretBox = new FakeSecretBox();
        KeyStoreException failure = new KeyStoreException("temporarily unavailable");
        secretBox.decryptFailure = failure;
        RecordingWriter writer = new RecordingWriter();

        Exception thrown = assertThrows(Exception.class, () -> ExpressInstallIdentity.resolve(
                "preserve-this-envelope", secretBox, writer, new SecureRandom()));

        assertSame(failure, thrown);
        assertEquals(0, writer.writes);
    }

    private static final class FakeSecretBox implements ExpressInstallIdentity.SecretBox {
        String decrypted;
        Exception decryptFailure;
        String lastPlainText;

        @Override
        public String decrypt(String encoded) throws Exception {
            if (decryptFailure != null) throw decryptFailure;
            return decrypted;
        }

        @Override
        public String encrypt(String plainText) {
            lastPlainText = plainText;
            return "replacement-envelope";
        }
    }

    private static final class RecordingWriter
            implements ExpressInstallIdentity.EncodedIdentityWriter {
        int writes;
        String encoded;

        @Override
        public boolean write(String value) {
            writes++;
            encoded = value;
            return true;
        }
    }
}
