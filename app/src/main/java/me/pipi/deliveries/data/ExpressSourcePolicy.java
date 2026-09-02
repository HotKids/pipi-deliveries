package me.pipi.deliveries.data;

import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

import me.pipi.deliveries.model.CainiaoRoute;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

/** Deterministic source ownership and lifecycle policy for the canonical express row. */
final class ExpressSourcePolicy {
    static final String SOURCE_INTERFACE5 = "INTERFACE5";
    /** Primary account rows remain independent from the alternate account source. */
    static final String SOURCE_INTERFACE6 = "INTERFACE6";
    static final String SOURCE_DISCOVERY = "DISCOVERY";
    static final String SOURCE_INTERFACE5_JD = "I5-JD";
    static final String SOURCE_INTERFACE5_KUAIDI100 = "I5-K100";
    static final String SOURCE_LEGACY_ACCOUNT_ORDER = "I6-JD";
    static final String SOURCE_KUAIDI100 = "KD-100";
    static final String SOURCE_V4 = "V4";

    private ExpressSourcePolicy() {}

    static String normalizeWaybill(String waybill) {
        return clean(waybill).toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", "");
    }

    static String source(String source) {
        String value = clean(source).toUpperCase(Locale.ROOT);
        if (value.isEmpty() || SOURCE_DISCOVERY.equals(value)) {
            return SOURCE_DISCOVERY;
        }
        return value;
    }

    static int stateRank(String source) {
        String value = source(source);
        if (SOURCE_INTERFACE5.equals(value) || SOURCE_INTERFACE5_JD.equals(value)
                || SOURCE_INTERFACE6.equals(value)
                || SOURCE_LEGACY_ACCOUNT_ORDER.equals(value)) return 3;
        if (SOURCE_INTERFACE5_KUAIDI100.equals(value)
                || SOURCE_KUAIDI100.equals(value) || SOURCE_V4.equals(value)) return 1;
        return 0;
    }

    /** K100 manual rows keep the interface selected when the lookup was started. */
    static String kuaidi100FallbackSource(String bindingSource) {
        return "interface5".equalsIgnoreCase(clean(bindingSource))
                ? SOURCE_INTERFACE5_KUAIDI100 : SOURCE_KUAIDI100;
    }

    static String bindingSourceForOwner(String owner) {
        String normalized = source(owner);
        return SOURCE_INTERFACE5.equals(normalized)
                || SOURCE_INTERFACE5_JD.equals(normalized)
                || SOURCE_INTERFACE5_KUAIDI100.equals(normalized)
                ? "interface5" : "interface6";
    }

    static boolean isAccountOrderOwner(String owner) {
        String normalized = source(owner);
        return SOURCE_INTERFACE5_JD.equals(normalized)
                || SOURCE_LEGACY_ACCOUNT_ORDER.equals(normalized);
    }

    /** An order summary becomes carrier state only after identity and timed tracking agree. */
    static StatusSemantic accountOrderPresentationSemantic(
            String owner, String projectedWaybill, StatusSemantic sourceSemantic,
            String sourceTracksJson) {
        StatusSemantic fallback = sourceSemantic == null
                ? StatusSemantic.UNKNOWN : sourceSemantic;
        boolean projectedCarrierTimeline = !normalizeWaybill(projectedWaybill).isEmpty()
                && hasTimedCarrierTimeline(sourceTracksJson);
        return isAccountOrderOwner(owner) && !projectedCarrierTimeline
                ? StatusSemantic.ORDERED : fallback;
    }

    static boolean hasTimedCarrierTimeline(String tracksJson) {
        for (ExpressTimeline.Track track : ExpressTimeline.parse(tracksJson, "", "")) {
            if (parseEventTime(track.time) > 0L
                    && !ExpressStatusNormalizer.isProviderErrorDetail(track.detail)) return true;
        }
        return false;
    }

    /** Keeps the home/widget projection aligned with the currently selected account interface. */
    static boolean belongsToBindingSource(ExpressItem item, String bindingSource) {
        if (item == null) return false;
        // The account toggle selects only the automatic feed. A user-created shipment is one
        // durable local item and must remain visible under either automatic interface.
        if (item.manuallyAdded) return true;
        return belongsToBindingSource(
                item.stateOwner.isEmpty() ? item.source : item.stateOwner, bindingSource);
    }

    /** Applies the same source partition to rows that have not yet been projected as items. */
    static boolean belongsToBindingSource(String owner, String bindingSource) {
        String normalizedOwner = source(owner);
        if ("interface5".equalsIgnoreCase(clean(bindingSource))) {
            return SOURCE_INTERFACE5.equals(normalizedOwner)
                    || SOURCE_INTERFACE5_JD.equals(normalizedOwner)
                    || SOURCE_INTERFACE5_KUAIDI100.equals(normalizedOwner);
        }
        // Manual K100 rows belong to the main-interface experience. DISCOVERY/V4 are retained
        // here only so rows created by older builds do not disappear after upgrading.
        return SOURCE_INTERFACE6.equals(normalizedOwner)
                || SOURCE_LEGACY_ACCOUNT_ORDER.equals(normalizedOwner)
                || SOURCE_KUAIDI100.equals(normalizedOwner)
                || SOURCE_V4.equals(normalizedOwner)
                || SOURCE_DISCOVERY.equals(normalizedOwner);
    }

    static boolean shouldApplyState(
            String currentOwner, StatusSemantic current, long currentEventTime,
            String incomingOwner, StatusSemantic incoming, long incomingEventTime) {
        if (incoming == null || incoming == StatusSemantic.UNKNOWN) {
            return current == null || current == StatusSemantic.UNKNOWN;
        }
        if (current == null || current == StatusSemantic.UNKNOWN) return true;
        int currentOwnerRank = stateRank(currentOwner);
        int incomingOwnerRank = stateRank(incomingOwner);
        if (incomingOwnerRank < currentOwnerRank) return false;
        if (current == StatusSemantic.COMPLETED && incoming != StatusSemantic.COMPLETED) {
            return false;
        }
        if (incomingOwnerRank > currentOwnerRank) return true;
        if (current == incoming) {
            if (incomingEventTime <= 0L) return currentEventTime <= 0L;
            return currentEventTime <= 0L || incomingEventTime >= currentEventTime;
        }
        if (isDeliveryWaitingPair(current, incoming)) {
            return currentEventTime > 0L && incomingEventTime > currentEventTime;
        }
        int currentRank = deliveryRank(current);
        int incomingRank = deliveryRank(incoming);
        if (currentRank >= 0 && incomingRank >= 0) {
            return incomingRank > currentRank;
        }
        return incomingEventTime > 0L
                && (currentEventTime <= 0L || incomingEventTime > currentEventTime);
    }

    static boolean shouldApplyHeadline(
            String currentOwner, long currentEventTime,
            String incomingOwner, long incomingEventTime) {
        int currentRank = stateRank(currentOwner);
        int incomingRank = stateRank(incomingOwner);
        if (incomingRank < currentRank) return false;
        if (incomingEventTime <= 0L) return currentEventTime <= 0L;
        return currentEventTime <= 0L || incomingEventTime >= currentEventTime;
    }

    static String selectDetailUrl(String existing, String incoming) {
        String current = clean(existing);
        String candidate = clean(incoming);
        if (CainiaoRoute.isToken(candidate)) return candidate;
        if (CainiaoRoute.isToken(current)) return current;
        if (CainiaoRoute.isLegacyCredentialedUrl(candidate)) return candidate;
        if (CainiaoRoute.isLegacyCredentialedUrl(current)) return current;
        // A generic Cainiao URL cannot render shipment details, and Kuaidi100 is not a route for
        // Cainiao-owned rows. Keep the row closed until discovery supplies a real credential.
        return "";
    }

    static boolean isCredentialedCainiao(String url) {
        return CainiaoRoute.isToken(url) || CainiaoRoute.isLegacyCredentialedUrl(url);
    }

    static long parseEventTime(String value) {
        String clean = clean(value);
        if (clean.isEmpty()) return 0L;
        for (String pattern : new String[]{"yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss"}) {
            SimpleDateFormat parser = new SimpleDateFormat(pattern, Locale.CHINA);
            parser.setLenient(false);
            ParsePosition position = new ParsePosition(0);
            Date parsed = parser.parse(clean, position);
            if (parsed != null && position.getIndex() == clean.length()) {
                return parsed.getTime();
            }
        }
        return 0L;
    }

    private static boolean isDeliveryWaitingPair(
            StatusSemantic current, StatusSemantic incoming) {
        return (current == StatusSemantic.DELIVERY
                && incoming == StatusSemantic.WAITING_PICKUP)
                || (current == StatusSemantic.WAITING_PICKUP
                && incoming == StatusSemantic.DELIVERY);
    }

    private static int deliveryRank(StatusSemantic value) {
        if (value == null) return -1;
        switch (value) {
            case ORDERED: return 0;
            case SHIPPED: return 1;
            case PICKED: return 2;
            case TRANSIT: return 3;
            case DELIVERY: return 4;
            case WAITING_PICKUP: return 5;
            case COMPLETED: return 6;
            default: return -1;
        }
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
