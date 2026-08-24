package me.pipi.deliveries.model;

import java.util.Locale;

/** Provider adapter that projects source-specific status evidence into one shared semantic. */
public final class ExpressStatusNormalizer {
    private ExpressStatusNormalizer() {}

    public static StatusSemantic normalize(
            String source, String statusCode, String statusDescription, String latestDetail) {
        StatusSemantic structured = StatusSemantic.fromStored(statusCode, statusDescription);
        String owner = clean(source).toUpperCase(Locale.ROOT);
        if (!"INTERFACE5".equals(owner)) return structured;
        if (structured == StatusSemantic.COMPLETED
                || structured == StatusSemantic.CANCELLED
                || structured == StatusSemantic.DANGER
                || structured == StatusSemantic.WAITING_PICKUP) {
            return structured;
        }
        return isConfirmedPickupEvent(latestDetail)
                ? StatusSemantic.WAITING_PICKUP : structured;
    }

    /** Provider/service errors are never valid logistics events or user-facing timeline text. */
    public static boolean isProviderErrorDetail(String detail) {
        String value = clean(detail).replaceAll("\\s+", "");
        String lower = value.toLowerCase(Locale.ROOT);
        return lower.startsWith("noresult")
                || lower.startsWith("mismatchingcode")
                || value.startsWith("验证码错误")
                || value.equals("暂无状态")
                || value.equals("暂无物流信息")
                || value.equals("暂无物流动态")
                || value.equals("快递状态已更新，点击查看>>");
    }

    /** A list headline must be a real logistics event, never a duplicate of the state title. */
    public static boolean isHeadlinePlaceholder(String detail, StatusSemantic semantic) {
        String value = clean(detail).replaceAll("\\s+", "");
        if (value.isEmpty() || isProviderErrorDetail(value)) return true;
        if (semantic != null && value.equals(semantic.label.replaceAll("\\s+", ""))) return true;
        return StatusSemantic.fromStored("", value) != StatusSemantic.UNKNOWN;
    }

    /**
     * Last-resort state recovery for account orders whose list record exposes only an order id.
     * This is deliberately scoped to that source; ordinary carrier prose never owns app state.
     */
    public static StatusSemantic inferAccountOrderStatus(
            String latestDetail, String tracksJson) {
        for (ExpressTimeline.Track track : ExpressTimeline.parse(
                tracksJson, "", latestDetail)) {
            StatusSemantic inferred = inferAccountOrderEvent(track.detail);
            if (inferred != StatusSemantic.UNKNOWN) return inferred;
        }
        return inferAccountOrderEvent(latestDetail);
    }

    private static StatusSemantic inferAccountOrderEvent(String detail) {
        String value = clean(detail).replaceAll("\\s+", "");
        if (value.isEmpty()) return StatusSemantic.UNKNOWN;
        if (containsAny(value, "订单已取消", "已取消", "订单关闭")) {
            return StatusSemantic.CANCELLED;
        }
        if (containsAny(value, "已签收", "已妥投")) {
            return StatusSemantic.COMPLETED;
        }
        if (containsAny(value, "待取件", "等待取件", "取件码")
                || (containsAny(value, "快递柜", "丰巢", "驿站", "自提点")
                && containsAny(value, "已放入", "已存放", "已暂存", "已送达"))) {
            return StatusSemantic.WAITING_PICKUP;
        }
        if (containsAny(value, "正在派送", "派送中", "正在配送", "配送中", "即将送达")) {
            return StatusSemantic.DELIVERY;
        }
        if (containsAny(value, "已揽收", "揽收完成", "快递员已取件", "承运商已收件")) {
            return StatusSemantic.PICKED;
        }
        if (containsAny(value, "运输中", "已到达", "已发往", "转运", "分拨",
                "已出库", "离开仓库", "运输途中")) {
            return StatusSemantic.TRANSIT;
        }
        if (containsAny(value, "已发货", "商家已发货")) return StatusSemantic.SHIPPED;
        if (containsAny(value, "已下单", "订单已提交", "订单已完成", "配送完成",
                "等待出库", "正在出库", "正在打包", "拣货")) {
            return StatusSemantic.ORDERED;
        }
        return StatusSemantic.UNKNOWN;
    }

    /**
     * Interface5 occasionally keeps TRANSPORT after the carrier has deposited a parcel. Only explicit
     * deposit-and-collection wording is accepted; generic arrival or delivery prose fails closed.
     */
    static boolean isConfirmedPickupEvent(String detail) {
        String value = clean(detail).replaceAll("\\s+", "");
        if (value.isEmpty() || value.contains("已签收")) return false;
        if (value.contains("待取件") || value.contains("等待取件")) return true;
        boolean pickupPlace = containsAny(value,
                "代收点", "丰巢", "快递柜", "智能柜", "驿站", "自提点", "服务站");
        boolean deposited = containsAny(value,
                "已暂存", "已入柜", "已存放", "已放入", "已投递至", "已送至");
        boolean collect = containsAny(value,
                "请及时领取", "请领取", "请取件", "凭取件码", "取件码");
        return pickupPlace && deposited && collect;
    }

    private static boolean containsAny(String value, String... candidates) {
        for (String candidate : candidates) if (value.contains(candidate)) return true;
        return false;
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
