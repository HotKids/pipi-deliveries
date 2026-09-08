package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Application;

import org.json.JSONArray;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public class ExpressKuaidi100TimelineCaptureTest {
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
