package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;

import java.util.Arrays;

import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ManualQuerySuccess;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

/** 加件链第三级闸门：picker 与 v4_query 都没到起点、且 picker 给了 K100 页地址才抓（同 iOS/Pipi）。 */
public final class ExpressListActivityAddChainTest {
    private static final String ROUTE = "https://m.kuaidi100.com/result.jsp?nu=YT0000000001";

    private static ExpressQueryResult picker(String detail, boolean start) {
        String time = "2026-09-05 10:00:00";
        return new ExpressQueryResult(
                "YT0000000001", "YTO", "圆通速递",
                start ? StatusSemantic.PICKED : StatusSemantic.TRANSIT,
                time, detail,
                "[{\"time\":\"" + time + "\",\"context\":\"" + detail + "\"}]",
                "", "", TimelineSlot.V6_PICKER, "v6", ROUTE, "");
    }

    @Test
    public void capturesOnlyWhenNoLevelReachedTheStart() {
        ManualQuerySuccess partial = new ManualQuerySuccess(
                "meizu", picker("快件运输中", false), 1L, false);
        ManualQuerySuccess started = new ManualQuerySuccess(
                "meizu", picker("快件已揽收", true), 1L, false);

        assertEquals(ROUTE, ExpressListActivity.kuaidi100AddCaptureRoute(
                Arrays.asList(partial)));
        assertEquals("", ExpressListActivity.kuaidi100AddCaptureRoute(
                Arrays.asList(started)));
        assertEquals("", ExpressListActivity.kuaidi100AddCaptureRoute(
                Arrays.asList(partial, new ManualQuerySuccess(
                        TimelineSlot.V4_QUERY, picker("快件已揽收", true), 1L, false))));
        assertEquals("", ExpressListActivity.kuaidi100AddCaptureRoute(null));
    }
}
