package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Application;
import android.content.Context;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import me.pipi.deliveries.background.AccountCarrierRecognition;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.network.ExpressApi;
import me.pipi.deliveries.network.ExpressQueryCancellation;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

/**
 * 用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒。进详情 / 下拉详情按一次操作一份 30 秒：不属于同步轮的用户操作
 * 每次各一份，用户 2026-09-27 识别 30 秒细则答「这样做」（Lite 详情刷新里的识别从最多 60 秒降到 30 秒）。这一次刷新里
 * 的识别（订单投影前、v5_query 文案、京粉页、行的补识别）共用一份预算，下一次操作重新算。预算用光只结束识别，不结束
 * 这次刷新。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        shadows = ExpressDetailRecognitionBudgetTest.Api.class)
public final class ExpressDetailRecognitionBudgetTest {
    private static final CarrierNormalization YTO =
            new CarrierNormalization("YTO", "圆通速递", "yuantong", true, "budget");
    private ExpressDetailActivity activity;

    @Before public void setUp() {
        ReflectionHelpers.setStaticField(AccountCarrierRecognition.class, "budgetMillisOverride", 1_500L);
        Api.calls.set(0);
        Api.aborted.set(0);
        activity = Robolectric.buildActivity(ExpressDetailActivity.class).get();
    }

    @After public void tearDown() {
        ReflectionHelpers.setStaticField(AccountCarrierRecognition.class, "budgetMillisOverride", 0L);
        ((ExecutorService) ReflectionHelpers.getField(activity, "worker")).shutdownNow();
    }

    @Test public void oneDetailRefreshDrawsOnOneBudgetAndTheNextOneOnItsOwn() throws Exception {
        try (ExpressQueryCancellation refresh = new ExpressQueryCancellation(60_000L)) {
            assertEquals("YTO", recognizer(refresh).recognize("YT7700189181").standardCode);
            long started = System.nanoTime();
            try {
                recognizer(refresh).recognize("YT7700189182");
                fail("the second recognition of the same refresh waits only for what is left");
            } catch (AccountCarrierRecognition.BudgetSpentException expected) {
                // The refresh goes on; this waybill waits for a later round.
            }
            assertTrue(System.nanoTime() - started < TimeUnit.MILLISECONDS.toNanos(1_000L));
            assertFalse("the refresh itself is not cut", refresh.isCancelled());
            assertFalse(Thread.currentThread().isInterrupted());
            assertTrue("its request is cancelled", awaitAborted());
        }
        try (ExpressQueryCancellation next = new ExpressQueryCancellation(60_000L)) {
            assertEquals("the next operation has a budget of its own",
                    "YTO", recognizer(next).recognize("YT7700189182").standardCode);
        }
        assertEquals(3, Api.calls.get());
    }

    private AccountCarrierRecognition.Recognizer recognizer(ExpressQueryCancellation operation) {
        return ReflectionHelpers.callInstanceMethod(activity, "carrierRecognizer",
                ClassParameter.from(ExpressItem.class, null),
                ClassParameter.from(ExpressQueryCancellation.class, operation));
    }

    private static boolean awaitAborted() throws InterruptedException {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (System.nanoTime() - until < 0L) {
            if (Api.aborted.get() >= 1) return true;
            Thread.sleep(10L);
        }
        return Api.aborted.get() >= 1;
    }

    /** Every request answers 圆通 after one second unless it is cancelled first. */
    @Implements(value = ExpressApi.class, isInAndroidSdk = false)
    public static class Api {
        static final AtomicInteger calls = new AtomicInteger();
        static final AtomicInteger aborted = new AtomicInteger();

        @Implementation protected void __constructor__(Context ignored) {}

        @Implementation protected CarrierNormalization recognizeCarrier(
                String waybill, ExpressQueryCancellation cancellation, boolean excludeJd)
                throws Exception {
            calls.incrementAndGet();
            long until = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(1_000L);
            try {
                while (System.nanoTime() - until < 0L) {
                    if (cancellation != null) cancellation.throwIfCancelled();
                    Thread.sleep(5L);
                }
            } catch (InterruptedException cancelled) {
                aborted.incrementAndGet();
                Thread.currentThread().interrupt();
                throw cancelled;
            }
            return YTO;
        }
    }
}
