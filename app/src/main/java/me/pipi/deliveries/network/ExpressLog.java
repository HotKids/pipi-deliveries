package me.pipi.deliveries.network;

import android.util.Log;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import me.pipi.deliveries.BuildConfig;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;

/** iOS-compatible diagnostic envelope. Values never include full identities or route credentials. */
public final class ExpressLog {
    public static final String TAG = "PipiExpress";
    private static final DateTimeFormatter CLOCK = DateTimeFormatter.ofPattern("yyyy-MM-dd\'T\'HH:mm:ss.SSS\'Z\'", Locale.ROOT).withZone(ZoneOffset.UTC);
    private static final InheritableThreadLocal<Scope> CURRENT = new InheritableThreadLocal<>();
    private ExpressLog() {}

    public static final class Scope implements AutoCloseable {
        final Scope previous;
        final String flowId;
        final String trigger;
        final String source;
        /** A detail refresh flow, whatever its trigger (an automatic restart is not a pull). */
        final boolean detailRefresh;
        /**
         * Provider stage outcomes of this flow, across the threads it hands work to: answered, failed
         * with an error, or answered with nothing (iOS querySucceeded / queryFailureObserved /
         * emptyResponseObserved).
         */
        final java.util.concurrent.atomic.AtomicInteger stagesSucceeded =
                new java.util.concurrent.atomic.AtomicInteger();
        final java.util.concurrent.atomic.AtomicInteger stagesFailed =
                new java.util.concurrent.atomic.AtomicInteger();
        final java.util.concurrent.atomic.AtomicInteger stagesEmpty =
                new java.util.concurrent.atomic.AtomicInteger();
        Scope(String flowId, String trigger, String source) {
            this(flowId, trigger, source, false);
        }
        Scope(String flowId, String trigger, String source, boolean detailRefresh) {
            previous = CURRENT.get();
            this.flowId = flowId;
            this.trigger = trigger;
            this.source = source;
            this.detailRefresh = detailRefresh;
            CURRENT.set(this);
        }
        /**
         * Why a flow that changed nothing ended, in iOS's detail.refresh.skipped words: a stage
         * answered ({@code unchanged}), one failed ({@code query_failed}), one answered with nothing
         * ({@code empty_response}), or none ran ({@code not_attempted}).
         */
        public String unchangedReason() {
            return stagesSucceeded.get() > 0 ? "unchanged" : stagesFailed.get() > 0 ? "query_failed"
                    : stagesEmpty.get() > 0 ? "empty_response" : "not_attempted";
        }
        @Override public void close() { CURRENT.set(previous); }
    }

    public static boolean hasScope() { return CURRENT.get() != null; }

    public static String newFlowId(String prefix) {
        return prefix + "-" + UUID.randomUUID().toString();
    }

    public static Scope scope(String flowId, String trigger, String source) {
        return new Scope(flowId, trigger, source);
    }

    /**
     * A detail refresh flow (user 2026-09-28): its stages are {@code detail.refresh.stage_*} even when
     * the trigger is not detail_open / detail_pull, as for the refresh restarted when the page returns
     * to the foreground.
     */
    public static Scope detailScope(String flowId, String trigger, String source) {
        return new Scope(flowId, trigger, source, true);
    }

    /**
     * The last four characters of the normalized waybill (upper-case letters and digits only), as
     * iOS and Pipi log it (audit R10; the diagnostic contract's four-alphanumeric waybillTail).
     */
    public static String tail(String value) {
        String clean = value == null ? ""
                : value.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", "");
        return clean.length() <= 4 ? clean : clean.substring(clean.length() - 4);
    }

    public static String format(long atMs, String severity, String event, Object... keyValues) {
        LinkedHashMap<String, Object> fields = new LinkedHashMap<>();
        Scope scope = CURRENT.get();
        if (scope != null) {
            fields.put("flowId", scope.flowId);
            fields.put("trigger", scope.trigger);
            fields.put("source", scope.source);
        }
        fields.put("clientBuild", BuildConfig.VERSION_CODE);
        for (int index = 0; index + 1 < keyValues.length; index += 2) {
            if (keyValues[index + 1] != null) fields.put(String.valueOf(keyValues[index]), keyValues[index + 1]);
        }
        StringBuilder text = new StringBuilder(CLOCK.format(Instant.ofEpochMilli(atMs)))
                .append(' ').append(severity).append(' ').append(event);
        for (Map.Entry<String, Object> field : fields.entrySet()) {
            text.append(' ').append(field.getKey()).append('=').append(value(field.getValue()));
        }
        return text.toString();
    }

    private static String value(Object input) {
        String text = String.valueOf(input);
        if (text.matches("[^\\s=\"]+")) return text;
        return "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r") + "\"";
    }

    public static void write(String event, Object... fields) {
        emit(format(System.currentTimeMillis(), event.endsWith(".failed") ? "WARNING" : "INFO", event, fields));
    }

    /** A WARNING whose event name does not end in ".failed" (e.g. a dropped foreign package). */
    public static void warning(String event, Object... fields) {
        emit(format(System.currentTimeMillis(), "WARNING", event, fields));
    }

    /**
     * Audit R10 (user 2026-09-25): the events iOS and Pipi record at ERROR — a refresh round that
     * failed (iOS refresh.failed, Pipi EXPRESS_REFRESH_FAILED), the account list failing (iOS
     * account.sync.failed) and a failed manual query (Pipi EXPRESS_MANUAL_QUERY_COMPLETED failed).
     */
    public static void error(String event, Object... fields) {
        emit(format(System.currentTimeMillis(), "ERROR", event, fields));
    }

    /** iOS logger.ts SAFE_FAILURE_CODES: the Worker codes a failure line may carry as failureCode. */
    private static final java.util.Set<String> SAFE_FAILURE_CODES = new java.util.HashSet<>(
            java.util.Arrays.asList("attestation_rejected", "body_too_large", "carrier_mismatch",
                    "carrier_unknown", "delegation_unavailable", "detail_route_not_reconstructable",
                    "expired_request", "forbidden", "gateway_not_configured", "invalid_company_code",
                    "invalid_content_length", "invalid_express_identity", "invalid_express_interface",
                    "invalid_express_operation", "invalid_flight_operation", "invalid_input",
                    "invalid_jd_app_route", "invalid_json", "invalid_movie_operation",
                    "invalid_order_id", "invalid_primary_routes", "invalid_push_receipt",
                    "invalid_query", "invalid_railway_operation", "invalid_response",
                    "invalid_route_credential", "invalid_timeline_query", "invalid_upstream_response",
                    "invalid_waybill", "invalid_weather_operation", "key_activated_elsewhere",
                    "key_store_unavailable", "method_not_allowed", "network", "not_found",
                    "phone_tail", "phone_verification_required", "rate_limited", "rejected",
                    "replay_store_unavailable", "replayed_request", "unauthorized",
                    "upstream_rejected", "upstream_business_error", "upstream_unavailable"));

    /** A cause chain is read at most this far: Java allows chains that loop (A -> B -> A). */
    private static final int MAX_CAUSE_STEPS = 16;

    /**
     * iOS logger.ts diagnosticErrorDetails (user 2026-09-28): {@code fields} followed by the failure's
     * errorCategory in the iOS words, its gateway httpStatus and its whitelisted Worker failureCode;
     * never the exception's class name or text.
     */
    public static Object[] errorDetails(Throwable failure, Object... fields) {
        GatewayHttpException gateway = gatewayFailure(failure);
        int status = gateway == null ? 0 : gateway.status();
        String code = gateway == null ? "" : gateway.gatewayCode();
        Object[] details = java.util.Arrays.copyOf(fields, fields.length + 6);
        details[fields.length] = "errorCategory";
        details[fields.length + 1] = errorCategory(failure);
        details[fields.length + 2] = "httpStatus";
        details[fields.length + 3] = status >= 100 && status <= 599 ? status : null;
        details[fields.length + 4] = "failureCode";
        details[fields.length + 5] = SAFE_FAILURE_CODES.contains(code) ? code : null;
        return details;
    }

    /**
     * iOS logger.ts classifyDiagnosticError, read on a Java failure: a cancelled query is
     * {@code cancelled} (a deadline that ran out is {@code timeout}), a transport failure with no
     * user-safe text is {@code network}; everything else takes iOS's order of checks.
     */
    static String errorCategory(Throwable failure) {
        if (failure == null) return "unknown";
        String message = failure.getMessage() == null ? "" : failure.getMessage().toLowerCase(Locale.ROOT);
        if (failure instanceof InterruptedException) {
            return message.contains("timed out") ? "timeout" : "cancelled";
        }
        // A gateway answer is judged by its status first: iOS words its message from that status,
        // while Lite's message for 504 says 超时 and a Worker body may supply its own text.
        GatewayHttpException gateway = gatewayFailure(failure);
        int status = gateway == null ? 0 : gateway.status();
        if (status == 401 || status == 403) return "authorization";
        if (status == 408) return "timeout";
        if (status == 429) return "rate_limited";
        if (status >= 500) return "service";
        if (message.contains("取消")) return "cancelled";
        Throwable cause = failure;
        for (int step = 0; cause != null && step < MAX_CAUSE_STEPS; step++, cause = cause.getCause()) {
            if (cause.getClass().getSimpleName().toLowerCase(Locale.ROOT).contains("timeout")) return "timeout";
            if (cause.getCause() == cause) break;
        }
        if (message.contains("超时")) return "timeout";
        if (message.contains("响应与当前运单不匹配") || message.contains("物流信息与当前运单不符")) return "protocol";
        if (failure.getClass().getSimpleName().toLowerCase(Locale.ROOT).contains("kuaidi100")
                || message.contains("暂无轨迹") || message.contains("无法识别")) return "no_result";
        if (message.contains("已不在列表") || message.contains("已从列表中移除")) return "removed";
        if (message.contains("状态已更新")) return "state_changed";
        if (message.contains("服务暂时不可用")) return "service";
        if (message.contains("网络") || message.contains("连接")) return "network";
        if (message.contains("token") || message.contains("access key") || message.contains("授权")) {
            return "authorization";
        }
        if (message.contains("保存") || message.contains("storage")) return "storage";
        if (message.contains("手机号") || message.contains("验证码")) return "validation";
        cause = failure;
        for (int step = 0; cause != null && step < MAX_CAUSE_STEPS; step++, cause = cause.getCause()) {
            if (cause instanceof java.io.IOException) return "network";
            if (cause.getCause() == cause) break;
        }
        return "unknown";
    }

    private static GatewayHttpException gatewayFailure(Throwable failure) {
        Throwable cause = failure;
        for (int step = 0; cause != null && step < MAX_CAUSE_STEPS; step++, cause = cause.getCause()) {
            if (cause instanceof GatewayHttpException) return (GatewayHttpException) cause;
            if (cause.getCause() == cause) break;
        }
        return null;
    }

    /**
     * Audit R10 (user 2026-09-25): inside a detail refresh flow a stage is reported as iOS and Pipi
     * report it, {@code detail.refresh.stage_*}, not {@code manual.source.*}.
     */
    private static final java.util.Set<String> DETAIL_STAGE_OUTCOMES = new java.util.HashSet<>(
            java.util.Arrays.asList("started", "succeeded", "failed", "skipped"));

    private static boolean inDetailRefresh() {
        Scope scope = CURRENT.get();
        return scope != null && (scope.detailRefresh
                || "detail_open".equals(scope.trigger) || "detail_pull".equals(scope.trigger));
    }

    public static void line(String iface, String level, String provider, String outcome, Object... fields) {
        Scope scope = CURRENT.get();
        if (scope != null && !"http".equals(level)) {
            if ("succeeded".equals(outcome)) scope.stagesSucceeded.incrementAndGet();
            else if ("failed".equals(outcome)) {
                (failedWithError(fields) ? scope.stagesFailed : scope.stagesEmpty).incrementAndGet();
            }
        }
        emit(lineText(System.currentTimeMillis(), iface, level, provider, outcome, fields));
    }

    /** A failure line carrying an error (its category, or a cancellation) rather than an empty answer. */
    private static boolean failedWithError(Object... fields) {
        for (int index = 0; index + 1 < fields.length; index += 2) {
            String key = String.valueOf(fields[index]);
            if ("errorCategory".equals(key)) return true;
            if ("reason".equals(key) && "cancelled".equals(fields[index + 1])) return true;
        }
        return false;
    }

    static String lineText(long atMs, String iface, String level, String provider, String outcome,
            Object... fields) {
        String event = "v6_query".equals(level)
                && ("request".equals(outcome) || "response".equals(outcome) || "parsed".equals(outcome))
                ? "manual.meizu." + outcome
                : "detail".equals(level) ? "detail.refresh." + outcome
                : "v5_list".equals(level) || "v6_list".equals(level) ? "account.sync." + outcome
                : "v5_query".equals(level) ? "refresh.stage." + outcome
                : "manual.source." + outcome;
        // The transport's own lines stay out of the stage vocabulary.
        boolean detailStage = event.startsWith("manual.source.") && !"http".equals(level)
                && DETAIL_STAGE_OUTCOMES.contains(outcome) && inDetailRefresh();
        if (detailStage) event = "detail.refresh.stage_" + outcome;
        Object[] mapped = new Object[fields.length + 12];
        mapped[0] = "interface"; mapped[1] = iface == null || iface.isEmpty() ? null : iface;
        mapped[2] = "level"; mapped[3] = level;
        mapped[4] = "timelineProvider"; mapped[5] = level;
        mapped[6] = "sourceProvider"; mapped[7] = source(provider, false);
        mapped[8] = "result"; mapped[9] = outcome;
        mapped[10] = "stage"; mapped[11] = level;
        for (int index = 0; index + 1 < fields.length; index += 2) {
            String key = String.valueOf(fields[index]);
            if ("tail".equals(key)) key = "waybillTail";
            else if ("nodes".equals(key)) key = "effectiveTrackCount";
            else if ("elapsedMs".equals(key)) key = "durationMs";
            else if ("semantic".equals(key)) key = "statusSemantic";
            else if ("reason".equals(key)) key = "failed".equals(outcome) ? "errorCategory"
                    // Pipi's detail.refresh.stage_skipped names its reason gateReason.
                    : detailStage && "skipped".equals(outcome) ? "gateReason" : "skipReason";
            mapped[index + 12] = key;
            mapped[index + 13] = fields[index + 1];
        }
        return format(atMs, "failed".equals(outcome) ? "WARNING" : "INFO", event, mapped);
    }

    private static void emit(String message) {
        try {
            if (message.contains(" ERROR ")) Log.e(TAG, message);
            else if (message.contains(" WARNING ")) Log.w(TAG, message);
            else Log.i(TAG, message);
        }
        catch (RuntimeException ignored) { /* Logging cannot affect a query or persistence. */ }
    }

    public static void notificationSkipped(ExpressItem current, String reason) {
        if (current != null) write("notification.skipped", "skipReason", reason,
                "waybillTail", tail(current.displayWaybill()), "statusSemantic", current.semantic,
                "statusEventAtMs", current.statusEventTime, "sourceProvider", source(current.sourceProvider, current.manuallyAdded));
    }

    /** T23: the obligation is kept and delivered once the row's carrier is matched. */
    public static void notificationDeferred(ExpressItem current, String reason) {
        if (current != null) write("notification.deferred", "skipReason", reason,
                "waybillTail", tail(current.displayWaybill()), "statusSemantic", current.semantic,
                "statusEventAtMs", current.statusEventTime, "sourceProvider", source(current.sourceProvider, current.manuallyAdded));
    }

    public static void retentionRejected(ExpressQueryResult result, String reason) {
        if (result != null) write("retention.rejected", "skipReason", reason,
                "waybillTail", tail(result.waybill), "statusSemantic", result.semantic,
                "statusEventAtMs", result.statusEventTime, "sourceProvider", source(result.sourceProvider, false));
    }

    public static void notificationDecided(ExpressItem previous, ExpressItem current, boolean deferred) {
        if (previous == null || current == null) return;
        write("notification.decided", "waybillTail", tail(current.displayWaybill()),
                "sourceProvider", source(current.sourceProvider, current.manuallyAdded),
                "previousStatusSemantic", previous.semantic, "statusSemantic", current.semantic,
                "previousStatusEventAtMs", previous.statusEventTime, "statusEventAtMs", current.statusEventTime,
                "detailChanged", !previous.latestDetail.equals(current.latestDetail), "deferred", deferred);
    }

    public static void manualCommitSkipped(String reason, String waybill, int writes) {
        write("manual.query.skipped", "waybillTail", tail(waybill), "skipReason", reason, "writes", writes);
    }

    public static String source(String sourceProvider, boolean manuallyAdded) {
        if (manuallyAdded) return "manual";
        String value = sourceProvider == null ? "" : sourceProvider.trim().toLowerCase(Locale.ROOT);
        return "shunfeng".equals(value) ? "sfexpress" : value;
    }
}
