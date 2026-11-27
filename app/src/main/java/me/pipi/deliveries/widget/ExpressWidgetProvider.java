package me.pipi.deliveries.widget;

import me.pipi.deliveries.model.ExpressTimeline;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.text.TextPaint;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.RemoteViews;

import me.pipi.deliveries.feature.express.ExpressDetailActivity;
import me.pipi.deliveries.feature.express.ExpressListActivity;

import java.util.List;

import me.pipi.deliveries.R;
import me.pipi.deliveries.background.ExpressScheduler;
import me.pipi.deliveries.feature.express.ExpressStatusColors;
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
    private static final int[] WIDE_CONTENT_IDS = {
            R.id.widget_express_row_content1,
            R.id.widget_express_row_content2,
            R.id.widget_express_row_content3
    };
    private static final int[] WIDE_LOGO_FRAME_IDS = {
            R.id.widget_express_logo_frame1,
            R.id.widget_express_logo_frame2,
            R.id.widget_express_logo_frame3
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
    /** Each 4×2 row's small gray 寄 tag after the waybill tail (owner 2026-11-21). */
    private static final int[] WIDE_SENDER_IDS = {
            R.id.widget_express_sender1,
            R.id.widget_express_sender2,
            R.id.widget_express_sender3
    };
    private static final int[] WIDE_DETAIL_IDS = {
            R.id.widget_express_detail1,
            R.id.widget_express_detail2,
            R.id.widget_express_detail3
    };

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        updateAsync(context);
    }

    @Override
    public void onAppWidgetOptionsChanged(
            Context context, AppWidgetManager manager, int id, Bundle options) {
        updateAsync(context);
    }

    private void updateAsync(Context context) {
        PendingResult pending = goAsync();
        ExpressScheduler.handoffWidgetRefresh(context, () -> {
            if (pending != null) pending.finish();
        });
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
            views.setViewVisibility(R.id.widget_compact_empty_search_frame,
                    empty ? View.VISIBLE : View.GONE);
            int accent;
            if (empty) {
                accent = ExpressWidgetPalette.emptyAccent(context);
                views.setImageViewResource(R.id.widget_compact_brand_gradient,
                        R.drawable.widget_express_empty_gradient_mask);
                views.setViewVisibility(R.id.widget_compact_sender, View.GONE);
            } else {
                ExpressItem item = selected.get(0);
                accent = ExpressWidgetPalette.accent(context, item);
                views.setImageViewResource(R.id.widget_compact_brand_gradient,
                        R.drawable.widget_express_brand_gradient_mask);
                String status = ExpressWidgetPresentation.statusText(item);
                views.setTextViewText(R.id.widget_priority_status, status);
                // Owner 2026-11-21 ("Lite 也加寄标签"): an outgoing parcel's gray 寄 tag follows the
                // status word, which steps down only as far as the tag needs (Pipi's 2×2 rule).
                views.setViewVisibility(R.id.widget_compact_sender,
                        item.sender ? View.VISIBLE : View.GONE);
                views.setTextViewTextSize(R.id.widget_priority_status, TypedValue.COMPLEX_UNIT_SP,
                        compactStatusTextSp(context, status, item.sender,
                                widthDp * hostRatio, layout));
                applyStatusTextColor(context, views, R.id.widget_priority_status, item, accent, false);
                views.setImageViewResource(R.id.widget_compact_courier_logo,
                        item.displayIconResource());
                views.setTextViewText(R.id.widget_compact_company,
                        ExpressWidgetPresentation.rowIdentity(item));
                String detail = item.latestDetail.isEmpty()
                        ? context.getString(R.string.widget_no_logistics_detail)
                        : ExpressTimeline.displayHeadline(item);
                views.setTextViewText(R.id.widget_compact_detail, detail);
                // 只有一行时整行居中，两行及以上仍然左对齐——与 Pipi compact 同一条规则
                // （Pipi ExpressWidgetProvider.scaleCompact；用户定 2026-09-06）。
                boolean singleLineDetail = fitsCompactSingleLine(
                        context, detail, widthDp * hostRatio, layout);
                views.setInt(R.id.widget_compact_detail, "setMaxLines",
                        singleLineDetail ? 1 : layout.detailLineLimit);
                views.setInt(R.id.widget_compact_detail, "setGravity",
                        singleLineDetail ? Gravity.CENTER
                                : Gravity.CENTER_VERTICAL | Gravity.START);
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
            ExpressWidgetLayout.Medium mediumLayout =
                    ExpressWidgetLayout.medium(hostHeightDp);
            WidgetTypographyProfile typography =
                    CardSizeProfile.resolve(options, hostWidthDp).typography;
            float density = context.getResources().getDisplayMetrics().density;
            ExpressWidgetRowPolicy.RowLayout rowLayout = ExpressWidgetRowPolicy.calculate(
                    displayed.size(), hostHeightDp, density,
                    typography.lineBox(
                            ExpressWidgetRowPolicy.DEFAULT_ROW_CONTENT_HEIGHT_DP));
            String title = context.getString(R.string.widget_express_count,
                    ExpressWidgetPresentation.activeCount(items));
            int countStart = title.lastIndexOf(' ') + 1;
            views.setTextViewText(R.id.widget_express_title, title.substring(0, countStart).trim());
            views.setTextViewText(R.id.widget_express_count, title.substring(countStart));
            views.setTextViewTextSize(R.id.widget_express_title,
                    TypedValue.COMPLEX_UNIT_SP,
                    typography.textSize(WidgetTypographyProfile.Token.PRIMARY_TITLE));
            views.setTextViewTextSize(R.id.widget_express_count,
                    TypedValue.COMPLEX_UNIT_SP,
                    typography.textSize(WidgetTypographyProfile.Token.PRIMARY_TITLE));
            ExpressWidgetMeasurements.centerHeaderGlyphs(context, views,
                    title.substring(0, countStart).trim(), title.substring(countStart),
                    typography.textSize(WidgetTypographyProfile.Token.PRIMARY_TITLE));
            views.setTextViewTextSize(R.id.widget_express_empty_text,
                    TypedValue.COMPLEX_UNIT_SP,
                    typography.textSize(WidgetTypographyProfile.Token.BODY));
            views.setViewVisibility(R.id.widget_express_empty,
                    empty ? View.VISIBLE : View.GONE);
            int accent = empty
                    ? ExpressWidgetPalette.emptyAccent(context)
                    : ExpressWidgetPalette.accent(context, displayed.get(0));
            views.setImageViewResource(R.id.widget_express_brand_gradient,
                    empty
                            ? R.drawable.widget_express_empty_gradient_mask
                            : R.drawable.widget_express_brand_gradient_mask);
            views.setInt(R.id.widget_express_brand_gradient, "setColorFilter", accent);
            views.setViewVisibility(R.id.widget_express_brand_gradient, View.VISIBLE);
            views.setInt(R.id.widget_express_search, "setColorFilter", accent);
            if (empty) {
                for (int index = 0; index < WIDE_ROW_IDS.length; index++) {
                    hideWideRow(views, index);
                }
            } else {
                for (int index = 0; index < WIDE_ROW_IDS.length; index++) {
                    bindWideRow(context, views, displayed, index, id * 10 + index,
                            rowLayout, typography, mediumLayout);
                }
                ExpressWidgetMeasurements.centerWideRowGlyphs(context, views, displayed,
                        rowLayout.visibleRows, WIDE_ROW_IDS, WIDE_LOGO_FRAME_IDS,
                        WIDE_LOGO_IDS, WIDE_COMPANY_IDS, WIDE_SENDER_IDS, WIDE_STATUS_IDS,
                        WIDE_DETAIL_IDS, hostWidthDp, rowLayout.detailMaxLines);
            }

            views.setOnClickPendingIntent(R.id.widget_express_header,
                    openList(context, 5100 + id));
            // An empty card's tap focuses the query field, as the 2×2 empty card and Pipi and iOS do (G-MED-22).
            views.setOnClickPendingIntent(R.id.widget_express_empty,
                    openSearch(context, 6100 + id));
            views.setOnClickPendingIntent(R.id.widget_express_search,
                    openSearch(context, 7100 + id));
            views.setOnClickPendingIntent(R.id.widget_express_root, null);
            manager.updateAppWidget(id, views);
        }
    }

    private static void bindWideRow(
            Context context, RemoteViews views, List<ExpressItem> items, int index,
            int requestCode, ExpressWidgetRowPolicy.RowLayout rowLayout,
            WidgetTypographyProfile typography,
            ExpressWidgetLayout.Medium mediumLayout) {
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
        // Cleared on every bind; ExpressWidgetMeasurements.centerWideRowGlyphs caps it again.
        views.setInt(WIDE_COMPANY_IDS[index], "setMaxWidth", Integer.MAX_VALUE);
        views.setViewVisibility(WIDE_SENDER_IDS[index], item.sender ? View.VISIBLE : View.GONE);
        applySenderTagTextColor(context, views, WIDE_SENDER_IDS[index],
                ExpressWidgetPalette.accent(context, items.get(0)));
        views.setTextViewText(WIDE_STATUS_IDS[index],
                ExpressWidgetPresentation.statusText(item));
        views.setInt(WIDE_STATUS_IDS[index],
                "setBackgroundResource", ExpressStatusColors.widgetBadgeBackground(item));
        applyStatusTextColor(context, views, WIDE_STATUS_IDS[index], item,
                ExpressWidgetPalette.accent(context, items.get(0)), true);
        views.setTextViewTextSize(WIDE_DETAIL_IDS[index], TypedValue.COMPLEX_UNIT_SP,
                mediumLayout.detailTextSizeSp);
        views.setInt(WIDE_DETAIL_IDS[index], "setMaxLines", rowLayout.detailMaxLines);
        views.setTextViewText(WIDE_DETAIL_IDS[index], ExpressTimeline.displayHeadline(item));
        views.setViewVisibility(WIDE_DETAIL_IDS[index],
                item.latestDetail.isEmpty() ? View.GONE : View.VISIBLE);
        boolean expandedDetail = rowLayout.detailMaxLines > 1 && !item.latestDetail.isEmpty();
        views.setInt(WIDE_CONTENT_IDS[index], "setGravity",
                expandedDetail ? Gravity.TOP : Gravity.CENTER_VERTICAL);
        views.setViewPadding(WIDE_LOGO_FRAME_IDS[index], 0, 0, 0, 0);
        views.setOnClickPendingIntent(root, openDetail(context, item, requestCode));
    }

    private static void hideWideRow(RemoteViews views, int index) {
        views.setTextViewText(WIDE_COMPANY_IDS[index], "");
        views.setViewVisibility(WIDE_SENDER_IDS[index], View.GONE);
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
        int compatHeaderVerticalInsetPx = Math.round(
                layout.logoVerticalInsetDp * density);
        int identityBottomInsetPx = Math.round(
                ExpressWidgetLayout.COMPACT_IDENTITY_BOTTOM_INSET_DP * density);
        int pillIconInsetPx = Math.round(layout.pillIconInsetDp * density);
        views.setViewPadding(R.id.widget_compact_content,
                paddingPx, paddingPx, paddingPx, paddingPx);
        views.setViewPadding(R.id.widget_compact_empty,
                paddingPx, paddingPx, paddingPx, paddingPx);
        views.setViewPadding(R.id.widget_compact_all,
                pillHorizontalPaddingPx, 0, pillHorizontalPaddingPx, 0);
        if (Build.VERSION.SDK_INT >= 31) {
            ExpressWidgetApi31.applyCompactHeaderSize(
                    views, layout.courierLogoSizeDp);
            ExpressWidgetApi31.applyCompactPillIconSize(
                    views, layout.pillIconSizeDp);
            views.setViewPadding(R.id.widget_compact_courier_logo, 0, 0, 0, 0);
            views.setViewPadding(R.id.widget_compact_identity,
                    0, 0, 0, identityBottomInsetPx);
            views.setViewPadding(R.id.widget_compact_all_icon, 0, 0, 0, 0);
        } else {
            // API 29/30 cannot resize RemoteViews layout params, so the fixed slots
            // use the same symmetric inset to keep their visible heights aligned.
            views.setViewPadding(R.id.widget_compact_courier_logo,
                    logoHorizontalInsetPx, compatHeaderVerticalInsetPx,
                    logoHorizontalInsetPx, compatHeaderVerticalInsetPx);
            views.setViewPadding(R.id.widget_compact_identity,
                    0, 0, 0, identityBottomInsetPx);
            views.setViewPadding(R.id.widget_compact_all_icon,
                    pillIconInsetPx, pillIconInsetPx, pillIconInsetPx, pillIconInsetPx);
        }
        views.setTextViewTextSize(R.id.widget_priority_status,
                TypedValue.COMPLEX_UNIT_SP, layout.statusTextSizeSp);
        views.setTextViewTextSize(R.id.widget_compact_company,
                TypedValue.COMPLEX_UNIT_SP, layout.companyTextSizeSp);
        // The 2×2 寄 tag steps down 1sp below the carrier line, matching Pipi and iOS (owner 2026-11-27).
        views.setTextViewTextSize(R.id.widget_compact_sender,
                TypedValue.COMPLEX_UNIT_SP, compactSenderTextSp(layout));
        views.setTextViewTextSize(R.id.widget_compact_detail,
                TypedValue.COMPLEX_UNIT_SP, layout.detailTextSizeSp);
        views.setTextViewTextSize(R.id.widget_compact_all_text,
                TypedValue.COMPLEX_UNIT_SP, layout.pillContentSize);
        views.setInt(R.id.widget_compact_detail,
                "setMaxLines", layout.detailLineLimit);
    }

    /** The 2×2 logo's end margin in express_widget_2x2.xml, before the status word. */
    private static final float COMPACT_LOGO_GAP_DP = 9f;
    /** The smallest 2×2 status size an outgoing parcel's 寄 tag can step the status word down to. */
    static final float COMPACT_SENDER_MIN_STATUS_SP = 14f;
    static final float COMPACT_SENDER_TEXT_OFFSET_SP = 1f;

    static float compactSenderTextSp(ExpressWidgetLayout.Compact layout) {
        return Math.max(10f, layout.companyTextSizeSp - COMPACT_SENDER_TEXT_OFFSET_SP);
    }

    /** Width of the 2×2 card's small gray 寄 tag, including its gap after the status word. */
    static float compactSenderTagPx(Context context, ExpressWidgetLayout.Compact layout) {
        Resources resources = context.getResources();
        TextPaint paint = new TextPaint(TextPaint.ANTI_ALIAS_FLAG);
        paint.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        paint.setTextSize(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP,
                compactSenderTextSp(layout), resources.getDisplayMetrics()));
        return paint.measureText(context.getString(R.string.express_sender))
                + 2f * resources.getDimension(R.dimen.express_widget_sender_tag_padding_horizontal)
                + resources.getDimension(R.dimen.express_widget_sender_tag_gap);
    }

    /**
     * The 2×2 headline size. With an outgoing parcel's 寄 tag the status word steps down from the
     * usual size only when the status and tag would not fit beside the logo, never below 14sp, so
     * the tag is never pushed out (Pipi {@code ExpressWidgetProvider.compactStatusTextSp}); every
     * other headline keeps its fixed size.
     */
    static float compactStatusTextSp(Context context, String status, boolean sender,
            float widthDp, ExpressWidgetLayout.Compact layout) {
        float preferred = layout.statusTextSizeSp;
        if (!sender || status == null || status.isEmpty()
                || !Float.isFinite(widthDp) || widthDp <= 0f) {
            return preferred;
        }
        // API 29/30 keep the 44dp logo slot and inset the artwork inside it.
        float logoSlotDp = Build.VERSION.SDK_INT >= 31
                ? layout.courierLogoSizeDp
                : layout.courierLogoSizeDp + 2f * layout.logoHorizontalInsetDp;
        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        float availablePx = Math.max(0f, widthDp - layout.paddingDp * 2f - logoSlotDp
                - COMPACT_LOGO_GAP_DP) * metrics.density;
        TextPaint paint = new TextPaint(TextPaint.ANTI_ALIAS_FLAG);
        paint.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        float tagPx = compactSenderTagPx(context, layout);
        for (float sp = preferred; sp > COMPACT_SENDER_MIN_STATUS_SP; sp -= 1f) {
            paint.setTextSize(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sp, metrics));
            if (paint.measureText(status) + tagPx <= availablePx) return sp;
        }
        return Math.min(preferred, COMPACT_SENDER_MIN_STATUS_SP);
    }

    /** 与 Pipi 的同名判定同形：单行且量得下才算一行，量不准时按多行处理。 */
    private static boolean fitsCompactSingleLine(
            Context context, String text, float widthDp,
            ExpressWidgetLayout.Compact layout) {
        if (text == null || text.isEmpty() || text.indexOf('\n') >= 0
                || !Float.isFinite(widthDp) || widthDp <= 0f) {
            return false;
        }
        float availableDp = Math.max(0f, widthDp - layout.paddingDp * 2f);
        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        TextPaint paint = new TextPaint(TextPaint.ANTI_ALIAS_FLAG);
        paint.setTextSize(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_SP, layout.detailTextSizeSp, metrics));
        return paint.measureText(text) <= availableDp * metrics.density;
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
        Context application = context.getApplicationContext();
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            ExpressScheduler.handoffWidgetRefresh(application, () -> {});
        } else {
            refreshAllBlocking(application);
        }
    }

    private static void refreshAllBlocking(Context context) {
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

    private static void applyStatusTextColor(Context context, RemoteViews views, int id,
            ExpressItem item, int accent, boolean badge) {
        if (Build.VERSION.SDK_INT >= 31) {
            Configuration appearance = new Configuration(context.getResources().getConfiguration());
            appearance.uiMode = (appearance.uiMode & ~Configuration.UI_MODE_NIGHT_MASK)
                    | Configuration.UI_MODE_NIGHT_NO;
            int day = statusTextColor(context.createConfigurationContext(appearance), item, accent, badge);
            appearance.uiMode = (appearance.uiMode & ~Configuration.UI_MODE_NIGHT_MASK)
                    | Configuration.UI_MODE_NIGHT_YES;
            int night = statusTextColor(context.createConfigurationContext(appearance), item, accent, badge);
            ExpressWidgetApi31.applyStatusTextColor(views, id, day, night);
        } else {
            views.setTextColor(id, statusTextColor(context, item, accent, badge));
        }
    }

    // Owner 2026-11-20 (修改 11): the 2×2 headline shows the shared text pair as it is; the 4×2 badge keeps it
    // unless the carrier brand gradient (0x55 at its corner, under the 0x1A badge fill) causes a drop under 3.0:1.
    static int statusTextColor(Context context, ExpressItem item, int accent, boolean badge) {
        int status = ExpressStatusColors.accent(context, item);
        if (!badge) return status;
        int surface = context.getColor(R.color.widget_surface);
        int tinted = androidx.core.graphics.ColorUtils.compositeColors(
                (accent & 0x00ffffff) | 0x55000000, surface);
        int fill = ExpressStatusColors.widgetBadgeFill(context, item);
        return ExpressStatusColors.brandGradientFloor(status,
                androidx.core.graphics.ColorUtils.compositeColors(fill, surface),
                androidx.core.graphics.ColorUtils.compositeColors(fill, tinted));
    }

    static final int SENDER_TAG_LIGHT_FILL = 0x1F757575;
    static final int SENDER_TAG_DARK_FILL = 0x38757575;
    static final int SENDER_TAG_LIGHT_INK = 0xFF616161;
    static final int SENDER_TAG_DARK_INK = 0xFFBDBDBD;

    private static void applySenderTagTextColor(Context context, RemoteViews views, int id, int accent) {
        if (Build.VERSION.SDK_INT >= 31) {
            Configuration appearance = new Configuration(context.getResources().getConfiguration());
            appearance.uiMode = (appearance.uiMode & ~Configuration.UI_MODE_NIGHT_MASK)
                    | Configuration.UI_MODE_NIGHT_NO;
            int day = senderTagTextColor(context.createConfigurationContext(appearance), accent, false);
            appearance.uiMode = (appearance.uiMode & ~Configuration.UI_MODE_NIGHT_MASK)
                    | Configuration.UI_MODE_NIGHT_YES;
            int night = senderTagTextColor(context.createConfigurationContext(appearance), accent, true);
            ExpressWidgetApi31.applyStatusTextColor(views, id, day, night);
        } else {
            views.setTextColor(id, senderTagTextColor(
                    context, accent, ExpressStatusColors.isNight(context)));
        }
    }

    static int senderTagTextColor(Context context, int accent, boolean night) {
        int ink = night ? SENDER_TAG_DARK_INK : SENDER_TAG_LIGHT_INK;
        int fill = night ? SENDER_TAG_DARK_FILL : SENDER_TAG_LIGHT_FILL;
        int surface = context.getColor(R.color.widget_surface);
        int tinted = androidx.core.graphics.ColorUtils.compositeColors(
                (accent & 0x00ffffff) | 0x55000000, surface);
        return ExpressStatusColors.brandGradientFloor(ink,
                androidx.core.graphics.ColorUtils.compositeColors(fill, surface),
                androidx.core.graphics.ColorUtils.compositeColors(fill, tinted));
    }

}
