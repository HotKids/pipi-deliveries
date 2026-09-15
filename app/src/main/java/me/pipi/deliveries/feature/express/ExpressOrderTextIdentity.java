package me.pipi.deliveries.feature.express;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import me.pipi.deliveries.data.CarrierRegistry;

/**
 * Carrier identity that the account feed's own JD order track text already names, e.g.
 * "您的订单由第三方卖家拣货完成，待出库交付极兔速递，运单号为JT4006839564547". When present the
 * waybill is read directly and no H5 projection WebView is opened; JD-fulfilled orders whose text
 * never names a waybill keep going through the H5 projection.
 */
public final class ExpressOrderTextIdentity {
    private static final Pattern WAYBILL =
            Pattern.compile("运单号\\s*[为是:：]?\\s*([A-Za-z0-9-]{8,32})");
    private static final Pattern CARRIER_BEFORE_WAYBILL = Pattern.compile(
            "(?:交付|交由|移交|转交|由)\\s*([一-龥A-Za-z0-9]{2,16}?)\\s*[，,、。；;]?\\s*运单号");
    public static final class Identity {
        public final String waybill;
        public final String courierCode;
        public final String companyName;
        Identity(String waybill, String courierCode, String companyName) {
            this.waybill = waybill;
            this.courierCode = courierCode;
            this.companyName = companyName;
        }
    }

    private ExpressOrderTextIdentity() {}

    /** Matches iOS account-order-text-identity; text names resolve only through the local table. */
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
        Matcher carrierMatch = CARRIER_BEFORE_WAYBILL.matcher(text);
        String rawCarrier = carrierMatch.find() ? carrierMatch.group(1).trim() : "";
        CarrierRegistry.Carrier carrier = CarrierRegistry.resolveName(rawCarrier);
        return new Identity(waybill, carrier == null ? "" : carrier.standardCode,
                carrier == null ? rawCarrier : carrier.companyName);
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
