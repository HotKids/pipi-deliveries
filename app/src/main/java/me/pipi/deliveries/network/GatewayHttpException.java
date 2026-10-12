package me.pipi.deliveries.network;

/**
 * A gateway answer that was not 2xx (user 2026-09-28): the same user-safe message and type callers
 * already handle, plus the HTTP status and the Worker's own error code, so diagnostics can say what
 * failed (iOS GatewayError) instead of printing a class name.
 */
public final class GatewayHttpException extends IllegalStateException {
    private final int status;
    private final String gatewayCode;

    GatewayHttpException(String message, int status, String gatewayCode) {
        super(message);
        this.status = status;
        this.gatewayCode = gatewayCode == null ? "" : gatewayCode;
    }

    /** The response's HTTP status. */
    public int status() {
        return status;
    }

    /** The Worker's {@code error} code, lower case; empty when the body carried none or an unsafe one. */
    public String gatewayCode() {
        return gatewayCode;
    }
}
