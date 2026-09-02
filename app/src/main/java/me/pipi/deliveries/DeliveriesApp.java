package me.pipi.deliveries;

import android.app.Application;
import android.util.Log;

import com.google.android.material.color.DynamicColors;

import me.pipi.deliveries.background.ExpressScheduler;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.network.CarrierAuthority;
import me.pipi.deliveries.notification.ExpressNotifications;

/** Process entrypoint for the source-native implementation. */
public final class DeliveriesApp extends Application {
    private static final String TAG = "DeliveriesApp";

    @Override
    public void onCreate() {
        super.onCreate();
        CarrierAuthority.initialize(this);
        DynamicColors.applyToActivitiesIfAvailable(this);
        ExpressNotifications.ensureChannels(this);
        ExpressScheduler.ensureScheduled(this);
        runLocalMaintenance();
    }

    private void runLocalMaintenance() {
        Thread maintenance = new Thread(() -> {
            try {
                ExpressRepository repository = ExpressRepository.get(this);
                repository.runPendingMigrations();
                repository.pruneExpiredShipmentsIfDue();
            } catch (Throwable failure) {
                Log.w(TAG, "Local maintenance failed; a later worker will retry", failure);
            }
        }, "deliveries-maintenance");
        maintenance.start();
    }
}
