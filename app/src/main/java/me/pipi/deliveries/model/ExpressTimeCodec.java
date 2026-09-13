package me.pipi.deliveries.model;

import java.time.LocalDateTime;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.format.ResolverStyle;
import java.time.temporal.TemporalAccessor;
import java.util.Locale;

/** Provider timestamps without an offset belong to China, independently of device timezone. */
public final class ExpressTimeCodec {
    private static final ZoneId CHINA = ZoneId.of("Asia/Shanghai");
    private static final DateTimeFormatter[] PROVIDER_FORMATS = {
            formatter("uuuu-MM-dd HH:mm:ss"),
            formatter("uuuu-MM-dd HH:mm"),
            formatter("uuuu-MM-dd'T'HH:mm:ss"),
            formatter("uuuu-MM-dd'T'HH:mm"),
            formatter("uuuu-MM-dd'T'HH:mm:ssXXX"),
            formatter("uuuu-MM-dd'T'HH:mmXXX"),
            formatter("uuuu-MM-dd'T'HH:mm:ss.SSSXXX")
    };

    private ExpressTimeCodec() {}

    public static String formatListTime(String raw) {
        long epoch = parse(raw);
        return epoch <= 0L ? (raw == null ? "" : raw)
                : formatter("uuuu-MM-dd HH:mm").format(Instant.ofEpochMilli(epoch).atZone(CHINA));
    }

    private static DateTimeFormatter formatter(String pattern) {
        return DateTimeFormatter.ofPattern(pattern, Locale.ROOT)
                .withResolverStyle(ResolverStyle.STRICT);
    }

    public static long parse(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) return 0L;
        for (DateTimeFormatter parser : PROVIDER_FORMATS) {
            try {
                TemporalAccessor parsed = parser.parseBest(value,
                        OffsetDateTime::from, LocalDateTime::from);
                return parsed instanceof OffsetDateTime
                        ? ((OffsetDateTime) parsed).toInstant().toEpochMilli()
                        : ((LocalDateTime) parsed).atZone(CHINA).toInstant().toEpochMilli();
            } catch (DateTimeParseException invalid) {
                // Each accepted shape is the same provider contract as Pipi Assistant.
            }
        }
        return 0L;
    }
}
