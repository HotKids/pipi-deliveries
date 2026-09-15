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
        assertEquals("", jt.displayCompany());
        assertEquals("", jt.displayCourierCode());
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

    @Test public void projectedCarrierIsResolvedWithoutRewritingTheOrderIdentity() throws Exception {
        repository.saveInterface5OrderSummary(new ExpressQueryResult(
                "1234500000001", "JDKD", "京东购物", StatusSemantic.COMPLETED, 0L,
                "2026-09-13 18:32:15", "Delivery event", "[]", "", PHONE,
                "interface5", "", "", "JingDong"), PHONE);
        ExpressItem order = repository.findByWaybill("1234500000001", "interface5");
        assertTrue(order.isAccountOrder());
        assertTrue(repository.saveOrderProjection(order, "interface5", "JD00000005481", ""));
        ExpressItem projected = repository.find(order.rowId);
        assertTrue(AccountCarrierRecognition.needsRecognition(projected));
        assertTrue(AccountCarrierRecognition.recognize(repository, projected, waybill -> {
            assertEquals("JD00000005481", waybill);
            return new CarrierNormalization("JD", "京东快递", "jd", true, "t1");
        }));
        ExpressItem recognized = repository.find(order.rowId);
        assertEquals(order.waybill, recognized.waybill);
        assertEquals(order.courierCode, recognized.courierCode);
        assertEquals("JD00000005481", recognized.displayWaybill());
        assertEquals("京东快递", recognized.displayCompany());
        assertEquals("jd", recognized.displayCourierCode());
        assertFalse(AccountCarrierRecognition.needsRecognition(recognized));
    }

    @Test public void sameWaybillRefreshCannotDiscardPendingRecognition() throws Exception {
        ExpressItem item = saved("SF1221489425261", "UNKNOWN", "", "JingDong");
        assertTrue(AccountCarrierRecognition.recognize(repository, item, waybill -> {
            saved(waybill, "JDKD", "京东购物", "JingDong");
            return new CarrierNormalization("SF", "顺丰速运", "shunfeng", true, "t1");
        }));
        ExpressItem recognized = repository.find(item.rowId);
        assertEquals("顺丰速运", recognized.displayCompany());
        assertEquals("shunfeng", recognized.displayCourierCode());
        assertEquals(me.pipi.deliveries.R.drawable.sf, recognized.displayIconResource());
        assertFalse(AccountCarrierRecognition.needsRecognition(recognized));
        saved(item.waybill, "JDKD", "京东购物", "JingDong");
        assertEquals("顺丰速运", repository.find(item.rowId).displayCompany());
    }

    @Test public void staleProjectedPlatformNameDoesNotBlockCarrierRepair() throws Exception {
        repository.saveInterface5OrderSummary(new ExpressQueryResult(
                "1234500000002", "JDKD", "京东购物", StatusSemantic.TRANSIT, 0L,
                "2026-09-13 18:32:15", "Delivery event", "[]", "", PHONE,
                "interface5", "", "", "JingDong"), PHONE);
        ExpressItem order = repository.findByWaybill("1234500000002", "interface5");
        assertTrue(repository.saveOrderProjection(order, "interface5", "SF00000005481", "京东快递"));
        ExpressItem projected = repository.find(order.rowId);
        assertTrue(AccountCarrierRecognition.needsRecognition(projected));
        assertTrue(AccountCarrierRecognition.recognize(repository, projected, waybill ->
                new CarrierNormalization("SF", "顺丰速运", "shunfeng", true, "builtin")));
        ExpressItem recognized = repository.find(order.rowId);
        assertEquals("顺丰速运", recognized.displayCompany());
        assertEquals("shunfeng", recognized.displayCourierCode());
        assertFalse(AccountCarrierRecognition.needsRecognition(recognized));
        assertTrue(repository.saveOrderProjection(recognized, "interface5", "SF00000005481", "京东快递"));
        assertEquals("顺丰速运", repository.find(order.rowId).displayCompany());
        assertTrue(repository.saveOrderProjection(repository.find(order.rowId),
                "interface5", "YT00000005481", ""));
        assertEquals("", repository.find(order.rowId).displayCompany());
        assertTrue(AccountCarrierRecognition.needsRecognition(repository.find(order.rowId)));
    }

    @Test public void projectedRecognitionSurvivesAnAccountCarrierFieldRefresh() throws Exception {
        String orderId = "1234500000003";
        repository.saveInterface5OrderSummary(new ExpressQueryResult(
                orderId, "JDKD", "京东购物", StatusSemantic.TRANSIT, 0L,
                "2026-09-13 18:32:15", "Delivery event", "[]", "", PHONE,
                "interface5", "", "", "JingDong"), PHONE);
        ExpressItem order = repository.findByWaybill(orderId, "interface5");
        assertTrue(repository.saveOrderProjection(order, "interface5", "SF00000005482", ""));
        ExpressItem projected = repository.find(order.rowId);
        assertTrue(AccountCarrierRecognition.recognize(repository, projected, waybill -> {
            repository.saveInterface5OrderSummary(new ExpressQueryResult(
                    orderId, "UNKNOWN", "京东购物", StatusSemantic.TRANSIT, 0L,
                    "2026-09-13 18:33:15", "Next delivery event", "[]", "", PHONE,
                    "interface5", "", "", "JingDong"), PHONE);
            return new CarrierNormalization("SF", "顺丰速运", "shunfeng", true, "builtin");
        }));
        assertEquals("顺丰速运", repository.find(order.rowId).displayCompany());
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
