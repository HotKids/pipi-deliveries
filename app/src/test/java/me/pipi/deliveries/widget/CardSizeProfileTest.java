package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class CardSizeProfileTest {
    @Test
    public void logicalColumnSpanWinsOverPhysicalWidth() {
        assertEquals(CardSizeProfile.WIDE_4X2,
                CardSizeProfile.resolve(4, 430f));
        assertEquals(CardSizeProfile.EXTRA_WIDE_5X2,
                CardSizeProfile.resolve(5, 250f));
    }

    @Test
    public void widthSelectsProfileWhenColumnSpanIsUnavailable() {
        assertEquals(CardSizeProfile.WIDE_4X2,
                CardSizeProfile.fromWidth(319.9f));
        assertEquals(CardSizeProfile.EXTRA_WIDE_5X2,
                CardSizeProfile.fromWidth(320f));
    }
}
