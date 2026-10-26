package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.Context;
import android.content.pm.PermissionInfo;
import android.os.Build;
import me.pipi.deliveries.data.ExpressRepository;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.shadows.ShadowApplication;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {32, 33}, application = Application.class, shadows = ColdHomeLoadTest.Scheduler.class)
@GraphicsMode(GraphicsMode.Mode.LEGACY)
public final class ExpressListReceiverPrivacyTest {
    @Test public void lifecycleReceiverUsesNotExportedOrSignaturePermission() throws Exception {
        Application app = RuntimeEnvironment.getApplication();
        String permission = app.getPackageName() + ".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION";
        PermissionInfo info = app.getPackageManager().getPermissionInfo(permission, 0);
        assertEquals(PermissionInfo.PROTECTION_SIGNATURE,
                info.protectionLevel & PermissionInfo.PROTECTION_MASK_BASE);
        assertTrue(java.util.Arrays.asList(app.getPackageManager().getPackageInfo(
                app.getPackageName(), android.content.pm.PackageManager.GET_PERMISSIONS)
                .requestedPermissions).contains(permission));
        // Robolectric does not automatically grant the app's declared signature permission.
        Shadows.shadowOf(app).grantPermissions(permission);
        ActivityController<ExpressListActivity> controller = Robolectric.buildActivity(ExpressListActivity.class);
        try {
            controller.create().start();
            ShadowApplication.Wrapper registration = null;
            for (ShadowApplication.Wrapper candidate : Shadows.shadowOf(app).getRegisteredReceivers()) {
                if (candidate.intentFilter.hasAction(ExpressRepository.ACTION_CHANGED)) {
                    registration = candidate;
                    break;
                }
            }
            assertNotNull(registration);
            assertTrue(registration.intentFilter.hasAction(ExpressRepository.ACTION_SYNC_FINISHED));
            if (Build.VERSION.SDK_INT >= 33) {
                assertEquals(Context.RECEIVER_NOT_EXPORTED,
                        registration.flags & Context.RECEIVER_NOT_EXPORTED);
            } else {
                assertEquals(permission, registration.broadcastPermission);
            }
        } finally {
            controller.stop().destroy();
            ColdHomeLoadTest.awaitPublications();
        }
        assertFalse(Shadows.shadowOf(app).hasReceiverForIntent(
                new android.content.Intent(ExpressRepository.ACTION_CHANGED)));
    }
}
