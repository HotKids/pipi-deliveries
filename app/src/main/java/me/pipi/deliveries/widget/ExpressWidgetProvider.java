package me.pipi.deliveries.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;

import me.pipi.deliveries.feature.express.ExpressDetailActivity;
import me.pipi.deliveries.feature.express.ExpressListActivity;

import java.util.List;

import me.pipi.deliveries.R;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.network.ExpressAccountSource;

/** Original compact widget plus Pipi's three-row wide widget. */
public class ExpressWidgetProvider extends AppWidgetProvider {
    static final int MAX_WIDE_ITEMS = ExpressWidgetRowPolicy.WIDE_ROW_LIMIT;
    private static final int[] WIDE_ROW_IDS = {
            R.id.widget_express_row1,
            R.id.widget_express_row2,
            R.id.widget_express_row3
    };
    private static final int[] WIDE_LOGO_IDS = {
            R.id.widget_express_logo1,
            R.id.widget_express_logo2,
            R.id.widget_express_logo3
    };
    private static final int[] WIDE_COMPANY_IDS = {
            R.id.widget_express_company1,
            R.id.widget_express_company2,
            R.id.widget_express_company3
    };
    private static final int[] WIDE_STATUS_IDS = {
            R.id.widget_express_status1,
            R.id.widget_express_status2,
            R.id.widget_express_status3
    };
    private static final int[] WIDE_DETAIL_IDS = {
            R.id.widget_express_detail1,
            R.id.widget_express_detail2,
            R.id.widget_express_detail3
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
        List<ExpressItem> selected = ExpressWidgetPresentation.first(items, 1);
        boolean empty = selected.isEmpty();
        for (int id : ids) {
            RemoteViews views = new RemoteViews(
                    context.getPackageName(), R.layout.express_widget_2x2);
            Bundle options = manager.getAppWidgetOptions(id);
            float widthDp = WidgetHostMetrics.currentWidthDp(context, options);
            float heightDp = WidgetHostMetrics.currentHeightDp(context, options);
            float hostRatio = options.getFloat("hsResizeRatio", 1f);
            if (hostRatio < 0.5f || hostRatio > 1.5f) hostRatio = 1f;
            ExpressWidgetLayout.Compact layout =
                    ExpressWidgetLayout.compact(
                            widthDp * hostRatio, heightDp * hostRatio);
            applyCompactLayout(context, views, layout);
            views.setViewVisibility(R.id.widget_compact_content,
                    empty ? View.GONE : View.VISIBLE);
            views.setViewVisibility(R.id.widget_compact_empty,
                    empty ? View.VISIBLE : View.GONE);
            int accent;
            if (empty) {
                accent = ExpressWidgetPalette.emptyAccent(context);
                views.setImageViewResource(R.id.widget_compact_brand_gradient,
                        R.drawable.widget_express_empty_gradient_mask);
            } else {
                ExpressItem item = selected.get(0);
                accent = ExpressWidgetPalette.accent(context, item);
                views.setImageViewResource(R.id.widget_compact_brand_gradient,
                        R.drawable.widget_express_brand_gradient_mask);
                views.setTextViewText(R.id.widget_priority_status,
                        context.getString(ExpressWidgetPresentation.priorityLabel(item.semantic)));
                views.setTextColor(R.id.widget_priority_status,
                        StatusStyle.forSemantic(item.semantic).foreground);
                views.setImageViewResource(R.id.widget_compact_courier_logo,
                        item.displayIconResource());
                views.setTextViewText(R.id.widget_compact_company,
                        item.companyName);
                views.setTextViewText(R.id.widget_compact_detail,
                        item.latestDetail.isEmpty()
                                ? context.getString(R.string.widget_no_logistics_detail)
                                : item.latestDetail);
                views.setTextViewText(R.id.widget_compact_all_text,
                        context.getString(R.string.widget_all_deliveries, items.size()));
                views.setOnClickPendingIntent(R.id.widget_compact_shipment,
                        openDetail(context, item, 2100 + id));
                views.setOnClickPendingIntent(R.id.widget_compact_all,
                        openList(context, 2200 + id));
            }
            views.setInt(R.id.widget_compact_brand_gradient, "setColorFilter", accent);
            views.setInt(R.id.widget_compact_empty_search, "setColorFilter", accent);
            views.setOnClickPendingIntent(R.id.widget_compact_empty,
                    openSearch(context, 3200 + id));
            views.setOnClickPendingIntent(R.id.widget_compact_empty_search,
                    openSearch(context, 3300 + id));
            views.setOnClickPendingIntent(R.id.widget_compact_root, null);
            manager.updateAppWidget(id, views);
        }
    }

    private static void updateWide(
            Context context, AppWidgetManager manager, int[] ids, List<ExpressItem> items) {
        List<ExpressItem> displayed = items.size() <= MAX_WIDE_ITEMS
                ? items : items.subList(0, MAX_WIDE_ITEMS);
        boolean empty = displayed.isEmpty();
        for (int id : ids) {
            RemoteViews views = new RemoteViews(
                    context.getPackageName(), R.layout.express_widget_4x2);
            Bundle options = manager.getAppWidgetOptions(id);
            float hostWidthDp = WidgetHostMetrics.currentWidthDp(context, options);
            float hostHeightDp = WidgetHostMetrics.currentHeightDp(context, options);
            WidgetTypographyProfile typography =
                    CardSizeProfile.resolve(options, hostWidthDp).typography;
            float density = context.getResources().getDisplayMetrics().density;
            ExpressWidgetRowPolicy.RowLayout rowLayout = ExpressWidgetRowPolicy.calculate(
                    displayed.size(), hostHeightDp, density,
                    typography.lineBox(
                            ExpressWidgetRowPolicy.DEFAULT_ROW_CONTENT_HEIGHT_DP));
            views.setTextViewText(R.id.widget_express_title,
                    context.getString(R.string.widget_express_count,
                            ExpressWidgetPresentation.activeCount(items)));
            views.setTextViewTextSize(R.id.widget_express_title,
                    TypedValue.COMPLEX_UNIT_SP,
                    typography.textSize(WidgetTypographyProfile.Token.PRIMARY_TITLE));
            views.setTextViewTextSize(R.id.widget_express_empty_text,
                    TypedValue.COMPLEX_UNIT_SP,
                    typography.textSize(WidgetTypographyProfile.Token.BODY));
            views.setViewVisibility(R.id.widget_express_empty,
                    empty ? View.VISIBLE : View.GONE);
            views.setViewVisibility(R.id.widget_express_brand_gradient,
                    empty ? View.GONE : View.VISIBLE);
            if (empty) {
                for (int index = 0; index < WIDE_ROW_IDS.length; index++) {
                    hideWideRow(views, index);
                }
            } else {
                int accent = ExpressWidgetPalette.accent(context, displayed.get(0));
                views.setInt(R.id.widget_express_brand_gradient, "setColorFilter", accent);
                views.setInt(R.id.widget_express_search, "setColorFilter", accent);
                for (int index = 0; index < WIDE_ROW_IDS.length; index++) {
                    bindWideRow(context, views, displayed, index, id * 10 + index,
                            rowLayout, typography);
                }
            }

            views.setOnClickPendingIntent(R.id.widget_express_header,
                    openList(context, 5100 + id));
            views.setOnClickPendingIntent(R.id.widget_express_empty,
                    openList(context, 6100 + id));
            views.setOnClickPendingIntent(R.id.widget_express_search,
                    openSearch(context, 7100 + id));
            views.setOnClickPendingIntent(R.id.widget_express_root, null);
            manager.updateAppWidget(id, views);
        }
    }

    private static void bindWideRow(
            Context context, RemoteViews views, List<ExpressItem> items, int index,
            int requestCode, ExpressWidgetRowPolicy.RowLayout rowLayout,
            WidgetTypographyProfile typography) {
        if (index >= rowLayout.visibleRows) {
            hideWideRow(views, index);
            return;
        }
        ExpressItem item = items.get(index);
        int root = WIDE_ROW_IDS[index];
        views.setViewVisibility(root, View.VISIBLE);
        views.setViewPadding(root, 0, rowLayout.verticalPaddingPx,
                0, rowLayout.verticalPaddingPx);
        if (Build.VERSION.SDK_INT >= 31) {
            ExpressWidgetApi31.applyWideRowHeight(views, root, rowLayout.rowHeightPx);
        }
        views.setImageViewResource(WIDE_LOGO_IDS[index], item.displayIconResource());
        views.setTextViewTextSize(WIDE_COMPANY_IDS[index], TypedValue.COMPLEX_UNIT_SP,
                typography.textSize(WidgetTypographyProfile.Token.PRIMARY_TITLE));
        views.setTextViewText(WIDE_COMPANY_IDS[index],
                ExpressWidgetPresentation.rowIdentity(item));
        views.setTextViewText(WIDE_STATUS_IDS[index],
                context.getString(ExpressWidgetPresentation.priorityLabel(item.semantic)));
        StatusStyle statusStyle = StatusStyle.forSemantic(item.semantic);
        views.setInt(WIDE_STATUS_IDS[index],
                "setBackgroundResource", statusStyle.background);
        views.setTextColor(WIDE_STATUS_IDS[index], statusStyle.foreground);
        views.setTextViewTextSize(WIDE_DETAIL_IDS[index], TypedValue.COMPLEX_UNIT_SP,
                typography.textSize(WidgetTypographyProfile.Token.SUPPORT));
        views.setTextViewText(WIDE_DETAIL_IDS[index], item.latestDetail);
        views.setViewVisibility(WIDE_DETAIL_IDS[index],
                item.latestDetail.isEmpty() ? View.GONE : View.VISIBLE);
        views.setOnClickPendingIntent(root, openDetail(context, item, requestCode));
    }

    private static void hideWideRow(RemoteViews views, int index) {
        views.setImageViewResource(WIDE_LOGO_IDS[index], R.drawable.ic_local_shipping);
        views.setTextViewText(WIDE_COMPANY_IDS[index], "");
        views.setTextViewText(WIDE_STATUS_IDS[index], "");
        views.setTextViewText(WIDE_DETAIL_IDS[index], "");
        views.setViewVisibility(WIDE_DETAIL_IDS[index], View.GONE);
        views.setViewVisibility(WIDE_ROW_IDS[index], View.GONE);
    }

    private static void applyCompactLayout(
            Context context, RemoteViews views, ExpressWidgetLayout.Compact layout) {
        float density = context.getResources().getDisplayMetrics().density;
        int paddingPx = Math.round(layout.paddingDp * density);
        int pillHorizontalPaddingPx = Math.round(
                layout.pillHorizontalPaddingDp * density);
        int logoHorizontalInsetPx = Math.round(
                layout.logoHorizontalInsetDp * density);
        int logoVerticalInsetPx = Math.round(layout.logoVerticalInsetDp * density);
        views.setViewPadding(R.id.widget_compact_content,
                paddingPx, paddingPx, paddingPx, paddingPx);
        views.setViewPadding(R.id.widget_compact_empty,
                paddingPx, paddingPx, paddingPx, paddingPx);
        views.setViewPadding(R.id.widget_compact_all,
                pillHorizontalPaddingPx, 0, pillHorizontalPaddingPx, 0);
        if (Build.VERSION.SDK_INT >= 31) {
            ExpressWidgetApi31.applyCompactLogoSize(views, layout.courierLogoSizeDp);
            views.setViewPadding(R.id.widget_compact_courier_logo, 0, 0, 0, 0);
        } else {
            views.setViewPadding(R.id.widget_compact_courier_logo,
                    logoHorizontalInsetPx, logoVerticalInsetPx,
                    logoHorizontalInsetPx, logoVerticalInsetPx);
        }
        views.setTextViewTextSize(R.id.widget_priority_status,
                TypedValue.COMPLEX_UNIT_SP, layout.statusTextSizeSp);
        views.setTextViewTextSize(R.id.widget_compact_company,
                TypedValue.COMPLEX_UNIT_SP, layout.companyTextSizeSp);
        views.setTextViewTextSize(R.id.widget_compact_detail,
                TypedValue.COMPLEX_UNIT_SP, layout.detailTextSizeSp);
        views.setInt(R.id.widget_compact_detail,
                "setMaxLines", layout.detailLineLimit);
    }

    private static PendingIntent openList(Context context, int requestCode) {
        Intent intent = new Intent(context, ExpressListActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent openDetail(
            Context context, ExpressItem item, int requestCode) {
        Intent intent = new Intent(context, ExpressDetailActivity.class)
                .putExtra(ExpressDetailActivity.EXTRA_ROW_ID, item.rowId)
                .setData(android.net.Uri.parse(
                        "deliveries://express-widget/compact/" + item.rowId))
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
