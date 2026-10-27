package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.Context;
import android.os.Looper;
import android.view.View;
import android.widget.ListView;
import android.widget.TextView;
import androidx.appcompat.app.AlertDialog;
import com.google.android.material.materialswitch.MaterialSwitch;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import me.pipi.deliveries.R;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.notification.ExpressLiveNotifications;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowDialog;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36, manifest = Config.NONE, application = Application.class, qualifiers = "mdpi",
        shadows = ExpressManagerInteractionTest.Repository.class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class ExpressManagerInteractionTest {
    @Implements(value = ExpressRepository.class, isInAndroidSdk = false)
    public static class Repository {
        static final List<String> phones = new CopyOnWriteArrayList<>();
        static final List<String> removed = new CopyOnWriteArrayList<>();
        static final AtomicInteger replays = new AtomicInteger();
        @Implementation protected List<String> phones(String source) { return new ArrayList<>(phones); }
        @Implementation protected void requestPendingNotificationReplay() { replays.incrementAndGet(); }
        @Implementation protected void unbindPhone(String phone, String source) {
            removed.add(phone);
            phones.remove(phone);
        }
    }

    @Before public void reset() {
        RuntimeEnvironment.setFontScale(1f);
        Repository.phones.clear();
        Repository.removed.clear();
        Repository.replays.set(0);
        RuntimeEnvironment.getApplication().getSharedPreferences("express_live_settings", Context.MODE_PRIVATE)
                .edit().clear().commit();
    }

    @Test public void scrollingKeepsTheLastBindingAndAddButtonReachable() throws Exception {
        Repository.phones.addAll(List.of("13800000001", "13800000002", "13800000003", "13800000004", "13800000005"));
        for (int[] window : new int[][]{{360, 640, 2}, {360, 480, 1}, {360, 360, 1}}) {
            RuntimeEnvironment.setFontScale(window[2]);
            try (ActivityController<ExpressManagerActivity> controller = open()) {
                ExpressManagerActivity activity = controller.get();
                layout(activity, window[0], window[1]);
                ListView list = activity.findViewById(android.R.id.list);
                assertTrue(list.getHeight() >= 64);
                assertEquals(1, list.getHeaderViewsCount());
                assertFalse(list.getAdapter().isEnabled(0));
                list.setSelection(5);
                layout(activity, window[0], window[1]);
                assertEquals(5, list.getLastVisiblePosition());
                assertEquals("13800000005", list.getItemAtPosition(5));
                View bind = activity.findViewById(R.id.btn_bind_phone);
                assertTrue(bind.getTop() >= 0);
                assertTrue(bind.getBottom() <= window[1]);
            }
        }
    }

    @Test public void headerSwitchesKeepIndependentPersistenceAndReplayCallbacks() throws Exception {
        try (ActivityController<ExpressManagerActivity> controller = open()) {
            ExpressManagerActivity activity = controller.get();
            layout(activity, 360, 640);
            MaterialSwitch pickup = activity.findViewById(R.id.live_pickup);
            MaterialSwitch delivery = activity.findViewById(R.id.live_delivery);
            assertTrue(pickup.isChecked());
            assertTrue(delivery.isChecked());
            assertEquals(0, Repository.replays.get());
            pickup.performClick();
            assertFalse(ExpressLiveNotifications.pickupEnabled(activity));
            assertTrue(ExpressLiveNotifications.deliveryEnabled(activity));
            delivery.performClick();
            assertFalse(ExpressLiveNotifications.deliveryEnabled(activity));
            assertEquals(2, Repository.replays.get());
        }
        try (ActivityController<ExpressManagerActivity> controller = open()) {
            layout(controller.get(), 360, 640);
            assertFalse(((MaterialSwitch) controller.get().findViewById(R.id.live_pickup)).isChecked());
            assertFalse(((MaterialSwitch) controller.get().findViewById(R.id.live_delivery)).isChecked());
            assertEquals(2, Repository.replays.get());
        }
    }

    @Test public void headerDoesNotShiftUnbindTargetsAndStaysVisibleWhenTheLastPhoneIsRemoved() throws Exception {
        Repository.phones.addAll(List.of("13800000001", "13800000002"));
        try (ActivityController<ExpressManagerActivity> controller = open()) {
            ExpressManagerActivity activity = controller.get();
            ListView list = activity.findViewById(android.R.id.list);
            for (String phone : List.of("13800000001", "13800000002")) {
                list.setSelection(1);
                layout(activity, 360, 640);
                assertEquals(phone, list.getItemAtPosition(1));
                View row = list.getChildAt(1 - list.getFirstVisiblePosition());
                assertEquals(phone, ((TextView) row.findViewById(R.id.phone_text)).getText().toString());
                row.findViewById(R.id.delete_phone).performClick();
                AlertDialog dialog = (AlertDialog) ShadowDialog.getLatestDialog();
                assertTrue(((TextView) dialog.findViewById(android.R.id.message)).getText().toString().contains(phone));
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
                await(() -> Repository.removed.contains(phone)
                        && list.getCount() == Repository.phones.size() + 1);
            }
            list.setSelection(0);
            layout(activity, 360, 640);
            assertEquals(List.of("13800000001", "13800000002"), Repository.removed);
            assertEquals(1, list.getCount());
            assertEquals(View.VISIBLE, list.getVisibility());
            assertEquals(View.VISIBLE, activity.findViewById(R.id.phone_empty).getVisibility());
            assertNotNull(activity.findViewById(R.id.live_pickup));
        }
    }

    private static ActivityController<ExpressManagerActivity> open() throws Exception {
        ActivityController<ExpressManagerActivity> controller = Robolectric.buildActivity(ExpressManagerActivity.class);
        controller.get().setTheme(R.style.AppTheme);
        controller.create().start().resume();
        ListView list = controller.get().findViewById(android.R.id.list);
        await(() -> list.getCount() == Repository.phones.size() + 1);
        return controller;
    }

    private static void layout(ExpressManagerActivity activity, int width, int height) {
        View root = activity.findViewById(R.id.express_manager_content_layout);
        root.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
        root.layout(0, 0, width, height);
    }

    private static void await(BooleanSupplier finished) throws Exception {
        long deadline = System.nanoTime() + 3_000_000_000L;
        do {
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            if (finished.getAsBoolean()) return;
            Thread.sleep(5);
        } while (System.nanoTime() < deadline);
        fail("Manager callback did not finish");
    }
}
