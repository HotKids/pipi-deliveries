package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;

/**
 * 用户 2026-09-27 提交前核对答复四（同步轮里单个请求自身超时「四端对齐 iOS」）：in a sync round a recognition request
 * that its own time limit ends — a connect or read timeout, or the shared request's budget — records no failure and no
 * terminal verdict; the round is told it timed out and marks it cut off. 用户 2026-09-27 提交前核对答复五（轮外请求自身
 * 超时「四端都不算失败（对齐 iOS）」）：outside a sync round such a timeout records nothing either, and marks nothing; the
 * caller sees the same network failure as before. A refused connection, an unknown host, an HTTP error or an explicit
 * failure answer is still a counted failure, in a round or not.
 */
public final class CarrierRecognitionRoundTimeoutTest {
    private static final String WAYBILL = "SF1234567890";

    @After public void tearDown() {
        CarrierRecognitionCoordinator.sharedRequestBudgetOverrideMillis = 0L;
    }

    /** The free level times out in four sync rounds: no failure, no cooldown, no terminal verdict. */
    @Test(timeout = 20_000L)
    public void aFreeLevelTimeoutInASyncRoundRecordsNothing() throws Exception {
        AtomicInteger requests = new AtomicInteger();
        AtomicBoolean answerNow = new AtomicBoolean();
        MemoryState state = new MemoryState();
        CarrierRecognitionCoordinator coordinator = coordinator((url, cancellation) -> {
            requests.incrementAndGet();
            if (answerNow.get()) {
                return response(new JSONArray().put(new JSONObject().put("comCode", "shunfeng")));
            }
            throw new SocketTimeoutException("connect timed out");
        }, gateway(new AtomicInteger(), () -> {
            throw new AssertionError("the paid level is never reached");
        }), state);
        for (int round = 1; round <= CarrierRecognitionCoordinator.MAX_NETWORK_FAILURES + 1; round++) {
            try {
                coordinator.recognize(WAYBILL, null, false, true);
                fail("the round is told the request timed out");
            } catch (CarrierRecognitionTimeoutException expected) {
                // Nothing recorded; the round marks it cut off.
            }
            assertNothingRecorded(state);
            assertEquals("round " + round + " asked again", round, requests.get());
        }
        answerNow.set(true);
        assertEquals("SF", coordinator.recognize(WAYBILL, null, false, true).candidates.get(0).standardCode);
    }

    /** The paid level (Worker classify, read timeout) in a sync round: the same. */
    @Test(timeout = 20_000L)
    public void aPaidLevelTimeoutInASyncRoundRecordsNothing() throws Exception {
        AtomicInteger classifications = new AtomicInteger();
        MemoryState state = new MemoryState();
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> response(new JSONArray()),
                gateway(classifications, () -> {
                    // What ExpressGatewayClient throws for a timed-out exchange.
                    throw GatewayHttpErrors.networkFailure(new SocketTimeoutException("Read timed out"));
                }), state);
        for (int round = 1; round <= CarrierRecognitionCoordinator.MAX_NETWORK_FAILURES + 1; round++) {
            try {
                coordinator.recognize(WAYBILL, null, false, true);
                fail("the round is told the request timed out");
            } catch (CarrierRecognitionTimeoutException expected) {
                // Nothing recorded.
            }
            assertNothingRecorded(state);
            assertEquals(round, classifications.get());
        }
    }

    /**
     * 用户 2026-09-27 提交前核对答复五 (migrated from the previous "a timeout outside a sync round still counts" case):
     * outside a sync round (a detail refresh) the free level's own timeout records nothing either — four times over,
     * no cooldown, no terminal verdict — while the caller still sees the network failure it saw before.
     */
    @Test(timeout = 20_000L)
    public void aFreeLevelTimeoutOutsideASyncRoundRecordsNothing() throws Exception {
        AtomicInteger requests = new AtomicInteger();
        AtomicBoolean answerNow = new AtomicBoolean();
        MemoryState state = new MemoryState();
        CarrierRecognitionCoordinator coordinator = coordinator((url, cancellation) -> {
            requests.incrementAndGet();
            if (answerNow.get()) {
                return response(new JSONArray().put(new JSONObject().put("comCode", "shunfeng")));
            }
            throw new SocketTimeoutException("connect timed out");
        }, gateway(new AtomicInteger(), () -> {
            throw new AssertionError("the paid level is never reached");
        }), state);
        for (int attempt = 1; attempt <= CarrierRecognitionCoordinator.MAX_NETWORK_FAILURES + 1; attempt++) {
            try (ExpressQueryCancellation detail = new ExpressQueryCancellation(10_000L)) {
                coordinator.recognize(WAYBILL, detail);
                fail("the failure is reported");
            } catch (IllegalStateException expected) {
                assertEquals("网络异常，请稍后重试", expected.getMessage());
            }
            assertNothingRecorded(state);
            assertEquals("attempt " + attempt + " asked again", attempt, requests.get());
        }
        answerNow.set(true);
        assertEquals("SF", coordinator.recognize(WAYBILL, null).candidates.get(0).standardCode);
    }

    /** 用户 2026-09-27 提交前核对答复五: the paid level's own timeout outside a sync round, likewise. */
    @Test(timeout = 20_000L)
    public void aPaidLevelTimeoutOutsideASyncRoundRecordsNothing() throws Exception {
        MemoryState state = new MemoryState();
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> response(new JSONArray()),
                gateway(new AtomicInteger(), () -> {
                    throw GatewayHttpErrors.networkFailure(new SocketTimeoutException("Read timed out"));
                }), state);
        for (int attempt = 1; attempt <= CarrierRecognitionCoordinator.MAX_NETWORK_FAILURES + 1; attempt++) {
            try {
                coordinator.recognize(WAYBILL, null, true);
                fail("the failure is reported");
            } catch (IllegalStateException expected) {
                // The same failure the caller saw before; nothing recorded.
            }
            assertNothingRecorded(state);
        }
    }

    /** 用户 2026-09-27 提交前核对答复五: outside a sync round a refused connection is still a counted failure. */
    @Test(timeout = 20_000L)
    public void aNetworkFailureThatIsNoTimeoutStillCountsOutsideASyncRound() throws Exception {
        MemoryState state = new MemoryState();
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> {
                    throw new java.net.ConnectException("Connection refused");
                }, gateway(new AtomicInteger(), () -> {
                    throw new AssertionError("the paid level is never reached");
                }), state);
        try {
            coordinator.recognize(WAYBILL, null);
            fail("the failure is reported");
        } catch (IllegalStateException expected) {
            // Counted as before.
        }
        assertEquals(1, state.value.networkFailures);
        assertTrue(state.value.retryAt > 0L);
    }

    /** An answer other than a timeout (here a refused connection) is still a failure in a sync round too. */
    @Test(timeout = 20_000L)
    public void aNetworkFailureThatIsNoTimeoutStillCountsInASyncRound() throws Exception {
        MemoryState state = new MemoryState();
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> {
                    throw new java.net.ConnectException("Connection refused");
                }, gateway(new AtomicInteger(), () -> {
                    throw new AssertionError("the paid level is never reached");
                }), state);
        try {
            coordinator.recognize(WAYBILL, null, false, true);
            fail("the failure is reported");
        } catch (IllegalStateException expected) {
            // Counted as before.
        }
        assertEquals(1, state.value.networkFailures);
    }

    /**
     * The shared request's own budget ({@code SHARED_REQUEST_BUDGET_MS}) ends it while a sync round waits: the round
     * is told it timed out instead of being interrupted, and nothing is recorded. A caller outside a round is
     * interrupted, as before.
     */
    @Test(timeout = 20_000L)
    public void theSharedRequestBudgetEndingInASyncRoundIsATimeout() throws Exception {
        CarrierRecognitionCoordinator.sharedRequestBudgetOverrideMillis = 200L;
        MemoryState state = new MemoryState();
        CarrierRecognitionCoordinator coordinator = coordinator((url, cancellation) -> {
            // As HttpClient does: the request waits until its cancellation (here its deadline) ends it.
            while (true) {
                cancellation.throwIfCancelled();
                Thread.sleep(5L);
            }
        }, gateway(new AtomicInteger(), () -> {
            throw new AssertionError("the paid level is never reached");
        }), state);
        try {
            coordinator.recognize(WAYBILL, null, false, true);
            fail("the round is told the request timed out");
        } catch (CarrierRecognitionTimeoutException expected) {
            assertFalse("the round's thread is not interrupted", Thread.currentThread().isInterrupted());
        }
        assertNothingRecorded(state);
        try {
            coordinator.recognize(WAYBILL, null);
            fail("a caller outside a round is interrupted");
        } catch (InterruptedException expected) {
            // Unchanged outside a round.
        }
        assertNothingRecorded(state);
    }

    /**
     * A request a detail refresh started and a sync round joined: when it times out while the round waits, the
     * round's rule applies to the shared request (no failure); every waiting caller is told it timed out.
     */
    @Test(timeout = 20_000L)
    public void aSharedRequestTimingOutWhileARoundWaitsRecordsNothing() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        MemoryState state = new MemoryState();
        CarrierRecognitionCoordinator coordinator = coordinator((url, cancellation) -> {
            started.countDown();
            assertTrue(release.await(5, TimeUnit.SECONDS));
            throw new SocketTimeoutException("Read timed out");
        }, gateway(new AtomicInteger(), () -> {
            throw new AssertionError("the paid level is never reached");
        }), state);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try (ExpressQueryCancellation detail = new ExpressQueryCancellation(10_000L)) {
            Future<CarrierRecognitionCoordinator.Outcome> detailWait = pool.submit(
                    () -> coordinator.recognize(WAYBILL, detail));
            assertTrue(started.await(2, TimeUnit.SECONDS));
            AtomicReference<Thread> roundThread = new AtomicReference<>();
            Future<CarrierRecognitionCoordinator.Outcome> roundWait = pool.submit(() -> {
                roundThread.set(Thread.currentThread());
                return coordinator.recognize(WAYBILL, null, false, true);
            });
            long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while ((roundThread.get() == null
                    || roundThread.get().getState() != Thread.State.TIMED_WAITING)
                    && System.nanoTime() < until) {
                Thread.yield();
            }
            assertEquals("the round waits on the shared request",
                    Thread.State.TIMED_WAITING, roundThread.get().getState());
            release.countDown();
            for (Future<CarrierRecognitionCoordinator.Outcome> wait : List.of(detailWait, roundWait)) {
                try {
                    wait.get(3, TimeUnit.SECONDS);
                    fail("both callers are told it timed out");
                } catch (ExecutionException expected) {
                    assertTrue(expected.getCause() instanceof CarrierRecognitionTimeoutException);
                }
            }
            assertNothingRecorded(state);
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    private static void assertNothingRecorded(MemoryState state) {
        assertEquals("no failure counted", 0, state.value.networkFailures);
        assertFalse("no terminal verdict", state.value.terminal);
        assertEquals("no cooldown", 0L, state.value.retryAt);
    }

    private static CarrierRecognitionCoordinator coordinator(
            Kuaidi100CarrierDetector.Transport transport, ExpressGatewayTransport gateway,
            CarrierRecognitionCoordinator.State state) {
        return new CarrierRecognitionCoordinator(
                new Kuaidi100CarrierDetector(transport), gateway, state, System::currentTimeMillis);
    }

    private interface Post {
        void run() throws Exception;
    }

    private static ExpressGatewayTransport gateway(AtomicInteger calls, Post post) {
        return new ExpressGatewayTransport() {
            @Override public boolean configured() {
                return true;
            }

            @Override public HttpClient.Response post(String path, JSONObject payload) throws Exception {
                calls.incrementAndGet();
                post.run();
                return response(new JSONObject());
            }
        };
    }

    private static HttpClient.Response response(Object body) {
        return new HttpClient.Response(200, String.valueOf(body).getBytes(StandardCharsets.UTF_8));
    }

    private static final class MemoryState implements CarrierRecognitionCoordinator.State {
        CarrierRecognitionCoordinator.Snapshot value = CarrierRecognitionCoordinator.Snapshot.empty();

        @Override public synchronized CarrierRecognitionCoordinator.Snapshot load(String identity) {
            return value;
        }

        @Override public synchronized void save(
                String identity, CarrierRecognitionCoordinator.Snapshot snapshot) {
            value = snapshot;
        }
    }
}
