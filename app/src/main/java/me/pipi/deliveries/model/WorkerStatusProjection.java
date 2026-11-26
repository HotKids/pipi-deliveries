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
    public final boolean orderStageOnly;

    private WorkerStatusProjection(JSONObject value) {
        scope = value.optString("scope");
        semantic = StatusSemantic.valueOf(value.optString("semantic"));
        code = value.optString("code", "");
        text = value.optString("text", "");
        priority = value.optInt("priority", 0);
        eventAtMs = value.optLong("eventAtMs", 0L);
        structured = value.optBoolean("structured", false);
        orderStageOnly = "ORDER".equals(scope) && Boolean.TRUE.equals(value.opt("orderStageOnly"));
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

    /**
     * A timeline node's own projection (用户定 2026-10-01「两边都改」, the reader Pipi's
     * ExpressWorkerStatus.nodeEvidence and iOS status.ts nodeProjection share): structured=false with
     * an empty code says the node carried no enum, so it is absent and the node's raw fields decide.
     * An unrecognised code (non-empty) stays an explicit UNKNOWN. Packet projections use {@link #read}.
     */
    public static WorkerStatusProjection nodeEvidence(JSONObject node) {
        WorkerStatusProjection value = read(node);
        return value == null || (!value.structured && value.code.isEmpty()) ? null : value;
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
            JSONObject json = new JSONObject().put("version", 1).put("scope", scope)
                    .put("semantic", semantic.name()).put("code", code).put("text", text)
                    .put("priority", priority).put("eventAtMs", eventAtMs)
                    .put("structured", structured);
            if (orderStageOnly) json.put("orderStageOnly", true);
            return json;
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
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

    /**
     * The projection the Worker gives a Meizu v6 row whose coarse status is FAILED and whose structured
     * description is a listed customs state ({@link StatusSemantic#meizuFailedDescriptionCode}), for a
     * packet the Worker did not project (owner decision 2026-11-20). Null otherwise.
     */
    public static WorkerStatusProjection meizuFailedDescription(
            JSONObject row, String coarseStatus, long eventAtMs) {
        if (row == null) return null;
        String code = StatusSemantic.meizuFailedDescriptionCode(
                coarseStatus, StatusSemantic.meizuDescription(row));
        if (code.isEmpty()) return null;
        me.pipi.deliveries.data.ExpressStatusLabels table =
                me.pipi.deliveries.data.CarrierRegistry.statusLabels();
        String text = table.subtypeLabel(StatusSemantic.TRANSIT, code);
        if (text.isEmpty()) text = table.label(StatusSemantic.TRANSIT);
        try {
            return read(new JSONObject().put("normalizedStatus", new JSONObject()
                    .put("version", 1).put("scope", "SHIPMENT").put("semantic", "TRANSIT")
                    .put("code", code).put("text", text)
                    .put("priority", table.subtypePriority(StatusSemantic.TRANSIT, code))
                    .put("eventAtMs", Math.max(0L, eventAtMs)).put("structured", true)));
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    public static int priority(ExpressQueryResult result) {
        return result == null || result.workerStatus == null ? 0 : result.workerStatus.priority;
    }
}
