package me.pipi.deliveries.util;

import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

/** Shared named daemon thread factories used by cross-app synchronized components. */
public final class PipiExecutors {
    private PipiExecutors() {}

    public static ThreadFactory namedFactory(String prefix) {
        String safePrefix = prefix == null || prefix.isEmpty() ? "deliveries-worker" : prefix;
        AtomicInteger sequence = new AtomicInteger(1);
        return runnable -> {
            Thread thread = new Thread(runnable, safePrefix + "-" + sequence.getAndIncrement());
            thread.setDaemon(true);
            return thread;
        };
    }
}
