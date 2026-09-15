package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public final class CarrierRecognitionCoordinatorTest {
    @Test public void replacementCannotStartUntilPreviousCacheCommitIsFenced() throws Exception {
        CountDownLatch oldCommitEntered = new CountDownLatch(1);
        CountDownLatch finishOldCommit = new CountDownLatch(1);
        CountDownLatch replacementProvider = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        AtomicReference<CarrierRecognitionCoordinator.Snapshot> value = new AtomicReference<>(
                CarrierRecognitionCoordinator.Snapshot.empty());
        CarrierRecognitionCoordinator.State state = new CarrierRecognitionCoordinator.State() {
            @Override public CarrierRecognitionCoordinator.Snapshot load(String identity) { return value.get(); }
            @Override public void save(String identity, CarrierRecognitionCoordinator.Snapshot next) {
                if (oldCommitEntered.getCount() > 0L) {
                    oldCommitEntered.countDown();
                    try {
                        assertTrue(finishOldCommit.await(3, TimeUnit.SECONDS));
                    } catch (InterruptedException interrupted) {
                        throw new AssertionError(interrupted);
                    }
                }
                value.set(next);
            }
        };
        CarrierRecognitionCoordinator coordinator = coordinator((url, cancellation) -> {
            int call = calls.incrementAndGet();
            if (call > 1) replacementProvider.countDown();
            return response(new JSONArray().put(new JSONObject()
                    .put("comCode", call == 1 ? "shunfeng" : "yuantong")));
        }, unusedGateway(), state, () -> 1_000L);
        ExecutorService pool = Executors.newFixedThreadPool(3);
        AtomicReference<Thread> cancellationThread = new AtomicReference<>();
        try (ExpressQueryCancellation subscriber = new ExpressQueryCancellation(5_000L)) {
            Future<?> original = pool.submit(() -> coordinator.recognize("SF1234567890", subscriber));
            assertTrue(oldCommitEntered.await(2, TimeUnit.SECONDS));
            Future<?> cancelling = pool.submit(() -> {
                cancellationThread.set(Thread.currentThread());
                subscriber.cancel();
            });
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while (System.nanoTime() < deadline && (cancellationThread.get() == null
                    || cancellationThread.get().getState() != Thread.State.BLOCKED)) Thread.yield();
            assertEquals(Thread.State.BLOCKED, cancellationThread.get().getState());
            Future<CarrierRecognitionCoordinator.Outcome> replacement = pool.submit(
                    () -> coordinator.recognize("SF1234567890", null));
            boolean overlapped = replacementProvider.await(200, TimeUnit.MILLISECONDS);
            finishOldCommit.countDown();
            cancelling.get(2, TimeUnit.SECONDS);
            try {
                original.get(2, TimeUnit.SECONDS);
                org.junit.Assert.fail("Original observer was cancelled");
            } catch (java.util.concurrent.ExecutionException expected) {
                assertTrue(expected.getCause() instanceof InterruptedException);
            }
            assertEquals("SF", replacement.get(2, TimeUnit.SECONDS).candidates.get(0).standardCode);
            assertFalse(overlapped);
            assertEquals(1, calls.get());
        } finally {
            finishOldCommit.countDown();
            pool.shutdownNow();
        }
    }

    @Test public void finalCallerCancellationStopsClassificationAndCacheCommit() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch aborted = new CountDownLatch(1);
        AtomicInteger classifyCalls = new AtomicInteger();
        AtomicInteger writes = new AtomicInteger();
        CarrierRecognitionCoordinator.State state = new CarrierRecognitionCoordinator.State() {
            @Override public CarrierRecognitionCoordinator.Snapshot load(String identity) {
                return CarrierRecognitionCoordinator.Snapshot.empty();
            }
            @Override public void save(String identity, CarrierRecognitionCoordinator.Snapshot value) {
                writes.incrementAndGet();
            }
        };
        CarrierRecognitionCoordinator coordinator = coordinator((url, cancellation) -> {
            started.countDown();
            try {
                while (true) {
                    cancellation.throwIfCancelled();
                    Thread.sleep(10L);
                }
            } catch (InterruptedException expected) {
                aborted.countDown();
                // Even a late successful HTTP body cannot start classification after cancellation.
                return response(new JSONArray());
            }
        }, gateway((path, payload) -> {
            classifyCalls.incrementAndGet();
            return response(new JSONObject());
        }), state, () -> 1_000L);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try (ExpressQueryCancellation subscriber = new ExpressQueryCancellation(5_000L)) {
            Future<?> result = pool.submit(() -> coordinator.recognize("SF1234567890", subscriber));
            assertTrue(started.await(2, TimeUnit.SECONDS));
            subscriber.cancel();
            try {
                result.get(2, TimeUnit.SECONDS);
                org.junit.Assert.fail("The final observer must leave");
            } catch (java.util.concurrent.ExecutionException expected) {
                assertTrue(expected.getCause() instanceof InterruptedException);
            }
            assertTrue(aborted.await(2, TimeUnit.SECONDS));
            assertEquals(0, classifyCalls.get());
            assertEquals(0, writes.get());
        } finally {
            pool.shutdownNow();
        }
    }

    @Test public void cancellingTheFirstCallerKeepsTheJoinedCallerAndTransportAlive() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        KeyedState state = new KeyedState();
        CarrierRecognitionCoordinator coordinator = coordinator((url, cancellation) -> {
            calls.incrementAndGet();
            started.countDown();
            while (!release.await(10, TimeUnit.MILLISECONDS)) cancellation.throwIfCancelled();
            return response(new JSONArray().put(new JSONObject().put("comCode", "shunfeng")));
        }, unusedGateway(), state, () -> 1_000L);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        AtomicReference<Thread> followerThread = new AtomicReference<>();
        try (ExpressQueryCancellation firstCancellation = new ExpressQueryCancellation(5_000L);
             ExpressQueryCancellation secondCancellation = new ExpressQueryCancellation(5_000L)) {
            Future<CarrierRecognitionCoordinator.Outcome> first = pool.submit(
                    () -> coordinator.recognize("SF1234567890", firstCancellation));
            assertTrue(started.await(2, TimeUnit.SECONDS));
            Future<CarrierRecognitionCoordinator.Outcome> second = pool.submit(() -> {
                followerThread.set(Thread.currentThread());
                return coordinator.recognize("SF1234567890", secondCancellation);
            });
            awaitWaiting(followerThread);
            firstCancellation.cancel();
            try {
                first.get(2, TimeUnit.SECONDS);
                org.junit.Assert.fail("Cancelled observer must leave");
            } catch (java.util.concurrent.ExecutionException expected) {
                assertTrue(expected.getCause() instanceof InterruptedException);
            }
            release.countDown();
            assertEquals("SF", second.get(2, TimeUnit.SECONDS).candidates.get(0).standardCode);
            assertEquals(1, calls.get());
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    private static void awaitWaiting(AtomicReference<Thread> thread) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (System.nanoTime() < deadline) {
            if (thread.get() != null && thread.get().getState() == Thread.State.TIMED_WAITING) return;
            Thread.yield();
        }
        org.junit.Assert.fail("Joined caller never began waiting");
    }
    @Test public void followerDeadlineDoesNotCancelOwnerOrSerializeOtherWaybills() throws Exception {
        CountDownLatch started = new CountDownLatch(2);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        KeyedState state = new KeyedState();
        CarrierRecognitionCoordinator coordinator = coordinator((url, cancellation) -> {
            calls.incrementAndGet();
            started.countDown();
            assertTrue(release.await(5, TimeUnit.SECONDS));
            return response(new JSONArray().put(new JSONObject().put("comCode", "shunfeng")));
        }, unusedGateway(), state, () -> 1_000L);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<CarrierRecognitionCoordinator.Outcome> first = pool.submit(
                    () -> coordinator.recognize("SF1234567890", null));
            Future<CarrierRecognitionCoordinator.Outcome> other = pool.submit(
                    () -> coordinator.recognize("SF2234567890", null));
            assertTrue(started.await(2, TimeUnit.SECONDS));
            try (ExpressQueryCancellation observer = new ExpressQueryCancellation(100L)) {
                try {
                    coordinator.recognize("SF1234567890", observer);
                    org.junit.Assert.fail("Follower deadline must end only its own wait");
                } catch (InterruptedException expected) {
                    assertFalse(first.isDone());
                }
            }
            release.countDown();
            assertEquals("SF", first.get(3, TimeUnit.SECONDS).candidates.get(0).standardCode);
            assertEquals("SF", other.get(3, TimeUnit.SECONDS).candidates.get(0).standardCode);
            assertEquals(2, calls.get());
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test public void cancelledOwnerDoesNotLeaveAPendingEntryOrConsumeFailureBudget() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        MemoryState state = new MemoryState();
        CarrierRecognitionCoordinator coordinator = coordinator((url, cancellation) -> {
            if (calls.incrementAndGet() == 1) throw new InterruptedException("Synthetic cancellation");
            return response(new JSONArray().put(new JSONObject().put("comCode", "shunfeng")));
        }, unusedGateway(), state, () -> 1_000L);
        try {
            coordinator.recognize("SF1234567890", null);
            org.junit.Assert.fail("Must propagate cancellation");
        } catch (InterruptedException expected) {
            assertEquals(0, state.value.networkFailures);
        }
        assertEquals("SF", coordinator.recognize("SF1234567890", null).candidates.get(0).standardCode);
        assertEquals(2, calls.get());
    }
    @Test public void sameWaybillSharesPendingWorkAcrossCoordinators() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch duplicate = new CountDownLatch(1);
        AtomicInteger publicCalls = new AtomicInteger();
        AtomicInteger classifyCalls = new AtomicInteger();
        KeyedState state = new KeyedState();
        Kuaidi100CarrierDetector.Transport transport = (url, cancellation) -> {
            if (publicCalls.incrementAndGet() > 1) duplicate.countDown();
            started.countDown();
            assertTrue(release.await(5, TimeUnit.SECONDS));
            return response(new JSONArray());
        };
        ExpressGatewayTransport gateway = gateway((path, payload) -> {
            classifyCalls.incrementAndGet();
            return response(new JSONObject().put("auto", new JSONArray().put(
                    new JSONObject().put("comCode", "shunfeng"))));
        });
        CarrierRecognitionCoordinator first = coordinator(transport, gateway, state, () -> 1_000L);
        CarrierRecognitionCoordinator second = coordinator(transport, gateway, state, () -> 1_000L);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<CarrierRecognitionCoordinator.Outcome> owner = pool.submit(
                    () -> first.recognize("SF1234567890", null));
            assertTrue(started.await(2, TimeUnit.SECONDS));
            Future<CarrierRecognitionCoordinator.Outcome> follower = pool.submit(
                    () -> second.recognize("sf123-4567890", null));
            duplicate.await(300, TimeUnit.MILLISECONDS);
            release.countDown();
            assertEquals("SF", owner.get(3, TimeUnit.SECONDS).candidates.get(0).standardCode);
            assertEquals("SF", follower.get(3, TimeUnit.SECONDS).candidates.get(0).standardCode);
            assertEquals(1, publicCalls.get());
            assertEquals(1, classifyCalls.get());
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }
    @Test
    public void pendingRecognitionPreservesFailuresAndWaitsWithoutProviderCalls() throws Exception {
        long[] now = {1_000L};
        int[] publicCalls = {0};
        int[] gatewayCalls = {0};
        MemoryState state = new MemoryState();
        state.value = new CarrierRecognitionCoordinator.Snapshot(
                me.pipi.deliveries.model.CarrierNormalization.NONE, 2, 0L, false);
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> { publicCalls[0]++; return response(new JSONArray()); },
                gateway((path, payload) -> {
                    gatewayCalls[0]++;
                    return new HttpClient.Response(502, new JSONObject()
                            .put("error", "recognition_pending").put("retryAt", now[0] + 60_000L)
                            .toString().getBytes(StandardCharsets.UTF_8));
                }), state, () -> now[0]);
        for (int attempt = 1; attempt <= 4; attempt++) {
            CarrierRecognitionCoordinator.Outcome result = coordinator.recognize("TEST123456", null);
            assertTrue(result.deferred);
            assertFalse(result.terminal);
            assertEquals(2, state.value.networkFailures);
            assertEquals(now[0] + 60_000L, state.value.retryAt);
            coordinator.recognize("TEST123456", null);
            assertEquals(attempt, publicCalls[0]);
            assertEquals(attempt, gatewayCalls[0]);
            now[0] += 60_000L;
        }
    }

    @Test
    public void pendingDeadlineIsBoundedAndGenericErrorsStillCount() throws Exception {
        long now = 1_000L;
        MemoryState state = new MemoryState();
        String[] code = {"recognition_pending"};
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> response(new JSONArray()),
                gateway((path, payload) -> new HttpClient.Response(502, new JSONObject()
                        .put("error", code[0]).put("retryAt", now + 10 * CarrierRecognitionCoordinator.RETRY_DELAY_MS)
                        .toString().getBytes(StandardCharsets.UTF_8))), state, () -> now);
        assertTrue(coordinator.recognize("TEST123456", null).deferred);
        assertEquals(now + CarrierRecognitionCoordinator.RETRY_DELAY_MS, state.value.retryAt);
        assertEquals(0, state.value.networkFailures);
        state.value = CarrierRecognitionCoordinator.Snapshot.empty();
        code[0] = "upstream_unavailable";
        try { coordinator.recognize("TEST123456", null); org.junit.Assert.fail("must fail"); }
        catch (IllegalStateException expected) { assertEquals(1, state.value.networkFailures); }
    }

    @Test
    public void successfulDirectRecognitionIsPersistedAndReused() throws Exception {
        int[] publicCalls = {0};
        MemoryState state = new MemoryState();
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> {
                    publicCalls[0]++;
                    return response(new JSONArray().put(
                            new JSONObject().put("comCode", "shunfeng")));
                }, unusedGateway(), state, () -> 1_000L);

        CarrierRecognitionCoordinator.Outcome first = coordinator.recognize(
                "SF1234567890", null);
        CarrierRecognitionCoordinator.Outcome second = coordinator.recognize(
                "SF1234567890", null);

        assertEquals(1, publicCalls[0]);
        assertEquals("SF", first.candidates.get(0).standardCode);
        assertEquals("shunfeng", second.candidates.get(0).kuaidi100Code);
    }

    @Test
    public void unmappedPublicCodeUsesExistingWorkerClassifyAsSecondLevel()
            throws Exception {
        String[] requestedPath = {""};
        JSONObject[] requestedPayload = {null};
        ExpressGatewayTransport gateway = gateway((path, payload) -> {
            requestedPath[0] = path;
            requestedPayload[0] = payload;
            return response(new JSONObject().put("auto", new JSONArray().put(
                    new JSONObject().put("comCode", "KYSY")
                            .put("name", "跨越速运"))));
        });
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> response(new JSONArray().put(
                        new JSONObject().put("comCode", "not-in-local-baseline"))),
                gateway, new MemoryState(), () -> 1_000L);

        CarrierRecognitionCoordinator.Outcome result = coordinator.recognize(
                "TEST123456", null);

        assertEquals("/api/express/classify", requestedPath[0]);
        assertTrue(requestedPayload[0].getBoolean("firstStageCompleted"));
        assertEquals(2, requestedPayload[0].length());
        assertEquals("KYSY", result.candidates.get(0).standardCode);
    }

    @Test
    public void networkFailuresWaitFifteenMinutesAndBecomeTerminalAfterThree()
            throws Exception {
        long[] now = {10_000L};
        int[] calls = {0};
        MemoryState state = new MemoryState();
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> {
                    calls[0]++;
                    throw new IOException("synthetic network failure");
                }, unusedGateway(), state, () -> now[0]);

        for (int attempt = 1; attempt <= 3; attempt++) {
            try {
                coordinator.recognize("TEST123456", null);
                org.junit.Assert.fail("Expected network failure");
            } catch (Exception expected) {
                // The detector translates transport errors into the gateway's stable
                // network-failure type; retry state must not depend on the wrapper type.
                assertTrue(expected.getMessage() != null);
            }
            CarrierRecognitionCoordinator.Outcome immediate = coordinator.recognize(
                    "TEST123456", null);
            if (attempt < 3) {
                assertTrue(immediate.deferred);
                assertFalse(immediate.terminal);
                now[0] += CarrierRecognitionCoordinator.RETRY_DELAY_MS;
            } else {
                assertTrue(immediate.terminal);
            }
        }
        assertEquals(3, calls[0]);
    }

    @Test
    public void staleResolvedPresentationHealsFromCurrentTableWithoutNetwork() throws Exception {
        int[] calls = {0};
        MemoryState state = new MemoryState();
        state.value = new CarrierRecognitionCoordinator.Snapshot(
                new me.pipi.deliveries.model.CarrierNormalization(
                        "HTKY", "百世快递", "jtexpress", true, "broken"),
                0, 0L, false);
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> {
                    calls[0]++;
                    return response(new JSONArray().put(
                            new JSONObject().put("comCode", "huitongkuaidi")));
                }, unusedGateway(), state, () -> 1_000L);

        CarrierRecognitionCoordinator.Outcome result = coordinator.recognize(
                "TEST123456", null);

        assertEquals(0, calls[0]);
        assertEquals("HTKY", result.candidates.get(0).standardCode);
        assertEquals("极兔速递", result.candidates.get(0).displayName);
        assertEquals("huitongkuaidi", result.candidates.get(0).kuaidi100Code);
    }

    @Test
    public void unknownCachedStandardCodeRunsRecognitionAgain() throws Exception {
        int[] calls = {0};
        MemoryState state = new MemoryState();
        state.value = new CarrierRecognitionCoordinator.Snapshot(
                new me.pipi.deliveries.model.CarrierNormalization(
                        "REMOVED", "旧承运商", "removed", true, "old"),
                0, 0L, false);
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> {
                    calls[0]++;
                    return response(new JSONArray().put(
                            new JSONObject().put("comCode", "shunfeng")));
                }, unusedGateway(), state, () -> 1_000L);

        CarrierRecognitionCoordinator.Outcome result = coordinator.recognize(
                "TEST123456", null);

        assertEquals(1, calls[0]);
        assertEquals("SF", result.candidates.get(0).standardCode);
    }

    @Test
    public void equivalentWaybillFormattingUsesOneDurableIdentity() throws Exception {
        int[] calls = {0};
        KeyedState state = new KeyedState();
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> {
                    calls[0]++;
                    return response(new JSONArray().put(
                            new JSONObject().put("comCode", "shunfeng")));
                }, unusedGateway(), state, () -> 1_000L);

        coordinator.recognize("SF 123-456", null);
        CarrierRecognitionCoordinator.Outcome reused = coordinator.recognize(
                "sf123456", null);

        assertEquals(1, calls[0]);
        assertEquals("SF", reused.candidates.get(0).standardCode);
    }

    @Test
    public void punctuationOnlyWaybillNeverCreatesSharedEmptyIdentity() throws Exception {
        int[] calls = {0};
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> {
                    calls[0]++;
                    return response(new JSONArray());
                }, unusedGateway(), new KeyedState(), () -> 1_000L);

        CarrierRecognitionCoordinator.Outcome result = coordinator.recognize(
                "------", null);

        assertTrue(result.terminal);
        assertEquals(0, calls[0]);
    }

    private static CarrierRecognitionCoordinator coordinator(
            Kuaidi100CarrierDetector.Transport transport,
            ExpressGatewayTransport gateway,
            CarrierRecognitionCoordinator.State state,
            CarrierRecognitionCoordinator.Clock clock) {
        return new CarrierRecognitionCoordinator(
                new Kuaidi100CarrierDetector(transport), gateway, state, clock);
    }

    private static ExpressGatewayTransport unusedGateway() {
        return gateway((path, payload) -> {
            throw new AssertionError("Gateway must not be called");
        });
    }

    private static ExpressGatewayTransport gateway(Responder responder) {
        return new ExpressGatewayTransport() {
            @Override public boolean configured() { return true; }

            @Override public HttpClient.Response post(String path, JSONObject payload)
                    throws Exception {
                return responder.post(path, payload);
            }
        };
    }

    private static HttpClient.Response response(Object body) {
        return new HttpClient.Response(200, String.valueOf(body)
                .getBytes(StandardCharsets.UTF_8));
    }

    private static final class MemoryState implements CarrierRecognitionCoordinator.State {
        CarrierRecognitionCoordinator.Snapshot value =
                CarrierRecognitionCoordinator.Snapshot.empty();

        @Override public synchronized CarrierRecognitionCoordinator.Snapshot load(String identity) {
            return value;
        }

        @Override public synchronized void save(
                String identity, CarrierRecognitionCoordinator.Snapshot snapshot) {
            value = snapshot;
        }
    }

    private static final class KeyedState implements CarrierRecognitionCoordinator.State {
        private final Map<String, CarrierRecognitionCoordinator.Snapshot> values =
                new HashMap<>();

        @Override public synchronized CarrierRecognitionCoordinator.Snapshot load(String identity) {
            return values.getOrDefault(
                    identity, CarrierRecognitionCoordinator.Snapshot.empty());
        }

        @Override public synchronized void save(
                String identity, CarrierRecognitionCoordinator.Snapshot snapshot) {
            values.put(identity, snapshot);
        }
    }

    @FunctionalInterface
    private interface Responder {
        HttpClient.Response post(String path, JSONObject payload) throws Exception;
    }
}
