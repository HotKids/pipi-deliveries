package me.pipi.deliveries.model;

import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.format.ResolverStyle;
import java.time.temporal.ChronoField;
import java.time.temporal.TemporalAccessor;
import java.util.Locale;

/** Provider timestamps without an offset belong to China, independently of device timezone. */
public final class ExpressTimeCodec {
    private static final ZoneId CHINA = ZoneId.of("Asia/Shanghai");
    private static final DateTimeFormatter SPACE_SECONDS = formatter("uuuu-MM-dd HH:mm:ss");
    private static final DateTimeFormatter LIST_FORMAT = formatter("uuuu-MM-dd HH:mm");
    private static final DateTimeFormatter ISO_SECONDS = formatter("uuuu-MM-dd'T'HH:mm:ss");
    private static final DateTimeFormatter ISO_MINUTES = formatter("uuuu-MM-dd'T'HH:mm");
    private static final DateTimeFormatter ISO_OFFSET_SECONDS =
            formatter("uuuu-MM-dd'T'HH:mm:ssXXX");
    private static final DateTimeFormatter ISO_OFFSET_MINUTES =
            formatter("uuuu-MM-dd'T'HH:mmXXX");
    private static final DateTimeFormatter ISO_OFFSET_MILLIS =
            formatter("uuuu-MM-dd'T'HH:mm:ss.SSSXXX");
    private static final DateTimeFormatter[] ISO_OFFSET_FORMATS = {
            ISO_OFFSET_SECONDS,
            ISO_OFFSET_MINUTES,
            ISO_OFFSET_MILLIS
    };

    private ExpressTimeCodec() {}

    public static String formatListTime(String raw) {
        long epoch = parse(raw);
        return epoch <= 0L
                ? (raw == null ? "" : raw)
                : LIST_FORMAT.format(Instant.ofEpochMilli(epoch).atZone(CHINA));
    }

    private static DateTimeFormatter formatter(String pattern) {
        return DateTimeFormatter.ofPattern(pattern, Locale.ROOT)
                .withResolverStyle(ResolverStyle.STRICT);
    }

    public static long parseEpochOrText(Object raw) {
        if (raw == null || raw == JSONObject.NULL) {
            return 0L;
        }
        if (raw instanceof Number) {
            return normalizeEpoch(((Number) raw).longValue());
        }
        String value = String.valueOf(raw).trim();
        if (value.isEmpty()) {
            return 0L;
        }
        if (!looksLikeLong(value)) {
            return parse(value);
        }
        try {
            return normalizeEpoch(Long.parseLong(value));
        } catch (NumberFormatException ignored) {
            return parse(value);
        }
    }

    static boolean looksLikeLong(String value) {
        int length = value.length();
        int index = 0;
        char first = value.charAt(0);
        if (first == '-' || first == '+') {
            if (length == 1) {
                return false;
            }
            index = 1;
        }
        for (; index < length; index++) {
            if (Character.digit(value.charAt(index), 10) < 0) {
                return false;
            }
        }
        return true;
    }

    static long normalizeEpoch(long value) {
        if (value <= 0L) {
            return 0L;
        }
        return value < 100_000_000_000L ? value * 1000L : value;
    }

    public static long parse(String raw) {
        String value = raw == null ? "" : raw.trim();
        int length = value.length();
        if (length < 16) {
            return 0L;
        }
        char separator = value.charAt(10);
        if (separator == ' ') {
            if (length == 19) {
                return tryParseLocal(SPACE_SECONDS, value);
            }
            if (length == 16) {
                return tryParseLocal(LIST_FORMAT, value);
            }
            return 0L;
        }
        if (separator != 'T') {
            return 0L;
        }
        if (length == 19) {
            return tryParseLocal(ISO_SECONDS, value);
        }
        if (length == 16) {
            return tryParseLocal(ISO_MINUTES, value);
        }
        for (DateTimeFormatter parser : ISO_OFFSET_FORMATS) {
            try {
                TemporalAccessor parsed = parser.parse(value);
                return parsed.isSupported(ChronoField.OFFSET_SECONDS)
                        ? OffsetDateTime.from(parsed).toInstant().toEpochMilli()
                        : LocalDateTime.from(parsed).atZone(CHINA).toInstant().toEpochMilli();
            } catch (DateTimeParseException ignored) {
                // Try the remaining offset shapes in the shared provider contract.
            }
        }
        return 0L;
    }

    private static long tryParseLocal(DateTimeFormatter parser, String value) {
        try {
            return LocalDateTime.parse(value, parser).atZone(CHINA).toInstant().toEpochMilli();
        } catch (DateTimeParseException ignored) {
            return 0L;
        }
    }
}
