package me.pipi.deliveries.background;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

import java.util.concurrent.atomic.AtomicInteger;

import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

/** EXPRESS_OWNERSHIP_PLAN §3.1 裁决 A (2026-09-03): account rows recognise their carrier client-side. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class AccountCarrierRecognitionTest {
    private static final String PHONE = "13800001515";
    private Context context;
    private ExpressRepository repository;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
    }

    @Test public void unresolvedAccountRowsAreRecognisedIntoDisplayOnlyNormalization()
            throws Exception {
        ExpressItem item = saved("YT9876543210123", "UNKNOWN", "未知快递", "");
        assertTrue(AccountCarrierRecognition.needsRecognition(item));

        AtomicInteger calls = new AtomicInteger();
        assertTrue(AccountCarrierRecognition.recognize(repository, item, waybill -> {
            calls.incrementAndGet();
            assertEquals("YT9876543210123", waybill);
            return new CarrierNormalization("YTO", "圆通速递", "yuantong", true, "t1");
        }));
        ExpressItem recognized = repository.findByWaybill("YT9876543210123", "interface5");
        assertNotNull(recognized);
        assertEquals(1, calls.get());
        assertEquals("UNKNOWN", recognized.courierCode);
        assertTrue(recognized.carrierNormalization.recognized());
        assertEquals("YTO", recognized.carrierNormalization.standardCode);
        assertFalse(AccountCarrierRecognition.needsRecognition(recognized));

        // Failures and empty results change nothing; the coordinator owns retries.
        ExpressItem other = saved("ZT9876543210123", "UNKNOWN", "未知快递", "");
        assertFalse(AccountCarrierRecognition.recognize(repository, other, waybill -> {
            throw new IllegalStateException("public carrier classifier unavailable");
        }));
        assertFalse(AccountCarrierRecognition.recognize(
                repository, other, waybill -> CarrierNormalization.NONE));
        assertTrue(AccountCarrierRecognition.needsRecognition(
                repository.findByWaybill("ZT9876543210123", "interface5")));
    }

    @Test public void theJdPlatformLabelOnANonJdWaybillIsNoCarrierEvidence() throws Exception {
        ExpressItem jt = saved("JT4006839564547", "JDKD", "京东快递", "JingDong");
        assertTrue(AccountCarrierRecognition.platformLabelOnly(jt));
        assertTrue(AccountCarrierRecognition.needsRecognition(jt));
        assertFalse(AccountCarrierRecognition.recognize(repository, jt, waybill ->
                new CarrierNormalization("JD", "京东快递", "jd", true, "t1")));
        assertTrue(AccountCarrierRecognition.recognize(repository, jt, waybill ->
                new CarrierNormalization("JTSD", "极兔速递", "jtexpress", true, "t1")));
        assertEquals("JTSD", repository.findByWaybill("JT4006839564547", "interface5")
                .carrierNormalization.standardCode);

        ExpressItem jd = saved("JDVD10645984010", "JDKD", "京东快递", "JingDong");
        assertFalse(AccountCarrierRecognition.platformLabelOnly(jd));
        assertFalse(AccountCarrierRecognition.needsRecognition(jd));
        ExpressItem sf = saved("SF1234567890123", "SF", "顺丰速运", "");
        assertFalse(AccountCarrierRecognition.needsRecognition(sf));
    }

    private ExpressItem saved(
            String waybill, String courierCode, String companyName, String sourceProvider) {
        ExpressQueryResult result = new ExpressQueryResult(
                waybill, courierCode, companyName, StatusSemantic.TRANSIT, 0L,
                "2026-09-03 17:48:37", "已取件",
                "[{\"time\":\"2026-09-03 17:48:37\",\"context\":\"已取件\"}]",
                "", PHONE, "interface5", "", "", sourceProvider);
        repository.saveInterface5(result, PHONE);
        ExpressItem item = repository.findByWaybill(waybill, "interface5");
        assertNotNull(item);
        return item;
    }
}
