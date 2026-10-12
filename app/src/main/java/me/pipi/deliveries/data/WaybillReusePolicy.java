package me.pipi.deliveries.data;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;

/**
 * A carrier reusing an old waybill number (user decisions 2026-10-01/02, all four clients): 「C 新件优先（含 A）」,
 * 「至少晚 24 小时」, 「当新件初次出现，不通知」, details 「全部按推荐」.
 *
 * <p>The number is reused when the old record is terminal (signed or cancelled) and the new record's anchor is at
 * least 24 hours after the old record's terminal time. The anchor is the new record's earliest timed node; a record
 * without nodes uses its own status time, then its latest time; a record with no time at all is never judged reused.
 * The old record's terminal time is the latest of its own status time, the time it shows and its newest timed node,
 * so none of the old parcel's own nodes falls inside the 24 hours (the same reading as Pipi). Times are valid when
 * positive and not in the future. JingDong business sources are excluded on either side.</p>
 *
 * <p>The repository applies the outcome: a new record takes the row as a first sighting after the old record's row,
 * caches, latch, remark, detail selection and carrier recognition are removed; an old record meeting a row a newer
 * parcel already took is ignored. The account list keeps the new record of the two (detail 5).</p>
 */
public final class WaybillReusePolicy {
    /** 「至少晚 24 小时」. */
    public static final long MIN_GAP_MS = 24L * 60L * 60L * 1000L;

    private WaybillReusePolicy() {}

    /** Whether {@code newer} is a new parcel on the number {@code older} used; either order of two list records. */
    public static boolean supersedes(ExpressQueryResult older, ExpressQueryResult newer, long now) {
        if (older == null || newer == null
                || AutomaticOwnershipPolicy.isJingDongSource(older.sourceProvider)
                || AutomaticOwnershipPolicy.isJingDongSource(newer.sourceProvider)) return false;
        return reuses(terminalAt(older, now), anchorAt(newer, now));
    }

    static boolean reuses(long oldTerminalAt, long newAnchorAt) {
        return oldTerminalAt > 0L && newAnchorAt > 0L && newAnchorAt - oldTerminalAt >= MIN_GAP_MS;
    }

    static long terminalAt(ExpressItem item, long now) {
        return item == null || !item.semantic.terminal() ? 0L
                : terminalAt(item.tracksJson, item.statusEventTime, item.latestTime, now);
    }

    static long terminalAt(ExpressQueryResult result, long now) {
        return result == null || result.semantic == null || !result.semantic.terminal() ? 0L
                : terminalAt(result.tracksJson, result.statusEventTime, result.latestTime, now);
    }

    /**
     * 优化 5（协调方定的接口约定）：the parcel's own reuse anchor as the paid classify request carries it — its earliest timed
     * node, else its status time, else its latest time, each only when positive and not after {@code now}; 0 (not sent)
     * when there is none.
     */
    public static long parcelAnchorAt(ExpressItem item, long now) {
        return anchorAt(item, now);
    }

    /** {@link #parcelAnchorAt(ExpressItem, long)} for an account record not stored as a row yet. */
    public static long parcelAnchorAt(ExpressQueryResult result, long now) {
        return anchorAt(result, now);
    }

    static long anchorAt(ExpressItem item, long now) {
        return item == null ? 0L : anchorAt(item.tracksJson, item.statusEventTime, item.latestTime, now);
    }

    static long anchorAt(ExpressQueryResult result, long now) {
        return result == null ? 0L
                : anchorAt(result.tracksJson, result.statusEventTime, result.latestTime, now);
    }

    private static long terminalAt(String tracksJson, long statusEventTime, String latestTime, long now) {
        long latest = Math.max(valid(statusEventTime, now), valid(ExpressTimeline.parseTime(latestTime), now));
        for (ExpressTimeline.Track track : ExpressTimeline.parse(tracksJson, "", "")) {
            latest = Math.max(latest, valid(track.epochMillis, now));
        }
        return latest;
    }

    private static long anchorAt(String tracksJson, long statusEventTime, String latestTime, long now) {
        long earliest = 0L;
        for (ExpressTimeline.Track track : ExpressTimeline.parse(tracksJson, "", "")) {
            long at = valid(track.epochMillis, now);
            if (at > 0L && (earliest == 0L || at < earliest)) earliest = at;
        }
        if (earliest > 0L) return earliest;
        long status = valid(statusEventTime, now);
        return status > 0L ? status : valid(ExpressTimeline.parseTime(latestTime), now);
    }

    private static long valid(long value, long now) {
        return value > 0L && value <= now ? value : 0L;
    }
}
