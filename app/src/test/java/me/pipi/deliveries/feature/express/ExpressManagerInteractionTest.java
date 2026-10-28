package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.Context;
import android.os.Looper;
import android.os.SystemClock;
import android.view.InputEvent;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
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
import me.pipi.deliveries.background.ExpressScheduler;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.notification.ExpressLiveNotifications;
import me.pipi.deliveries.network.ExpressAccountSource;
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
import org.robolectric.util.ReflectionHelpers;

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

    @Implements(value = ExpressScheduler.class, isInAndroidSdk = false)
    public static class Scheduler {
        static int requests;
        @Implementation protected static java.util.UUID requestNow(Context context) {
            requests++;
            return java.util.UUID.randomUUID();
        }
    }

    @Before public void reset() {
        RuntimeEnvironment.setFontScale(1f);
        Repository.phones.clear();
        Repository.removed.clear();
        Repository.replays.set(0);
        RuntimeEnvironment.getApplication().getSharedPreferences("express_live_settings", Context.MODE_PRIVATE)
                .edit().clear().commit();
        RuntimeEnvironment.getApplication().getSharedPreferences("express_account_source", Context.MODE_PRIVATE)
                .edit().clear().commit();
    }

    @Test @Config(shadows = {Repository.class, Scheduler.class})
    public void hiddenTitleEntryKeepsItsTextAndPhysicalTripleTap() throws Exception {
        Scheduler.requests = 0;
        try (ActivityController<ExpressManagerActivity> controller = open()) {
            ExpressManagerActivity activity = controller.get();
            layout(activity, 360, 640);
            View toolbar = activity.findViewById(R.id.top_app_bar);
            assertFalse(toolbar.isImportantForAccessibility());
            ArrayList<View> titleViews = new ArrayList<>();
            toolbar.findViewsWithText(titleViews, activity.getString(R.string.manage_phone),
                    View.FIND_VIEWS_WITH_TEXT);
            assertEquals(1, titleViews.size());
            assertTrue(titleViews.get(0).isImportantForAccessibility());
            assertEquals(activity.getString(R.string.manage_phone),
                    titleViews.get(0).createAccessibilityNodeInfo().getText().toString());
            toolbar.performClick();
            toolbar.performClick();
            assertEquals(ExpressAccountSource.V6, ExpressAccountSource.current(activity));
            toolbar.performClick();
            assertEquals(ExpressAccountSource.V5, ExpressAccountSource.current(activity));
            assertEquals(1, Repository.replays.get());
            assertEquals(1, Scheduler.requests);
        }
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

    @Test @Config(sdk = {Config.OLDEST_SDK, 36})
    public void switchSummariesBelongToTheToggleTargetAndSpokenLabel() throws Exception {
        RuntimeEnvironment.setFontScale(2f);
        try (ActivityController<ExpressManagerActivity> controller = open()) {
            controller.visible().windowFocusChanged(true);
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            ExpressManagerActivity activity = controller.get();
            layout(activity, 360, 640);
            for (int[] setting : new int[][]{
                    {R.id.live_pickup, R.string.live_pickup, R.string.live_pickup_summary},
                    {R.id.live_delivery, R.string.live_delivery, R.string.live_delivery_summary}}) {
                MaterialSwitch toggle = activity.findViewById(setting[0]);
                TextView bodyLarge = new TextView(activity);
                bodyLarge.setTextAppearance(
                        com.google.android.material.R.style.TextAppearance_Material3_BodyLarge);
                assertEquals(bodyLarge.getTextSize(), toggle.getTextSize(), 0.01f);
                assertTrue(toggle.getText().toString().contains(activity.getString(setting[2])));
                AccessibilityNodeInfo node = toggle.createAccessibilityNodeInfo();
                assertTrue(node.isCheckable());
                assertTrue(node.isChecked());
                assertTrue(node.isClickable());
                assertTrue(node.getText().toString().contains(activity.getString(setting[1])));
                assertTrue(node.getText().toString().contains(activity.getString(setting[2])));
                assertEquals(0, node.getChildCount());
                assertTrue(toggle.getHeight() >= toggle.getTotalPaddingTop()
                        + toggle.getLayout().getHeight() + toggle.getTotalPaddingBottom());
                int callbacks = Repository.replays.get();
                float x = toggle.getCompoundPaddingLeft() + 8;
                float y = toggle.getTotalPaddingTop() + toggle.getLayout().getLineBottom(
                        toggle.getLayout().getLineCount() - 1) - 2;
                long now = SystemClock.uptimeMillis();
                MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x, y, 0);
                MotionEvent up = MotionEvent.obtain(now, now + 16, MotionEvent.ACTION_UP, x, y, 0);
                try {
                    assertTrue(toggle.dispatchTouchEvent(down));
                    assertTrue(toggle.dispatchTouchEvent(up));
                } finally {
                    down.recycle();
                    up.recycle();
                }
                Shadows.shadowOf(Looper.getMainLooper()).idle();
                assertFalse(toggle.isChecked());
                assertFalse(toggle.createAccessibilityNodeInfo().isChecked());
                assertEquals(callbacks + 1, Repository.replays.get());
            }
        }
    }

    @Test @Config(sdk = {Config.OLDEST_SDK, 36})
    public void keyboardAndDpadCanReachBothHeaderSwitchesFromTheToolbar() throws Exception {
        for (int key : new int[]{KeyEvent.KEYCODE_TAB, KeyEvent.KEYCODE_DPAD_DOWN}) {
            try (ActivityController<ExpressManagerActivity> controller = open()) {
                controller.visible().windowFocusChanged(true);
                Shadows.shadowOf(Looper.getMainLooper()).idle();
                ExpressManagerActivity activity = controller.get();
                layout(activity, 360, 640);
                View decor = activity.getWindow().getDecorView();
                ArrayList<View> navigation = new ArrayList<>();
                activity.findViewById(R.id.top_app_bar).findViewsWithText(navigation,
                        activity.getString(R.string.navigate_back), View.FIND_VIEWS_WITH_CONTENT_DESCRIPTION);
                assertEquals(1, navigation.size());
                View back = navigation.get(0);
                back.setFocusableInTouchMode(true);
                assertTrue(back.requestFocus());
                assertEquals(back, decor.findFocus());
                for (int toggleId : new int[]{R.id.live_pickup, R.id.live_delivery}) {
                    View toggle = activity.findViewById(toggleId);
                    for (int attempts = 0; attempts < 6 && decor.findFocus() != toggle; attempts++) {
                        sendKey(activity, key);
                    }
                    assertEquals("Key " + key + " must reach header toggle", toggle, decor.findFocus());
                    int callbacks = Repository.replays.get();
                    sendKey(activity, KeyEvent.KEYCODE_DPAD_CENTER);
                    assertEquals(callbacks + 1, Repository.replays.get());
                }
            }
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

    private static void sendKey(ExpressManagerActivity activity, int key) {
        View decor = activity.getWindow().getDecorView();
        Object viewRoot = ReflectionHelpers.callInstanceMethod(decor, "getViewRootImpl");
        // Robolectric's UiAutomation stops at View.dispatchKeyEvent and skips focus navigation.
        for (int action : new int[]{KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP}) {
            ReflectionHelpers.callInstanceMethod(viewRoot, "enqueueInputEvent",
                    ReflectionHelpers.ClassParameter.from(InputEvent.class, new KeyEvent(action, key)));
            Shadows.shadowOf(Looper.getMainLooper()).idle();
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
