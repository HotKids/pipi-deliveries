package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

import org.junit.Test;

/**
 * 用户 2026-09-28：failures carry iOS diagnosticErrorDetails — errorCategory in the iOS words, the
 * gateway httpStatus and the whitelisted Worker failureCode — never the exception's class name.
 */
public final class ExpressLogErrorDetailsTest {
    @Test public void aWorkerUpstreamFailureIsServiceWithItsStatusAndCode() {
        String line = line(GatewayFailureFixture.upstreamUnavailable());
        assertTrue(line, line.endsWith(" errorCategory=service httpStatus=502 failureCode=upstream_unavailable"));
        assertFalse(line, line.contains("Exception"));
    }

    @Test public void gatewayStatusesTakeTheIosCategories() {
        assertEquals("authorization", category(response(401, "{\"error\":\"unauthorized\"}")));
        assertEquals("authorization", category(response(403, "{}")));
        assertEquals("timeout", category(response(408, "{}")));
        assertEquals("rate_limited", category(response(429, "{\"error\":\"rate_limited\"}")));
        assertEquals("service", category(response(504, "{}")));
        String unsafe = line(GatewayHttpErrors.forResponse(new HttpClient.Response(400,
                "{\"error\":\"private token 123\"}".getBytes(StandardCharsets.UTF_8)), "查询失败，请稍后重试"));
        assertTrue(unsafe, unsafe.contains(" httpStatus=400") && !unsafe.contains("failureCode="));
        String unlisted = line(response(400, "{\"error\":\"made_up_code\"}"));
        assertFalse(unlisted, unlisted.contains("failureCode="));
    }

    @Test public void transportFailuresAreTimeoutOrNetwork() {
        assertEquals("timeout", ExpressLog.errorCategory(
                GatewayHttpErrors.networkFailure(new SocketTimeoutException("Read timed out"))));
        assertEquals("network", ExpressLog.errorCategory(
                GatewayHttpErrors.networkFailure(new ConnectException("refused"))));
        assertEquals("network", ExpressLog.errorCategory(new java.io.IOException("unexpected end of stream")));
        String line = line(GatewayHttpErrors.networkFailure(new SocketTimeoutException("Read timed out")));
        assertFalse(line, line.contains("httpStatus=") || line.contains("failureCode="));
    }

    @Test public void aCancelledQueryIsCancelledAndARunOutDeadlineIsTimeout() {
        assertEquals("cancelled", ExpressLog.errorCategory(new InterruptedException("Express query cancelled")));
        assertEquals("timeout", ExpressLog.errorCategory(new InterruptedException("Express query timed out")));
        assertEquals("unknown", ExpressLog.errorCategory(new IllegalStateException("All delivery sources failed")));
    }

    @Test public void theLeadingFieldsComeFirst() {
        Object[] details = ExpressLog.errorDetails(GatewayFailureFixture.upstreamUnavailable(), "stage", "enrichment");
        assertEquals(Arrays.asList("stage", "enrichment", "errorCategory", "service", "httpStatus", 502,
                "failureCode", "upstream_unavailable"), Arrays.asList(details));
    }

    /** A cause chain that loops back on itself (A -> B -> A) still ends: every walk stops after 16 causes. */
    @Test(timeout = 10_000L) public void aCyclicCauseChainEnds() {
        RuntimeException first = new RuntimeException("first");
        RuntimeException second = new RuntimeException("second", first);
        first.initCause(second);
        assertEquals("unknown", ExpressLog.errorCategory(first));
        assertTrue(line(first).endsWith(" errorCategory=unknown"));
    }

    /** Only the first 16 throwables of a chain are read: a gateway answer buried deeper is not reported. */
    @Test public void onlyTheFirstSixteenCausesAreRead() {
        Throwable near = GatewayFailureFixture.upstreamUnavailable();
        for (int depth = 1; depth < 16; depth++) near = new RuntimeException("wrapped", near);
        assertEquals("service", ExpressLog.errorCategory(near));
        assertTrue(line(near), line(near).endsWith(" httpStatus=502 failureCode=upstream_unavailable"));
        Throwable deep = new RuntimeException("wrapped", near);
        assertEquals("unknown", ExpressLog.errorCategory(deep));
        assertFalse(line(deep), line(deep).contains("httpStatus="));
        Throwable deepTimeout = new java.net.SocketTimeoutException("Read timed out");
        for (int depth = 0; depth < 16; depth++) deepTimeout = new RuntimeException("wrapped", deepTimeout);
        assertEquals("unknown", ExpressLog.errorCategory(deepTimeout));
    }

    private static GatewayHttpException response(int status, String body) {
        return GatewayHttpErrors.forResponse(new HttpClient.Response(status,
                body.getBytes(StandardCharsets.UTF_8)), "查询失败，请稍后重试");
    }

    private static String category(Throwable failure) {
        return ExpressLog.errorCategory(failure);
    }

    private static String line(Throwable failure) {
        return ExpressLog.format(0L, "ERROR", "refresh.account.failed", ExpressLog.errorDetails(failure));
    }
}
