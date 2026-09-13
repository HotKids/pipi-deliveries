package me.pipi.deliveries.model;

import static org.junit.Assert.assertEquals;
import java.time.Instant;
import java.util.TimeZone;
import org.junit.Test;

public final class ExpressTimeCodecTest {
    @Test public void providerClockRemainsInChinaAcrossDeviceTimezones() {
        TimeZone previous = TimeZone.getDefault();
        try {
            long expected = Instant.parse("2026-09-10T02:15:30Z").toEpochMilli();
            for (String zone : new String[]{"UTC", "America/Los_Angeles", "Asia/Tokyo"}) {
                TimeZone.setDefault(TimeZone.getTimeZone(zone));
                assertEquals(expected, ExpressTimeline.parseTime("2026-09-10 10:15:30"));
                assertEquals(expected, ExpressTimeCodec.parse("2026-09-10T10:15:30+08:00"));
                assertEquals(expected, ExpressTimeCodec.parse("2026-09-10T02:15:30Z"));
            }
        } finally {
            TimeZone.setDefault(previous);
        }
    }

    @Test public void malformedDatesAndTrailingTextCannotSupplyEventEvidence() {
        assertEquals(0L, ExpressTimeCodec.parse("2026-02-30 10:15:30"));
        assertEquals(0L, ExpressTimeCodec.parse("2026-09-10 10:15:30 ignored"));
        assertEquals(0L, ExpressTimeCodec.parse("2026-09-10T10:15:30+08:00 ignored"));
        assertEquals(0L, ExpressTimeCodec.parse(null));
    }
}
