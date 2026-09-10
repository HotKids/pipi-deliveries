package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;
import android.app.Application;
import me.pipi.deliveries.model.*;
import me.pipi.deliveries.data.TimelineSlot;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class)
public class ExpressCainiaoTimelineParserTest {
    @Test public void minutePrecisionDomMatchesIosAndCannotSupplyStructuredStatus() {
        ExpressItem owner = ExpressInterfaceDetailPolicyTest.owner("INTERFACE5", "CaiNiao");
        ExpressQueryResult result = ExpressCainiaoTimelineParser.parse(
                "{\"extractionSource\":\"dom\",\"statusText\":\"已签收\",\"tracks\":["
                        + "{\"timeText\":\"2026-09-09 09:12\",\"detail\":\"已揽收\"}]}", owner);
        assertNotNull(result);
        assertEquals("2026-09-09 09:12:00", result.latestTime);
        assertEquals(owner.displayWaybill(), result.waybill);
        assertEquals(TimelineSlot.CN_H5, result.timelineProvider);
        assertEquals(StatusSemantic.UNKNOWN, result.semantic);
        assertFalse(result.structuredStatusEvidence);
        assertEquals(0L, result.statusEventTime);
    }

    @Test public void vueKeepsForecastRowsAndUsesOnlyTimedProviderNodes() {
        ExpressQueryResult result = ExpressCainiaoTimelineParser.parse(
                "{\"extractionSource\":\"vue\",\"tracks\":["
                        + "{\"timeText\":\"2026/09/09 09:12:00\",\"detail\":\"预计明日送达\"},"
                        + "{\"timeText\":\"invalid\",\"detail\":\"已签收\"},"
                        + "{\"timeText\":\"2026-09-08 09:12:00\",\"detail\":\"已揽收\"}]}",
                ExpressInterfaceDetailPolicyTest.owner("INTERFACE5", "CaiNiao"));
        assertNotNull(result);
        assertEquals(2, ExpressTimeline.parse(result.tracksJson, "", "").size());
        assertEquals("预计明日送达", result.latestDetail);
    }

    @Test public void missingFirstPartyExtractionIsNotAValidPackage() {
        assertNull(ExpressCainiaoTimelineParser.parse(
                "{\"extractionSource\":\"none\",\"tracks\":[{\"timeText\":\"2026-09-09 09:12\",\"detail\":\"已揽收\"}]}",
                ExpressInterfaceDetailPolicyTest.owner("INTERFACE5", "CaiNiao")));
    }
}
