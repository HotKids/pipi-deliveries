package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Application;
import android.os.Looper;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowWebView;
import org.robolectric.util.ReflectionHelpers;

/**
 * 用户 2026-09-25 同意（方案 A，三端同一口径，iOS account-sync-policy.ts unionPageOutcome）：京粉页空壳由抓取自己
 * 判定——页面加载完、有真实视口、不是风控，到超时什么带物流的东西都没抓到：没有带节点的包、没有网络节点、没有
 * 运单号。getUnionActivity 回的能不能解析不算数：iPhone 上赠品单 4421 的 union 接口回了 200，只是不带物流；Pixel 上
 * 同一单的超时探针是 packets 0、netTracks 0、waybill false、ready complete、426×952。抓到物流、没加载完、没有视口、
 * 风控都不算空壳；风控也不算抓到物流（既不计数也不清零）。用户 2026-09-26（其余裁决 4）：union 请求发出去了、到超时
 * 还没回，与请求出错一样不算空壳；从没发出过 union 请求的页仍算空壳。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class)
public final class JingDongEmptyShellDetectionTest {
    private static final String ROUTE = "https://jingfen.jd.com/item?fixture=4421";
    private final List<ExpressAutomaticTimelineCapture.Result> results = new ArrayList<>();

    @Test public void aLoadedPageThatNeverSentAUnionRequestIsAnEmptyShell() throws Exception {
        ExpressAutomaticTimelineCapture.Result result = timeOut(offWindow(), state("complete", 426, 952));
        assertNotNull(result);
        assertTrue(result.emptyPage);
        assertFalse(result.logisticsSeen);
        assertNull(result.timeline);
        assertFalse(result.throttled);
    }

    @Test public void aHostedPageIsJudgedTheSameWay() throws Exception {
        Activity host = Robolectric.buildActivity(Activity.class).setup().get();
        try {
            ExpressAutomaticTimelineCapture capture = new ExpressAutomaticTimelineCapture(host, order(),
                    ROUTE, TimelineSlot.JD_H5, new ExpressQueryCancellation(60_000L), results::add);
            ExpressAutomaticTimelineCapture.Result result = timeOut(capture, state("complete", 412, 915));
            assertNotNull(result);
            assertTrue(result.emptyPage);
        } finally {
            host.finish();
        }
    }

    @Test public void aPageThatHasNotFinishedLoadingIsNotAnEmptyShell() throws Exception {
        assertNull(timeOut(offWindow(), state("interactive", 426, 952)));
    }

    @Test public void aPageWithoutAViewportIsNotAnEmptyShell() throws Exception {
        assertNull(timeOut(offWindow(), state("complete", 0, 0)));
    }

    @Test public void aPageThatNeverReportedItsStateIsNotAnEmptyShell() {
        ExpressAutomaticTimelineCapture capture = offWindow();
        capture.start();
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(21L));
        assertEquals(1, results.size());
        assertNull(results.get(0));
    }

    /**
     * A union answer without logistics is still an empty shell: a bare 200 answer, one the parser cannot
     * read, and one that names only the order's own number.
     */
    @Test public void aUnionAnswerWithoutLogisticsIsStillAnEmptyShell() throws Exception {
        for (JSONObject answered : new JSONObject[]{
                withQueued(state("complete", 426, 952), "{\"code\":\"0\",\"data\":{\"floors\":[{\"element\":"
                        + "{\"info\":{\"traceList\":[]}}}]}}"),
                withQueued(state("complete", 426, 952), "<html>system busy</html>"),
                withQueued(state("complete", 426, 952), "{\"data\":{\"orderId\":\"350000004421\","
                        + "\"mailNo\":\"350000004421\",\"traceList\":[{\"operateMessage\":\"已完成\"}]}}"),
                state("complete", 426, 952).put("q", new JSONArray().put("not an envelope"))}) {
            results.clear();
            ExpressAutomaticTimelineCapture.Result result = timeOut(offWindow(), answered);
            assertNotNull(answered.toString(), result);
            assertTrue(answered.toString(), result.emptyPage);
            assertFalse(answered.toString(), result.logisticsSeen);
        }
    }

    /** Anything logistics-bearing: network nodes, the union waybill, a queued packet with tracks or a waybill. */
    @Test public void aCapturedLogisticsSignalIsNeverAnEmptyShell() throws Exception {
        for (JSONObject captured : new JSONObject[]{
                state("complete", 426, 952).put("n", 2),
                state("complete", 426, 952).put("u", true),
                withQueued(state("complete", 426, 952), "{\"data\":{\"traceList\":[{\"operateTime\":"
                        + "\"2026-09-20 10:00:00\",\"operateMessage\":\"您的快件已签收\"}]}}"),
                withQueued(state("complete", 426, 952), "{\"data\":{\"floors\":[{\"element\":{\"info\":"
                        + "{\"waybillCode\":\"YT0000000004421\",\"traceList\":[]}}}]}}")}) {
            results.clear();
            ExpressAutomaticTimelineCapture.Result result = timeOut(offWindow(), captured);
            assertNotNull(captured.toString(), result);
            assertTrue(captured.toString(), result.logisticsSeen);
            assertFalse(captured.toString(), result.emptyPage);
        }
    }

    @Test public void logisticsSeenEarlierStillCountsWhenTheLastPollLooksEmpty() throws Exception {
        ExpressAutomaticTimelineCapture capture = offWindow();
        capture.start();
        WebView view = ReflectionHelpers.getField(capture, "view");
        answerPoll(view, state("complete", 426, 952).put("n", 1));
        answerPoll(view, state("complete", 426, 952));
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(21L));
        assertEquals(1, results.size());
        assertTrue(results.get(0).logisticsSeen);
        assertFalse(results.get(0).emptyPage);
    }

    /** Risk control is neither an empty shell nor logistics: the answer JD sends with it counts neither way. */
    @Test public void riskControlIsNeverAnEmptyShell() throws Exception {
        ExpressAutomaticTimelineCapture polled = offWindow();
        polled.start();
        answerPoll(ReflectionHelpers.getField(polled, "view"), withQueued(
                state("complete", 426, 952).put("k", true), "{\"code\":\"403\",\"msg\":\"刷新几遍还不行\"}"));
        assertEquals(1, results.size());
        assertTrue(results.get(0).throttled);
        assertFalse(results.get(0).emptyPage);
        assertFalse("a risk-control reply is not logistics", results.get(0).logisticsSeen);

        results.clear();
        ExpressAutomaticTimelineCapture blocked = offWindow();
        blocked.start();
        WebView view = ReflectionHelpers.getField(blocked, "view");
        answerPoll(view, state("complete", 426, 952));
        WebResourceResponse response = new WebResourceResponse("text/html", "UTF-8", null);
        response.setStatusCodeAndReasonPhrase(403, "Forbidden");
        Shadows.shadowOf(view).getWebViewClient().onReceivedHttpError(view, null, response);
        assertEquals(1, results.size());
        assertTrue(results.get(0).throttled);
        assertFalse(results.get(0).emptyPage);
        assertFalse(results.get(0).logisticsSeen);
    }

    /**
     * 用户 2026-09-25 补充：union 请求回了非 2xx 或网络失败（探针计进 e），与风控一样既不是空壳也不是物流——京东两次
     * 故障隔 10 分钟不能把真订单记成空壳。抓到的物流照旧算数。
     */
    @Test public void aUnionErrorIsNeitherAnEmptyShellNorLogistics() throws Exception {
        assertNull("a failed union answer on a loaded page",
                timeOut(offWindow(), state("complete", 426, 952).put("e", 1)));
        results.clear();
        assertNull("a failed union answer next to a bare 2xx one", timeOut(offWindow(),
                withQueued(state("complete", 426, 952).put("e", 1), "{\"code\":\"0\"}")));
        results.clear();
        ExpressAutomaticTimelineCapture.Result logistics =
                timeOut(offWindow(), state("complete", 426, 952).put("e", 1).put("n", 1));
        assertNotNull(logistics);
        assertTrue("logistics still count when another union answer failed", logistics.logisticsSeen);
        assertFalse(logistics.emptyPage);
    }

    /**
     * 用户 2026-09-26（其余裁决 4，Lite、iOS 同口径）：union 请求发出去了、到超时还没回（探针的 p，页面自己中止的请求
     * 也一直算着），与请求出错一样既不是空壳也不是物流；同一页上已经抓到的物流照旧算数。
     */
    @Test public void aUnionRequestStillUnansweredAtTheTimeoutIsNeitherAnEmptyShellNorLogistics()
            throws Exception {
        assertNull("a union request sent and never answered",
                timeOut(offWindow(), state("complete", 426, 952).put("p", 1)));
        results.clear();
        assertNull("an unanswered request next to a bare 2xx answer", timeOut(offWindow(),
                withQueued(state("complete", 426, 952).put("p", 1), "{\"code\":\"0\"}")));
        results.clear();
        ExpressAutomaticTimelineCapture.Result logistics =
                timeOut(offWindow(), state("complete", 426, 952).put("p", 1).put("n", 1));
        assertNotNull(logistics);
        assertTrue("logistics still count while another union request is pending", logistics.logisticsSeen);
        assertFalse(logistics.emptyPage);
        results.clear();
        ExpressAutomaticTimelineCapture.Result answered =
                timeOut(offWindow(), state("complete", 426, 952).put("p", 0));
        assertNotNull("every request sent was answered: still an empty shell", answered);
        assertTrue(answered.emptyPage);
    }

    @Test public void aCancelledCaptureIsNeverAnEmptyShell() throws Exception {
        ExpressAutomaticTimelineCapture capture = offWindow();
        capture.start();
        answerPoll(ReflectionHelpers.getField(capture, "view"), state("complete", 426, 952));
        capture.cancel();
        assertEquals(1, results.size());
        assertNull(results.get(0));
    }

    private ExpressAutomaticTimelineCapture offWindow() {
        return ExpressAutomaticTimelineCapture.offWindow(RuntimeEnvironment.getApplication(), order(),
                ROUTE, new ExpressQueryCancellation(60_000L), results::add);
    }

    /** Starts the page, answers one poll with {@code state} and lets the JD page time out. */
    private ExpressAutomaticTimelineCapture.Result timeOut(
            ExpressAutomaticTimelineCapture capture, JSONObject state) throws Exception {
        capture.start();
        answerPoll(ReflectionHelpers.getField(capture, "view"), state);
        assertTrue("one poll does not finish a JD page", results.isEmpty());
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(21L));
        assertEquals(1, results.size());
        return results.get(0);
    }

    private static void answerPoll(WebView view, JSONObject state) {
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(250L));
        ShadowWebView page = Shadows.shadowOf(view);
        assertEquals(ExpressJingDongTimelineParser.readScript(), page.getLastEvaluatedJavascript());
        page.getLastEvaluatedJavascriptCallback().onReceiveValue(JSONObject.quote(state.toString()));
    }

    /** What readScript returns for a page that captured nothing. */
    private static JSONObject state(String readyState, int width, int height) throws Exception {
        return new JSONObject().put("q", new JSONArray()).put("k", false).put("n", 0)
                .put("u", false).put("e", 0).put("p", 0).put("r", readyState).put("w", width)
                .put("h", height);
    }

    /** The same state with one union answer queued the way the probe queues it. */
    private static JSONObject withQueued(JSONObject state, String wholePayload) throws Exception {
        state.getJSONArray("q").put(new JSONObject().put("wholePayload", wholePayload)
                .put("fullProgressRequestedAtStart", false).put("source", "network").toString());
        return state;
    }

    private static ExpressItem order() {
        return new ExpressItem(1L, "", "350000004421", "JDKD", "京东商品快递",
                StatusSemantic.COMPLETED, "已完成", "您的订单350000004421已完成",
                "2026-09-20 10:00:00", "[]", "", "I5-JD", "", 1L, 2L, "I5-JD", "", "v5", ROUTE, true,
                "", "", "[]", "JingDong");
    }
}
