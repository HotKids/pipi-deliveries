package me.pipi.deliveries.data;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class ExpressRepositoryPhoneAssociationTest {
    @Test
    public void fullAndUniqueMaskedPhonesMatch() {
        assertTrue(ExpressRepository.matchesPhoneAssociation(
                "13800138000", "13800138000", false));
        assertTrue(ExpressRepository.matchesPhoneAssociation(
                "****8000", "13800138000", true));
        assertTrue(ExpressRepository.matchesPhoneAssociation(
                "+86 13800138000", "13800138000", false));
    }

    @Test
    public void ambiguousOrDifferentTailDoesNotMatch() {
        assertFalse(ExpressRepository.matchesPhoneAssociation(
                "****8000", "13800138000", false));
        assertFalse(ExpressRepository.matchesPhoneAssociation(
                "****1111", "13800138000", true));
        assertFalse(ExpressRepository.matchesPhoneAssociation(
                "", "13800138000", true));
    }
}
