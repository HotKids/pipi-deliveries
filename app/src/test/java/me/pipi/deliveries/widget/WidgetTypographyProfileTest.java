package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class WidgetTypographyProfileTest {
    private static final float EPSILON = 0.0001f;

    @Test
    public void populatedFourByTwoUsesGithubPipiScaleAndSemanticTokens() {
        WidgetTypographyProfile profile = WidgetTypographyProfile.wide4x2();

        assertEquals(1.0625f, profile.typographyScale, EPSILON);
        assertEquals(17f, profile.textSize(
                WidgetTypographyProfile.Token.PRIMARY_TITLE), EPSILON);
        assertEquals(14f, profile.textSize(
                WidgetTypographyProfile.Token.SUPPORT), EPSILON);
        assertEquals(44.625f, profile.lineBox(42f), EPSILON);
        assertEquals(44.625f, profile.lineBox(42f, 0.85f), EPSILON);
        assertEquals(58.0125f, profile.lineBox(42f, 1.3f), EPSILON);
        assertEquals(66.9375f, profile.lineBox(42f, 1.5f), EPSILON);
    }

    @Test
    public void fiveByTwoKeepsBaseSizes() {
        WidgetTypographyProfile profile = WidgetTypographyProfile.extraWide5x2();

        assertEquals(16f, profile.textSize(
                WidgetTypographyProfile.Token.PRIMARY_TITLE), EPSILON);
        assertEquals(13f, profile.textSize(
                WidgetTypographyProfile.Token.SUPPORT), EPSILON);
        assertEquals(42f, profile.lineBox(42f, Float.NaN), EPSILON);
    }
}
