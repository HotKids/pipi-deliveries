package me.pipi.deliveries.network;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Map;

/** App-local HTTP adapter for shared {@link Kuaidi100CarrierDetector}. */
final class Kuaidi100CarrierTransport {
    private Kuaidi100CarrierTransport() {}

    static Kuaidi100CarrierDetector.Transport defaultTransport(String userAgent) {
        Map<String, String> headers = Collections.singletonMap("User-Agent", userAgent);
        return (url, cancellation) -> cancellation == null
                ? HttpClient.postForm(url, "", false, headers)
                : HttpClient.postForm(url, "", false, cancellation, headers);
    }

    static Exception networkFailure(IOException failure) {
        return GatewayHttpErrors.networkFailure(failure);
    }

    static RuntimeException httpFailure(Kuaidi100CarrierDetector.HttpResponse response) {
        if (response instanceof HttpClient.Response) {
            return GatewayHttpErrors.forResponse((HttpClient.Response) response, "暂时无法识别承运商");
        }
        HttpClient.Response adapted = response == null ? null
                : new HttpClient.Response(
                        response.status(),
                        response.utf8().getBytes(StandardCharsets.UTF_8));
        return GatewayHttpErrors.forResponse(adapted, "暂时无法识别承运商");
    }
}
