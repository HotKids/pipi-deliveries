package me.pipi.deliveries.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

import me.pipi.deliveries.feature.express.ExpressDetailActivity;
import me.pipi.deliveries.feature.express.ExpressListActivity;

import java.util.List;

import me.pipi.deliveries.R;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.network.ExpressAccountSource;

/** Original compact widget plus Pipi's scrollable three-row wide widget. */
public class ExpressWidgetProvider extends AppWidgetProvider {
    static final int MAX_WIDE_ITEMS = 30;
    private static final int[] COMPACT_ICONS = {
            R.id.widget_compact_logo1,
            R.id.widget_compact_logo2,
            R.id.widget_compact_logo3,
            R.id.widget_compact_logo4
    };

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        if (this instanceof Express4x2WidgetProvider) {
            updateWide(context, manager, ids,
                    visibleItems(context));
        } else {
            updateCompact(context, manager, ids,
                    visibleItems(context));
        }
    }

    @Override
    public void onAppWidgetOptionsChanged(
            Context context, AppWidgetManager manager, int id, Bundle options) {
        if (this instanceof Express4x2WidgetProvider) {
            updateWide(context, manager, new int[]{id},
                    visibleItems(context));
        } else {
            updateCompact(context, manager, new int[]{id},
                    visibleItems(context));
        }
    }

    private static void updateCompact(
            Context context, AppWidgetManager manager, int[] ids, List<ExpressItem> items) {
        List<ExpressItem> selected = ExpressWidgetPresentation.first(
                items, COMPACT_ICONS.length);
        ExpressWidgetPresentation.PriorityStatus priority =
                ExpressWidgetPresentation.priorityStatus(items);
        boolean empty = selected.isEmpty();
        for (int id : ids) {
            RemoteViews views = new RemoteViews(
                    context.getPackageName(), R.layout.express_widget_2x2);
            views.setViewVisibility(R.id.widget_compact_content,
                    empty ? View.GONE : View.VISIBLE);
            views.setViewVisibility(R.id.widget_compact_empty,
                    empty ? View.VISIBLE : View.GONE);
            if (empty) {
                int accent = ExpressWidgetPalette.emptyAccent(context);
                views.setInt(R.id.widget_compact_empty_gradient, "setColorFilter", accent);
                views.setInt(R.id.widget_compact_empty_box, "setColorFilter", accent);
            } else {
                int statusColor = StatusStyle.forSemantic(priority.semantic).foreground;
                views.setInt(R.id.widget_compact_brand_gradient, "setColorFilter",
                        ExpressWidgetPalette.accent(context, selected.get(0)));
                views.setTextColor(R.id.widget_priority_status, statusColor);
            }
            views.setTextViewText(R.id.widget_priority_status,
                    context.getString(ExpressWidgetPresentation.priorityLabel(priority.semantic))
                            + " " + priority.count);
            views.setTextViewText(R.id.widget_active_count,
                    context.getString(R.string.widget_active_packages,
                            ExpressWidgetPresentation.activeCount(items)));
            int overlapVisibility = selected.size() == COMPACT_ICONS.length
                    ? View.VISIBLE : View.GONE;
            views.setViewVisibility(R.id.widget_compact_overlap_1, overlapVisibility);
            views.setViewVisibility(R.id.widget_compact_overlap_2, overlapVisibility);
            for (int index = 0; index < COMPACT_ICONS.length; index++) {
                if (index < selected.size()) {
                    ExpressItem item = selected.get(index);
                    views.setViewVisibility(COMPACT_ICONS[index], View.VISIBLE);
                    views.setImageViewResource(COMPACT_ICONS[index],
                            item.displayIconResource());
                } else {
                    views.setViewVisibility(COMPACT_ICONS[index], View.GONE);
                }
            }
            views.setOnClickPendingIntent(R.id.widget_compact_root,
                    openList(context, 2100 + id));
            views.setOnClickPendingIntent(R.id.widget_compact_search,
                    openSearch(context, 3100 + id));
            views.setOnClickPendingIntent(R.id.widget_compact_empty,
                    openSearch(context, 3200 + id));
            views.setOnClickPendingIntent(R.id.widget_compact_empty_search,
                    openSearch(context, 3300 + id));
            manager.updateAppWidget(id, views);
        }
    }

    private static void updateWide(
            Context context, AppWidgetManager manager, int[] ids, List<ExpressItem> items) {
        List<ExpressItem> sorted = ExpressWidgetPresentation.first(items, MAX_WIDE_ITEMS);
        boolean empty = sorted.isEmpty();
        for (int id : ids) {
            RemoteViews views = new RemoteViews(
                    context.getPackageName(), R.layout.express_widget_4x2);
            views.setTextViewText(R.id.widget_express_title,
                    context.getString(R.string.widget_express_count,
                            items.size()));
            views.setViewVisibility(R.id.widget_express_list,
                    empty ? View.GONE : View.VISIBLE);
            views.setViewVisibility(R.id.widget_express_content,
                    empty ? View.GONE : View.VISIBLE);
            views.setViewVisibility(R.id.widget_express_empty,
                    empty ? View.VISIBLE : View.GONE);
            if (empty) {
                int accent = ExpressWidgetPalette.emptyAccent(context);
                views.setInt(R.id.widget_express_empty_gradient, "setColorFilter", accent);
                views.setInt(R.id.widget_express_empty_box, "setColorFilter", accent);
            } else {
                views.setInt(R.id.widget_express_brand_gradient, "setColorFilter",
                        ExpressWidgetPalette.accent(context, sorted.get(0)));
            }

            long generation = packageGeneration(context);
            if (Build.VERSION.SDK_INT >= 31) {
                ExpressWidgetApi31.setRemoteAdapter(
                        views, context, sorted, calculateRowSize(context, manager, id));
            } else {
                Intent adapter = new Intent(context, ExpressWidgetLegacyService.class)
                        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                        .setData(android.net.Uri.parse("deliveries://express-widget/" + id
                                + "/adapter/" + generation));
                views.setRemoteAdapter(R.id.widget_express_list, adapter);
            }

            Intent openItem = new Intent(context, ExpressDetailActivity.class)
                    .setAction("me.pipi.deliveries.widget.OPEN_EXPRESS")
                    .setData(android.net.Uri.parse("deliveries://express-widget/" + id
                            + "/open/" + generation))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int mutable = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
            PendingIntent itemTemplate = PendingIntent.getActivity(context, 4100 + id, openItem,
                    PendingIntent.FLAG_UPDATE_CURRENT | mutable);
            views.setPendingIntentTemplate(R.id.widget_express_list, itemTemplate);

            views.setOnClickPendingIntent(R.id.widget_express_header,
                    openList(context, 5100 + id));
            views.setOnClickPendingIntent(R.id.widget_express_empty,
                    openSearch(context, 6100 + id));
            views.setOnClickPendingIntent(R.id.widget_express_empty_search,
                    openSearch(context, 6200 + id));
            views.setOnClickPendingIntent(R.id.widget_express_search,
                    openSearch(context, 7100 + id));
            // Collection rows own their tap target; the card must not consume the gesture.
            views.setOnClickPendingIntent(R.id.widget_express_root, null);
            manager.updateAppWidget(id, views);
            if (Build.VERSION.SDK_INT < 31) {
                manager.notifyAppWidgetViewDataChanged(id, R.id.widget_express_list);
            }
        }
    }

    static RemoteViews itemRow(
            Context context, ExpressItem item, RowSize rowSize) {
        RemoteViews views = new RemoteViews(
                context.getPackageName(), R.layout.express_widget_item);
        if (Build.VERSION.SDK_INT >= 31) {
            ExpressWidgetApi31.applyRowSize(views, rowSize);
        }
        views.setImageViewResource(R.id.widget_express_item_logo,
                item.displayIconResource());
        views.setTextViewText(R.id.widget_express_item_company,
                ExpressWidgetPresentation.rowIdentity(item));
        views.setTextViewText(R.id.widget_express_item_status,
                item.displayStatus());
        StatusStyle statusStyle = StatusStyle.forSemantic(item.semantic);
        views.setInt(R.id.widget_express_item_status,
                "setBackgroundResource", statusStyle.background);
        views.setTextColor(R.id.widget_express_item_status, statusStyle.foreground);
        views.setTextViewText(R.id.widget_express_item_detail, item.latestDetail);
        views.setViewVisibility(R.id.widget_express_item_detail,
                item.latestDetail.isEmpty() ? View.GONE : View.VISIBLE);
        Intent fillIn = new Intent()
                .putExtra(ExpressDetailActivity.EXTRA_ROW_ID, item.rowId);
        views.setOnClickFillInIntent(R.id.widget_express_item, fillIn);
        return views;
    }

    static RowSize calculateRowSize(
            Context context, AppWidgetManager manager, int appWidgetId) {
        Bundle options = manager.getAppWidgetOptions(appWidgetId);
        int min = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 180);
        int max = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, min);
        float hostHeightDp = context.getResources().getConfiguration().orientation
                == Configuration.ORIENTATION_LANDSCAPE ? min : max;
        float density = context.getResources().getDisplayMetrics().density;
        int viewportPx = Math.max(dp(108f, density),
                (int) Math.floor((hostHeightDp - 57f) * density));
        int heightPx = Math.max(dp(42f, density), (viewportPx + 2) / 3);
        int paddingPx = Math.max(0, (heightPx - dp(42f, density)) / 2);
        return new RowSize(heightPx, paddingPx);
    }

    static int dp(float value, float density) {
        return Math.round(value * (density > 0f ? density : 1f));
    }

    private static PendingIntent openList(Context context, int requestCode) {
        Intent intent = new Intent(context, ExpressListActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent openSearch(Context context, int requestCode) {
        Intent intent = new Intent(context, ExpressListActivity.class)
                .putExtra(ExpressListActivity.EXTRA_FOCUS_QUERY, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static long packageGeneration(Context context) {
        try {
            return context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0).lastUpdateTime;
        } catch (Throwable ignored) {
            return 0L;
        }
    }

    public static void refreshAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] compactIds = manager.getAppWidgetIds(
                new ComponentName(context, Express2x2WidgetProvider.class));
        int[] wideIds = manager.getAppWidgetIds(
                new ComponentName(context, Express4x2WidgetProvider.class));
        if (compactIds.length == 0 && wideIds.length == 0) return;
        List<ExpressItem> items = visibleItems(context);
        if (compactIds.length > 0) updateCompact(context, manager, compactIds, items);
        if (wideIds.length > 0) updateWide(context, manager, wideIds, items);
    }

    private static List<ExpressItem> visibleItems(Context context) {
        return ExpressRepository.get(context).listVisible(
                ExpressAccountSource.bindingSource(context));
    }

    static final class RowSize {
        final int heightPx;
        final int paddingPx;

        RowSize(int heightPx, int paddingPx) {
            this.heightPx = heightPx;
            this.paddingPx = paddingPx;
        }
    }

    private static final class StatusStyle {
        final int background;
        final int foreground;

        StatusStyle(int background, int foreground) {
            this.background = background;
            this.foreground = foreground;
        }

        static StatusStyle forSemantic(
                me.pipi.deliveries.model.StatusSemantic semantic) {
            switch (semantic) {
                case DELIVERY:
                case WAITING_PICKUP:
                case COMPLETED:
                    return new StatusStyle(R.drawable.widget_express_status_green_bg,
                            0xff05c575);
                case PICKED:
                case SHIPPED:
                case ORDERED:
                case TRANSIT:
                case UNKNOWN:
                    return new StatusStyle(R.drawable.widget_express_status_blue_bg,
                            0xff0d84ff);
                case DANGER:
                    return new StatusStyle(R.drawable.widget_express_status_orange_bg,
                            0xffff5c5c);
                case CANCELLED:
                    return new StatusStyle(R.drawable.widget_express_status_gray_bg,
                            0xff8c93b0);
                default:
                    return new StatusStyle(R.drawable.widget_express_status_blue_bg,
                            0xff0d84ff);
            }
        }
    }
}
