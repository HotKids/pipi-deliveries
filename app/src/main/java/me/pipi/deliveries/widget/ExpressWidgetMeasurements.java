package me.pipi.deliveries.widget;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.util.TypedValue;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.RemoteViews;
import android.widget.TextView;

import me.pipi.deliveries.R;

/** Measures the express header with the host's actual fonts. */
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
        for (TextView text : new TextView[] {title, count, arrow}) {
            text.setTextSize(TypedValue.COMPLEX_UNIT_SP, size);
        }
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
        int width = text.getWidth(), height = text.getHeight();
        if (width <= 0 || height <= 0) return text.getTop() + height / 2f;
        // CJK fallback fonts and the chevron have different ink bounds inside centered line boxes.
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        try {
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
            return text.getTop() + (bottom < top ? height / 2f : (top + bottom + 1) / 2f);
        } finally {
            bitmap.recycle();
        }
    }
}
