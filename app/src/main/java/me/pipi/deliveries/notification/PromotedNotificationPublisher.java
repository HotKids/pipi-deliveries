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
    private static final long CONFIRMED_SURVIVAL_MIN_AGE_MS = 2_000L;
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
    private static final Map<NotificationKey, LiveNowBarPost> LIVE_NOW_BAR_POSTS = new HashMap<>();
    private static final ScheduledExecutorService PROBE_EXECUTOR =
            Executors.newSingleThreadScheduledExecutor(
                    PipiExecutors.namedFactory("pipi-systemui-probe"));
    private static volatile java.util.function.LongSupplier clock = System::currentTimeMillis;

    private PromotedNotificationPublisher() {}

    static void setClockForTest(java.util.function.LongSupplier supplier) {
        synchronized (LOCK) {
            clock = supplier == null ? System::currentTimeMillis : supplier;
            if (supplier == null) {
                for (ProbeState probe : PROBES.values()) {
                    if (probe != null && probe.future != null) probe.future.cancel(false);
                }
                PROBES.clear();
                LIVE_NOW_BAR_POSTS.clear();
            }
        }
    }

    /**
     * Reconciles unconfirmed Now Bar {@code style=1} probes left behind by an earlier process
     * before startup live-surface restoration runs.
     */
    public static void reconcilePendingNowBarProbes(Context context) {
        if (context == null) return;
        Context app = context.getApplicationContext();
        if (app == null) app = context;
        NotificationManager manager = app.getSystemService(NotificationManager.class);
        if (manager == null) return;
        reconcilePendingNowBarProbes(app, manager, clock.getAsLong());
    }

    static void reconcilePendingNowBarProbes(
            Context app, NotificationManager manager, long nowMillis) {
        if (app == null || manager == null || !SamsungNowBarCompat.shouldProbe(app)) return;
        synchronized (LOCK) {
            for (SamsungNowBarCompat.PendingNowBarProbe pending
                    : SamsungNowBarCompat.listPendingNowBarProbes(app)) {
                reconcilePendingNowBarProbeLocked(app, manager, pending, nowMillis);
            }
        }
    }

    private static void reconcilePendingNowBarProbeLocked(
            Context app,
            NotificationManager manager,
            SamsungNowBarCompat.PendingNowBarProbe pending,
            long nowMillis) {
        if (pending == null) return;
        if (!pending.osBuild.equals(SamsungNowBarCompat.osBuildFingerprint())) {
            SamsungNowBarCompat.clearPendingNowBarProbe(app, pending.namespace);
            return;
        }
        if (pending.timeoutAt > 0L && nowMillis >= pending.timeoutAt) {
            SamsungNowBarCompat.clearPendingNowBarProbe(app, pending.namespace);
            return;
        }
        long elapsed = nowMillis - pending.postedAt;
        if (elapsed < SamsungNowBarCompat.PENDING_PROBE_STALE_MS) return;
        if (!canObserveChannel(app, manager, pending.channelId)) {
            SamsungNowBarCompat.clearPendingNowBarProbe(app, pending.namespace);
            return;
        }
        NotificationKey persistedKey =
                NotificationKey.persisted(pending.persistenceKey, pending.id);
        Boolean active = isNotificationActive(app, manager, persistedKey);
        if (active == null) return;
        if (active) {
            if (elapsed >= PROBE_DELAY_MS + PROBE_CONFIRM_DELAY_MS) {
                SamsungNowBarCompat.recordNowBarConfirmed(app, pending.namespace);
                Log.i(TAG, "Now Bar template confirmed from prior post namespace="
                        + pending.namespace + " key=" + persistedKey.logLabel());
            } else if (!pending.processSession.isEmpty()
                    && !pending.processSession.equals(SamsungNowBarCompat.processSession())) {
                SamsungNowBarCompat.clearPendingNowBarProbe(app, pending.namespace);
            }
            return;
        }
        // Force-stop, process restart or device reboot clears StatusBarNotifications without
        // SystemUI having rejected style=1; clear pending_probe without disabling Now Bar.
        if (!pending.processSession.isEmpty()
                && !pending.processSession.equals(SamsungNowBarCompat.processSession())) {
            SamsungNowBarCompat.clearPendingNowBarProbe(app, pending.namespace);
            return;
        }
        if (NotificationDismissalStore.wasDismissedForProbe(
                app, persistedKey, pending.dismissalFingerprint, pending.dismissalToken)) {
            SamsungNowBarCompat.clearPendingNowBarProbe(app, pending.namespace);
            return;
        }
        if (!SamsungNowBarCompat.SYSTEM_UI_ERROR_FALLBACK_ENABLED) {
            SamsungNowBarCompat.clearPendingNowBarProbe(app, pending.namespace);
            return;
        }
        SamsungNowBarCompat.recordNowBarRejection(app, pending.namespace);
        Log.w(TAG, "Unconfirmed Now Bar template missing after probe window; disabling namespace="
                + pending.namespace + " key=" + persistedKey.logLabel());
    }

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

    /** Tries the Samsung Now Bar style=1 template before the established promoted notification. */
    @SuppressLint("MissingPermission")
    public static void post(Context context, NotificationManager manager, NotificationKey key,
                            Notification enhanced, Notification genericAndroid,
                            Notification nowBarCandidate) {
        if (context == null || manager == null || key == null || enhanced == null) return;
        Context app = context.getApplicationContext();
        Notification generic = genericClone(genericAndroid == null ? enhanced : genericAndroid);
        String namespace = SamsungNowBarCompat.namespaceOf(key);
        long fallbackGeneration = 0L;
        synchronized (LOCK) {
            ProbeState existingProbe = PROBES.get(key);
            boolean reusableNowBarProbe = existingProbe != null
                    && existingProbe.pickupFallback != null
                    && existingProbe.future != null
                    && !existingProbe.future.isDone()
                    && nowBarCandidate != null
                    && SamsungNowBarCompat.hasPendingNowBarProbe(app, namespace)
                    && SamsungNowBarCompat.shouldTryNowBarTemplate(app, namespace)
                    && !SamsungNowBarCompat.isNowBarConfirmedOnCurrentBuild(app, namespace)
                    && canProbeDelivery(app, manager, nowBarCandidate);
            if (reusableNowBarProbe) {
                long generation = GENERATIONS.advance(key);
                existingProbe.generation = generation;
                existingProbe.generic = generic;
                existingProbe.pickupFallback = enhanced;
                existingProbe.expectedFingerprint =
                        NotificationDismissalStore.activeFingerprint(app, key);
                existingProbe.expectedToken =
                        NotificationDismissalStore.activeToken(app, key);
                try {
                    key.notify(manager, nowBarCandidate);
                    recordLiveNowBarPostLocked(app, key, nowBarCandidate);
                    return;
                } catch (IllegalArgumentException rejected) {
                    cancelProbeLocked(key);
                    LIVE_NOW_BAR_POSTS.remove(key);
                    SamsungNowBarCompat.recordNowBarRejection(app, namespace);
                    Log.w(TAG, "Now Bar template rejected during posting namespace="
                            + namespace + " key=" + key.logLabel());
                }
            } else {
                if (SamsungNowBarCompat.shouldProbe(app) && existingProbe == null) {
                    reconcilePendingNowBarProbeLocked(
                            app,
                            manager,
                            SamsungNowBarCompat.readPendingNowBarProbe(app, namespace),
                            clock.getAsLong());
                }
                cancelProbeLocked(key);
            }
            long generation = GENERATIONS.advance(key);
            if (nowBarCandidate != null
                    && SamsungNowBarCompat.shouldTryNowBarTemplate(app, namespace)) {
                if (SamsungNowBarCompat.isNowBarConfirmedOnCurrentBuild(app, namespace)) {
                    if (wasConfirmedNowBarDroppedLocked(app, manager, key, nowBarCandidate)) {
                        LIVE_NOW_BAR_POSTS.remove(key);
                        SamsungNowBarCompat.recordNowBarRejection(app, namespace);
                        Log.w(TAG, "Confirmed Now Bar notification missing on update; restoring"
                                + " established notification namespace=" + namespace
                                + " key=" + key.logLabel());
                    } else {
                        try {
                            key.notify(manager, nowBarCandidate);
                            recordLiveNowBarPostLocked(app, key, nowBarCandidate);
                            finishProbeLocked(key, generation);
                            return;
                        } catch (IllegalArgumentException rejected) {
                            LIVE_NOW_BAR_POSTS.remove(key);
                            SamsungNowBarCompat.recordNowBarRejection(app, namespace);
                            Log.w(TAG, "Now Bar template rejected during posting namespace="
                                    + namespace + " key=" + key.logLabel());
                        }
                    }
                } else if (canProbeDelivery(app, manager, nowBarCandidate)) {
                    String expectedFp = NotificationDismissalStore.activeFingerprint(app, key);
                    String expectedTok = NotificationDismissalStore.activeToken(app, key);
                    SamsungNowBarCompat.recordPendingNowBarProbe(
                            app,
                            key,
                            clock.getAsLong(),
                            nowBarCandidate.getTimeoutAfter(),
                            nowBarCandidate.getChannelId(),
                            expectedFp,
                            expectedTok);
                    try {
                        key.notify(manager, nowBarCandidate);
                        recordLiveNowBarPostLocked(app, key, nowBarCandidate);
                        scheduleProbeLocked(app, manager, key, generation, generic, enhanced);
                        return;
                    } catch (IllegalArgumentException rejected) {
                        LIVE_NOW_BAR_POSTS.remove(key);
                        SamsungNowBarCompat.recordNowBarRejection(app, namespace);
                        Log.w(TAG, "Now Bar template rejected during posting namespace="
                                + namespace + " key=" + key.logLabel());
                    }
                }
            }
            LIVE_NOW_BAR_POSTS.remove(key);
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
        ProbeState state = new ProbeState(
                generation, generic, pickupFallback, expectedFingerprint, expectedToken);
        PROBES.put(key, state);
        state.future = PROBE_EXECUTOR.schedule(
                () -> probeInFlight(app, manager, key, false),
                PROBE_DELAY_MS, TimeUnit.MILLISECONDS);
    }

    private static void probeInFlight(Context context, NotificationManager manager,
                                      NotificationKey key, boolean confirmation) {
        final long generation;
        final Notification generic;
        final String expectedFingerprint;
        final String expectedToken;
        synchronized (LOCK) {
            ProbeState state = PROBES.get(key);
            if (state == null) return;
            generation = state.generation;
            generic = state.generic;
            expectedFingerprint = state.expectedFingerprint;
            expectedToken = state.expectedToken;
        }
        probe(context, manager, key, generation, generic,
                expectedFingerprint, expectedToken, confirmation);
    }

    /** Posts an ordinary replacement while invalidating an older live probe for the same ID. */
    @SuppressLint("MissingPermission")
    public static void postStandard(NotificationManager manager, NotificationKey key,
                                    Notification notification) {
        if (manager == null || key == null || notification == null) return;
        synchronized (LOCK) {
            LIVE_NOW_BAR_POSTS.remove(key);
            cancelProbeLocked(key);
            key.notify(manager, notification);
        }
    }

    /** Explicit cancellation shares the final-notify lock and therefore cannot be resurrected. */
    public static void cancel(NotificationManager manager, NotificationKey key) {
        if (manager == null || key == null) return;
        synchronized (LOCK) {
            LIVE_NOW_BAR_POSTS.remove(key);
            cancelProbeLocked(key);
            key.cancel(manager);
        }
    }

    /** Stops the compatibility probe before it can mistake a user swipe for SystemUI removal. */
    static void onUserDismissed(NotificationKey key) {
        if (key == null) return;
        synchronized (LOCK) {
            LIVE_NOW_BAR_POSTS.remove(key);
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
            ProbeState state = PROBES.get(key);
            if (state == null) return;
            // Second generation check: cancellation may have happened during the framework query.
            if (!GENERATIONS.isCurrent(key, generation)) {
                // Allow a surviving notification to keep its in-flight confirmation schedule across
                // rapid < 7.2s updates that advanced state.generation while getActiveNotifications ran.
                if (!active || !GENERATIONS.isCurrent(key, state.generation)) return;
            }
            if (!canObserveDelivery(context, manager, state.generic != null ? state.generic : genericAndroid)) {
                finishProbeLocked(key, state.generation);
                return;
            }
            pickupNowBar = state.pickupFallback != null;
            String namespace = SamsungNowBarCompat.namespaceOf(key);
            if (active) {
                if (!confirmation) {
                    state.future = PROBE_EXECUTOR.schedule(
                            () -> probeInFlight(context, manager, key, true),
                            PROBE_CONFIRM_DELAY_MS,
                            TimeUnit.MILLISECONDS);
                    if (!pickupNowBar) {
                        Log.i(TAG, "Samsung enhancement passed initial delivery key=" + key.logLabel());
                    }
                    return;
                }
                if (pickupNowBar) {
                    SamsungNowBarCompat.recordNowBarConfirmed(context, namespace);
                    Log.i(TAG, "Now Bar template delivery observed namespace="
                            + namespace + " key=" + key.logLabel());
                } else {
                    SamsungNowBarCompat.recordProbe(context, true);
                    Log.i(TAG, "Samsung enhancement survived delayed confirmation key=" + key.logLabel());
                }
                finishProbeLocked(key, state.generation);
                return;
            }
            if (state.generation != generation) return;
            LIVE_NOW_BAR_POSTS.remove(key);
            if (NotificationDismissalStore.wasDismissedForProbe(
                    context, key, expectedFingerprint, expectedToken)) {
                if (pickupNowBar) {
                    SamsungNowBarCompat.clearPendingNowBarProbe(context, namespace);
                }
                Log.i(TAG, "Live update dismissed by user before probe fallback key=" + key.logLabel());
                finishProbeLocked(key, generation);
                return;
            }
            if (!SamsungNowBarCompat.SYSTEM_UI_ERROR_FALLBACK_ENABLED) {
                if (pickupNowBar) {
                    SamsungNowBarCompat.clearPendingNowBarProbe(context, namespace);
                }
                Log.w(TAG, "SystemUI removed enhanced live update key=" + key.logLabel()
                        + "; temporary error fallback disabled");
                finishProbeLocked(key, generation);
                return;
            }
            if (pickupNowBar && !SamsungNowBarCompat.useGenericFallback(context)) {
                SamsungNowBarCompat.recordNowBarRejection(context, namespace);
                Log.w(TAG, "Now Bar template removed; restoring established notification namespace="
                        + namespace + " key=" + key.logLabel());
                try {
                    postEnhancedLocked(context, manager, key, generation,
                            state.pickupFallback, genericAndroid);
                } catch (RuntimeException failure) {
                    finishProbeLocked(key, generation);
                    Log.w(TAG, "Unable to restore established notification"
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
            String namespace = SamsungNowBarCompat.namespaceOf(key);
            if (NotificationDismissalStore.wasDismissedForProbe(
                    context, key, expectedFingerprint, expectedToken)) {
                if (pickupNowBar) {
                    SamsungNowBarCompat.clearPendingNowBarProbe(context, namespace);
                }
                Log.i(TAG, "Live update dismissed by user during fallback preparation key=" + key.logLabel());
                finishProbeLocked(key, generation);
                return;
            }
            if (pickupNowBar) {
                SamsungNowBarCompat.recordNowBarRejection(context, namespace);
                Log.w(TAG, "Now Bar template removed; restoring generic notification namespace="
                        + namespace + " key=" + key.logLabel());
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
        SamsungNowBarCompat.clearPendingNowBarProbeIfMatches(key);
    }

    private static boolean canObserveNotifications(Context context, NotificationManager manager) {
        try {
            if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                return false;
            }
            return manager.areNotificationsEnabled();
        } catch (Throwable error) {
            return false;
        }
    }

    private static void recordLiveNowBarPostLocked(
            Context app, NotificationKey key, Notification nowBarCandidate) {
        long now = clock.getAsLong();
        long timeoutAfter = nowBarCandidate.getTimeoutAfter();
        LIVE_NOW_BAR_POSTS.put(key, new LiveNowBarPost(
                now,
                timeoutAfter > 0L ? now + timeoutAfter : 0L,
                nowBarCandidate.getChannelId(),
                SamsungNowBarCompat.fingerprint(app),
                NotificationDismissalStore.activeFingerprint(app, key),
                NotificationDismissalStore.activeToken(app, key)));
    }

    private static boolean wasConfirmedNowBarDroppedLocked(
            Context app,
            NotificationManager manager,
            NotificationKey key,
            Notification nextCandidate) {
        if (!SamsungNowBarCompat.SYSTEM_UI_ERROR_FALLBACK_ENABLED) return false;
        LiveNowBarPost prev = LIVE_NOW_BAR_POSTS.get(key);
        if (prev == null) return false;
        if (!prev.compatFingerprint.equals(SamsungNowBarCompat.fingerprint(app))) return false;
        long now = clock.getAsLong();
        if (now - prev.postedAt < CONFIRMED_SURVIVAL_MIN_AGE_MS) return false;
        if (prev.timeoutAt > 0L && now >= prev.timeoutAt - PROBE_DELIVERY_MARGIN_MS) return false;
        if (!canObserveChannel(app, manager, prev.channelId)
                || !canObserveDelivery(app, manager, nextCandidate)) {
            return false;
        }
        if (NotificationDismissalStore.wasDismissedForProbe(
                app, key, prev.dismissalFingerprint, prev.dismissalToken)) {
            return false;
        }
        Boolean active = isNotificationActive(app, manager, key);
        return Boolean.FALSE.equals(active);
    }

    private static Boolean isNotificationActive(
            Context context, NotificationManager manager, NotificationKey key) {
        try {
            StatusBarNotification[] notifications = manager.getActiveNotifications();
            if (notifications != null) {
                for (StatusBarNotification notification : notifications) {
                    if (key.matches(notification, context.getPackageName())) {
                        return Boolean.TRUE;
                    }
                }
            }
            return Boolean.FALSE;
        } catch (Throwable error) {
            Log.w(TAG, "Unable to inspect active notifications key=" + key.logLabel()
                    + " kind=" + error.getClass().getSimpleName());
            return null;
        }
    }

    private static boolean canObserveChannel(
            Context context, NotificationManager manager, String channelId) {
        try {
            if (!canObserveNotifications(context, manager)) return false;
            if (channelId == null || channelId.isEmpty()) return true;
            NotificationChannel channel = manager.getNotificationChannel(channelId);
            return channel != null
                    && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
        } catch (Throwable error) {
            return false;
        }
    }

    private static boolean canObserveDelivery(Context context, NotificationManager manager,
                                              Notification notification) {
        if (notification == null) return false;
        String channelId = notification.getChannelId();
        if (channelId == null || channelId.isEmpty()) return false;
        return canObserveChannel(context, manager, channelId);
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

    private static final class LiveNowBarPost {
        final long postedAt;
        final long timeoutAt;
        final String channelId;
        final String compatFingerprint;
        final String dismissalFingerprint;
        final String dismissalToken;

        LiveNowBarPost(
                long postedAt,
                long timeoutAt,
                String channelId,
                String compatFingerprint,
                String dismissalFingerprint,
                String dismissalToken) {
            this.postedAt = postedAt;
            this.timeoutAt = timeoutAt;
            this.channelId = channelId == null ? "" : channelId;
            this.compatFingerprint = compatFingerprint == null ? "" : compatFingerprint;
            this.dismissalFingerprint = dismissalFingerprint == null ? "" : dismissalFingerprint;
            this.dismissalToken = dismissalToken == null ? "" : dismissalToken;
        }
    }

    private static final class ProbeState {
        long generation;
        Notification generic;
        Notification pickupFallback;
        String expectedFingerprint;
        String expectedToken;
        ScheduledFuture<?> future;

        ProbeState(
                long generation,
                Notification generic,
                Notification pickupFallback,
                String expectedFingerprint,
                String expectedToken) {
            this.generation = generation;
            this.generic = generic;
            this.pickupFallback = pickupFallback;
            this.expectedFingerprint = expectedFingerprint == null ? "" : expectedFingerprint;
            this.expectedToken = expectedToken == null ? "" : expectedToken;
        }
    }
}
