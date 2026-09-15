package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.SharedPreferences;
import me.pipi.deliveries.model.CarrierNormalization;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public final class CarrierRecognitionPreferencesTest {
    @Test public void onlyTransientFailuresAreBoundedAcrossCoordinatorInstances() {
        SharedPreferences preferences = RuntimeEnvironment.getApplication()
                .getSharedPreferences("carrier-retention-test", 0);
        preferences.edit().clear().commit();
        CarrierRecognitionCoordinator.State first =
                new CarrierRecognitionCoordinator.PreferencesState(preferences);
        CarrierRecognitionCoordinator.State second =
                new CarrierRecognitionCoordinator.PreferencesState(preferences);
        assertSame(first.coordinationKey(), second.coordinationKey());
        CarrierNormalization sf = new CarrierNormalization("SF", "顺丰速运", "shunfeng", true, "");
        first.save("known", new CarrierRecognitionCoordinator.Snapshot(sf, 0, 0, false));
        first.save("terminal", new CarrierRecognitionCoordinator.Snapshot(CarrierNormalization.NONE, 3, 0, true));
        for (int index = 0; index < 260; index++) {
            second.save("failure-" + index, new CarrierRecognitionCoordinator.Snapshot(
                    CarrierNormalization.NONE, 1, 1000L + index, false));
        }
        assertEquals(258, preferences.getAll().size());
        assertTrue(first.load("known").success.recognized());
        assertTrue(first.load("terminal").terminal);
        assertEquals(1259L, first.load("failure-259").retryAt);
        assertFalse(first.load("failure-259").terminal);
    }
}
