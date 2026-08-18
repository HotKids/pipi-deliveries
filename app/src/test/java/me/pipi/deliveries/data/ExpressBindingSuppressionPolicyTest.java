package me.pipi.deliveries.data;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public final class ExpressBindingSuppressionPolicyTest {
    @Test
    public void suppressedWaybillBlocksOnlyAnUnresolvedAutomaticAssociation() {
        assertTrue(ExpressRepository.shouldSuppressAutomaticImport(true, ""));
        assertFalse(ExpressRepository.shouldSuppressAutomaticImport(
                true, "13800138000"));
        assertFalse(ExpressRepository.shouldSuppressAutomaticImport(false, ""));
    }

    @Test
    public void suppressionPhoneEvidenceIsNormalizedAndNonPlaintext() {
        String local = ExpressRepository.phoneAssociationHash("13800138000");
        String countryCode = ExpressRepository.phoneAssociationHash("+86 138 0013 8000");

        assertTrue(local.matches("[0-9a-f]{64}"));
        assertTrue(local.equals(countryCode));
        assertFalse(local.contains("13800138000"));
        assertNotEquals(local, ExpressRepository.phoneAssociationHash("13900139000"));
    }

    @Test
    public void unbindSuppressionIsSourceAndPhoneScopedInsteadOfGlobal() throws Exception {
        String database = source("ExpressDatabase.java");
        String repository = source("ExpressRepository.java");
        int unbindStart = repository.indexOf(
                "public void unbindPhone(String phone, String syncSource)");
        int unbindEnd = repository.indexOf(
                "private static boolean ownerBelongsToBindingSource", unbindStart);
        String unbind = repository.substring(unbindStart, unbindEnd);

        assertTrue(database.contains(
                "PRIMARY KEY(waybill_hash,binding_source,phone_hash)"));
        assertTrue(unbind.contains("insertUnboundPhoneAssociation"));
        assertFalse(unbind.contains("insertTombstone"));
        assertTrue(repository.contains(
                "\"binding_source=? AND phone_hash=?\""));
        assertTrue(repository.contains("&& rejectsUnboundAutomaticWrite("));
        assertTrue(repository.contains("clearUnboundPhoneAssociations("));
    }

    private static String source(String name) throws Exception {
        Path path = Path.of("src/main/java/me/pipi/deliveries/data", name);
        if (!Files.isRegularFile(path)) {
            path = Path.of("app/src/main/java/me/pipi/deliveries/data", name);
        }
        return Files.readString(path, StandardCharsets.UTF_8);
    }
}
