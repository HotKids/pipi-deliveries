package me.pipi.deliveries.data;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.ExpressTimeline;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/** User-deleted automatic records wait for a genuine, accepted trajectory update. */
final class ExpressAutomaticDeletionFence {
    static final String TABLE = "automatic_deletion_fence";
    static final String CREATE = "CREATE TABLE IF NOT EXISTS " + TABLE
            + "(ticket TEXT PRIMARY KEY NOT NULL,nodes TEXT NOT NULL)";

    private ExpressAutomaticDeletionFence() {}

    static void remember(SQLiteDatabase db, String ticket, Collection<ExpressQueryResult> evidence, long now) {
        Map<String, Node> known = new LinkedHashMap<>();
        List<Node> previous = read(db, ticket);
        if (previous != null) for (Node node : previous) known.put(node.key(), node);
        for (ExpressQueryResult packet : evidence)
            for (Node node : nodes(packet, false, now)) known.put(node.key(), node);
        JSONArray stored = new JSONArray();
        try {
            for (Node node : known.values()) stored.put(new JSONObject().put("at", node.at).put("text", node.text));
        } catch (JSONException impossible) { throw new IllegalStateException(impossible); }
        ContentValues values = new ContentValues(); values.put("ticket", ticket); values.put("nodes", stored.toString());
        if (db.insertWithOnConflict(TABLE, null, values, SQLiteDatabase.CONFLICT_REPLACE) == -1L)
            throw new IllegalStateException("Automatic deletion fence was not saved");
    }

    static boolean blocks(SQLiteDatabase db, String ticket, ExpressQueryResult packet, boolean eligible, long now) {
        List<Node> baseline = read(db, ticket);
        if (baseline == null) return false;
        if (!eligible) return true;
        long latest = 0L;
        for (Node node : baseline) latest = Math.max(latest, node.at);
        for (Node candidate : nodes(packet, true, now)) {
            // Undated changes and older history fills cannot establish the update being awaited.
            if (candidate.at <= 0L || candidate.at < latest) continue;
            boolean known = false;
            for (Node node : baseline) {
                if (node.text.equals(candidate.text)
                        && Math.abs(node.at - candidate.at) <= ExpressTimeline.NEAR_DUPLICATE_WINDOW_MS) {
                    known = true; break;
                }
            }
            if (!known) return false;
        }
        return true;
    }

    static void release(SQLiteDatabase db, String ticket) {
        if (read(db, ticket) != null && db.delete(TABLE, "ticket=?", new String[]{ticket}) != 1)
            throw new IllegalStateException("Automatic deletion fence was not released");
    }

    private static List<Node> nodes(ExpressQueryResult packet, boolean ownSourceOnly, long now) {
        List<Node> result = new ArrayList<>();
        if (packet == null) return result;
        String tracks = packet.tracksJson;
        if (ownSourceOnly) tracks = ownSourceTracks(packet);
        for (ExpressTimeline.Track track : ExpressTimeline.parse(tracks, "", "")) {
            if (track.epochMillis > now || ExpressStatusNormalizer.isProviderErrorDetail(track.detail)) continue;
            result.add(new Node(track.epochMillis, digest(ExpressTimeline.fingerprint(track.detail))));
        }
        if (!ownSourceOnly) for (ExpressTimeline.Track track : ExpressTimeline.parse("[]", packet.latestTime, packet.latestDetail)) {
            if (track.epochMillis <= 0L || track.epochMillis > now
                    || ExpressStatusNormalizer.isHeadlinePlaceholder(track.detail, packet.semantic)) continue;
            result.add(new Node(track.epochMillis, digest(ExpressTimeline.fingerprint(track.detail))));
        }
        return result;
    }

    private static String ownSourceTracks(ExpressQueryResult packet) {
        try {
            JSONArray input = ExpressTimeline.findArray(new JSONTokener(packet.tracksJson).nextValue());
            JSONArray output = new JSONArray();
            if (input == null) return "[]";
            String owner = TimelineSlot.normalize(packet.timelineProvider);
            for (int i = 0; i < input.length(); i++) {
                JSONObject row = input.optJSONObject(i);
                if (row == null) continue;
                String source = row.optString("_pipiStatusSource", "").trim().toLowerCase(java.util.Locale.ROOT);
                // The v6 subscription adapter tags its own account nodes as "meizu".
                if (!source.isEmpty() && !owner.equals(TimelineSlot.normalize(source))
                        && !(TimelineSlot.V6_LIST.equals(owner) && "meizu".equals(source))) continue;
                output.put(row);
            }
            return output.toString();
        } catch (JSONException malformed) { return "[]"; }
    }

    private static List<Node> read(SQLiteDatabase db, String ticket) {
        try (Cursor row = db.query(TABLE, new String[]{"nodes"}, "ticket=?", new String[]{ticket}, null, null, null)) {
            if (!row.moveToFirst()) return null;
            JSONArray stored = new JSONArray(row.getString(0));
            List<Node> nodes = new ArrayList<>();
            for (int i = 0; i < stored.length(); i++) {
                JSONObject node = stored.getJSONObject(i);
                nodes.add(new Node(node.getLong("at"), node.getString("text")));
            }
            return nodes;
        } catch (JSONException malformed) { throw new IllegalStateException("Automatic deletion fence is unavailable", malformed); }
    }

    private static String digest(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(bytes.length * 2);
            for (byte element : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", element & 0xff));
            return result.toString();
        } catch (NoSuchAlgorithmException unavailable) { throw new IllegalStateException("SHA-256 unavailable", unavailable); }
    }

    private static final class Node {
        final long at; final String text;
        Node(long at, String text) { this.at = at; this.text = text; }
        String key() { return at + ":" + text; }
    }
}
