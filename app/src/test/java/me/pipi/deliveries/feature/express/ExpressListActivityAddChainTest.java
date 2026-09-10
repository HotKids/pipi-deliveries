package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;

import java.util.Arrays;

import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ManualQuerySuccess;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import android.app.Application;

/** K100 keeps the add-chain start gate and uses the requested waybill rather than Picker's URL. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public final class ExpressListActivityAddChainTest {
    private static final String ROUTE = "https://m.kuaidi100.com/result.jsp?nu=YT0000000001";

    private static ExpressQueryResult picker(String detail, boolean start) {
        String time = "2026-09-05 10:00:00";
        return new ExpressQueryResult(
                "YT0000000001", "YTO", "圆通速递",
                start ? StatusSemantic.PICKED : StatusSemantic.TRANSIT,
                time, detail,
                "[{\"time\":\"" + time + "\",\"context\":\"" + detail + "\"}]",
                "", "", TimelineSlot.V6_QUERY, "v6", ROUTE, "");
    }

    @Test
    public void capturesOnlyWhenNoLevelReachedTheStart() {
        ManualQuerySuccess partial = new ManualQuerySuccess(
                "meizu", picker("快件运输中", false), 1L, false);
        ManualQuerySuccess started = new ManualQuerySuccess(
                "meizu", picker("快件已揽收", true), 1L, false);

        assertEquals("https://m.kuaidi100.com/app/query/?nu=YT0000000001", ExpressDetailActivity.kuaidi100AddCaptureRoute(
                " yt-0000000001 ", Arrays.asList(partial)));
        assertEquals("", ExpressDetailActivity.kuaidi100AddCaptureRoute(
                "YT0000000001", Arrays.asList(started)));
        assertEquals("", ExpressDetailActivity.kuaidi100AddCaptureRoute(
                "YT0000000001", Arrays.asList(partial, new ManualQuerySuccess(
                        TimelineSlot.V4_QUERY, picker("快件已揽收", true), 1L, false))));
        assertEquals("", ExpressDetailActivity.kuaidi100AddCaptureRoute("YT0000000001", null));
        assertEquals("", ExpressDetailActivity.kuaidi100AddCaptureRoute("", Arrays.asList(partial)));
    }
}
