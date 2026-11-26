package me.pipi.deliveries.feature.express;

import android.os.Bundle;
import android.os.CountDownTimer;
import android.view.View;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import com.google.android.material.appbar.MaterialToolbar;
import com.google.android.material.button.MaterialButton;

import me.pipi.deliveries.R;
import me.pipi.deliveries.background.ExpressScheduler;
import me.pipi.deliveries.data.ExpressPhoneBindingPolicy;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.network.ExpressAccountSource;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressSubscriptionClient;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public final class ExpressLoginActivity extends AppCompatActivity {
    private static final String STATE_RESEND_AT = "verification_resend_at";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private EditText phone;
    private EditText code;
    private TextView error;
    private MaterialButton sendCode;
    private MaterialButton bind;
    private CountDownTimer resendTimer;
    private Future<?> activeTask;
    private long resendAvailableAt;
    private boolean busy;
    private boolean binding;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_express_login);
        MaterialToolbar toolbar = findViewById(R.id.top_app_bar);
        toolbar.setNavigationOnClickListener(view -> finish());
        phone = findViewById(R.id.phone_input);
        code = findViewById(R.id.code_input);
        error = findViewById(R.id.tv_verify_code_error);
        sendCode = findViewById(R.id.send_code_button);
        bind = findViewById(R.id.btn_bind_phone);
        sendCode.setOnClickListener(view -> sendVerificationCode());
        bind.setOnClickListener(view -> bind());
        if (state != null) {
            resendAvailableAt = state.getLong(STATE_RESEND_AT, 0L);
            long remaining = resendAvailableAt - System.currentTimeMillis();
            if (remaining > 0L) startResendCountdown(remaining);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        state.putLong(STATE_RESEND_AT, resendAvailableAt);
        super.onSaveInstanceState(state);
    }

    @Override
    protected void onDestroy() {
        if (resendTimer != null) resendTimer.cancel();
        if (activeTask != null) activeTask.cancel(true);
        worker.shutdownNow();
        super.onDestroy();
    }

    private void sendVerificationCode() {
        String number = phone.getText().toString();
        binding = false;
        setBusy(true);
        activeTask = worker.submit(() -> {
            try {
                if (ExpressAccountSource.isV5(this)) {
                    new ExpressDiscoveryClient().sendCode(this, number);
                } else {
                    new ExpressSubscriptionClient().sendCode(this, number);
                }
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    startResendCountdown();
                    Toast.makeText(this, ExpressToastCopy.CODE_SENT, Toast.LENGTH_SHORT).show();
                });
            } catch (Throwable failure) {
                toastFailure(failure, ExpressToastCopy.CODE_SEND_FAILED);
            } finally {
                runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) setBusy(false);
                });
            }
        });
    }

    private void bind() {
        String number = phone.getText().toString().replaceAll("\\D", "");
        String verification = code.getText().toString().trim();
        if (!number.matches("^1[3-9]\\d{9}$")) {
            showError(getString(R.string.invalid_phone));
            return;
        }
        if (verification.isEmpty()) {
            showError(getString(R.string.verification_code_required));
            return;
        }
        String bindingSource = ExpressAccountSource.bindingSource(this);
        binding = true;
        setBusy(true);
        activeTask = worker.submit(() -> {
            try {
                ExpressRepository repository = ExpressRepository.get(this);
                java.util.List<String> sourcePhones = repository.phones(bindingSource);
                if (!sourcePhones.contains(number)
                        && !ExpressPhoneBindingPolicy.hasCapacity(sourcePhones.size())) {
                    runOnUiThread(() -> {
                        if (!isFinishing() && !isDestroyed()) showError(ExpressPhoneBindingPolicy.limitMessage());
                    });
                    return;
                }
                if (ExpressAccountSource.isV5(this)) {
                    new ExpressDiscoveryClient().bind(this, number, verification);
                } else {
                    new ExpressSubscriptionClient().bind(this, number, verification);
                }
                repository.bindPhoneLocally(number, bindingSource);
                ExpressScheduler.requestNow(this);
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    Toast.makeText(this, ExpressToastCopy.PHONE_BOUND, Toast.LENGTH_SHORT).show();
                });
                runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) finish();
                });
            } catch (Throwable failure) {
                inlineFailure(failure, ExpressToastCopy.BIND_FAILED);
            } finally {
                runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) setBusy(false);
                });
            }
        });
    }

    private void setBusy(boolean busy) {
        this.busy = busy;
        boolean coolingDown = resendTimer != null;
        phone.setEnabled(!busy);
        code.setEnabled(!busy);
        sendCode.setEnabled(!busy && !coolingDown);
        bind.setEnabled(!busy);
        bind.setText(busy && binding ? R.string.binding_phone : R.string.card_sub_btn_bind_txt);
        if (busy && !binding) {
            sendCode.setText(R.string.sending_code);
        } else if (!coolingDown) {
            sendCode.setText(R.string.send_code);
        }
        if (!busy) return;
        error.setVisibility(View.INVISIBLE);
    }

    private void startResendCountdown() {
        resendAvailableAt = System.currentTimeMillis() + 60_000L;
        startResendCountdown(60_000L);
    }

    private void startResendCountdown(long durationMillis) {
        if (resendTimer != null) resendTimer.cancel();
        resendTimer = new CountDownTimer(durationMillis, 1_000L) {
            @Override public void onTick(long millisUntilFinished) {
                long seconds = Math.max(1L, (millisUntilFinished + 999L) / 1_000L);
                sendCode.setText(getString(R.string.resend_code_countdown, seconds));
                sendCode.setEnabled(false);
            }

            @Override public void onFinish() {
                resendTimer = null;
                resendAvailableAt = 0L;
                sendCode.setText(R.string.send_code);
                sendCode.setEnabled(!busy);
            }
        };
        resendTimer.start();
    }

    /** 绑定失败留在表单内联显示（三端同），上游给了原因就显示原因，否则用统一兜底文案。 */
    private void inlineFailure(Throwable failure, String fallback) {
        String message = userMessage(failure, fallback);
        runOnUiThread(() -> {
            if (!isFinishing() && !isDestroyed()) showError(message);
        });
    }

    /** 验证码发送失败走 toast（AGENTS §11 三端统一）：上游给了原因就显示原因，否则用统一兜底文案。 */
    private void toastFailure(Throwable failure, String fallback) {
        String message = userMessage(failure, fallback);
        runOnUiThread(() -> {
            if (!isFinishing() && !isDestroyed()) {
                Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
            }
        });
    }

    /**
     * The failure's own text only when it is user copy: the Chinese messages Lite and the gateway's sanitized answers
     * throw. A platform or library failure (an unresolved host, a socket timeout, a JSON or Keystore error) carries
     * English text, a class name or a URL, and shows the page's fallback instead (G-HIGH-18, 2026-11-20 review).
     */
    static String userMessage(Throwable failure, String fallback) {
        String message = failure == null || failure.getMessage() == null ? "" : failure.getMessage().trim();
        if (message.isEmpty() || message.length() > 96 || !containsHan(message)
                || message.indexOf('\n') >= 0 || message.indexOf('\r') >= 0) return fallback;
        String lower = message.toLowerCase(java.util.Locale.ROOT);
        for (String marker : new String[]{"exception", "error", "java.", "javax.", "android.", "http", "://"}) {
            if (lower.contains(marker)) return fallback;
        }
        return message;
    }

    private static boolean containsHan(String value) {
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character >= 0x4E00 && character <= 0x9FFF) return true;
        }
        return false;
    }

    private void showError(String message) {
        error.setText(message);
        error.setVisibility(View.VISIBLE);
    }
}
