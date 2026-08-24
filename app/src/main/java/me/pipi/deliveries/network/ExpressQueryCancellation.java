package me.pipi.deliveries.network;

import java.util.concurrent.TimeUnit;

/** One finite, cancellable lifetime shared by every request in an express query. */
public final class ExpressQueryCancellation {
    private final Object lock = new Object();
    private final long deadlineNanos;
    private boolean cancelled;
    private Runnable activeCancellation;

    public ExpressQueryCancellation(long timeoutMillis) {
        if (timeoutMillis <= 0L) throw new IllegalArgumentException("timeout must be positive");
        deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
    }

    public void cancel() {
        Runnable cancellation;
        synchronized (lock) {
            if (cancelled) return;
            cancelled = true;
            cancellation = activeCancellation;
            activeCancellation = null;
        }
        if (cancellation != null) {
            try {
                cancellation.run();
            } catch (RuntimeException ignored) {
                // Cancellation remains final even if a transport has already torn itself down.
            }
        }
    }

    public boolean isCancelled() {
        synchronized (lock) {
            return cancelled || deadlineNanos - System.nanoTime() <= 0L;
        }
    }

    public void throwIfCancelled() throws InterruptedException {
        if (Thread.currentThread().isInterrupted() || isCancelled()) {
            throw new InterruptedException("Express query cancelled");
        }
    }

    int remainingTimeoutMillis(int maximumMillis) throws InterruptedException {
        if (maximumMillis <= 0) throw new IllegalArgumentException("maximum must be positive");
        throwIfCancelled();
        long remainingNanos = deadlineNanos - System.nanoTime();
        if (remainingNanos <= 0L) throw new InterruptedException("Express query timed out");
        long remainingMillis = TimeUnit.NANOSECONDS.toMillis(remainingNanos);
        if (remainingMillis <= 0L) remainingMillis = 1L;
        return (int) Math.min(maximumMillis, remainingMillis);
    }

    void attach(Runnable cancellation) throws InterruptedException {
        if (cancellation == null) throw new IllegalArgumentException("cancellation is required");
        boolean cancelNow;
        synchronized (lock) {
            cancelNow = cancelled || deadlineNanos - System.nanoTime() <= 0L
                    || Thread.currentThread().isInterrupted();
            if (!cancelNow) {
                if (activeCancellation != null) {
                    throw new IllegalStateException("Express query already has an active request");
                }
                activeCancellation = cancellation;
            }
        }
        if (cancelNow) {
            try {
                cancellation.run();
            } catch (RuntimeException ignored) {
                // The caller still observes cancellation below.
            }
            throw new InterruptedException("Express query cancelled");
        }
    }

    void detach(Runnable cancellation) {
        synchronized (lock) {
            if (activeCancellation == cancellation) activeCancellation = null;
        }
    }
}
