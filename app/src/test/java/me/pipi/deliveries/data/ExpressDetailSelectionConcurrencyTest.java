package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;

import java.lang.reflect.Field;
import java.lang.reflect.Proxy;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public final class ExpressDetailSelectionConcurrencyTest {
    @Test public void repositoriesPublishMemoryAndPreferencesInTheSameOrder() throws Exception {
        Context application = RuntimeEnvironment.getApplication();
        SharedPreferences stored = application.getSharedPreferences("express_detail_selection", 0);
        stored.edit().clear().commit();
        Field selections = ExpressRepository.class.getDeclaredField("detailSelections");
        selections.setAccessible(true);
        selections.set(null, null);
        CountDownLatch firstApply = new CountDownLatch(1);
        CountDownLatch releaseFirst = new CountDownLatch(1);
        AtomicBoolean blockFirst = new AtomicBoolean(true);
        SharedPreferences preferences = (SharedPreferences) Proxy.newProxyInstance(
                SharedPreferences.class.getClassLoader(), new Class<?>[]{SharedPreferences.class},
                (proxy, method, args) -> {
                    if (!"edit".equals(method.getName())) return method.invoke(stored, args);
                    SharedPreferences.Editor editor = stored.edit();
                    return Proxy.newProxyInstance(SharedPreferences.Editor.class.getClassLoader(),
                            new Class<?>[]{SharedPreferences.Editor.class}, (editorProxy, operation, values) -> {
                                if ("apply".equals(operation.getName()) && blockFirst.getAndSet(false)) {
                                    firstApply.countDown();
                                    if (!releaseFirst.await(5, TimeUnit.SECONDS)) {
                                        throw new AssertionError("First publication was never released");
                                    }
                                }
                                Object result = operation.invoke(editor, values);
                                return result instanceof SharedPreferences.Editor ? editorProxy : result;
                            });
                });
        Context context = new ContextWrapper(application) {
            @Override public Context getApplicationContext() { return this; }
            @Override public SharedPreferences getSharedPreferences(String name, int mode) {
                return "express_detail_selection".equals(name)
                        ? preferences : super.getSharedPreferences(name, mode);
            }
        };
        ExpressRepository first = new ExpressRepository(context);
        ExpressRepository second = new ExpressRepository(context);
        ExpressItem item = new ExpressItem(99, "", "STICKYTEST99", "", "", StatusSemantic.TRANSIT,
                "", "", "", "[]", "", "manual", "");
        AtomicReference<Throwable> failure = new AtomicReference<>();
        CountDownLatch secondStarted = new CountDownLatch(1);
        CountDownLatch secondFinished = new CountDownLatch(1);
        Thread writerA = new Thread(() -> {
            try { first.rememberDetailSelection(item, TimelineSlot.V6_QUERY); }
            catch (Throwable error) { failure.compareAndSet(null, error); }
        });
        Thread writerB = new Thread(() -> {
            secondStarted.countDown();
            try { second.rememberDetailSelection(item, TimelineSlot.K100_H5); }
            catch (Throwable error) { failure.compareAndSet(null, error); }
            finally { secondFinished.countDown(); }
        });
        writerA.start();
        try {
            assertTrue(firstApply.await(5, TimeUnit.SECONDS));
            writerB.start();
            assertTrue(secondStarted.await(5, TimeUnit.SECONDS));
            assertFalse("Another repository must wait for the shared publication boundary",
                    secondFinished.await(500, TimeUnit.MILLISECONDS));
        } finally {
            releaseFirst.countDown();
            writerA.join(5000);
            writerB.join(5000);
        }
        assertFalse(writerA.isAlive());
        assertFalse(writerB.isAlive());
        assertNull(failure.get());
        assertEquals(TimelineSlot.K100_H5, ExpressRepository.preferredDetailProvider(item));
        assertEquals(TimelineSlot.K100_H5, stored.getString("99\u0000STICKYTEST99", ""));
        selections.set(null, null);
        new ExpressRepository(application);
        assertEquals(TimelineSlot.K100_H5, ExpressRepository.preferredDetailProvider(item));
    }
}
