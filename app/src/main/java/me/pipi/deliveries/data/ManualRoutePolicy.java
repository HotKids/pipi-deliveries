package me.pipi.deliveries.data;

import me.pipi.deliveries.model.ExpressQueryResult;

import java.net.URI;

/** Builds the direct K100 query page and validates provider-returned manual detail routes. */
public final class ManualRoutePolicy {
    private ManualRoutePolicy() {}

    public static String kuaidi100QueryUrl(String waybill) {
        String number = ExpressSourcePolicy.normalizeWaybill(waybill);
        return number.isEmpty() ? ""
                : "https://m.kuaidi100.com/app/query/?nu=" + android.net.Uri.encode(number);
    }

    public static String meizuKuaidi100Url(String provider, ExpressQueryResult result) {
        if (result == null || !TimelineSlot.V6_QUERY.equals(TimelineSlot.normalize(provider))) return "";
        String resultProvider = clean(result.timelineProvider);
        if (!resultProvider.isEmpty()
                && !TimelineSlot.V6_QUERY.equals(TimelineSlot.normalize(resultProvider))) return "";
        return safeKuaidi100Url(result.detailUrl);
    }

    public static String safeKuaidi100Url(String route) {
        String candidate = clean(route);
        if (candidate.isEmpty()) return "";
        try {
            URI uri = new URI(candidate);
            String host = uri.getHost();
            if (!"https".equalsIgnoreCase(uri.getScheme())
                    || host == null || !trustedHost(host)) return "";
            return uri.toString();
        } catch (Exception ignored) {
            return "";
        }
    }

    private static boolean trustedHost(String host) {
        String value = clean(host).toLowerCase(java.util.Locale.ROOT);
        return "kuaidi100.com".equals(value) || value.endsWith(".kuaidi100.com");
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
