package me.pipi.deliveries.background;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** Runs at most two network requests; their commits remain on the owning refresh thread. */
final class ExpressRefreshQueue implements AutoCloseable {
    private final ExecutorService executor = Executors.newFixedThreadPool(2);
    private final List<Future<Runnable>> pending = new ArrayList<>();

    void submit(Callable<Runnable> request) { pending.add(executor.submit(request)); }

    void drain() {
        for (Future<Runnable> request : pending) {
            try {
                Runnable commit = request.get();
                if (commit != null) commit.run();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new CancellationException("Refresh interrupted");
            } catch (ExecutionException failed) {
                Throwable cause = failed.getCause();
                if (cause instanceof Error) throw (Error) cause;
                if (cause instanceof RuntimeException) throw (RuntimeException) cause;
                throw new IllegalStateException("Refresh request failed", cause);
            }
        }
    }

    @Override public void close() {
        for (Future<Runnable> request : pending) request.cancel(true);
        executor.shutdownNow();
    }
}
