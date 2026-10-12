package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import me.pipi.deliveries.background.AccountCarrierRecognition;
import me.pipi.deliveries.model.CarrierNormalization;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * 用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒。预算到点时正在进行的识别请求被取消；被取消的请求不写失败次数、
 * 不写终态——下一轮照常再问，满三次也不进终态。走真实的 {@link ExpressApi} → {@link CarrierRecognitionCoordinator}，
 * 请求由这里的 transport 模拟。
 */
public final class CarrierRecognitionBudgetCancellationTest {
    private static final String WAYBILL = "SF1234567890";

    /** The free level hangs until it is cancelled; four cut rounds leave no cooldown and no terminal verdict. */
    @Test(timeout = 20_000L)
    public void aFreeLevelRequestCutAtTheBudgetRecordsNoFailure() throws Exception {
        AtomicInteger requests = new AtomicInteger();
        AtomicInteger aborted = new AtomicInteger();
        AtomicBoolean answerNow = new AtomicBoolean();
        ExpressApi api = new ExpressApi(gateway(() -> {
            throw new AssertionError("the paid level is never reached");
        }), new Kuaidi100CarrierDetector((url, cancellation) -> {
            requests.incrementAndGet();
            if (answerNow.get()) {
                return response(new JSONArray().put(new JSONObject().put("comCode", "shunfeng")));
            }
            hangUntilCancelled(cancellation, aborted);
            throw new AssertionError("unreachable");
        }));
        // More cut rounds than MAX_NETWORK_FAILURES: a recorded failure would cool the next round and
        // the third would be terminal.
        for (int round = 1; round <= CarrierRecognitionCoordinator.MAX_NETWORK_FAILURES + 1; round++) {
            cutAtTheBudget(api);
            assertTrue("round " + round + ": the request in flight is cancelled",
                    await(aborted, round));
            assertEquals("round " + round + " asked again: nothing was recorded", round, requests.get());
        }
        answerNow.set(true);
        CarrierNormalization answer = AccountCarrierRecognition.bounded(
                new AccountCarrierRecognition.Budget(5_000L),
                waybill -> api.recognizeCarrier(waybill, null)).recognize(WAYBILL);
        assertEquals("neither cooling nor terminal", "SF", answer.standardCode);
    }

    /** The paid level (Worker classify) hangs; its cut rounds record no failure either. */
    @Test(timeout = 20_000L)
    public void aPaidLevelRequestCutAtTheBudgetRecordsNoFailure() throws Exception {
        AtomicInteger classifications = new AtomicInteger();
        AtomicInteger aborted = new AtomicInteger();
        AtomicBoolean answerNow = new AtomicBoolean();
        ExpressGatewayTransport gateway = new ExpressGatewayTransport() {
            @Override public boolean configured() {
                return true;
            }

            @Override public HttpClient.Response post(String path, JSONObject payload) {
                throw new AssertionError("the paid level takes the round's cancellation");
            }

            @Override public HttpClient.Response post(
                    String path, JSONObject payload, ExpressQueryCancellation cancellation)
                    throws Exception {
                classifications.incrementAndGet();
                if (answerNow.get()) {
                    return response(new JSONObject().put("auto", new JSONArray()
                            .put(new JSONObject().put("comCode", "SF"))));
                }
                hangUntilCancelled(cancellation, aborted);
                throw new AssertionError("unreachable");
            }
        };
        ExpressApi api = new ExpressApi(gateway, new Kuaidi100CarrierDetector(
                (url, cancellation) -> response(new JSONArray())));
        for (int round = 1; round <= CarrierRecognitionCoordinator.MAX_NETWORK_FAILURES + 1; round++) {
            cutAtTheBudget(api);
            assertTrue("round " + round + ": the paid request is cancelled", await(aborted, round));
            assertEquals("round " + round + " reached the paid level again", round, classifications.get());
        }
        answerNow.set(true);
        CarrierNormalization answer = AccountCarrierRecognition.bounded(
                new AccountCarrierRecognition.Budget(5_000L),
                waybill -> api.recognizeCarrier(waybill, null)).recognize(WAYBILL);
        assertEquals("SF", answer.standardCode);
    }

    private static void cutAtTheBudget(ExpressApi api) throws Exception {
        AccountCarrierRecognition.Budget budget = new AccountCarrierRecognition.Budget(200L);
        AccountCarrierRecognition.Recognizer recognizer = AccountCarrierRecognition.bounded(
                budget, waybill -> api.recognizeCarrier(waybill, null));
        long started = System.nanoTime();
        try {
            recognizer.recognize(WAYBILL);
            fail("the budget ends the wait");
        } catch (AccountCarrierRecognition.BudgetSpentException expected) {
            // The round goes on without an answer for this waybill.
        }
        assertTrue("the wait stops at the budget",
                System.nanoTime() - started < TimeUnit.SECONDS.toNanos(2));
        assertTrue(budget.spent());
        assertFalse("the round's own thread is not interrupted", Thread.currentThread().isInterrupted());
        try {
            recognizer.recognize(WAYBILL);
            fail("a spent budget asks nothing more");
        } catch (AccountCarrierRecognition.BudgetSpentException expected) {
            // Nothing is sent once the budget is spent.
        }
    }

    /** What an aborted HTTP exchange does: it waits until its cancellation fires, then fails. */
    private static void hangUntilCancelled(ExpressQueryCancellation cancellation, AtomicInteger aborted) {
        try {
            while (true) {
                cancellation.throwIfCancelled();
                Thread.sleep(5L);
            }
        } catch (InterruptedException cancelled) {
            aborted.incrementAndGet();
            // Not an InterruptedException: the coordinator's failure path runs and must record nothing.
            throw new IllegalStateException("stream reset");
        }
    }

    private static boolean await(AtomicInteger counter, int expected) throws InterruptedException {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (System.nanoTime() - until < 0L) {
            if (counter.get() >= expected) return true;
            Thread.sleep(5L);
        }
        return counter.get() >= expected;
    }

    private static ExpressGatewayTransport gateway(Runnable onPost) {
        return new ExpressGatewayTransport() {
            @Override public boolean configured() {
                return true;
            }

            @Override public HttpClient.Response post(String path, JSONObject payload) {
                onPost.run();
                return response(new JSONObject());
            }
        };
    }

    private static HttpClient.Response response(Object body) {
        return new HttpClient.Response(200, String.valueOf(body).getBytes(StandardCharsets.UTF_8));
    }
}
