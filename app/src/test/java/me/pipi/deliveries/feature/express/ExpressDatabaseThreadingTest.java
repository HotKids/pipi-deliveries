package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.os.Looper;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import me.pipi.deliveries.R;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.widget.Express2x2WidgetProvider;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class,
        shadows = ExpressDatabaseThreadingTest.RepositoryShadow.class)
public class ExpressDatabaseThreadingTest {
    @Implements(value = ExpressRepository.class, isInAndroidSdk = false)
    public static class RepositoryShadow {
        static CountDownLatch read;
        static final AtomicBoolean mainThread = new AtomicBoolean();

        private static void recordRead() {
            mainThread.set(Looper.myLooper() == Looper.getMainLooper());
            read.countDown();
        }

        @Implementation protected ExpressItem find(long rowId) {
            recordRead();
            return null;
        }

        @Implementation protected List<ExpressItem> listVisible(String source) {
            recordRead();
            return Collections.emptyList();
        }

        @Implementation protected List<String> phones(String source) {
            recordRead();
            return Collections.emptyList();
        }
    }

    @Before public void reset() {
        RepositoryShadow.read = new CountDownLatch(1);
        RepositoryShadow.mainThread.set(false);
    }

    private void assertBackgroundRead() throws Exception {
        assertTrue(RepositoryShadow.read.await(3L, TimeUnit.SECONDS));
        assertFalse(RepositoryShadow.mainThread.get());
    }

    @Test public void detailLoadsItsOwnerAwayFromMainThread() throws Exception {
        ActivityController<ExpressDetailActivity> activity = Robolectric.buildActivity(ExpressDetailActivity.class);
        activity.get().setTheme(R.style.AppTheme);
        try {
            activity.create();
            assertBackgroundRead();
        } finally { activity.destroy(); }
    }

    @Test public void listLoadsItsRowsAwayFromMainThread() throws Exception {
        ActivityController<ExpressListActivity> activity = Robolectric.buildActivity(ExpressListActivity.class);
        activity.get().setTheme(R.style.AppTheme);
        try {
            activity.create();
            assertBackgroundRead();
        } finally { activity.destroy(); }
    }

    @Test public void managerLoadsItsPhonesAwayFromMainThread() throws Exception {
        ActivityController<ExpressManagerActivity> activity = Robolectric.buildActivity(ExpressManagerActivity.class);
        activity.get().setTheme(R.style.AppTheme);
        try {
            activity.create().start().resume();
            assertBackgroundRead();
        } finally { activity.pause().stop().destroy(); }
    }

}
