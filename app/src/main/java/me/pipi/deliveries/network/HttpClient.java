package me.pipi.deliveries.network;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Map;

/** Small bounded HTTPS transport shared by all delivery sources. */
final class HttpClient {
    private static final int MAX_BYTES = 2 * 1024 * 1024;

    private HttpClient() {}

    static Response get(String url) throws Exception {
        return execute(url, "GET", null, null, true, Collections.emptyMap());
    }

    static Response postForm(String url, String body, boolean redirects) throws Exception {
        return execute(url, "POST", "application/x-www-form-urlencoded; charset=UTF-8",
                body.getBytes(StandardCharsets.UTF_8), redirects, Collections.emptyMap());
    }

    static Response postJson(String url, String body) throws Exception {
        return execute(url, "POST", "application/json; charset=UTF-8",
                body.getBytes(StandardCharsets.UTF_8), true, Collections.emptyMap());
    }

    static Response postJson(String url, String body, Map<String, String> headers)
            throws Exception {
        return postJson(url, body, headers, true);
    }

    static Response postJson(
            String url, String body, Map<String, String> headers, boolean redirects)
            throws Exception {
        return execute(url, "POST", "application/json; charset=UTF-8",
                body.getBytes(StandardCharsets.UTF_8), redirects, headers);
    }

    private static Response execute(String url, String method, String contentType,
                                    byte[] body, boolean redirects,
                                    Map<String, String> headers) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setRequestMethod(method);
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(20_000);
            connection.setInstanceFollowRedirects(redirects);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Charset", "UTF-8");
            for (Map.Entry<String, String> header : headers.entrySet()) {
                connection.setRequestProperty(header.getKey(), header.getValue());
            }
            // Match the accepted Volley request profile. Some OEM endpoints gate SMS traffic by
            // the platform Dalvik user agent; a product-specific UA can be accepted at HTTP level
            // while silently skipping the downstream SMS send.
            String platformAgent = System.getProperty("http.agent", "");
            if (platformAgent != null && !platformAgent.isEmpty()) {
                connection.setRequestProperty("User-Agent", platformAgent);
            }
            if (body != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", contentType);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(body);
                }
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 400
                    ? connection.getInputStream() : connection.getErrorStream();
            return new Response(status, readBounded(stream));
        } finally {
            connection.disconnect();
        }
    }

    private static byte[] readBounded(InputStream input) throws Exception {
        if (input == null) return new byte[0];
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int count;
            while ((count = stream.read(buffer)) != -1) {
                total += count;
                if (total > MAX_BYTES) throw new IllegalStateException("Response is too large");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    static final class Response {
        final int status;
        final byte[] body;

        Response(int status, byte[] body) {
            this.status = status;
            this.body = body == null ? new byte[0] : body;
        }

        boolean successful() {
            return status >= 200 && status < 300;
        }

        String utf8() {
            return new String(body, StandardCharsets.UTF_8);
        }
    }
}
