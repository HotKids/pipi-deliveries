package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.RemoteViews;
import android.widget.TextView;

import androidx.core.graphics.ColorUtils;

import java.lang.reflect.Method;

import me.pipi.deliveries.R;
import me.pipi.deliveries.feature.express.ExpressStatusColors;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        qualifiers = "port-notnight-mdpi")
public class ExpressWidgetBadgeContrastTest {
    // Real carrier accents, plus a white artwork and a pale pink one (red on red at night).
    private static final int[] BADGE_ACCENTS = {
            0xff3b2000, 0xff00519e, 0xfff39400, 0xffff2600, 0xffd32b2c,
            0xfffa0352, 0xffe33c24, 0xff762e97, 0xffe3373f, 0xfff57a00,
            0xff72388a, 0xfff7cd23, 0xff581a7e, 0xff008e4f, 0xff009d51,
            0xff0480bb, 0xff3482ff, 0xffffffff, 0xffffcdd2
    };

    @After public void restoreAppearance() {
        RuntimeEnvironment.setQualifiers("port-notnight-mdpi");
    }

    /**
     * Owner 2026-11-20 (修改 11, rule 3): the 2×2 headline shows the shared text pair as it is. The 4×2 badge
     * keeps it too unless the carrier brand gradient causes the drop: under 3.0:1 at the 0x55 brand corner
     * (under the 0x1A fill) and lower than on the plain badge. Then it takes the smallest 1% step toward
     * black or white that reaches 3.0:1 at that corner.
     */
    @Test public void badgesKeepTheSharedPairAndFloorOnlyCollidingBrandGradients() {
        int[] floored = new int[2];
        int[] unchanged = new int[2];
        for (boolean night : new boolean[] {false, true}) {
            RuntimeEnvironment.setQualifiers(qualifiers(night));
            Context context = RuntimeEnvironment.getApplication();
            for (StatusSemantic semantic : StatusSemantic.values()) {
                ExpressItem item = item(semantic);
                int foreground = ExpressStatusColors.accent(context, item);
                GradientDrawable badge = (GradientDrawable) context.getDrawable(
                        ExpressStatusColors.widgetBadgeBackground(item));
                int fill = badge.getColor().getDefaultColor();
                assertEquals("Keep the daylight badge fill", ExpressStatusColors.widgetBadgeFill(item), fill);
                assertEquals("The badge fill is the light text colour at 0x1A",
                        (ExpressStatusColors.accent(semantic, "", false) & 0xffffff) | 0x1a000000, fill);
                assertEquals("Keep the existing sender-badge radius", 3f,
                        badge.getCornerRadius(), 0f);
                for (int brand : BADGE_ACCENTS) {
                    assertEquals("The 2x2 headline shows the shared pair as it is", foreground,
                            ExpressWidgetProvider.statusTextColor(context, item, brand, false));
                    Badge shown = badge(context, item, brand);
                    if (!shown.collides()) {
                        assertEquals(semantic + " night=" + night + " brand=" + Integer.toHexString(brand)
                                + ": the gradient causes no drop", foreground, shown.text);
                        unchanged[night ? 1 : 0]++;
                        continue;
                    }
                    floored[night ? 1 : 0]++;
                    assertTrue("The floor reaches 3.0:1 at the brand corner",
                            ColorUtils.calculateContrast(shown.text, shown.corner) >= 3.0);
                    int target = ColorUtils.calculateContrast(0xff000000, shown.corner)
                            >= ColorUtils.calculateContrast(0xffffffff, shown.corner) ? 0xff000000 : 0xffffffff;
                    int step = -1;
                    for (int index = 1; index <= 100 && step < 0; index++) {
                        if (ColorUtils.setAlphaComponent(ColorUtils.blendARGB(foreground, target, index / 100f), 255)
                                == shown.text) step = index;
                    }
                    assertTrue("The floor moves toward black or white", step > 0);
                    int previous = ColorUtils.setAlphaComponent(
                            ColorUtils.blendARGB(foreground, target, (step - 1) / 100f), 255);
                    assertTrue("The floor takes the smallest step",
                            ColorUtils.calculateContrast(previous, shown.corner) < 3.0);
                }
            }
        }
        for (int mode = 0; mode < 2; mode++) {
            assertTrue("The floor applies only to colliding brand gradients",
                    floored[mode] > 0 && unchanged[mode] > 0);
        }
    }

    /** Collision and non-collision cases in each appearance (修改 11 rule 3). */
    @Test public void redOnRedAndGreenOnGreenCollideWhileOtherPairsStayRaw() {
        RuntimeEnvironment.setQualifiers(qualifiers(false));
        Context day = RuntimeEnvironment.getApplication();
        assertTrue(badge(day, item(StatusSemantic.DANGER), 0xffd32b2c).isFloored());
        assertTrue(badge(day, item(StatusSemantic.DELIVERY), 0xff009d51).isFloored());
        assertTrue(badge(day, item(StatusSemantic.ORDERED), 0xff3482ff).isRaw());
        // A white artwork adds no drop, so even the lightest pairs stay as they are.
        assertTrue(badge(day, item(StatusSemantic.COMPLETED), 0xffffffff).isRaw());
        assertTrue(badge(day, item(StatusSemantic.UNKNOWN), 0xffffffff).isRaw());
        RuntimeEnvironment.setQualifiers(qualifiers(true));
        Context night = RuntimeEnvironment.getApplication();
        assertTrue(badge(night, item(StatusSemantic.TRANSIT), 0xfff7cd23).isFloored());
        assertTrue(badge(night, item(StatusSemantic.DANGER), 0xffffcdd2).isFloored());
        assertTrue(badge(night, item(StatusSemantic.DANGER), 0xffd32b2c).isRaw());
        assertTrue(badge(night, item(StatusSemantic.TRANSIT), 0xff3482ff).isRaw());
    }

    private static Badge badge(Context context, ExpressItem item, int brand) {
        int surface = context.getColor(R.color.widget_surface);
        int fill = ExpressStatusColors.widgetBadgeFill(item);
        int plain = ColorUtils.compositeColors(fill, surface);
        int corner = ColorUtils.compositeColors(fill, ColorUtils.compositeColors(
                ColorUtils.setAlphaComponent(brand, 0x55), surface));
        return new Badge(ExpressWidgetProvider.statusTextColor(context, item, brand, true),
                ExpressStatusColors.accent(context, item), plain, corner);
    }

    private record Badge(int text, int raw, int plain, int corner) {
        boolean collides() {
            double atCorner = ColorUtils.calculateContrast(raw, corner);
            return atCorner < 3.0 && atCorner < ColorUtils.calculateContrast(raw, plain);
        }

        boolean isFloored() {
            return collides() && text != raw && ColorUtils.calculateContrast(text, corner) >= 3.0;
        }

        boolean isRaw() {
            return !collides() && text == raw;
        }
    }

    @Test public void remoteViewsUsesHostAppearanceWithoutChangingBadgeFill() throws Exception {
        for (boolean generatedNight : new boolean[] {false, true}) {
            RuntimeEnvironment.setQualifiers(qualifiers(generatedNight));
            Context generated = RuntimeEnvironment.getApplication();
            ExpressItem item = item(StatusSemantic.ORDERED);
            int brand = 0xff0480bb;
            RemoteViews views = new RemoteViews(generated.getPackageName(), R.layout.express_widget_4x2);
            views.setInt(R.id.widget_express_status1, "setBackgroundResource",
                    ExpressStatusColors.widgetBadgeBackground(item));
            Method bind = ExpressWidgetProvider.class.getDeclaredMethod("applyStatusTextColor",
                    Context.class, RemoteViews.class, int.class, ExpressItem.class, int.class, boolean.class);
            bind.setAccessible(true);
            bind.invoke(null, generated, views, R.id.widget_express_status1, item, brand, true);
            int generatedText = ExpressWidgetProvider.statusTextColor(generated, item, brand, true);
            RuntimeEnvironment.setQualifiers(qualifiers(!generatedNight));
            Context host = RuntimeEnvironment.getApplication();
            View root = views.apply(host, new FrameLayout(host));
            TextView text = root.findViewById(R.id.widget_express_status1);
            int expected = Build.VERSION.SDK_INT >= 31
                    ? ExpressWidgetProvider.statusTextColor(host, item, brand, true) : generatedText;
            assertEquals(expected, text.getCurrentTextColor());
            views.reapply(host, root);
            assertEquals(expected, text.getCurrentTextColor());
            assertEquals(0x1a5a6b80,
                    ((GradientDrawable) text.getBackground()).getColor().getDefaultColor());
        }
    }

    private static String qualifiers(boolean night) {
        return "port-" + (night ? "night" : "notnight") + "-mdpi";
    }

    private static ExpressItem item(StatusSemantic semantic) {
        return new ExpressItem(1, "", "TEST", "ZTO", "", semantic,
                "", "", "", "", "", "INTERFACE5", "");
    }
}
