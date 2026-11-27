package me.pipi.deliveries.notification;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import me.pipi.deliveries.util.PipiExecutors;

/**
 * The single promoted-notification publication path for every live surface.
 *
 * <p>Posts, probes, replacements and explicit cancellations are serialized under one lock. A
 * monotonically unique generation is checked both before and after querying SystemUI, so a stale
 * probe can never repost a notification after cancellation or a newer post.</p>
 */
public final class PromotedNotificationPublisher {
    private static final String TAG = "PipiPromoted";
    private static final long PROBE_DELAY_MS = 1_200L;
    private static final long PROBE_CONFIRM_DELAY_MS = 6_000L;
    private static final long PROBE_DELIVERY_MARGIN_MS = 500L;
    private static final String EXTRA_REQUEST_PROMOTED =
            "android.requestPromotedOngoing";
    private static final String EXTRA_PREFER_SMALL_ICON =
            "android.app.preferSmallIcon";
    private static final String EXTRA_SHOW_SMALL_ICON =
            "android.showSmallIcon";
    private static final String SAMSUNG_NOW_BAR_PREFIX =
            "android.ongoingActivityNoti.";
    private static final String SAMSUNG_REMINDER_PREFIX =
            "android.sreminder.";
    private static final float NOTIFICATION_SMALL_ICON_DP = 24f;

    private static final Object LOCK = new Object();
    private static final NotificationGenerationRegistry GENERATIONS =
            new NotificationGenerationRegistry();
    private static final Map<NotificationKey, ProbeState> PROBES = new HashMap<>();
    private static final ScheduledExecutorService PROBE_EXECUTOR =
            Executors.newSingleThreadScheduledExecutor(
                    PipiExecutors.namedFactory("pipi-systemui-probe"));

    private PromotedNotificationPublisher() {}

    /** Adds the public promoted contract and the Samsung-only small-icon hint. */
    public static void configureEnhanced(Context context, Notification.Builder builder,
                                         String capsule) {
        configurePromoted(builder, capsule);
        if (SamsungNowBarCompat.shouldTrySamsungEnhancement(context)) {
            Bundle extras = new Bundle();
            extras.putBoolean(EXTRA_SHOW_SMALL_ICON, true);
            builder.addExtras(extras);
        }
    }

    /** Adds only public Android promoted-notification fields. */
    public static void configureGeneric(Notification.Builder builder, String capsule) {
        configurePromoted(builder, capsule);
    }

    /** Uses only the public icon preference for non-promoted notifications. */
    public static void configurePreferredSmallIcon(Notification.Builder builder) {
        Bundle extras = new Bundle();
        extras.putBoolean(EXTRA_PREFER_SMALL_ICON, true);
        builder.addExtras(extras);
    }

    private static void configurePromoted(Notification.Builder builder, String capsule) {
        if (Build.VERSION.SDK_INT >= 36) {
            try {
                Notification.Builder.class.getMethod(
                                "setRequestPromotedOngoing", boolean.class)
                        .invoke(builder, true);
            } catch (Throwable error) {
                // Optional API: extras below preserve the public fallback contract.
                Log.w(TAG, "promoted ongoing builder API unavailable; using extras fallback" + " kind=" + error.getClass().getSimpleName());
            }
        }
        Bundle extras = new Bundle();
        extras.putBoolean(EXTRA_REQUEST_PROMOTED, true);
        extras.putBoolean(EXTRA_PREFER_SMALL_ICON, true);
        builder.addExtras(extras);
        if (Build.VERSION.SDK_INT >= 36) builder.setShortCriticalText(capsule);
    }

    /**
     * Posts the enhanced variant, probes supported Samsung SystemUI, and atomically replaces a
     * rejected notification with a private-extra-free generic clone.
     */
    public static void post(Context context, NotificationManager manager, NotificationKey key,
                            Notification enhanced, Notification genericAndroid) {
        post(context, manager, key, enhanced, genericAndroid, null);
    }

    /** Tries the native pickup template before the established pickup notification. */
    @SuppressLint("MissingPermission")
    public static void post(Context context, NotificationManager manager, NotificationKey key,
                            Notification enhanced, Notification genericAndroid,
                            Notification pickupNowBar) {
        if (context == null || manager == null || key == null || enhanced == null) return;
        Context app = context.getApplicationContext();
        Notification generic = genericClone(genericAndroid == null ? enhanced : genericAndroid);
        long fallbackGeneration = 0L;
        synchronized (LOCK) {
            cancelProbeLocked(key);
            long generation = GENERATIONS.advance(key);
            if (pickupNowBar != null && SamsungNowBarCompat.shouldTryPickupNowBar(app)
                    && canProbeDelivery(app, manager, pickupNowBar)) {
                try {
                    key.notify(manager, pickupNowBar);
                    scheduleProbeLocked(app, manager, key, generation, generic, enhanced);
                    return;
                } catch (IllegalArgumentException rejected) {
                    SamsungNowBarCompat.recordPickupNowBarRejection(app);
                    Log.w(TAG, "Pickup Now Bar notification rejected during posting");
                }
            }
            if (SamsungNowBarCompat.useGenericFallback(app)) {
                fallbackGeneration = generation;
            } else {
                postEnhancedLocked(app, manager, key, generation, enhanced, generic);
                return;
            }
        }
        // Drawable loading, bitmap allocation/drawing and Builder recovery are deliberately
        // outside the publication lock. The generation check below still prevents a cancel or
        // newer post that raced this preparation from being resurrected.
        Notification compacted = compactSamsungFallback(app, generic);
        synchronized (LOCK) {
            if (!GENERATIONS.isCurrent(key, fallbackGeneration)) return;
            try {
                key.notify(manager, compacted);
                Log.w(TAG, "Using generic Android live update key=" + key.logLabel()
                        + " fingerprint=" + SamsungNowBarCompat.fingerprint(app));
            } finally {
                GENERATIONS.clearIfCurrent(key, fallbackGeneration);
            }
        }
    }

    private static void postEnhancedLocked(Context app, NotificationManager manager,
                                           NotificationKey key, long generation,
                                           Notification enhanced, Notification generic) {
        key.notify(manager, enhanced);
        if (SamsungNowBarCompat.shouldProbeDelivery(app)
                && canProbeDelivery(app, manager, enhanced)) {
            scheduleProbeLocked(app, manager, key, generation, generic, null);
        } else {
            finishProbeLocked(key, generation);
        }
    }

    private static boolean canProbeDelivery(Context app, NotificationManager manager,
                                            Notification notification) {
        return PromotedNotificationPolicy.hasProbeWindow(
                notification.getTimeoutAfter(), PROBE_DELAY_MS + PROBE_CONFIRM_DELAY_MS,
                PROBE_DELIVERY_MARGIN_MS) && canObserveDelivery(app, manager, notification);
    }

    private static void scheduleProbeLocked(Context app, NotificationManager manager,
                                            NotificationKey key, long generation,
                                            Notification generic, Notification pickupFallback) {
        String expectedFingerprint = NotificationDismissalStore.activeFingerprint(app, key);
        String expectedToken = NotificationDismissalStore.activeToken(app, key);
        ProbeState state = new ProbeState(generation, pickupFallback);
        PROBES.put(key, state);
        state.future = PROBE_EXECUTOR.schedule(
                () -> probe(app, manager, key, generation, generic,
                        expectedFingerprint, expectedToken, false),
                PROBE_DELAY_MS, TimeUnit.MILLISECONDS);
    }

    /** Posts an ordinary replacement while invalidating an older live probe for the same ID. */
    @SuppressLint("MissingPermission")
    public static void postStandard(NotificationManager manager, NotificationKey key,
                                    Notification notification) {
        if (manager == null || key == null || notification == null) return;
        synchronized (LOCK) {
            cancelProbeLocked(key);
            key.notify(manager, notification);
        }
    }

    /** Explicit cancellation shares the final-notify lock and therefore cannot be resurrected. */
    public static void cancel(NotificationManager manager, NotificationKey key) {
        if (manager == null || key == null) return;
        synchronized (LOCK) {
            cancelProbeLocked(key);
            key.cancel(manager);
        }
    }

    /** Stops the compatibility probe before it can mistake a user swipe for SystemUI removal. */
    static void onUserDismissed(NotificationKey key) {
        if (key == null) return;
        synchronized (LOCK) {
            cancelProbeLocked(key);
        }
    }

    private static void probe(Context context, NotificationManager manager, NotificationKey key,
                              long generation, Notification genericAndroid,
                              String expectedFingerprint, String expectedToken,
                              boolean confirmation) {
        // First generation check: do no SystemUI work for a cancelled/replaced post.
        if (!GENERATIONS.isCurrent(key, generation)) return;
        if (!canObserveDelivery(context, manager, genericAndroid)) {
            finishProbe(key, generation);
            return;
        }
        boolean active = false;
        try {
            StatusBarNotification[] notifications = manager.getActiveNotifications();
            if (notifications != null) {
                for (StatusBarNotification notification : notifications) {
                    if (key.matches(notification, context.getPackageName())) {
                        active = true;
                        break;
                    }
                }
            }
        } catch (Throwable error) {
            Log.w(TAG, "SystemUI survival probe unavailable key=" + key.logLabel() + " kind=" + error.getClass().getSimpleName());
            finishProbe(key, generation);
            return;
        }

        boolean pickupNowBar;
        synchronized (LOCK) {
            // Second generation check: cancellation may have happened during the framework query.
            if (!GENERATIONS.isCurrent(key, generation)) return;
            if (!canObserveDelivery(context, manager, genericAndroid)) {
                finishProbeLocked(key, generation);
                return;
            }
            ProbeState state = PROBES.get(key);
            if (state == null || state.generation != generation) return;
            pickupNowBar = state.pickupFallback != null;
            if (active) {
                if (!confirmation) {
                    state.future = PROBE_EXECUTOR.schedule(
                            () -> probe(context, manager, key, generation,
                                    genericAndroid, expectedFingerprint, expectedToken, true),
                            PROBE_CONFIRM_DELAY_MS,
                            TimeUnit.MILLISECONDS);
                    if (!pickupNowBar) {
                        Log.i(TAG, "Samsung enhancement passed initial delivery key=" + key.logLabel());
                    }
                    return;
                }
                if (pickupNowBar) {
                    Log.i(TAG, "Pickup Now Bar notification delivery observed");
                } else {
                    SamsungNowBarCompat.recordProbe(context, true);
                    Log.i(TAG, "Samsung enhancement survived delayed confirmation key=" + key.logLabel());
                }
                finishProbeLocked(key, generation);
                return;
            }
            if (NotificationDismissalStore.wasDismissedForProbe(
                    context, key, expectedFingerprint, expectedToken)) {
                Log.i(TAG, "Live update dismissed by user before probe fallback key=" + key.logLabel());
                finishProbeLocked(key, generation);
                return;
            }
            if (!SamsungNowBarCompat.SYSTEM_UI_ERROR_FALLBACK_ENABLED) {
                Log.w(TAG, "SystemUI removed enhanced live update key=" + key.logLabel()
                        + "; temporary error fallback disabled");
                finishProbeLocked(key, generation);
                return;
            }
            if (pickupNowBar && !SamsungNowBarCompat.useGenericFallback(context)) {
                SamsungNowBarCompat.recordPickupNowBarRejection(context);
                Log.w(TAG, "Pickup Now Bar removed; restoring the established pickup notification");
                try {
                    postEnhancedLocked(context, manager, key, generation,
                            state.pickupFallback, genericAndroid);
                } catch (RuntimeException failure) {
                    finishProbeLocked(key, generation);
                    Log.w(TAG, "Unable to restore pickup notification"
                            + " kind=" + failure.getClass().getSimpleName());
                    throw failure;
                }
                return;
            }
        }
        Notification compacted = compactSamsungFallback(context, genericAndroid);
        synchronized (LOCK) {
            if (!GENERATIONS.isCurrent(key, generation)) return;
            if (!canObserveDelivery(context, manager, genericAndroid)) {
                finishProbeLocked(key, generation);
                return;
            }
            if (NotificationDismissalStore.wasDismissedForProbe(
                    context, key, expectedFingerprint, expectedToken)) {
                Log.i(TAG, "Live update dismissed by user during fallback preparation key=" + key.logLabel());
                finishProbeLocked(key, generation);
                return;
            }
            if (pickupNowBar) {
                SamsungNowBarCompat.recordPickupNowBarRejection(context);
                Log.w(TAG, "Pickup Now Bar removed; restoring the generic pickup notification");
            } else {
                int failures = SamsungNowBarCompat.recordProbe(context, false);
                Log.w(TAG, "SystemUI removed enhanced live update key=" + key.logLabel()
                        + " failures=" + failures
                        + "; reposting generic Android live update");
            }
            if (!GENERATIONS.isCurrent(key, generation)) return;
            try {
                key.notify(manager, compacted);
            } finally {
                finishProbeLocked(key, generation);
            }
        }
    }

    /**
     * Samsung's generic promoted-notification fallback draws the ordinary small icon inside a
     * tighter lock-screen circle than its enhanced template. Apply the same centered 0.80 scale
     * to every live surface only after that fallback is selected; other Android and Samsung's
     * enhanced path retain their canonical small icons.
     */
    static Notification compactSamsungFallback(Context context, Notification notification) {
        if (context == null || notification == null || notification.getSmallIcon() == null) {
            return notification;
        }
        try {
            Drawable drawable = notification.getSmallIcon().loadDrawable(context);
            if (drawable == null) return notification;
            float density = context.getResources().getDisplayMetrics().density;
            int size = Math.max(1, Math.round(NOTIFICATION_SMALL_ICON_DP * density));
            int contentSize = PromotedNotificationPolicy.fallbackIconContentSize(size);
            int inset = Math.max(0, (size - contentSize) / 2);
            Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            bitmap.setDensity(context.getResources().getDisplayMetrics().densityDpi);
            drawable.setBounds(inset, inset, inset + contentSize, inset + contentSize);
            drawable.draw(new Canvas(bitmap));
            return Notification.Builder.recoverBuilder(context, notification)
                    .setSmallIcon(Icon.createWithBitmap(bitmap))
                    .build();
        } catch (Throwable error) {
            Log.w(TAG, "Unable to compact Samsung fallback small icon" + " kind=" + error.getClass().getSimpleName());
            return notification;
        }
    }

    private static void finishProbe(NotificationKey key, long generation) {
        synchronized (LOCK) {
            finishProbeLocked(key, generation);
        }
    }

    private static void finishProbeLocked(NotificationKey key, long generation) {
        ProbeState state = PROBES.get(key);
        if (state != null && state.generation == generation) PROBES.remove(key);
        GENERATIONS.clearIfCurrent(key, generation);
    }

    private static void cancelProbeLocked(NotificationKey key) {
        GENERATIONS.invalidate(key);
        ProbeState previous = PROBES.remove(key);
        if (previous != null && previous.future != null) previous.future.cancel(false);
    }

    private static boolean canObserveDelivery(Context context, NotificationManager manager,
                                              Notification notification) {
        try {
            if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                return false;
            }
            if (!manager.areNotificationsEnabled()) return false;
            String channelId = notification.getChannelId();
            if (channelId == null || channelId.isEmpty()) return false;
            NotificationChannel channel = manager.getNotificationChannel(channelId);
            return channel != null
                    && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
        } catch (Throwable error) {
            Log.w(TAG, "Unable to verify notification permission/channel state" + " kind=" + error.getClass().getSimpleName());
            return false;
        }
    }

    private static Notification genericClone(Notification source) {
        Notification copy = source.clone();
        Bundle extras = copy.extras;
        if (extras == null || extras.isEmpty()) return copy;
        extras.remove(EXTRA_SHOW_SMALL_ICON);
        Iterator<String> keys = extras.keySet().iterator();
        while (keys.hasNext()) {
            String key = keys.next();
            if (key.startsWith(SAMSUNG_NOW_BAR_PREFIX)
                    || key.startsWith(SAMSUNG_REMINDER_PREFIX)) {
                keys.remove();
            }
        }
        return copy;
    }

    private static final class ProbeState {
        final long generation;
        final Notification pickupFallback;
        ScheduledFuture<?> future;

        ProbeState(long generation, Notification pickupFallback) {
            this.generation = generation;
            this.pickupFallback = pickupFallback;
        }
    }
}
