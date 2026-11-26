package me.pipi.deliveries.notification;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * The shared PromotedNotificationPublisher logs a key by its namespace and framework id only (G-HIGH-19 in Pipi,
 * mirrored to Lite with G-LOW-16); Lite's own NotificationKey supplies the same label.
 */
public final class NotificationKeyLogLabelTest {
    @Test public void theLogLabelKeepsTheNamespaceAndFrameworkIdOnly() {
        assertEquals("express.live/0x45000001", NotificationKey.singleton("express.live", 0x45000001).logLabel());
        assertEquals("express.live/0x2a", NotificationKey.persisted("express.live:SYNTHETIC0901", 42).logLabel());
        assertEquals("plain/0x7", NotificationKey.persisted("plain", 7).logLabel());
        // toString is unchanged: dismissal persistence and tests still read the full label.
        assertEquals("express.live:singleton/0x45000001",
                NotificationKey.singleton("express.live", 0x45000001).toString());
    }
}
