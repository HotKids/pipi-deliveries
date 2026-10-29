package me.pipi.deliveries.feature.express;

import android.content.Intent;
import android.os.Bundle;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.text.style.TextAppearanceSpan;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.ImageButton;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import com.google.android.material.appbar.MaterialToolbar;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.color.MaterialColors;
import com.google.android.material.materialswitch.MaterialSwitch;

import me.pipi.deliveries.R;
import me.pipi.deliveries.background.ExpressScheduler;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.network.ExpressAccountSource;
import me.pipi.deliveries.notification.ExpressLiveNotifications;
import me.pipi.deliveries.widget.ExpressWidgetProvider;

import java.util.ArrayList;

public final class ExpressManagerActivity extends AppCompatActivity {
    private static final long TITLE_TAP_WINDOW_MS = 1_500L;
    private final ArrayList<String> phones = new ArrayList<>();
    private final java.util.concurrent.ExecutorService worker =
            java.util.concurrent.Executors.newSingleThreadExecutor();
    private int reloadGeneration;
    private PhoneAdapter adapter;
    private TextView phoneEmpty;
    private int titleTapCount;
    private long lastTitleTapAt;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_express_manager);
        MaterialToolbar toolbar = findViewById(R.id.top_app_bar);
        toolbar.setNavigationOnClickListener(view -> finish());
        toolbar.setOnClickListener(view -> onTitleTapped());
        toolbar.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        for (int i = 0; i < toolbar.getChildCount(); i++) {
            View child = toolbar.getChildAt(i);
            if (child instanceof TextView && android.text.TextUtils.equals(
                    ((TextView) child).getText(), toolbar.getTitle())) {
                child.setAccessibilityHeading(true);
            }
        }
        ListView list = findViewById(android.R.id.list);
        list.setItemsCanFocus(true);
        View header = getLayoutInflater().inflate(R.layout.header_express_manager, list, false);
        list.addHeaderView(header, null, false);
        phoneEmpty = header.findViewById(R.id.phone_empty);
        MaterialSwitch delivery = header.findViewById(R.id.live_delivery);
        MaterialSwitch pickup = header.findViewById(R.id.live_pickup);
        setSwitchSummary(delivery, R.string.live_delivery_summary);
        setSwitchSummary(pickup, R.string.live_pickup_summary);
        delivery.setChecked(ExpressLiveNotifications.deliveryEnabled(this));
        pickup.setChecked(ExpressLiveNotifications.pickupEnabled(this));
        delivery.setOnCheckedChangeListener((button, enabled) -> {
            ExpressLiveNotifications.setDeliveryEnabled(this, enabled);
            ExpressRepository.get(this).requestPendingNotificationReplay();
        });
        pickup.setOnCheckedChangeListener((button, enabled) -> {
            ExpressLiveNotifications.setPickupEnabled(this, enabled);
            ExpressRepository.get(this).requestPendingNotificationReplay();
        });
        adapter = new PhoneAdapter();
        list.setAdapter(adapter);
        findViewById(R.id.btn_bind_phone).setOnClickListener(view ->
                startActivity(new Intent(this, ExpressLoginActivity.class)));
    }

    private void setSwitchSummary(MaterialSwitch toggle, int summaryResource) {
        toggle.setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_BodyLarge);
        CharSequence title = toggle.getText();
        SpannableString label = new SpannableString(title + "\n" + getString(summaryResource));
        int summaryStart = title.length() + 1;
        label.setSpan(new TextAppearanceSpan(this,
                        com.google.android.material.R.style.TextAppearance_Material3_BodyMedium),
                summaryStart, label.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        label.setSpan(new ForegroundColorSpan(MaterialColors.getColor(toggle,
                        com.google.android.material.R.attr.colorOnSurfaceVariant)),
                summaryStart, label.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        toggle.setText(label);
    }

    @Override
    protected void onResume() {
        super.onResume();
        reloadPhones();
    }

    @Override protected void onDestroy() {
        reloadGeneration++;
        worker.shutdown();
        super.onDestroy();
    }

    private void reloadPhones() {
        int generation = ++reloadGeneration;
        String bindingSource = ExpressAccountSource.bindingSource(this);
        worker.execute(() -> {
            try {
                java.util.List<String> fresh = ExpressRepository.get(this).phones(bindingSource);
                runOnUiThread(() -> {
                    if (generation != reloadGeneration || isFinishing() || isDestroyed()
                            || !bindingSource.equals(ExpressAccountSource.bindingSource(this))) return;
                    phones.clear();
                    phones.addAll(fresh);
                    phoneEmpty.setVisibility(phones.isEmpty() ? View.VISIBLE : View.GONE);
                    adapter.notifyDataSetChanged();
                });
            } catch (RuntimeException failure) {
                // 「本地快递数据读取失败」只在列表加载失败时弹（审计 R8，用户 2026-09-25 默认 #13）：
                // 绑定管理页读失败时保持原来的列表，不弹。
            }
        });
    }

    private void onTitleTapped() {
        long now = android.os.SystemClock.elapsedRealtime();
        titleTapCount = now - lastTitleTapAt <= TITLE_TAP_WINDOW_MS
                ? titleTapCount + 1 : 1;
        lastTitleTapAt = now;
        if (titleTapCount < 3) return;
        titleTapCount = 0;
        String selected = ExpressAccountSource.toggle(this);
        ExpressRepository.get(this).requestPendingNotificationReplay();
        reloadPhones();
        ExpressWidgetProvider.refreshAll(this);
        ExpressScheduler.requestNow(this);
        Toast.makeText(this, getString(
                R.string.account_source_switched,
                ExpressAccountSource.displayName(selected)),
                Toast.LENGTH_SHORT).show();
    }

    private void confirmUnbind(String phone) {
        new MaterialAlertDialogBuilder(this)
                .setMessage(getString(R.string.unbind_phone_confirm, phone))
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.unbind_phone, (dialog, which) -> {
                    String bindingSource = ExpressAccountSource.bindingSource(this);
                    worker.execute(() -> {
                        boolean unbound;
                        try {
                            ExpressRepository.get(this).unbindPhone(phone, bindingSource);
                            unbound = true;
                        } catch (RuntimeException failure) {
                            unbound = false;
                        }
                        String message = unbound ? ExpressToastCopy.PHONE_UNBOUND : ExpressToastCopy.UNBIND_FAILED;
                        runOnUiThread(() -> {
                            if (isFinishing() || isDestroyed()) return;
                            reloadPhones();
                            Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
                        });
                    });
                })
                .show();
    }

    private final class PhoneAdapter extends BaseAdapter {
        private final LayoutInflater inflater = LayoutInflater.from(ExpressManagerActivity.this);

        @Override public int getCount() { return phones.size(); }
        @Override public String getItem(int position) { return phones.get(position); }
        @Override public long getItemId(int position) { return position; }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            PhoneHolder holder;
            if (convertView == null) {
                convertView = inflater.inflate(R.layout.item_express_phone, parent, false);
                holder = new PhoneHolder(convertView);
                convertView.setTag(holder);
            } else {
                holder = (PhoneHolder) convertView.getTag();
            }
            String phone = getItem(position);
            holder.phone.setText(phone);
            holder.delete.setContentDescription(getString(R.string.unbind_phone_tail,
                    phone.substring(Math.max(0, phone.length() - 4))));
            holder.delete.setOnClickListener(view -> confirmUnbind(phone));
            return convertView;
        }
    }

    private static final class PhoneHolder {
        final TextView phone;
        final ImageButton delete;

        PhoneHolder(View root) {
            phone = root.findViewById(R.id.phone_text);
            delete = root.findViewById(R.id.delete_phone);
        }
    }
}
