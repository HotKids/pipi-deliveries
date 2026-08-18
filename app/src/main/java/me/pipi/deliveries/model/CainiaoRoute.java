package me.pipi.deliveries.model;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/** Internal automatic-Cainiao route descriptor shared by discovery, storage and detail UI. */
public final class CainiaoRoute {
    private static final String PREFIX = "pipi-route:";

    private CainiaoRoute() {}

    public static String token(String sourceInterface) {
        String value = normalizeInterface(sourceInterface);
        return value.isEmpty() ? "" : PREFIX + value;
    }

    public static boolean isToken(String value) {
        return !interfaceFromToken(value).isEmpty();
    }

    public static String interfaceFromToken(String value) {
        String clean = clean(value).toLowerCase(Locale.ROOT);
        if (!clean.startsWith(PREFIX)) return "";
        return normalizeInterface(clean.substring(PREFIX.length()));
    }

    public static boolean isLegacyCredentialedUrl(String value) {
        return isTrustedResolvedUrl(value) && !credentialFromLegacyUrl(value).isEmpty();
    }

    public static boolean isTrustedResolvedUrl(String value) {
        try {
            URI uri = URI.create(clean(value));
            String host = clean(uri.getHost()).toLowerCase(Locale.ROOT);
            return "https".equalsIgnoreCase(uri.getScheme())
                    && ("cainiao.com".equals(host) || host.endsWith(".cainiao.com")
                    || "taobao.com".equals(host) || host.endsWith(".taobao.com"));
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static String credentialFromLegacyUrl(String value) {
        try {
            URI uri = URI.create(clean(value));
            if (!isTrustedResolvedUrl(value)) return "";
            String query = clean(uri.getRawQuery());
            for (String part : query.split("&")) {
                int separator = part.indexOf('=');
                if (separator <= 0
                        || !"secretkey".equalsIgnoreCase(part.substring(0, separator))) {
                    continue;
                }
                return URLDecoder.decode(
                        part.substring(separator + 1), StandardCharsets.UTF_8.name()).trim();
            }
        } catch (Throwable ignored) {
            // Invalid legacy routes never become provider credentials.
        }
        return "";
    }

    public static String interfaceFromLegacyUrl(String value) {
        try {
            URI uri = URI.create(clean(value));
            String query = clean(uri.getRawQuery());
            for (String part : query.split("&")) {
                int separator = part.indexOf('=');
                if (separator <= 0 || !"from".equalsIgnoreCase(part.substring(0, separator))) {
                    continue;
                }
                String marker = URLDecoder.decode(
                        part.substring(separator + 1), StandardCharsets.UTF_8.name())
                        .trim().toUpperCase(Locale.ROOT);
                if ("INTERFACE5".equals(marker)) return "v5";
                if ("INTERFACE6".equals(marker)) return "v6";
            }
        } catch (Throwable ignored) {
            // Old Deliveries builds only emitted Interface6 routes.
        }
        return isLegacyCredentialedUrl(value) ? "v6" : "";
    }

    private static String normalizeInterface(String value) {
        String clean = clean(value).toLowerCase(Locale.ROOT);
        return "v5".equals(clean) || "v6".equals(clean) ? clean : "";
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
