package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import android.app.Application;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.graphics.Typeface;
import android.text.Spanned;
import android.text.TextPaint;
import android.text.style.ForegroundColorSpan;
import android.view.View;
import android.widget.FrameLayout;
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

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAppWidgetManager;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public final class ExpressWidgetHeaderThemeTest {
    @Test
    public void daytimePopulatedRemoteViewsUsesNightHostHeaderColors() throws Exception {
        assertCachedHeaderColors(false, true, 4);
    }

    @Test
    public void nighttimePopulatedRemoteViewsUsesDayHostHeaderColors() throws Exception {
        assertCachedHeaderColors(true, false, 4);
    }

    @Test
    public void daytimeEmptyRemoteViewsUsesNightHostHeaderColors() throws Exception {
        assertCachedHeaderColors(false, true, 0);
    }

    @Test
    public void nighttimeEmptyRemoteViewsUsesDayHostHeaderColors() throws Exception {
        assertCachedHeaderColors(true, false, 0);
    }

    private static void assertCachedHeaderColors(boolean generatedNight, boolean hostNight,
            int activeCount) throws Exception {
        RuntimeEnvironment.setQualifiers(generatedNight ? "+night" : "+notnight");
        Context context = RuntimeEnvironment.getApplication();
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ShadowAppWidgetManager shadow = Shadows.shadowOf(manager);
        int widgetId = shadow.createWidget(NoOpWidgetProvider.class,
                R.layout.express_widget_4x2);
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

        RuntimeEnvironment.setQualifiers(hostNight ? "+night" : "+notnight");
        Context host = RuntimeEnvironment.getApplication();
        View root = cached.apply(host, new FrameLayout(host));
        assertHeader(root, activeCount);
        cached.reapply(host, root);
        assertHeader(root, activeCount);
    }

    private static void assertHeader(View root, int activeCount) {
        TextView title = root.findViewById(R.id.widget_express_title);
        int countId = root.getResources().getIdentifier("widget_express_count", "id",
                root.getContext().getPackageName());
        TextView count = countId == 0 ? null : root.findViewById(countId);
        String fullTitle = root.getContext().getString(R.string.widget_express_count, activeCount);
        TextView countView = count == null ? title : count;
        int countStart = count == null ? fullTitle.lastIndexOf(' ') + 1 : 0;
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
                        com.google.android.material.R.attr.colorOnSurfaceVariant),
                paint.getColor());
        assertEquals(MaterialColors.getColor(title,
                com.google.android.material.R.attr.colorOnSurface), title.getCurrentTextColor());
        assertEquals(fullTitle, title.getText().toString()
                + (count == null ? "" : count.getText().toString()));
        if (count != null) {
            assertEquals(Typeface.BOLD, title.getTypeface().getStyle());
            assertEquals(Typeface.NORMAL, count.getTypeface().getStyle());
            assertEquals(title.getTextSize(), count.getTextSize(), 0.01f);
            assertEquals(title.getParent(), count.getParent());
        }
    }

    public static final class NoOpWidgetProvider extends AppWidgetProvider {}
}
