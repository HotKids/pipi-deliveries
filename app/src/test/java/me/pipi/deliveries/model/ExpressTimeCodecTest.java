package me.pipi.deliveries.model;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.time.Instant;
import java.util.TimeZone;

public final class ExpressTimeCodecTest {
    @Test
    public void providerClockRemainsInChinaAcrossDeviceTimezones() {
        TimeZone previous = TimeZone.getDefault();
        try {
            long expected = Instant.parse("2026-09-10T02:15:30Z").toEpochMilli();
            long expectedMinute = Instant.parse("2026-09-10T02:15:00Z").toEpochMilli();
            for (String zone : new String[]{"UTC", "America/Los_Angeles", "Asia/Tokyo"}) {
                TimeZone.setDefault(TimeZone.getTimeZone(zone));
                assertEquals(expected, ExpressTimeline.parseTime("2026-09-10 10:15:30"));
                assertEquals(expectedMinute, ExpressTimeCodec.parse("2026-09-10 10:15"));
                assertEquals(expected, ExpressTimeCodec.parse("2026-09-10T10:15:30"));
                assertEquals(expectedMinute, ExpressTimeCodec.parse("2026-09-10T10:15"));
                assertEquals(expected, ExpressTimeCodec.parse("2026-09-10T10:15:30+08:00"));
                assertEquals(expected, ExpressTimeCodec.parse("2026-09-10T02:15:30Z"));
                assertEquals(expected + 125L,
                        ExpressTimeCodec.parse("2026-09-10T10:15:30.125+08:00"));
                assertEquals("2026-09-10 10:15",
                        ExpressTimeCodec.formatListTime("2026-09-10 10:15:30"));
            }
        } finally {
            TimeZone.setDefault(previous);
        }
    }

    @Test
    public void parseEpochOrTextNormalizesSecondsMillisecondsAndText() {
        long expected = Instant.parse("2026-09-10T02:15:30Z").toEpochMilli();
        assertEquals(expected, ExpressTimeCodec.parseEpochOrText(expected / 1000L));
        assertEquals(expected, ExpressTimeCodec.parseEpochOrText(Long.toString(expected / 1000L)));
        assertEquals(expected, ExpressTimeCodec.parseEpochOrText(Long.toString(expected)));
        assertEquals(expected, ExpressTimeCodec.parseEpochOrText("2026-09-10 10:15:30"));
        assertEquals(0L, ExpressTimeCodec.parseEpochOrText(0L));
        assertEquals(0L, ExpressTimeCodec.parseEpochOrText("-5"));
        assertEquals(0L, ExpressTimeCodec.parseEpochOrText(null));
    }

    @Test
    public void malformedDatesAndTrailingTextCannotSupplyEventEvidence() {
        assertEquals(0L, ExpressTimeCodec.parse("2026-02-30 10:15:30"));
        assertEquals(0L, ExpressTimeCodec.parse("2026-09-10 10:15:30 ignored"));
        assertEquals(0L, ExpressTimeCodec.parse("2026-09-10T10:15:30+08:00 ignored"));
        assertEquals(0L, ExpressTimeCodec.parse(null));
    }
}
