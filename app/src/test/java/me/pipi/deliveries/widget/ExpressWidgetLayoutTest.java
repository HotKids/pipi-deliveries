package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class ExpressWidgetLayoutTest {
    private static final float EPSILON = 0.0001f;

    @Test
    public void compactUsesPipiSourceScaleAcrossLauncherSizes() {
        ExpressWidgetLayout.Compact small = ExpressWidgetLayout.compact(141.3f, 170.1f);
        ExpressWidgetLayout.Compact reference = ExpressWidgetLayout.compact(157f, 189f);
        ExpressWidgetLayout.Compact fold = ExpressWidgetLayout.compact(201f, 240f);

        assertTrue(small.small);
        assertEquals(12.6f, small.paddingDp, EPSILON);
        assertEquals(20f, small.statusTextSizeSp, EPSILON);
        assertEquals(12f, small.companyTextSizeSp, EPSILON);
        assertEquals(12f, small.detailTextSizeSp, EPSILON);
        assertEquals(38f, small.courierLogoSizeDp, EPSILON);
        assertEquals(3f, small.logoHorizontalInsetDp, EPSILON);
        assertEquals(3f, small.logoVerticalInsetDp, EPSILON);
        assertEquals(14f, small.pillContentSize, EPSILON);
        assertEquals(15f, small.pillIconSizeDp, EPSILON);
        assertEquals(0.5f, small.pillIconInsetDp, EPSILON);
        assertEquals(11f, small.pillHorizontalPaddingDp, EPSILON);
        assertEquals(3, small.detailLineLimit);

        assertFalse(reference.small);
        assertEquals(14f, reference.paddingDp, EPSILON);
        assertEquals(20f, reference.statusTextSizeSp, EPSILON);
        assertEquals(12f, reference.companyTextSizeSp, EPSILON);
        assertEquals(13f, reference.detailTextSizeSp, EPSILON);
        assertEquals(42f, reference.courierLogoSizeDp, EPSILON);
        assertEquals(1f, reference.logoHorizontalInsetDp, EPSILON);
        assertEquals(1f, reference.logoVerticalInsetDp, EPSILON);
        assertEquals(14f, reference.pillContentSize, EPSILON);
        assertEquals(16f, reference.pillIconSizeDp, EPSILON);
        assertEquals(0f, reference.pillIconInsetDp, EPSILON);
        assertEquals(12f, reference.pillHorizontalPaddingDp, EPSILON);
        assertEquals(3, reference.detailLineLimit);

        assertFalse(fold.small);
        assertEquals(15.4f, fold.paddingDp, EPSILON);
        assertEquals(20f, fold.statusTextSizeSp, EPSILON);
        assertEquals(12f, fold.companyTextSizeSp, EPSILON);
        assertEquals(13f, fold.detailTextSizeSp, EPSILON);
        assertEquals(44f, fold.courierLogoSizeDp, EPSILON);
        assertEquals(0f, fold.logoHorizontalInsetDp, EPSILON);
        assertEquals(0f, fold.logoVerticalInsetDp, EPSILON);
        assertEquals(14f, fold.pillContentSize, EPSILON);
        assertEquals(16f, fold.pillIconSizeDp, EPSILON);
        assertEquals(0f, fold.pillIconInsetDp, EPSILON);
        assertEquals(13.2f, fold.pillHorizontalPaddingDp, EPSILON);
        assertEquals(3, fold.detailLineLimit);
    }

    @Test
    public void wideEmptyKeepsCurrentResponsiveInsets() {
        ExpressWidgetLayout.Medium small = ExpressWidgetLayout.medium(148f);
        ExpressWidgetLayout.Medium regular = ExpressWidgetLayout.medium(155f);

        assertTrue(small.small);
        assertEquals(10f, small.verticalPaddingDp, EPSILON);
        assertEquals(12f, small.horizontalPaddingDp, EPSILON);
        assertEquals(12f, small.detailTextSizeSp, EPSILON);

        assertFalse(regular.small);
        assertEquals(12f, regular.verticalPaddingDp, EPSILON);
        assertEquals(14.4f, regular.horizontalPaddingDp, EPSILON);
        assertEquals(13f, regular.detailTextSizeSp, EPSILON);
    }
}
