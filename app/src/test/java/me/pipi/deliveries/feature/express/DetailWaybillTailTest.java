package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;

import android.app.Application;

import me.pipi.deliveries.network.ExpressLog;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

/**
 * G-LOW-16 (2026-11-20 review): the detail page logs the same four-alphanumeric waybillTail as every other Lite line
 * (ExpressLog.tail): separators are dropped before the last four are taken, so a tail never carries a space or dash.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public final class DetailWaybillTailTest {
    @Test public void theDetailTailDropsSeparatorsBeforeTakingTheLastFour() {
        assertEquals("2345", tailOf("SF 1234-5"));
        assertEquals("AB12", tailOf("jt-00ab 12"));
        assertEquals("0001", tailOf(" JD0001 "));
        assertEquals("", tailOf(null));
        for (String waybill : new String[]{"SF 1234-5", "jt-00ab 12", "YT0000000001003", "12"}) {
            assertEquals(ExpressLog.tail(waybill), tailOf(waybill));
        }
    }

    private static String tailOf(String waybill) {
        return ReflectionHelpers.callStaticMethod(ExpressDetailActivity.class, "tailOf",
                ClassParameter.from(String.class, waybill));
    }
}
