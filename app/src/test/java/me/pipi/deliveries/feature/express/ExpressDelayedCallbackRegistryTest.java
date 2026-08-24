package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;

import android.app.Activity;
import android.app.Application;
import android.os.Looper;
import android.view.View;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@LooperMode(LooperMode.Mode.PAUSED)
public final class ExpressDelayedCallbackRegistryTest {
    @Test
    public void clearingTemporaryViewCallbacksPreventsLateExecution() {
        ExpressDelayedCallbackRegistry callbacks = new ExpressDelayedCallbackRegistry();
        ActivityController<Activity> controller = Robolectric.buildActivity(Activity.class).setup();
        View hiddenView = new View(controller.get());
        controller.get().setContentView(hiddenView);
        AtomicInteger executions = new AtomicInteger();

        callbacks.post(hiddenView, executions::incrementAndGet, 1_000L);
        callbacks.post(hiddenView, executions::incrementAndGet, 2_000L);
        assertEquals(2, callbacks.pendingCount());

        callbacks.clear();
        assertEquals(0, callbacks.pendingCount());
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(3));
        assertEquals(0, executions.get());
        controller.destroy();
    }

    @Test
    public void executedCallbackIsNotRetainedByTheTemporaryViewRegistry() {
        ExpressDelayedCallbackRegistry callbacks = new ExpressDelayedCallbackRegistry();
        ActivityController<Activity> controller = Robolectric.buildActivity(Activity.class).setup();
        View hiddenView = new View(controller.get());
        controller.get().setContentView(hiddenView);
        AtomicInteger executions = new AtomicInteger();

        callbacks.post(hiddenView, executions::incrementAndGet, 100L);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100L));

        assertEquals(1, executions.get());
        assertEquals(0, callbacks.pendingCount());
        controller.destroy();
    }
}
