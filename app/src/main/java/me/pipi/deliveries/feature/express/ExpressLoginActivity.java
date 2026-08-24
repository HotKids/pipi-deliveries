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
                    Toast.makeText(this, R.string.verification_sent, Toast.LENGTH_SHORT).show();
                });
            } catch (Throwable failure) {
                showFailure(failure);
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
        ExpressRepository repository = ExpressRepository.get(this);
        String bindingSource = ExpressAccountSource.bindingSource(this);
        java.util.List<String> sourcePhones = repository.phones(bindingSource);
        if (!sourcePhones.contains(number)
                && !ExpressPhoneBindingPolicy.hasCapacity(sourcePhones.size())) {
            showError(ExpressPhoneBindingPolicy.limitMessage());
            return;
        }
        setBusy(true);
        activeTask = worker.submit(() -> {
            try {
                if (ExpressAccountSource.isV5(this)) {
                    new ExpressDiscoveryClient().bind(this, number, verification);
                } else {
                    new ExpressSubscriptionClient().bind(this, number, verification);
                }
                repository.bindPhoneLocally(number, bindingSource);
                ExpressScheduler.requestNow(this);
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    Toast.makeText(this, R.string.phone_bound, Toast.LENGTH_SHORT).show();
                });
                runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) finish();
                });
            } catch (Throwable failure) {
                showFailure(failure);
            } finally {
                runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) setBusy(false);
                });
            }
        });
    }

    private void setBusy(boolean busy) {
        boolean coolingDown = resendTimer != null;
        phone.setEnabled(!busy);
        code.setEnabled(!busy);
        sendCode.setEnabled(!busy && !coolingDown);
        bind.setEnabled(!busy);
        if (busy) {
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
                sendCode.setEnabled(true);
            }
        };
        resendTimer.start();
    }

    private void showFailure(Throwable failure) {
        String message = failure.getMessage() == null
                ? getString(R.string.network_exception) : failure.getMessage();
        runOnUiThread(() -> {
            if (!isFinishing() && !isDestroyed()) showError(message);
        });
    }

    private void showError(String message) {
        error.setText(message);
        error.setVisibility(View.VISIBLE);
    }
}
