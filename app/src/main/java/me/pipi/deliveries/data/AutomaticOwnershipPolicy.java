package me.pipi.deliveries.data;

import java.util.Locale;

import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

/** First-qualified automatic ownership rules shared by persistence and refresh receipts. */
final class AutomaticOwnershipPolicy {
    static final long TAKEOVER_COOLDOWN_MS = 2L * 60L * 60L * 1000L;

    private AutomaticOwnershipPolicy() {}

    static String providerForPackageOwner(String owner) {
        String source = ExpressSourcePolicy.source(owner);
        if (ExpressSourcePolicy.SOURCE_INTERFACE5.equals(source)
                || ExpressSourcePolicy.SOURCE_INTERFACE5_JD.equals(source)) {
            return ExpressSourcePolicy.SOURCE_INTERFACE5;
        }
        if (ExpressSourcePolicy.SOURCE_INTERFACE6.equals(source)
                || ExpressSourcePolicy.SOURCE_LEGACY_ACCOUNT_ORDER.equals(source)) {
            return ExpressSourcePolicy.SOURCE_INTERFACE6;
        }
        return "";
    }

    static boolean isAutomaticPackageOwner(String owner) {
        return !providerForPackageOwner(owner).isEmpty();
    }

    /**
     * The FINAL ownership gate is about provenance, not timeline fullness. An automatic packet
     * therefore needs raw carrier identity, known state and an explicit local timeline owner.
     * Empty same-source history and an absent optional business-source label are still valid.
     */
    static boolean isQualified(String packageOwner, ExpressQueryResult result) {
        if (result == null) return false;
        String provider = providerForPackageOwner(packageOwner);
        if (provider.isEmpty()) return false;
        // Samsung v3's documented JingDong order-stage exception is N/A here: this client has
        // no Samsung v3 ingestion path. Do not synthesize that exception from display labels.
        if (!result.carrierIdentityEvidence) return false;
        if (result.semantic == null || result.semantic == StatusSemantic.UNKNOWN) return false;
        return ExpressSourcePolicy.bindingSourceForOwner(provider)
                .equals(clean(result.timelineProvider).toLowerCase(Locale.ROOT));
    }

    static boolean isJingDongSource(String sourceProvider) {
        return "jingdong".equals(clean(sourceProvider).toLowerCase(Locale.ROOT));
    }

    static boolean isShunFengSource(String sourceProvider) {
        return "shunfeng".equals(clean(sourceProvider).toLowerCase(Locale.ROOT));
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
