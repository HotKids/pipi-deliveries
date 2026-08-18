package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;

import java.nio.charset.StandardCharsets;

import org.junit.Test;

public final class GatewayHttpErrorsTest {
    @Test
    public void keepsSafeGatewayMessageBeforeStatusFallback() {
        assertEquals("验证码错误，请重新输入", GatewayHttpErrors.forResponse(
                response(401, "{\"message\":\"验证码错误，请重新输入\"}"), "验证失败").getMessage());
    }

    @Test
    public void mapsGatewayStatusWithoutLeakingInternalBody() {
        assertEquals("请求验证失败，请稍后重试", GatewayHttpErrors.forResponse(
                response(401, "{\"error\":\"signature_invalid\"}"), "验证失败").getMessage());
        assertEquals("当前请求受限，请稍后重试", GatewayHttpErrors.forResponse(
                response(403, "{}"), "验证失败").getMessage());
        assertEquals("请求过于频繁，请稍后再试", GatewayHttpErrors.forResponse(
                response(429, "{}"), "验证失败").getMessage());
        assertEquals("请求超时，请稍后重试", GatewayHttpErrors.forResponse(
                response(504, "{}"), "验证失败").getMessage());
        assertEquals("服务暂时不可用，请稍后重试", GatewayHttpErrors.forResponse(
                response(502, "{\"message\":\"upstream timeout\"}"), "验证失败").getMessage());
    }

    @Test
    public void rejectsUnsafeOrSensitiveResponseText() {
        assertEquals("验证失败", GatewayHttpErrors.forResponse(response(
                400, "{\"message\":\"https://internal.example/token/123456\"}"),
                "验证失败").getMessage());
        assertEquals("手机号后四位为***，请确认", GatewayHttpErrors.forResponse(response(
                400, "{\"message\":\"手机号后四位为8098，请确认\"}"),
                "验证失败").getMessage());
    }

    @Test
    public void keepsBusinessFailuresSafeAfterA200Response() throws Exception {
        assertEquals("验证码错误", GatewayHttpErrors.forPayload(
                new org.json.JSONObject("{\"message\":\"验证码错误\"}"), "验证失败")
                .getMessage());
        assertEquals("验证失败", GatewayHttpErrors.forPayload(
                new org.json.JSONObject("{\"message\":\"internal Exception at host\"}"),
                "验证失败").getMessage());
    }

    @Test
    public void transportFailureUsesNetworkMessage() {
        assertEquals("网络异常，请稍后重试", GatewayHttpErrors.networkFailure().getMessage());
    }

    @Test
    public void malformedSuccessPayloadUsesOnlyTheCallerFallback() {
        try {
            GatewayHttpErrors.parseObject(response(200, "<html>internal failure</html>"),
                    "查询失败，请稍后重试");
            org.junit.Assert.fail("Expected malformed response");
        } catch (IllegalStateException expected) {
            assertEquals("查询失败，请稍后重试", expected.getMessage());
        }
    }

    private static HttpClient.Response response(int status, String body) {
        return new HttpClient.Response(status, body.getBytes(StandardCharsets.UTF_8));
    }
}
