package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.Context;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import me.pipi.deliveries.R;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressAccountSource;
import me.pipi.deliveries.network.ExpressQueryCancellation;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class)
public final class ExpressManualPreviewTest {
    @Test
    public void partialShowsFooterCompleteHidesItAndStoppedPageRejectsLatePreview() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        String source = ExpressAccountSource.bindingSource(context);
        ExpressQueryResult complete = result("已揽收", "v4_query");
        ActivityController<ExpressDetailActivity> controller = Robolectric.buildActivity(
                ExpressDetailActivity.class, ExpressDetailActivity.transientPickerPreviewIntent(
                        context, complete, "", source));
        ExpressDetailActivity activity = controller.get();
        activity.setTheme(R.style.AppTheme);
        controller.create().start().resume();
        ((java.util.concurrent.ExecutorService) field(activity, "worker", null))
                .submit(() -> { }).get(3, java.util.concurrent.TimeUnit.SECONDS);
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        ExpressQueryCancellation cancellation = new ExpressQueryCancellation(15000L);
        field(activity, "firstManualQueryCancellation", cancellation);
        field(activity, "firstManualQueryInFlight", true);
        Method publish = ExpressDetailActivity.class.getDeclaredMethod(
                "publishFirstManualPreview", ExpressQueryResult.class, ExpressQueryCancellation.class);
        publish.setAccessible(true);
        ExpressQueryResult partial = result("运输中", "v6_query");
        publish.invoke(activity, partial, cancellation);
        assertTrue(hasText(activity.findViewById(R.id.timeline), "完整轨迹加载中"));
        assertNull(ExpressRepository.get(context).findByWaybill(complete.waybill, source));
        publish.invoke(activity, complete, cancellation);
        assertFalse(hasText(activity.findViewById(R.id.timeline), "完整轨迹加载中"));
        assertTrue((Boolean) field(activity, "firstManualQueryInFlight", null));
        assertNull(ExpressRepository.get(context).findByWaybill(complete.waybill, source));
        controller.pause().stop();
        assertTrue(cancellation.isCancelled());
        publish.invoke(activity, partial, cancellation);
        assertSame(complete, field(activity, "previewResult", null));
        controller.destroy();
    }

    private static Object field(Object target, String name, Object value) throws Exception {
        Field field = ExpressDetailActivity.class.getDeclaredField(name);
        field.setAccessible(true);
        if (value != null) field.set(target, value);
        return field.get(target);
    }

    private static boolean hasText(View view, String text) {
        if (view instanceof TextView && text.contentEquals(((TextView) view).getText())) return true;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) if (hasText(group.getChildAt(i), text)) return true;
        }
        return false;
    }

    private static ExpressQueryResult result(String detail, String provider) {
        return new ExpressQueryResult("SYNTHETICPREVIEW123456", "ZTO", "中通快递",
                StatusSemantic.TRANSIT, "2026-09-09 12:00:00", detail,
                "[{\"time\":\"2026-09-09 12:00:00\",\"context\":\"" + detail + "\"}]",
                "", "", provider);
    }
}
