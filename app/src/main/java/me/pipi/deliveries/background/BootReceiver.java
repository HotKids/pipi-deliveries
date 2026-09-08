package me.pipi.deliveries.background;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import me.pipi.deliveries.widget.ExpressWidgetProvider;

public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
        ExpressScheduler.ensureScheduled(context);
        ExpressWidgetProvider.refreshAll(context);
    }
}
