package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.RemoteViews;

import java.lang.reflect.Method;
import java.util.List;
import java.util.Map;

import me.pipi.deliveries.R;
import me.pipi.deliveries.feature.express.ExpressListActivity;
import me.pipi.deliveries.model.ExpressItem;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

/**
 * G-MED-22 (2026-11-20 review): tapping an empty widget opens the list with its query field focused, on the 4×2 as on
 * the 2×2 (and as Pipi and iOS do); the 4×2 header still opens the plain list.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class)
public final class ExpressWidgetEmptyTapTest {
    @Test public void theEmptyWideBodyOpensTheFocusedQuery() throws Exception {
        View root = emptyWidget(false);
        assertFocusesQuery(tap(root, R.id.widget_express_empty));
        assertFocusesQuery(tap(root, R.id.widget_express_search));
        Intent header = tap(root, R.id.widget_express_header);
        assertEquals(ExpressListActivity.class.getName(), header.getComponent().getClassName());
        assertFalse("The header opens the plain list",
                header.getBooleanExtra(ExpressListActivity.EXTRA_FOCUS_QUERY, false));
    }

    @Test public void theEmptyCompactBodyStillOpensTheFocusedQuery() throws Exception {
        View root = emptyWidget(true);
        assertFocusesQuery(tap(root, R.id.widget_compact_empty));
        assertFocusesQuery(tap(root, R.id.widget_compact_empty_search));
    }

    private static void assertFocusesQuery(Intent started) {
        assertEquals(ExpressListActivity.class.getName(), started.getComponent().getClassName());
        assertTrue("An empty widget's tap focuses the query field",
                started.getBooleanExtra(ExpressListActivity.EXTRA_FOCUS_QUERY, false));
    }

    private static Intent tap(View root, int id) {
        Application application = RuntimeEnvironment.getApplication();
        Shadows.shadowOf(application).clearNextStartedActivities();
        View target = root.findViewById(id);
        assertNotNull(target);
        assertTrue(target.performClick());
        Intent started = Shadows.shadowOf(application).getNextStartedActivity();
        assertNotNull("The tap starts an activity", started);
        return started;
    }

    private static View emptyWidget(boolean compact) throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        var shadow = Shadows.shadowOf(manager);
        int widgetId = shadow.createWidget(ExpressWidgetHeaderGeometryTest.NoOpWidgetProvider.class,
                compact ? R.layout.express_widget_2x2 : R.layout.express_widget_4x2);
        Method update = ExpressWidgetProvider.class.getDeclaredMethod(
                compact ? "updateCompact" : "updateWide", Context.class,
                AppWidgetManager.class, int[].class, List.class);
        update.setAccessible(true);
        update.invoke(null, context, manager, new int[]{widgetId}, List.<ExpressItem>of());
        Map<Integer, ?> infos = ReflectionHelpers.getField(shadow, "widgetInfos");
        RemoteViews views = ReflectionHelpers.getField(infos.get(widgetId), "lastRemoteViews");
        return views.apply(context, new FrameLayout(context));
    }
}
