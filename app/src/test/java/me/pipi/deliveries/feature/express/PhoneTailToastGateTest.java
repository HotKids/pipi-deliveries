package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Application;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import me.pipi.deliveries.data.ManualTimelineAuthorityPolicy;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * 「需要验证手机号后 4 位」提示只在详情仍不完整时弹（用户 2026-09-26，其余裁决 20，三端同口径：iOS sync.ts 的
 * {@code !shipmentDetailComplete}，Pipi {@code ExpressPoller.showsPhoneTailToast}）。完整与否是 Lite 现有的
 * {@link ExpressDetailActivity#currentDetailComplete}。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class)
public final class PhoneTailToastGateTest {
    private static final String SIGNED_AT = "2026-09-20 18:00:00";
    private static final long SIGNED_AT_MS = 1789898400000L;
    private static final String TRACKS = "[{\"time\":\"" + SIGNED_AT + "\",\"context\":\"快件已签收\"},"
            + "{\"time\":\"2026-09-19 09:00:00\",\"context\":\"快件已揽收\"}]";

    @Test public void aSignedManualParcelWithACompleteDetailGetsNoPhoneTailToast() {
        ExpressItem signed = manual(StatusSemantic.COMPLETED);
        ManualTimelineAuthorityPolicy.Candidate complete = new ManualTimelineAuthorityPolicy.Candidate(
                TimelineSlot.V6_QUERY, detail(StatusSemantic.COMPLETED), 100L, true);
        assertTrue("the fixture really is a complete detail",
                ExpressDetailActivity.currentDetailComplete(signed, null, complete));
        assertFalse(ExpressDetailActivity.phoneTailToastDue(signed, null, complete));
    }

    @Test public void aStillIncompleteDetailKeepsThePhoneTailToast() {
        ExpressItem signed = manual(StatusSemantic.COMPLETED);
        assertTrue("no detail package at all",
                ExpressDetailActivity.phoneTailToastDue(signed, null, null));
        ExpressQueryResult noPickup = new ExpressQueryResult(signed.waybill, "ZTO", "中通快递",
                StatusSemantic.COMPLETED, SIGNED_AT_MS, SIGNED_AT, "快件已签收",
                "[{\"time\":\"" + SIGNED_AT + "\",\"context\":\"快件已签收\"}]", "", "",
                TimelineSlot.V6_QUERY, "", "", "");
        assertTrue("a package without its pickup",
                ExpressDetailActivity.phoneTailToastDue(signed, null,
                        new ManualTimelineAuthorityPolicy.Candidate(TimelineSlot.V6_QUERY, noPickup, 100L, true)));
        // A manual parcel still on its way is never complete (no feed clock), as on iOS and Pipi.
        ExpressItem moving = manual(StatusSemantic.TRANSIT);
        assertTrue(ExpressDetailActivity.phoneTailToastDue(moving, null,
                new ManualTimelineAuthorityPolicy.Candidate(
                        TimelineSlot.V6_QUERY, detail(StatusSemantic.TRANSIT), 100L, true)));
    }

    /** Both places that show the toast ask the gate after this round is committed. */
    @Test public void bothToastSitesAskTheGateAfterTheCommit() throws Exception {
        Path path = Paths.get("src/main/java/me/pipi/deliveries/feature/express/ExpressDetailActivity.java");
        if (!Files.exists(path)) path = Paths.get("app").resolve(path);
        String source = new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
        int pullCommit = source.indexOf("true, claim, cancellation);");
        int pullGate = source.indexOf("if (manualPhoneTailRequired\n"
                + "                            && !phoneTailToastDue(repository.find(queryOwner.rowId))) {\n"
                + "                        manualPhoneTailRequired = false;");
        assertTrue(pullCommit > 0 && pullGate > pullCommit);
        int addCommit = source.indexOf("false, pollClaim, cancellation);");
        int addGate = source.indexOf(
                "boolean phoneTailToast = manualPhoneTailRequired && phoneTailToastDue(saved);");
        assertTrue(addCommit > 0 && addGate > addCommit);
        assertTrue(source.contains("Toast.makeText(this, phoneTailToast ? ExpressToastCopy.MANUAL_PHONE_TAIL_REQUIRED"));
    }

    private static ExpressItem manual(StatusSemantic semantic) {
        return new ExpressItem(7L, "", "ZTO7000000000001", "ZTO", "中通快递", semantic,
                semantic.label, "快件已签收", SIGNED_AT, TRACKS, "", "manual", "",
                SIGNED_AT_MS, SIGNED_AT_MS, "", "", "", "", false, "", "", "[]", "",
                true, TimelineSlot.V6_QUERY, SIGNED_AT_MS);
    }

    private static ExpressQueryResult detail(StatusSemantic semantic) {
        return new ExpressQueryResult("ZTO7000000000001", "ZTO", "中通快递", semantic,
                SIGNED_AT_MS, SIGNED_AT, "快件已签收", TRACKS, "", "", TimelineSlot.V6_QUERY, "", "", "");
    }
}
