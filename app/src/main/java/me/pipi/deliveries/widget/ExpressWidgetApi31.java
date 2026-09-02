package me.pipi.deliveries.widget;

import android.util.TypedValue;
import android.widget.RemoteViews;

import androidx.annotation.RequiresApi;

import me.pipi.deliveries.R;

/** API 31 RemoteViews layout helpers isolated from Android 10/11 class verification. */
@RequiresApi(31)
final class ExpressWidgetApi31 {
    private ExpressWidgetApi31() {}

    static void applyWideRowHeight(RemoteViews views, int rowId, int heightPx) {
        views.setViewLayoutHeight(rowId, heightPx, TypedValue.COMPLEX_UNIT_PX);
    }

    static void applyCompactHeaderSize(RemoteViews views, float logoSizeDp) {
        views.setViewLayoutWidth(R.id.widget_compact_courier_logo,
                logoSizeDp, TypedValue.COMPLEX_UNIT_DIP);
        views.setViewLayoutHeight(R.id.widget_compact_courier_logo,
                logoSizeDp, TypedValue.COMPLEX_UNIT_DIP);
        views.setViewLayoutHeight(R.id.widget_compact_identity,
                logoSizeDp, TypedValue.COMPLEX_UNIT_DIP);
    }

    static void applyCompactPillIconSize(RemoteViews views, float iconSizeDp) {
        views.setViewLayoutWidth(R.id.widget_compact_all_icon,
                iconSizeDp, TypedValue.COMPLEX_UNIT_DIP);
        views.setViewLayoutHeight(R.id.widget_compact_all_icon,
                iconSizeDp, TypedValue.COMPLEX_UNIT_DIP);
    }
}
