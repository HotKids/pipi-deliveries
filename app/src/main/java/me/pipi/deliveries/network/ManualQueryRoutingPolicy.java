package me.pipi.deliveries.network;

import me.pipi.deliveries.model.ExpressItem;

/** Business-source routing for the Android manual provider chain. */
public final class ManualQueryRoutingPolicy {
    private ManualQueryRoutingPolicy() {}

    public static boolean includesMoto(ExpressItem owner) {
        // Lite intentionally has no interface-4 trajectory caller.
        return false;
    }
}
