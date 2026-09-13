package me.pipi.deliveries.data;

import static org.junit.Assert.*;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import me.pipi.deliveries.data.ManualTimelineAuthorityPolicy.Candidate;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.WorkerStatusProjection;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class StatusDonorPolicyTest {
    private static final long EVENT = 1789290913000L;

    static Candidate candidate(String waybill, String provider, StatusSemantic semantic,
            int priority, long event, int count, boolean pickup, boolean captured) throws Exception {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));
        JSONArray tracks = new JSONArray();
        for (int i = 0; i < count; i++) tracks.put(new JSONObject()
                .put("time", format.format(new Date(event - i * 60_000L)))
                .put("context", pickup && i == count - 1 ? "已揽收" : "Provider event " + i));
        WorkerStatusProjection status = WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1).put("scope", "SHIPMENT")
                        .put("semantic", semantic.name()).put("code", "SERVER_ENUM")
                        .put("text", priority == 1 ? "驿站派送中" : semantic.label)
                        .put("priority", priority).put("eventAtMs", event)
                        .put("structured", semantic != StatusSemantic.UNKNOWN)));
        ExpressQueryResult result = new ExpressQueryResult(waybill, "EMS", "EMS", semantic,
                event, format.format(new Date(event)), "Provider event 0", tracks.toString(),
                "", "", provider, "", "", "").withWorkerStatus(status);
        return new Candidate(provider, result, 1L, captured);
    }

    private static Candidate candidate(String provider, StatusSemantic semantic, int priority,
            long event, int count, boolean pickup, boolean captured) throws Exception {
        return candidate("EMS_DONOR_TEST", provider, semantic, priority, event, count, pickup, captured);
    }

    @Test public void unknownHistoryCannotChangeEqualTimeStructuredWinnerInEitherOrder() throws Exception {
        Candidate delivery = candidate("v4_query", StatusSemantic.DELIVERY, 1, EVENT, 4, true, false);
        Candidate transit = candidate("v6_query", StatusSemantic.TRANSIT, 0, EVENT, 1, false, false);
        Candidate h5 = candidate("k100_h5", StatusSemantic.UNKNOWN, 0, EVENT, 14, true, true);
        for (boolean includeH5 : new boolean[]{false, true}) {
            List<Candidate> candidates = new ArrayList<>(Arrays.asList(transit, delivery));
            if (includeH5) candidates.add(h5);
            for (int order = 0; order < 2; order++, Collections.reverse(candidates)) {
                assertSame(delivery, ManualTimelineAuthorityPolicy.selectStructuredStatus(candidates));
                Candidate history = ManualTimelineAuthorityPolicy.selectDetail(candidates);
                assertSame(includeH5 ? h5 : delivery, history);
                ExpressQueryResult shown = ManualTimelineAuthorityPolicy.presentationResult(history.result, candidates);
                assertEquals(StatusSemantic.DELIVERY, shown.semantic);
                assertEquals("驿站派送中", shown.statusDescription);
                assertEquals(includeH5 ? 14 : 4, Kuaidi100TimelinePolicy.timedTrackCount(shown));
            }
        }
        assertEquals(StatusSemantic.UNKNOWN, h5.result.semantic);
    }

    @Test public void newerDifferentSemanticWinsDonorWithoutReplacingValidHistoryStatus() throws Exception {
        Candidate delivery = candidate("v4_query", StatusSemantic.DELIVERY, 1, EVENT, 4, true, false);
        Candidate transit = candidate("v6_query", StatusSemantic.TRANSIT, 0, EVENT + 1000, 1, false, false);
        Candidate h5 = candidate("k100_h5", StatusSemantic.UNKNOWN, 0, EVENT, 14, true, true);
        List<Candidate> candidates = Arrays.asList(delivery, h5, transit);
        assertSame(transit, ManualTimelineAuthorityPolicy.selectStructuredStatus(candidates));
        assertEquals(StatusSemantic.TRANSIT, ManualTimelineAuthorityPolicy.presentationResult(h5.result, candidates).semantic);
        assertSame(delivery.result, ManualTimelineAuthorityPolicy.presentationResult(delivery.result, candidates));
    }

    @Test public void semanticGroupingRemovesPriorityTimeCycleInAllSixPermutations() throws Exception {
        Candidate station = candidate("v4_query", StatusSemantic.DELIVERY, 1, EVENT - 3000, 4, true, false);
        Candidate ordinary = candidate("v6_query", StatusSemantic.DELIVERY, 0, EVENT - 1000, 6, true, false);
        Candidate transit = candidate("k100_h5", StatusSemantic.TRANSIT, 0, EVENT - 2000, 2, true, true);
        Candidate[] values = {station, ordinary, transit};
        for (int a = 0; a < 3; a++) for (int b = 0; b < 3; b++) {
            if (a == b) continue;
            List<Candidate> order = Arrays.asList(values[a], values[b], values[3 - a - b]);
            assertSame(transit, ManualTimelineAuthorityPolicy.selectStructuredStatus(order));
        }
        assertSame(station, ManualTimelineAuthorityPolicy.selectStructuredStatus(Arrays.asList(ordinary, station)));
    }

    @Test public void tiedStatusClockReusesCompletenessThenCoverageThenCaptureQuality() throws Exception {
        Candidate complete = candidate("v4_query", StatusSemantic.DELIVERY, 0, EVENT, 2, true, false);
        Candidate partial = candidate("v6_query", StatusSemantic.TRANSIT, 0, EVENT, 5, false, true);
        assertSame(complete, ManualTimelineAuthorityPolicy.selectStructuredStatus(Arrays.asList(partial, complete)));
        Candidate richer = candidate("v4_query", StatusSemantic.DELIVERY, 0, EVENT, 4, true, false);
        Candidate shorter = candidate("v6_query", StatusSemantic.TRANSIT, 0, EVENT, 2, true, false);
        assertSame(richer, ManualTimelineAuthorityPolicy.selectStructuredStatus(Arrays.asList(shorter, richer)));
        Candidate captured = candidate("k100_h5", StatusSemantic.DELIVERY, 0, EVENT, 2, true, true);
        assertSame(captured, ManualTimelineAuthorityPolicy.selectStructuredStatus(Arrays.asList(shorter, captured)));
        Candidate free = candidate("v4_query", StatusSemantic.DELIVERY, 0, EVENT, 2, true, false);
        Candidate paid = candidate("kdniao", StatusSemantic.TRANSIT, 0, EVENT, 2, true, false);
        assertSame(free, ManualTimelineAuthorityPolicy.selectStructuredStatus(Arrays.asList(paid, free)));
        Candidate online = candidate("v6_query", StatusSemantic.TRANSIT, 0, EVENT, 2, true, false);
        assertSame(online, ManualTimelineAuthorityPolicy.selectStructuredStatus(Arrays.asList(free, online)));
    }

    @Test public void validStatusUsesItsOwnSemanticSubtypeDespiteNewerForeignSemanticDonor() throws Exception {
        Candidate selected = candidate("v6_query", StatusSemantic.DELIVERY, 0, EVENT, 4, true, false);
        Candidate station = candidate("v4_query", StatusSemantic.DELIVERY, 1, EVENT, 2, true, false);
        Candidate newer = candidate("k100_h5", StatusSemantic.TRANSIT, 0, EVENT + 1000, 6, true, true);
        List<Candidate> candidates = Arrays.asList(newer, selected, station);
        assertSame(newer, ManualTimelineAuthorityPolicy.selectStructuredStatus(candidates));
        ExpressQueryResult shown = ManualTimelineAuthorityPolicy.presentationResult(selected.result, candidates);
        assertEquals(StatusSemantic.DELIVERY, shown.semantic);
        assertEquals("驿站派送中", shown.statusDescription);
        assertEquals(1, shown.workerStatus.priority);
        assertEquals(EVENT, shown.statusEventTime);
        assertEquals(selected.provider, shown.timelineProvider);
        assertEquals(4, Kuaidi100TimelinePolicy.timedTrackCount(shown));
        assertEquals(0, selected.result.workerStatus.priority);
    }

    @Test public void retainedTerminalAndSameTicketEligibilityRemainUnchanged() throws Exception {
        Candidate signed = candidate("v4_query", StatusSemantic.COMPLETED, 0, EVENT - 1000, 2, true, false);
        Candidate newer = candidate("v6_query", StatusSemantic.TRANSIT, 0, EVENT, 4, true, false);
        assertSame(signed, ManualTimelineAuthorityPolicy.selectStructuredStatus(Arrays.asList(newer, signed), true));
        Candidate h5 = candidate("k100_h5", StatusSemantic.UNKNOWN, 0, EVENT, 14, true, true);
        Candidate wrong = candidate("OTHER_TICKET", "v4_query", StatusSemantic.DELIVERY, 1, EVENT, 4, true, false);
        assertSame(h5.result, ManualTimelineAuthorityPolicy.presentationResult(h5.result, Arrays.asList(wrong, h5)));
    }
}
