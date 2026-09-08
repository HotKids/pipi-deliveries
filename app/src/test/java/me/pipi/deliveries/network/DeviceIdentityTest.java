package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class DeviceIdentityTest {
    @Test
    public void generatedIdentityIsFifteenDigitLuhnImei() {
        for (int attempt = 0; attempt < 100; attempt++) {
            String value = DeviceIdentity.generateImei();
            assertEquals(15, value.length());
            assertTrue(value.matches("\\d{15}"));
            assertTrue(DeviceIdentity.validImei(value));
        }
    }

    @Test
    public void hiddenDiscoveryPhoneIsNormalizedBeforeItIsPersisted() {
        assertEquals("13800138000", ExpressDiscoveryClient.normalizedPhone("138 0013 8000"));
    }

    @Test(expected = IllegalArgumentException.class)
    public void hiddenDiscoveryRejectsInvalidPhoneBeforeSchedulingSync() {
        ExpressDiscoveryClient.normalizedPhone("12345");
    }
}
