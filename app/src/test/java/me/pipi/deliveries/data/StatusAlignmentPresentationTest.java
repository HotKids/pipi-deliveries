package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import android.app.Application;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.ManualQuerySuccess;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.WorkerStatusProjection;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

/** Synthetic regression partitions for the October 8 headline/status alignment contract. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class StatusAlignmentPresentationTest {
    private static final String PHONE = "13800000077";
    private static final String SF = "SF1000000000077";
    private static final String ZTO = "ZT1000000000077";
    private static final String CAINIAO = "YT1000000000077";
    private static final long MINUTE = 60_000L;

    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;
    /** A whole second two hours ago: the parcels stay well inside the 14-day list window. */
    private long base;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        repository.bindPhoneLocally(PHONE, "interface5");
        repository.bindPhoneLocally(PHONE, "interface6");
        base = (System.currentTimeMillis() - 120L * MINUTE) / 1000L * 1000L;
    }

    @After public void tearDown() {
        database.close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    /**
     * A coarse SF signing cannot replace the detailed headline before the first actual refresh finishes.
     */
    @Test public void aCoarseSigningWaitsForTheFirstRefreshBeforeBecomingAFallback() throws Exception {
        ExpressItem owner = signedShunFengWithOlderPicker();

        ExpressItem listed = listed(owner.rowId, "interface5");
        assertEquals(StatusSemantic.COMPLETED, listed.semantic);
        assertEquals(base + 110L * MINUTE, listed.statusEventTime);
        assertEquals("快件到达营业点", listed.latestDetail);
        assertEquals(at(20), listed.latestTime);

        ExpressItem found = repository.find(owner.rowId);
        assertEquals(StatusSemantic.COMPLETED, found.semantic);
        assertEquals("快件到达营业点", found.latestDetail);
        assertEquals(at(20), found.latestTime);

        // The check compares the headline before the swap, and the SF detail shows the Picker package.
        ExpressRepository.StatusAlignmentProbe probe = probe(owner.rowId, "interface5");
        assertEquals(base + 110L * MINUTE, probe.statusAt);
        assertEquals(base + 20L * MINUTE, probe.headlineAt);
        assertEquals(base + 20L * MINUTE, probe.detailAt);
    }

    /** The status package's newest node is the headline itself: nothing newer, so the headline stays. */
    @Test public void aStatusPackageWithNothingNewerKeepsTheHeadline() throws Exception {
        ExpressQueryResult feed = new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                base + 110L * MINUTE, at(20), "快件到达营业点",
                tracks(new String[][]{{at(20), "快件到达营业点"}, {at(0), "快件已揽收"}}),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, base + 110L * MINUTE));
        repository.saveInterface5(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertNotNull(owner);

        ExpressItem listed = listed(owner.rowId, "interface5");
        assertEquals(StatusSemantic.COMPLETED, listed.semantic);
        assertEquals("快件到达营业点", listed.latestDetail);
        assertEquals(at(20), listed.latestTime);
        ExpressRepository.StatusAlignmentProbe probe = probe(owner.rowId, "interface5");
        assertEquals(base + 110L * MINUTE, probe.statusAt);
        assertEquals(base + 20L * MINUTE, probe.headlineAt);
    }

    /** Headline replacement has no minimum time gap when the status is newer. */
    @Test public void aStatusFiveMinutesAheadTakesItsMatchingNode() throws Exception {
        ExpressQueryResult feed = new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.DELIVERY,
                base + 25L * MINUTE, at(20), "快件到达营业点",
                tracks(new String[][]{{at(25), "快件派送中"}, {at(20), "快件到达营业点"}}),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.DELIVERY, base + 25L * MINUTE));
        repository.saveInterface5(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertEquals("快件派送中", listed(owner.rowId, "interface5").latestDetail);
    }

    /**
     * 「按列表实际显示的时间」(用户 2026-09-16): retention reads the headline the list shows, the aligned one included.
     * The stored headline is fifteen days old (past the 14-day list window) but the structured signing ten days
     * ago brings the status package's own node as the headline, so the row stays listed and findable; the stored
     * row keeps its own headline.
     */
    @Test public void retentionReadsTheAlignedHeadline() throws Exception {
        long day = 24L * 60L * MINUTE;
        long now = System.currentTimeMillis() / 1000L * 1000L;
        String signedAt = time(now - 10L * day);
        String storedAt = time(now - 15L * day);
        ExpressQueryResult feed = new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                now - 10L * day, storedAt, "快件到达营业点",
                tracks(new String[][]{{signedAt, "快件已签收"}, {storedAt, "快件到达营业点"},
                        {time(now - 16L * day), "快件已揽收"}}),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, now - 10L * day));
        repository.saveInterface5(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertNotNull(owner);
        assertEquals(storedAt, repository.find(owner.rowId).latestTime);

        ExpressItem listed = listed(owner.rowId, "interface5");
        assertEquals(signedAt, listed.latestTime);
        assertEquals("快件已签收", listed.latestDetail);
        assertNotNull(repository.findVisibleByWaybill(ZTO, "interface5"));
    }

    @Test public void aKnownDifferentNodeCannotMatchSigningByTimeAlone() throws Exception {
        String json = new JSONArray()
                .put(new JSONObject().put("time", at(107)).put("context", "配送节点").put("statusCode", "105"))
                .put(new JSONObject().put("time", at(100)).put("context", "签收节点").put("statusCode", "107"))
                .toString();
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                base + 110L * MINUTE, at(107), "配送节点", json, "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, base + 110L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertEquals("签收节点", listed(owner.rowId, "interface5").latestDetail);
        assertEquals(StatusSemantic.DELIVERY, probe(owner.rowId, "interface5").headlineSemantic);
        org.junit.Assert.assertFalse(repository.signedFrozen(owner));
    }

    @Test public void anUnknownNodeMayMatchTheStatusWithinFiveMinutes() throws Exception {
        String json = new JSONArray()
                .put(new JSONObject().put("time", at(107)).put("context", "未知状态节点"))
                .put(new JSONObject().put("time", at(104)).put("context", "配送节点").put("statusCode", "105"))
                .toString();
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                base + 110L * MINUTE, at(104), "配送节点", json, "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, base + 110L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertEquals("未知状态节点", listed(owner.rowId, "interface5").latestDetail);
    }

    @Test public void aNewerStructuredHeadlineUpdatesOnlyTheDisplayStatus() throws Exception {
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.ORDERED,
                base, at(0), "旧节点", tracks(new String[][]{{at(0), "旧节点"}}),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.ORDERED, base)), PHONE);
        context.getSystemService(NotificationManager.class).cancelAll();
        String json = new JSONArray().put(new JSONObject().put("time", at(30))
                .put("context", "配送节点").put("statusCode", "105")).toString();
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.PICKED,
                base + 20L * MINUTE, at(30), "配送节点", json, "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.PICKED, base + 20L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertEquals(StatusSemantic.DELIVERY, listed(owner.rowId, "interface5").semantic);
        assertEquals(StatusSemantic.PICKED, repository.find(owner.rowId).semantic);
        List<Notification> posted = Shadows.shadowOf(context.getSystemService(NotificationManager.class))
                .getAllNotifications();
        assertEquals("the displayed delivery also owns one aggregate live surface", 2, posted.size());
        Notification ordinary = posted.stream().filter(n -> "express_picked".equals(n.getChannelId())).findFirst().orElseThrow();
        Notification live = posted.stream().filter(n -> "express_live".equals(n.getChannelId())).findFirst().orElseThrow();
        assertEquals("派送中 1 件", live.extras.getCharSequence(Notification.EXTRA_TITLE).toString());
        assertEquals("the display override cannot change the notification channel", "express_picked",
                ordinary.getChannelId());
        assertTrue("the notification title must use the list's promoted display status",
                ordinary.extras.getCharSequence(Notification.EXTRA_TITLE).toString().contains("派送中"));
    }

    @Test public void aKnownCoarseHeadlineWaitsForFinishedAlignmentBeforeUsingItsStatusDonor() throws Exception {
        String json = new JSONArray()
                .put(new JSONObject().put("time", at(22)).put("context", "简略签收节点").put("statusCode", "107"))
                .put(new JSONObject().put("time", at(20)).put("context", "简略配送节点").put("statusCode", "105"))
                .toString();
        repository.saveInterface5(new ExpressQueryResult(SF, "SF", "顺丰速运", StatusSemantic.DELIVERY,
                base + 20L * MINUTE, at(22), "简略签收节点", json, "", PHONE, "interface5", "", "", "ShunFeng")
                .withWorkerStatus(structured(StatusSemantic.DELIVERY, base + 20L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(SF, "interface5");
        assertNotNull(owner);
        String storedTracks = repository.find(owner.rowId).tracksJson;

        ExpressItem first = listed(owner.rowId, "interface5");
        assertEquals(StatusSemantic.DELIVERY, first.semantic);
        assertEquals(base + 20L * MINUTE, first.statusEventTime);
        assertEquals("简略签收节点", first.latestDetail);
        assertEquals(at(22), first.latestTime);

        ExpressRepository.StatusAlignmentProbe probe = probe(owner.rowId, "interface5");
        org.junit.Assert.assertTrue(probe.headlineCoarse);
        assertEquals(StatusSemantic.COMPLETED, probe.headlineSemantic);
        String times = ExpressRepository.alignmentTimes(probe);
        java.util.Map<String, Long> before = repository.statusAlignmentEvidence(owner);
        org.junit.Assert.assertTrue(repository.beginStatusAlignment(owner, times, System.currentTimeMillis()));
        assertEquals("a reserved request has not finished", "简略签收节点",
                listed(owner.rowId, "interface5").latestDetail);
        assertEquals(StatusSemantic.DELIVERY, listed(owner.rowId, "interface5").semantic);

        repository.finishStatusAlignment(owner, times, before);
        org.junit.Assert.assertTrue(repository.alignmentAttemptFinished(owner.rowId, times));
        ExpressItem fallback = listed(owner.rowId, "interface5");
        assertEquals("简略配送节点", fallback.latestDetail);
        assertEquals(at(20), fallback.latestTime);
        assertEquals(StatusSemantic.DELIVERY, fallback.semantic);
        assertEquals(base + 20L * MINUTE, fallback.statusEventTime);
        assertEquals(StatusSemantic.DELIVERY, repository.find(owner.rowId).semantic);
        assertEquals(at(22), repository.find(owner.rowId).latestTime);
        assertEquals(storedTracks, repository.find(owner.rowId).tracksJson);
        org.junit.Assert.assertFalse(repository.signedFrozen(owner));
    }

    @Test public void aKnownSameStateHeadlineWithinFiveMinutesAdvancesOnlyTheDisplayTime() throws Exception {
        String json = new JSONArray().put(new JSONObject().put("time", at(22))
                .put("context", "较新配送节点").put("statusCode", "105")).toString();
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.DELIVERY,
                base + 20L * MINUTE, at(22), "较新配送节点", json, "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.DELIVERY, base + 20L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertNotNull(owner);
        String storedTracks = repository.find(owner.rowId).tracksJson;

        ExpressItem shown = listed(owner.rowId, "interface5");
        assertEquals(base + 22L * MINUTE, shown.statusEventTime);
        assertEquals(StatusSemantic.DELIVERY, shown.semantic);
        assertEquals("较新配送节点", shown.latestDetail);
        assertEquals(at(22), shown.latestTime);
        ExpressItem stored = repository.find(owner.rowId);
        assertEquals(base + 20L * MINUTE, stored.statusEventTime);
        assertEquals(StatusSemantic.DELIVERY, stored.semantic);
        assertEquals(storedTracks, stored.tracksJson);
    }

    /** The displayed feed node owns Hs even when another package has the same text and time. */
    @Test public void aNonSfFeedHeadlineDoesNotBorrowAnEnumFromAnUnselectedManualPackage() throws Exception {
        String headline = "Same synthetic event";
        String feedTracks = new JSONArray().put(new JSONObject().put("time", at(22))
                .put("context", headline).put("statusCode", "105")).toString();
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.DELIVERY,
                base + 20L * MINUTE, at(22), headline, feedTracks,
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.DELIVERY, base + 20L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertNotNull(owner);
        String storedTracks = owner.tracksJson;

        String manualTracks = new JSONArray().put(new JSONObject().put("time", at(22))
                .put("context", headline).put("statusCode", "3")).toString();
        ExpressQueryResult manual = new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.UNKNOWN,
                0L, at(22), headline, manualTracks, "", PHONE, TimelineSlot.V6_QUERY, "", "", "");
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, manual, base + 23L * MINUTE, false)),
                PHONE, "interface5");
        ManualTimelineAuthorityPolicy.Candidate cached =
                repository.manualTimelineCandidate(owner, TimelineSlot.V6_QUERY);
        assertNotNull(cached);
        assertEquals(StatusSemantic.COMPLETED,
                ExpressTimeline.parse(cached.result.tracksJson, "", "", cached.provider).get(0).semantic);
        ExpressItem stored = repository.find(owner.rowId);
        assertEquals("the timed feed still owns the displayed headline", "", stored.manualTimelineProvider);
        assertEquals(storedTracks, stored.tracksJson);
        assertEquals(StatusSemantic.DELIVERY, stored.semantic);
        assertEquals(base + 20L * MINUTE, stored.statusEventTime);

        ExpressItem shown = listed(owner.rowId, "interface5");
        assertEquals("the feed node, not the same-text manual node, owns Hs",
                StatusSemantic.DELIVERY, shown.semantic);
        assertEquals(base + 22L * MINUTE, shown.statusEventTime);
        assertEquals(headline, shown.latestDetail);
        assertEquals(at(22), shown.latestTime);
        assertEquals(StatusSemantic.DELIVERY, probe(owner.rowId, "interface5").headlineSemantic);
        assertEquals(StatusSemantic.DELIVERY, repository.listVisibleForHome("interface5").get(0).semantic);
    }

    @Test public void aSelectedSfManualHeadlineKeepsItsOwnEnumWhenTheFeedHasTheSameNode() throws Exception {
        String headline = "Same synthetic event";
        repository.saveInterface5(new ExpressQueryResult(SF, "SF", "顺丰速运", StatusSemantic.DELIVERY,
                base + 20L * MINUTE, at(22), headline, codedTracks(at(22), headline, "3"),
                "", PHONE, "interface5", "", "", "ShunFeng")
                .withWorkerStatus(structured(StatusSemantic.DELIVERY, base + 20L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(SF, "interface5");
        ExpressQueryResult manual = new ExpressQueryResult(SF, "SF", "顺丰速运", StatusSemantic.DELIVERY,
                base + 20L * MINUTE, at(22), headline, codedTracks(at(22), headline, "5"),
                "", PHONE, TimelineSlot.V6_QUERY, "", "", "")
                .withManualStatusEvidence("Out for delivery", true);
        saveManual(owner, manual);

        ExpressItem projected = repository.find(owner.rowId);
        assertEquals(TimelineSlot.V6_QUERY, projected.manualTimelineProvider);
        assertEquals(headline, projected.latestDetail);
        assertEquals(at(22), projected.latestTime);
        ExpressRepository.StatusAlignmentProbe probe = probe(owner.rowId, "interface5");
        assertEquals(StatusSemantic.DELIVERY, probe.headlineSemantic);
        assertFalse(probe.headlineCoarse);
        assertEquals(StatusSemantic.DELIVERY, listed(owner.rowId, "interface5").semantic);
        assertEquals(base + 22L * MINUTE, listed(owner.rowId, "interface5").statusEventTime);
    }

    @Test public void aNonSfSelectedManualTimelineDoesNotOwnTheRetainedFeedHeadline() throws Exception {
        String headline = "Same synthetic event";
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.DELIVERY,
                base + 20L * MINUTE, at(22), headline, "[]",
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.DELIVERY, base + 20L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        saveManual(owner, new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.UNKNOWN,
                0L, at(22), headline, codedTracks(at(22), headline, "3"),
                "", PHONE, TimelineSlot.V6_QUERY, "", "", ""));

        ExpressItem projected = repository.find(owner.rowId);
        assertEquals(TimelineSlot.V6_QUERY, projected.manualTimelineProvider);
        assertEquals(headline, projected.latestDetail);
        assertEquals(at(22), projected.latestTime);
        assertEquals(StatusSemantic.UNKNOWN, probe(owner.rowId, "interface5").headlineSemantic);
        ExpressItem shown = listed(owner.rowId, "interface5");
        assertEquals(StatusSemantic.DELIVERY, shown.semantic);
        assertEquals(base + 20L * MINUTE, shown.statusEventTime);
        assertEquals(projected.latestDetail, shown.latestDetail);
        assertEquals(projected.latestTime, shown.latestTime);
    }

    @Test public void aNewerAccountQueryHeadlineKeepsItsOwnEnumWhenAnotherManualPackageHasTheSameNode() throws Exception {
        ExpressItem owner = nonSfOwnerWithManualDecoy(at(20), "Old feed event", at(24));
        ExpressQueryResult query = new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.DELIVERY,
                base + 20L * MINUTE, at(24), "Same synthetic event",
                codedTracks(at(24), "Same synthetic event", "105"),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.DELIVERY, base + 20L * MINUTE));
        assertTrue(repository.saveInterface5Query(query, owner, repository.bindingGeneration(PHONE, "interface5")));

        ExpressItem projected = repository.find(owner.rowId);
        assertEquals("the timed feed keeps its timeline; only the query headline advances",
                "", projected.manualTimelineProvider);
        assertEquals(query.latestDetail, projected.latestDetail);
        assertEquals(query.latestTime, projected.latestTime);
        assertEquals(StatusSemantic.DELIVERY, probe(owner.rowId, "interface5").headlineSemantic);
        ExpressItem shown = listed(owner.rowId, "interface5");
        assertEquals(StatusSemantic.DELIVERY, shown.semantic);
        assertEquals(base + 24L * MINUTE, shown.statusEventTime);
        assertEquals(query.latestDetail, shown.latestDetail);
        assertEquals(query.latestTime, shown.latestTime);
    }

    @Test public void aStatusOnlyAccountQueryKeepsTheFeedHeadlineProvenance() throws Exception {
        String headline = "Same synthetic event";
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.DELIVERY,
                base + 20L * MINUTE, at(30), headline, codedTracks(at(30), headline, "105"),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.DELIVERY, base + 20L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        saveManual(owner, new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.UNKNOWN,
                0L, at(30), headline, codedTracks(at(30), headline, "3"),
                "", PHONE, TimelineSlot.V6_QUERY, "", "", ""));
        ExpressQueryResult query = new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.DELIVERY,
                base + 30L * MINUTE, at(10), "Older query event", codedTracks(at(10), "Older query event", "104"),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.DELIVERY, base + 30L * MINUTE));
        assertTrue(repository.saveInterface5Query(query, owner, repository.bindingGeneration(PHONE, "interface5")));

        ExpressItem projected = repository.find(owner.rowId);
        assertEquals(base + 30L * MINUTE, projected.statusEventTime);
        assertEquals(headline, projected.latestDetail);
        assertEquals(at(30), projected.latestTime);
        assertEquals(StatusSemantic.DELIVERY, probe(owner.rowId, "interface5").headlineSemantic);
    }

    @Test public void anAttachedCarrierHeadlineCarriesItsOwnEnumPastTheSelectedManualTimeline() throws Exception {
        String order = "3630448013820579";
        String headline = "Same synthetic event";
        repository.saveInterface5OrderSummary(new ExpressQueryResult(order, "JD", "京东购物", StatusSemantic.TRANSIT,
                base + 20L * MINUTE, at(20), "Old feed event", "[]",
                "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(structured(StatusSemantic.TRANSIT, base + 20L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(order, "interface5");
        assertTrue(repository.saveOrderProjection(owner, "interface5", ZTO, "中通快递"));
        owner = repository.find(owner.rowId);
        assertTrue(repository.saveAutomaticDetailTimeline(owner, repository.captureManualQueryOwner(owner),
                new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.UNKNOWN, 0L,
                        at(24), headline, codedTracks(at(24), headline, "3"),
                        "", "", TimelineSlot.JD_H5, "", "", ""), true));
        assertEquals(TimelineSlot.JD_H5, repository.find(owner.rowId).manualTimelineProvider);

        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.DELIVERY,
                base + 23L * MINUTE, at(24), headline, codedTracks(at(24), headline, "105"),
                "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(structured(StatusSemantic.DELIVERY, base + 23L * MINUTE)), PHONE);

        ExpressItem projected = repository.find(owner.rowId);
        assertEquals(order, projected.waybill);
        assertEquals(TimelineSlot.JD_H5, projected.manualTimelineProvider);
        assertEquals(StatusSemantic.DELIVERY, projected.semantic);
        assertEquals(headline, projected.latestDetail);
        assertEquals(at(24), projected.latestTime);
        assertEquals(StatusSemantic.DELIVERY, probe(owner.rowId, "interface5").headlineSemantic);
        assertEquals(projected.latestDetail, listed(owner.rowId, "interface5").latestDetail);
        assertEquals(projected.latestTime, listed(owner.rowId, "interface5").latestTime);
    }

    @Test public void manualOnlyRetentionDoesNotBorrowTheNewerAccountQueryHeadlineEnum() throws Exception {
        base = (System.currentTimeMillis() - ExpressVisibilityPolicy.SIGNED_VISIBLE_MS - 21L * MINUTE)
                / 1000L * 1000L;
        String delivery = "Feed delivery event";
        String signature = "Feed signing event";
        String feedTracks = new JSONArray()
                .put(new JSONObject().put("time", at(22)).put("context", delivery).put("statusCode", "105"))
                .put(new JSONObject().put("time", at(20)).put("context", signature).put("statusCode", "107"))
                .toString();
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                base + 20L * MINUTE, at(22), delivery, feedTracks,
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, base + 20L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertEquals(StatusSemantic.COMPLETED, owner.semantic);
        assertTrue(owner.signedRetainedAt > 0L);
        ExpressQueryResult query = new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                base + 20L * MINUTE, at(28), "Newer unknown query event",
                codedTracks(at(28), "Newer unknown query event", "UNKNOWN"),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, base + 20L * MINUTE));
        assertTrue(repository.saveInterface5Query(query, owner, repository.bindingGeneration(PHONE, "interface5")));
        assertEquals(query.latestTime, repository.find(owner.rowId).latestTime);
        context.getSystemService(NotificationManager.class).cancelAll();

        ExpressItem manualOnly = repository.saveOwnerManualTimeline(owner,
                new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.UNKNOWN, 0L,
                        at(10), "Older manual event", codedTracks(at(10), "Older manual event", "0"),
                        "", PHONE, TimelineSlot.V6_QUERY, "", "", ""),
                PHONE, "interface5", base + 29L * MINUTE, false);
        assertEquals("the write path passes its manual-only projection into retention", at(22), manualOnly.latestTime);
        assertEquals(delivery, manualOnly.latestDetail);
        assertEquals(StatusSemantic.COMPLETED, manualOnly.semantic);
        assertEquals(query.latestTime, repository.find(owner.rowId).latestTime);
        java.lang.reflect.Method retention = ExpressRepository.class.getDeclaredMethod("retentionView",
                android.database.sqlite.SQLiteDatabase.class, ExpressItem.class);
        retention.setAccessible(true);
        ExpressItem retained = (ExpressItem) retention.invoke(repository, database.getWritableDatabase(), manualOnly);
        assertEquals("retention aligns the enum of its actual feed headline, not the newer query headline",
                at(20), retained.latestTime);
        assertEquals(signature, retained.latestDetail);
        assertTrue(ExpressVisibilityPolicy.isHiddenSigned(retained, System.currentTimeMillis()));
        assertEquals("this unchanged manual-only write has no notification event", 0,
                context.getSystemService(NotificationManager.class).getActiveNotifications().length);
    }

    private ExpressItem nonSfOwnerWithManualDecoy(String feedTime, String feedHeadline, String manualTime)
            throws Exception {
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.DELIVERY,
                base + 20L * MINUTE, feedTime, feedHeadline, codedTracks(feedTime, feedHeadline, "105"),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.DELIVERY, base + 20L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        saveManual(owner, new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.UNKNOWN,
                0L, manualTime, "Same synthetic event", codedTracks(manualTime, "Same synthetic event", "3"),
                "", PHONE, TimelineSlot.V6_QUERY, "", "", ""));
        assertEquals("", repository.find(owner.rowId).manualTimelineProvider);
        return repository.find(owner.rowId);
    }

    private void saveManual(ExpressItem owner, ExpressQueryResult result) {
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(result.timelineProvider, result, base + 25L * MINUTE, false)),
                PHONE, "interface5");
        assertNotNull(repository.manualTimelineCandidate(owner, result.timelineProvider));
    }

    private static String codedTracks(String time, String detail, String code) throws Exception {
        return new JSONArray().put(new JSONObject().put("time", time).put("context", detail)
                .put("statusCode", code)).toString();
    }

    @Test public void anUnknownNewerHeadlineWithinFiveMinutesKeepsTheDisplayStatusTime() throws Exception {
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.DELIVERY,
                base + 20L * MINUTE, at(22), "未知状态节点",
                tracks(new String[][]{{at(22), "未知状态节点"}}), "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.DELIVERY, base + 20L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertNotNull(owner);
        assertEquals(StatusSemantic.UNKNOWN, probe(owner.rowId, "interface5").headlineSemantic);
        ExpressItem shown = listed(owner.rowId, "interface5");
        assertEquals(base + 20L * MINUTE, shown.statusEventTime);
        assertEquals(StatusSemantic.DELIVERY, shown.semantic);
        assertEquals(at(22), shown.latestTime);
    }

    @Test public void aNewerKnownNonTerminalHeadlineCannotRewindASignedDisplay() throws Exception {
        String json = new JSONArray()
                .put(new JSONObject().put("time", at(22)).put("context", "配送节点").put("statusCode", "105"))
                .put(new JSONObject().put("time", at(20)).put("context", "签收节点").put("statusCode", "107"))
                .toString();
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                base + 20L * MINUTE, at(22), "配送节点", json, "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, base + 20L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertNotNull(owner);
        ExpressItem shown = listed(owner.rowId, "interface5");
        assertEquals(StatusSemantic.COMPLETED, shown.semantic);
        assertEquals(base + 20L * MINUTE, shown.statusEventTime);
        assertEquals("签收节点", shown.latestDetail);
        assertEquals(at(20), shown.latestTime);
        assertEquals("配送节点", repository.find(owner.rowId).latestDetail);
    }

    @Test public void anUntimedStatusUsesItsLatestRealNodeOnlyForAlignment() throws Exception {
        String json = new JSONArray()
                .put(new JSONObject().put("time", at(111)).put("context", "快递状态已更新"))
                .put(new JSONObject().put("time", at(110)).put("context", "签收节点").put("statusCode", "107"))
                .put(new JSONObject().put("time", at(20)).put("context", "旧节点"))
                .toString();
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                0L, at(20), "旧节点", json, "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, 0L)), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        ExpressRepository.StatusAlignmentProbe probe = probe(owner.rowId, "interface5");
        assertEquals(base + 110L * MINUTE, probe.statusAt);
        org.junit.Assert.assertTrue(probe.statusTimeFallback);
        assertEquals(0L, repository.find(owner.rowId).statusEventTime);
        assertEquals("签收节点", listed(owner.rowId, "interface5").latestDetail);
        org.junit.Assert.assertFalse(repository.signedFrozen(owner));
    }

    @Test public void notificationBodyUsesTheAlignedHeadlineWithoutChangingItsStatusChannel() throws Exception {
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.PICKED,
                base, at(0), "旧节点", tracks(new String[][]{{at(0), "旧节点"}}),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.PICKED, base)), PHONE);
        context.getSystemService(NotificationManager.class).cancelAll();
        String json = new JSONArray()
                .put(new JSONObject().put("time", at(30)).put("context", "运输节点").put("statusCode", "104"))
                .put(new JSONObject().put("time", at(20)).put("context", "旧配送节点").put("statusCode", "105"))
                .toString();
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.TRANSIT,
                base + 30L * MINUTE, at(20), "旧配送节点", json, "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.TRANSIT, base + 30L * MINUTE)), PHONE);
        List<Notification> posted = Shadows.shadowOf(context.getSystemService(NotificationManager.class))
                .getAllNotifications();
        assertEquals(1, posted.size());
        assertEquals("express_transit", posted.get(0).getChannelId());
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertEquals("运输节点", listed(owner.rowId, "interface5").latestDetail);
        assertEquals(listed(owner.rowId, "interface5").latestDetail,
                posted.get(0).extras.getCharSequence(Notification.EXTRA_TEXT).toString().replace("\u200B", ""));
        assertEquals(StatusSemantic.TRANSIT, repository.find(owner.rowId).semantic);
    }

    @Test public void aSignedSfNotificationWaitsForTheFirstAlignmentThenUsesItsFinalFallback() throws Exception {
        ExpressItem owner = sfSigningAfterOlderPicker();
        assertEquals("a status change cannot publish the old transit headline", 0,
                context.getSystemService(NotificationManager.class).getActiveNotifications().length);
        database.close();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        repository.replayPendingNotifications();
        assertEquals("repository recreation cannot release the durable pending event early", 0,
                context.getSystemService(NotificationManager.class).getActiveNotifications().length);
        ExpressRepository.StatusAlignmentProbe probe = probe(owner.rowId, "interface5");
        String times = ExpressRepository.alignmentTimes(probe);
        java.util.Map<String, Long> before = repository.statusAlignmentEvidence(owner);
        assertTrue(repository.beginStatusAlignment(owner, times, System.currentTimeMillis()));
        repository.replayPendingNotifications();
        assertEquals("a reserved request has not finished", 0,
                context.getSystemService(NotificationManager.class).getActiveNotifications().length);
        repository.finishStatusAlignment(owner, times, before);
        List<Notification> posted = Shadows.shadowOf(context.getSystemService(NotificationManager.class))
                .getAllNotifications();
        assertEquals(1, posted.size());
        assertEquals("快件已签收", posted.get(0).extras.getCharSequence(Notification.EXTRA_TEXT)
                .toString().replace("\u200B", ""));
        repository.replayPendingNotifications();
        assertEquals(1, Shadows.shadowOf(context.getSystemService(NotificationManager.class))
                .getAllNotifications().size());
    }

    @Test public void aPendingSfSigningUsesTheDetailedSameStateNodeWhenItArrives() throws Exception {
        ExpressItem owner = sfSigningAfterOlderPicker();
        assertEquals(0, context.getSystemService(NotificationManager.class).getActiveNotifications().length);
        String times = ExpressRepository.alignmentTimes(probe(owner.rowId, "interface5"));
        java.util.Map<String, Long> before = repository.statusAlignmentEvidence(owner);
        assertTrue(repository.beginStatusAlignment(owner, times, System.currentTimeMillis()));
        ExpressQueryResult signed = new ExpressQueryResult(SF, "SF", "顺丰速运", StatusSemantic.COMPLETED,
                base + 110L * MINUTE, at(110), "本人已签收，感谢使用顺丰",
                new JSONArray().put(new JSONObject().put("time", at(110))
                        .put("context", "本人已签收，感谢使用顺丰").put("action", "SIGNED"))
                        .put(new JSONObject().put("time", at(20)).put("context", "快件到达营业点")
                                .put("action", "TRANSPORT")).toString(),
                "", PHONE, TimelineSlot.V6_QUERY, "", "", "")
                .withManualStatusEvidence("已签收", true);
        java.lang.reflect.Field active = me.pipi.deliveries.background.ExpressStatusAlignment.class
                .getDeclaredField("ALIGNING");
        active.setAccessible(true);
        @SuppressWarnings("unchecked") java.util.Set<Long> aligning = (java.util.Set<Long>) active.get(null);
        aligning.add(owner.rowId);
        try {
            repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                    List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, signed, System.currentTimeMillis(), false)),
                    PHONE, "interface5");
            assertEquals("an inner commit cannot publish before the alignment attempt finishes", 0,
                    context.getSystemService(NotificationManager.class).getActiveNotifications().length);
        } finally { aligning.remove(owner.rowId); }
        repository.finishStatusAlignment(owner, times, before);
        List<Notification> posted = Shadows.shadowOf(context.getSystemService(NotificationManager.class))
                .getAllNotifications();
        assertEquals(1, posted.size());
        assertEquals("本人已签收，感谢使用顺丰", posted.get(0).extras.getCharSequence(Notification.EXTRA_TEXT)
                .toString().replace("\u200B", ""));
    }

    @Test public void aKnownConflictingSfNodeCannotReleaseTheSigningWithinFiveMinutes() throws Exception {
        ExpressItem owner = sfSigningAfterOlderPicker();
        saveSfNearSigning(owner, true);
        assertEquals(0, context.getSystemService(NotificationManager.class).getActiveNotifications().length);
        assertEquals(StatusSemantic.COMPLETED, listed(owner.rowId, "interface5").semantic);
    }

    @Test public void anUnknownSfNodeMayReleaseTheSigningWithinFiveMinutes() throws Exception {
        ExpressItem owner = sfSigningAfterOlderPicker();
        saveSfNearSigning(owner, false);
        List<Notification> posted = Shadows.shadowOf(context.getSystemService(NotificationManager.class))
                .getAllNotifications();
        assertEquals(1, posted.size());
        assertEquals("最新详细节点", posted.get(0).extras.getCharSequence(Notification.EXTRA_TEXT)
                .toString().replace("\u200B", ""));
    }

    @Test public void aNonSignedSfUpdateKeepsItsExistingPublicationTiming() throws Exception {
        ExpressItem owner = sfChangeAfterOlderPicker(StatusSemantic.DELIVERY);
        ExpressQueryResult result = new ExpressQueryResult(SF, "SF", "顺丰速运", StatusSemantic.DELIVERY,
                base + 110L * MINUTE, at(20), "快件到达营业点",
                tracks(new String[][]{{at(20), "快件到达营业点"}, {at(0), "顺丰速运 已收取快件"}}),
                "", PHONE, TimelineSlot.V6_QUERY, "", "", "").withManualStatusEvidence("派送中", true);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, result, System.currentTimeMillis(), false)),
                PHONE, "interface5");
        assertEquals(1, context.getSystemService(NotificationManager.class).getActiveNotifications().length);
    }

    @Test public void finishingSfAlignmentDoesNotReplayAnotherRowsPendingNotification() throws Exception {
        ExpressItem owner = sfSigningAfterOlderPicker();
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.TRANSIT,
                base + 20L * MINUTE, at(20), "Other row event",
                tracks(new String[][]{{at(20), "Other row event"}}),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.TRANSIT, base + 20L * MINUTE)), PHONE);
        ExpressItem other = repository.findByWaybill(ZTO, "interface5");
        android.content.ContentValues event = new android.content.ContentValues();
        event.put("owner_row_id", other.rowId);
        event.put("event_token", "synthetic-other-pending");
        database.getWritableDatabase().insertOrThrow(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null, event);
        String times = ExpressRepository.alignmentTimes(probe(owner.rowId, "interface5"));
        java.util.Map<String, Long> before = repository.statusAlignmentEvidence(owner);
        assertTrue(repository.beginStatusAlignment(owner, times, System.currentTimeMillis()));
        repository.finishStatusAlignment(owner, times, before);
        assertEquals("only the settled SF row is published", 1,
                context.getSystemService(NotificationManager.class).getActiveNotifications().length);
        assertEquals(1L, android.database.DatabaseUtils.queryNumEntries(database.getReadableDatabase(),
                ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, "owner_row_id=?",
                new String[]{Long.toString(other.rowId)}));
    }

    private void saveSfNearSigning(ExpressItem owner, boolean knownConflict) throws Exception {
        JSONObject head = new JSONObject().put("time", at(108)).put("context", "最新详细节点");
        if (knownConflict) head.put("action", "DELIVERING");
        ExpressQueryResult result = new ExpressQueryResult(SF, "SF", "顺丰速运", StatusSemantic.DELIVERY,
                base + 108L * MINUTE, at(108), "最新详细节点", new JSONArray().put(head)
                        .put(new JSONObject().put("time", at(20)).put("context", "快件到达营业点")
                                .put("action", "TRANSPORT")).toString(),
                "", PHONE, TimelineSlot.V6_QUERY, "", "", "").withManualStatusEvidence("派送中", true);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, result, System.currentTimeMillis(), false)),
                PHONE, "interface5");
    }

    private ExpressItem sfSigningAfterOlderPicker() throws Exception {
        return sfChangeAfterOlderPicker(StatusSemantic.COMPLETED);
    }

    private ExpressItem sfChangeAfterOlderPicker(StatusSemantic semantic) throws Exception {
        repository.saveInterface5(new ExpressQueryResult(SF, "SF", "顺丰速运", StatusSemantic.TRANSIT,
                base + 20L * MINUTE, at(20), "快件到达营业点",
                tracks(new String[][]{{at(20), "快件到达营业点"}, {at(0), "顺丰速运 已收取快件"}}),
                "", PHONE, "interface5", "", "", "ShunFeng")
                .withWorkerStatus(structured(StatusSemantic.TRANSIT, base + 20L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(SF, "interface5");
        ExpressQueryResult picker = new ExpressQueryResult(SF, "SF", "顺丰速运", StatusSemantic.TRANSIT,
                base + 20L * MINUTE, at(20), "快件到达营业点",
                tracks(new String[][]{{at(20), "快件到达营业点"}, {at(0), "顺丰速运 已收取快件"}}),
                "", PHONE, TimelineSlot.V6_QUERY, "", "", "").withManualStatusEvidence("运输中", true);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, picker, base + 21L * MINUTE, false)),
                PHONE, "interface5");
        context.getSystemService(NotificationManager.class).cancelAll();
        String detail = semantic == StatusSemantic.COMPLETED ? "快件已签收" : "快件正在派送";
        repository.saveInterface5(new ExpressQueryResult(SF, "SF", "顺丰速运", semantic,
                base + 110L * MINUTE, at(110), detail,
                tracks(new String[][]{{at(110), detail}, {at(0), "顺丰速运 已收取快件"}}),
                "", PHONE, "interface5", "", "", "ShunFeng")
                .withWorkerStatus(structured(semantic, base + 110L * MINUTE)), PHONE);
        return repository.find(owner.rowId);
    }

    /** An interface 6 feed carries no nodes: with no captured package its detail has no timed node, no D. */
    @Test public void anInterface6RowWithOnlyItsFeedHasNoDetailTime() throws Exception {
        ExpressQueryResult feed = new ExpressQueryResult(CAINIAO, "YTO", "圆通速递", StatusSemantic.TRANSIT,
                base + 30L * MINUTE, at(30), "快件运输中", "[]", "", PHONE, TimelineSlot.V6_LIST, "", "",
                "CaiNiao").withWorkerStatus(structured(StatusSemantic.TRANSIT, base + 30L * MINUTE));
        repository.saveInterface6(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(CAINIAO, "interface6");
        assertNotNull(owner);

        ExpressRepository.StatusAlignmentProbe probe = probe(owner.rowId, "interface6");
        assertEquals(base + 30L * MINUTE, probe.statusAt);
        assertEquals(base + 30L * MINUTE, probe.headlineAt);
        assertEquals(0L, probe.detailAt);
    }

    /** Cancelled rows take no part. */
    @Test public void aCancelledRowHasNoProbe() throws Exception {
        ExpressQueryResult feed = new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.CANCELLED,
                base + 110L * MINUTE, at(20), "订单已取消",
                tracks(new String[][]{{at(20), "订单已取消"}}), "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.CANCELLED, base + 110L * MINUTE));
        repository.saveInterface5(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertNotNull(owner);
        for (ExpressRepository.StatusAlignmentProbe probe : repository.statusAlignmentProbes("interface5")) {
            if (probe.row.rowId == owner.rowId) throw new AssertionError("a cancelled row was probed");
        }
    }

    /**
     * Both refresh paths can query a coarse signed SF feed, and share the same active lease.
     */
    @Test public void ordinaryAndAlignmentClaimsShareTheirActiveLease() throws Exception {
        ExpressItem owner = repository.find(signedShunFengWithOlderPicker().rowId);
        long now = System.currentTimeMillis();
        ExpressRepository.ManualTimelinePollClaim ordinary = repository.claimManualTimelinePoll(owner, now);
        assertNotNull(ordinary);
        assertNull("an active lease still holds", repository.claimStatusAlignmentManualTimelinePoll(owner, now));
        repository.releaseManualTimelinePoll(ordinary);
        ExpressRepository.ManualTimelinePollClaim again =
                repository.claimStatusAlignmentManualTimelinePoll(owner, now);
        assertNotNull(again);
        repository.releaseManualTimelinePoll(again);
    }

    private ExpressItem signedShunFengWithOlderPicker() throws Exception {
        ExpressQueryResult feed = new ExpressQueryResult(SF, "SF", "顺丰速运", StatusSemantic.COMPLETED,
                base + 110L * MINUTE, at(110), "快件已签收",
                tracks(new String[][]{{at(110), "快件已签收"}, {at(0), "顺丰速运 已收取快件"}}),
                "", PHONE, "interface5", "", "", "ShunFeng")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, base + 110L * MINUTE));
        repository.saveInterface5(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(SF, "interface5");
        assertNotNull(owner);
        ExpressQueryResult picker = new ExpressQueryResult(SF, "SF", "顺丰速运", StatusSemantic.TRANSIT,
                base + 20L * MINUTE, at(20), "快件到达营业点",
                tracks(new String[][]{{at(20), "快件到达营业点"}, {at(0), "顺丰速运 已收取快件"}}),
                "", PHONE, TimelineSlot.V6_QUERY, "", "", "")
                .withManualStatusEvidence("运输中", true);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, picker, base + 21L * MINUTE, false)),
                PHONE, "interface5");
        return repository.find(owner.rowId);
    }

    private ExpressItem listed(long rowId, String binding) {
        for (ExpressItem item : repository.listVisible(binding)) {
            if (item.rowId == rowId) return item;
        }
        throw new AssertionError("the row is not visible");
    }

    private ExpressRepository.StatusAlignmentProbe probe(long rowId, String binding) {
        for (ExpressRepository.StatusAlignmentProbe probe : repository.statusAlignmentProbes(binding)) {
            if (probe.row.rowId == rowId) return probe;
        }
        throw new AssertionError("the row has no probe");
    }

    /** The fixture time {@code minutes} after {@link #base}, as the feeds write it (Asia/Shanghai). */
    private static String time(long epochMillis) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));
        return format.format(new Date(epochMillis));
    }

    private String at(long minutes) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));
        return format.format(new Date(base + minutes * MINUTE));
    }

    static WorkerStatusProjection structured(StatusSemantic semantic, long eventAtMs) throws Exception {
        return WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1)
                        .put("scope", "SHIPMENT").put("semantic", semantic.name())
                        .put("code", "SERVER_ENUM").put("text", semantic.label).put("priority", 0)
                        .put("eventAtMs", eventAtMs).put("structured", true)));
    }

    static String tracks(String[][] nodes) throws Exception {
        JSONArray value = new JSONArray();
        for (String[] node : nodes) value.put(new JSONObject().put("time", node[0]).put("context", node[1]));
        return value.toString();
    }
}
