package me.pipi.deliveries.widget;

import android.content.Context;
import android.util.TypedValue;
import android.widget.RemoteViews;

import androidx.annotation.RequiresApi;

import java.util.List;

import me.pipi.deliveries.R;
import me.pipi.deliveries.model.ExpressItem;

/** API 31 collection helpers isolated so Android 10/11 never verify these platform classes. */
@RequiresApi(31)
final class ExpressWidgetApi31 {
    private ExpressWidgetApi31() {}

    static void setRemoteAdapter(
            RemoteViews views, Context context, List<ExpressItem> items,
            ExpressWidgetProvider.RowSize rowSize) {
        RemoteViews.RemoteCollectionItems.Builder rows =
                new RemoteViews.RemoteCollectionItems.Builder()
                        .setHasStableIds(true)
                        .setViewTypeCount(1);
        for (ExpressItem item : items) {
            rows.addItem(item.rowId, ExpressWidgetProvider.itemRow(context, item, rowSize));
        }
        views.setRemoteAdapter(R.id.widget_express_list, rows.build());
    }

    static void applyRowSize(
            RemoteViews views, ExpressWidgetProvider.RowSize rowSize) {
        views.setViewLayoutHeight(
                R.id.widget_express_item, rowSize.heightPx, TypedValue.COMPLEX_UNIT_PX);
        views.setViewPadding(
                R.id.widget_express_item, 0, rowSize.paddingPx, 0, rowSize.paddingPx);
    }
}
