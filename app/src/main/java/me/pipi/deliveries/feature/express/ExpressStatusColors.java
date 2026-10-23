package me.pipi.deliveries.feature.express;

import androidx.core.graphics.ColorUtils;

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

    public static int textOn(int accent, int... backgrounds) {
        int target = minimumContrast(0xff000000, backgrounds) >= minimumContrast(0xffffffff, backgrounds)
                ? 0xff000000 : 0xffffffff;
        for (int step = 0; step <= 100; step++) {
            int candidate = ColorUtils.setAlphaComponent(ColorUtils.blendARGB(accent, target, step / 100f), 255);
            if (minimumContrast(candidate, backgrounds) >= 4.5) return candidate;
        }
        return target;
    }

    private static double minimumContrast(int color, int[] backgrounds) {
        double minimum = Double.POSITIVE_INFINITY;
        for (int background : backgrounds) {
            minimum = Math.min(minimum, ColorUtils.calculateContrast(color, background));
        }
        return minimum;
    }

    private ExpressStatusColors() {}
}
