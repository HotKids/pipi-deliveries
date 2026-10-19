package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.os.Looper;
import android.util.TypedValue;
import android.view.LayoutInflater;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.view.ContextThemeWrapper;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.ColorUtils;

import com.google.android.material.appbar.MaterialToolbar;
import com.google.android.material.color.MaterialColors;
import com.google.android.material.textfield.TextInputLayout;

import java.lang.reflect.Method;
import java.time.Duration;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.TimeUnit;

import me.pipi.deliveries.R;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, application = Application.class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public final class ExpressUiAccessibilityTest {
    @Test
    public void sendingCodeKeepsItsOwnProgressAndDisablesBothActions() {
        ActivityController<ExpressLoginActivity> controller = login();
        ExpressLoginActivity activity = controller.get();
        activity.findViewById(R.id.send_code_button).performClick();
        assertEquals(activity.getString(R.string.sending_code),
                ((TextView) activity.findViewById(R.id.send_code_button)).getText().toString());
        assertEquals(activity.getString(R.string.card_sub_btn_bind_txt),
                ((TextView) activity.findViewById(R.id.btn_bind_phone)).getText().toString());
        assertFalse(activity.findViewById(R.id.send_code_button).isEnabled());
        assertFalse(activity.findViewById(R.id.btn_bind_phone).isEnabled());
        controller.pause().stop().destroy();
    }

    @Test
    public void bindingShowsProgressOnTheBindingActionAndKeepsResendCountdown() {
        ActivityController<ExpressLoginActivity> controller = login();
        ExpressLoginActivity activity = controller.get();
        invoke(activity, "startResendCountdown", new Class<?>[] {long.class}, 30_000L);
        String countdown = ((TextView) activity.findViewById(R.id.send_code_button))
                .getText().toString();
        activity.findViewById(R.id.btn_bind_phone).performClick();
        assertEquals("绑定中…", ((TextView) activity.findViewById(R.id.btn_bind_phone))
                .getText().toString());
        assertEquals(countdown, ((TextView) activity.findViewById(R.id.send_code_button))
                .getText().toString());
        assertFalse(activity.findViewById(R.id.phone_input).isEnabled());
        assertFalse(activity.findViewById(R.id.code_input).isEnabled());
        controller.pause().stop().destroy();
    }

    @Test
    public void countdownExpiryCannotEnableResendDuringPendingBinding() {
        ActivityController<ExpressLoginActivity> controller = login();
        ExpressLoginActivity activity = controller.get();
        invoke(activity, "startResendCountdown", new Class<?>[] {long.class}, 1L);
        activity.findViewById(R.id.btn_bind_phone).performClick();
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(2));
        assertFalse(activity.findViewById(R.id.send_code_button).isEnabled());
        assertFalse(activity.findViewById(R.id.btn_bind_phone).isEnabled());
        invoke(activity, "setBusy", new Class<?>[] {boolean.class}, false);
        assertTrue(activity.findViewById(R.id.send_code_button).isEnabled());
        assertEquals(activity.getString(R.string.card_sub_btn_bind_txt),
                ((TextView) activity.findViewById(R.id.btn_bind_phone)).getText().toString());
        controller.pause().stop().destroy();
    }

    @Test
    public void detailActionsRemainReadableAndTouchSizedAtLargeText() {
        Context context = themedContext(2f);
        View root = LayoutInflater.from(context).inflate(R.layout.activity_express_detail, null);
        TextView waybill = root.findViewById(R.id.detail_waybill);
        TextView hotline = root.findViewById(R.id.detail_hotline_value);
        String fullLabel = "Carrier: JD026505915826112345678901234567890";
        waybill.setText(fullLabel);
        hotline.setText("950616");
        root.findViewById(R.id.detail_hotline).setVisibility(View.VISIBLE);
        measure(root, 320, 1000);
        assertTrue(waybill.getHeight() >= dp(context, 48));
        assertTrue(hotline.getHeight() >= dp(context, 48));
        assertTrue(hotline.getWidth() >= dp(context, 48));
        assertEquals(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 15f,
                context.getResources().getDisplayMetrics()), waybill.getTextSize(), 0.1f);
        assertTrue("waybill width=" + waybill.getWidth() + ", text width="
                + waybill.getPaint().measureText(fullLabel) + ", maxLines=" + waybill.getMaxLines(),
                waybill.getLineCount() > 1);
        assertEquals(fullLabel.length(), waybill.getLayout().getLineEnd(waybill.getLineCount() - 1));
        assertEquals(0, waybill.getLayout().getEllipsisCount(waybill.getLineCount() - 1));
        assertNotNull(waybill.getCompoundDrawablesRelative()[2]);
    }

    @Test
    public void searchErrorGrowsBelowTheInputAndHomeTitleKeepsItsOwnHierarchy() {
        ActivityController<AppCompatActivity> controller = Robolectric.buildActivity(AppCompatActivity.class);
        controller.get().setTheme(R.style.AppTheme);
        controller.create().start().resume().visible();
        Context context = themedContext(2f);
        View root = LayoutInflater.from(context).inflate(R.layout.activity_express_list, null);
        controller.get().setContentView(root);
        TextInputLayout field = root.findViewById(R.id.home_query_container);
        TextView input = root.findViewById(R.id.home_query_input);
        field.setStartIconOnClickListener(ignored -> {});
        measure(root, 320, 1000);
        int originalHeight = field.getHeight();
        assertTrue(input.getHeight() >= dp(context, 48));
        assertEquals(dp(context, 24), field.getBoxCornerRadiusTopStart(), 0.1f);
        field.setError("Check the waybill number and enter at least six characters.");
        measure(root, 320, 1000);
        TextView error = field.findViewById(com.google.android.material.R.id.textinput_error);
        assertNotNull(error);
        assertTrue(field.getHeight() > originalHeight);
        android.graphics.Rect errorBounds = new android.graphics.Rect();
        error.getDrawingRect(errorBounds);
        field.offsetDescendantRectToMyCoords(error, errorBounds);
        assertTrue(errorBounds.bottom <= field.getHeight());
        assertEquals(error.getText().length(), error.getLayout().getLineEnd(error.getLineCount() - 1));
        View searchIcon = field.findViewById(com.google.android.material.R.id.text_input_start_icon);
        android.graphics.Rect iconBounds = new android.graphics.Rect();
        searchIcon.getDrawingRect(iconBounds);
        field.offsetDescendantRectToMyCoords(searchIcon, iconBounds);
        android.graphics.Rect inputBounds = new android.graphics.Rect();
        input.getDrawingRect(inputBounds);
        field.offsetDescendantRectToMyCoords(input, inputBounds);
        assertTrue(inputBounds.left + input.getCompoundPaddingLeft() >= iconBounds.right);

        Context normal = themedContext(1f);
        View normalRoot = LayoutInflater.from(normal).inflate(R.layout.activity_express_list, null);
        measure(normalRoot, 360, 800);
        MaterialToolbar toolbar = normalRoot.findViewById(R.id.top_app_bar);
        TextView title = null;
        for (int i = 0; i < toolbar.getChildCount(); i++) {
            if (toolbar.getChildAt(i) instanceof TextView) title = (TextView) toolbar.getChildAt(i);
        }
        assertNotNull(title);
        assertEquals(dp(normal, 64), toolbar.getHeight());
        assertEquals(dp(normal, 24), title.getLeft());
        assertEquals(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 22f,
                normal.getResources().getDisplayMetrics()), title.getTextSize(), 0.1f);
        controller.pause().stop().destroy();
    }

    @Test
    public void headerActionsCopyOnlyTheWaybillAndOpenTheDialer() {
        ExpressDetailActivity activity = detail();
        invoke(activity, "renderHeader", new Class<?>[] {
                String.class, String.class, String.class, String.class, StatusSemantic.class},
                "JD", "京东快递", "JD0265059158261", "运输中", StatusSemantic.TRANSIT);
        View waybill = activity.findViewById(R.id.detail_waybill);
        View hotline = activity.findViewById(R.id.detail_hotline_value);
        assertClickLabel(waybill, activity.getString(R.string.copy_waybill));
        assertClickLabel(hotline, "拨打客服电话");
        assertTrue(waybill.performAccessibilityAction(AccessibilityNodeInfo.ACTION_CLICK, null));
        ClipboardManager clipboard = activity.getSystemService(ClipboardManager.class);
        assertEquals("JD0265059158261", clipboard.getPrimaryClip().getItemAt(0).getText().toString());
        assertTrue(hotline.performAccessibilityAction(AccessibilityNodeInfo.ACTION_CLICK, null));
        Intent dial = Shadows.shadowOf(activity).getNextStartedActivity();
        assertEquals(Intent.ACTION_DIAL, dial.getAction());
        assertEquals("tel:950616", dial.getDataString());
    }

    @Test
    public void timelineSecondaryTextResolvesTheCurrentThemeInLightAndDark() {
        for (String mode : new String[] {"+notnight", "+night"}) {
            RuntimeEnvironment.setQualifiers(mode);
            ExpressDetailActivity activity = detail();
            ExpressTimeline.Track track = ExpressTimeline.parse(
                    "[{\"time\":\"2026-10-19 12:30:00\",\"context\":\"Parcel in transit\"}]", "", "").get(0);
            LinearLayout row = (LinearLayout) invoke(activity, "buildTrackRow",
                    new Class<?>[] {ExpressTimeline.Track.class, boolean.class, boolean.class},
                    track, false, true);
            int secondary = MaterialColors.getColor(row,
                    com.google.android.material.R.attr.colorOnSurfaceVariant);
            LinearLayout times = (LinearLayout) row.getChildAt(0);
            assertEquals(secondary, ((TextView) times.getChildAt(0)).getCurrentTextColor());
            assertEquals(secondary, ((TextView) times.getChildAt(1)).getCurrentTextColor());
            assertEquals(secondary, ((TextView) row.getChildAt(2)).getCurrentTextColor());
            assertTrue(ColorUtils.calculateContrast(secondary, MaterialColors.getColor(row,
                    com.google.android.material.R.attr.colorSurface)) >= 4.5);
        }
    }

    private static ActivityController<ExpressLoginActivity> login() {
        ActivityController<ExpressLoginActivity> controller = Robolectric
                .buildActivity(ExpressLoginActivity.class).setup();
        ExpressLoginActivity activity = controller.get();
        ReflectionHelpers.setField(activity, "worker", new PendingExecutor());
        ((TextView) activity.findViewById(R.id.phone_input)).setText("13800000000");
        ((TextView) activity.findViewById(R.id.code_input)).setText("123456");
        return controller;
    }

    private static ExpressDetailActivity detail() {
        ExpressDetailActivity activity = Robolectric.buildActivity(ExpressDetailActivity.class).get();
        activity.setTheme(R.style.AppTheme);
        activity.setContentView(R.layout.activity_express_detail);
        ReflectionHelpers.setField(activity, "statusView", activity.findViewById(R.id.detail_status));
        ReflectionHelpers.setField(activity, "waybillView", activity.findViewById(R.id.detail_waybill));
        ReflectionHelpers.setField(activity, "hotlineView", activity.findViewById(R.id.detail_hotline_value));
        ReflectionHelpers.setField(activity, "hotlineRow", activity.findViewById(R.id.detail_hotline));
        ReflectionHelpers.setField(activity, "timeline", activity.findViewById(R.id.timeline));
        return activity;
    }

    private static Context themedContext(float fontScale) {
        Context application = RuntimeEnvironment.getApplication();
        Configuration configuration = new Configuration(application.getResources().getConfiguration());
        configuration.fontScale = fontScale;
        return new ContextThemeWrapper(application.createConfigurationContext(configuration), R.style.AppTheme);
    }

    private static void assertClickLabel(View view, String expected) {
        for (AccessibilityNodeInfo.AccessibilityAction action :
                view.createAccessibilityNodeInfo().getActionList()) {
            if (action.getId() == AccessibilityNodeInfo.ACTION_CLICK) {
                assertEquals(expected, action.getLabel());
                return;
            }
        }
        fail("Missing click accessibility action");
    }

    private static void measure(View view, int widthDp, int heightDp) {
        for (int pass = 0; pass < 3; pass++) {
            view.measure(View.MeasureSpec.makeMeasureSpec(dp(view.getContext(), widthDp), View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(dp(view.getContext(), heightDp), View.MeasureSpec.EXACTLY));
            view.layout(0, 0, view.getMeasuredWidth(), view.getMeasuredHeight());
            Shadows.shadowOf(Looper.getMainLooper()).idle();
        }
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    private static Object invoke(Object target, String name, Class<?>[] parameters, Object... arguments) {
        try {
            Method method = target.getClass().getDeclaredMethod(name, parameters);
            method.setAccessible(true);
            return method.invoke(target, arguments);
        } catch (ReflectiveOperationException failure) {
            throw new AssertionError(failure);
        }
    }

    private static final class PendingExecutor extends AbstractExecutorService {
        @Override public void execute(Runnable task) {}
        @Override public void shutdown() {}
        @Override public List<Runnable> shutdownNow() { return Collections.emptyList(); }
        @Override public boolean isShutdown() { return false; }
        @Override public boolean isTerminated() { return false; }
        @Override public boolean awaitTermination(long timeout, TimeUnit unit) { return false; }
    }
}
