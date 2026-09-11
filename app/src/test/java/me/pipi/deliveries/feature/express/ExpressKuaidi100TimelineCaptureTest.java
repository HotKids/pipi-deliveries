package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.app.Activity;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import java.util.List;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.data.ManualRoutePolicy;
import me.pipi.deliveries.network.ExpressLog;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.Implementation;
import org.robolectric.shadows.ShadowLog;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public class ExpressKuaidi100TimelineCaptureTest {
    @Before public void clearLogs() { ShadowLog.clear(); }

    @Test public void jtBranchUsesCanonicalIdentityAndKeepsK100Unchanged() {
        for (String code : new String[]{"JTSD", "JT", "J&T", "JTEXPRESS", "JITU"}) {
            assertEquals(TimelineSlot.JT_H5, ManualRoutePolicy.primaryH5Provider(code));
            assertEquals("https://jtsd.jtexpress.com.cn/pipi#/pages/checkGoods/sendDetail?waybillNo=JTTEST1&isFrom=serach",
                    ManualRoutePolicy.primaryH5Url(" jt-test-1 ", code));
        }
        for (String code : new String[]{"HTKY", "SF", "JD", ""}) {
            assertEquals(TimelineSlot.K100_H5, ManualRoutePolicy.primaryH5Provider(code));
            assertEquals(ManualRoutePolicy.kuaidi100QueryUrl("JTTEST1"),
                    ManualRoutePolicy.primaryH5Url("JTTEST1", code));
        }
        assertEquals("", ManualRoutePolicy.safePrimaryH5Url(
                ManualRoutePolicy.primaryH5Url("JTOTHER", "JTSD"), "JTTEST1"));
    }

    @Test public void phoneCandidatesUseExplicitSuffixOtherwiseBoundSuffixesOnly() {
        assertEquals(java.util.Arrays.asList("1234"), ExpressKuaidi100TimelineCapture.phoneCandidates(
                "1234", java.util.Arrays.asList("binding-5678", "binding-9012")));
        assertEquals(java.util.Arrays.asList("5678", "9012"), ExpressKuaidi100TimelineCapture.phoneCandidates(
                "", java.util.Arrays.asList("binding-5678", "other-5678", "binding-9012", "invalid")));
        assertTrue(ExpressKuaidi100TimelineCapture.phoneCandidates("", java.util.Collections.emptyList()).isEmpty());
    }

    @Test public void jtCaptureKeepsTextStatusOutOfStructuredStatusAndUsesOwnSlot() {
        ExpressQueryResult captured = ExpressDetailActivity.kuaidi100CapturedResult(
                "JTTEST1", "JTSD", "Synthetic carrier", "", ExpressKuaidi100TimelineCapture.normalizedTracks(
                        "{\"tracks\":[{\"time\":\"2026-09-10 10:00\",\"context\":\"已揽件 Synthetic parcel collected\"}]}"));
        assertEquals(TimelineSlot.JT_H5, captured.timelineProvider);
        assertEquals(StatusSemantic.UNKNOWN, captured.semantic);
        assertEquals(0L, captured.statusEventTime);
        assertEquals("2026-09-10 10:00:00", captured.latestTime);
        assertTrue(ExpressDetailActivity.timelineComplete(captured));
        assertTrue(ExpressKuaidi100TimelineCapture.phoneRequired("{\"tracks\":[],\"outcome\":\"phone_required\"}"));
        assertFalse(ExpressKuaidi100TimelineCapture.phoneRequired("{\"tracks\":[],\"outcome\":\"provider_error\"}"));
        assertFalse(ExpressKuaidi100TimelineCapture.phoneRequired("null"));
    }

    @Test public void jtCorrectedPhoneMayRetryWithoutChangingK100Cooldown() {
        Application context = org.robolectric.RuntimeEnvironment.getApplication();
        long now = 2_000_000L;
        List<String> first = java.util.Arrays.asList("1234");
        List<String> corrected = java.util.Arrays.asList("5678");
        ExpressKuaidi100CaptureCooldown.record(context, TimelineSlot.JT_H5, "JTTEST1", first, now);
        assertFalse(ExpressKuaidi100CaptureCooldown.due(context, TimelineSlot.JT_H5, "JTTEST1", first, now + 1));
        assertTrue(ExpressKuaidi100CaptureCooldown.due(context, TimelineSlot.JT_H5, "JTTEST1", corrected, now + 1));
        assertTrue(ExpressKuaidi100CaptureCooldown.due(context, TimelineSlot.K100_H5, "JTTEST1", first, now + 1));
        ExpressKuaidi100CaptureCooldown.record(context, TimelineSlot.K100_H5, "JTTEST1", first, now);
        assertFalse(ExpressKuaidi100CaptureCooldown.due(context, TimelineSlot.K100_H5, "JTTEST1", corrected, now + 1));
        for (String key : context.getSharedPreferences("express_k100_capture_cooldown", 0).getAll().keySet()) {
            assertFalse(key.contains("1234"));
            assertFalse(key.contains("5678"));
        }
    }

    @Test public void sameParcelSavedSuffixReachesBothActualLoaderEvaluations() throws Exception {
        Activity host = Robolectric.buildActivity(Activity.class).setup().get();
        ExpressItem owner = new ExpressItem(1L, "synthetic-owner-1234", "SFTEST4271", "SF", "SF",
                StatusSemantic.TRANSIT, "运输中", "Synthetic event", "2026-09-09 18:51:23",
                "[]", "", "INTERFACE5", "");
        ExpressAutomaticTimelineCapture automatic = new ExpressAutomaticTimelineCapture(host, owner,
                "https://m.kuaidi100.com/app/query/?nu=SFTEST4271", TimelineSlot.K100_H5,
                new ExpressQueryCancellation(10000L), result -> { });
        automatic.start();
        String actual = evaluatedScript(automatic, "view");
        assertTrue(actual.contains(ExpressKuaidi100TimelineCapture.verificationScript(owner.displayWaybill(), owner.phone)));
        assertFalse(actual.contains(owner.phone));
        automatic.cancel();
        ExpressKuaidi100TimelineCapture standalone = new ExpressKuaidi100TimelineCapture(host,
                "https://m.kuaidi100.com/app/query/?nu=SFTEST4272", "SFTEST4272", "5678", null);
        assertTrue(standalone.start());
        String manual = evaluatedScript(standalone, "webView");
        assertTrue(manual.contains(ExpressKuaidi100TimelineCapture.verificationScript("SFTEST4272", "5678")));
        standalone.cancel();
        for (String log : captureLogs()) {
            assertFalse(log.contains("1234"));
            assertFalse(log.contains("5678"));
            assertFalse(log.contains("SFTEST"));
        }
    }

    @Test public void invalidSavedSuffixNeverEntersTheVerificationScript() {
        for (String phone : new String[]{"", "123", "12a4", "****"}) {
            assertEquals("", ExpressKuaidi100TimelineCapture.verificationScript("SFTEST4271", phone));
        }
        assertEquals("", ExpressKuaidi100TimelineCapture.verificationScript("", "1234"));
        assertFalse(ExpressKuaidi100TimelineCapture.verificationScript(" sf-test-4271 ", "owner-1234")
                .contains("owner-1234"));
    }

    @Test public void verificationAttemptIsMonotonicAndBooleanOnly() {
        ExpressKuaidi100TimelineCapture.Diagnostics diagnostics = new ExpressKuaidi100TimelineCapture.Diagnostics();
        diagnostics.accept("{\"tracks\":[],\"diagnostics\":{\"phoneVerificationAttempted\":true}}");
        diagnostics.accept("{\"tracks\":[],\"diagnostics\":{\"phoneVerificationAttempted\":false}}");
        diagnostics.finish("timeout");
        assertTrue(captureLogs().get(0).contains("phoneVerificationAttempted=true"));
    }

    @Implements(value = ExpressKuaidi100TimelineCapture.class, isInAndroidSdk = false)
    public static class CaptureArguments {
        static String waybill;
        static String phone;
        static boolean starts;
        @Implementation protected void __constructor__(Activity host, String route, String number,
                String savedPhone, ExpressKuaidi100TimelineCapture.Callback callback) {
            waybill = number;
            phone = savedPhone;
        }
        @Implementation protected boolean start() { return starts; }
        @Implementation protected void cancel() { }
    }

    @Test @Config(shadows = CaptureArguments.class)
    public void bothDetailCallersPassOnlyTheirExistingParcelPhone() throws Exception {
        ExpressDetailActivity activity = Robolectric.buildActivity(ExpressDetailActivity.class).get();
        CaptureArguments.starts = false;
        java.lang.reflect.Method add = ExpressDetailActivity.class.getDeclaredMethod(
                "captureKuaidi100ForAddChain", String.class, String.class, ExpressQueryResult.class,
                String.class, ExpressQueryCancellation.class);
        add.setAccessible(true);
        add.invoke(activity, "SFTEST4281", "https://m.kuaidi100.com/app/query/?nu=SFTEST4281",
                new ExpressQueryResult("SFTEST4281", "SF", "SF", StatusSemantic.TRANSIT, "", "", "[]"),
                "2468", new ExpressQueryCancellation(10000L));
        assertEquals("SFTEST4281", CaptureArguments.waybill);
        assertEquals("2468", CaptureArguments.phone);

        ExpressItem owner = new ExpressItem(1L, "saved-owner-1357", "SFTEST4282", "SF", "SF",
                StatusSemantic.TRANSIT, "运输中", "Synthetic", "2026-09-09 18:51:23",
                "[]", "", "KD-100", "", 1L, 2L, "KD-100", "", "", "", true,
                "", "", "[]", "", true, "", 0L);
        java.lang.reflect.Field item = ExpressDetailActivity.class.getDeclaredField("item");
        item.setAccessible(true);
        item.set(activity, owner);
        Class<?> stateClass = Class.forName(ExpressDetailActivity.class.getName() + "$DetailState");
        java.lang.reflect.Constructor<?> stateConstructor = stateClass.getDeclaredConstructor(
                me.pipi.deliveries.data.ExpressRepository.class, ExpressItem.class, String.class);
        stateConstructor.setAccessible(true);
        java.lang.reflect.Field state = ExpressDetailActivity.class.getDeclaredField("detailState");
        state.setAccessible(true);
        state.set(activity, stateConstructor.newInstance(
                me.pipi.deliveries.data.ExpressRepository.get(activity), owner, "interface5"));
        CaptureArguments.starts = true;
        java.lang.reflect.Method detail = ExpressDetailActivity.class.getDeclaredMethod(
                "ensureKuaidi100Presentation", ExpressQueryResult.class, String.class);
        detail.setAccessible(true);
        detail.invoke(activity, null, "synthetic");
        assertEquals(owner.displayWaybill(), CaptureArguments.waybill);
        assertEquals(owner.phone, CaptureArguments.phone);
    }

    private static String evaluatedScript(Object capture, String webField) throws Exception {
        java.lang.reflect.Method poll = capture.getClass().getDeclaredMethod("poll");
        poll.setAccessible(true);
        poll.invoke(capture);
        java.lang.reflect.Field field = capture.getClass().getDeclaredField(webField);
        field.setAccessible(true);
        return Shadows.shadowOf((WebView) field.get(capture)).getLastEvaluatedJavascript();
    }

    @Test public void diagnosticsUseOnlyTypedMetadataAndNormalizedTrackCount() throws Exception {
        ExpressKuaidi100TimelineCapture.Diagnostics diagnostics =
                new ExpressKuaidi100TimelineCapture.Diagnostics();
        diagnostics.evaluations = 3;
        diagnostics.accept("null");
        diagnostics.accept("not-json");
        String page = "{\"tracks\":[{\"time\":\"2026-09-09 18:51:23\",\"context\":\"Synthetic event\"},"
                + "{\"time\":\"invalid\",\"context\":\"Synthetic invalid event\"}],"
                + "\"diagnostics\":{\"mainPresent\":true,\"readyState\":\"complete\","
                + "\"checkCodeVisible\":false,\"value\":\"withheld-code\",\"phone\":\"withheld-phone\"}}";
        diagnostics.accept(JSONObject.quote(page));
        diagnostics.finish("timeout");
        diagnostics.finish("cancelled");
        assertEquals(1, captureLogs().size());
        String log = captureLogs().get(0);
        assertTrue(log.contains("evaluations=3 evaluationFailures=2"));
        assertTrue(log.contains("mainPresent=true readyState=complete checkCodeVisible=false validTracks=1"));
        assertFalse(log.contains("withheld"));
        assertFalse(log.contains("Synthetic"));
    }

    @Test public void missingAndMistypedMetadataStayUnknown() {
        ExpressKuaidi100TimelineCapture.Diagnostics diagnostics =
                new ExpressKuaidi100TimelineCapture.Diagnostics();
        diagnostics.accept("{\"tracks\":[],\"diagnostics\":{\"mainPresent\":\"false\","
                + "\"readyState\":\"withheld-state\",\"checkCodeVisible\":0}}");
        diagnostics.finish("timeout");
        String log = captureLogs().get(0);
        assertTrue(log.contains("mainPresent=unknown readyState=unknown checkCodeVisible=unknown validTracks=0"));
        assertFalse(log.contains("withheld"));
    }

    @Test public void bothK100LoadersLogCancellationOnceBeforeAnyEvaluation() {
        ExpressKuaidi100TimelineCapture standalone = new ExpressKuaidi100TimelineCapture(null, "", "", "", null);
        standalone.cancel();
        standalone.cancel();
        ExpressAutomaticTimelineCapture automatic = automatic(TimelineSlot.K100_H5, null);
        automatic.cancel();
        automatic.cancel();
        assertEquals(2, captureLogs().size());
        for (String log : captureLogs()) {
            assertTrue(log.contains("reason=cancelled evaluations=0 evaluationFailures=0"));
            assertTrue(log.contains("mainPresent=unknown readyState=unknown checkCodeVisible=unknown"));
        }
        automatic(TimelineSlot.CN_H5, null).cancel();
        automatic(TimelineSlot.JD_H5, null).cancel();
        assertEquals(2, captureLogs().size());
    }

    @Test public void actualK100AutomaticMainFrameHttpErrorKeepsItsNumericCode() throws Exception {
        Activity host = Robolectric.buildActivity(Activity.class).setup().get();
        ExpressAutomaticTimelineCapture capture = automatic(TimelineSlot.K100_H5, host);
        capture.start();
        java.lang.reflect.Field field = ExpressAutomaticTimelineCapture.class.getDeclaredField("view");
        field.setAccessible(true);
        WebView view = (WebView) field.get(capture);
        WebResourceResponse response = new WebResourceResponse("text/html", "UTF-8", null);
        response.setStatusCodeAndReasonPhrase(403, "Synthetic error");
        Shadows.shadowOf(view).getWebViewClient().onReceivedHttpError(view, null, response);
        capture.cancel();
        assertEquals(1, captureLogs().size());
        assertTrue(captureLogs().get(0).contains("reason=main_frame_http_error"));
        assertTrue(captureLogs().get(0).contains("httpStatus=403"));
        assertFalse(captureLogs().get(0).contains("Synthetic"));
    }

    private static ExpressAutomaticTimelineCapture automatic(String provider, Activity host) {
        return new ExpressAutomaticTimelineCapture(host, null,
                "https://m.kuaidi100.com/app/query/?nu=SYNTHETIC4271", provider,
                new ExpressQueryCancellation(10000L), result -> { });
    }

    private static List<String> captureLogs() {
        return ShadowLog.getLogsForTag(ExpressLog.TAG).stream().map(entry -> entry.msg)
                .filter(message -> message.contains("event=capture_finished"))
                .collect(java.util.stream.Collectors.toList());
    }

    @Test
    public void normalizedTracksKeepsOnlyTimedRealNodes() throws Exception {
        String payload = "\"{\\\"tracks\\\":[{\\\"time\\\":\\\"2026-09-05 12:47:18\\\",\\\"context\\\":\\\"收件人详细地址待确认\\\"},"
                + "{\\\"time\\\":\\\"function (v) { return v }\\\",\\\"context\\\":\\\"假节点\\\"},"
                + "{\\\"time\\\":\\\"2026-09-04 09:00:00\\\",\\\"context\\\":\\\"快件已揽收\\\"}]}\"";

        String normalized = ExpressKuaidi100TimelineCapture.normalizedTracks(payload);

        JSONArray tracks = new JSONArray(normalized);
        assertEquals(2, tracks.length());
        assertEquals("2026-09-05 12:47:18", tracks.getJSONObject(0).getString("time"));
        assertEquals("快件已揽收", tracks.getJSONObject(1).getString("context"));
    }

    @Test
    public void nothingUsableIsAnEmptyResult() {
        assertEquals("", ExpressKuaidi100TimelineCapture.normalizedTracks(""));
        assertEquals("", ExpressKuaidi100TimelineCapture.normalizedTracks("null"));
        assertEquals("", ExpressKuaidi100TimelineCapture.normalizedTracks("\"{\\\"tracks\\\":[]}\""));
    }

    @Test
    public void extractionScriptStaysOnKuaidi100AndIgnoresFunctions() {
        String script = ExpressKuaidi100TimelineCapture.extractionScript();
        assertTrue(script.contains("kuaidi100.com"));
        assertTrue(script.contains("typeof v==='string'||typeof v==='number'"));
        assertTrue(script.contains("__INITIAL_STATE__"));
        assertFalse(script.contains("document.cookie"));
        assertEquals(8_000L, ExpressKuaidi100TimelineCapture.CAPTURE_TIMEOUT_MS);
    }
}
