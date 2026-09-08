package me.pipi.deliveries.network;

import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.model.ExpressItem;

/** Business-source routing for the Android manual provider chain. */
public final class ManualQueryRoutingPolicy {
    private ManualQueryRoutingPolicy() {}

    public static boolean includesMoto(ExpressItem owner) {
        if (owner == null) return true;
        if (owner.usesSourceManualTakeover()) return false;
        CarrierRegistry.Carrier carrier = CarrierRegistry.resolveCpCode(owner.courierCode);
        return carrier == null || !"SF".equals(carrier.standardCode);
    }
}
