package me.pipi.deliveries.data;

import me.pipi.deliveries.model.ExpressQueryResult;

import java.net.URI;

/** Validation boundary for provider-returned manual detail routes. */
public final class ManualRoutePolicy {
    private ManualRoutePolicy() {}

    public static String meizuKuaidi100Url(String provider, ExpressQueryResult result) {
        if (result == null || !"meizu".equalsIgnoreCase(clean(provider))) return "";
        String resultProvider = clean(result.timelineProvider);
        if (!resultProvider.isEmpty() && !"meizu".equalsIgnoreCase(resultProvider)) return "";
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
