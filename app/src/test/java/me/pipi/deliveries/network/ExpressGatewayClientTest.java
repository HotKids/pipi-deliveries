package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class ExpressGatewayClientTest {
    @Test
    public void signatureCoversTheGatewayRoute() throws Exception {
        assertEquals(
                "3307996c3754f45d440c7a5f1a75d4084759f94e2e2eb3164c7c7a98e2024d94",
                ExpressGatewayClient.hmacSha256Hex(
                        "key", ExpressGatewayClient.canonicalRequest(
                                1700000000L,
                                "0123456789abcdef0123456789abcdef",
                                "/api/express/classify",
                                "{}")));
        assertFalse(ExpressGatewayClient.hmacSha256Hex(
                "key", ExpressGatewayClient.canonicalRequest(
                        1700000000L,
                        "0123456789abcdef0123456789abcdef",
                        "/api/express/classify",
                        "{}"))
                .equals(ExpressGatewayClient.hmacSha256Hex(
                        "key", ExpressGatewayClient.canonicalRequest(
                                1700000000L,
                                "0123456789abcdef0123456789abcdef",
                                "/api/express/detail",
                                "{}"))));
    }

    @Test
    public void sharedGatewayRequiresAPlainHttpsBaseUrl() {
        assertTrue(ExpressGatewayClient.isTrustedGatewayUrl(
                "https://pipi-gateway.hotki.de"));
        assertTrue(ExpressGatewayClient.isTrustedGatewayUrl("https://example.com/path/"));
        assertFalse(ExpressGatewayClient.isTrustedGatewayUrl("http://example.com"));
        assertFalse(ExpressGatewayClient.isTrustedGatewayUrl("https://user:pass@example.com"));
        assertFalse(ExpressGatewayClient.isTrustedGatewayUrl("https://example.com?target=other"));
        assertFalse(ExpressGatewayClient.isTrustedGatewayUrl("https://example.com/#fragment"));
    }
}
