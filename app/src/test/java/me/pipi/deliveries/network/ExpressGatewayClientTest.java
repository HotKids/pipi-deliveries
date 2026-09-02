package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class ExpressGatewayClientTest {
    @Test
    public void signatureCanonicalRequestCoversMethodRouteAndBody() throws Exception {
        assertEquals(
                "1700000000000\n01234567-89ab-cdef-0123-456789abcdef\nPOST\n"
                        + "/api/express/classify\n"
                        + "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
                GatewaySessionSigner.canonicalRequest(
                        "1700000000000",
                        "01234567-89ab-cdef-0123-456789abcdef",
                        "/api/express/classify",
                        "{}".getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    @Test
    public void sharedGatewayRequiresAPlainHttpsBaseUrl() {
        assertTrue(ExpressGatewayClient.isTrustedGatewayUrl(
                "https://pipiassistant.app"));
        assertTrue(ExpressGatewayClient.isTrustedGatewayUrl("https://example.com/path/"));
        assertFalse(ExpressGatewayClient.isTrustedGatewayUrl("http://example.com"));
        assertFalse(ExpressGatewayClient.isTrustedGatewayUrl("https://user:pass@example.com"));
        assertFalse(ExpressGatewayClient.isTrustedGatewayUrl("https://example.com?target=other"));
        assertFalse(ExpressGatewayClient.isTrustedGatewayUrl("https://example.com/#fragment"));
    }
}
