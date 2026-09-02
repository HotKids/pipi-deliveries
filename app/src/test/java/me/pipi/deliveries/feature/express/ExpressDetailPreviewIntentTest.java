package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;
import android.content.Intent;

import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public final class ExpressDetailPreviewIntentTest {
    @Test
    public void onlyTheLivePickerPreviewForcesNativeNonPersistentRendering() {
        Context context = RuntimeEnvironment.getApplication();
        ExpressQueryResult picker = new ExpressQueryResult(
                "TEST123456", "ZTO", "中通快递", StatusSemantic.TRANSIT,
                "2026-09-02 10:00:00", "运输中",
                "[{\"time\":\"2026-09-02 10:00:00\",\"context\":\"运输中\"}]",
                "https://m.kuaidi100.com/result.jsp?nu=TEST123456",
                "", "meizu");

        Intent transientPreview = ExpressDetailActivity.transientPickerPreviewIntent(
                context, picker, "1234", "interface6");
        assertFalse(transientPreview.getBooleanExtra("persist_express_preview", true));
        assertTrue(transientPreview.getBooleanExtra("transient_picker_preview", false));
        assertTrue((transientPreview.getFlags() & Intent.FLAG_ACTIVITY_CLEAR_TOP) != 0);

        Intent finalDetail = ExpressDetailActivity.persistedPreviewIntent(
                context, picker, "1234", "interface6");
        assertFalse(finalDetail.getBooleanExtra("persist_express_preview", true));
        assertFalse(finalDetail.getBooleanExtra("transient_picker_preview", false));
        assertTrue((finalDetail.getFlags() & Intent.FLAG_ACTIVITY_CLEAR_TOP) != 0);
    }
}
