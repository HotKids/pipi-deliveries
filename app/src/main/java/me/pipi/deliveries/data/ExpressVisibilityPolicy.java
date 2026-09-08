package me.pipi.deliveries.data;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

/** Time-based visibility rules shared by the app list and its local detail cache. */
final class ExpressVisibilityPolicy {
    static final long SIGNED_VISIBLE_MS = 7L * 24L * 60L * 60L * 1000L;
    static final long CANCELLED_VISIBLE_MS = 4L * 60L * 60L * 1000L;

    private ExpressVisibilityPolicy() {}

    static boolean isExpired(ExpressItem item, long now) {
        if (item == null) return false;
        StatusSemantic lifecycleSemantic = lifecycleSemantic(item);
        if (lifecycleSemantic == StatusSemantic.COMPLETED) {
            long signedAt = ExpressLifecycleTimes.signedAt(item, null, now);
            return signedAt > 0L && now - signedAt >= SIGNED_VISIBLE_MS;
        }
        if (lifecycleSemantic == StatusSemantic.CANCELLED) {
            long cancelledAt = ExpressLifecycleTimes.eventAt(item, now);
            return cancelledAt > 0L && now - cancelledAt >= CANCELLED_VISIBLE_MS;
        }
        return false;
    }

    /**
     * 上游回包（列表摘要或按件详情）本身是否已经过了留存窗口：来源状态已签收且签收时间超过
     * 7 天、或已取消超过 4 小时。用在自动件首次入库前——三端同口径：Pipi 在 ingress 直接拒收
     * （deleteExpiredCompletionData → rejected），iOS 存进去也会被 pruneShipments 立刻丢掉且
     * 新件从不通知；Lite 之前先落成「已下单」摘要、再被按件详情翻成「已签收」，每小时清理一次
     * 就重新导入并重新通知一次（2026-09-05 17:55 Fold7：0058/7308/6800 三票 8 月底签收件）。
     */
    static boolean isExpiredResult(ExpressQueryResult result, long now) {
        if (result == null) return false;
        if (result.semantic == StatusSemantic.COMPLETED) {
            long signedAt = ExpressLifecycleTimes.signedAt(null, result, now);
            return signedAt > 0L && now - signedAt >= SIGNED_VISIBLE_MS;
        }
        if (result.semantic == StatusSemantic.CANCELLED) {
            long cancelledAt = Math.max(
                    result.statusEventTime,
                    ExpressSourcePolicy.parseEventTime(result.latestTime));
            return cancelledAt > 0L && cancelledAt <= now
                    && now - cancelledAt >= CANCELLED_VISIBLE_MS;
        }
        return false;
    }

    private static StatusSemantic lifecycleSemantic(ExpressItem item) {
        // Account-order status is not carrier evidence. Once a real waybill timeline is projected,
        // item.semantic already contains that carrier package and may start retention normally.
        return item.semantic;
    }
}
