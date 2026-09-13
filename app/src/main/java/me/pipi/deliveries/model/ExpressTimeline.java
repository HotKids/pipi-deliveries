package me.pipi.deliveries.model;

import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.data.TimelineSlot;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;

/** Normalizes Kuaidi100 and OEM track arrays into the native Pipi timeline. */
public final class ExpressTimeline {
    public static final class Track {
        public final String time;
        public final String detail;
        public final long epochMillis;

        Track(String time, String detail) {
            this.time = clean(time);
            this.detail = clean(detail);
            this.epochMillis = parseTime(this.time);
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
        rawTracks.sort((left, right) -> Long.compare(right.epochMillis, left.epochMillis));
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

    /** Only the latest nodes' provider enums can contradict presentation; prose is not evidence. */
    public static List<StatusSemantic> latestTrackStatuses(String tracksJson, String provider) {
        List<RawTrack> tracks = rawTracks(tracksJson);
        long latest = 0L;
        for (RawTrack track : tracks) latest = Math.max(latest, track.epochMillis);
        if (latest <= 0L) return Collections.emptyList();
        ArrayList<StatusSemantic> statuses = new ArrayList<>();
        for (RawTrack track : tracks) {
            if (track.epochMillis != latest || track.detail.isEmpty()) continue;
            String source = first(track.value, "_pipiStatusSource");
            if (source.isEmpty()) source = provider;
            String code = first(track.value, "statusCode", "logisticsStatus", "status", "state", "action");
            WorkerStatusProjection normalized = WorkerStatusProjection.read(track.value);
            if (normalized != null) { statuses.add(normalized.semantic); continue; }
            StatusSemantic semantic = TimelineSlot.isAccount(source) || "account".equals(source)
                    ? StatusSemantic.fromAccountState(code, "")
                    : StatusSemantic.fromKuaidi100EventCode(code);
            if (semantic == StatusSemantic.UNKNOWN) semantic = StatusSemantic.fromStored(code, "");
            statuses.add(semantic);
        }
        return statuses;
    }

    /**
     * AGENTS §9 / plan R-29 (user decision 2026-09-03, same rule on iOS and Pipi): for an
     * account-projected waybill, a manual provider package (Online / K100 / KDNiao) with any node
     * earlier than the order's own first timed feed node minus a day belongs to another parcel
     * (reused waybill). The anchor comes only from the account package.
     */
    public static final long FOREIGN_PACKAGE_ANCHOR_SLACK_MS = 24L * 60L * 60L * 1000L;

    public static long foreignPackageAnchorMillis(String accountTracksJson) {
        long earliest = 0L;
        int timed = 0;
        for (RawTrack track : rawTracks(accountTracksJson)) {
            long time = track.epochMillis;
            if (time <= 0L) continue;
            timed++;
            if (earliest == 0L || time < earliest) earliest = time;
        }
        // 锚的是 feed 的**第一条**节点——前提是 feed 里真的有这一票自己的起点。签收之后账号 feed
        // 往往只剩最近几条（派送、签收），起点早被它自己截掉了：拿这种摘要的最早一条当锚，这一票
        // 从揽收开始的历史整包会被判成别人的包裹丢掉（用户 2026-09-08 报，三端同改）。
        if (timed <= 0 || !hasOriginBoundary(accountTracksJson)) return 0L;
        return earliest > 0L ? earliest - FOREIGN_PACKAGE_ANCHOR_SLACK_MS : 0L;
    }

    public static long accountListOriginAtMillis(String tracksJson) {
        long anchor = foreignPackageAnchorMillis(tracksJson);
        return anchor > 0L ? anchor + FOREIGN_PACKAGE_ANCHOR_SLACK_MS : 0L;
    }

    /** Only a timed order or pickup node proves the feed's origin. */
    private static boolean hasOriginBoundary(String tracksJson) {
        for (RawTrack track : rawTracks(tracksJson)) {
            if (track.epochMillis > 0L
                    && Kuaidi100TimelinePolicy.containsTimelineOrigin(track.value, "")) return true;
        }
        return false;
    }

    public static boolean isForeignPackage(String accountTracksJson, String candidateTracksJson) {
        return isForeignPackage(foreignPackageAnchorMillis(accountTracksJson), candidateTracksJson);
    }

    public static boolean isForeignPackage(long anchor, String candidateTracksJson) {
        if (anchor <= 0L) return false;
        for (RawTrack track : rawTracks(candidateTracksJson)) {
            long time = track.epochMillis;
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
        tracks.sort((left, right) -> Long.compare(right.epochMillis, left.epochMillis));
        tracks = collapseNearTimeDuplicates(tracks);
        JSONArray values = new JSONArray();
        for (RawTrack track : tracks) {
            values.put(track.value);
        }
        return values.toString();
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
            String fingerprint = candidate.fingerprint;
            long at = candidate.epochMillis;
            if (!fingerprint.isEmpty() && at > 0L) {
                for (RawTrack existing : output) {
                    long existingAt = existing.epochMillis;
                    if (existingAt <= 0L || !fingerprint.equals(existing.fingerprint)) continue;
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
        final long epochMillis;
        final String fingerprint;

        RawTrack(String time, String detail, JSONObject value) {
            this.time = clean(time);
            this.detail = clean(detail);
            this.value = value;
            this.epochMillis = parseTime(this.time);
            this.fingerprint = fingerprint(this.detail);
        }
    }

    public static JSONArray findArray(Object node) {
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

    public static long parseTime(String value) {
        return ExpressTimeCodec.parse(value);
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
