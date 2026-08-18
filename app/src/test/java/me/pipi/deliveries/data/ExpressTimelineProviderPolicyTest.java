package me.pipi.deliveries.data;

import static org.junit.Assert.assertSame;

import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ExpressTimelineProviderPolicyTest {
    @Test
    public void usableV4WinsAsAWholeTimelineEvenWhenK100AlsoExists() {
        ExpressQueryResult v4 = result("v4", "v4 轨迹");
        ExpressQueryResult k100 = result("kuaidi100", "K100 轨迹");

        assertSame(v4, ExpressRepository.preferredLocalTimeline(v4, k100));
    }

    @Test
    public void unusableV4FallsBackToK100WithoutMixingNodes() {
        ExpressQueryResult v4 = new ExpressQueryResult(
                "TEST123", "ZTO", "中通快递", StatusSemantic.TRANSIT,
                "", "", "[]", "", "", "v4");
        ExpressQueryResult k100 = result("kuaidi100", "K100 轨迹");

        assertSame(k100, ExpressRepository.preferredLocalTimeline(v4, k100));
    }

    private static ExpressQueryResult result(String provider, String detail) {
        return new ExpressQueryResult(
                "TEST123", "ZTO", "中通快递", StatusSemantic.TRANSIT,
                "2026-08-17 12:00:00", detail,
                "[{\"time\":\"2026-08-17 12:00:00\",\"context\":\"" + detail + "\"}]",
                "", "", provider);
    }
}
