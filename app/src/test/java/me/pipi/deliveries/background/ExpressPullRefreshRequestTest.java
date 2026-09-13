package me.pipi.deliveries.background;

import static org.junit.Assert.*;

import android.app.Application;
import androidx.work.NetworkType;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public class ExpressPullRefreshRequestTest {
    @Test public void explicitPullMarkerSurvivesTheWorkRequest() {
        androidx.work.impl.model.WorkSpec pull = ExpressScheduler.immediateRequest(true).getWorkSpec();
        androidx.work.impl.model.WorkSpec ordinary = ExpressScheduler.immediateRequest(false).getWorkSpec();
        assertTrue(pull.input.getBoolean(ExpressScheduler.USER_PULL, false));
        assertFalse(ordinary.input.getBoolean(ExpressScheduler.USER_PULL, false));
        assertEquals(ExpressSyncWorker.class.getName(), pull.workerClassName);
        assertEquals(NetworkType.CONNECTED, pull.constraints.getRequiredNetworkType());
    }
    @Test public void widgetAndForegroundUseTheSameNetworkWorkerWithDifferentRecentChecks() {
        var widget = ExpressScheduler.immediateRequest(false, "background", true).getWorkSpec();
        var foreground = ExpressScheduler.immediateRequest(false, "foreground", false).getWorkSpec();
        assertEquals(ExpressSyncWorker.class.getName(), widget.workerClassName);
        assertEquals(widget.workerClassName, foreground.workerClassName);
        assertEquals(NetworkType.CONNECTED, widget.constraints.getRequiredNetworkType());
        assertTrue(widget.input.getBoolean(ExpressScheduler.WIDGET_RECENT_CHECK, false));
        assertFalse(foreground.input.getBoolean(ExpressScheduler.WIDGET_RECENT_CHECK, false));
        assertEquals("foreground", foreground.input.getString(ExpressScheduler.TRIGGER));
    }

    @Test public void widgetFreshnessUsesCapturedSourceAndExpiresAtSixtySeconds() {
        android.content.Context context = org.robolectric.RuntimeEnvironment.getApplication();
        context.getSharedPreferences("express_network_success",0).edit().clear().commit();
        assertFalse(ExpressScheduler.hasRecentNetworkSuccess(context,"interface6",System.currentTimeMillis()));
        ExpressScheduler.recordNetworkSuccess(context,"interface6");
        long success=context.getSharedPreferences("express_network_success",0).getLong("interface6",0L);
        assertTrue(ExpressScheduler.hasRecentNetworkSuccess(context,"interface6",success+59_999L));
        assertFalse(ExpressScheduler.hasRecentNetworkSuccess(context,"interface6",success+60_000L));
        assertFalse(ExpressScheduler.hasRecentNetworkSuccess(context,"interface5",success));
        assertFalse(ExpressScheduler.hasRecentNetworkSuccess(context,"interface6",success-1L));
    }

}
