package me.pipi.deliveries.model;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Versioned Worker result; clients never interpret its upstream code or display text. */
public final class WorkerStatusProjection {
    public final String scope;
    public final StatusSemantic semantic;
    public final String code;
    public final String text;
    public final int priority;
    public final long eventAtMs;
    public final boolean structured;

    private WorkerStatusProjection(JSONObject value) {
        scope = value.optString("scope");
        semantic = StatusSemantic.valueOf(value.optString("semantic"));
        code = value.optString("code", "");
        text = value.optString("text", "");
        priority = value.optInt("priority", 0);
        eventAtMs = value.optLong("eventAtMs", 0L);
        structured = value.optBoolean("structured", false);
    }

    public static WorkerStatusProjection read(JSONObject packet) {
        JSONObject value = packet == null ? null : packet.optJSONObject("normalizedStatus");
        if (value == null || !(value.opt("version") instanceof Number)
                || value.optDouble("version") != 1.0
                || !(value.opt("code") instanceof String)
                || !(value.opt("text") instanceof String)
                || !("ORDER".equals(value.optString("scope"))
                || "SHIPMENT".equals(value.optString("scope")))
                || !(value.opt("structured") instanceof Boolean)
                || !(value.opt("priority") instanceof Number)
                || value.optDouble("priority", -1) != value.optInt("priority", -1)
                || value.optInt("priority", -1) < 0
                || !(value.opt("eventAtMs") instanceof Number)
                || value.optDouble("eventAtMs", -1) != value.optLong("eventAtMs", -1)
                || value.optLong("eventAtMs", -1) < 0) return null;
        try { return new WorkerStatusProjection(value); }
        catch (IllegalArgumentException invalidSemantic) { return null; }
    }

    public static WorkerStatusProjection cached(String tracks) {
        try {
            Object value = new JSONTokener(tracks).nextValue();
            return value instanceof JSONObject ? read((JSONObject) value) : null;
        } catch (Exception invalid) { return null; }
    }

    public boolean matches(StatusSemantic state, long time) {
        return semantic == state && eventAtMs == time;
    }

    public JSONObject toJson() {
        try {
            return new JSONObject().put("version", 1).put("scope", scope)
                    .put("semantic", semantic.name()).put("code", code).put("text", text)
                    .put("priority", priority).put("eventAtMs", eventAtMs)
                    .put("structured", structured);
        } catch (Exception impossible) { throw new IllegalStateException(impossible); }
    }

    /** The safe projection is a packet sidecar, never a synthetic timeline event. */
    public static String attach(String tracks, WorkerStatusProjection status) {
        try {
            Object value = new JSONTokener(tracks == null || tracks.isEmpty() ? "[]" : tracks).nextValue();
            if (value instanceof JSONObject) {
                JSONObject packet = (JSONObject) value;
                packet.remove("normalizedStatus");
                if (status != null) packet.put("normalizedStatus", status.toJson());
                return packet.toString();
            }
            if (status == null) return tracks;
            return new JSONObject().put("data", value instanceof JSONArray ? value : new JSONArray())
                    .put("normalizedStatus", status.toJson()).toString();
        } catch (Exception invalid) { throw new IllegalArgumentException("Invalid timeline cache", invalid); }
    }

    public static int priority(ExpressQueryResult result) {
        return result == null || result.workerStatus == null ? 0 : result.workerStatus.priority;
    }
}
