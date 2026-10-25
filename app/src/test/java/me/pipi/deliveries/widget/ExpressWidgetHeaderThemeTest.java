package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.Spanned;
import android.text.TextPaint;
import android.text.style.ForegroundColorSpan;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.RemoteViews;
import android.widget.TextView;

import com.google.android.material.color.MaterialColors;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import me.pipi.deliveries.R;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.shadows.ShadowAppWidgetManager;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        qualifiers = "port-notnight-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public final class ExpressWidgetHeaderThemeTest {
    @After public void restoreDayMode() {
        RuntimeEnvironment.setQualifiers("port-notnight-mdpi");
        RuntimeEnvironment.setFontScale(1f);
    }

    @Test public void largerSystemTextKeepsHeaderGlyphsCentered() throws Exception {
        for (int count : new int[] {0, 2, 12}) {
            assertCachedHeaderColors(false, true, count, 1.3f);
        }
    }

    @Test public void twoDigitCountStaysCenteredWhenReapplied() throws Exception {
        assertCachedHeaderColors(false, false, 12);
    }

    @Test
    public void daytimePopulatedRemoteViewsUsesNightHostHeaderColors() throws Exception {
        assertCachedHeaderColors(false, true, 2);
    }

    @Test
    public void nighttimePopulatedRemoteViewsUsesDayHostHeaderColors() throws Exception {
        assertCachedHeaderColors(true, false, 2);
    }

    @Test
    public void daytimeEmptyRemoteViewsUsesNightHostHeaderColors() throws Exception {
        assertCachedHeaderColors(false, true, 0);
    }

    @Test
    public void nighttimeEmptyRemoteViewsUsesDayHostHeaderColors() throws Exception {
        assertCachedHeaderColors(true, false, 0);
    }

    static void assertCachedHeaderColors(boolean generatedNight, boolean hostNight,
            int activeCount) throws Exception {
        assertCachedHeaderColors(generatedNight, hostNight, activeCount, 1f);
    }

    static void assertCachedHeaderColors(boolean generatedNight, boolean hostNight,
            int activeCount, float fontScale) throws Exception {
        for (int width : new int[] {300, 360}) {
            RuntimeEnvironment.setQualifiers(qualifiers(generatedNight));
            RuntimeEnvironment.setFontScale(fontScale);
            Context context = RuntimeEnvironment.getApplication();
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            ShadowAppWidgetManager shadow = Shadows.shadowOf(manager);
            int widgetId = shadow.createWidget(NoOpWidgetProvider.class,
                    R.layout.express_widget_4x2);
            Bundle options = new Bundle();
            options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, width);
            options.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, width);
            options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 220);
            options.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 220);
            manager.updateAppWidgetOptions(widgetId, options);
            List<ExpressItem> items = new ArrayList<>();
            for (int index = 0; index < activeCount; index++) {
                items.add(new ExpressItem(index + 1, "", "TEST" + index, "JD", "京东快递",
                        StatusSemantic.TRANSIT, "运输中", "Parcel in transit", "", "[]", "",
                        "interface5", ""));
            }
            Method update = ExpressWidgetProvider.class.getDeclaredMethod("updateWide",
                    Context.class, AppWidgetManager.class, int[].class, List.class);
            update.setAccessible(true);
            update.invoke(null, context, manager, new int[] { widgetId }, items);
            Map<Integer, ?> infos = ReflectionHelpers.getField(shadow, "widgetInfos");
            RemoteViews cached = ReflectionHelpers.getField(infos.get(widgetId), "lastRemoteViews");
            assertNotNull(cached);

            RuntimeEnvironment.setQualifiers(qualifiers(hostNight));
            RuntimeEnvironment.setFontScale(fontScale);
            Context host = RuntimeEnvironment.getApplication();
            View root = cached.apply(host, new FrameLayout(host));
            assertEquals("Exercise the host's actual font scale", fontScale,
                    root.getResources().getConfiguration().fontScale, .001f);
            WidgetTypographyProfile typography = CardSizeProfile.fromWidth(width).typography;
            assertHeader(root, activeCount, typography);
            cached.reapply(host, root);
            assertHeader(root, activeCount, typography);
        }
    }

    private static void assertHeader(View root, int activeCount,
            WidgetTypographyProfile typography) {
        TextView title = root.findViewById(R.id.widget_express_title);
        TextView count = root.findViewById(R.id.widget_express_count);
        assertNotNull(count);
        TextView countView = count;
        int countStart = 0;
        TextPaint paint = new TextPaint(countView.getPaint());
        paint.setColor(countView.getCurrentTextColor());
        if (countView.getText() instanceof Spanned) {
            Spanned text = (Spanned) countView.getText();
            for (ForegroundColorSpan span : text.getSpans(countStart, text.length(),
                    ForegroundColorSpan.class)) {
                span.updateDrawState(paint);
            }
        }
        assertEquals("count must resolve its color in the host's current theme",
                MaterialColors.getColor(title,
                        com.google.android.material.R.attr.colorOnSurface),
                paint.getColor());
        assertEquals(MaterialColors.getColor(title,
                com.google.android.material.R.attr.colorOnSurface), title.getCurrentTextColor());
        assertEquals("我的快递", title.getText().toString());
        assertEquals(Integer.toString(activeCount), count.getText().toString());
        assertEquals(700, title.getTypeface().getWeight());
        assertEquals(title.getTypeface().getWeight(), count.getTypeface().getWeight());
        assertEquals(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP,
                typography.textSize(WidgetTypographyProfile.Token.PRIMARY_TITLE),
                root.getResources().getDisplayMetrics()), title.getTextSize(), .01f);
        assertEquals(title.getTextSize(), count.getTextSize(), .01f);
        if (root.getResources().getConfiguration().fontScale > 1f) {
            float normalPx = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP,
                    typography.textSize(WidgetTypographyProfile.Token.PRIMARY_TITLE),
                    root.getResources().getDisplayMetrics());
            assertTrue("The large-font partition must actually enlarge the rendered text",
                    title.getTextSize() > normalPx * 1.15f);
        }
        assertEquals(title.getParent(), count.getParent());
        assertTrue(title.getIncludeFontPadding());
        ViewGroup header = (ViewGroup) title.getParent();
        TextView chevron = null;
        for (int index = 0; index < header.getChildCount(); index++) {
            if (header.getChildAt(index) instanceof TextView child
                    && child.getText().toString().equals("›")) chevron = child;
        }
        assertNotNull(chevron);
        assertEquals(title.getTypeface().getWeight(), chevron.getTypeface().getWeight());
        assertEquals(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP,
                typography.textSize(WidgetTypographyProfile.Token.PRIMARY_TITLE) * 1.25f,
                root.getResources().getDisplayMetrics()), chevron.getTextSize(), .01f);
        assertEquals(title.getCurrentTextColor(), chevron.getCurrentTextColor());
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO, chevron.getImportantForAccessibility());
        float density = root.getResources().getDisplayMetrics().density;
        assertEquals(Math.round(5f * density),
                ((ViewGroup.MarginLayoutParams) count.getLayoutParams()).getMarginStart());
        assertEquals(Math.round(4f * density),
                ((ViewGroup.MarginLayoutParams) chevron.getLayoutParams()).getMarginStart());
        assertInkCentered(header, title, count, chevron);
    }

    private static void assertInkCentered(ViewGroup header, TextView title,
            TextView count, TextView chevron) {
        header.measure(View.MeasureSpec.makeMeasureSpec(400, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.UNSPECIFIED);
        header.layout(0, 0, header.getMeasuredWidth(), header.getMeasuredHeight());
        LinearLayout originalHeader = legacyHeaderFromD27ea663(
                title.getContext(), count.getText().toString(), title.getTextSize());
        TextView originalTitle = (TextView) originalHeader.getChildAt(0);
        originalHeader.measure(View.MeasureSpec.makeMeasureSpec(400, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.UNSPECIFIED);
        originalHeader.layout(0, 0, originalHeader.getMeasuredWidth(), originalHeader.getMeasuredHeight());
        assertEquals("Keep the original title baseline", originalTitle.getBaseline(), title.getBaseline());
        assertEquals("Keep the original title position", originalTitle.getTop(), title.getTop());
        assertEquals("Keep the original title's absolute baseline",
                originalTitle.getTop() + originalTitle.getBaseline(),
                title.getTop() + title.getBaseline());
        assertEquals("Keep the original header height", originalHeader.getHeight(), header.getHeight());
        assertEquals("Only the suffix moves", 0f, title.getTranslationY(), 0f);
        Bitmap bitmap = Bitmap.createBitmap(header.getWidth(), header.getHeight(),
                Bitmap.Config.ARGB_8888);
        try {
            header.draw(new Canvas(bitmap));
            float center = visibleCenterY(bitmap, title);
            assertEquals("Count glyphs must center on the title", center,
                    visibleCenterY(bitmap, count), 1f);
            assertEquals("Chevron glyph must center on the title", center,
                    visibleCenterY(bitmap, chevron), 1f);
        } finally {
            bitmap.recycle();
        }
    }

    private static LinearLayout legacyHeaderFromD27ea663(Context context,
            String countText, float textSizePx) {
        // Independent baseline: d27ea663, express_widget_4x2.xml's header and
        // ExpressWidgetProvider.updateWide. Its title retains the separator space.
        LinearLayout header = new LinearLayout(context);
        header.setLayoutParams(new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(context);
        title.setText("我的快递 ");
        title.setTextColor(MaterialColors.getColor(title,
                com.google.android.material.R.attr.colorOnSurface));
        title.setTypeface(null, Typeface.BOLD);
        title.setTextSize(TypedValue.COMPLEX_UNIT_PX, textSizePx);
        header.addView(title, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView count = new TextView(context);
        count.setText(countText);
        count.setTextColor(MaterialColors.getColor(count,
                com.google.android.material.R.attr.colorOnSurfaceVariant));
        count.setTypeface(null, Typeface.NORMAL);
        count.setTextSize(TypedValue.COMPLEX_UNIT_PX, textSizePx);
        header.addView(count, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        ImageView arrow = new ImageView(context);
        arrow.setContentDescription(null);
        arrow.setScaleType(ImageView.ScaleType.FIT_CENTER);
        float density = context.getResources().getDisplayMetrics().density;
        LinearLayout.LayoutParams arrowLayout = new LinearLayout.LayoutParams(
                Math.round(16f * density), Math.round(16f * density));
        arrowLayout.setMarginStart(Math.round(2f * density));
        header.addView(arrow, arrowLayout);
        return header;
    }

    private static float visibleCenterY(Bitmap bitmap, TextView child) {
        int top = bitmap.getHeight(), bottom = -1;
        for (int y = 0; y < bitmap.getHeight(); y++) {
            for (int x = child.getLeft(); x < child.getRight(); x++) {
                if (Color.alpha(bitmap.getPixel(x, y)) < 16) continue;
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
            }
        }
        assertTrue("The host must render visible glyphs for " + child.getText(), bottom >= top);
        return (top + bottom) / 2f;
    }

    private static String qualifiers(boolean night) {
        return "port-" + (night ? "night" : "notnight") + "-mdpi";
    }

    public static final class NoOpWidgetProvider extends AppWidgetProvider {}
}
