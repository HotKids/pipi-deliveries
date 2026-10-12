package me.pipi.deliveries.data;

import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.json.JSONArray;
import org.json.JSONObject;

import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.WorkerStatusProjection;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

/**
 * Removes observed shopping-review events from a known JD carrier parcel, except a review that is
 * the parcel's first signing (user decisions 2026-09-27, same on all four clients), which stays an
 * ordinary node.
 *
 * <p>A review can be the first signing only when its own packet reports a structured signed
 * status: the packet's structured COMPLETED, or a node whose own status is signed (its Worker
 * projection when structured, otherwise its raw account status enum; never text). In a packet
 * without one, every review is removed. Otherwise a review is removed only when the parcel was
 * signed strictly earlier: signed since = the earliest of the caller's prior stored structured
 * completion (the row's or the same slot's status time stored before this packet, 0 when none is
 * in scope) and the packet's signed nodes ({@code eventAtMs}, else the node's time); review nodes
 * themselves count. The packet's own package status time is not earlier evidence: an interface-5
 * package clock is its newest node, the review itself. A timed review is removed when it is later
 * than that time, an untimed one whenever the parcel was signed. Times are read on the collapsed
 * timeline: a twin pushed again within five minutes is judged at the newer copy's time, which is the
 * time the timeline shows (same on all four clients).</p>
 */
final class JingDongOrderCompletionPolicy {
    private static final Pattern NUMBERED = Pattern.compile(
            "^您的订单(\\d+)已完成,感谢您对京东的支持,欢迎再次光临\\.期待您对本次购物进行评价\\.?$");
    private static final Pattern PRODUCT = Pattern.compile(
            "^您的订单\\[[^\\]]+\\]已完成,\\d+京豆等您拿,完成评价即有机会获得,不要错过呦!?$");

    private JingDongOrderCompletionPolicy() {}

    static boolean matches(String detail, String orderId) {
        String text = detail == null ? "" : detail.replaceAll("\\s+", "")
                .replace('，', ',').replace('。', '.').replace('！', '!');
        Matcher numbered = NUMBERED.matcher(text);
        if (numbered.matches()) {
            String knownOrder = orderId == null ? "" : orderId.trim();
            return !knownOrder.matches("\\d+") || numbered.group(1).equals(knownOrder);
        }
        return PRODUCT.matcher(text).matches();
    }

    /** Cheap pre-check: both templates contain 评; escaped text is parsed rather than guessed. */
    static boolean mayHaveCandidate(ExpressQueryResult packet) {
        return packet != null && (mayHold(packet.latestDetail) || mayHold(packet.tracksJson));
    }

    /** Whether the packet holds a review node or headline at all. */
    static boolean hasCandidate(ExpressQueryResult packet, String orderId) {
        if (!mayHaveCandidate(packet)) return false;
        if (matches(packet.latestDetail, orderId)) return true;
        try {
            JSONArray tracks = ExpressTimeline.findArray(
                    new org.json.JSONTokener(packet.tracksJson).nextValue());
            for (int index = 0; index < tracks.length(); index++) {
                JSONObject track = tracks.optJSONObject(index);
                if (track != null && matches(detailOf(track), orderId)) return true;
            }
        } catch (Exception invalidTimeline) {
            return false;
        }
        return false;
    }

    /** Whether {@link #clean} with this prior signing removes a review timed exactly at {@code time}. */
    static boolean removesAt(ExpressQueryResult packet, String orderId, long priorSignedAt, long time,
            ExpressQueryResult... priorPackets) {
        if (packet == null || time <= 0L || !mayHaveCandidate(packet)) return false;
        try {
            JSONArray tracks = ExpressTimeline.findArray(
                    new org.json.JSONTokener(packet.tracksJson).nextValue());
            long[] shown = ExpressTimeline.displayedTimes(tracks);
            boolean signed = packetSigned(packet, tracks);
            long nodesSince = signedSince(tracks, shown, 0L, packet.timelineProvider);
            if (matches(packet.latestDetail, orderId)
                    && time == ExpressSourcePolicy.parseEventTime(packet.latestTime)
                    && removes(time, signed, since(packet, tracks, priorPackets, packet.latestDetail, null,
                    time, priorSignedAt, nodesSince))) return true;
            for (int index = 0; index < tracks.length(); index++) {
                JSONObject track = tracks.optJSONObject(index);
                if (track == null || time != eventTime(track) || !matches(detailOf(track), orderId)) continue;
                long shownAt = Math.max(time, shown[index]);
                if (removes(shownAt, signed, since(packet, tracks, priorPackets, detailOf(track), track,
                        shownAt, priorSignedAt, nodesSince))) {
                    return true;
                }
            }
        } catch (Exception invalidTimeline) {
            return false;
        }
        return false;
    }

    /**
     * The same packet without any review node, for the rankings and gates that treat a review kept
     * as the first signing as a temporary node (user 2026-09-27). Status fields stay as they are;
     * only the nodes and the headline they derive go. Never stored.
     */
    static ExpressQueryResult withoutCandidates(ExpressQueryResult packet, String orderId) {
        if (!mayHaveCandidate(packet)) return packet;
        JSONArray kept = new JSONArray();
        boolean removed = false;
        try {
            JSONArray tracks = ExpressTimeline.findArray(
                    new org.json.JSONTokener(packet.tracksJson).nextValue());
            for (int index = 0; index < tracks.length(); index++) {
                JSONObject track = tracks.optJSONObject(index);
                if (track == null) continue;
                if (matches(detailOf(track), orderId)) {
                    removed = true;
                    continue;
                }
                kept.put(track);
            }
        } catch (Exception invalidTimeline) {
            return packet;
        }
        if (!removed && !matches(packet.latestDetail, orderId)) return packet;
        ExpressTimeline.Track latest = latest(kept);
        return new ExpressQueryResult(packet.waybill, packet.courierCode, packet.companyName,
                packet.semantic, packet.statusEventTime, latest == null ? "" : latest.time,
                latest == null ? "" : latest.detail,
                WorkerStatusProjection.attach(kept.toString(), packet.workerStatus), packet.detailUrl,
                packet.phone, packet.timelineProvider, packet.routeInterface,
                packet.routeCredential, packet.sourceProvider, packet.carrierNormalization)
                .withCarrierIdentityEvidence(packet.carrierIdentityEvidence)
                .withManualStatusEvidence(packet.statusDescription, packet.structuredStatusEvidence)
                .withAccountListMetadata(packet.senderPhone, packet.listOriginAtMs);
    }

    /** No prior stored status in scope: only the packet's own signed nodes count. */
    static ExpressQueryResult clean(
            ExpressQueryResult packet, String orderId) {
        return clean(packet, orderId, 0L);
    }

    /** {@code priorSignedAt}: the prior stored structured completion time, or 0. */
    static ExpressQueryResult clean(
            ExpressQueryResult packet, String orderId, long priorSignedAt) {
        return clean(packet, orderId, priorSignedAt, new ExpressQueryResult[0]);
    }

    /**
     * {@code priorPackets}: the packets stored before this one (the row's own, the slot's), whose headline and
     * nodes show what the prior completion was (用户 2026-09-28「修，按规则保留」, see {@link #anchorCounts}).
     */
    static ExpressQueryResult clean(ExpressQueryResult packet, String orderId, long priorSignedAt,
            ExpressQueryResult... priorPackets) {
        if (packet == null) return null;
        if (!mayHaveCandidate(packet)) return packet;
        JSONArray kept = new JSONArray();
        boolean removed = false;
        boolean removedHeadline = false;
        boolean removedStatus = false;
        StatusSemantic survivingSemantic = StatusSemantic.UNKNOWN;
        long survivingStatusTime = 0L;
        try {
            JSONArray tracks = ExpressTimeline.findArray(
                    new org.json.JSONTokener(packet.tracksJson).nextValue());
            boolean headlineCandidate = matches(packet.latestDetail, orderId);
            boolean anyCandidate = headlineCandidate;
            for (int index = 0; !anyCandidate && index < tracks.length(); index++) {
                JSONObject track = tracks.optJSONObject(index);
                anyCandidate = track != null && matches(detailOf(track), orderId);
            }
            if (!anyCandidate) return packet;
            // Evidence is read only once a review is present.
            boolean signed = packetSigned(packet, tracks);
            long[] shown = ExpressTimeline.displayedTimes(tracks);
            long nodesSince = signedSince(tracks, shown, 0L, packet.timelineProvider);
            long headlineAt = ExpressSourcePolicy.parseEventTime(packet.latestTime);
            removedHeadline = headlineCandidate && removes(headlineAt, signed, since(packet, tracks,
                    priorPackets, packet.latestDetail, null, headlineAt, priorSignedAt, nodesSince));
            removedStatus = removedHeadline && (packet.statusEventTime <= 0L
                    || ExpressSourcePolicy.parseEventTime(packet.latestTime) == packet.statusEventTime);
            for (int index = 0; index < tracks.length(); index++) {
                JSONObject track = tracks.optJSONObject(index);
                if (track == null) continue;
                String detail = detailOf(track);
                long time = eventTime(track);
                // A twin is judged at the time the collapsed timeline shows it (the newer copy's).
                long shownAt = Math.max(time, shown[index]);
                if (matches(detail, orderId) && removes(shownAt, signed, since(packet, tracks, priorPackets,
                        detail, track, shownAt, priorSignedAt, nodesSince))) {
                    removed = true;
                    removedStatus |= time > 0L && time == packet.statusEventTime;
                    continue;
                }
                kept.put(track);
                String origin = first(track, "_pipiStatusSource");
                if (origin.isEmpty()) origin = packet.timelineProvider;
                String code = first(track, "stateNum", "logisticsStatus", "statusCode", "status", "state");
                String description = first(track, "stateText", "logisticsStatusDesc", "stateName", "stateDesc");
                WorkerStatusProjection normalized = WorkerStatusProjection.nodeEvidence(track);
                StatusSemantic state = normalized != null ? normalized.semantic : TimelineSlot.V5_QUERY.equals(TimelineSlot.normalize(origin))
                        ? StatusSemantic.fromAccountState(code, description) : StatusSemantic.UNKNOWN;
                if (state == StatusSemantic.UNKNOWN && normalized == null) {
                    state = StatusSemantic.fromStored(code, description);
                }
                if (state != StatusSemantic.UNKNOWN && time > survivingStatusTime) {
                    survivingSemantic = state;
                    survivingStatusTime = time;
                }
            }
        } catch (Exception invalidTimeline) {
            // A malformed cache is not evidence for removing unrelated provider content.
            return packet;
        }
        if (!removed && !removedHeadline) return packet;
        List<ExpressTimeline.Track> remaining = ExpressTimeline.parse(kept.toString(), "", "");
        ExpressTimeline.Track latest = latest(kept);
        // Hiding a review cannot revoke an independent structured completion.
        boolean replaceStatus = (remaining.isEmpty() || removedStatus)
                && !(packet.semantic == StatusSemantic.COMPLETED && packet.structuredStatusEvidence);
        StatusSemantic semantic = replaceStatus ? survivingSemantic : packet.semantic;
        long statusTime = replaceStatus ? survivingStatusTime : packet.statusEventTime;
        return new ExpressQueryResult(packet.waybill, packet.courierCode, packet.companyName,
                semantic, statusTime, latest == null ? "" : latest.time,
                latest == null ? "" : latest.detail, WorkerStatusProjection.attach(kept.toString(),
                        replaceStatus ? null : packet.workerStatus), packet.detailUrl,
                packet.phone, packet.timelineProvider, packet.routeInterface,
                packet.routeCredential, packet.sourceProvider, packet.carrierNormalization)
                .withCarrierIdentityEvidence(packet.carrierIdentityEvidence)
                .withManualStatusEvidence(replaceStatus ? semantic.label : packet.statusDescription,
                        replaceStatus ? survivingSemantic != StatusSemantic.UNKNOWN
                                : packet.structuredStatusEvidence)
                .withAccountListMetadata(packet.senderPhone, packet.listOriginAtMs);
    }

    private static ExpressTimeline.Track latest(JSONArray kept) {
        List<ExpressTimeline.Track> remaining = ExpressTimeline.parse(kept.toString(), "", "");
        for (ExpressTimeline.Track track : remaining) {
            if (ExpressSourcePolicy.parseEventTime(track.time) > 0L) return track;
        }
        return remaining.isEmpty() ? null : remaining.get(0);
    }

    /** The packet's own structured signed status: its structured COMPLETED, or a signed node. */
    private static boolean packetSigned(ExpressQueryResult packet, JSONArray tracks) {
        if (packet.semantic == StatusSemantic.COMPLETED && packet.structuredStatusEvidence) return true;
        for (int index = 0; index < tracks.length(); index++) {
            JSONObject track = tracks.optJSONObject(index);
            if (track != null && nodeSigned(track, packet.timelineProvider)) return true;
        }
        return false;
    }

    /** Earliest signing the prior stored status and this packet's own signed nodes prove, or 0. */
    private static long signedSince(JSONArray tracks, long[] shown, long priorSignedAt,
            String packetProvider) {
        long since = Math.max(0L, priorSignedAt);
        for (int index = 0; index < tracks.length(); index++) {
            JSONObject track = tracks.optJSONObject(index);
            if (track == null || !nodeSigned(track, packetProvider)) continue;
            WorkerStatusProjection status = WorkerStatusProjection.read(track);
            long own = eventTime(track);
            long signedAt = status != null && status.structured && status.eventAtMs > 0L
                    ? status.eventAtMs : own;
            // Measured on the collapsed timeline: a copy folded into a newer twin signs at the
            // newer copy's time, so it never counts as an earlier signing against its own twin.
            if (shown[index] > own) signedAt = Math.max(signedAt, shown[index]);
            if (signedAt > 0L && (since <= 0L || signedAt < since)) since = signedAt;
        }
        return since;
    }

    /**
     * The earliest signing before the review {@code reviewDetail} shown at {@code reviewAt}: its packet's signed
     * nodes and, when it counts, the prior stored completion.
     */
    private static long since(ExpressQueryResult packet, JSONArray tracks, ExpressQueryResult[] priorPackets,
            String reviewDetail, JSONObject review, long reviewAt, long priorSignedAt, long nodesSince) {
        if (!anchorCounts(packet, tracks, priorPackets, reviewDetail, review, reviewAt, priorSignedAt)) {
            return nodesSince;
        }
        return nodesSince > 0L ? Math.min(nodesSince, priorSignedAt) : priorSignedAt;
    }

    /**
     * 用户 2026-09-28「修，按规则保留」：a prior stored completion that is itself a near-duplicate copy of the
     * review being judged is no earlier signing. It is one when the review is shown no more than five minutes
     * after it and what sits at that second, in this packet or the packets stored before it, is a copy of the
     * review: the same fingerprint and no conflicting structured status, the collapse's own criteria. A
     * different node there, nothing there, or the review more than five minutes later keeps it earlier signing
     * evidence.
     */
    private static boolean anchorCounts(ExpressQueryResult packet, JSONArray tracks,
            ExpressQueryResult[] priorPackets, String reviewDetail, JSONObject review, long reviewAt,
            long anchor) {
        if (anchor <= 0L) return false;
        if (reviewAt <= 0L || reviewAt < anchor
                || reviewAt - anchor > ExpressTimeline.NEAR_DUPLICATE_WINDOW_MS) return true;
        int atAnchor = nodesAtAnchor(packet, tracks, reviewDetail, review, anchor);
        if (priorPackets != null) {
            for (ExpressQueryResult prior : priorPackets) {
                if (atAnchor < 0 || prior == null) continue;
                JSONArray priorTracks;
                try {
                    priorTracks = ExpressTimeline.findArray(
                            new org.json.JSONTokener(prior.tracksJson).nextValue());
                } catch (Exception invalidTimeline) {
                    priorTracks = null;
                }
                atAnchor = Math.min(atAnchor, nodesAtAnchor(prior, priorTracks, reviewDetail, review, anchor));
            }
        }
        return atAnchor != 0;
    }

    /** What {@code packet} has at the anchor's second: 1 nothing, 0 only copies of the review, -1 another node. */
    private static int nodesAtAnchor(ExpressQueryResult packet, JSONArray tracks, String reviewDetail,
            JSONObject review, long anchor) {
        int result = 1;
        String headline = packet == null ? "" : packet.latestDetail == null ? "" : packet.latestDetail.trim();
        if (!headline.isEmpty()
                && ExpressSourcePolicy.parseEventTime(packet.latestTime) / 1000L == anchor / 1000L) {
            if (!ExpressTimeline.sameEventText(headline, null, reviewDetail, review)) return -1;
            result = 0;
        }
        for (int index = 0; tracks != null && index < tracks.length(); index++) {
            JSONObject track = tracks.optJSONObject(index);
            if (track == null || eventTime(track) / 1000L != anchor / 1000L) continue;
            String detail = detailOf(track);
            if (detail.isEmpty()) continue;
            if (!ExpressTimeline.sameEventText(detail, track, reviewDetail, review)) return -1;
            result = 0;
        }
        return result;
    }

    /** The node's own signed status: a structured Worker projection, else its raw account enum. */
    private static boolean nodeSigned(JSONObject track, String packetProvider) {
        WorkerStatusProjection status = WorkerStatusProjection.read(track);
        if (status != null && status.structured) return status.semantic == StatusSemantic.COMPLETED;
        String origin = first(track, "_pipiStatusSource");
        if (origin.isEmpty()) origin = packetProvider;
        String code = first(track, "stateNum", "logisticsStatus", "statusCode", "status", "state");
        StatusSemantic state = TimelineSlot.V5_QUERY.equals(TimelineSlot.normalize(origin))
                ? StatusSemantic.fromAccountState(code, "") : StatusSemantic.UNKNOWN;
        if (state == StatusSemantic.UNKNOWN) state = StatusSemantic.fromStored(code, "");
        return state == StatusSemantic.COMPLETED;
    }

    /** A review in a packet without a structured signed status goes, as before 2026-09-27. */
    private static boolean removes(long reviewTime, boolean packetSigned, long signedSince) {
        return !packetSigned || signedSince > 0L && (reviewTime <= 0L || reviewTime > signedSince);
    }

    private static boolean mayHold(String text) {
        return text != null && (text.indexOf('评') >= 0 || text.contains("\\u"));
    }

    private static String detailOf(JSONObject track) {
        return first(track, "context", "desc", "description", "detail");
    }

    private static long eventTime(JSONObject track) {
        return ExpressSourcePolicy.parseEventTime(
                first(track, "time", "ftime", "date", "logisticsGmtModified"));
    }

    private static String first(JSONObject value, String... keys) {
        for (String key : keys) {
            String text = value.optString(key, "").trim();
            if (!text.isEmpty()) return text;
        }
        return "";
    }
}
