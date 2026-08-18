package me.pipi.deliveries.feature.express;

import android.content.Intent;
import android.os.Bundle;
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

import me.pipi.deliveries.R;
import me.pipi.deliveries.background.ExpressScheduler;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.network.ExpressAccountSource;
import me.pipi.deliveries.widget.ExpressWidgetProvider;

import java.util.ArrayList;

public final class ExpressManagerActivity extends AppCompatActivity {
    private static final long TITLE_TAP_WINDOW_MS = 1_500L;
    private final ArrayList<String> phones = new ArrayList<>();
    private PhoneAdapter adapter;
    private int titleTapCount;
    private long lastTitleTapAt;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_express_manager);
        MaterialToolbar toolbar = findViewById(R.id.top_app_bar);
        toolbar.setNavigationOnClickListener(view -> finish());
        toolbar.setOnClickListener(view -> onTitleTapped());
        ListView list = findViewById(android.R.id.list);
        list.setEmptyView(findViewById(R.id.phone_empty));
        adapter = new PhoneAdapter();
        list.setAdapter(adapter);
        findViewById(R.id.btn_bind_phone).setOnClickListener(view ->
                startActivity(new Intent(this, ExpressLoginActivity.class)));
    }

    @Override
    protected void onResume() {
        super.onResume();
        reloadPhones();
    }

    private void reloadPhones() {
        phones.clear();
        phones.addAll(ExpressRepository.get(this).phones(
                ExpressAccountSource.bindingSource(this)));
        adapter.notifyDataSetChanged();
    }

    private void onTitleTapped() {
        long now = android.os.SystemClock.elapsedRealtime();
        titleTapCount = now - lastTitleTapAt <= TITLE_TAP_WINDOW_MS
                ? titleTapCount + 1 : 1;
        lastTitleTapAt = now;
        if (titleTapCount < 3) return;
        titleTapCount = 0;
        String selected = ExpressAccountSource.toggle(this);
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
                    ExpressRepository.get(this).unbindPhone(
                            phone, ExpressAccountSource.bindingSource(this));
                    reloadPhones();
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
