package me.pipi.deliveries.background;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

import me.pipi.deliveries.model.CarrierNormalization;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/**
 * 用户 2026-09-27 第二轮清单：截断排后。The marks a sync round leaves for the waybills its recognition budget
 * truncated: kept across a process restart next to the recognition records, keyed the same way (no waybill
 * in the clear), and cleared by a recognised or terminal answer only.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public final class CarrierRecognitionDeferralsTest {
    private static final CarrierNormalization YTO =
            new CarrierNormalization("YTO", "圆通速递", "yuantong", true, "budget");
    private final AtomicLong now = new AtomicLong(1_000L);
    private SharedPreferences preferences;

    @Before public void setUp() {
        Context context = RuntimeEnvironment.getApplication();
        preferences = context.getSharedPreferences(CarrierRecognitionDeferrals.PREFS, 0);
        preferences.edit().clear().commit();
    }

    @Test public void aMarkOutlivesTheProcessAndNamesNoWaybill() {
        deferrals().defer("yt-7700 189301", true);
        CarrierRecognitionDeferrals restarted = deferrals();
        assertEquals(CarrierRecognitionDeferrals.CUT, restarted.mark("YT7700189301"));
        for (Map.Entry<String, ?> stored : preferences.getAll().entrySet()) {
            assertTrue(stored.getKey(), stored.getKey().matches("[0-9a-f]{64}"));
            assertFalse(String.valueOf(stored.getValue()).contains("7700189301"));
        }
    }

    @Test public void theRoundsOwnReasonReplacesAnEarlierOne() {
        CarrierRecognitionDeferrals deferrals = deferrals();
        deferrals.defer("YT7700189302", true);
        deferrals.defer("YT7700189302", false);
        assertEquals(CarrierRecognitionDeferrals.SKIPPED, deferrals.mark("YT7700189302"));
        deferrals.defer("YT7700189302", true);
        assertEquals(CarrierRecognitionDeferrals.CUT, deferrals.mark("YT7700189302"));
    }

    @Test public void untruncatedFirstThenLeftUnaskedThenCutEachInListOrder() {
        CarrierRecognitionDeferrals deferrals = deferrals();
        deferrals.defer("YT7700189311", true);
        deferrals.defer("YT7700189312", false);
        deferrals.defer("YT7700189314", true);
        deferrals.defer("YT7700189315", false);
        List<String> ordered = deferrals.recognitionLast(List.of("YT7700189311", "YT7700189312",
                "YT7700189313", "", "YT7700189314", "YT7700189315"), waybill -> waybill);
        assertEquals(List.of("YT7700189313", "", "YT7700189312", "YT7700189315",
                "YT7700189311", "YT7700189314"), ordered);
    }

    @Test public void onlyARecognisedOrTerminalAnswerClearsTheMark() throws Exception {
        CarrierRecognitionDeferrals deferrals = deferrals();
        CarrierNormalization[] answer = {CarrierNormalization.NONE};
        AccountCarrierRecognition.Recognizer tracked = deferrals.tracking(waybill -> {
            if (answer[0] == null) throw new IllegalStateException("network failure");
            return answer[0];
        });
        deferrals.defer("YT7700189321", true);
        tracked.recognize("YT7700189321");
        assertEquals("no answer yet (cooling or pending)", CarrierRecognitionDeferrals.CUT,
                deferrals.mark("YT7700189321"));
        answer[0] = null;
        try {
            tracked.recognize("YT7700189321");
            fail();
        } catch (IllegalStateException expected) {
            // A failure is the coordinator's to count; it does not clear the mark.
        }
        assertEquals(CarrierRecognitionDeferrals.CUT, deferrals.mark("YT7700189321"));
        answer[0] = YTO;
        tracked.recognize("YT7700189321");
        assertEquals(CarrierRecognitionDeferrals.NONE, deferrals.mark("YT7700189321"));

        deferrals.defer("YT7700189322", false);
        answer[0] = CarrierNormalization.exhausted();
        tracked.recognize("YT7700189322");
        assertEquals(CarrierRecognitionDeferrals.NONE, deferrals.mark("YT7700189322"));
    }

    @Test public void aBudgetThatRunsOutMarksTheWaybill() throws Exception {
        CarrierRecognitionDeferrals deferrals = deferrals();
        AccountCarrierRecognition.Budget budget = new AccountCarrierRecognition.Budget(150L);
        AccountCarrierRecognition.Recognizer tracked = deferrals.tracking(
                AccountCarrierRecognition.bounded(budget, waybill -> {
                    Thread.sleep(5_000L);
                    return YTO;
                }));
        try {
            tracked.recognize("YT7700189331");
            fail("cut at the budget");
        } catch (AccountCarrierRecognition.BudgetSpentException expected) {
            assertTrue(expected.cut);
        }
        try {
            tracked.recognize("YT7700189332");
            fail("nothing is asked once the budget is spent");
        } catch (AccountCarrierRecognition.BudgetSpentException expected) {
            assertFalse(expected.cut);
        }
        assertEquals(CarrierRecognitionDeferrals.CUT, deferrals.mark("YT7700189331"));
        assertEquals(CarrierRecognitionDeferrals.SKIPPED, deferrals.mark("YT7700189332"));
    }

    /**
     * 用户 2026-09-27 提交前核对答复四：a sync round's request that timed out on its own is marked cut off, like one
     * the budget cut; it is no answer, and the budget is not spent by it.
     */
    @Test public void aRequestThatTimedOutOnItsOwnIsMarkedCut() throws Exception {
        CarrierRecognitionDeferrals deferrals = deferrals();
        AccountCarrierRecognition.Budget budget = new AccountCarrierRecognition.Budget(5_000L);
        int[] asked = {0};
        AccountCarrierRecognition.Recognizer tracked = deferrals.tracking(
                AccountCarrierRecognition.bounded(budget, waybill -> {
                    asked[0]++;
                    throw new me.pipi.deliveries.network.CarrierRecognitionTimeoutException();
                }));
        for (String waybill : new String[]{"YT7700189341", "YT7700189342"}) {
            try {
                tracked.recognize(waybill);
                fail("the timeout is reported");
            } catch (me.pipi.deliveries.network.CarrierRecognitionTimeoutException expected) {
                // No answer this round; nothing recorded.
            }
            assertEquals(CarrierRecognitionDeferrals.CUT, deferrals.mark(waybill));
        }
        assertEquals("the round's budget still asks the next waybill", 2, asked[0]);
        assertFalse(budget.spent());
    }

    @Test public void theOldestMarksGiveWayPastTheCap() {
        CarrierRecognitionDeferrals deferrals = deferrals();
        for (int index = 0; index <= CarrierRecognitionDeferrals.MAX_ENTRIES; index++) {
            now.incrementAndGet();
            deferrals.defer(String.format("YT%010d", index), false);
        }
        assertEquals(CarrierRecognitionDeferrals.MAX_ENTRIES, preferences.getAll().size());
        assertEquals(CarrierRecognitionDeferrals.NONE, deferrals.mark(String.format("YT%010d", 0)));
        assertEquals(CarrierRecognitionDeferrals.SKIPPED, deferrals.mark(
                String.format("YT%010d", CarrierRecognitionDeferrals.MAX_ENTRIES)));
    }

    private CarrierRecognitionDeferrals deferrals() {
        return new CarrierRecognitionDeferrals(preferences, now::get);
    }
}
