package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import android.app.Application;
import android.content.Context;
import android.os.Looper;
import android.view.View;
import android.widget.EditText;
import android.widget.TextView;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import me.pipi.deliveries.R;
import me.pipi.deliveries.data.ExpressAutomaticDetailPersistenceTest.SyntheticSecretBox;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressPhoneBindingPolicy;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.network.ExpressAccountSource;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.shadows.ShadowToast;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

/**
 * G-HIGH-18 (2026-11-20 review): the binding page shows a failure's own text only when it is user copy, and a page
 * that has gone away while its request ran shows nothing.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, application = Application.class, shadows = SyntheticSecretBox.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressLoginFailureCopyTest {
    private ActivityController<ExpressLoginActivity> controller;
    private ExpressLoginActivity activity;

    @Before public void setUp() {
        Context context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        controller = Robolectric.buildActivity(ExpressLoginActivity.class).setup();
        activity = controller.get();
        ShadowToast.reset();
    }

    @After public void tearDown() {
        ((ExecutorService) ReflectionHelpers.getField(activity, "worker")).shutdownNow();
    }

    @Test public void aPlatformFailureShowsTheBindFallbackInsteadOfItsEnglishText() {
        inlineFailure(new IllegalStateException(
                "Unable to resolve host \"gateway.example\": No address associated with hostname"));
        assertEquals(ExpressToastCopy.BIND_FAILED, errorText());
        inlineFailure(new IllegalArgumentException(new org.json.JSONException("Value <html> cannot be converted")));
        assertEquals(ExpressToastCopy.BIND_FAILED, errorText());
        // A wrapped Chinese message still names its class: not user copy either.
        inlineFailure(new RuntimeException(new IllegalStateException("网络异常，请稍后重试")));
        assertEquals(ExpressToastCopy.BIND_FAILED, errorText());
    }

    @Test public void userCopyFromLiteOrTheGatewayIsStillShownAsItIs() {
        inlineFailure(new IllegalArgumentException("请输入正确的验证码"));
        assertEquals("请输入正确的验证码", errorText());
        inlineFailure(new IllegalStateException("请求超时，请稍后重试"));
        assertEquals("请求超时，请稍后重试", errorText());
        inlineFailure(new IllegalStateException(""));
        assertEquals(ExpressToastCopy.BIND_FAILED, errorText());
    }

    @Test public void aCodeRequestFailureToastsOnlyUserCopy() {
        toastFailure(new java.net.SocketTimeoutException("timeout"));
        assertEquals(ExpressToastCopy.CODE_SEND_FAILED, ShadowToast.getTextOfLatestToast());
        toastFailure(new java.security.GeneralSecurityException("Keystore operation failed"));
        assertEquals(ExpressToastCopy.CODE_SEND_FAILED, ShadowToast.getTextOfLatestToast());
        toastFailure(new IllegalArgumentException("请输入正确的手机号"));
        assertEquals("请输入正确的手机号", ShadowToast.getTextOfLatestToast());
    }

    @Test public void theLimitMessageIsNotShownOnAPageThatHasGoneAway() throws Exception {
        ExpressRepository repository = ExpressRepository.get(activity);
        String source = ExpressAccountSource.bindingSource(activity);
        for (int index = 0; index < ExpressPhoneBindingPolicy.MAX_BOUND_PHONE_COUNT; index++) {
            repository.bindPhoneLocally("1380000000" + index, source);
        }
        ((EditText) activity.findViewById(R.id.phone_input)).setText("13900001111");
        ((EditText) activity.findViewById(R.id.code_input)).setText("123456");
        activity.findViewById(R.id.btn_bind_phone).performClick();
        Future<?> task = ReflectionHelpers.getField(activity, "activeTask");
        task.get(10, TimeUnit.SECONDS);
        activity.finish();
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        TextView error = activity.findViewById(R.id.tv_verify_code_error);
        assertNotEquals("A page that has gone away must not show the limit message",
                View.VISIBLE, error.getVisibility());
    }

    private void inlineFailure(Throwable failure) {
        ReflectionHelpers.callInstanceMethod(activity, "inlineFailure",
                ClassParameter.from(Throwable.class, failure),
                ClassParameter.from(String.class, ExpressToastCopy.BIND_FAILED));
        Shadows.shadowOf(Looper.getMainLooper()).idle();
    }

    private void toastFailure(Throwable failure) {
        ReflectionHelpers.callInstanceMethod(activity, "toastFailure",
                ClassParameter.from(Throwable.class, failure),
                ClassParameter.from(String.class, ExpressToastCopy.CODE_SEND_FAILED));
        Shadows.shadowOf(Looper.getMainLooper()).idle();
    }

    private String errorText() {
        TextView error = activity.findViewById(R.id.tv_verify_code_error);
        assertEquals(View.VISIBLE, error.getVisibility());
        return error.getText().toString();
    }
}
