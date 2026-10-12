package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.app.Application;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.Collections;
import java.util.Map;

import me.pipi.deliveries.data.ManualRoutePolicy;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressQueryCancellation;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

/**
 * 用户 2026-10-02 弹窗「Lite 也做，iOS 查文档能做就做（推荐）」（Pipi Kuaidi100H5Client.isAllowedCaptureResource）：the
 * hidden Kuaidi100 capture page loads only Kuaidi100's own files (and data:/blob:); any other sub-resource answers
 * an empty 204 at once. The main frame and the J&T page are untouched. Synthetic waybills only.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public final class Kuaidi100CaptureResourceTest {
    private static final String WAYBILL = "SYNTHETIC4271";

    @Test public void onlyKuaidi100HostsAndInlineUrlsAreAllowed() {
        for (String allowed : new String[]{
                "https://m.kuaidi100.com/app/query/?nu=SYNTHETIC4271",
                "https://kuaidi100.com/favicon.ico",
                "http://www.kuaidi100.com/js/query.js",
                "https://CDN.KUAIDI100.COM/static/app.css",
                "data:image/png;base64,AAAA",
                "blob:https://m.kuaidi100.com/0f1e2d3c"}) {
            assertTrue(allowed, ExpressKuaidi100TimelineCapture.isAllowedCaptureResource(allowed));
        }
        for (String blocked : new String[]{
                "https://a.baidinet.com/hm.js?synthetic",
                "https://hm.baidu.com/hm.js?synthetic",
                "https://kuaidi100.com.example.net/app.js",
                "https://notkuaidi100.com/app.js",
                "ftp://m.kuaidi100.com/file",
                "javascript:void(0)",
                "about:blank",
                "not a url",
                "",
                null}) {
            assertFalse(String.valueOf(blocked), ExpressKuaidi100TimelineCapture.isAllowedCaptureResource(blocked));
        }
    }

    @Test public void aBlockedResourceAnswersAnEmpty204() throws Exception {
        WebResourceResponse response = ExpressKuaidi100TimelineCapture.emptyCaptureResponse();
        assertEquals(204, response.getStatusCode());
        assertEquals("No Content", response.getReasonPhrase());
        assertEquals(-1, response.getData().read());
    }

    @Test public void theAddChainK100PageBlocksThirdPartyFilesButNotTheMainFrame() throws Exception {
        Activity host = Robolectric.buildActivity(Activity.class).setup().get();
        ExpressKuaidi100TimelineCapture capture = new ExpressKuaidi100TimelineCapture(host,
                ManualRoutePolicy.kuaidi100QueryUrl(WAYBILL), WAYBILL, "", (finished, tracks) -> { });
        assertTrue(capture.start());
        WebView view = field(capture, "webView");
        WebViewClient client = Shadows.shadowOf(view).getWebViewClient();
        WebResourceResponse blocked = client.shouldInterceptRequest(view,
                request("https://a.baidinet.com/hm.js?synthetic", false));
        assertNotNull(blocked);
        assertEquals(204, blocked.getStatusCode());
        assertNull(client.shouldInterceptRequest(view, request("https://m.kuaidi100.com/js/query.js", false)));
        assertNull(client.shouldInterceptRequest(view, request("https://a.baidinet.com/main", true)));
        capture.cancel();
    }

    @Test public void theAddChainJtPageIsUnchanged() throws Exception {
        Activity host = Robolectric.buildActivity(Activity.class).setup().get();
        ExpressKuaidi100TimelineCapture capture = new ExpressKuaidi100TimelineCapture(host,
                ManualRoutePolicy.primaryH5Url(WAYBILL, "JTSD"), WAYBILL, "", (finished, tracks) -> { });
        assertTrue(capture.start());
        WebView view = field(capture, "webView");
        assertNull(Shadows.shadowOf(view).getWebViewClient().shouldInterceptRequest(view,
                request("https://a.baidinet.com/hm.js?synthetic", false)));
        capture.cancel();
    }

    @Test public void theDetailPullK100PageBlocksThirdPartyFilesAndJtIsUnchanged() throws Exception {
        Activity host = Robolectric.buildActivity(Activity.class).setup().get();
        ExpressAutomaticTimelineCapture k100 = new ExpressAutomaticTimelineCapture(host, owner(),
                ManualRoutePolicy.kuaidi100QueryUrl(WAYBILL), TimelineSlot.K100_H5,
                new ExpressQueryCancellation(10_000L), result -> { });
        k100.start();
        WebView view = field(k100, "view");
        WebViewClient client = Shadows.shadowOf(view).getWebViewClient();
        WebResourceResponse blocked = client.shouldInterceptRequest(view,
                request("https://hm.baidu.com/hm.js?synthetic", false));
        assertNotNull(blocked);
        assertEquals(204, blocked.getStatusCode());
        assertNull(client.shouldInterceptRequest(view, request("https://m.kuaidi100.com/js/query.js", false)));
        assertNull(client.shouldInterceptRequest(view, request("data:image/png;base64,AAAA", false)));
        k100.cancel();

        ExpressAutomaticTimelineCapture jt = new ExpressAutomaticTimelineCapture(host, owner(),
                ManualRoutePolicy.primaryH5Url(WAYBILL, "JTSD"), TimelineSlot.JT_H5,
                new ExpressQueryCancellation(10_000L), result -> { });
        jt.start();
        WebView jtView = field(jt, "view");
        assertNotNull("the J&T page opened", jtView);
        assertNull(Shadows.shadowOf(jtView).getWebViewClient().shouldInterceptRequest(jtView,
                request("https://hm.baidu.com/hm.js?synthetic", false)));
        jt.cancel();
    }

    private static ExpressItem owner() {
        return new ExpressItem(1L, "13800000099", WAYBILL, "JTSD", "极兔速递",
                StatusSemantic.TRANSIT, "运输中", "Synthetic", "2026-10-02 10:00:00",
                "[]", "", "KD-100", "", 1L, 2L, "KD-100", "", "", "", true,
                "", "", "[]", "", true, "", 0L);
    }

    @SuppressWarnings("unchecked")
    private static <T> T field(Object target, String name) throws Exception {
        java.lang.reflect.Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return (T) field.get(target);
    }

    private static WebResourceRequest request(String url, boolean mainFrame) {
        Uri uri = Uri.parse(url);
        return new WebResourceRequest() {
            @Override public Uri getUrl() { return uri; }
            @Override public boolean isForMainFrame() { return mainFrame; }
            @Override public boolean isRedirect() { return false; }
            @Override public boolean hasGesture() { return false; }
            @Override public String getMethod() { return "GET"; }
            @Override public Map<String, String> getRequestHeaders() { return Collections.emptyMap(); }
        };
    }
}
