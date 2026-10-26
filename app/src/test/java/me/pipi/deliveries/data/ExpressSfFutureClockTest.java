package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;

import android.app.Application;
import android.os.SystemClock;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        instrumentedPackages = {"me.pipi.deliveries.data"})
public final class ExpressSfFutureClockTest {
    @Test public void retainedFutureStatusBecomesEligibleWhenItsClockArrives() {
        long now = ExpressSourcePolicy.parseEventTime("2026-10-24 12:00:00");
        long future = now + 3_600_000L;
        SystemClock.setCurrentTimeMillis(now);
        assertEquals(now, org.robolectric.shadows.ShadowSystem.currentTimeMillis());
        ExpressItem owner = new ExpressItem(
                84L, "13900001234", "SF-FUTURE", "SF", "顺丰速运",
                StatusSemantic.TRANSIT, "运输中", "Synthetic accepted transit",
                "2026-10-24 11:59:00", "[]", "", "INTERFACE5", "",
                now - 60_000L, now, "INTERFACE5", "INTERFACE5", "v5", "", false,
                "", "", "", "ShunFeng", false, "", 0L);
        String tracks = "[{\"time\":\"2026-10-24 13:00:00\",\"context\":\"Synthetic future delivery\"}]";
        ExpressQueryResult packet = new ExpressQueryResult(
                owner.waybill, "SF", "顺丰速运", StatusSemantic.DELIVERY, future,
                "2026-10-24 13:00:00", "Synthetic future delivery", tracks,
                "", "", "v6_query", "", "", "")
                .withManualStatusEvidence("派送中", true);
        ManualTimelineAuthorityPolicy.Candidate cached =
                new ManualTimelineAuthorityPolicy.Candidate("v6_query", packet, now, true);

        ExpressItem before = ExpressRepository.projectManualTimeline(owner, cached);
        assertEquals(StatusSemantic.TRANSIT, before.semantic);
        assertEquals(owner.statusEventTime, before.statusEventTime);
        assertEquals(tracks, cached.result.tracksJson);
        assertEquals(StatusSemantic.DELIVERY, cached.result.semantic);
        assertEquals(future, cached.result.statusEventTime);

        SystemClock.setCurrentTimeMillis(future);
        assertEquals(future, org.robolectric.shadows.ShadowSystem.currentTimeMillis());
        ExpressItem after = ExpressRepository.projectManualTimeline(before, cached);
        assertEquals(StatusSemantic.DELIVERY, after.semantic);
        assertEquals(future, after.statusEventTime);
        assertEquals(tracks, after.tracksJson);
        assertEquals(tracks, cached.result.tracksJson);
        assertEquals(future, cached.result.statusEventTime);
    }
}
