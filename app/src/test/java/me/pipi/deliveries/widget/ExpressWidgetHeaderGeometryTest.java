package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.RemoteViews;
import android.widget.TextView;

import me.pipi.deliveries.R;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public final class ExpressWidgetHeaderGeometryTest {
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
