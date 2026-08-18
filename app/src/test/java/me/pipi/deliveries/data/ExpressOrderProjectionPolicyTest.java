package me.pipi.deliveries.data;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class ExpressOrderProjectionPolicyTest {
    @Test
    public void lateProjectionCannotRecreateADeletedSourceOrDisplayWaybill() {
        assertTrue(ExpressRepository.canSaveOrderProjection(false, false));
        assertFalse(ExpressRepository.canSaveOrderProjection(true, false));
        assertFalse(ExpressRepository.canSaveOrderProjection(false, true));
        assertFalse(ExpressRepository.canSaveOrderProjection(true, true));
    }
}
