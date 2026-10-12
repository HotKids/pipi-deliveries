package me.pipi.deliveries.network;

import java.nio.charset.StandardCharsets;

/** Gateway failures as the Worker sends them, for tests outside this package. */
public final class GatewayFailureFixture {
    private GatewayFailureFixture() {}

    /**
     * The Worker's answer when the Xiaomi list upstream hits its 20 s cap (worker.js fetch handler:
     * 502 {"error":"upstream_unavailable"}), turned into the exception the account sync throws.
     */
    public static IllegalStateException upstreamUnavailable() {
        return GatewayHttpErrors.forResponse(new HttpClient.Response(502,
                "{\"error\":\"upstream_unavailable\"}".getBytes(StandardCharsets.UTF_8)), "同步失败，请稍后重试");
    }
}
