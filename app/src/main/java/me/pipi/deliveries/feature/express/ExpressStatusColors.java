package me.pipi.deliveries.feature.express;

/**
 * 快递状态强调色，三端同一张表（用户定 2026-09-05：派送中与已签收不能同色）。
 * Pipi 同值在 ExpressNotificationVisuals，iOS 用系统色名 statusTint（红/橙/绿/青/蓝/黄/灰）。
 * 小组件的状态胶囊 / 状态词也只用这张表（2026-09-05 晚：用户指出列表已是青色而小组件仍是绿）。
 */
public final class ExpressStatusColors {
    public static final int DANGER = 0xFFD43D3D;
    public static final int WAITING_PICKUP = 0xFFE65B17;
    public static final int DELIVERY = 0xFF1A8A4A;
    public static final int COMPLETED = 0xFF0F9D8A;
    public static final int TRANSIT = 0xFF3275D6;
    public static final int ORDERED = 0xFFFBC02D;
    public static final int NEUTRAL = 0xFF757575;

    private ExpressStatusColors() {}
}
