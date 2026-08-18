package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.Test;

public final class ExpressQueryCancellationTest {
    @Test
    public void cancellationTearsDownTheActiveRequestExactlyOnce() throws Exception {
        ExpressQueryCancellation cancellation = new ExpressQueryCancellation(10_000L);
        AtomicInteger disconnects = new AtomicInteger();
        Runnable disconnect = disconnects::incrementAndGet;
        cancellation.attach(disconnect);

        cancellation.cancel();
        cancellation.cancel();

        assertTrue(cancellation.isCancelled());
        assertEquals(1, disconnects.get());
        try {
            cancellation.throwIfCancelled();
            org.junit.Assert.fail("Expected cancellation");
        } catch (InterruptedException expected) {
            // Expected: callers stop before starting another provider request.
        }
    }

    @Test
    public void requestTimeoutIsBoundedByTheWholeQueryDeadline() throws Exception {
        ExpressQueryCancellation cancellation = new ExpressQueryCancellation(10_000L);

        int bounded = cancellation.remainingTimeoutMillis(20_000);

        assertTrue(bounded > 0);
        assertTrue(bounded <= 10_000);
    }

    @Test
    public void cancellingAnActiveHttpRequestDisconnectsItPromptly() throws Exception {
        CountDownLatch accepted = new CountDownLatch(1);
        CountDownLatch releaseServer = new CountDownLatch(1);
        ExecutorService serverWorker = Executors.newSingleThreadExecutor();
        ExecutorService clientWorker = Executors.newSingleThreadExecutor();
        try (ServerSocket server = new ServerSocket(
                0, 1, InetAddress.getByName("127.0.0.1"))) {
            Future<?> serverTask = serverWorker.submit(() -> {
                try (Socket ignored = server.accept()) {
                    accepted.countDown();
                    releaseServer.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                } catch (Exception ignored) {
                    // Closing the test server is the expected teardown path.
                }
            });
            ExpressQueryCancellation cancellation =
                    new ExpressQueryCancellation(5_000L);
            Future<HttpClient.Response> request = clientWorker.submit(() ->
                    HttpClient.postJson(
                            "http://127.0.0.1:" + server.getLocalPort(), "{}",
                            Collections.emptyMap(), false, cancellation));

            assertTrue(accepted.await(2, TimeUnit.SECONDS));
            cancellation.cancel();
            try {
                request.get(2, TimeUnit.SECONDS);
                org.junit.Assert.fail("Expected cancellation");
            } catch (ExecutionException expected) {
                assertTrue(expected.getCause() instanceof InterruptedException);
            }
            releaseServer.countDown();
            serverTask.get(2, TimeUnit.SECONDS);
        } finally {
            releaseServer.countDown();
            clientWorker.shutdownNow();
            serverWorker.shutdownNow();
        }
    }
}
