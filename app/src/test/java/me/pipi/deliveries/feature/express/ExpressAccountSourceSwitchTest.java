package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;

import java.lang.reflect.Proxy;

import me.pipi.deliveries.network.ExpressAccountSource;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowToast;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36, manifest = Config.NONE, application = Application.class,
        shadows = {ExpressManagerInteractionTest.Repository.class,
                ExpressManagerInteractionTest.Scheduler.class})
public final class ExpressAccountSourceSwitchTest {
    @Test
    public void commitFailureDoesNotUpdateInMemoryStateAndShowsSaveFailedToast() {
        Context base = RuntimeEnvironment.getApplication();
        ExpressManagerInteractionTest.Repository.replays.set(0);
        ExpressManagerInteractionTest.Scheduler.requests = 0;
        base.getSharedPreferences("express_account_source", Context.MODE_PRIVATE)
                .edit().putString("active_interface", ExpressAccountSource.V6).commit();
        assertEquals(ExpressAccountSource.V6, ExpressAccountSource.current(base));

        SharedPreferences real = base.getSharedPreferences("express_account_source", Context.MODE_PRIVATE);
        Context failingContext = new ContextWrapper(base) {
            @Override public Context getApplicationContext() { return this; }
            @Override public SharedPreferences getSharedPreferences(String name, int mode) {
                if (!"express_account_source".equals(name)) return super.getSharedPreferences(name, mode);
                return (SharedPreferences) Proxy.newProxyInstance(
                        SharedPreferences.class.getClassLoader(),
                        new Class<?>[]{SharedPreferences.class},
                        (proxy, method, args) -> {
                            if ("edit".equals(method.getName())) {
                                SharedPreferences.Editor editor = real.edit();
                                return Proxy.newProxyInstance(
                                        SharedPreferences.Editor.class.getClassLoader(),
                                        new Class<?>[]{SharedPreferences.Editor.class},
                                        (ep, em, ea) -> {
                                            if ("commit".equals(em.getName())) return false;
                                            Object res = em.invoke(editor, ea);
                                            return res == editor ? ep : res;
                                        });
                            }
                            return method.invoke(real, args);
                        });
            }
        };

        IllegalStateException error = assertThrows(
                IllegalStateException.class, () -> ExpressAccountSource.toggle(failingContext));
        assertTrue(error.getMessage().contains("无法切换接口"));
        assertEquals(ExpressAccountSource.V6, ExpressAccountSource.current(base));

        var controller = Robolectric.buildActivity(ExpressManagerActivity.class).setup();
        ExpressManagerActivity activity = controller.get();
        try {
            ShadowToast.reset();
            activity.switchAccountSource(failingContext);
            assertEquals(ExpressAccountSource.V6, ExpressAccountSource.current(base));
            assertEquals(0, ExpressManagerInteractionTest.Repository.replays.get());
            assertEquals(0, ExpressManagerInteractionTest.Scheduler.requests);
            assertEquals("无法切换接口，请稍后重试", ShadowToast.getTextOfLatestToast());

            ShadowToast.reset();
            activity.switchAccountSource();
            assertEquals(ExpressAccountSource.V5, ExpressAccountSource.current(base));
            assertEquals(1, ExpressManagerInteractionTest.Repository.replays.get());
            assertEquals(1, ExpressManagerInteractionTest.Scheduler.requests);
            assertTrue(String.valueOf(ShadowToast.getTextOfLatestToast()).contains("已切换至"));
        } finally {
            ExpressAccountSource.toggle(base);
            controller.destroy();
        }
    }
}
