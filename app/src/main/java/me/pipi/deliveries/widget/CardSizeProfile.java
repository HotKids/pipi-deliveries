package me.pipi.deliveries.widget;

import android.os.Bundle;

/** Pipi's discrete typography profiles for four- and five-column widget hosts. */
enum CardSizeProfile {
    WIDE_4X2(WidgetTypographyProfile.wide4x2()),
    EXTRA_WIDE_5X2(WidgetTypographyProfile.extraWide5x2());

    private static final float EXTRA_WIDE_HOST_THRESHOLD_DP = 320f;
    private static final String HOST_COLUMN_SPAN_OPTION = "semAppWidgetColumnSpan";

    final WidgetTypographyProfile typography;

    CardSizeProfile(WidgetTypographyProfile typography) {
        this.typography = typography;
    }

    static CardSizeProfile resolve(Bundle options, float hostWidthDp) {
        int columns = options == null ? -1 : options.getInt(HOST_COLUMN_SPAN_OPTION, -1);
        return resolve(columns, hostWidthDp);
    }

    static CardSizeProfile resolve(int logicalColumnSpan, float hostWidthDp) {
        int columns = logicalColumnSpan;
        if (columns == 4) return WIDE_4X2;
        if (columns >= 5) return EXTRA_WIDE_5X2;
        return fromWidth(hostWidthDp);
    }

    static CardSizeProfile fromWidth(float hostWidthDp) {
        return hostWidthDp < EXTRA_WIDE_HOST_THRESHOLD_DP
                ? WIDE_4X2 : EXTRA_WIDE_5X2;
    }
}
