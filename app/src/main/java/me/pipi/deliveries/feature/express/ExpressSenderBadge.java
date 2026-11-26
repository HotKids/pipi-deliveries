package me.pipi.deliveries.feature.express;

import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.View;
import android.widget.TextView;

import me.pipi.deliveries.model.StatusSemantic;

/**
 * Shared list/detail badge using the iOS status tint and compact sender treatment: the light text colour
 * at 0x1A under the current appearance's text colour (owner 2026-11-20, 修改 11).
 */
final class ExpressSenderBadge {
    private ExpressSenderBadge() {}

    static void apply(TextView view, boolean sender, StatusSemantic semantic, String label) {
        if (view == null) return;
        view.setVisibility(sender ? View.VISIBLE : View.GONE);
        if (!sender) return;
        float density = view.getResources().getDisplayMetrics().density;
        view.setText(me.pipi.deliveries.R.string.express_sender);
        view.setTextSize(11);
        view.setTypeface(view.getTypeface(), Typeface.BOLD);
        view.setTextColor(ExpressStatusColors.accent(semantic, label,
                ExpressStatusColors.isNight(view.getContext())));
        view.setIncludeFontPadding(false);
        view.setSingleLine(true);
        view.setPadding(Math.round(6 * density), Math.round(2 * density),
                Math.round(6 * density), Math.round(2 * density));
        GradientDrawable background = new GradientDrawable();
        background.setColor(ExpressStatusColors.badgeFill(semantic, label));
        background.setCornerRadius(6 * density);
        view.setBackground(background);
    }
}
