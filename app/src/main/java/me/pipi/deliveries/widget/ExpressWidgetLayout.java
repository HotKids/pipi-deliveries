package me.pipi.deliveries.widget;

/** Responsive metrics for the compact widget and the current wide empty state. */
final class ExpressWidgetLayout {
    private static final float COMPACT_COMPAT_LOGO_SLOT_DP = 42f;
    private static final float COMPACT_REFERENCE_WIDTH_DP = 157f;
    private static final float COMPACT_REFERENCE_HEIGHT_DP = 189f;

    private ExpressWidgetLayout() {}

    static Compact compact(float widthDp, float heightDp) {
        float scale = 1f;
        if (Float.isFinite(widthDp) && widthDp > 0f
                && Float.isFinite(heightDp) && heightDp > 0f) {
            scale = clamp(Math.min(
                    widthDp / COMPACT_REFERENCE_WIDTH_DP,
                    heightDp / COMPACT_REFERENCE_HEIGHT_DP), 0.9f, 1.1f);
        }
        int detailLineLimit = Float.isFinite(heightDp) && heightDp >= 155f ? 3 : 2;
        return new Compact(
                scale < 1f,
                clamp(14f * scale, 12f, 16f),
                15f * scale,
                12f * scale,
                12.5f * scale,
                clamp(42f * scale, 38f, 44f),
                clamp(12f * scale, 11f, 14f),
                detailLineLimit);
    }

    private static float clamp(float value, float min, float max) {
        return Math.max(min, Math.min(max, value));
    }

    static Medium medium(float heightDp) {
        boolean small = Float.isFinite(heightDp) && heightDp < 155f;
        float verticalPadding = small ? 10f : 12f;
        return new Medium(
                small,
                verticalPadding,
                verticalPadding * 1.2f);
    }

    static final class Compact {
        final boolean small;
        final float paddingDp;
        final float statusTextSizeSp;
        final float companyTextSizeSp;
        final float detailTextSizeSp;
        final float courierLogoSizeDp;
        final float pillHorizontalPaddingDp;
        final int detailLineLimit;

        Compact(boolean small, float paddingDp,
                float statusTextSizeSp, float companyTextSizeSp,
                float detailTextSizeSp, float courierLogoSizeDp,
                float pillHorizontalPaddingDp, int detailLineLimit) {
            this.small = small;
            this.paddingDp = paddingDp;
            this.statusTextSizeSp = statusTextSizeSp;
            this.companyTextSizeSp = companyTextSizeSp;
            this.detailTextSizeSp = detailTextSizeSp;
            this.courierLogoSizeDp = courierLogoSizeDp;
            this.pillHorizontalPaddingDp = pillHorizontalPaddingDp;
            this.detailLineLimit = detailLineLimit;
            logoHorizontalInsetDp = Math.max(
                    0f, (COMPACT_COMPAT_LOGO_SLOT_DP - courierLogoSizeDp) / 2f);
            logoVerticalInsetDp = Math.max(
                    0f, (COMPACT_COMPAT_LOGO_SLOT_DP - courierLogoSizeDp) / 2f);
        }

        final float logoHorizontalInsetDp;
        final float logoVerticalInsetDp;
    }

    static final class Medium {
        final boolean small;
        final float verticalPaddingDp;
        final float horizontalPaddingDp;

        Medium(boolean small, float verticalPaddingDp, float horizontalPaddingDp) {
            this.small = small;
            this.verticalPaddingDp = verticalPaddingDp;
            this.horizontalPaddingDp = horizontalPaddingDp;
        }
    }
}
