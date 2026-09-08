package me.pipi.deliveries.feature.express;

import android.content.Context;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.data.ExpressOrderProjectionIdentity;
import me.pipi.deliveries.data.ExpressRepository;

/** Persists a bounded retry delay for an unresolved account-order H5 projection. */
final class ExpressOrderProjectionRetryStore {
    static final long FAILURE_COOLDOWN_MS = 60L * 60L * 1000L;

    private static final String PREFS = "express_order_projection_retries";
    private static final Map<String, AttemptToken> ACTIVE_ATTEMPTS = new HashMap<>();
    private static final Map<String, Map<String, Runnable>> RELEASE_WAITERS = new HashMap<>();
    private final ExpressRepository repository;

    ExpressOrderProjectionRetryStore(Context context) {
        Context application = context.getApplicationContext();
        application.deleteSharedPreferences(PREFS);
        repository = ExpressRepository.get(application);
    }

    AttemptToken beginAttempt(ExpressItem item, long now, boolean force) {
        if (!ExpressHomeOrderProjectionCapture.needsProjection(item)) return null;
        String identity = stableIdentity(item);
        if (identity.isEmpty()) return null;
        synchronized (ACTIVE_ATTEMPTS) {
            if (ACTIVE_ATTEMPTS.containsKey(identity)) return null;
            if (!force) {
                ExpressRepository.OrderProjectionRetryState state =
                        repository.orderProjectionRetryState(item);
                if (!shouldAttempt(state.failedAt, state.routeFingerprint,
                        routeFingerprint(item), now, false)) return null;
            }
            return acquireAttemptLocked(identity);
        }
    }

    static AttemptToken acquireAttempt(ExpressItem item) {
        String identity = stableIdentity(item);
        if (identity.isEmpty()) return null;
        synchronized (ACTIVE_ATTEMPTS) {
            if (ACTIVE_ATTEMPTS.containsKey(identity)) return null;
            return acquireAttemptLocked(identity);
        }
    }

    private static AttemptToken acquireAttemptLocked(String identity) {
        AttemptToken token = new AttemptToken(identity, UUID.randomUUID().toString());
        ACTIVE_ATTEMPTS.put(identity, token);
        return token;
    }

    void endAttempt(AttemptToken token) {
        releaseAttempt(token);
    }

    static boolean completeAttempt(
            AttemptToken token, Runnable beforeRelease,
            AttemptFailureReporter failureReporter) {
        Objects.requireNonNull(failureReporter, "failureReporter");
        if (token == null || token.identity.isEmpty()) return false;
        List<Runnable> wakeups = null;
        boolean completed = false;
        RuntimeException completionFailure = null;
        synchronized (ACTIVE_ATTEMPTS) {
            if (ACTIVE_ATTEMPTS.get(token.identity) != token) return false;
            try {
                if (beforeRelease != null) beforeRelease.run();
                completed = true;
            } catch (RuntimeException failure) {
                completionFailure = failure;
            } finally {
                if (ACTIVE_ATTEMPTS.get(token.identity) == token) {
                    ACTIVE_ATTEMPTS.remove(token.identity);
                    wakeups = drainWaitersLocked(token.identity);
                }
            }
        }
        runWakeups(wakeups);
        if (completionFailure != null) failureReporter.report(completionFailure);
        return completed;
    }

    static boolean releaseAttempt(AttemptToken token) {
        if (token == null || token.identity.isEmpty()) return false;
        List<Runnable> wakeups;
        synchronized (ACTIVE_ATTEMPTS) {
            if (ACTIVE_ATTEMPTS.get(token.identity) != token) return false;
            ACTIVE_ATTEMPTS.remove(token.identity);
            wakeups = drainWaitersLocked(token.identity);
        }
        runWakeups(wakeups);
        return true;
    }

    static WaitToken waitForAttemptRelease(ExpressItem item, Runnable wakeup) {
        String identity = stableIdentity(item);
        if (identity.isEmpty() || wakeup == null) return null;
        synchronized (ACTIVE_ATTEMPTS) {
            if (!ACTIVE_ATTEMPTS.containsKey(identity)) return null;
            WaitToken token = new WaitToken(identity, UUID.randomUUID().toString());
            RELEASE_WAITERS.computeIfAbsent(identity, ignored -> new HashMap<>())
                    .put(token.nonce, wakeup);
            return token;
        }
    }

    static boolean cancelWait(WaitToken token) {
        if (token == null || token.identity.isEmpty() || token.nonce.isEmpty()) return false;
        synchronized (ACTIVE_ATTEMPTS) {
            Map<String, Runnable> waiters = RELEASE_WAITERS.get(token.identity);
            if (waiters == null || waiters.remove(token.nonce) == null) return false;
            if (waiters.isEmpty()) RELEASE_WAITERS.remove(token.identity);
            return true;
        }
    }

    private static List<Runnable> drainWaitersLocked(String identity) {
        Map<String, Runnable> waiters = RELEASE_WAITERS.remove(identity);
        return waiters == null || waiters.isEmpty()
                ? null : new ArrayList<>(waiters.values());
    }

    private static void runWakeups(List<Runnable> wakeups) {
        if (wakeups == null) return;
        for (Runnable wakeup : wakeups) {
            try {
                wakeup.run();
            } catch (RuntimeException ignored) {
                // One abandoned screen must not prevent other waiters from observing release.
            }
        }
    }

    @FunctionalInterface
    interface AttemptFailureReporter {
        void report(RuntimeException failure);
    }

    static final class AttemptToken {
        final String identity;
        final String nonce;

        AttemptToken(String identity, String nonce) {
            this.identity = identity == null ? "" : identity;
            this.nonce = nonce == null ? "" : nonce;
        }
    }

    static final class WaitToken {
        final String identity;
        final String nonce;

        WaitToken(String identity, String nonce) {
            this.identity = identity == null ? "" : identity;
            this.nonce = nonce == null ? "" : nonce;
        }
    }

    static ExpressItem currentUnresolvedOwner(ExpressItem expected, ExpressItem current) {
        return ExpressOrderProjectionBridge.sameUnresolvedOwner(expected, current)
                && ExpressHomeOrderProjectionCapture.needsProjection(current)
                ? current : null;
    }

    void recordFailure(ExpressItem item, long now) {
        if (item == null) return;
        repository.recordOrderProjectionFailure(item, now, routeFingerprint(item));
    }

    void clear(ExpressItem item) {
        if (item == null) return;
        repository.clearOrderProjectionRetry(item);
    }

    static boolean shouldAttempt(
            long failedAt, String failedRouteFingerprint,
            String currentRouteFingerprint, long now) {
        return shouldAttempt(failedAt, failedRouteFingerprint,
                currentRouteFingerprint, now, false);
    }

    static boolean shouldAttempt(
            long failedAt, String failedRouteFingerprint,
            String currentRouteFingerprint, long now, boolean force) {
        if (force) return true;
        if (failedAt <= 0L || failedRouteFingerprint == null
                || !failedRouteFingerprint.equals(currentRouteFingerprint)) return true;
        // A wall-clock rollback must not turn a transient failure into a permanent block.
        if (now < failedAt) return true;
        return now - failedAt >= FAILURE_COOLDOWN_MS;
    }

    static String stableIdentity(ExpressItem item) {
        return ExpressOrderProjectionIdentity.stableIdentity(item);
    }

    static String routeFingerprint(ExpressItem item) {
        return ExpressOrderProjectionIdentity.routeFingerprint(item);
    }
}
