package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Application;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * The detail entry's complete-cache gate. 优化 2（用户 2026-10-03「v5 对不上并进对齐」）removed the one-minute list/detail
 * mismatch query that used to pass this gate once for a terminal JD row (it was ListDetailMismatchGateTest); a list and a
 * detail more than five minutes apart are forced by the status alignment instead. The gate itself is unchanged.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class)
public final class CompleteCacheEntryGateTest {
    private static final String PHONE = "13800009310";
    private static final String ORDER = "3622448007419310";
    private static final String WAYBILL = "JD0261257549310";

    @Test public void aCompleteTerminalJingDongRowOpensOnItsCacheWhateverItsListSays() {
        ExpressItem signed = listedJingDong(910_011L, StatusSemantic.COMPLETED);
        assertTrue("no list/detail bypass any more", ExpressDetailActivity.shouldSkipCompleteCache(signed, true));
        assertFalse("an incomplete detail is refreshed anyway",
                ExpressDetailActivity.shouldSkipCompleteCache(signed, false));
    }

    @Test public void theGateIsUnchangedForOtherRows() {
        ExpressItem delivering = listedJingDong(910_012L, StatusSemantic.DELIVERY);
        ExpressItem cainiao = new ExpressItem(910_013L, PHONE, "YT1234567890", "YTO", "圆通速递",
                StatusSemantic.COMPLETED, "已签收", "已签收", "2026-09-23 11:12:23", "[]", "",
                "INTERFACE5", "", 1L, 1L, "INTERFACE5", "", "v5", "", false, "", "", "[]", "CaiNiao");
        assertFalse("a JD row still on its way is not served from its cache",
                ExpressDetailActivity.shouldSkipCompleteCache(delivering, true));
        assertTrue(ExpressDetailActivity.shouldSkipCompleteCache(cainiao, true));
        assertFalse(ExpressDetailActivity.shouldSkipCompleteCache(cainiao, false));
    }

    private static ExpressItem listedJingDong(long rowId, StatusSemantic semantic) {
        return new ExpressItem(rowId, PHONE, ORDER, "JD", "京东购物", semantic, semantic.label,
                "列表最新一条", "2026-09-23 11:12:23", "[]", "", "I5-JD", "", 1L, 1L, "I5-JD", "", "v5", "", false,
                WAYBILL, "京东快递", "[]", "JingDong");
    }
}
