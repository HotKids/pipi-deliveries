package me.pipi.deliveries.data;

import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.json.JSONArray;
import org.json.JSONObject;

import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

/** Removes only observed shopping-review events from a known JD carrier parcel. */
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

    static boolean containsAt(ExpressQueryResult packet, String orderId, long time) {
        if (packet == null || time <= 0L) return false;
        if (matches(packet.latestDetail, orderId)
                && time == ExpressSourcePolicy.parseEventTime(packet.latestTime)) return true;
        try {
            JSONArray tracks = new JSONArray(packet.tracksJson);
            for (int index = 0; index < tracks.length(); index++) {
                JSONObject track = tracks.optJSONObject(index);
                if (track != null && time == ExpressSourcePolicy.parseEventTime(
                        first(track, "time", "ftime", "date", "logisticsGmtModified"))
                        && matches(first(track, "context", "desc", "description", "detail"), orderId)) {
                    return true;
                }
            }
        } catch (Exception invalidTimeline) {
            return false;
        }
        return false;
    }

    static ExpressQueryResult clean(
            ExpressQueryResult packet, String orderId) {
        if (packet == null) return null;
        JSONArray kept = new JSONArray();
        boolean removed = false;
        boolean removedStatus = matches(packet.latestDetail, orderId)
                && (packet.statusEventTime <= 0L
                || ExpressSourcePolicy.parseEventTime(packet.latestTime) == packet.statusEventTime);
        StatusSemantic survivingSemantic = StatusSemantic.UNKNOWN;
        long survivingStatusTime = 0L;
        try {
            JSONArray tracks = new JSONArray(packet.tracksJson);
            for (int index = 0; index < tracks.length(); index++) {
                JSONObject track = tracks.optJSONObject(index);
                if (track == null) continue;
                String detail = first(track, "context", "desc", "description", "detail");
                long time = ExpressSourcePolicy.parseEventTime(
                        first(track, "time", "ftime", "date", "logisticsGmtModified"));
                if (matches(detail, orderId)) {
                    removed = true;
                    removedStatus |= time > 0L && time == packet.statusEventTime;
                    continue;
                }
                kept.put(track);
                String origin = first(track, "_pipiStatusSource");
                if (origin.isEmpty()) origin = packet.timelineProvider;
                String code = first(track, "stateNum", "logisticsStatus", "statusCode", "status", "state");
                String description = first(track, "stateText", "logisticsStatusDesc", "stateName", "stateDesc");
                StatusSemantic state = TimelineSlot.V5_QUERY.equals(TimelineSlot.normalize(origin))
                        ? StatusSemantic.fromAccountState(code, description) : StatusSemantic.UNKNOWN;
                if (state == StatusSemantic.UNKNOWN) {
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
        if (!removed && !matches(packet.latestDetail, orderId)) return packet;
        List<ExpressTimeline.Track> remaining = ExpressTimeline.parse(kept.toString(), "", "");
        ExpressTimeline.Track latest = null;
        for (ExpressTimeline.Track track : remaining) {
            if (ExpressSourcePolicy.parseEventTime(track.time) > 0L) {
                latest = track;
                break;
            }
        }
        if (latest == null && !remaining.isEmpty()) latest = remaining.get(0);
        boolean replaceStatus = remaining.isEmpty() || removedStatus;
        StatusSemantic semantic = replaceStatus ? survivingSemantic : packet.semantic;
        long statusTime = replaceStatus ? survivingStatusTime : packet.statusEventTime;
        return new ExpressQueryResult(packet.waybill, packet.courierCode, packet.companyName,
                semantic, statusTime, latest == null ? "" : latest.time,
                latest == null ? "" : latest.detail, kept.toString(), packet.detailUrl,
                packet.phone, packet.timelineProvider, packet.routeInterface,
                packet.routeCredential, packet.sourceProvider, packet.carrierNormalization)
                .withCarrierIdentityEvidence(packet.carrierIdentityEvidence)
                .withManualStatusEvidence(replaceStatus ? semantic.label : packet.statusDescription,
                        replaceStatus ? survivingSemantic != StatusSemantic.UNKNOWN
                                : packet.structuredStatusEvidence);
    }

    private static String first(JSONObject value, String... keys) {
        for (String key : keys) {
            String text = value.optString(key, "").trim();
            if (!text.isEmpty()) return text;
        }
        return "";
    }
}
