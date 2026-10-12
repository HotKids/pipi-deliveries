package me.pipi.deliveries.feature.express;

import android.content.Context;

import java.util.HashMap;
import java.util.Map;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.data.ExpressOrderProjectionIdentity;
import me.pipi.deliveries.data.JingDongEmptyOrderPages;

/** Persists a bounded retry delay for an unresolved account-order H5 projection. */
final class ExpressOrderProjectionRetryStore {
    static final long FAILURE_COOLDOWN_MS = 60L * 60L * 1000L;

    private static final Map<String, AttemptToken> ACTIVE_ATTEMPTS = new HashMap<>();
    private final android.content.SharedPreferences timelineCooldown;
    private final JingDongEmptyOrderPages emptyPages;

    ExpressOrderProjectionRetryStore(Context context) {
        Context application = context.getApplicationContext();
        timelineCooldown = application.getSharedPreferences("express_jd_h5_cooldown", 0);
        emptyPages = new JingDongEmptyOrderPages(application);
    }

    AttemptToken beginAttempt(ExpressItem item, long now) {
        return ExpressHomeOrderProjectionCapture.needsProjection(item)
                ? beginTimelineAttempt(item, now) : null;
    }

    AttemptToken beginTimelineAttempt(ExpressItem item, long now) {
        return beginTimelineAttempt(item, now, null);
    }

    /** Home holds an order lease while querying; only an actual H5 load starts its cooldown. */
    AttemptToken beginTimelineAttempt(ExpressItem item, long now, AttemptToken pendingQuery) {
        if (!ExpressDetailActivity.usesInterface5Automatic(item) || !item.isAccountOrder()) return null;
        String identity = stableIdentity(item);
        if (identity.isEmpty()) return null;
        synchronized (ACTIVE_ATTEMPTS) {
            if (pendingQuery == null ? ACTIVE_ATTEMPTS.containsKey(identity)
                    : ACTIVE_ATTEMPTS.get(identity) != pendingQuery) return null;
            String key = timelineKey(item);
            long until = timelineCooldown.getLong(key, 0L);
            if (until > now && until - now <= FAILURE_COOLDOWN_MS) return null;
            long claimed = now + 10L * 60_000L;
            if (!timelineCooldown.edit().putLong(key, claimed).commit()) return null;
            AttemptToken token = pendingQuery == null ? acquireAttemptLocked(identity) : pendingQuery;
            token.claimedAt = now;
            token.claimedUntil = claimed;
            return token;
        }
    }

    /**
     * 优化 6（用户 2026-10-03「离屏失败不占冷却（推荐）」）：a background off-window union page that brought no package and was
     * not risk control gives back the ten minutes this attempt claimed, so Home's capture may open the page at once. The
     * attempt time stays as the order's mark (its place in the background order, the order opened longest ago first),
     * already over. Nothing changes when the claim was replaced meanwhile (risk control's hour, another attempt).
     */
    void releaseTimelineCooldown(ExpressItem item, AttemptToken token) {
        if (item == null || token == null || token.claimedUntil <= 0L) return;
        synchronized (ACTIVE_ATTEMPTS) {
            String key = timelineKey(item);
            if (timelineCooldown.getLong(key, 0L) != token.claimedUntil) return;
            timelineCooldown.edit().putLong(key, token.claimedAt).apply();
            token.claimedUntil = 0L;
        }
    }

    /** 只读冷却、不占租约也不写冷却：与 beginTimelineAttempt 同一个到期判断。 */
    boolean timelineAttemptDue(ExpressItem item, long now) {
        if (stableIdentity(item).isEmpty()) return false;
        long until = timelineCooldown.getLong(timelineKey(item), 0L);
        return !(until > now && until - now <= FAILURE_COOLDOWN_MS);
    }

    /**
     * 京粉页冷却的到期时刻（从没开过为 0），只读。后台轮次按它排队：最久没开过的单先开，封顶时不总是同几单。
     */
    long timelineCooldownUntil(ExpressItem item) {
        return stableIdentity(item).isEmpty() ? 0L : timelineCooldown.getLong(timelineKey(item), 0L);
    }

    void recordTimelineRateLimit(ExpressItem item, long now) {
        synchronized (ACTIVE_ATTEMPTS) {
            String key = timelineKey(item);
            long until = Math.max(timelineCooldown.getLong(key, 0L), now + FAILURE_COOLDOWN_MS);
            // The risk-control mark only names the rest in diagnostics (iOS riskControlAtMs); the rest itself
            // is the cooldown above.
            if (!timelineCooldown.edit().putLong(key, until).putLong(key + RISK_CONTROL_SUFFIX, until).commit())
                throw new IllegalStateException("JD cooldown persistence failed");
        }
    }

    private static final String RISK_CONTROL_SUFFIX = ".risk_control";

    /**
     * Why this order's union page may not open at {@code now}, in iOS's words (用户 2026-09-28, diagnostics
     * only): another capture of the order is running ({@code active_attempt}), the hour after JD risk
     * control ({@code risk_control_cooldown}), or the ordinary ten minutes ({@code cooldown}); null when
     * none of these holds. Reads only; the rest is decided by {@link #beginTimelineAttempt}.
     */
    String timelineSkipReason(ExpressItem item, long now) {
        String identity = stableIdentity(item);
        if (identity.isEmpty()) return null;
        synchronized (ACTIVE_ATTEMPTS) {
            if (ACTIVE_ATTEMPTS.containsKey(identity)) return "active_attempt";
        }
        String key = timelineKey(item);
        long until = timelineCooldown.getLong(key, 0L);
        if (!(until > now && until - now <= FAILURE_COOLDOWN_MS)) return null;
        return timelineCooldown.getLong(key + RISK_CONTROL_SUFFIX, 0L) > now ? "risk_control_cooldown" : "cooldown";
    }

    /**
     * 用户 2026-09-25 同意（方案 A）：已完成订单的京粉页确认是空壳后不再重开，首页、后台轮次与进详情取号都先问这里。
     */
    boolean pageConfirmedEmpty(ExpressItem item) {
        return emptyPages.confirmed(item);
    }

    /**
     * 一次京粉页的结果（与 iOS nextEmptyShellStrikes 同口径）：抓到带物流的东西（带节点的包、网络节点、运单号）就清掉
     * 这一单的空壳次数和记号；空壳（见 {@link ExpressAutomaticTimelineCapture.Result#emptyPage}，接口只回了不带物流的
     * 响应也算）记一次；其余结果——风控、union 请求出错（非 2xx 或网络失败）、加载失败、没加载完或没有视口就超时
     * ——既不算也不清。这一单已不是已完成、没有运单号的订单时，任何结果都清掉。中途取消的抓取调用方不会走到这里。
     */
    void recordPage(ExpressItem item, ExpressAutomaticTimelineCapture.Result result, long now) {
        if (item == null) return;
        boolean logistics = result != null && (result.timeline != null || result.logisticsSeen);
        if (logistics || !JingDongEmptyOrderPages.applies(item)) emptyPages.forget(item);
        else if (result != null && result.emptyPage) emptyPages.recordEmpty(item, now);
    }

    private static String timelineKey(ExpressItem item) {
        return ExpressOrderProjectionIdentity.orderHash(item.waybill);
    }

    static AttemptToken acquireAttempt(ExpressItem item) {
        String identity = stableIdentity(item);
        if (identity.isEmpty()) return null;
        synchronized (ACTIVE_ATTEMPTS) {
            if (ACTIVE_ATTEMPTS.containsKey(identity)) return null;
            return acquireAttemptLocked(identity);
        }
    }

    private static AttemptToken acquireAttemptLocked(String identity) {
        AttemptToken token = new AttemptToken(identity);
        ACTIVE_ATTEMPTS.put(identity, token);
        return token;
    }

    void endAttempt(AttemptToken token) {
        releaseAttempt(token);
    }

    static boolean releaseAttempt(AttemptToken token) {
        if (token == null || token.identity.isEmpty()) return false;
        synchronized (ACTIVE_ATTEMPTS) {
            if (ACTIVE_ATTEMPTS.get(token.identity) != token) return false;
            ACTIVE_ATTEMPTS.remove(token.identity);
            return true;
        }
    }

    static final class AttemptToken {
        final String identity;
        /** The union page this attempt opened: when it claimed the cooldown, and the end it claimed; 0 for none. */
        long claimedAt;
        long claimedUntil;

        AttemptToken(String identity) {
            this.identity = identity == null ? "" : identity;
        }
    }

    static String stableIdentity(ExpressItem item) {
        return ExpressOrderProjectionIdentity.stableIdentity(item);
    }

    static String routeFingerprint(ExpressItem item) {
        return ExpressOrderProjectionIdentity.routeFingerprint(item);
    }
}
