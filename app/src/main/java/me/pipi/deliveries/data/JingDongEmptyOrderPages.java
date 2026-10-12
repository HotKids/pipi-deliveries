package me.pipi.deliveries.data;

import android.content.Context;
import android.content.SharedPreferences;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

/**
 * 用户 2026-09-25 同意（方案 A）：已完成的京东订单，京粉页一旦确认是空壳（完全没有物流接口响应），就记住这一单，
 * 不再重试。三端同一口径（iOS account-sync-policy.ts unionPageOutcome / nextEmptyShellStrikes）：
 * <ul>
 *   <li>空壳由 {@code ExpressAutomaticTimelineCapture} 判定：页面加载完、有真实视口、不是风控，什么带物流的东西
 *   都没抓到（没有带节点的包、没有网络节点、没有运单号），而且 getUnionActivity 要么一次都没发出，要么发出的都回了
 *   2xx（回的能不能解析不算数）。发出了、到超时还没回的请求与出错一样既不算也不清（用户 2026-09-26，其余裁决 4）。</li>
 *   <li>「确认」= 同一单两次空壳、后一次距上一次至少一个京粉页冷却（10 分钟）；不到 10 分钟的又一次只把这一次挪到
 *   新的时间。只有一次时照常到冷却再试。</li>
 *   <li>抓到带物流的东西就把这一单的次数和记号一起清掉；风控、union 请求出错（非 2xx 或网络失败）既不算也不清。</li>
 * </ul>
 *
 * <p>记号只按订单号哈希存（与京粉页冷却同一种哈希，{@link ExpressOrderProjectionIdentity#orderHash}），不存订单号
 * 本身（AGENTS §9）。只有已完成、还没有运单号的接口 5 京东订单会被记；它不再已完成或有了运单号，记号就不起作用。</p>
 */
public final class JingDongEmptyOrderPages {
    static final String PREFERENCES = "express_jd_h5_empty_page";
    /** 两次空壳至少相隔一个京粉页冷却，与 ExpressOrderProjectionRetryStore 的 10 分钟同值。 */
    public static final long CONFIRMATION_SPACING_MS = 10L * 60L * 1000L;
    /** 存的是最近一次还没确认的空壳时间；确认后换成这个值。 */
    private static final long CONFIRMED = -1L;
    private static final Object LOCK = new Object();

    private final SharedPreferences marks;

    public JingDongEmptyOrderPages(Context context) {
        marks = context.getApplicationContext().getSharedPreferences(PREFERENCES, 0);
    }

    /** 已完成、还没有运单号（没有订单投影）的接口 5 京东账号订单：只有它能被记、记号也只对它起作用。 */
    public static boolean applies(ExpressItem order) {
        if (order == null || order.manuallyAdded || !order.isJingDongSource()
                || !order.projectedWaybill.isEmpty()
                || order.semantic != StatusSemantic.COMPLETED) return false;
        String owner = order.stateOwner.isEmpty() ? order.source : order.stateOwner;
        return ExpressSourcePolicy.SOURCE_INTERFACE5_JD.equals(ExpressSourcePolicy.source(owner))
                && !ExpressSourcePolicy.normalizeWaybill(order.waybill).isEmpty();
    }

    /** 这一单的京粉页已确认是空壳（两次、相隔至少 10 分钟），而且它仍是已完成、没有运单号的订单。 */
    public boolean confirmed(ExpressItem order) {
        return applies(order) && marks.getLong(key(order), 0L) == CONFIRMED;
    }

    /**
     * 一次空壳：距上一次至少 10 分钟就确认，否则把这一次记成最近的空壳（第一次也是这样记）。非已完成订单从不记。
     */
    public void recordEmpty(ExpressItem order, long now) {
        if (!applies(order)) return;
        String key = key(order);
        synchronized (LOCK) {
            long last = marks.getLong(key, 0L);
            if (last == CONFIRMED) return;
            long next = last > 0L && now - last >= CONFIRMATION_SPACING_MS ? CONFIRMED : now;
            if (next != last) marks.edit().putLong(key, next).apply();
        }
    }

    /** 抓到带物流的东西（或这一单已不是已完成、没有运单号的订单）：这一单的次数和记号都清掉。 */
    public void forget(ExpressItem order) {
        if (order == null || ExpressSourcePolicy.normalizeWaybill(order.waybill).isEmpty()) return;
        String key = key(order);
        synchronized (LOCK) {
            if (marks.contains(key)) marks.edit().remove(key).apply();
        }
    }

    private static String key(ExpressItem order) {
        return ExpressOrderProjectionIdentity.orderHash(order.waybill);
    }
}
