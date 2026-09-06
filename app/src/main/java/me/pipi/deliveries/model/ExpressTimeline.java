package me.pipi.deliveries.model;

import me.pipi.deliveries.data.TimelineSlot;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;

/** Normalizes Kuaidi100 and OEM track arrays into the native Pipi timeline. */
public final class ExpressTimeline {
    private static final int MAX_PERSISTED_TRACKS = 156;

    public static final class Track {
        public final String time;
        public final String detail;

        Track(String time, String detail) {
            this.time = clean(time);
            this.detail = clean(detail);
        }
    }

    private ExpressTimeline() {}

    public static List<Track> parse(
            String tracksJson, String fallbackTime, String fallbackDetail) {
        ArrayList<Track> tracks = new ArrayList<>();
        ArrayList<RawTrack> rawTracks = new ArrayList<>();
        try {
            Object root = new JSONTokener(clean(tracksJson).isEmpty() ? "[]" : tracksJson)
                    .nextValue();
            JSONArray values = findArray(root);
            if (values != null) {
                for (int index = 0; index < values.length(); index++) {
                    JSONObject value = values.optJSONObject(index);
                    if (value == null) continue;
                    String detail = first(value,
                            "context", "desc", "description", "logisticDetail",
                            "lastLogisticDetail", "message");
                    if (detail.isEmpty()
                            || ExpressStatusNormalizer.isNonEventDetail(detail)) continue;
                    rawTracks.add(new RawTrack(first(value,
                            "time", "ftime", "date", "logisticsGmtModified"), detail, value));
                }
            }
        } catch (Throwable ignored) {
            // The persisted timeline may come from an older provider schema. Fall back below.
        }
        // 同包内同文案、5 分钟内、结构化状态不冲突的节点算同一条（用户定 2026-09-06，三端同 Pipi）；
        // 原来是「相邻同文案不看时间」，会把几小时后重复的真实事件也吞掉。老缓存里的重复也在这里收掉。
        rawTracks.sort((left, right) -> Long.compare(parseTime(right.time), parseTime(left.time)));
        for (RawTrack raw : collapseNearTimeDuplicates(rawTracks)) {
            tracks.add(new Track(raw.time, raw.detail));
        }
        LinkedHashMap<String, Track> unique = new LinkedHashMap<>();
        for (Track track : tracks) {
            String key = normalizeText(track.time) + '\u0000' + normalizeText(track.detail);
            unique.putIfAbsent(key, track);
        }
        tracks.clear();
        tracks.addAll(unique.values());
        tracks.sort((left, right) -> Long.compare(parseTime(right.time), parseTime(left.time)));

        if (tracks.isEmpty() && !clean(fallbackDetail).isEmpty()
                && !ExpressStatusNormalizer.isNonEventDetail(fallbackDetail)) {
            tracks.add(new Track(fallbackTime, fallbackDetail));
        }
        return Collections.unmodifiableList(tracks);
    }

    /** Returns the newest real provider event, skipping errors and state-only placeholder nodes. */
    public static Track latestMeaningful(String tracksJson, StatusSemantic semantic) {
        for (Track track : parse(tracksJson, "", "")) {
            if (!ExpressStatusNormalizer.isHeadlinePlaceholder(track.detail, semantic)) {
                return track;
            }
        }
        return null;
    }

    /**
     * AGENTS §9 / plan R-29 (user decision 2026-09-03, same rule on iOS and Pipi): for an
     * account-projected waybill, a manual provider package (Picker / K100 / KDNiao) with any node
     * earlier than the order's own first timed feed node minus a day belongs to another parcel
     * (reused waybill). The anchor comes only from the account package.
     */
    public static final long FOREIGN_PACKAGE_ANCHOR_SLACK_MS = 24L * 60L * 60L * 1000L;

    public static long foreignPackageAnchorMillis(String accountTracksJson) {
        long earliest = 0L;
        for (RawTrack track : rawTracks(accountTracksJson)) {
            long time = parseTime(track.time);
            if (time > 0L && (earliest == 0L || time < earliest)) earliest = time;
        }
        return earliest > 0L ? earliest - FOREIGN_PACKAGE_ANCHOR_SLACK_MS : 0L;
    }

    public static boolean isForeignPackage(String accountTracksJson, String candidateTracksJson) {
        long anchor = foreignPackageAnchorMillis(accountTracksJson);
        if (anchor <= 0L) return false;
        for (RawTrack track : rawTracks(candidateTracksJson)) {
            long time = parseTime(track.time);
            if (time > 0L && time < anchor) return true;
        }
        return false;
    }

    /** Historical provider failures invalidate their old package-level metadata. */
    public static boolean containsProviderError(String tracksJson) {
        try {
            Object root = new JSONTokener(clean(tracksJson).isEmpty() ? "[]" : tracksJson)
                    .nextValue();
            JSONArray values = findArray(root);
            if (values == null) return false;
            for (int index = 0; index < values.length(); index++) {
                JSONObject value = values.optJSONObject(index);
                if (value == null) continue;
                String detail = first(value,
                        "context", "desc", "description", "logisticDetail",
                        "lastLogisticDetail", "message");
                if (ExpressStatusNormalizer.isProviderErrorDetail(detail)) return true;
            }
        } catch (Throwable ignored) {
            // Malformed history cannot prove that provider error metadata is present.
        }
        return false;
    }

    /**
     * Incrementally combines one provider's cached and refreshed timelines. Refreshed rows own
     * duplicate events, cached rows fill missing metadata, and conflicting structured states at
     * the same timestamp remain separate evidence instead of being rewritten.
     */
    public static String mergeJson(String cachedJson, String refreshedJson) {
        LinkedHashMap<String, RawTrack> merged = new LinkedHashMap<>();
        // The latest successful response owns presentation and receives missing metadata from
        // its own older cache. Conflicting structured states remain separate evidence rows.
        appendRaw(merged, rawTracks(refreshedJson));
        appendRaw(merged, rawTracks(cachedJson));
        ArrayList<RawTrack> tracks = new ArrayList<>(merged.values());
        tracks.sort((left, right) -> Long.compare(parseTime(right.time), parseTime(left.time)));
        tracks = collapseNearTimeDuplicates(tracks);
        tracks = compact(tracks);
        JSONArray values = new JSONArray();
        for (RawTrack track : tracks) {
            values.put(track.value);
        }
        return values.toString();
    }

    /** Bounds durable history while retaining the lifecycle evidence used by query gates. */
    private static ArrayList<RawTrack> compact(ArrayList<RawTrack> tracks) {
        if (tracks.size() <= MAX_PERSISTED_TRACKS) return tracks;
        boolean[] selected = new boolean[tracks.size()];
        for (int index = 0; index < MAX_PERSISTED_TRACKS; index++) selected[index] = true;

        int latestTerminal = -1;
        int earliestStart = -1;
        for (int index = 0; index < tracks.size(); index++) {
            RawTrack track = tracks.get(index);
            if (latestTerminal < 0 && isTerminalBoundary(track)) latestTerminal = index;
            if (isStartBoundary(track)) earliestStart = index;
        }
        retainBoundary(selected, latestTerminal, earliestStart, latestTerminal);
        retainBoundary(selected, earliestStart, earliestStart, latestTerminal);

        ArrayList<RawTrack> compacted = new ArrayList<>(MAX_PERSISTED_TRACKS);
        for (int index = 0; index < tracks.size(); index++) {
            if (selected[index]) compacted.add(tracks.get(index));
        }
        return compacted;
    }

    private static void retainBoundary(
            boolean[] selected, int boundary, int earliestStart, int latestTerminal) {
        if (boundary < 0 || selected[boundary]) return;
        for (int index = MAX_PERSISTED_TRACKS - 1; index > 0; index--) {
            if (!selected[index] || index == earliestStart || index == latestTerminal) continue;
            selected[index] = false;
            selected[boundary] = true;
            return;
        }
    }

    private static boolean isStartBoundary(RawTrack track) {
        StatusSemantic semantic = boundarySemantic(track);
        if (semantic == StatusSemantic.ORDERED || semantic == StatusSemantic.PICKED) {
            return true;
        }
        String text = boundaryText(track);
        return text.contains("已下单") || text.contains("待揽收")
                || text.contains("等待揽收") || text.contains("已揽件")
                || text.contains("已揽收") || text.contains("揽收成功")
                || text.contains("picked") || text.contains("collected")
                || text.contains("order placed");
    }

    private static boolean isTerminalBoundary(RawTrack track) {
        if (boundarySemantic(track).terminal()) return true;
        String text = boundaryText(track);
        return text.contains("已签收") || text.contains("签收成功")
                || text.contains("已完成") || text.contains("已拒收")
                || text.contains("delivered") || text.contains("completed");
    }

    private static String boundaryText(RawTrack track) {
        if (track == null) return "";
        JSONObject value = track.value;
        return normalizeText(track.detail + " "
                + first(value, "logisticsStatusDesc", "status", "statusDesc"))
                .toLowerCase(Locale.ROOT);
    }

    private static StatusSemantic boundarySemantic(RawTrack track) {
        if (track == null || track.value == null) return StatusSemantic.UNKNOWN;
        JSONObject value = track.value;
        String provider = first(value, "_pipiStatusSource").toLowerCase(Locale.ROOT);
        String code = first(value,
                "logisticsStatus", "statusCode", "status", "state", "action");
        String description = first(value,
                "logisticsStatusDesc", "stateName", "statusDesc");
        StatusSemantic semantic = "account".equals(provider)
                || TimelineSlot.isAccount(provider)
                ? StatusSemantic.fromAccountState(code, description)
                : StatusSemantic.fromKuaidi100EventCode(code);
        return semantic == StatusSemantic.UNKNOWN
                ? StatusSemantic.fromStored(code, description) : semantic;
    }

    private static List<RawTrack> rawTracks(String tracksJson) {
        ArrayList<RawTrack> tracks = new ArrayList<>();
        try {
            Object root = new JSONTokener(clean(tracksJson).isEmpty() ? "[]" : tracksJson)
                    .nextValue();
            JSONArray values = findArray(root);
            if (values == null) return Collections.emptyList();
            for (int index = 0; index < values.length(); index++) {
                JSONObject value = values.optJSONObject(index);
                if (value == null) continue;
                String detail = first(value,
                        "context", "desc", "description", "logisticDetail",
                        "lastLogisticDetail", "message");
                String time = first(value,
                        "time", "ftime", "date", "logisticsGmtModified");
                if (ExpressStatusNormalizer.isNonEventDetail(detail)
                        || detail.isEmpty() && time.isEmpty()) continue;
                tracks.add(new RawTrack(
                        time, detail, new JSONObject(value.toString())));
            }
        } catch (Throwable ignored) {
            return Collections.emptyList();
        }
        return tracks;
    }

    private static void appendRaw(
            LinkedHashMap<String, RawTrack> output, List<RawTrack> tracks) {
        for (RawTrack track : tracks) {
            String base = normalizeText(track.time) + '\u0000' + normalizeEvent(track.detail);
            String key = base + '\u0000' + structuredStatusKey(track.value);
            RawTrack existing = output.get(key);
            if (existing == null) {
                String prefix = base + '\u0000';
                for (java.util.Map.Entry<String, RawTrack> entry : output.entrySet()) {
                    if (entry.getKey().startsWith(prefix)
                            && compatibleStructuredStatus(
                            entry.getValue().value, track.value)) {
                        existing = entry.getValue();
                        break;
                    }
                }
            }
            if (existing == null) {
                output.put(key, track);
            } else {
                fillMissingFields(existing.value, track.value);
            }
        }
    }

    private static String structuredStatusKey(JSONObject value) {
        return structuredValue(value, "logisticsStatus") + '\u0001'
                + structuredValue(value, "logisticsStatusDesc") + '\u0001'
                + structuredValue(value, "statusCode") + '\u0001'
                + structuredValue(value, "status") + '\u0001'
                + structuredValue(value, "_pipiStatusSource");
    }

    private static boolean compatibleStructuredStatus(JSONObject left, JSONObject right) {
        for (String key : new String[]{
                "logisticsStatus", "logisticsStatusDesc", "statusCode", "status"
        }) {
            String leftValue = structuredValue(left, key);
            String rightValue = structuredValue(right, key);
            if (!leftValue.isEmpty() && !rightValue.isEmpty()
                    && !leftValue.equals(rightValue)) return false;
        }
        String leftSource = structuredValue(left, "_pipiStatusSource");
        String rightSource = structuredValue(right, "_pipiStatusSource");
        return leftSource.isEmpty() || rightSource.isEmpty() || leftSource.equals(rightSource);
    }

    private static String structuredValue(JSONObject value, String key) {
        if (value == null) return "";
        Object raw = value.opt(key);
        if (!(raw instanceof String) && !(raw instanceof Number)) return "";
        return normalizeText(String.valueOf(raw)).toLowerCase(Locale.ROOT);
    }

    private static void fillMissingFields(JSONObject target, JSONObject source) {
        if (target == null || source == null) return;
        Iterator<String> keys = source.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            Object current = target.opt(key);
            if (target.has(key) && !target.isNull(key)
                    && (!(current instanceof String)
                    || !clean((String) current).isEmpty())) continue;
            try {
                Object value = source.opt(key);
                if (value instanceof JSONObject) {
                    value = new JSONObject(value.toString());
                } else if (value instanceof JSONArray) {
                    value = new JSONArray(value.toString());
                }
                target.put(key, value);
            } catch (Throwable ignored) {
                // Optional provider metadata cannot invalidate a durable tracking node.
            }
        }
    }

    /** 同包内同文案节点的合并窗口（用户定 2026-09-06，三端同 Pipi CROSS_SOURCE_DUPLICATE_WINDOW_SECONDS）。 */
    static final long NEAR_DUPLICATE_WINDOW_MS = 5L * 60L * 1000L;

    /**
     * 与 Pipi TrackTimelinePolicy.collapseNearTimeDuplicates 同法：列表已按新到旧排好，指纹相同、
     * 相距 ≤ 5 分钟、结构化状态不冲突的后一条并进前一条（较新的拥有展示，老的只补空字段）。
     */
    private static ArrayList<RawTrack> collapseNearTimeDuplicates(List<RawTrack> sorted) {
        ArrayList<RawTrack> output = new ArrayList<>();
        for (RawTrack candidate : sorted) {
            RawTrack duplicate = null;
            String fingerprint = fingerprint(candidate.detail);
            long at = parseTime(candidate.time);
            if (!fingerprint.isEmpty() && at > 0L) {
                for (RawTrack existing : output) {
                    long existingAt = parseTime(existing.time);
                    if (existingAt <= 0L || !fingerprint.equals(fingerprint(existing.detail))) continue;
                    if (!compatibleStructuredStatus(existing.value, candidate.value)) continue;
                    if (Math.abs(existingAt - at) <= NEAR_DUPLICATE_WINDOW_MS) {
                        duplicate = existing;
                        break;
                    }
                }
            }
            if (duplicate == null) {
                output.add(candidate);
            } else {
                fillMissingFields(duplicate.value, candidate.value);
            }
        }
        return output;
    }

    /** 与 Pipi TrackTimelinePolicy.fingerprint 同法：NFKC、「您的快件/订单/包裹」归一、去尾标点、去空白。 */
    private static String fingerprint(String detail) {
        return java.text.Normalizer.normalize(clean(detail), java.text.Normalizer.Form.NFKC)
                .replace('\u00a0', ' ')
                .replaceAll("\\s+", " ")
                .trim()
                .replaceFirst("^您的(?:快件|订单|包裹)\\s*", "您的物流")
                .replaceAll("[。.!！?？,，;；、…]+$", "")
                .replaceAll("\\s+", "");
    }

    private static final class RawTrack {
        final String time;
        final String detail;
        final JSONObject value;

        RawTrack(String time, String detail, JSONObject value) {
            this.time = clean(time);
            this.detail = clean(detail);
            this.value = value;
        }
    }

    private static JSONArray findArray(Object node) {
        if (node instanceof JSONArray) return (JSONArray) node;
        if (!(node instanceof JSONObject)) return null;
        JSONObject object = (JSONObject) node;
        String[] keys = {"data", "traces", "details", "packageDyn", "list"};
        for (String key : keys) {
            Object value = object.opt(key);
            if (value instanceof JSONArray) return (JSONArray) value;
            if (value instanceof JSONObject) {
                JSONArray nested = findArray(value);
                if (nested != null) return nested;
            }
            if (value instanceof String) {
                try {
                    JSONArray nested = findArray(new JSONTokener((String) value).nextValue());
                    if (nested != null) return nested;
                } catch (Throwable ignored) {
                    // Try the next known envelope.
                }
            }
        }
        return null;
    }

    private static String first(JSONObject value, String... keys) {
        for (String key : keys) {
            String candidate = clean(value.optString(key, ""));
            if (!candidate.isEmpty() && !"null".equalsIgnoreCase(candidate)) return candidate;
        }
        return "";
    }

    private static long parseTime(String value) {
        SimpleDateFormat parser = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA);
        parser.setLenient(false);
        ParsePosition position = new ParsePosition(0);
        Date parsed = parser.parse(clean(value), position);
        return parsed == null || position.getIndex() != clean(value).length()
                ? 0L : parsed.getTime();
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    private static String normalizeText(String value) {
        return clean(value).replaceAll("\\s+", " ");
    }

    private static String normalizeEvent(String value) {
        return normalizeText(value).replaceAll("[\\s。！!，,；;：:]+$", "");
    }
}
