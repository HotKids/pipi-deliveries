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


/**
 * The single promoted-notification publication path for every live surface.
 *
 * <p>Posts, probes, replacements and explicit cancellations are serialized under one lock. A
 * monotonically unique generation is checked both before and after querying SystemUI, so a stale
 * probe can never repost a notification after cancellation or a newer post.</p>
 */
public final class PromotedNotificationPublisher {
    private static final String TAG = "DeliveriesPromoted";
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
                    runnable -> {
                        Thread thread = new Thread(runnable, "deliveries-systemui-probe");
                        thread.setDaemon(true);
                        return thread;
                    });

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

    private static void configurePromoted(Notification.Builder builder, String capsule) {
        if (Build.VERSION.SDK_INT >= 36) {
            try {
                Notification.Builder.class.getMethod(
                                "setRequestPromotedOngoing", boolean.class)
                        .invoke(builder, true);
            } catch (Throwable error) {
                // Optional API: extras below preserve the public fallback contract.
                Log.w(TAG, "promoted ongoing builder API unavailable; using extras fallback",
                        error);
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
    @SuppressLint("MissingPermission")
    public static void post(Context context, NotificationManager manager, NotificationKey key,
                            Notification enhanced, Notification genericAndroid) {
        if (context == null || manager == null || key == null || enhanced == null) return;
        Context app = context.getApplicationContext();
        Notification generic = genericClone(genericAndroid == null ? enhanced : genericAndroid);
        long fallbackGeneration = 0L;
        synchronized (LOCK) {
            cancelProbeLocked(key);
            long generation = GENERATIONS.advance(key);
            if (SamsungNowBarCompat.useGenericFallback(app)) {
                fallbackGeneration = generation;
            } else {
                key.notify(manager, enhanced);
                boolean shouldProbe = SamsungNowBarCompat.shouldProbeDelivery(app)
                        && canObserveDelivery(app, manager, enhanced)
                        && PromotedNotificationPolicy.hasProbeWindow(
                                enhanced.getTimeoutAfter(),
                                PROBE_DELAY_MS + PROBE_CONFIRM_DELAY_MS,
                                PROBE_DELIVERY_MARGIN_MS);
                if (!shouldProbe) {
                    GENERATIONS.clearIfCurrent(key, generation);
                    return;
                }
                ProbeState state = new ProbeState(generation);
                PROBES.put(key, state);
                state.future = PROBE_EXECUTOR.schedule(
                        () -> probe(app, manager, key, generation, generic, false),
                        PROBE_DELAY_MS,
                        TimeUnit.MILLISECONDS);
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
                Log.w(TAG, "Using generic Android live update key=" + key
                        + " fingerprint=" + SamsungNowBarCompat.fingerprint(app));
            } finally {
                GENERATIONS.clearIfCurrent(key, fallbackGeneration);
            }
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

    private static void probe(Context context, NotificationManager manager, NotificationKey key,
                              long generation, Notification genericAndroid,
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
            Log.w(TAG, "SystemUI survival probe unavailable key=" + key, error);
            finishProbe(key, generation);
            return;
        }

        boolean prepareGenericRepost = false;
        synchronized (LOCK) {
            // Second generation check: cancellation may have happened during the framework query.
            if (!GENERATIONS.isCurrent(key, generation)) return;
            if (!canObserveDelivery(context, manager, genericAndroid)) {
                finishProbeLocked(key, generation);
                return;
            }
            if (active) {
                if (!confirmation) {
                    ProbeState state = PROBES.get(key);
                    if (state == null || state.generation != generation) return;
                    state.future = PROBE_EXECUTOR.schedule(
                            () -> probe(context, manager, key, generation,
                                    genericAndroid, true),
                            PROBE_CONFIRM_DELAY_MS,
                            TimeUnit.MILLISECONDS);
                    Log.i(TAG, "Samsung enhancement passed initial delivery key=" + key);
                    return;
                }
                SamsungNowBarCompat.recordProbe(context, true);
                Log.i(TAG, "Samsung enhancement survived delayed confirmation key=" + key);
                finishProbeLocked(key, generation);
                return;
            }
            if (!SamsungNowBarCompat.SYSTEM_UI_ERROR_FALLBACK_ENABLED) {
                Log.w(TAG, "SystemUI removed enhanced live update key=" + key
                        + "; temporary error fallback disabled");
                finishProbeLocked(key, generation);
                return;
            }
            prepareGenericRepost = true;
        }
        if (!prepareGenericRepost) return;
        Notification compacted = compactSamsungFallback(context, genericAndroid);
        synchronized (LOCK) {
            if (!GENERATIONS.isCurrent(key, generation)) return;
            if (!canObserveDelivery(context, manager, genericAndroid)) {
                finishProbeLocked(key, generation);
                return;
            }
            int failures = SamsungNowBarCompat.recordProbe(context, false);
            if (!GENERATIONS.isCurrent(key, generation)) return;
            Log.w(TAG, "SystemUI removed enhanced live update key=" + key
                    + " failures=" + failures
                    + "; reposting generic Android live update");
            key.notify(manager, compacted);
            finishProbeLocked(key, generation);
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
            Log.w(TAG, "Unable to compact Samsung fallback small icon", error);
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
            Log.w(TAG, "Unable to verify notification permission/channel state", error);
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
        ScheduledFuture<?> future;

        ProbeState(long generation) {
            this.generation = generation;
        }
    }
}
