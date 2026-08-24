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
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.network.ExpressApi;
import me.pipi.deliveries.network.ExpressAccountSource;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import me.pipi.deliveries.network.ExpressSubscriptionClient;
import me.pipi.deliveries.network.ManualQueryCoordinator;

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
    private static final long MANUAL_QUERY_TIMEOUT_MS = 30_000L;
    private static final String STATE_PHONE_TAIL_DIALOG = "phone_tail_dialog";
    private static final String STATE_PHONE_TAIL_WAYBILL = "phone_tail_waybill";
    private static final String STATE_PHONE_TAIL_COURIER = "phone_tail_courier";
    private static final String STATE_PHONE_TAIL_MISMATCH = "phone_tail_mismatch";
    private static final String STATE_PHONE_TAIL_VALUE = "phone_tail_value";
    private static final String STATE_MANUAL_QUERY_CANCELLED = "manual_query_cancelled";
    private final ArrayList<ExpressItem> items = new ArrayList<>();
    private ExpressAdapter adapter;
    private ListView list;
    private View empty;
    private View retentionNotice;
    private SwipeRefreshLayout swipeRefresh;
    private final ExecutorService queryWorker = Executors.newSingleThreadExecutor();
    private final ExecutorService carrierDetectWorker = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private Future<?> queryTask;
    private Future<?> carrierDetectTask;
    private ExpressQueryCancellation queryCancellation;
    private ExpressQueryCancellation carrierDetectCancellation;
    private Runnable carrierDetectStart;
    private volatile long queryGeneration;
    private TextInputLayout queryContainer;
    private TextInputEditText queryInput;
    private volatile long carrierDetectGeneration;
    private volatile String detectedWaybill = "";
    private volatile String detectedCourierCode = "";
    private boolean querying;
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
    private ExpressOrderProjectionRetryStore orderProjectionRetries;
    private ExpressHomeOrderProjectionCapture orderProjectionCapture;
    private ExpressOrderProjectionRetryStore.AttemptToken orderProjectionAttemptToken;
    private boolean orderProjectionCaptureEnabled;
    private boolean resetOrderProjectionAttemptsAfterCapture;
    private final ManualQueryStopNotice manualQueryStopNotice = new ManualQueryStopNotice();

    private final BroadcastReceiver changes = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (intent != null
                    && ExpressRepository.ACTION_SYNC_FINISHED.equals(intent.getAction())) {
                if (orderProjectionCapture == null) attemptedOrderProjections.clear();
                else resetOrderProjectionAttemptsAfterCapture = true;
            }
            reload();
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        orderProjectionRetries = new ExpressOrderProjectionRetryStore(this);
        if (state != null) {
            manualQueryStopNotice.restore(
                    state.getBoolean(STATE_MANUAL_QUERY_CANCELLED, false));
        }
        setContentView(R.layout.activity_express_list);
        list = findViewById(android.R.id.list);
        empty = findViewById(R.id.emptyView);
        swipeRefresh = findViewById(R.id.swipe_refresh);
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
            boolean enter = event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER;
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
        swipeRefresh.setColorSchemeColors(MaterialColors.getColor(
                swipeRefresh, androidx.appcompat.R.attr.colorPrimary));
        swipeRefresh.setProgressBackgroundColorSchemeColor(MaterialColors.getColor(
                swipeRefresh, com.google.android.material.R.attr.colorSurfaceContainer));
        float density = getResources().getDisplayMetrics().density;
        swipeRefresh.setProgressViewOffset(
                true,
                0,
                Math.round(24f * density));
        swipeRefresh.setDistanceToTriggerSync(Math.round(64f * density));
        swipeRefresh.setOnRefreshListener(() -> {
            ExpressScheduler.requestNow(this);
            swipeRefresh.postDelayed(() -> swipeRefresh.setRefreshing(false), 15_000L);
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
        if (manualQueryStopNotice.consume()) {
            Toast.makeText(this, R.string.manual_query_cancelled, Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onStop() {
        manualQueryStopNotice.markIfActive(querying);
        invalidateInteractiveNetworkOperations();
        orderProjectionCaptureEnabled = false;
        resetOrderProjectionAttemptsAfterCapture = false;
        if (orderProjectionCapture != null) {
            orderProjectionRetries.endAttempt(orderProjectionAttemptToken);
            orderProjectionAttemptToken = null;
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
        state.putBoolean(STATE_MANUAL_QUERY_CANCELLED,
                manualQueryStopNotice.snapshot() || querying);
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

    static final class ManualQueryStopNotice {
        private boolean pending;

        void markIfActive(boolean active) {
            pending |= active;
        }

        void restore(boolean saved) {
            pending |= saved;
        }

        boolean snapshot() {
            return pending;
        }

        boolean consume() {
            boolean result = pending;
            pending = false;
            return result;
        }
    }

    @Override
    protected void onDestroy() {
        if (orderProjectionCapture != null) {
            orderProjectionRetries.endAttempt(orderProjectionAttemptToken);
            orderProjectionAttemptToken = null;
            orderProjectionCapture.cancel();
            orderProjectionCapture = null;
        }
        dismissDialog(phoneTailDialog);
        dismissDialog(deleteConfirmationDialog);
        invalidateInteractiveNetworkOperations();
        queryWorker.shutdownNow();
        carrierDetectWorker.shutdownNow();
        super.onDestroy();
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
            ExpressOrderProjectionRetryStore.AttemptToken token =
                    orderProjectionRetries.beginAttempt(
                            candidate, System.currentTimeMillis(), false);
            if (token == null) {
                continue;
            }
            ExpressHomeOrderProjectionCapture capture =
                    new ExpressHomeOrderProjectionCapture(
                            this, candidate, this::onOrderProjectionCaptureFinished);
            orderProjectionCapture = capture;
            orderProjectionAttemptToken = token;
            if (capture.start()) return;
            orderProjectionCapture = null;
            orderProjectionAttemptToken = null;
            settleOrderProjectionAttempt(candidate, token, false);
        }
    }

    private void onOrderProjectionCaptureFinished(
            ExpressHomeOrderProjectionCapture capture, boolean saved) {
        if (capture != orderProjectionCapture) return;
        orderProjectionCapture = null;
        ExpressOrderProjectionRetryStore.AttemptToken token = orderProjectionAttemptToken;
        orderProjectionAttemptToken = null;
        ExpressItem captured = capture.sourceItem();
        settleOrderProjectionAttempt(captured, token, saved);
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

    private void settleOrderProjectionAttempt(
            ExpressItem expected, ExpressOrderProjectionRetryStore.AttemptToken token,
            boolean saved) {
        ExpressRepository repository = ExpressRepository.get(this);
        ExpressItem current = expected == null ? null : repository.find(expected.rowId);
        ExpressItem unresolved = ExpressOrderProjectionRetryStore.currentUnresolvedOwner(
                expected, current);
        ExpressOrderProjectionRetryStore.completeAttempt(token, () -> {
            if (saved || unresolved == null) {
                orderProjectionRetries.clear(expected);
            } else {
                orderProjectionRetries.recordFailure(
                        expected, System.currentTimeMillis());
            }
        }, failure -> Log.w(
                "ExpressOrderProjection",
                "Projection retry state could not be saved",
                failure));
    }

    static ExpressItem nextOrderProjectionCandidate(
            List<ExpressItem> values, Set<String> attempted) {
        if (values == null || attempted == null) return null;
        for (ExpressItem value : values) {
            if (!ExpressHomeOrderProjectionCapture.needsProjection(value)) continue;
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
        queryWaybill("", "");
    }

    private void queryWaybill(String suppliedPhoneTail, String suppliedCourierHint) {
        String waybill = queryInput.getText() == null
                ? "" : queryInput.getText().toString().trim();
        if (querying) return;
        if (waybill.length() < 6) {
            String message = getString(R.string.invalid_waybill);
            Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
            return;
        }
        querying = true;
        long operationGeneration = ++queryGeneration;
        queryContainer.setError(null);
        queryInput.setEnabled(false);
        hideKeyboard();
        String detectedAtSubmission = waybill.equals(detectedWaybill)
                ? detectedCourierCode : "";
        carrierDetectGeneration++;
        if (carrierDetectStart != null) {
            mainHandler.removeCallbacks(carrierDetectStart);
            carrierDetectStart = null;
        }
        if (carrierDetectCancellation != null) carrierDetectCancellation.cancel();
        carrierDetectCancellation = null;
        if (carrierDetectTask != null) carrierDetectTask.cancel(true);
        carrierDetectTask = null;
        String queryBindingSource = ExpressAccountSource.bindingSource(this);
        ExpressQueryCancellation operationCancellation =
                new ExpressQueryCancellation(MANUAL_QUERY_TIMEOUT_MS);
        queryCancellation = operationCancellation;
        queryTask = queryWorker.submit(() -> {
            String attemptedCourierHint = suppliedCourierHint == null
                    ? "" : suppliedCourierHint;
            try {
                ExpressRepository repository = ExpressRepository.get(this);
                ExpressItem existing = repository.findByWaybill(waybill, queryBindingSource);
                ArrayList<String> phones = new ArrayList<>();
                if (suppliedPhoneTail != null && !suppliedPhoneTail.isEmpty()) {
                    phones.add(suppliedPhoneTail);
                }
                phones.addAll(repository.phoneCandidates(
                        existing == null ? "" : existing.phone, queryBindingSource));
                String liveDetected = detectedAtSubmission;
                if (liveDetected.isEmpty() && waybill.equals(detectedWaybill)) {
                    // Never serialize submission behind the decorative classifier preview. The
                    // selected manual source and its K100 fallback both perform authoritative
                    // recognition as part of their own bounded request.
                    liveDetected = detectedCourierCode;
                }
                String courierHint = suppliedCourierHint == null
                        || suppliedCourierHint.isEmpty()
                        ? !liveDetected.isEmpty()
                                ? liveDetected
                                : existing == null ? "" : existing.courierCode
                        : suppliedCourierHint;
                attemptedCourierHint = courierHint;
                ExpressQueryResult result;
                boolean requireTimedTimeline = existing != null
                        && existing.isInterface5ShunFengSource();
                result = ManualQueryCoordinator.queryForBindingSource(
                        queryBindingSource, requireTimedTimeline,
                        () -> new ExpressDiscoveryClient().queryManual(
                                getApplicationContext(), waybill,
                                repository.phones(queryBindingSource),
                                operationCancellation),
                        () -> new ExpressSubscriptionClient().queryManual(
                                getApplicationContext(), waybill,
                                operationCancellation),
                        () -> new ExpressApi(getApplicationContext()).queryWithPhones(
                                waybill, courierHint, phones, operationCancellation));
                String queryPhone = !result.phone.isEmpty()
                        ? result.phone
                        : suppliedPhoneTail == null || suppliedPhoneTail.isEmpty()
                        ? existing == null ? "" : existing.phone
                        : suppliedPhoneTail;
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()
                            || !queryOperationIsCurrent(
                            operationGeneration, queryBindingSource)) return;
                    if (queryCancellation == operationCancellation) {
                        queryCancellation = null;
                    }
                    queryTask = null;
                    querying = false;
                    queryInput.setEnabled(true);
                    queryInput.setText("");
                    Toast.makeText(this,
                            (requireTimedTimeline
                                    ? Kuaidi100TimelinePolicy.hasTimedTracking(result)
                                    : Kuaidi100TimelinePolicy.hasRealTracking(result))
                                    ? R.string.manual_query_success
                                    : R.string.manual_query_no_track,
                            Toast.LENGTH_SHORT).show();
                    startActivity(ExpressDetailActivity.previewIntent(
                            this, result, queryPhone, queryBindingSource));
                });
            } catch (Throwable failure) {
                String message = failure instanceof InterruptedException
                        ? getString(R.string.manual_query_timeout)
                        : failure.getMessage() == null
                        ? getString(R.string.network_exception) : failure.getMessage();
                String retryCourierHint = attemptedCourierHint;
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()
                            || !queryOperationIsCurrent(
                            operationGeneration, queryBindingSource)) return;
                    if (queryCancellation == operationCancellation) {
                        queryCancellation = null;
                    }
                    queryTask = null;
                    querying = false;
                    queryInput.setEnabled(true);
                    if (failure instanceof ExpressApi.QueryException) {
                        ExpressApi.QueryException queryFailure =
                                (ExpressApi.QueryException) failure;
                        if (queryFailure.needsPhoneTail()) {
                            queryContainer.setError(null);
                            showPhoneTailDialog(
                                    waybill, retryCourierHint,
                                    queryFailure.phoneTailMismatch());
                            return;
                        }
                    }
                    queryContainer.setError(null);
                    boolean unrecognized = isCarrierRecognitionFailure(message);
                    if (unrecognized) updateCarrierSuffix("");
                    Toast.makeText(this, unrecognized
                                    ? getString(R.string.carrier_unrecognized) : message,
                            Toast.LENGTH_SHORT).show();
                });
            }
        });
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
            CarrierRegistry.Carrier cached = existing == null ? null
                    : CarrierRegistry.resolve(existing.courierCode, existing.companyName);
            if (cached != null) {
                code = cached.kuaidi100Code;
                company = CarrierRegistry.displayName(
                        existing.courierCode, existing.companyName);
            } else {
                if ("interface5".equals(bindingSource)) {
                    ExpressDiscoveryClient.CarrierMatch detected =
                            new ExpressDiscoveryClient().detectManualCarrier(
                                    getApplicationContext(), waybill, cancellation);
                    code = detected.code;
                    company = CarrierRegistry.displayName(code, detected.name);
                } else {
                    code = new ExpressApi(getApplicationContext()).detect(
                            waybill, cancellation);
                    CarrierRegistry.Carrier detected = CarrierRegistry.resolve(code, "");
                    company = detected == null ? ""
                            : CarrierRegistry.displayName(code, detected.companyName);
                }
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
        queryGeneration++;
        if (queryCancellation != null) queryCancellation.cancel();
        queryCancellation = null;
        if (queryTask != null) queryTask.cancel(true);
        queryTask = null;
        querying = false;
        if (queryInput != null) queryInput.setEnabled(true);

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

    private boolean queryOperationIsCurrent(long generation, String bindingSource) {
        return operationIsCurrent(
                generation, bindingSource, queryGeneration,
                ExpressAccountSource.bindingSource(this));
    }

    static boolean operationIsCurrent(
            long expectedGeneration, String expectedBindingSource,
            long currentGeneration, String currentBindingSource) {
        return expectedGeneration == currentGeneration
                && expectedBindingSource != null
                && expectedBindingSource.equals(currentBindingSource);
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

    private static boolean isCarrierRecognitionFailure(String message) {
        String value = message == null ? "" : message.trim();
        return value.contains("识别承运商")
                || value.contains("快递公司")
                || value.contains("有效的快递单号");
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
                .setPositiveButton(R.string.mzuc_delete, (clickedDialog, which) ->
                        ExpressRepository.get(this).delete(item.rowId))
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

    private static int statusColor(View view, ExpressItem item) {
        switch (item.semantic) {
            case CANCELLED:
            case DANGER:
                return MaterialColors.getColor(
                        view, androidx.appcompat.R.attr.colorError);
            case COMPLETED:
                return MaterialColors.getColor(
                        view, com.google.android.material.R.attr.colorTertiary);
            case UNKNOWN:
                return MaterialColors.getColor(
                        view, com.google.android.material.R.attr.colorOnSurfaceVariant);
            default:
                return MaterialColors.getColor(
                        view, androidx.appcompat.R.attr.colorPrimary);
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
