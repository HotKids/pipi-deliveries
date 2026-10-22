package me.pipi.deliveries.widget;

import android.app.Application;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, manifest = Config.NONE, application = Application.class,
        qualifiers = "port-notnight-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public final class ExpressWidgetCompatHeaderTest {
    @Test public void android10WideRowsKeepArtworkSizeAndVisibleGlyphAlignment() throws Exception {
        ExpressWidgetHeaderGeometryTest.assertWideRowsCenterArtworkOnVisibleGlyphs();
    }

    @Test public void android10ExpandedAndMissingRowsClearCachedOpticalPlacement() throws Exception {
        ExpressWidgetHeaderGeometryTest.assertWideRowsRestoreCachedArtworkPlacement();
    }

    @Test public void android10LargeTextKeepsHeaderGlyphsCentered() throws Exception {
        for (int count : new int[] {0, 2, 12}) {
            ExpressWidgetHeaderThemeTest.assertCachedHeaderColors(false, true, count, 1.3f);
        }
    }

    @Test public void android10HostKeepsHeaderGlyphsCentered() throws Exception {
        ExpressWidgetHeaderThemeTest.assertCachedHeaderColors(false, true, 2);
    }
}
