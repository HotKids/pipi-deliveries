package me.pipi.deliveries.feature.express;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Dialog;
import android.content.BroadcastReceiver;
import android.content.res.ColorStateList;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.Log;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.BaseAdapter;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.RequiresApi;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.google.android.material.appbar.MaterialToolbar;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.color.MaterialColors;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.shape.MaterialShapeDrawable;
import com.google.android.material.shape.ShapeAppearanceModel;
import com.google.android.material.textfield.TextInputEditText;
import com.google.android.material.textfield.TextInputLayout;

import me.pipi.deliveries.R;
import me.pipi.deliveries.background.ExpressScheduler;
import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.network.ExpressApi;
import me.pipi.deliveries.network.ExpressAccountSource;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import me.pipi.deliveries.network.ExpressLog;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** Native Material shipment list and manual-query entry point. */
public final class ExpressListActivity extends AppCompatActivity {
    public static final String EXTRA_FOCUS_QUERY = "focus_express_query";
    private static final long CARRIER_DETECT_DELAY_MS = 450L;
    private static final long CARRIER_DETECT_TIMEOUT_MS = 15_000L;
    private static final String STATE_PHONE_TAIL_DIALOG = "phone_tail_dialog";
    private static final String STATE_PHONE_TAIL_WAYBILL = "phone_tail_waybill";
    private static final String STATE_PHONE_TAIL_COURIER = "phone_tail_courier";
    private static final String STATE_PHONE_TAIL_MISMATCH = "phone_tail_mismatch";
    private static final String STATE_PHONE_TAIL_VALUE = "phone_tail_value";
    private final ArrayList<ExpressItem> items = new ArrayList<>();
    private ExpressAdapter adapter;
    private ListView list;
    private View empty;
    private View retentionNotice;
    private SwipeRefreshLayout swipeRefresh;
    private final ExecutorService carrierDetectWorker = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private Future<?> carrierDetectTask;
    private ExpressQueryCancellation carrierDetectCancellation;
    private Runnable carrierDetectStart;
    private TextInputLayout queryContainer;
    private TextInputEditText queryInput;
    private volatile long carrierDetectGeneration;
    private volatile String detectedWaybill = "";
    private volatile String detectedCourierCode = "";
    private boolean querying;
    private final ActivityResultLauncher<Intent> manualQuery = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(), result -> {
                querying = false;
                queryInput.setEnabled(true);
                if (result.getResultCode() == RESULT_OK) {
                    queryInput.setText("");
                    reload();
                } else if (result.getResultCode() == ExpressDetailActivity.RESULT_PHONE_TAIL_REQUIRED
                        && result.getData() != null) {
                    Intent retry = result.getData();
                    queryContainer.setError(null);
                    showPhoneTailDialog(
                            retry.getStringExtra(ExpressDetailActivity.EXTRA_RETRY_WAYBILL),
                            retry.getStringExtra(ExpressDetailActivity.EXTRA_RETRY_COURIER),
                            retry.getBooleanExtra(ExpressDetailActivity.EXTRA_RETRY_MISMATCH, false));
                }
            });
    private boolean queryFocusWhenWindowReady;
    private boolean queryImeWasVisible;
    private int queryKeyboardAttempts;
    private boolean receiverRegistered;
    private Dialog phoneTailDialog;
    private TextInputEditText[] phoneTailDigits;
    private String phoneTailWaybill = "";
    private String phoneTailCourierHint = "";
    private boolean phoneTailMismatch;
    private Dialog deleteConfirmationDialog;
    private final Set<String> attemptedOrderProjections = new HashSet<>();
    private ExpressHomeOrderProjectionCapture orderProjectionCapture;
    private boolean orderProjectionCaptureEnabled;
    private boolean resetOrderProjectionAttemptsAfterCapture;
    /** 下拉刷新的结果 toast 只在这次手势对应的同步结束时弹一次（AGENTS §11 统一表）。 */
    private boolean pullRefreshPending;
    private String pullRefreshWorkId;
    // 15 秒只收起转圈，不下结论：一轮同步（列表 + 逐票详情 + 手动链）常常超过 15 秒，之前这里
    // 直接弹「刷新失败」，同步其实还在跑、最后还成功了（Fold7 2026-09-05 19:05 实测 25 秒）。
    // iOS / Pipi 都是等整轮跑完再按计数弹；真正的失败文案只在 60 秒都没等到结束广播时兜底。
    private final Runnable pullRefreshTimeout = () -> swipeRefresh.setRefreshing(false);
    private final Runnable pullRefreshHardTimeout = () -> {
        swipeRefresh.setRefreshing(false);
        if (!pullRefreshPending) return;
        pullRefreshPending = false;
        Toast.makeText(this, ExpressToastCopy.REFRESH_FAILED, Toast.LENGTH_SHORT).show();
    };

    private final BroadcastReceiver changes = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (intent != null
                    && ExpressRepository.ACTION_SYNC_FINISHED.equals(intent.getAction())) {
                if (orderProjectionCapture == null) attemptedOrderProjections.clear();
                else resetOrderProjectionAttemptsAfterCapture = true;
                announcePullRefreshOutcome(intent);
            }
            reload();
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_express_list);
        list = findViewById(android.R.id.list);
        empty = findViewById(R.id.emptyView);
        swipeRefresh = findViewById(R.id.swipe_refresh);
        ExpressPullRefreshStyle.apply(swipeRefresh);
        retentionNotice = getLayoutInflater().inflate(
                R.layout.footer_express_retention_notice, list, false);
        list.addFooterView(retentionNotice, null, false);
        adapter = new ExpressAdapter();
        list.setAdapter(adapter);
        queryContainer = findViewById(R.id.home_query_container);
        queryInput = findViewById(R.id.home_query_input);
        queryContainer.setErrorEnabled(false);
        TextView carrierSuffix = queryContainer.getSuffixTextView();
        carrierSuffix.setGravity(Gravity.CENTER_VERTICAL);
        carrierSuffix.setMinHeight(Math.round(
                56f * getResources().getDisplayMetrics().density));
        carrierSuffix.setIncludeFontPadding(false);
        updateCarrierSuffix("");
        queryInput.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(
                    CharSequence value, int start, int count, int after) {}
            @Override public void onTextChanged(
                    CharSequence value, int start, int before, int count) {}
            @Override public void afterTextChanged(Editable value) {
                queryContainer.setError(null);
                scheduleCarrierDetection();
            }
        });
        View contentRoot = findViewById(R.id.express_list_content_layout);
        queryInput.setOnFocusChangeListener((view, hasFocus) -> updateQueryCursor());
        contentRoot.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
            boolean imeVisible = Build.VERSION.SDK_INT >= 30
                    ? Api30.imeVisible(contentRoot) : legacyImeVisible(contentRoot);
            boolean imeWasVisible = queryImeWasVisible;
            queryImeWasVisible = imeVisible;
            if (imeVisible) {
                queryFocusWhenWindowReady = false;
                queryKeyboardAttempts = 0;
            }
            if (!imeVisible && imeWasVisible) {
                queryInput.clearFocus();
                contentRoot.requestFocus();
            }
            updateQueryCursor();
        });
        if (!getIntent().getBooleanExtra(EXTRA_FOCUS_QUERY, false)) {
            contentRoot.requestFocus();
        }
        queryContainer.setStartIconOnClickListener(view -> queryWaybill());
        queryInput.setOnEditorActionListener((view, actionId, event) -> {
            // 实体键盘 / adb 的回车会按 DOWN、UP 各回调一次，只认一次，免得已在列表的件开两个详情。
            boolean enter = event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER
                    && event.getAction() == KeyEvent.ACTION_DOWN;
            if (actionId == EditorInfo.IME_ACTION_SEARCH || enter) {
                queryWaybill();
                return true;
            }
            return false;
        });
        MaterialToolbar toolbar = findViewById(R.id.top_app_bar);
        toolbar.setOnMenuItemClickListener(item -> {
            if (item.getItemId() != R.id.action_manage) return false;
            startActivity(new Intent(this, ExpressManagerActivity.class));
            return true;
        });
        // 下拉刷新圈用 SwipeRefreshLayout 的默认样式（用户定 2026-09-05）：自定义的 24dp 停靠位
        // 压在第一行文字上，surfaceContainer 底色又跟页面几乎同色，看起来像一块糊住文字的污渍。
        swipeRefresh.setOnRefreshListener(() -> {
            pullRefreshPending = true;
            pullRefreshWorkId = ExpressScheduler.requestNow(this).toString();
            swipeRefresh.removeCallbacks(pullRefreshTimeout);
            swipeRefresh.removeCallbacks(pullRefreshHardTimeout);
            swipeRefresh.postDelayed(pullRefreshTimeout, 15_000L);
            swipeRefresh.postDelayed(pullRefreshHardTimeout, 60_000L);
        });
        requestNotificationPermission();
        reload();
        focusQueryIfRequested(getIntent());
        if (state != null && state.getBoolean(STATE_PHONE_TAIL_DIALOG, false)) {
            showPhoneTailDialog(
                    state.getString(STATE_PHONE_TAIL_WAYBILL, ""),
                    state.getString(STATE_PHONE_TAIL_COURIER, ""),
                    state.getBoolean(STATE_PHONE_TAIL_MISMATCH, false),
                    state.getString(STATE_PHONE_TAIL_VALUE, ""));
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        focusQueryIfRequested(intent);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && queryFocusWhenWindowReady) {
            queryInput.postDelayed(this::showQueryKeyboard, 120L);
        }
    }

    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    @Override
    protected void onStart() {
        super.onStart();
        orderProjectionCaptureEnabled = true;
        attemptedOrderProjections.clear();
        resetOrderProjectionAttemptsAfterCapture = false;
        if (!receiverRegistered) {
            IntentFilter filter = new IntentFilter(ExpressRepository.ACTION_CHANGED);
            filter.addAction(ExpressRepository.ACTION_SYNC_FINISHED);
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(changes, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(changes, filter);
            }
            receiverRegistered = true;
        }
        reload();
        if (currentWaybill().length() >= 6) scheduleCarrierDetection();
    }

    @Override
    protected void onStop() {
        pullRefreshPending = false;
        if (swipeRefresh != null) {
            swipeRefresh.removeCallbacks(pullRefreshTimeout);
            swipeRefresh.removeCallbacks(pullRefreshHardTimeout);
        }
        invalidateCarrierDetection();
        orderProjectionCaptureEnabled = false;
        resetOrderProjectionAttemptsAfterCapture = false;
        if (orderProjectionCapture != null) {
            orderProjectionCapture.cancel();
            orderProjectionCapture = null;
        }
        if (receiverRegistered) {
            unregisterReceiver(changes);
            receiverRegistered = false;
        }
        super.onStop();
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        if (phoneTailDialog != null && phoneTailDialog.isShowing()) {
            state.putBoolean(STATE_PHONE_TAIL_DIALOG, true);
            state.putString(STATE_PHONE_TAIL_WAYBILL, phoneTailWaybill);
            state.putString(STATE_PHONE_TAIL_COURIER, phoneTailCourierHint);
            state.putBoolean(STATE_PHONE_TAIL_MISMATCH, phoneTailMismatch);
            state.putString(STATE_PHONE_TAIL_VALUE,
                    phoneTailDigits == null ? "" : phoneTail(phoneTailDigits));
        }
        super.onSaveInstanceState(state);
    }

    @Override
    protected void onDestroy() {
        if (orderProjectionCapture != null) {
            orderProjectionCapture.cancel();
            orderProjectionCapture = null;
        }
        dismissDialog(phoneTailDialog);
        dismissDialog(deleteConfirmationDialog);
        invalidateInteractiveNetworkOperations();
        carrierDetectWorker.shutdownNow();
        super.onDestroy();
    }

    /** 同步结束：按这轮的计数弹「刷新完成 / 当前已是最新 / 部分 / 失败」，与 iOS 同一套判据。 */
    private void announcePullRefreshOutcome(Intent intent) {
        if (!pullRefreshPending || pullRefreshWorkId == null
                || !pullRefreshWorkId.equals(intent.getStringExtra(
                        ExpressRepository.EXTRA_SYNC_WORK_ID))) return;
        pullRefreshPending = false;
        pullRefreshWorkId = null;
        swipeRefresh.removeCallbacks(pullRefreshTimeout);
        swipeRefresh.removeCallbacks(pullRefreshHardTimeout);
        swipeRefresh.setRefreshing(false);
        Toast.makeText(this, ExpressToastCopy.refreshSummary(
                intent.getIntExtra(ExpressRepository.EXTRA_SYNC_ATTEMPTED, 0),
                intent.getIntExtra(ExpressRepository.EXTRA_SYNC_SUCCEEDED, 0),
                intent.getIntExtra(ExpressRepository.EXTRA_SYNC_FAILED, 0)),
                Toast.LENGTH_SHORT).show();
    }

    private void reload() {
        List<ExpressItem> fresh = ExpressRepository.get(this).listVisible(
                ExpressAccountSource.bindingSource(this));
        items.clear();
        items.addAll(fresh);
        adapter.notifyDataSetChanged();
        boolean isEmpty = items.isEmpty();
        empty.setVisibility(isEmpty ? View.VISIBLE : View.GONE);
        list.setVisibility(isEmpty ? View.GONE : View.VISIBLE);
        retentionNotice.setVisibility(isEmpty ? View.GONE : View.VISIBLE);
        swipeRefresh.setRefreshing(false);
        startNextOrderProjectionCapture();
    }

    private void startNextOrderProjectionCapture() {
        if (!orderProjectionCaptureEnabled || orderProjectionCapture != null
                || isFinishing() || isDestroyed()) return;
        ExpressItem candidate;
        while ((candidate = nextOrderProjectionCandidate(
                items, attemptedOrderProjections)) != null) {
            // Feed text projection does not open H5 and must not consume its cooldown.
            ExpressOrderTextIdentity.Identity textIdentity =
                    ExpressOrderTextIdentity.fromTracksJson(
                            candidate.tracksJson, candidate.waybill);
            if (textIdentity != null) {
                ExpressOrderProjectionRetryStore.AttemptToken token =
                        ExpressOrderProjectionRetryStore.acquireAttempt(candidate);
                if (token == null) continue;
                String owner = candidate.stateOwner.isEmpty()
                        ? candidate.source : candidate.stateOwner;
                boolean saved = ExpressRepository.get(this).saveOrderProjection(
                        candidate, ExpressAccountSource.bindingSourceForOwner(owner),
                        textIdentity.waybill, "");
                ExpressOrderProjectionRetryStore.releaseAttempt(token);
                if (saved) {
                    ExpressScheduler.requestNow(this);
                    reload();
                    return;
                }
                continue;
            }
            ExpressHomeOrderProjectionCapture capture =
                    new ExpressHomeOrderProjectionCapture(
                            this, candidate, this::onOrderProjectionCaptureFinished);
            orderProjectionCapture = capture;
            if (capture.start()) return;
            orderProjectionCapture = null;
        }
    }

    private void onOrderProjectionCaptureFinished(
            ExpressHomeOrderProjectionCapture capture, boolean saved) {
        if (capture != orderProjectionCapture) return;
        orderProjectionCapture = null;
        if (resetOrderProjectionAttemptsAfterCapture) {
            resetOrderProjectionAttemptsAfterCapture = false;
            attemptedOrderProjections.clear();
        }
        if (!orderProjectionCaptureEnabled || isFinishing() || isDestroyed()) return;
        if (saved) {
            ExpressScheduler.requestNow(this);
            reload();
        }
        else mainHandler.post(this::startNextOrderProjectionCapture);
    }

    static ExpressItem nextOrderProjectionCandidate(
            List<ExpressItem> values, Set<String> attempted) {
        if (values == null || attempted == null) return null;
        for (ExpressItem value : values) {
            if (!ExpressHomeOrderProjectionCapture.needsProjection(value)) {
                if (value != null && value.isAccountOrder() && value.projectedWaybill.isEmpty()) {
                    me.pipi.deliveries.network.ExpressLog.line("v5", "jd_h5", "jingdong", "skipped",
                            "tail", me.pipi.deliveries.network.ExpressLog.tail(value.waybill),
                            "reason", "projection_prerequisite", "routePresent", !value.routeCredential.isEmpty(),
                            "routeAvailable", value.routeCredentialAvailable);
                }
                continue;
            }
            String key = orderProjectionAttemptKey(value);
            if (attempted.add(key)) return value;
        }
        return null;
    }

    private static String orderProjectionAttemptKey(ExpressItem value) {
        String owner = value.stateOwner.isEmpty() ? value.source : value.stateOwner;
        return ExpressAccountSource.bindingSourceForOwner(owner) + ":" + value.rowId + ":"
                + ExpressDetailActivity.normalizeIdentity(value.waybill) + ":"
                + ExpressOrderProjectionRetryStore.routeFingerprint(value);
    }

    private void queryWaybill() {
        String waybill = currentWaybill();
        queryWaybill("", detectedCarrierHintForQuery(
                waybill, detectedWaybill, detectedCourierCode));
    }

    private long lastQuerySubmitAtMs;

    private void queryWaybill(String suppliedPhoneTail, String suppliedCourierHint) {
        String waybill = queryInput.getText() == null
                ? "" : queryInput.getText().toString().trim();
        if (querying) return;
        // 同一次回车可能既走 IME 动作又走按键事件（实体键盘 / adb），400 毫秒内只认第一次。
        long now = android.os.SystemClock.uptimeMillis();
        if (now - lastQuerySubmitAtMs < 400L) return;
        lastQuerySubmitAtMs = now;
        if (waybill.length() < 6) {
            // 校验类文案内联显示，不弹 toast（AGENTS §11 统一表，三端同）。
            queryContainer.setError(getString(R.string.invalid_waybill));
            return;
        }
        // 已在列表里的单号不再花一次识别、一轮查询或第二行（用户定 2026-09-04，iOS/Pipi 同）。
        ExpressItem listed = ExpressRepository.get(this).findByWaybill(
                waybill, ExpressAccountSource.bindingSource(this));
        if (listed != null) {
            queryContainer.setError(null);
            Toast.makeText(this, ExpressToastCopy.ALREADY_IN_LIST, Toast.LENGTH_SHORT).show();
            // 用户定 2026-09-05：提示「已在列表」的同时打开那一票的详情（iOS/Pipi 同）。
            startActivity(new Intent(this, ExpressDetailActivity.class).putExtra(
                    ExpressDetailActivity.EXTRA_ROW_ID, listed.rowId));
            return;
        }
        querying = true;
        Toast.makeText(this, ExpressToastCopy.MANUAL_QUERYING, Toast.LENGTH_SHORT).show();
        queryContainer.setError(null);
        queryInput.setEnabled(false);
        hideKeyboard();
        carrierDetectGeneration++;
        if (carrierDetectStart != null) {
            mainHandler.removeCallbacks(carrierDetectStart);
            carrierDetectStart = null;
        }
        if (carrierDetectCancellation != null) carrierDetectCancellation.cancel();
        carrierDetectCancellation = null;
        if (carrierDetectTask != null) carrierDetectTask.cancel(true);
        carrierDetectTask = null;
        manualQuery.launch(ExpressDetailActivity.manualQueryIntent(
                this, waybill, suppliedPhoneTail, suppliedCourierHint,
                ExpressAccountSource.bindingSource(this)));
    }

    private void scheduleCarrierDetection() {
        String waybill = queryInput.getText() == null
                ? "" : queryInput.getText().toString().trim();
        long generation = ++carrierDetectGeneration;
        detectedWaybill = waybill;
        detectedCourierCode = "";
        if (carrierDetectStart != null) mainHandler.removeCallbacks(carrierDetectStart);
        if (carrierDetectCancellation != null) carrierDetectCancellation.cancel();
        carrierDetectCancellation = null;
        if (carrierDetectTask != null && !carrierDetectTask.isDone()) {
            carrierDetectTask.cancel(true);
        }
        carrierDetectTask = null;
        if (waybill.length() < 6) {
            carrierDetectStart = null;
            updateCarrierSuffix("");
            return;
        }
        updateCarrierSuffix("");
        String bindingSource = ExpressAccountSource.bindingSource(this);
        carrierDetectStart = () -> {
            carrierDetectStart = null;
            if (generation != carrierDetectGeneration) return;
            ExpressQueryCancellation cancellation =
                    new ExpressQueryCancellation(CARRIER_DETECT_TIMEOUT_MS);
            carrierDetectCancellation = cancellation;
            carrierDetectTask = carrierDetectWorker.submit(() ->
                    detectCarrier(waybill, generation, bindingSource, cancellation));
        };
        mainHandler.postDelayed(carrierDetectStart, CARRIER_DETECT_DELAY_MS);
    }

    private void detectCarrier(
            String waybill, long generation, String bindingSource,
            ExpressQueryCancellation cancellation) {
        String code = "";
        String company = "";
        try {
            ExpressItem existing = ExpressRepository.get(this)
                    .findByWaybill(waybill, bindingSource);
            String cachedCode = existing == null ? "" : existing.displayCourierCode();
            CarrierRegistry.Carrier cached = existing == null ? null
                    : CarrierRegistry.resolveKuaidi100Code(cachedCode);
            if (cached == null && existing != null) {
                cached = CarrierRegistry.resolveName(existing.displayCompany());
            }
            if (cached != null) {
                code = cachedCode;
                company = existing.displayCompany();
            } else {
                code = new ExpressApi(getApplicationContext()).detect(
                        waybill, cancellation);
                CarrierRegistry.Carrier detected = CarrierRegistry.resolveKuaidi100Code(code);
                company = detected == null ? ""
                        : CarrierRegistry.displayName(code, detected.companyName);
            }
        } catch (Throwable ignored) {
            // Detection is optional. Submission retains its server-side fallback.
        }
        if (generation != carrierDetectGeneration || !waybill.equals(detectedWaybill)
                || !bindingSource.equals(ExpressAccountSource.bindingSource(this))) return;
        detectedCourierCode = code;
        String shownCompany = company;
        runOnUiThread(() -> {
            if (carrierDetectCancellation == cancellation) {
                carrierDetectCancellation = null;
            }
            if (isFinishing() || isDestroyed()
                    || generation != carrierDetectGeneration
                    || !waybill.equals(currentWaybill())
                    || !bindingSource.equals(
                    ExpressAccountSource.bindingSource(this))) return;
            updateCarrierSuffix(shownCompany);
        });
    }

    private void invalidateInteractiveNetworkOperations() {
        querying = false;
        if (queryInput != null) queryInput.setEnabled(true);
        invalidateCarrierDetection();
    }

    /** Carrier detection belongs only to the visible input form. */
    private void invalidateCarrierDetection() {
        carrierDetectGeneration++;
        if (carrierDetectCancellation != null) carrierDetectCancellation.cancel();
        carrierDetectCancellation = null;
        if (carrierDetectStart != null) mainHandler.removeCallbacks(carrierDetectStart);
        carrierDetectStart = null;
        if (carrierDetectTask != null) carrierDetectTask.cancel(true);
        carrierDetectTask = null;
        detectedWaybill = "";
        detectedCourierCode = "";
    }

    static String manualQueryRawCarrierHint(
            String suppliedHint,
            String existingRawCarrier) {
        String supplied = suppliedHint == null ? "" : suppliedHint.trim();
        if (!supplied.isEmpty()) return supplied;
        String existing = existingRawCarrier == null ? "" : existingRawCarrier.trim();
        return existing;
    }

    static String detectedCarrierHintForQuery(
            String currentWaybill,
            String detectedWaybill,
            String detectedCourierCode) {
        String current = currentWaybill == null ? "" : currentWaybill.trim();
        String detected = detectedWaybill == null ? "" : detectedWaybill.trim();
        if (current.isEmpty() || !current.equalsIgnoreCase(detected)) return "";
        return detectedCourierCode == null ? "" : detectedCourierCode.trim();
    }

    private String currentWaybill() {
        return queryInput.getText() == null ? "" : queryInput.getText().toString().trim();
    }

    private void updateCarrierSuffix(String company) {
        String value = company == null ? "" : company.trim();
        boolean recognized = !value.isEmpty();
        queryContainer.setSuffixText(recognized ? value : "");
        queryContainer.setSuffixTextColor(ColorStateList.valueOf(MaterialColors.getColor(
                queryContainer,
                recognized
                        ? androidx.appcompat.R.attr.colorPrimary
                        : com.google.android.material.R.attr.colorOnSurfaceVariant)));
    }

    private void showPhoneTailDialog(
            String waybill, String courierHint, boolean mismatch) {
        showPhoneTailDialog(waybill, courierHint, mismatch, "");
    }

    private void showPhoneTailDialog(
            String waybill, String courierHint, boolean mismatch, String restoredTail) {
        if (isFinishing() || isDestroyed()) return;
        dismissDialog(phoneTailDialog);
        FrameLayout parent = new FrameLayout(this);
        View content = getLayoutInflater().inflate(
                R.layout.dialog_phone_tail, parent, false);
        TextInputEditText[] digits = {
                content.findViewById(R.id.phone_tail_digit_1),
                content.findViewById(R.id.phone_tail_digit_2),
                content.findViewById(R.id.phone_tail_digit_3),
                content.findViewById(R.id.phone_tail_digit_4)
        };
        TextView errorView = content.findViewById(R.id.phone_tail_error);
        MaterialButton submitButton = content.findViewById(R.id.phone_tail_submit);
        ImageButton closeButton = content.findViewById(R.id.phone_tail_close);
        String initialTail = restoredTail == null
                ? "" : restoredTail.replaceAll("\\D", "");
        if (initialTail.length() > digits.length) {
            initialTail = initialTail.substring(0, digits.length);
        }
        for (int index = 0; index < initialTail.length(); index++) {
            digits[index].setText(String.valueOf(initialTail.charAt(index)));
            digits[index].setSelection(1);
        }
        if (mismatch) showPhoneTailError(errorView, R.string.phone_tail_mismatch);
        Dialog dialog = new Dialog(this);
        phoneTailDialog = dialog;
        phoneTailDigits = digits;
        phoneTailWaybill = waybill == null ? "" : waybill;
        phoneTailCourierHint = courierHint == null ? "" : courierHint;
        phoneTailMismatch = mismatch;
        dialog.setContentView(content);
        dialog.setCanceledOnTouchOutside(true);
        dialog.setOnDismissListener(ignored -> {
            if (phoneTailDialog != dialog) return;
            phoneTailDialog = null;
            phoneTailDigits = null;
            phoneTailWaybill = "";
            phoneTailCourierHint = "";
            phoneTailMismatch = false;
        });
        String preservedTail = initialTail;
        dialog.setOnShowListener(ignored -> {
            View.OnClickListener submit = view -> {
                String tail = phoneTail(digits);
                if (!tail.matches("\\d{4}")) {
                    showPhoneTailError(errorView, R.string.phone_tail_invalid);
                    focusFirstEmptyDigit(digits);
                    return;
                }
                dialog.dismiss();
                queryWaybill(tail, courierHint);
            };
            submitButton.setOnClickListener(submit);
            closeButton.setOnClickListener(view -> dialog.dismiss());
            bindPhoneTailDigits(digits, errorView, submit);
            float density = getResources().getDisplayMetrics().density;
            ShapeAppearanceModel shape = ShapeAppearanceModel.builder()
                    .setAllCornerSizes(24f * density)
                    .build();
            MaterialShapeDrawable surface = new MaterialShapeDrawable(shape);
            surface.setFillColor(ColorStateList.valueOf(MaterialColors.getColor(
                    content, com.google.android.material.R.attr.colorSurface)));
            content.setBackground(surface);
            Window window = dialog.getWindow();
            if (window != null) {
                window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
                window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
                window.setDimAmount(0.32f);
                window.setSoftInputMode(
                        WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                                | WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
                window.getDecorView().setPadding(0, 0, 0, 0);
                int available = getResources().getDisplayMetrics().widthPixels
                        - Math.round(48f * density);
                window.setLayout(
                        Math.min(Math.round(320f * density), available),
                        ViewGroup.LayoutParams.WRAP_CONTENT);
            }
            TextInputEditText focusDigit = digits[Math.min(
                    preservedTail.length(), digits.length - 1)];
            focusDigit.requestFocus();
            focusDigit.postDelayed(() -> {
                if (!dialog.isShowing() || isFinishing() || isDestroyed()) return;
                InputMethodManager keyboard = getSystemService(InputMethodManager.class);
                if (keyboard != null) {
                    keyboard.showSoftInput(focusDigit, InputMethodManager.SHOW_IMPLICIT);
                }
                Window keyboardWindow = dialog.getWindow();
                if (keyboardWindow != null && Build.VERSION.SDK_INT >= 30) {
                    Api30.showIme(keyboardWindow);
                }
            }, 180L);
        });
        dialog.show();
    }

    private void bindPhoneTailDigits(
            TextInputEditText[] digits, TextView errorView, View.OnClickListener submit) {
        boolean[] distributing = {false};
        for (int index = 0; index < digits.length; index++) {
            final int position = index;
            TextInputEditText input = digits[position];
            input.addTextChangedListener(new TextWatcher() {
                private int previousLength;

                @Override public void beforeTextChanged(
                        CharSequence value, int start, int count, int after) {
                    previousLength = value == null ? 0 : value.length();
                }

                @Override public void onTextChanged(
                        CharSequence value, int start, int before, int count) {}

                @Override public void afterTextChanged(Editable value) {
                    if (distributing[0]) return;
                    errorView.setVisibility(View.GONE);
                    phoneTailMismatch = false;
                    String entered = value == null ? "" : value.toString().replaceAll("\\D", "");
                    if (entered.length() > 1) {
                        distributing[0] = true;
                        int destination = position;
                        for (int offset = 0;
                                offset < entered.length() && destination < digits.length;
                                offset++, destination++) {
                            digits[destination].setText(String.valueOf(entered.charAt(offset)));
                            digits[destination].setSelection(1);
                        }
                        distributing[0] = false;
                        digits[Math.min(destination, digits.length - 1)].requestFocus();
                    } else if (entered.length() == 1 && position < digits.length - 1) {
                        digits[position + 1].requestFocus();
                    } else if (entered.isEmpty() && previousLength > 0 && position > 0) {
                        digits[position - 1].requestFocus();
                        digits[position - 1].setSelection(digitText(digits[position - 1]).length());
                    }
                }
            });
            input.setOnKeyListener((view, keyCode, event) -> {
                if (keyCode != KeyEvent.KEYCODE_DEL
                        || event.getAction() != KeyEvent.ACTION_DOWN
                        || !digitText(input).isEmpty() || position == 0) return false;
                TextInputEditText previous = digits[position - 1];
                previous.setText("");
                previous.requestFocus();
                return true;
            });
            input.setOnEditorActionListener((view, actionId, event) -> {
                boolean enter = event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER;
                if (actionId == EditorInfo.IME_ACTION_SEARCH
                        || actionId == EditorInfo.IME_ACTION_DONE || enter) {
                    submit.onClick(view);
                    return true;
                }
                return false;
            });
        }
    }

    private void showPhoneTailError(TextView errorView, int message) {
        errorView.setText(message);
        errorView.setVisibility(View.VISIBLE);
    }

    private static String phoneTail(TextInputEditText[] digits) {
        StringBuilder result = new StringBuilder(4);
        for (TextInputEditText digit : digits) result.append(digitText(digit));
        return result.toString();
    }

    private static String digitText(TextInputEditText input) {
        return input.getText() == null ? "" : input.getText().toString().trim();
    }

    private static void focusFirstEmptyDigit(TextInputEditText[] digits) {
        for (TextInputEditText digit : digits) {
            if (!digitText(digit).isEmpty()) continue;
            digit.requestFocus();
            return;
        }
        digits[0].requestFocus();
    }

    private void hideKeyboard() {
        InputMethodManager keyboard = getSystemService(InputMethodManager.class);
        if (keyboard != null) keyboard.hideSoftInputFromWindow(queryInput.getWindowToken(), 0);
        queryInput.clearFocus();
    }

    private void focusQueryIfRequested(Intent intent) {
        if (intent == null || !intent.getBooleanExtra(EXTRA_FOCUS_QUERY, false)) return;
        intent.removeExtra(EXTRA_FOCUS_QUERY);
        queryFocusWhenWindowReady = true;
        queryKeyboardAttempts = 0;
        queryInput.requestFocus();
        updateQueryCursor();
        queryInput.setSelection(queryInput.length());
        if (hasWindowFocus()) queryInput.postDelayed(this::showQueryKeyboard, 120L);
    }

    private void showQueryKeyboard() {
        if (!queryFocusWhenWindowReady || !hasWindowFocus()) return;
        queryInput.requestFocus();
        updateQueryCursor();
        queryInput.setSelection(queryInput.length());
        InputMethodManager keyboard = getSystemService(InputMethodManager.class);
        if (keyboard != null) {
            keyboard.showSoftInput(queryInput, InputMethodManager.SHOW_IMPLICIT);
        }
        if (Build.VERSION.SDK_INT >= 30) Api30.showIme(getWindow());
        queryKeyboardAttempts++;
        if (queryKeyboardAttempts < 4) {
            queryInput.postDelayed(() -> {
                if (queryFocusWhenWindowReady && !queryImeWasVisible) showQueryKeyboard();
            }, 220L);
        }
    }

    private void updateQueryCursor() {
        queryInput.setCursorVisible(queryInput.hasFocus() && queryImeWasVisible);
    }

    private static boolean legacyImeVisible(View contentRoot) {
        Rect visible = new Rect();
        contentRoot.getWindowVisibleDisplayFrame(visible);
        int rootHeight = contentRoot.getRootView().getHeight();
        return rootHeight > 0 && rootHeight - visible.bottom > rootHeight * 0.15f;
    }

    @RequiresApi(30)
    private static final class Api30 {
        private Api30() {}

        static boolean imeVisible(View contentRoot) {
            WindowInsets insets = contentRoot.getRootWindowInsets();
            return insets != null && insets.isVisible(WindowInsets.Type.ime());
        }

        static void showIme(Window window) {
            android.view.WindowInsetsController controller = window.getInsetsController();
            if (controller != null) controller.show(WindowInsets.Type.ime());
        }
    }

    private void confirmDelete(ExpressItem item) {
        dismissDialog(deleteConfirmationDialog);
        Dialog dialog = new MaterialAlertDialogBuilder(this)
                .setMessage(R.string.delete_express_confirm)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.mzuc_delete, (clickedDialog, which) -> {
                    ExpressRepository.get(this).delete(item.rowId);
                    Toast.makeText(this, ExpressToastCopy.DELETED, Toast.LENGTH_SHORT).show();
                })
                .create();
        deleteConfirmationDialog = dialog;
        dialog.setOnDismissListener(ignored -> {
            if (deleteConfirmationDialog == dialog) deleteConfirmationDialog = null;
        });
        dialog.show();
    }

    private static void dismissDialog(Dialog dialog) {
        if (dialog != null && dialog.isShowing()) dialog.dismiss();
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1100);
        }
    }

    private final class ExpressAdapter extends BaseAdapter {
        private final LayoutInflater inflater = LayoutInflater.from(ExpressListActivity.this);

        @Override public int getCount() { return items.size(); }
        @Override public ExpressItem getItem(int position) { return items.get(position); }
        @Override public long getItemId(int position) { return getItem(position).rowId; }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            Holder holder;
            if (convertView == null) {
                convertView = inflater.inflate(R.layout.item_express_list, parent, false);
                holder = new Holder(convertView);
                convertView.setTag(holder);
            } else {
                holder = (Holder) convertView.getTag();
            }
            ExpressItem item = getItem(position);
            holder.icon.setImageResource(item.displayIconResource());
            holder.title.setText(item.displayStatus());
            holder.title.setTextColor(statusColor(holder.title, item));
            holder.time.setText(item.latestTime);
            holder.time.setVisibility(item.latestTime.isEmpty() ? View.GONE : View.VISIBLE);
            holder.remark.setText(item.remark);
            holder.remark.setVisibility(item.remark.isEmpty() ? View.GONE : View.VISIBLE);
            holder.waybill.setText(getString(
                    R.string.express_company_waybill,
                    item.displayCompany(), item.displayWaybill()));
            holder.detail.setText(item.latestDetail);
            holder.detail.setVisibility(item.latestDetail.isEmpty() ? View.GONE : View.VISIBLE);
            holder.deleteButton.setOnClickListener(view -> confirmDelete(item));
            convertView.setOnClickListener(view -> startActivity(
                    new Intent(ExpressListActivity.this, ExpressDetailActivity.class)
                            .putExtra(ExpressDetailActivity.EXTRA_ROW_ID, item.rowId)));
            convertView.setOnLongClickListener(null);
            convertView.setLongClickable(false);
            return convertView;
        }
    }

    /** 三端同一张状态色表（用户定 2026-09-05）：与详情页 statusColor、Pipi、iOS statusTint 同表。 */
    private static int statusColor(View view, ExpressItem item) {
        switch (item.semantic == null ? StatusSemantic.UNKNOWN : item.semantic) {
            case DANGER: return ExpressStatusColors.DANGER;
            case WAITING_PICKUP: return ExpressStatusColors.WAITING_PICKUP;
            case DELIVERY: return ExpressStatusColors.DELIVERY;
            case COMPLETED: return ExpressStatusColors.COMPLETED;
            case PICKED:
            case TRANSIT: return ExpressStatusColors.TRANSIT;
            case ORDERED:
            case SHIPPED: return ExpressStatusColors.ORDERED;
            case CANCELLED: return ExpressStatusColors.NEUTRAL;
            default:
                return MaterialColors.getColor(
                        view, com.google.android.material.R.attr.colorOnSurfaceVariant);
        }
    }

    private static final class Holder {
        final ImageView icon;
        final TextView title;
        final TextView time;
        final TextView remark;
        final TextView waybill;
        final TextView detail;
        final ImageButton deleteButton;

        Holder(View root) {
            icon = root.findViewById(R.id.iv_cp_icon);
            title = root.findViewById(R.id.tv_cp_name_and_status);
            time = root.findViewById(R.id.tv_express_time);
            remark = root.findViewById(R.id.tv_remark);
            waybill = root.findViewById(R.id.tv_mail_no);
            detail = root.findViewById(R.id.tv_express_detail);
            deleteButton = root.findViewById(R.id.iv_delete);
        }
    }
}
