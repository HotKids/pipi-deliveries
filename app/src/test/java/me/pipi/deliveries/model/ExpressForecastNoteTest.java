package me.pipi.deliveries.model;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.List;

/**
 * AGENTS §107（用户定 2026-09-04，裁决 A 整条撤销，三端同规则）：来源返回什么就显示什么。预告文案是普通节点，
 * 照常进轨迹、进节点计数、能当头条；只有 provider 自己的错误占位行被剔除。
 */
public final class ExpressForecastNoteTest {
    private static final String PICKUP =
            "【DK江门维达网点】的谭秀文（18128210371）已取件，物流问题请联系：0750-2484284为您解决";

    @Test public void forecastNotesAreOrdinaryEventsAndOnlyProviderErrorsAreDropped() {
        assertFalse(ExpressStatusNormalizer.isNonEventDetail("预计9月4日(周五)送达"));
        assertFalse(ExpressStatusNormalizer.isNonEventDetail("最快9月3日发货，9月4日(周五)送达"));
        assertFalse(ExpressStatusNormalizer.isNonEventDetail("温馨提示：您的订单预计9月6日09:00-15:00送达"));
        assertFalse(ExpressStatusNormalizer.isNonEventDetail(PICKUP));
        assertTrue(ExpressStatusNormalizer.isNonEventDetail("查无结果"));
        assertFalse(ExpressStatusNormalizer.isProviderErrorDetail("预计9月4日(周五)送达"));
        assertFalse(ExpressStatusNormalizer.isHeadlinePlaceholder(
                "预计9月4日(周五)送达", StatusSemantic.TRANSIT));
    }

    @Test public void timelinesKeepForecastRowsAsTheSourceReturnedThem() throws Exception {
        String tracks = new JSONArray()
                .put(new JSONObject().put("time", "2026-09-03 17:54:53")
                        .put("context", "预计9月4日(周五)送达"))
                .put(new JSONObject().put("time", "2026-09-03 17:49:51").put("context", PICKUP))
                .put(new JSONObject().put("time", "2026-09-03 14:49:46")
                        .put("context", "最快9月3日发货，9月4日(周五)送达"))
                .toString();
        List<ExpressTimeline.Track> parsed = ExpressTimeline.parse(tracks, "", "");
        assertEquals(3, parsed.size());
        assertEquals("预计9月4日(周五)送达", parsed.get(0).detail);
        assertEquals("2026-09-03 17:54:53", parsed.get(0).time);
        assertEquals(PICKUP, parsed.get(1).detail);
        assertFalse(ExpressTimeline.containsProviderError(tracks));
        // A forecast fallback headline is a node like any other headline.
        assertEquals(1, ExpressTimeline.parse("[]", "2026-09-03 17:54:53", "预计9月4日(周五)送达")
                .size());
        assertEquals("预计9月4日(周五)送达",
                ExpressTimeline.latestMeaningful(tracks, StatusSemantic.TRANSIT).detail);
    }
}
