package me.pipi.deliveries.feature.express;

import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.network.ExpressApi;

/** Applies the selected manual-query source first and invokes its fallback only when needed. */
final class ManualQueryCoordinator {
    private ManualQueryCoordinator() {}

    static ExpressQueryResult query(Source primary, Source fallback) throws Exception {
        ExpressQueryResult primaryResult = null;
        try {
            primaryResult = primary.query();
            if (Kuaidi100TimelinePolicy.hasRealTracking(primaryResult)) return primaryResult;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw interrupted;
        } catch (Exception ignored) {
            // Provider failures are non-terminal because the explicit fallback still owns recovery.
        }
        try {
            ExpressQueryResult fallbackResult = fallback.query();
            if (Kuaidi100TimelinePolicy.hasRealTracking(fallbackResult)
                    || primaryResult == null) {
                return fallbackResult;
            }
            // Preserve route and carrier metadata from a successful primary lookup so an
            // uncollected shipment can enter the hidden retry queue intact.
            return primaryResult;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw interrupted;
        } catch (Exception fallbackFailure) {
            if (fallbackFailure instanceof ExpressApi.QueryException
                    && ((ExpressApi.QueryException) fallbackFailure).needsPhoneTail()) {
                throw fallbackFailure;
            }
            if (primaryResult != null) return primaryResult;
            throw fallbackFailure;
        }
    }

    @FunctionalInterface
    interface Source {
        ExpressQueryResult query() throws Exception;
    }
}
