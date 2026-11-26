package me.pipi.deliveries.notification;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;


import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

/**
 * Shared by Pipi and Deliveries Lite (tools/sync_android_shared_classes.py).
 *
 * <p>The notification state names follow the running app's package. They must not follow a
 * class's own package: R8 moves classes into the unnamed package in minified builds, and
 * {@code Class#getPackageName()} only exists from API 31 while Lite's compat flavour starts at
 * API 29 (third branch review §9.2 item 1, 2026-11-23).</p>
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36, application = Application.class)
public final class NotificationHostTest {
    private static final String PIPI = "me.pipi.assistant";
    private static final String DELIVERIES = "me.pipi.deliveries";
    private static final String PIPI_DISMISSALS = "pipi_notification_dismissals";
    private static final String DELIVERIES_DISMISSALS = "deliveries_notification_dismissals";
    private static final String PIPI_COMPAT = "pipi_systemui_compat";
    private static final String DELIVERIES_COMPAT = "deliveries_systemui_compat";

    private Application app;

    @Before
    public void setUp() {
        app = RuntimeEnvironment.getApplication();
        clearFiles();
    }

    @After
    public void tearDown() {
        clearFiles();
        NotificationDismissalStore.clearAll(null);
        SamsungNowBarCompat.resetCacheForTest();
    }

    @Test
    public void dismissalStoreUsesTheRunningAppsFileAndUriScheme() {
        assertDismissalHost(PIPI, 0x7e000001, PIPI_DISMISSALS, DELIVERIES_DISMISSALS, "pipi");
        assertDismissalHost(
                DELIVERIES, 0x7e000002, DELIVERIES_DISMISSALS, PIPI_DISMISSALS, "deliveries");
    }

    @Test
    public void samsungCompatUsesTheRunningAppsFile() {
        assertCompatHost(PIPI, PIPI_COMPAT, DELIVERIES_COMPAT);
        assertCompatHost(DELIVERIES, DELIVERIES_COMPAT, PIPI_COMPAT);
    }

    private void assertDismissalHost(String packageName, int id, String expectedFile,
                                     String otherFile, String expectedScheme) {
        Context host = hostContext(packageName);
        NotificationKey recorded = NotificationKey.singleton("host.recorded." + packageName, id);
        String fingerprint = NotificationDismissalStore.fingerprint("host", packageName);
        NotificationDismissalStore.record(host, recorded, fingerprint);
        assertEquals(packageName, fingerprint,
                file(expectedFile).getString(recorded.persistenceKey(), null));
        assertFalse(packageName, file(otherFile).contains(recorded.persistenceKey()));

        NotificationKey prepared =
                NotificationKey.singleton("host.prepared." + packageName, id + 0x100);
        Notification.Builder builder = new Notification.Builder(app, "host_test");
        assertTrue(packageName,
                NotificationDismissalStore.prepare(host, builder, prepared, fingerprint));
        assertEquals(packageName, fingerprint,
                file(expectedFile).getString(prepared.persistenceKey() + ":active", null));
        assertFalse(packageName, file(otherFile).contains(prepared.persistenceKey() + ":active"));
        PendingIntent deleted = builder.build().deleteIntent;
        assertNotNull(packageName, deleted);
        assertEquals(packageName, expectedScheme,
                Shadows.shadowOf(deleted).getSavedIntent().getData().getScheme());
    }

    private void assertCompatHost(String packageName, String expectedFile, String otherFile) {
        clearFiles();
        SamsungNowBarCompat.resetCacheForTest();
        SamsungNowBarCompat.recordProbe(hostContext(packageName), false);
        assertEquals(packageName, 1, file(expectedFile).getInt("failures", 0));
        assertFalse(packageName, file(otherFile).contains("failures"));
    }

    private Context hostContext(String packageName) {
        return new ContextWrapper(app) {
            @Override public String getPackageName() {
                return packageName;
            }

            @Override public Context getApplicationContext() {
                return this;
            }
        };
    }

    private SharedPreferences file(String name) {
        return app.getSharedPreferences(name, Context.MODE_PRIVATE);
    }

    private void clearFiles() {
        for (String name : new String[]{
                PIPI_DISMISSALS, DELIVERIES_DISMISSALS, PIPI_COMPAT, DELIVERIES_COMPAT}) {
            file(name).edit().clear().commit();
        }
    }
}
