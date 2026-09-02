package me.pipi.deliveries.widget;

/** Responsive metrics for the compact widget and the current wide empty state. */
final class ExpressWidgetLayout {
    private static final float COMPACT_COMPAT_LOGO_SLOT_DP = 44f;
    private static final float COMPACT_COMPAT_PILL_ICON_SLOT_DP = 16f;
    private static final float COMPACT_REFERENCE_WIDTH_DP = 157f;
    private static final float COMPACT_REFERENCE_HEIGHT_DP = 189f;
    private static final float COMPACT_STATUS_TEXT_SIZE_SP = 20f;
    private static final float COMPACT_COMPANY_TEXT_SIZE_SP = 12f;
    private static final float COMPACT_DETAIL_TEXT_SIZE_SP = 12f;
    private static final float REGULAR_DETAIL_TEXT_SIZE_SP = 13f;
    private static final float COMPACT_PILL_TEXT_SIZE_SP = 14f;

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
        float courierLogoSizeDp = clamp(42f * scale, 38f, 44f);
        return new Compact(
                scale < 1f,
                clamp(14f * scale, 12f, 16f),
                COMPACT_STATUS_TEXT_SIZE_SP,
                COMPACT_COMPANY_TEXT_SIZE_SP,
                compactDetailTextSize(widthDp, heightDp),
                courierLogoSizeDp,
                COMPACT_PILL_TEXT_SIZE_SP,
                compactPillIconSize(widthDp),
                clamp(12f * scale, 11f, 14f),
                detailLineLimit);
    }

    private static float compactPillIconSize(float widthDp) {
        return Float.isFinite(widthDp) && widthDp <= 148f ? 15f : 16f;
    }

    private static float compactDetailTextSize(float widthDp, float heightDp) {
        boolean compactWidth = Float.isFinite(widthDp) && widthDp <= 148f;
        boolean compactHeight = Float.isFinite(heightDp) && heightDp < 155f;
        return compactWidth || compactHeight
                ? COMPACT_DETAIL_TEXT_SIZE_SP : REGULAR_DETAIL_TEXT_SIZE_SP;
    }

    private static float wideDetailTextSize(float heightDp) {
        return Float.isFinite(heightDp) && heightDp < 155f
                ? COMPACT_DETAIL_TEXT_SIZE_SP : REGULAR_DETAIL_TEXT_SIZE_SP;
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
                verticalPadding * 1.2f,
                wideDetailTextSize(heightDp));
    }

    static final class Compact {
        final boolean small;
        final float paddingDp;
        final float statusTextSizeSp;
        final float companyTextSizeSp;
        final float detailTextSizeSp;
        final float courierLogoSizeDp;
        final float pillContentSize;
        final float pillIconSizeDp;
        final float pillHorizontalPaddingDp;
        final int detailLineLimit;

        Compact(boolean small, float paddingDp,
                float statusTextSizeSp, float companyTextSizeSp,
                float detailTextSizeSp, float courierLogoSizeDp,
                float pillContentSize, float pillIconSizeDp,
                float pillHorizontalPaddingDp,
                int detailLineLimit) {
            this.small = small;
            this.paddingDp = paddingDp;
            this.statusTextSizeSp = statusTextSizeSp;
            this.companyTextSizeSp = companyTextSizeSp;
            this.detailTextSizeSp = detailTextSizeSp;
            this.courierLogoSizeDp = courierLogoSizeDp;
            this.pillContentSize = pillContentSize;
            this.pillIconSizeDp = pillIconSizeDp;
            this.pillHorizontalPaddingDp = pillHorizontalPaddingDp;
            this.detailLineLimit = detailLineLimit;
            logoHorizontalInsetDp = Math.max(
                    0f, (COMPACT_COMPAT_LOGO_SLOT_DP - courierLogoSizeDp) / 2f);
            logoVerticalInsetDp = Math.max(
                    0f, (COMPACT_COMPAT_LOGO_SLOT_DP - courierLogoSizeDp) / 2f);
            pillIconInsetDp = Math.max(
                    0f, (COMPACT_COMPAT_PILL_ICON_SLOT_DP - pillIconSizeDp) / 2f);
        }

        final float logoHorizontalInsetDp;
        final float logoVerticalInsetDp;
        final float pillIconInsetDp;
    }

    static final class Medium {
        final boolean small;
        final float verticalPaddingDp;
        final float horizontalPaddingDp;
        final float detailTextSizeSp;

        Medium(boolean small, float verticalPaddingDp, float horizontalPaddingDp,
                float detailTextSizeSp) {
            this.small = small;
            this.verticalPaddingDp = verticalPaddingDp;
            this.horizontalPaddingDp = horizontalPaddingDp;
            this.detailTextSizeSp = detailTextSizeSp;
        }
    }
}
