package me.pipi.deliveries.network;

import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.model.ExpressQueryResult;

import java.util.function.Predicate;

/** Applies the selected manual-query source first and invokes its fallback only when needed. */
public final class ManualQueryCoordinator {
    private ManualQueryCoordinator() {}

    public static ExpressQueryResult query(Source primary, Source fallback) throws Exception {
        return query(primary, fallback, Kuaidi100TimelinePolicy::hasRealTracking);
    }

    /** Uses Kuaidi100 as the tracking authority and consults the account source only as fallback. */
    public static ExpressQueryResult queryKuaidi100First(
            Source kuaidi100, Source accountFallback) throws Exception {
        return query(kuaidi100, accountFallback, Kuaidi100TimelinePolicy::hasTimedTracking);
    }

    /** Reuses the selected account interface and its K100 fallback without cross-interface calls. */
    public static ExpressQueryResult queryForBindingSource(
            String bindingSource, boolean kuaidi100First,
            Source interface5, Source interface6, Source kuaidi100) throws Exception {
        Source account;
        if ("interface5".equalsIgnoreCase(bindingSource)) {
            account = interface5;
        } else if ("interface6".equalsIgnoreCase(bindingSource)) {
            account = interface6;
        } else {
            throw new IllegalArgumentException("Unsupported account source");
        }
        return kuaidi100First
                ? queryKuaidi100First(kuaidi100, account)
                : query(account, kuaidi100);
    }

    private static ExpressQueryResult query(
            Source primary, Source fallback,
            Predicate<ExpressQueryResult> successful) throws Exception {
        ExpressQueryResult primaryResult = null;
        try {
            primaryResult = primary.query();
            if (successful.test(primaryResult)) return primaryResult;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw interrupted;
        } catch (Exception ignored) {
            // Provider failures are non-terminal because the explicit fallback still owns recovery.
        }
        try {
            ExpressQueryResult fallbackResult = fallback.query();
            if (successful.test(fallbackResult)
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
    public interface Source {
        ExpressQueryResult query() throws Exception;
    }
}
