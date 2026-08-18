package me.pipi.deliveries.model;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;

/** Normalizes Kuaidi100 and OEM track arrays into the native Pipi timeline. */
public final class ExpressTimeline {
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
                    if (detail.isEmpty()) continue;
                    tracks.add(new Track(first(value,
                            "time", "ftime", "date", "logisticsGmtModified"), detail));
                }
            }
        } catch (Throwable ignored) {
            // The persisted timeline may come from an older provider schema. Fall back below.
        }
        LinkedHashMap<String, Track> unique = new LinkedHashMap<>();
        for (Track track : tracks) {
            String key = normalizeText(track.time) + '\u0000' + normalizeText(track.detail);
            unique.putIfAbsent(key, track);
        }
        tracks.clear();
        tracks.addAll(unique.values());
        tracks.sort((left, right) -> Long.compare(parseTime(right.time), parseTime(left.time)));
        ArrayList<Track> collapsed = new ArrayList<>();
        String previousEvent = "";
        for (Track track : tracks) {
            String event = normalizeEvent(track.detail);
            if (!event.isEmpty() && event.equals(previousEvent)) continue;
            collapsed.add(track);
            previousEvent = event;
        }
        tracks.clear();
        tracks.addAll(collapsed);
        if (tracks.isEmpty() && !clean(fallbackDetail).isEmpty()) {
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
     * Incrementally combines a cached timeline with a provider refresh. A timestamp identifies
     * a provider scan bucket, so all refreshed nodes in that second replace the cached bucket
     * while timestamps absent from the refresh remain available offline.
     */
    public static String mergeJson(String cachedJson, String refreshedJson) {
        Buckets cached = Buckets.from(parse(cachedJson, "", ""));
        Buckets refreshed = Buckets.from(parse(refreshedJson, "", ""));
        cached.timed.putAll(refreshed.timed);
        cached.timeless.putAll(refreshed.timeless);

        ArrayList<Track> tracks = new ArrayList<>();
        for (List<Track> bucket : cached.timed.values()) tracks.addAll(bucket);
        tracks.addAll(cached.timeless.values());
        tracks.sort((left, right) -> Long.compare(parseTime(right.time), parseTime(left.time)));
        JSONArray values = new JSONArray();
        for (Track track : tracks) {
            JSONObject value = new JSONObject();
            try {
                value.put("time", track.time);
                value.put("context", track.detail);
                values.put(value);
            } catch (Throwable ignored) {
                // Both values are plain strings; keep any already encoded nodes if a platform
                // JSON implementation unexpectedly rejects one.
            }
        }
        return values.toString();
    }

    private static final class Buckets {
        final LinkedHashMap<String, List<Track>> timed = new LinkedHashMap<>();
        final LinkedHashMap<String, Track> timeless = new LinkedHashMap<>();

        static Buckets from(List<Track> tracks) {
            Buckets result = new Buckets();
            for (Track track : tracks) {
                String time = normalizeText(track.time);
                if (time.isEmpty()) {
                    result.timeless.put(normalizeEvent(track.detail), track);
                } else {
                    result.timed.computeIfAbsent(time, ignored -> new ArrayList<>()).add(track);
                }
            }
            return result;
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
