package me.pipi.deliveries.feature.express;

import android.app.Activity;

/** App-local foreground Activity lookup for {@link ExpressHiddenWebView}. */
final class ExpressForegroundHost {
    private ExpressForegroundHost() {}

    static Activity current() {
        return null;
    }
}
