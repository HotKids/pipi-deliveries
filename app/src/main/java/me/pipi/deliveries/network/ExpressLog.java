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
        Scope(String flowId, String trigger, String source) {
            previous = CURRENT.get();
            this.flowId = flowId;
            this.trigger = trigger;
            this.source = source;
            CURRENT.set(this);
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

    public static String tail(String value) {
        String clean = value == null ? "" : value.trim();
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

    public static void line(String iface, String level, String provider, String outcome, Object... fields) {
        String event = "v6_query".equals(level)
                && ("request".equals(outcome) || "response".equals(outcome) || "parsed".equals(outcome))
                ? "manual.meizu." + outcome
                : "detail".equals(level) ? "detail.refresh." + outcome
                : "v5_list".equals(level) || "v6_list".equals(level) ? "account.sync." + outcome
                : "v5_query".equals(level) ? "refresh.stage." + outcome
                : "manual.source." + outcome;
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
            else if ("reason".equals(key)) key = "failed".equals(outcome) ? "errorCategory" : "skipReason";
            mapped[index + 12] = key;
            mapped[index + 13] = fields[index + 1];
        }
        write(event, mapped);
    }

    private static void emit(String message) {
        try { if (message.contains(" WARNING ")) Log.w(TAG, message); else Log.i(TAG, message); }
        catch (RuntimeException ignored) { /* Logging cannot affect a query or persistence. */ }
    }

    public static void notificationSkipped(ExpressItem current, String reason) {
        if (current != null) write("notification.skipped", "skipReason", reason,
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
