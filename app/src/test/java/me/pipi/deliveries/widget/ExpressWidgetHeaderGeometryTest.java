package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.RemoteViews;
import android.widget.TextView;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import me.pipi.deliveries.R;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public final class ExpressWidgetHeaderGeometryTest {
    private static final String DETAIL = "快件已到达转运中心，正在准备转运。";

    @Test @Config(sdk = 35)
    public void wideRowsCenterArtworkOnVisibleGlyphsWithoutChangingTheirStyle() throws Exception {
        assertWideRowsCenterArtworkOnVisibleGlyphs();
    }

    @Test @Config(sdk = 35)
    public void expandedAndMissingDetailsRestoreCachedArtworkPlacement() throws Exception {
        assertWideRowsRestoreCachedArtworkPlacement();
    }

    static void assertWideRowsCenterArtworkOnVisibleGlyphs() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        for (int width : new int[] {300, 360}) {
            RemoteViews views = wideViews(context, 3, width, DETAIL);
            View root = views.apply(context, new FrameLayout(context));
            layout(root, width);
            for (int index = 1; index <= 3; index++) {
                View row = root.findViewById(id(context, "widget_express_row" + index));
                View logo = root.findViewById(id(context, "widget_express_logo" + index));
                TextView company = root.findViewById(id(context, "widget_express_company" + index));
                TextView status = root.findViewById(id(context, "widget_express_status" + index));
                TextView detail = root.findViewById(id(context, "widget_express_detail" + index));
                Rect ink = inkBounds(row, company);
                ink.union(inkBounds(row, status));
                ink.union(inkBounds(row, detail));
                assertEquals("The rendered title/detail ink must center on the carrier artwork",
                        ink.exactCenterY(), bounds(row, logo).exactCenterY(), 1f);
                assertTrue("The artwork must remain inside the original row envelope",
                        bounds(row, logo).top >= 0 && bounds(row, logo).bottom <= row.getHeight());
                assertEquals(dp(context, 40f), logo.getWidth());
                assertEquals(dp(context, 40f), logo.getHeight());
                assertArtworkUncropped(row, logo);
                assertEquals(dp(context, 18f), status.getHeight());
                assertEquals(dp(context, 6f),
                        ((ViewGroup.MarginLayoutParams) status.getLayoutParams()).getMarginStart());
                View column = (View) company.getParent().getParent();
                assertEquals(dp(context, 12f), bounds(row, column).left - bounds(row, logo).right);
                assertEquals(1, detail.getMaxLines());
                assertEquals(dp(context, 2f), ((ViewGroup.MarginLayoutParams) detail.getLayoutParams()).topMargin);
                float density = context.getResources().getDisplayMetrics().scaledDensity;
                assertEquals(width == 300 ? 17f : 16f, company.getTextSize() / density, .01f);
                assertEquals(13f, detail.getTextSize() / density, .01f);
                assertEquals(ExpressWidgetProvider.StatusStyle.forSemantic(StatusSemantic.TRANSIT).foreground,
                        status.getCurrentTextColor());
                ExpressWidgetRowPolicy.RowLayout expected = ExpressWidgetRowPolicy.calculate(3, 220f,
                        context.getResources().getDisplayMetrics().density,
                        CardSizeProfile.fromWidth(width).typography.lineBox(
                                ExpressWidgetRowPolicy.DEFAULT_ROW_CONTENT_HEIGHT_DP));
                assertEquals(expected.verticalPaddingPx, row.getPaddingTop());
                assertEquals(expected.verticalPaddingPx, row.getPaddingBottom());
                if (Build.VERSION.SDK_INT >= 31) assertEquals(expected.rowHeightPx, row.getHeight());
                assertInkFits(row, company, status, detail);
            }
        }
    }

    static void assertWideRowsRestoreCachedArtworkPlacement() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        RemoteViews initial = wideViews(context, 3, 360, DETAIL);
        View root = initial.apply(context, new FrameLayout(context));
        layout(root, 360);
        for (int count : new int[] {1, 2}) {
            View logo = root.findViewById(R.id.widget_express_logo1);
            ((View) logo.getParent()).setPadding(0, logo.getHeight(), 0, -logo.getHeight());
            wideViews(context, count, 360, DETAIL.repeat(4)).reapply(context, root);
            layout(root, 360);
            View row = root.findViewById(R.id.widget_express_row1);
            TextView company = root.findViewById(R.id.widget_express_company1);
            TextView detail = root.findViewById(R.id.widget_express_detail1);
            View column = (View) company.getParent().getParent();
            assertEquals("Expanded rows must retain top alignment", bounds(row, column).top,
                    bounds(row, logo).top);
            assertEquals(Gravity.TOP, ((LinearLayout) column.getParent()).getGravity()
                    & Gravity.VERTICAL_GRAVITY_MASK);
            assertTrue("The expanded partition must render real wrapped text", detail.getLineCount() > 1);
            assertEquals(count == 1 ? 6 : 2, detail.getMaxLines());
            assertEquals(0, ((View) logo.getParent()).getPaddingTop());
            assertEquals(0, ((View) logo.getParent()).getPaddingBottom());
            assertEquals(0f, logo.getTranslationY(), 0f);
            assertArtworkUncropped(row, logo);
            assertInkFits(row, company, root.findViewById(R.id.widget_express_status1), detail);
        }
        for (int count : new int[] {1, 2, 3}) {
            View logo = root.findViewById(R.id.widget_express_logo1);
            ((View) logo.getParent()).setPadding(0, logo.getHeight(), 0, -logo.getHeight());
            wideViews(context, count, 360, "").reapply(context, root);
            layout(root, 360);
            View row = root.findViewById(R.id.widget_express_row1);
            TextView company = root.findViewById(R.id.widget_express_company1);
            View column = (View) company.getParent().getParent();
            assertEquals(View.GONE, root.findViewById(R.id.widget_express_detail1).getVisibility());
            assertEquals("Missing details retain the original container center for " + count + " rows",
                    bounds(row, column).exactCenterY(), bounds(row, logo).exactCenterY(), 1f);
            assertEquals(Gravity.CENTER_VERTICAL, ((LinearLayout) column.getParent()).getGravity()
                    & Gravity.VERTICAL_GRAVITY_MASK);
            assertEquals(0f, logo.getTranslationY(), 0f);
            assertArtworkUncropped(row, logo);
        }
        initial.reapply(context, root);
        layout(root, 360);
        View row = root.findViewById(R.id.widget_express_row1);
        View logo = root.findViewById(R.id.widget_express_logo1);
        TextView company = root.findViewById(R.id.widget_express_company1);
        Rect ink = inkBounds(row, company);
        ink.union(inkBounds(row, root.findViewById(R.id.widget_express_status1)));
        ink.union(inkBounds(row, root.findViewById(R.id.widget_express_detail1)));
        assertEquals("Reappearing details must regain optical alignment", ink.exactCenterY(),
                bounds(row, logo).exactCenterY(), 1f);
    }

    private static RemoteViews wideViews(Context context, int count, int width, String detail) throws Exception {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        var shadow = Shadows.shadowOf(manager);
        int widgetId = shadow.createWidget(NoOpWidgetProvider.class, R.layout.express_widget_4x2);
        Bundle options = new Bundle();
        options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, width);
        options.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, width);
        options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 220);
        options.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 220);
        manager.updateAppWidgetOptions(widgetId, options);
        List<ExpressItem> items = new ArrayList<>();
        for (int index = 0; index < count; index++) items.add(new ExpressItem(index + 1, "", "TEST" + index,
                "JD", "京东快递", StatusSemantic.TRANSIT, "运输中", detail, "", "[]", "", "interface5", ""));
        Method update = ExpressWidgetProvider.class.getDeclaredMethod("updateWide", Context.class,
                AppWidgetManager.class, int[].class, List.class);
        update.setAccessible(true);
        update.invoke(null, context, manager, new int[] {widgetId}, items);
        Map<Integer, ?> infos = ReflectionHelpers.getField(shadow, "widgetInfos");
        return ReflectionHelpers.getField(infos.get(widgetId), "lastRemoteViews");
    }

    public static final class NoOpWidgetProvider extends AppWidgetProvider {
        @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {}
    }

    private static int id(Context context, String name) {
        return context.getResources().getIdentifier(name, "id", context.getPackageName());
    }

    private static void layout(View root, int widthDp) {
        Context context = root.getContext();
        int width = dp(context, widthDp), height = dp(context, 220f);
        root.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
        root.layout(0, 0, width, height);
    }

    private static Rect bounds(View root, View child) {
        Rect bounds = new Rect(0, 0, child.getWidth(), child.getHeight());
        ((ViewGroup) root).offsetDescendantRectToMyCoords(child, bounds);
        return bounds;
    }

    private static Rect inkBounds(View root, TextView text) {
        Bitmap bitmap = Bitmap.createBitmap(text.getWidth(), text.getHeight(), Bitmap.Config.ARGB_8888);
        Drawable background = text.getBackground();
        try {
            text.setBackground(null);
            text.draw(new Canvas(bitmap));
            int top = text.getHeight(), bottom = -1;
            for (int y = 0; y < bitmap.getHeight(); y++) for (int x = 0; x < bitmap.getWidth(); x++) {
                if (Color.alpha(bitmap.getPixel(x, y)) < 16) continue;
                top = Math.min(top, y); bottom = Math.max(bottom, y);
            }
            assertTrue("The host must render actual glyphs", bottom >= top);
            Rect box = bounds(root, text);
            return new Rect(box.left, box.top + top, box.right, box.top + bottom + 1);
        } finally { text.setBackground(background); bitmap.recycle(); }
    }

    private static void assertInkFits(View row, TextView... fields) {
        for (TextView text : fields) {
            Rect ink = inkBounds(row, text);
            assertTrue("Rendered glyphs must fit the existing row", ink.top >= 0 && ink.bottom <= row.getHeight());
        }
    }

    private static void assertArtworkUncropped(View row, View logo) {
        assertEquals(0, logo.getPaddingLeft()); assertEquals(0, logo.getPaddingRight());
        assertEquals(0, logo.getPaddingTop()); assertEquals(0, logo.getPaddingBottom());
        Bitmap reference = Bitmap.createBitmap(logo.getWidth(), logo.getHeight(), Bitmap.Config.ARGB_8888);
        Bitmap rendered = Bitmap.createBitmap(row.getWidth(), row.getHeight(), Bitmap.Config.ARGB_8888);
        try {
            logo.draw(new Canvas(reference)); row.draw(new Canvas(rendered));
            Rect placement = bounds(row, logo);
            assertTrue(placement.top >= 0 && placement.bottom <= row.getHeight());
            for (int y = 0; y < reference.getHeight(); y++) for (int x = 0; x < reference.getWidth(); x++) {
                assertEquals("The full carrier asset must reach the host without cropping",
                        Color.alpha(reference.getPixel(x, y)),
                        Color.alpha(rendered.getPixel(placement.left + x, placement.top + y)));
            }
        } finally { reference.recycle(); rendered.recycle(); }
    }

    @Test
    public void compactCourierAndTwoLineIdentityShareOneResponsiveVisualEnvelope() {
        Context context = RuntimeEnvironment.getApplication();
        View root = LayoutInflater.from(context).inflate(
                R.layout.express_widget_2x2, null, false);
        root.findViewById(R.id.widget_compact_content).setVisibility(View.VISIBLE);
        root.findViewById(R.id.widget_compact_empty).setVisibility(View.GONE);

        int width = dp(context, 201f);
        int height = dp(context, 240f);
        root.measure(
                View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
        root.layout(0, 0, width, height);

        View logo = root.findViewById(R.id.widget_compact_courier_logo);
        View identity = root.findViewById(R.id.widget_compact_identity);
        TextView status = root.findViewById(R.id.widget_priority_status);
        TextView company = root.findViewById(R.id.widget_compact_company);
        float scaledDensity = context.getResources().getDisplayMetrics().scaledDensity;

        assertTrue(logo.getLeft() < identity.getLeft());
        // 用户定 2026-09-05 晚：两行用自然行高不裁字，公司行上提 2dp，块底补 5dp；
        // logo 在整行里居中，所以 logo 中心对齐两行块的中心。
        assertNaturalTwoLineBlock(context, logo, identity, status, company);
        assertEquals(20f, status.getTextSize() / scaledDensity, 0.01f);
        assertEquals(12f, company.getTextSize() / scaledDensity, 0.01f);
    }

    @Test
    public void compactRemoteViewsKeepsBothTextRowsEqualToResponsiveLogoHeight() {
        Context context = RuntimeEnvironment.getApplication();
        RemoteViews views = new RemoteViews(
                context.getPackageName(), R.layout.express_widget_2x2);
        ExpressWidgetApi31.applyCompactHeaderSize(views, 38f);

        FrameLayout host = new FrameLayout(context);
        View root = views.apply(context, host);
        root.findViewById(R.id.widget_compact_content).setVisibility(View.VISIBLE);
        root.findViewById(R.id.widget_compact_empty).setVisibility(View.GONE);

        int width = dp(context, 201f);
        int height = dp(context, 240f);
        root.measure(
                View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
        root.layout(0, 0, width, height);

        View logo = root.findViewById(R.id.widget_compact_courier_logo);
        View identity = root.findViewById(R.id.widget_compact_identity);
        TextView status = root.findViewById(R.id.widget_priority_status);
        TextView company = root.findViewById(R.id.widget_compact_company);
        float scaledDensity = context.getResources().getDisplayMetrics().scaledDensity;

        assertEquals(dp(context, 38f), logo.getHeight());
        // 缩小的 logo 也只是在整行里居中，两行块仍是自然行高 + 5dp 底补偿。
        assertNaturalTwoLineBlock(context, logo, identity, status, company);
        assertEquals(20f, status.getTextSize() / scaledDensity, 0.01f);
        assertEquals(12f, company.getTextSize() / scaledDensity, 0.01f);
    }

    private static void assertNaturalTwoLineBlock(Context context, View logo,
            View identity, TextView status, TextView company) {
        assertEquals(0, status.getTop());
        assertEquals(status.getLayout().getHeight(), status.getHeight());
        assertEquals(company.getLayout().getHeight(), company.getHeight());
        assertEquals(status.getBottom() - dp(context, 2f), company.getTop());
        assertEquals(company.getBottom() + dp(context, 5f), identity.getHeight());
        assertEquals(dp(context, 5f), identity.getPaddingBottom());
        int logoCentre = logo.getTop() + logo.getBottom();
        int identityCentre = identity.getTop() + identity.getBottom();
        assertTrue("logo centre*2=" + logoCentre + ", identity centre*2=" + identityCentre,
                Math.abs(logoCentre - identityCentre) <= 2);
    }

    private static int dp(Context context, float value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
