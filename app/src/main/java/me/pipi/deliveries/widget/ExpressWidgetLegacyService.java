package me.pipi.deliveries.widget;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.network.ExpressAccountSource;

/** Android 10/11 collection adapter for the scrollable 4×2 widget. */
public final class ExpressWidgetLegacyService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        int appWidgetId = intent == null ? AppWidgetManager.INVALID_APPWIDGET_ID
                : intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,
                        AppWidgetManager.INVALID_APPWIDGET_ID);
        return new Factory(getApplicationContext(), appWidgetId);
    }

    private static final class Factory implements RemoteViewsFactory {
        private final Context context;
        private final int appWidgetId;
        private volatile List<ExpressItem> items = Collections.emptyList();
        private volatile ExpressWidgetProvider.RowSize rowSize;

        Factory(Context context, int appWidgetId) {
            this.context = context;
            this.appWidgetId = appWidgetId;
        }

        @Override public void onCreate() { reload(); }

        @Override public void onDataSetChanged() { reload(); }

        private void reload() {
            List<ExpressItem> refreshed = ExpressWidgetPresentation.first(
                    ExpressRepository.get(context).listVisible(
                            ExpressAccountSource.bindingSource(context)),
                    ExpressWidgetProvider.MAX_WIDE_ITEMS);
            rowSize = ExpressWidgetProvider.calculateRowSize(
                    context, AppWidgetManager.getInstance(context), appWidgetId);
            items = Collections.unmodifiableList(new ArrayList<>(refreshed));
        }

        @Override public void onDestroy() { items = Collections.emptyList(); }
        @Override public int getCount() { return items.size(); }

        @Override
        public RemoteViews getViewAt(int position) {
            List<ExpressItem> snapshot = items;
            if (position < 0 || position >= snapshot.size()) return null;
            return ExpressWidgetProvider.itemRow(context, snapshot.get(position), rowSize);
        }

        @Override public RemoteViews getLoadingView() { return null; }
        @Override public int getViewTypeCount() { return 1; }
        @Override public long getItemId(int position) {
            List<ExpressItem> snapshot = items;
            return position >= 0 && position < snapshot.size()
                    ? snapshot.get(position).rowId : position;
        }
        @Override public boolean hasStableIds() { return true; }
    }
}
