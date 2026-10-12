package me.pipi.deliveries;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

/**
 * 京东签收用例的夹具是 2026-09-24 记下的真实时间（北京时间）。签收满 14 天列表就隐藏、满 21 天首次入库会被拒收，
 * 所以把夹具整体按天平移到今天，节点之间的间隔和时分秒都不变。
 */
public final class FixtureDay {
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private static final long SHIFT_DAYS = LocalDate.now(ZoneId.of("Asia/Shanghai")).toEpochDay()
            - LocalDate.of(2026, 9, 24).toEpochDay();

    private FixtureDay() {}

    /** 把 2026-09-24 那天写下的夹具时间平移到今天。 */
    public static String at(String fixture) {
        return LocalDateTime.parse(fixture, TIME).plusDays(SHIFT_DAYS).format(TIME);
    }
}
