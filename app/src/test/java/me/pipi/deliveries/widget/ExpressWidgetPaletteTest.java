package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class ExpressWidgetPaletteTest {
    @Test
    public void emptyStateUsesTheCanonicalAccentInsteadOfWallpaperColor() {
        assertEquals(0xff3482ff, ExpressWidgetPalette.emptyAccent(null));
    }

    @Test
    public void populatedStateStillExtractsAChromaticCarrierAccent() {
        int[] pixels = {
                0xffff8800, 0xffff8800, 0xffff8800,
                0xffeeeeee, 0xff111111
        };

        assertEquals(0xffff8800,
                ExpressWidgetPalette.dominantAccent(pixels, 0xff3482ff));
    }
}
