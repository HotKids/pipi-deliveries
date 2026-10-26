package me.pipi.deliveries.notification;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Persists user dismissal before a later unchanged publication can restore it. */
public final class NotificationDismissedReceiver extends BroadcastReceiver {
    static final String ACTION_DISMISSED = "me.pipi.deliveries.notification.USER_DISMISSED";
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "deliveries-notification-dismissal");
        thread.setDaemon(true);
        return thread;
    });

    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_DISMISSED.equals(intent.getAction())) return;
        String label = intent.getStringExtra(NotificationDismissalStore.EXTRA_KEY);
        int id = intent.getIntExtra(NotificationDismissalStore.EXTRA_ID, 0);
        String fingerprint = intent.getStringExtra(NotificationDismissalStore.EXTRA_FINGERPRINT);
        String token = intent.getStringExtra(NotificationDismissalStore.EXTRA_TOKEN);
        if (label == null || label.isEmpty() || id != ExpressLiveNotifications.LIVE_ID) return;
        Context application = context.getApplicationContext();
        PendingResult pending = goAsync();
        WORKER.execute(() -> {
            try {
                ExpressLiveNotifications.onDismissed(application, fingerprint, token);
            } finally {
                if (pending != null) pending.finish();
            }
        });
    }
}
