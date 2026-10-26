package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;
import android.app.Application;
import android.content.Intent;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public class ExpressLiveMissingDetailTest {
    @Test public void onlyLiveMissingParcelFallsBackToList() {
        ExpressDetailActivity ordinary = Robolectric.buildActivity(ExpressDetailActivity.class).get();
        ordinary.setIntent(new Intent());
        ReflectionHelpers.callInstanceMethod(ordinary, "showInitialDetail");
        assertTrue(ordinary.isFinishing());
        assertNull(Shadows.shadowOf(ordinary).getNextStartedActivity());
        ExpressDetailActivity live = Robolectric.buildActivity(ExpressDetailActivity.class).get();
        live.setIntent(new Intent().putExtra(ExpressDetailActivity.EXTRA_MISSING_OPENS_LIST, true));
        ReflectionHelpers.callInstanceMethod(live, "showInitialDetail");
        assertTrue(live.isFinishing());
        assertEquals(ExpressListActivity.class.getName(),
                Shadows.shadowOf(live).getNextStartedActivity().getComponent().getClassName());
    }
}
