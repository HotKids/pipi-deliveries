package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.TextPaint;
import android.util.DisplayMetrics;
import android.util.TypedValue;
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

/**
 * Owner 2026-11-21 ("Lite 也加寄标签"): the Lite widgets carry Pipi's small gray 寄 tag at Pipi's
 * positions, after the status word on the 2×2 card and after the waybill tail on every 4×2 row,
 * as white 寄 on gray {@code #9A9AA0} with 3dp corners, shown only for an outgoing parcel.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public final class ExpressWidgetSenderTagTest {
    private static final int[] WIDE_COMPANY_IDS = {
            R.id.widget_express_company1, R.id.widget_express_company2, R.id.widget_express_company3};
    private static final int[] WIDE_SENDER_IDS = {
            R.id.widget_express_sender1, R.id.widget_express_sender2, R.id.widget_express_sender3};
    private static final int[] WIDE_STATUS_IDS = {
            R.id.widget_express_status1, R.id.widget_express_status2, R.id.widget_express_status3};

    @Test public void theCompactLayoutCarriesOneHiddenGrayTagRightAfterTheStatusWord() {
        assertCompactTag(RuntimeEnvironment.getApplication());
    }

    @Test public void everyWideRowCarriesOneHiddenGrayTagBetweenTheTailAndTheStatus() {
        assertWideTags(RuntimeEnvironment.getApplication());
    }

    /** The tag keeps its gray and white text when the host is dark. */
    @Test @Config(qualifiers = "night")
    public void bothLayoutsKeepTheGrayTagAtNight() {
        Context context = RuntimeEnvironment.getApplication();
        assertCompactTag(context);
        assertWideTags(context);
    }

    @Test public void wideRowsShowTheTagOnlyForAnOutgoingParcelAndAReapplyClearsIt()
            throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        List<ExpressItem> mixed = List.of(parcel(1, true), parcel(2, false), parcel(3, true));
        View root = render(context, "updateWide", R.layout.express_widget_4x2, mixed, 360, 220)
                .apply(context, new FrameLayout(context));
        int[] expected = {View.VISIBLE, View.GONE, View.VISIBLE};
        for (int index = 0; index < 3; index++) {
            assertEquals("row " + index, expected[index],
                    root.findViewById(WIDE_SENDER_IDS[index]).getVisibility());
            // The identity text stays the plain "承运商 尾号" with the tag beside it.
            String identity = ((TextView) root.findViewById(WIDE_COMPANY_IDS[index]))
                    .getText().toString();
            assertEquals(ExpressWidgetPresentation.rowIdentity(mixed.get(index)), identity);
            assertFalse(identity.contains("寄"));
        }
        // A receiving parcel in the first row and two hidden rows clear every stale tag.
        render(context, "updateWide", R.layout.express_widget_4x2,
                List.of(parcel(4, false)), 360, 220).reapply(context, root);
        for (int id : WIDE_SENDER_IDS) {
            assertEquals(View.GONE, root.findViewById(id).getVisibility());
        }
        render(context, "updateWide", R.layout.express_widget_4x2,
                mixed, 360, 220).reapply(context, root);
        render(context, "updateWide", R.layout.express_widget_4x2,
                List.of(), 360, 220).reapply(context, root);
        for (int id : WIDE_SENDER_IDS) {
            assertEquals("The empty card hides every tag", View.GONE,
                    root.findViewById(id).getVisibility());
        }
    }

    /**
     * Fourth review R4-NEW-08 ③ (owner 2026-11-23「报告里的都直接做」): as on Pipi, an extreme carrier name on a wide
     * row ellipsizes before the 寄 tag and the status capsule, also at a large font scale.
     */
    @Test public void aLongCarrierNameYieldsToTheTagAndTheStatusOnWideRows() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        for (float scale : new float[] {1.0f, 1.3f}) {
            RuntimeEnvironment.setFontScale(scale);
            try {
                List<ExpressItem> items = List.of(longCarrier(1, true), longCarrier(2, false), parcel(3, true));
                View root = render(context, "updateWide", R.layout.express_widget_4x2, items, 360, 220)
                        .apply(context, new FrameLayout(context));
                root.measure(View.MeasureSpec.makeMeasureSpec(dp(context, 360f), View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
                root.layout(0, 0, root.getMeasuredWidth(), root.getMeasuredHeight());
                int unspecified = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED);
                for (int index = 0; index < 3; index++) {
                    String label = "scale " + scale + " row " + index;
                    TextView identity = root.findViewById(WIDE_COMPANY_IDS[index]);
                    TextView status = root.findViewById(WIDE_STATUS_IDS[index]);
                    View line = (View) identity.getParent();
                    for (TextView kept : new TextView[] {root.findViewById(WIDE_SENDER_IDS[index]), status}) {
                        if (kept.getVisibility() == View.GONE) continue;
                        int laidOut = kept.getWidth();
                        kept.measure(unspecified, unspecified);
                        assertEquals(label + " keeps its natural width", kept.getMeasuredWidth(), laidOut);
                        assertTrue(label + " stays inside the row", kept.getRight() <= line.getWidth());
                    }
                    if (index < 2) {
                        assertTrue(label + " the carrier name ellipsizes", identity.getWidth()
                                < identity.getPaint().measureText(identity.getText().toString()));
                    }
                }
            } finally {
                RuntimeEnvironment.setFontScale(1.0f);
            }
        }
    }

    @Test public void theCompactCardShowsTheTagForAnOutgoingParcelAtEveryScale() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        float scaled = context.getResources().getDisplayMetrics().scaledDensity;
        // Scale 0.9 (clamped), 1.0 and 1.1 (clamped).
        for (int[] size : new int[][]{{130, 160}, {157, 189}, {201, 240}}) {
            String label = size[0] + "x" + size[1];
            ExpressItem sender = parcel(1, true);
            View root = render(context, "updateCompact", R.layout.express_widget_2x2,
                    List.of(sender), size[0], size[1]).apply(context, new FrameLayout(context));
            TextView tag = root.findViewById(R.id.widget_compact_sender);
            TextView status = root.findViewById(R.id.widget_priority_status);
            TextView company = root.findViewById(R.id.widget_compact_company);
            assertEquals(label, View.VISIBLE, tag.getVisibility());
            assertEquals(label, 12f, company.getTextSize() / scaled, 0.01f);
            assertEquals(label, 11f, tag.getTextSize() / scaled, 0.01f);
            ExpressWidgetLayout.Compact layout = ExpressWidgetLayout.compact(size[0], size[1]);
            assertEquals(label + " the status word steps down only for the tag",
                    ExpressWidgetProvider.compactStatusTextSp(context,
                            ExpressWidgetPresentation.statusText(sender), true, size[0], layout),
                    status.getTextSize() / scaled, 0.01f);
            // The carrier line stays plain.
            assertFalse(company.getText().toString().contains("寄"));

            // A receiving parcel reapplied onto the same views hides the tag and restores 20sp.
            render(context, "updateCompact", R.layout.express_widget_2x2,
                    List.of(parcel(2, false)), size[0], size[1]).reapply(context, root);
            assertEquals(label, View.GONE, tag.getVisibility());
            assertEquals(label, 20f, status.getTextSize() / scaled, 0.01f);

            render(context, "updateCompact", R.layout.express_widget_2x2,
                    List.of(sender), size[0], size[1]).reapply(context, root);
            assertEquals(label, View.VISIBLE, tag.getVisibility());
            render(context, "updateCompact", R.layout.express_widget_2x2,
                    List.of(), size[0], size[1]).reapply(context, root);
            assertEquals(label + " empty card", View.GONE, tag.getVisibility());
        }
    }

    @Test public void theCompactHeadlineFitsTheWholeTagAndOtherHeadlinesKeepTheirSize() {
        Context context = RuntimeEnvironment.getApplication();
        ExpressWidgetLayout.Compact standard = ExpressWidgetLayout.compact(180f, 189f);
        // A receiving parcel keeps the fixed size exactly.
        assertEquals(20f, ExpressWidgetProvider.compactStatusTextSp(
                context, "派送中", false, 160f, ExpressWidgetLayout.compact(160f, 189f)), 0f);
        // At a standard width the status word keeps 20sp beside the tag.
        assertEquals(20f, ExpressWidgetProvider.compactStatusTextSp(
                context, "派送中", true, 180f, standard), 0f);
        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        for (float width : new float[]{130f, 140f, 157f, 160f, 180f, 201f}) {
            ExpressWidgetLayout.Compact layout = ExpressWidgetLayout.compact(width, 189f);
            for (StatusSemantic semantic : new StatusSemantic[]{StatusSemantic.TRANSIT,
                    StatusSemantic.DELIVERY, StatusSemantic.WAITING_PICKUP,
                    StatusSemantic.COMPLETED}) {
                String status = ExpressWidgetPresentation.statusText(parcel(1, true, semantic));
                float sp = ExpressWidgetProvider.compactStatusTextSp(
                        context, status, true, width, layout);
                assertTrue(status + " at " + width + "dp", sp <= 20f && sp >= 14f);
                if (sp <= 14f) continue;
                TextPaint paint = new TextPaint(TextPaint.ANTI_ALIAS_FLAG);
                paint.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
                paint.setTextSize(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP,
                        ExpressWidgetProvider.compactSenderTextSp(layout), metrics));
                float tag = paint.measureText("寄") + 2f * context.getResources().getDimension(
                        R.dimen.express_widget_sender_tag_padding_horizontal)
                        + context.getResources().getDimension(R.dimen.express_widget_sender_tag_gap);
                paint.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
                paint.setTextSize(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sp, metrics));
                float available = (width - 2f * layout.paddingDp - layout.courierLogoSizeDp - 9f)
                        * metrics.density;
                assertTrue(status + " + 寄 tag fits at " + sp + "sp, " + width + "dp",
                        paint.measureText(status) + tag <= available);
            }
        }
    }

    private static void assertCompactTag(Context context) {
        View root = LayoutInflater.from(context).inflate(R.layout.express_widget_2x2, null);
        TextView tag = root.findViewById(R.id.widget_compact_sender);
        TextView status = root.findViewById(R.id.widget_priority_status);
        boolean night = (context.getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        assertEquals("寄", tag.getText().toString());
        assertEquals("寄件", tag.getContentDescription().toString());
        assertEquals(View.GONE, tag.getVisibility());
        assertEquals(night ? ExpressWidgetProvider.SENDER_TAG_DARK_INK
                : ExpressWidgetProvider.SENDER_TAG_LIGHT_INK, tag.getCurrentTextColor());
        assertEquals(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 11f,
                context.getResources().getDisplayMetrics()), tag.getTextSize(), 0.01f);
        assertEquals(1, tag.getMaxLines());
        // Right after the status word on the same line, before the carrier line.
        assertSame(status.getParent(), tag.getParent());
        ViewGroup line = (ViewGroup) status.getParent();
        assertEquals(line.indexOfChild(status) + 1, line.indexOfChild(tag));
        assertSame(root.findViewById(R.id.widget_compact_identity), line.getParent());
        assertGray(context, tag);
        int horizontal = context.getResources().getDimensionPixelSize(
                R.dimen.express_widget_sender_tag_padding_horizontal);
        assertEquals(horizontal, tag.getPaddingStart());
        assertEquals(horizontal, tag.getPaddingEnd());
        int vertical = context.getResources().getDimensionPixelSize(
                R.dimen.express_widget_sender_tag_padding_vertical);
        assertEquals(vertical, tag.getPaddingTop());
        assertEquals(vertical, tag.getPaddingBottom());
        assertEquals(context.getResources().getDimensionPixelSize(
                        R.dimen.express_widget_sender_tag_gap),
                ((ViewGroup.MarginLayoutParams) tag.getLayoutParams()).getMarginStart());
        // The status word shrinks first; the tag never does.
        assertEquals(1f, ((LinearLayout.LayoutParams) status.getLayoutParams()).weight, 0f);
        assertEquals(0f, ((LinearLayout.LayoutParams) tag.getLayoutParams()).weight, 0f);
    }

    private static void assertWideTags(Context context) {
        View root = LayoutInflater.from(context).inflate(
                R.layout.express_widget_4x2, new FrameLayout(context), false);
        boolean night = (context.getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        for (int index = 0; index < 3; index++) {
            String label = "row " + index;
            TextView identity = root.findViewById(WIDE_COMPANY_IDS[index]);
            TextView tag = root.findViewById(WIDE_SENDER_IDS[index]);
            TextView status = root.findViewById(WIDE_STATUS_IDS[index]);
            ViewGroup line = (ViewGroup) identity.getParent();
            assertSame(label, line, tag.getParent());
            assertSame(label, line, status.getParent());
            assertEquals(label, line.indexOfChild(identity) + 1, line.indexOfChild(tag));
            assertEquals(label, line.indexOfChild(tag) + 1, line.indexOfChild(status));

            assertEquals(label, View.GONE, tag.getVisibility());
            assertEquals("寄", tag.getText().toString());
            assertEquals("寄件", tag.getContentDescription().toString());
            assertEquals(night ? ExpressWidgetProvider.SENDER_TAG_DARK_INK
                    : ExpressWidgetProvider.SENDER_TAG_LIGHT_INK, tag.getCurrentTextColor());
            assertGray(context, tag);
            LinearLayout.LayoutParams params = (LinearLayout.LayoutParams) tag.getLayoutParams();
            assertEquals(context.getResources().getDimensionPixelSize(
                    R.dimen.express_widget_sender_tag_gap), params.getMarginStart());
            assertEquals("The tag never shrinks", 0f, params.weight, 0f);
            int horizontal = context.getResources().getDimensionPixelSize(
                    R.dimen.express_widget_sender_tag_padding_horizontal);
            assertEquals(horizontal, tag.getPaddingStart());
            assertEquals(horizontal, tag.getPaddingEnd());
            // Stepped down one notch (16dp / 10dp) below the 18dp / 11dp status capsule.
            assertEquals(dp(context, 16f), params.height);
            assertEquals(dp(context, 18f), status.getLayoutParams().height);
            assertEquals(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 10f,
                    context.getResources().getDisplayMetrics()), tag.getTextSize(), 0.01f);
            assertEquals("The tag shares the capsule's medium weight",
                    status.getTypeface().getWeight(), tag.getTypeface().getWeight());
            assertEquals(1, tag.getMaxLines());
            // The capsule keeps its own 6dp gap after the tag.
            assertEquals(dp(context, 6f),
                    ((ViewGroup.MarginLayoutParams) status.getLayoutParams()).getMarginStart());
        }
    }

    private static void assertGray(Context context, TextView tag) {
        boolean night = (context.getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        assertTrue(tag.getBackground() instanceof GradientDrawable);
        GradientDrawable fill = (GradientDrawable) tag.getBackground();
        assertEquals(night ? ExpressWidgetProvider.SENDER_TAG_DARK_FILL
                : ExpressWidgetProvider.SENDER_TAG_LIGHT_FILL, fill.getColor().getDefaultColor());
        assertEquals(dp(context, 3f), fill.getCornerRadius(), 0.01f);
    }

    private static RemoteViews render(Context context, String method, int layout,
            List<ExpressItem> items, int widthDp, int heightDp) throws Exception {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        var shadow = Shadows.shadowOf(manager);
        int widgetId = shadow.createWidget(
                ExpressWidgetHeaderGeometryTest.NoOpWidgetProvider.class, layout);
        Bundle options = new Bundle();
        options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, widthDp);
        options.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, widthDp);
        options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, heightDp);
        options.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, heightDp);
        manager.updateAppWidgetOptions(widgetId, options);
        Method update = ExpressWidgetProvider.class.getDeclaredMethod(method, Context.class,
                AppWidgetManager.class, int[].class, List.class);
        update.setAccessible(true);
        update.invoke(null, context, manager, new int[] {widgetId}, new ArrayList<>(items));
        Map<Integer, ?> infos = ReflectionHelpers.getField(shadow, "widgetInfos");
        return ReflectionHelpers.getField(infos.get(widgetId), "lastRemoteViews");
    }

    /** An unrecognized carrier code shows as is, so a long one fills the identity. */
    private static ExpressItem longCarrier(int row, boolean sender) {
        return new ExpressItem(row, "", "ZZ12345678" + row, "UNRECOGNIZEDCARRIERCODEWITHAVERYLONGNAME", "",
                StatusSemantic.TRANSIT, "运输中", "快件已到达转运中心", "", "[]", "", "interface5", "")
                .withAccountListMetadata("", 0L, sender);
    }

    private static ExpressItem parcel(int row, boolean sender) {
        return parcel(row, sender, StatusSemantic.TRANSIT);
    }

    private static ExpressItem parcel(int row, boolean sender, StatusSemantic semantic) {
        return new ExpressItem(row, "", "SF12345678" + row, "SF", "顺丰速运", semantic,
                "运输中", "快件已到达转运中心", "", "[]", "", "interface5", "")
                .withAccountListMetadata("", 0L, sender);
    }

    private static int dp(Context context, float value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
