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
    private static final int[] CARRIER_ACCENTS = {
            0xff3b2000, 0xff00519e, 0xfff39400, 0xffff2600, 0xffd32b2c,
            0xfffa0352, 0xffe33c24, 0xff762e97, 0xffe3373f, 0xfff57a00,
            0xff72388a, 0xfff7cd23, 0xff581a7e, 0xff008e4f, 0xff009d51,
            0xff0480bb, 0xff3482ff
    };

    @After public void restoreAppearance() {
        RuntimeEnvironment.setQualifiers("port-notnight-mdpi");
    }

    @Test public void everyStatusRemainsReadableAcrossEveryCarrierGradient() {
        for (boolean night : new boolean[] {false, true}) {
            RuntimeEnvironment.setQualifiers(qualifiers(night));
            Context context = RuntimeEnvironment.getApplication();
            int surface = context.getColor(R.color.widget_surface);
            for (StatusSemantic semantic : StatusSemantic.values()) {
                ExpressItem item = item(semantic);
                ExpressWidgetProvider.StatusStyle style =
                        ExpressWidgetProvider.StatusStyle.forSemantic(semantic);
                GradientDrawable badge = (GradientDrawable) context.getDrawable(style.background);
                int fill = badge.getColor().getDefaultColor();
                assertEquals("Keep the semantic badge fill", (style.foreground & 0x00ffffff)
                        | 0x1a000000, fill);
                assertEquals("Keep the existing sender-badge radius", 3f,
                        badge.getCornerRadius(), 0f);
                for (int brand : CARRIER_ACCENTS) {
                    int text = ExpressWidgetProvider.statusTextColor(context, item, brand, true);
                    for (int opacity = 0; opacity <= 0x55; opacity++) {
                        int gradient = ColorUtils.compositeColors(
                                ColorUtils.setAlphaComponent(brand, opacity), surface);
                        int painted = ColorUtils.compositeColors(fill, gradient);
                        assertTrue(semantic + " night=" + night + " brand="
                                        + Integer.toHexString(brand) + " opacity=" + opacity,
                                ColorUtils.calculateContrast(text, painted) >= 4.5);
                    }
                    int tinted = ColorUtils.compositeColors(
                            ColorUtils.setAlphaComponent(brand, 0x55), surface);
                    assertEquals("The 2x2 non-badge path is unchanged",
                            ExpressStatusColors.textOn(style.foreground, surface, tinted),
                            ExpressWidgetProvider.statusTextColor(context, item, brand, false));
                }
            }
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
                    R.drawable.widget_express_status_ordered_bg);
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
            assertEquals(0x1afbc02d,
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
