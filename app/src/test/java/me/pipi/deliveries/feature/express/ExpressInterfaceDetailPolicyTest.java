package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;
import android.app.Application;
import me.pipi.deliveries.model.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class)
public class ExpressInterfaceDetailPolicyTest {
    static ExpressItem owner(String source, String provider) {
        return new ExpressItem(10L, "", "TEST123456", "ZTO", "中通快递",
                StatusSemantic.TRANSIT, "运输中", "运输中", "2026-09-09 10:00:00",
                "[]", "", source, "", 1L, 2L, source, source,
                source.equals("INTERFACE5") ? "v5" : "v6", "", true,
                "", "", "", provider, false, "", 0L);
    }

    static ExpressQueryResult result(String detail) {
        return new ExpressQueryResult("TEST123456", "ZTO", "中通快递",
                StatusSemantic.TRANSIT, "2026-09-09 10:00:00", detail,
                "[{\"time\":\"2026-09-09 10:00:00\",\"context\":\"" + detail + "\"}]");
    }

    @Test public void interface6CainiaoCannotEnterNativeRefresh() {
        assertFalse(ExpressDetailActivity.canRefreshLocalTimeline(owner("INTERFACE6", "CaiNiao")));
        assertTrue(ExpressDetailActivity.canRefreshLocalTimeline(owner("INTERFACE5", "CaiNiao")));
    }

    @Test public void automaticPickupStopsBeforePickerButOrderOnlyDoesNot() {
        ExpressItem owner = owner("INTERFACE5", "DouYin");
        assertFalse(ExpressDetailActivity.needsManualSupplement(owner, result("已揽收"), null));
        assertTrue(ExpressDetailActivity.needsManualSupplement(owner, result("订单已提交"), null));
    }

    @Test public void cachedPickerOrderCannotProveAutomaticSourceComplete() {
        assertTrue(ExpressDetailActivity.needsManualSupplement(
                owner("INTERFACE5", "DouYin"), result("运输中"), result("订单已提交")));
    }
}
