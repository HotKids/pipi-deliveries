package me.pipi.deliveries.widget;

/** One semantic typography scale shared by the express widget surfaces. */
final class WidgetTypographyProfile {
    static final float WIDE_4X2_SCALE = 1.0625f;
    static final float EXTRA_WIDE_5X2_SCALE = 1f;

    enum Token {
        PRIMARY_TITLE(16f),
        BODY(14f),
        SUPPORT(13f);

        final float baseSizeSp;

        Token(float baseSizeSp) {
            this.baseSizeSp = baseSizeSp;
        }
    }

    final float typographyScale;

    private WidgetTypographyProfile(float typographyScale) {
        this.typographyScale = typographyScale;
    }

    static WidgetTypographyProfile wide4x2() {
        return new WidgetTypographyProfile(WIDE_4X2_SCALE);
    }

    static WidgetTypographyProfile extraWide5x2() {
        return new WidgetTypographyProfile(EXTRA_WIDE_5X2_SCALE);
    }

    float textSize(Token token) {
        float scaled = token.baseSizeSp * typographyScale;
        if (typographyScale == EXTRA_WIDE_5X2_SCALE) return scaled;
        return Math.round(scaled);
    }

    float lineBox(float baseDp) {
        return lineBox(baseDp, 1f);
    }

    float lineBox(float baseDp, float fontScale) {
        float safeFontScale = Float.isFinite(fontScale)
                ? Math.max(1f, fontScale) : 1f;
        return Math.max(0f, baseDp) * typographyScale * safeFontScale;
    }
}
