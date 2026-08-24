package me.pipi.deliveries.data;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

import me.pipi.deliveries.model.ExpressItem;

/** Immutable owner identity used for one isolated order-page projection attempt. */
public final class ExpressOrderProjectionIdentity {
    private static final String CAPTURE_ALGORITHM_VERSION = "bridge-v3";

    private ExpressOrderProjectionIdentity() {}

    public static Snapshot snapshot(ExpressItem item) {
        if (item == null) return Snapshot.EMPTY;
        String owner = item.stateOwner.isEmpty() ? item.source : item.stateOwner;
        return new Snapshot(
                item.rowId,
                ExpressSourcePolicy.normalizeWaybill(item.waybill),
                ExpressSourcePolicy.bindingSourceForOwner(owner),
                normalize(item.sourceProvider),
                normalize(item.courierCode),
                clean(item.companyName),
                normalize(item.routeOwner),
                routeFingerprint(item));
    }

    public static boolean matches(Snapshot expected, ExpressItem current) {
        return expected != null && !expected.isEmpty()
                && expected.equals(snapshot(current));
    }

    public static String stableIdentity(ExpressItem item) {
        Snapshot value = snapshot(item);
        return value.isEmpty() ? ""
                : value.bindingSource + ":" + value.normalizedOrderId;
    }

    public static String routeFingerprint(ExpressItem item) {
        if (item == null) return "";
        String owner = item.stateOwner.isEmpty() ? item.source : item.stateOwner;
        String stableIdentity = ExpressSourcePolicy.bindingSourceForOwner(owner) + ":"
                + ExpressSourcePolicy.normalizeWaybill(item.waybill);
        return sha256(CAPTURE_ALGORITHM_VERSION + "\n"
                + stableIdentity + "\n"
                + normalize(item.sourceProvider) + "\n"
                + normalize(item.courierCode) + "\n"
                + clean(item.companyName) + "\n"
                + normalize(item.routeOwner) + "\n"
                + routeEndpoint(item));
    }

    private static String routeEndpoint(ExpressItem item) {
        String scheme = "";
        String host = "";
        int port = -1;
        String path = "/";
        try {
            URI route = URI.create(item.routeCredential).normalize();
            scheme = route.getScheme() == null
                    ? "" : route.getScheme().toLowerCase(Locale.ROOT);
            host = route.getHost() == null ? "" : route.getHost().toLowerCase(Locale.ROOT);
            port = route.getPort();
            if (port < 0) {
                if ("https".equals(scheme)) port = 443;
                else if ("http".equals(scheme)) port = 80;
            }
            String rawPath = route.getRawPath();
            path = rawPath == null || rawPath.isEmpty() ? "/" : rawPath;
        } catch (Throwable ignored) {
            // Invalid routes remain scoped by their interface and capture-owner fields.
        }
        // Query credentials may rotate at every sync. They are deliberately excluded while the
        // full endpoint and every owner field that determines the page contract are retained.
        return clean(item.routeInterface).toLowerCase(Locale.ROOT) + ":"
                + scheme + "://" + host + ":" + port + path;
    }

    private static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(
                    clean(value).getBytes(StandardCharsets.UTF_8));
            StringBuilder encoded = new StringBuilder(digest.length * 2);
            for (byte valueByte : digest) {
                encoded.append(String.format(Locale.ROOT, "%02x", valueByte & 0xff));
            }
            return encoded.toString();
        } catch (Exception failure) {
            throw new IllegalStateException("Cannot fingerprint projection owner", failure);
        }
    }

    private static String normalize(String value) {
        return clean(value).toUpperCase(Locale.ROOT);
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    public static final class Snapshot {
        static final Snapshot EMPTY = new Snapshot(
                0L, "", "", "", "", "", "", "");

        public final long rowId;
        public final String normalizedOrderId;
        public final String bindingSource;
        public final String sourceProvider;
        public final String courierCode;
        public final String companyName;
        public final String routeOwner;
        public final String routeFingerprint;

        Snapshot(
                long rowId, String normalizedOrderId, String bindingSource,
                String sourceProvider, String courierCode, String companyName,
                String routeOwner, String routeFingerprint) {
            this.rowId = rowId;
            this.normalizedOrderId = clean(normalizedOrderId);
            this.bindingSource = clean(bindingSource);
            this.sourceProvider = clean(sourceProvider);
            this.courierCode = clean(courierCode);
            this.companyName = clean(companyName);
            this.routeOwner = clean(routeOwner);
            this.routeFingerprint = clean(routeFingerprint);
        }

        public boolean isEmpty() {
            return rowId <= 0L || normalizedOrderId.isEmpty() || bindingSource.isEmpty();
        }

        @Override public boolean equals(Object other) {
            if (this == other) return true;
            if (!(other instanceof Snapshot)) return false;
            Snapshot value = (Snapshot) other;
            return rowId == value.rowId
                    && normalizedOrderId.equals(value.normalizedOrderId)
                    && bindingSource.equals(value.bindingSource)
                    && sourceProvider.equals(value.sourceProvider)
                    && courierCode.equals(value.courierCode)
                    && companyName.equals(value.companyName)
                    && routeOwner.equals(value.routeOwner)
                    && routeFingerprint.equals(value.routeFingerprint);
        }

        @Override public int hashCode() {
            int result = Long.hashCode(rowId);
            result = 31 * result + normalizedOrderId.hashCode();
            result = 31 * result + bindingSource.hashCode();
            result = 31 * result + sourceProvider.hashCode();
            result = 31 * result + courierCode.hashCode();
            result = 31 * result + companyName.hashCode();
            result = 31 * result + routeOwner.hashCode();
            result = 31 * result + routeFingerprint.hashCode();
            return result;
        }
    }
}
