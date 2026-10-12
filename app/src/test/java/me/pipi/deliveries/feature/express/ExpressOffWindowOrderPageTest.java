package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.ViewGroup;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import me.pipi.deliveries.data.ManualRoutePolicy;
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
import org.robolectric.util.ReflectionHelpers.ClassParameter;

/**
 * 后台京东订单投影的京粉页（用户定 2026-09-24）：没有 Activity 时用应用 Context 建、离屏按屏幕尺寸排版、
 * 轮询挂主线程 Looper，收尾照旧销毁；其它网页没有 Activity 一律不开；有 Activity 时与原来一样。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class)
public final class ExpressOffWindowOrderPageTest {
    private static final String ROUTE = "https://jingfen.jd.com/item?fixture=offwindow";
    private static final String CARRIER_WAYBILL = "JD0000000901";
    private final List<ExpressAutomaticTimelineCapture.Result> results = new ArrayList<>();

    @Test public void theOrderPageIsLaidOutAtDisplaySizeWithoutAWindowAndPolledFromTheMainLooper()
            throws Exception {
        Application application = RuntimeEnvironment.getApplication();
        ExpressAutomaticTimelineCapture capture = ExpressAutomaticTimelineCapture.offWindow(
                application, order(), ROUTE, new ExpressQueryCancellation(60_000L), results::add);

        capture.start();

        WebView view = ReflectionHelpers.getField(capture, "view");
        assertNotNull(view);
        assertSame("the application context, never an Activity", application, view.getContext());
        assertNull(view.getParent());
        assertFalse(view.isAttachedToWindow());
        DisplayMetrics display = application.getResources().getDisplayMetrics();
        assertTrue(display.widthPixels > 0 && display.heightPixels > 0);
        // Measured at display size. (Robolectric's WebView has no provider, so its setFrame from
        // layout() is a no-op and getWidth() stays 0; the measured size is the observable part.)
        assertEquals(display.widthPixels, view.getMeasuredWidth());
        assertEquals(display.heightPixels, view.getMeasuredHeight());
        ShadowWebView page = Shadows.shadowOf(view);
        assertEquals(ROUTE, page.getLastLoadedUrl());
        assertTrue(page.wasOnResumeCalled());
        assertNull(page.getLastEvaluatedJavascript());

        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(250L));

        assertEquals("a View outside any window never runs its own posts; the main looper does",
                ExpressJingDongTimelineParser.readScript(), page.getLastEvaluatedJavascript());
        page.getLastEvaluatedJavascriptCallback().onReceiveValue(JSONObject.quote(completePackage()));
        assertEquals(1, results.size());
        assertNotNull(results.get(0).timeline);
        assertEquals(CARRIER_WAYBILL, results.get(0).timeline.waybill);
        assertTrue(results.get(0).complete);
        assertTrue("the page is destroyed", page.wasDestroyCalled());
        assertNull(ReflectionHelpers.getField(capture, "view"));
        assertEquals("the poll and the timeout leave the main looper with the page",
                Duration.ZERO, Shadows.shadowOf(Looper.getMainLooper()).getNextScheduledTaskTime());
    }

    @Test public void anUnansweredOrderPageTimesOutAndIsDestroyed() {
        ExpressAutomaticTimelineCapture capture = ExpressAutomaticTimelineCapture.offWindow(
                RuntimeEnvironment.getApplication(), order(), ROUTE,
                new ExpressQueryCancellation(60_000L), results::add);
        capture.start();
        ShadowWebView page = Shadows.shadowOf((WebView) ReflectionHelpers.getField(capture, "view"));

        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(20L));

        assertEquals(1, results.size());
        assertNull(results.get(0));
        assertTrue(page.wasDestroyCalled());
    }

    @Test public void aRiskControlAnswerIsStillReportedWithoutAnActivity() {
        ExpressAutomaticTimelineCapture capture = ExpressAutomaticTimelineCapture.offWindow(
                RuntimeEnvironment.getApplication(), order(), ROUTE,
                new ExpressQueryCancellation(60_000L), results::add);
        capture.start();
        WebView view = ReflectionHelpers.getField(capture, "view");
        WebResourceResponse response = new WebResourceResponse("text/html", "UTF-8", null);
        response.setStatusCodeAndReasonPhrase(403, "Forbidden");

        Shadows.shadowOf(view).getWebViewClient().onReceivedHttpError(view, null, response);

        assertEquals(1, results.size());
        assertTrue("the caller records the 60-minute rest from this flag", results.get(0).throttled);
        assertTrue(Shadows.shadowOf(view).wasDestroyCalled());
    }

    @Test public void withoutAnActivityNoOtherPageEverOpens() {
        Application application = RuntimeEnvironment.getApplication();
        ExpressItem sf = shipment("SF1400000000901", "SF");
        ExpressItem jt = shipment("JTTEST1", "JTSD");
        Object[][] pages = {
                {TimelineSlot.K100_H5, sf, ManualRoutePolicy.kuaidi100QueryUrl(sf.displayWaybill())},
                {TimelineSlot.JT_H5, jt, ManualRoutePolicy.primaryH5Url(jt.displayWaybill(), "JTSD")},
                {TimelineSlot.CN_H5, sf, "https://page.cainiao.com/guoguo/app-myexpress-taobao/"
                        + "express-detail.html?mailNo=SF1400000000901"},
        };
        for (Object[] other : pages) {
            List<ExpressAutomaticTimelineCapture.Result> delivered = new ArrayList<>();
            ExpressAutomaticTimelineCapture.Callback callback = delivered::add;
            // Even the private off-window constructor refuses every page but the JD order page.
            ExpressAutomaticTimelineCapture capture = ReflectionHelpers.callConstructor(
                    ExpressAutomaticTimelineCapture.class,
                    ClassParameter.from(Activity.class, null),
                    ClassParameter.from(Context.class, application),
                    ClassParameter.from(ExpressItem.class, other[1]),
                    ClassParameter.from(String.class, other[2]),
                    ClassParameter.from(String.class, other[0]),
                    ClassParameter.from(ExpressQueryCancellation.class,
                            new ExpressQueryCancellation(60_000L)),
                    ClassParameter.from(ExpressAutomaticTimelineCapture.Callback.class, callback));

            capture.start();

            assertNull(other[0] + " opened without an Activity",
                    ReflectionHelpers.getField(capture, "view"));
            assertEquals(1, delivered.size());
            assertNull(delivered.get(0));
        }
        ExpressAutomaticTimelineCapture hostless = new ExpressAutomaticTimelineCapture(null, order(),
                ROUTE, TimelineSlot.JD_H5, new ExpressQueryCancellation(60_000L), results::add);
        hostless.start();
        assertNull("only the off-window factory may open a page without an Activity",
                ReflectionHelpers.getField(hostless, "view"));
    }

    @Test public void aHostedPageStillJoinsTheActivityContentAndPostsOnItsOwnView() {
        Activity host = Robolectric.buildActivity(Activity.class).setup().get();
        ExpressAutomaticTimelineCapture capture = new ExpressAutomaticTimelineCapture(host, order(),
                ROUTE, TimelineSlot.JD_H5, new ExpressQueryCancellation(60_000L), results::add);

        capture.start();

        WebView view = ReflectionHelpers.getField(capture, "view");
        ViewGroup content = host.findViewById(android.R.id.content);
        assertSame(content, view.getParent());
        assertSame(view, content.getChildAt(0));
        assertSame(host, view.getContext());
        assertTrue(view.isAttachedToWindow());
        assertNull(ReflectionHelpers.getField(capture, "offWindowContext"));
        assertNull("a hosted page keeps posting on its own view",
                ReflectionHelpers.getField(capture, "offWindowHandler"));
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(250L));
        assertEquals(ExpressJingDongTimelineParser.readScript(),
                Shadows.shadowOf(view).getLastEvaluatedJavascript());

        capture.cancel();

        assertNull(view.getParent());
        assertTrue(Shadows.shadowOf(view).wasDestroyCalled());
        assertEquals(1, results.size());
        assertNull(results.get(0));
        host.finish();
    }

    private static ExpressItem order() {
        return new ExpressItem(1L, "", "3630448013820901", "JD", "京东购物",
                StatusSemantic.TRANSIT, "运输中", "订单正在配送", "2026-09-24 08:00:00",
                "[]", "", "I5-JD", "", 1L, 2L, "I5-JD", "", "v5", ROUTE, true,
                "", "", "[]", "JingDong");
    }

    private static ExpressItem shipment(String waybill, String courier) {
        return new ExpressItem(2L, "", waybill, courier, "Synthetic carrier",
                StatusSemantic.TRANSIT, "运输中", "Synthetic event", "2026-09-24 08:00:00",
                "[]", "", "KD-100", "");
    }

    private static String completePackage() throws Exception {
        JSONArray tracks = new JSONArray();
        for (int index = 0; index < 2; index++) {
            tracks.put(new JSONObject().put("operateTime", "2026-09-24 1" + index + ":00:00")
                    .put("operateMessage", "运输节点 " + index).put("waybillCode", CARRIER_WAYBILL));
        }
        JSONObject info = new JSONObject().put("waybillCode", CARRIER_WAYBILL)
                .put("companyName", "京东快递").put("traceList", tracks);
        JSONObject envelope = new JSONObject().put("wholePayload", new JSONObject().put("data",
                        new JSONObject().put("floors", new JSONArray().put(new JSONObject()
                                .put("element", new JSONObject().put("info", info))))).toString())
                .put("source", "network").put("fullProgressRequestedAtStart", false);
        return new JSONObject().put("q", new JSONArray().put(envelope.toString())).toString();
    }
}
