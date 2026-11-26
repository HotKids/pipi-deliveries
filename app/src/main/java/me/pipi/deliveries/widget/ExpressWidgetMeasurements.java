package me.pipi.deliveries.widget;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.util.TypedValue;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.RemoteViews;
import android.widget.TextView;

import me.pipi.deliveries.R;

/** Measures the express header and rows with the host's actual fonts. */
final class ExpressWidgetMeasurements {
    private ExpressWidgetMeasurements() {}

    static void centerHeaderGlyphs(Context context, RemoteViews views,
            String titleText, String countText, float size) {
        View shell = LayoutInflater.from(context).inflate(
                R.layout.express_widget_4x2, new FrameLayout(context), false);
        TextView title = shell.findViewById(R.id.widget_express_title);
        TextView count = shell.findViewById(R.id.widget_express_count);
        TextView arrow = shell.findViewById(R.id.widget_express_arrow);
        title.setText(titleText);
        count.setText(countText);
        for (TextView text : new TextView[] {title, count}) {
            text.setTextSize(TypedValue.COMPLEX_UNIT_SP, size);
        }
        title.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED);
        // Enlarge the ink inside the original title-height envelope, preserving row placement.
        arrow.setTextSize(TypedValue.COMPLEX_UNIT_SP, size * 1.25f);
        arrow.setHeight(title.getMeasuredHeight());
        views.setTextViewTextSize(R.id.widget_express_arrow, TypedValue.COMPLEX_UNIT_SP, size * 1.25f);
        views.setInt(R.id.widget_express_arrow, "setHeight", title.getMeasuredHeight());
        View header = (View) title.getParent();
        header.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED);
        header.layout(0, 0, header.getMeasuredWidth(), header.getMeasuredHeight());
        float titleCenter = glyphCenterY(title);
        int countOffset = Math.round(titleCenter - glyphCenterY(count));
        int arrowOffset = Math.round(titleCenter - glyphCenterY(arrow));
        // Opposite padding shifts ink without changing line height; Android 10 RemoteViews
        // cannot call setTranslationY, while setViewPadding is supported on every Lite host.
        views.setViewPadding(R.id.widget_express_count, 0, countOffset, 0, -countOffset);
        views.setViewPadding(R.id.widget_express_arrow, 0, arrowOffset, 0, -arrowOffset);
    }

    private static float glyphCenterY(TextView text) {
        return text.getTop() + glyphBounds(text).exactCenterY();
    }

    private static Rect glyphBounds(TextView text) {
        int width = text.getWidth(), height = text.getHeight();
        if (width <= 0 || height <= 0) return new Rect(0, 0, width, height);
        // CJK fallback fonts and the chevron have different ink bounds inside centered line boxes.
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Drawable background = text.getBackground();
        try {
            text.setBackground(null);
            text.setTextColor(Color.BLACK);
            text.draw(new Canvas(bitmap));
            int top = height, bottom = -1;
            int[] pixels = new int[width * height];
            bitmap.getPixels(pixels, 0, width, 0, 0, width, height);
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    if (Color.alpha(pixels[y * width + x]) < 16) continue;
                    top = Math.min(top, y);
                    bottom = Math.max(bottom, y);
                }
            }
            return new Rect(0, bottom < top ? 0 : top, width,
                    bottom < top ? height : bottom + 1);
        } finally {
            text.setBackground(background);
            bitmap.recycle();
        }
    }

    static void centerWideRowGlyphs(Context context, RemoteViews views,
            java.util.List<me.pipi.deliveries.model.ExpressItem> items, int visibleRows,
            int[] rowIds, int[] logoFrameIds, int[] logoIds,
            int[] companyIds, int[] senderIds, int[] statusIds, int[] detailIds,
            float widthDp, int detailMaxLines) {
        if (visibleRows <= 0 || widthDp <= 0f) return;
        int count = Math.min(visibleRows, Math.min(items.size(), rowIds.length));
        View shell = inflateAndLayoutShell(context, views, widthDp);
        // Fourth external review R4-NEW-08 ③ (owner 2026-11-23「报告里的都直接做」): as on Pipi
        // (ExpressWidgetMeasurements.centerRowGlyphs there), a long carrier name yields to the 寄 tag
        // and the status capsule; the identity is capped at the width they leave.
        boolean capped = false;
        for (int index = 0; index < count; index++) {
            capped |= capWideIdentity(views, shell, companyIds[index], senderIds[index],
                    statusIds[index]);
        }
        boolean needsCentering = false;
        for (int index = 0; index < count; index++) {
            boolean expandedDetail = detailMaxLines > 1
                    && !items.get(index).latestDetail.isEmpty();
            if (!expandedDetail) {
                needsCentering = true;
                break;
            }
        }
        if (!needsCentering) return;
        if (capped) shell = inflateAndLayoutShell(context, views, widthDp);
        for (int index = 0; index < count; index++) {
            boolean expandedDetail = detailMaxLines > 1
                    && !items.get(index).latestDetail.isEmpty();
            if (expandedDetail) continue;
            applyCenteredRowPadding(views, shell, rowIds[index], logoFrameIds[index],
                    logoIds[index], companyIds[index], statusIds[index], detailIds[index]);
        }
    }

    static void centerRowGlyphs(Context context, RemoteViews views, int rowId,
            int logoFrameId, int logoId, int companyId, int statusId, int detailId,
            float widthDp, int detailMaxLines) {
        views.setViewPadding(logoFrameId, 0, 0, 0, 0);
        if (detailMaxLines > 1 || widthDp <= 0f) return;

        View shell = inflateAndLayoutShell(context, views, widthDp);
        applyCenteredRowPadding(views, shell, rowId, logoFrameId, logoId,
                companyId, statusId, detailId);
    }

    private static View inflateAndLayoutShell(
            Context context, RemoteViews views, float widthDp) {
        View shell = views.apply(context, new FrameLayout(context));
        int width = Math.max(1, Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, widthDp,
                context.getResources().getDisplayMetrics())));
        shell.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        shell.layout(0, 0, shell.getMeasuredWidth(), shell.getMeasuredHeight());
        return shell;
    }

    /**
     * Caps one wide row's identity at the title line width left after the visible 寄 tag and the
     * status capsule at their natural widths, and reports whether the identity was wider.
     */
    private static boolean capWideIdentity(RemoteViews views, View shell,
            int companyId, int senderId, int statusId) {
        TextView identity = shell.findViewById(companyId);
        ViewGroup line = (ViewGroup) identity.getParent();
        int unspecified = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED);
        int available = line.getMeasuredWidth() - line.getPaddingLeft() - line.getPaddingRight()
                - horizontalMargins(identity);
        for (int id : new int[] {senderId, statusId}) {
            View view = shell.findViewById(id);
            if (view.getVisibility() == View.GONE) continue;
            view.measure(unspecified, unspecified);
            available -= view.getMeasuredWidth() + horizontalMargins(view);
        }
        int maxWidth = Math.max(1, available);
        views.setInt(companyId, "setMaxWidth", maxWidth);
        identity.measure(unspecified, unspecified);
        return identity.getMeasuredWidth() > maxWidth;
    }

    private static int horizontalMargins(View view) {
        ViewGroup.MarginLayoutParams params = (ViewGroup.MarginLayoutParams) view.getLayoutParams();
        return params.leftMargin + params.rightMargin;
    }

    private static void applyCenteredRowPadding(RemoteViews views, View shell,
            int rowId, int logoFrameId, int logoId,
            int companyId, int statusId, int detailId) {
        ViewGroup row = shell.findViewById(rowId);
        View frame = row.findViewById(logoFrameId);
        View logo = row.findViewById(logoId);
        TextView detail = row.findViewById(detailId);
        int top = Math.round((frame.getHeight() - logo.getHeight()) / 2f);
        if (detail.getVisibility() == View.VISIBLE) {
            Rect ink = new Rect();
            for (int id : new int[] {companyId, statusId, detailId}) {
                TextView text = row.findViewById(id);
                Rect glyphs = glyphBounds(text);
                row.offsetDescendantRectToMyCoords(text, glyphs);
                ink.union(glyphs);
            }
            Rect frameBounds = new Rect(0, 0, frame.getWidth(), frame.getHeight());
            row.offsetDescendantRectToMyCoords(frame, frameBounds);
            top = Math.round(ink.exactCenterY() - frameBounds.top - logo.getHeight() / 2f);
        }
        top = Math.max(0, Math.min(frame.getHeight() - logo.getHeight(), top));
        // Move the fixed-size child inside its existing envelope; padding is also supported
        // by Android 10 RemoteViews and never scales the carrier artwork itself.
        views.setViewPadding(logoFrameId, 0, top, 0, -top);
    }
}
