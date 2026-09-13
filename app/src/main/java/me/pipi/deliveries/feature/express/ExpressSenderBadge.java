package me.pipi.deliveries.feature.express;

import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.View;
import android.widget.TextView;

/** Shared list/detail badge using the iOS status tint and compact sender treatment. */
final class ExpressSenderBadge {
    private ExpressSenderBadge() {}

    static void apply(TextView view, boolean sender, int color) {
        if (view == null) return;
        view.setVisibility(sender ? View.VISIBLE : View.GONE);
        if (!sender) return;
        float density = view.getResources().getDisplayMetrics().density;
        view.setText(me.pipi.deliveries.R.string.express_sender);
        view.setTextSize(11);
        view.setTypeface(view.getTypeface(), Typeface.BOLD);
        view.setTextColor(color);
        view.setIncludeFontPadding(false);
        view.setSingleLine(true);
        view.setPadding(Math.round(6 * density), Math.round(2 * density),
                Math.round(6 * density), Math.round(2 * density));
        GradientDrawable background = new GradientDrawable();
        background.setColor((color & 0x00ffffff) | 0x1a000000);
        background.setCornerRadius(6 * density);
        view.setBackground(background);
    }
}
