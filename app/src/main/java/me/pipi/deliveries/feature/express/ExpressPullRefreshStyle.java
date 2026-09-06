package me.pipi.deliveries.feature.express;

import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.google.android.material.color.MaterialColors;

/**
 * 下拉刷新圈的配色跟 Pipi 首页 Flutter `RefreshIndicator` 一致：圈底是 surface（Flutter 的
 * canvasColor），箭头/进度是 primary（用户指出 2026-09-06：原生样式的白圈没适配夜间模式）。
 * 几何和动画仍是 SwipeRefreshLayout 默认的（用户定 2026-09-05）。
 */
final class ExpressPullRefreshStyle {
    private ExpressPullRefreshStyle() {}

    static void apply(SwipeRefreshLayout view) {
        if (view == null) return;
        view.setProgressBackgroundColorSchemeColor(MaterialColors.getColor(
                view, com.google.android.material.R.attr.colorSurface));
        view.setColorSchemeColors(MaterialColors.getColor(
                view, androidx.appcompat.R.attr.colorPrimary));
    }
}
