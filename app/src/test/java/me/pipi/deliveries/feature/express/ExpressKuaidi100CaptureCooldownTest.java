package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class ExpressKuaidi100CaptureCooldownTest {
    @Test
    public void thirtyMinutesPerWaybillLikeTheOtherClients() {
        long now = 1_000_000_000L;
        assertTrue(ExpressKuaidi100CaptureCooldown.due(0L, now));
        assertFalse(ExpressKuaidi100CaptureCooldown.due(now - 5L * 60L * 1000L, now));
        assertTrue(ExpressKuaidi100CaptureCooldown.due(
                now - ExpressKuaidi100CaptureCooldown.COOLDOWN_MS, now));
        // 时钟回拨不锁死。
        assertTrue(ExpressKuaidi100CaptureCooldown.due(now + 60_000L, now));
    }
}
