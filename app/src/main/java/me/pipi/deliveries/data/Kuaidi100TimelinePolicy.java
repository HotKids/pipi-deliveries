package me.pipi.deliveries.data;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Refresh lifetime and same-provider incremental-cache policy for local timelines. */
public final class Kuaidi100TimelinePolicy {
    static final long SIGNED_REFRESH_WINDOW_MS = 24L * 60L * 60L * 1000L;

    private Kuaidi100TimelinePolicy() {}

    /** A manual item becomes visible only after a provider supplies a genuine timeline node. */
    public static boolean hasRealTracking(ExpressQueryResult result) {
        if (result == null || ExpressStatusNormalizer.isProviderErrorDetail(
                result.latestDetail)) return false;
        return ExpressTimeline.latestMeaningful(result.tracksJson, result.semantic) != null
                || hasTimedTracking(result);
    }

    /** A successful cache write requires a real event paired with a parseable provider time. */
    public static boolean hasTimedTracking(ExpressQueryResult result) {
        if (result == null || ExpressStatusNormalizer.isProviderErrorDetail(
                result.latestDetail)) return false;
        for (ExpressTimeline.Track track : ExpressTimeline.parse(result.tracksJson, "", "")) {
            if (ExpressSourcePolicy.parseEventTime(track.time) > 0L
                    && !ExpressStatusNormalizer.isProviderErrorDetail(track.detail)) {
                return true;
            }
        }
        return false;
    }

    /**
     * A current query chain is complete enough once one provider package contains the order or
     * pickup boundary. Numeric codes are interpreted with the package's own provider contract so
     * account state 102 (shipped) is never confused with Picker/K100 state 102 (ordered).
     */
    public static boolean hasTimelineStart(ExpressQueryResult result) {
        if (!hasTimedTracking(result)) return false;
        if (result.semantic == StatusSemantic.ORDERED
                || result.semantic == StatusSemantic.PICKED) return true;
        String provider = normalizeProvider(result.timelineProvider);
        try {
            Object root = new JSONTokener(result.tracksJson).nextValue();
            return containsTimelineStart(root, provider);
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static boolean hasTimelineStart(ExpressItem item) {
        if (item == null) return false;
        String owner = item.stateOwner.isEmpty() ? item.source : item.stateOwner;
        String provider = owner.toLowerCase(java.util.Locale.ROOT).contains("interface5")
                || "i5-jd".equalsIgnoreCase(owner) ? "interface5"
                : owner.toLowerCase(java.util.Locale.ROOT).contains("interface6")
                || "i6-jd".equalsIgnoreCase(owner) ? "interface6"
                : item.manualTimelineProvider;
        return hasTimelineStart(new ExpressQueryResult(
                item.displayWaybill(), item.courierCode, item.companyName,
                item.semantic, item.statusEventTime, item.latestTime,
                item.latestDetail, item.tracksJson, "", item.phone,
                provider, "", "", item.sourceProvider));
    }

    private static boolean containsTimelineStart(Object node, String provider) {
        if (node instanceof JSONArray) {
            JSONArray values = (JSONArray) node;
            for (int index = 0; index < values.length(); index++) {
                if (containsTimelineStart(values.opt(index), provider)) return true;
            }
            return false;
        }
        if (!(node instanceof JSONObject)) return false;
        JSONObject value = (JSONObject) node;
        String detail = first(value,
                "context", "desc", "description", "logisticDetail",
                "lastLogisticDetail", "message");
        boolean providerError = ExpressStatusNormalizer.isProviderErrorDetail(detail);
        String compactDetail = detail.replaceAll("\\s+", "");
        if (!providerError && (compactDetail.contains("已下单")
                || compactDetail.contains("订单已创建")
                || compactDetail.contains("已揽件") || compactDetail.contains("已揽收")
                || compactDetail.contains("揽件成功")
                || compactDetail.contains("揽收成功"))) return true;
        String source = normalizeProvider(first(value, "_pipiStatusSource"));
        if (source.isEmpty()) source = provider;
        if (!providerError) {
            String code = first(value,
                    "logisticsStatus", "statusCode", "status", "state", "action");
            String description = first(value, "logisticsStatusDesc", "stateName");
            StatusSemantic semantic = isAccountProvider(source)
                    ? StatusSemantic.fromAccountState(code, description)
                    : StatusSemantic.fromKuaidi100EventCode(code);
            if (semantic == StatusSemantic.UNKNOWN) {
                semantic = StatusSemantic.fromStored(code, description);
            }
            if (semantic == StatusSemantic.ORDERED || semantic == StatusSemantic.PICKED) {
                return true;
            }
        }
        java.util.Iterator<String> keys = value.keys();
        while (keys.hasNext()) {
            Object child = value.opt(keys.next());
            if ((child instanceof JSONArray || child instanceof JSONObject)
                    && containsTimelineStart(child, source)) return true;
        }
        return false;
    }

    private static boolean isAccountProvider(String provider) {
        return "account".equals(provider) || "interface5".equals(provider)
                || "interface6".equals(provider);
    }

    private static String first(JSONObject value, String... keys) {
        if (value == null) return "";
        for (String key : keys) {
            Object raw = value.opt(key);
            if (!(raw instanceof String) && !(raw instanceof Number)) continue;
            String candidate = String.valueOf(raw).trim();
            if (!candidate.isEmpty() && !"null".equalsIgnoreCase(candidate)) {
                return candidate;
            }
        }
        return "";
    }

    private static String normalizeProvider(String value) {
        return value == null ? "" : value.trim().toLowerCase(java.util.Locale.ROOT);
    }

    /** Uses only adapter contracts that explicitly return a self-contained timeline package. */
    public static boolean isTimelineIncomplete(ExpressQueryResult result) {
        if (result == null) return true;
        String provider = result.timelineProvider == null
                ? "" : result.timelineProvider.trim().toLowerCase(java.util.Locale.ROOT);
        // Completeness is an adapter contract. Moto/OPPO and account feeds can be partial even
        // when they contain several nodes or a terminal label. A collapsed KDNiao terminal
        // headline remains partial until its package contains another timed history node.
        boolean declaredComplete = "kuaidi100".equals(provider) || "kdniao".equals(provider);
        return !ManualTimelineAuthorityPolicy.isEffectivelyComplete(
                provider, result, declaredComplete);
    }

    public static boolean isTimelineIncomplete(ExpressItem item) {
        if (item == null) return true;
        String provider = item.manualTimelineProvider.toLowerCase(java.util.Locale.ROOT);
        if (provider.isEmpty()) {
            String owner = item.stateOwner.isEmpty() ? item.source : item.stateOwner;
            if ("V4".equalsIgnoreCase(owner) || "KD-100".equalsIgnoreCase(owner)
                    || "I5-K100".equalsIgnoreCase(owner)
                    || "I6-K100".equalsIgnoreCase(owner)) {
                provider = "v4".equalsIgnoreCase(owner) ? "v4" : "kuaidi100";
            }
        }
        return isTimelineIncomplete(new ExpressQueryResult(
                item.displayWaybill(), item.courierCode, item.companyName,
                item.semantic, item.statusEventTime, item.latestTime, item.latestDetail,
                item.tracksJson, "", item.phone, provider, "", "", item.sourceProvider));
    }

    /** Refresh on every open until an exact signed event is at least 24 hours old. */
    public static boolean shouldRefresh(
            ExpressItem item, ExpressQueryResult cached, long now) {
        boolean completed = item != null && item.semantic == StatusSemantic.COMPLETED;
        long signedAt = 0L;
        if (cached != null && cached.semantic == StatusSemantic.COMPLETED) {
            completed = true;
        }
        if (!completed) return true;
        signedAt = ExpressLifecycleTimes.signedAt(item, cached, now);
        if (signedAt <= 0L) return true;
        return now - signedAt < SIGNED_REFRESH_WINDOW_MS;
    }

    /** Keeps historical nodes and applies this refresh's additions or node revisions. */
    public static ExpressQueryResult merge(
            ExpressQueryResult cached, ExpressQueryResult refreshed) {
        return merge(cached, refreshed, false);
    }

    static ExpressQueryResult mergeManualProvider(
            ExpressQueryResult cached, ExpressQueryResult refreshed) {
        return merge(cached, refreshed, true);
    }

    private static ExpressQueryResult merge(
            ExpressQueryResult cached, ExpressQueryResult refreshed,
            boolean requireStructuredTerminal) {
        if (cached == null) return refreshed;
        if (refreshed == null) return cached;
        boolean frozenCompletedPresentation = isCompletedTimedPackage(cached)
                && (!requireStructuredTerminal || cached.structuredStatusEvidence);
        ExpressQueryResult presentation = frozenCompletedPresentation
                ? cached : selectedSameProviderPresentation(
                        cached, refreshed, requireStructuredTerminal);
        me.pipi.deliveries.model.CarrierNormalization normalization =
                refreshed.carrierNormalization.present()
                        ? refreshed.carrierNormalization : cached.carrierNormalization;
        return new ExpressQueryResult(
                prefer(presentation.waybill,
                        prefer(refreshed.waybill, cached.waybill)),
                prefer(presentation.courierCode,
                        prefer(refreshed.courierCode, cached.courierCode)),
                prefer(presentation.companyName,
                        prefer(refreshed.companyName, cached.companyName)),
                presentation.semantic, effectiveStatusEventTime(presentation),
                presentation.latestTime,
                presentation.latestDetail,
                ExpressTimeline.mergeJson(cached.tracksJson, refreshed.tracksJson),
                prefer(refreshed.detailUrl, cached.detailUrl),
                prefer(refreshed.phone, cached.phone),
                prefer(refreshed.timelineProvider, cached.timelineProvider),
                prefer(refreshed.routeInterface, cached.routeInterface),
                prefer(refreshed.routeCredential, cached.routeCredential),
                prefer(refreshed.sourceProvider, cached.sourceProvider), normalization)
                .withManualStatusEvidence(
                        presentation.statusDescription,
                        presentation.structuredStatusEvidence);
    }

    static boolean isCompletedTimedPackage(ExpressQueryResult result) {
        return result != null
                && result.semantic == StatusSemantic.COMPLETED
                && hasTimedTracking(result);
    }

    /** Selects one provider response as the whole visible header while tracks merge separately. */
    private static ExpressQueryResult selectedSameProviderPresentation(
            ExpressQueryResult cached, ExpressQueryResult refreshed,
            boolean requireStructuredTerminal) {
        boolean cachedTerminal = cached.semantic.terminal()
                && (!requireStructuredTerminal || cached.structuredStatusEvidence);
        boolean refreshedTerminal = refreshed.semantic.terminal()
                && (!requireStructuredTerminal || refreshed.structuredStatusEvidence);
        if (cachedTerminal && !refreshedTerminal) return cached;
        if (refreshedTerminal && !cachedTerminal) return refreshed;
        if (refreshed.semantic == StatusSemantic.UNKNOWN) return cached;
        if (cached.semantic == StatusSemantic.UNKNOWN) return refreshed;
        long cachedEvent = effectiveStatusEventTime(cached);
        long refreshedEvent = effectiveStatusEventTime(refreshed);
        if (refreshedEvent <= 0L) return cachedEvent <= 0L ? refreshed : cached;
        if (cachedEvent <= 0L) return refreshed;
        return refreshedEvent >= cachedEvent ? refreshed : cached;
    }

    private static long effectiveStatusEventTime(ExpressQueryResult result) {
        if (result == null) return 0L;
        if (result.statusEventTime > 0L) return result.statusEventTime;
        return ExpressSourcePolicy.parseEventTime(result.latestTime);
    }

    private static String prefer(String primary, String fallback) {
        return primary == null || primary.trim().isEmpty() ? fallback : primary;
    }
}
