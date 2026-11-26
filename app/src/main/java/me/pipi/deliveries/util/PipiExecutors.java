package me.pipi.deliveries.util;

import java.util.concurrent.Executor;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Shared named daemon thread factories used by cross-app synchronized components. */
public final class PipiExecutors {
    private static final ThreadPoolExecutor BACKGROUND_EXECUTOR = createBackgroundExecutor();

    private PipiExecutors() {}

    private static ThreadPoolExecutor createBackgroundExecutor() {
        ThreadPoolExecutor pool = new ThreadPoolExecutor(
                4, 4, 30L, TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(),
                namedFactory("deliveries-bg"));
        pool.allowCoreThreadTimeOut(true);
        return pool;
    }

    public static Executor backgroundExecutor() {
        return BACKGROUND_EXECUTOR;
    }

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
