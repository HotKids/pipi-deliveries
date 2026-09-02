package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;
import android.view.Gravity;
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
        assertEquals(logo.getTop(), identity.getTop());
        assertEquals(logo.getBottom(), identity.getBottom());
        assertEquals(logo.getHeight(), identity.getHeight());
        assertEquals(0, status.getTop());
        assertEquals(identity.getHeight(), company.getBottom());
        assertEquals(logo.getHeight(), status.getHeight() + company.getHeight());
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
        assertEquals(logo.getHeight(), identity.getHeight());
        assertEquals(logo.getHeight(), status.getHeight() + company.getHeight());
        assertEquals(dp(context, 24f), status.getLineHeight());
        assertEquals(dp(context, 14f), company.getLineHeight());
        assertTrue("status height=" + status.getHeight()
                        + ", lineHeight=" + status.getLineHeight(),
                status.getHeight() >= status.getLineHeight());
        assertTrue("company height=" + company.getHeight()
                        + ", lineHeight=" + company.getLineHeight(),
                company.getHeight() >= company.getLineHeight());
        assertEquals(Gravity.CENTER_VERTICAL,
                status.getGravity() & Gravity.VERTICAL_GRAVITY_MASK);
        assertEquals(Gravity.CENTER_VERTICAL,
                company.getGravity() & Gravity.VERTICAL_GRAVITY_MASK);
        assertEquals(20f, status.getTextSize() / scaledDensity, 0.01f);
        assertEquals(12f, company.getTextSize() / scaledDensity, 0.01f);
    }

    private static int dp(Context context, float value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
