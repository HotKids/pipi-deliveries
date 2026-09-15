package me.pipi.deliveries.background;

import java.util.Locale;

import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.network.ExpressAccountSource;

/**
 * Client-side carrier recognition for account (sync) rows — EXPRESS_OWNERSHIP_PLAN §3.1 残留 #1
 * 裁决改为 A（用户定，2026-09-03）: the free Kuaidi100 recognizer is called directly by the client
 * for every waybill whose raw carrier misses the built-in table; the Worker only maps built-in raw
 * codes. Results are display-only carrier normalization; raw fields never change. Account orders
 * store recognition against their projected waybill, never the original order tuple.
 */
public final class AccountCarrierRecognition {
    @FunctionalInterface
    public interface Recognizer {
        CarrierNormalization recognize(String waybill) throws Exception;
    }

    private AccountCarrierRecognition() {}

    /** R-20: a JD-platform row names the platform in its raw code; on a non-JD waybill that is no evidence. */
    static boolean platformLabelOnly(ExpressItem item) {
        if (item == null || !(item.isAccountOrder() || item.isJingDongSource())) return false;
        String waybill = normalize(item.displayWaybill());
        return !waybill.isEmpty() && !waybill.startsWith("JD");
    }

    public static boolean needsRecognition(ExpressItem item) {
        if (item == null || item.manuallyAdded) return false;
        if (item.isAccountOrder() && normalize(item.projectedWaybill).isEmpty()) return false;
        return !normalize(item.displayWaybill()).isEmpty() && item.resolvedCarrier() == null;
    }

    public static boolean recognize(
            ExpressRepository repository, ExpressItem item, Recognizer recognizer)
            throws InterruptedException {
        if (repository == null || recognizer == null || !needsRecognition(item)) return false;
        CarrierNormalization recognized;
        try {
            recognized = recognizer.recognize(item.displayWaybill());
        } catch (InterruptedException interrupted) {
            throw interrupted;
        } catch (Exception failure) {
            // The recognition coordinator owns retries (15-minute cooldown, three failures).
            return false;
        }
        if (recognized == null || !recognized.recognized()) return false;
        if (platformLabelOnly(item) && "JD".equals(recognized.standardCode)) return false;
        if (item.isAccountOrder()) {
            CarrierRegistry.Carrier carrier = CarrierRegistry.resolve(recognized.standardCode);
            if (carrier == null) return false;
            return repository.saveOrderProjectionCarrier(item,
                    ExpressAccountSource.bindingSourceForOwner(
                            item.stateOwner.isEmpty() ? item.source : item.stateOwner),
                    item.projectedWaybill, carrier.companyName);
        }
        return repository.saveRecognizedCarrier(item, recognized);
    }

    private static String normalize(String value) {
        return clean(value).toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", "");
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
