package me.pipi.deliveries.background;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;

import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ExpressSyncEngineTest {
    @Test
    public void placeholderOnlyInterface5ResultAllowsFallback() {
        ExpressQueryResult result = new ExpressQueryResult(
                "YT001", "YTO", "圆通速递", StatusSemantic.UNKNOWN,
                "", "暂无物流信息", "[]");

        assertFalse(ExpressSyncEngine.hasUsableInformation(result));
    }

    @Test
    public void structuredOrMeaningfulInterface5ResultWins() {
        ExpressQueryResult structured = new ExpressQueryResult(
                "YT001", "YTO", "圆通速递", StatusSemantic.TRANSIT,
                "", "", "[]");
        ExpressQueryResult detail = new ExpressQueryResult(
                "YT001", "YTO", "圆通速递", StatusSemantic.UNKNOWN,
                "", "快件已到达杭州转运中心", "[]");

        assertTrue(ExpressSyncEngine.hasUsableInformation(structured));
        assertTrue(ExpressSyncEngine.hasUsableInformation(detail));
    }

    @Test
    public void structuredProviderErrorsNeverBecomeTimelineText() {
        ExpressQueryResult noResult = new ExpressQueryResult(
                "YT001", "YTO", "圆通速递", StatusSemantic.TRANSIT,
                "", "no result", "[]");
        ExpressQueryResult verification = new ExpressQueryResult(
                "SF001", "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "", "验证码错误", "[]");

        assertFalse(ExpressSyncEngine.hasUsableInformation(noResult));
        assertFalse(ExpressSyncEngine.hasUsableInformation(verification));
    }

    @Test
    public void removedPhoneCannotMatchFutureMaskedServerRows() {
        assertEquals("13800138000", ExpressSyncEngine.matchedBoundPhone(
                "****8000", Arrays.asList("13900001111", "13800138000")));
        assertEquals("", ExpressSyncEngine.matchedBoundPhone(
                "****8098", Arrays.asList("13900001111", "13800138000")));
        assertEquals("", ExpressSyncEngine.matchedBoundPhone(
                "****8000", Arrays.asList("13900008000", "13800138000")));
    }
}
