package me.pipi.deliveries.feature.express;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The waybill that the account feed's own JD order track text already names, e.g.
 * "您的订单由第三方卖家拣货完成，待出库交付极兔速递，运单号为JT4006839564547". When present the
 * waybill is read directly and no H5 projection WebView is opened; JD-fulfilled orders whose text
 * never names a waybill keep going through the H5 projection.
 *
 * <p>Only the waybill is taken from the text (user ruling 2026-09-26, 其余裁决 7, iOS and Lite
 * alike): the carrier named next to it (「交付极兔速递」) is never read. The carrier comes from the
 * built-in table, then the free Kuaidi100 recognition, then the existing paid fallback, like any
 * other waybill without a raw carrier.</p>
 */
public final class ExpressOrderTextIdentity {
    private static final Pattern WAYBILL =
            Pattern.compile("运单号\\s*[为是:：]?\\s*([A-Za-z0-9-]{8,32})");
    public static final class Identity {
        public final String waybill;
        Identity(String waybill) {
            this.waybill = waybill;
        }
    }

    private ExpressOrderTextIdentity() {}

    /** Matches iOS account-order-text-identity: the waybill the text names, never its carrier. */
    public static Identity fromTracksJson(String tracksJson, String ownerWaybill) {
        if (tracksJson == null || tracksJson.trim().isEmpty()) return null;
        String owner = normalize(ownerWaybill);
        try {
            JSONArray tracks = me.pipi.deliveries.model.ExpressTimeline.findArray(
                    new org.json.JSONTokener(tracksJson).nextValue());
            for (int index = 0; index < tracks.length(); index++) {
                JSONObject track = tracks.optJSONObject(index);
                if (track == null) continue;
                Identity identity = fromDetail(firstText(track, "context", "desc", "detail",
                        "description"), owner);
                if (identity != null) return identity;
            }
        } catch (Throwable ignored) {
            // Malformed timeline JSON never produces an identity.
        }
        return null;
    }

    static Identity fromDetail(String detail, String ownerWaybill) {
        String text = detail == null ? "" : detail;
        Matcher matcher = WAYBILL.matcher(text);
        if (!matcher.find()) return null;
        String waybill = normalize(matcher.group(1));
        if (waybill.length() < 8 || waybill.equals(normalize(ownerWaybill))
                || (waybill.matches("[0-9]+") && waybill.length() > 20)) return null;
        return new Identity(waybill);
    }

    private static String firstText(JSONObject value, String... keys) {
        for (String key : keys) {
            String candidate = value.optString(key, "");
            if (candidate != null && !candidate.trim().isEmpty()) return candidate.trim();
        }
        return "";
    }

    private static String normalize(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").toUpperCase(Locale.ROOT);
    }
}
