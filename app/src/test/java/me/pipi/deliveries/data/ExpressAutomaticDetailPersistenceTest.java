package me.pipi.deliveries.data;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.database.SQLException;
import me.pipi.deliveries.model.*;
import me.pipi.deliveries.security.KeystoreSecretBox;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.*;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicInteger;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class,
        shadows = ExpressAutomaticDetailPersistenceTest.SyntheticSecretBox.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class ExpressAutomaticDetailPersistenceTest {
    @Implements(KeystoreSecretBox.class)
    public static class SyntheticSecretBox {
        @Implementation public static String encrypt(String alias, String value) {
            return Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8));
        }
        @Implementation public static String decrypt(String alias, String value) {
            return new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);
        }
    }
    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;
    private static final String PHONE = "13800000001";
    private static final String TIME = "2026-09-09 10:00:00";

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        repository.bindPhoneLocally(PHONE, "interface5");
        repository.bindPhoneLocally(PHONE, "interface6");
    }
    @After public void tearDown() {
        database.close(); context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void jtCaptureDisplayAndLabelSurviveTheActualCacheAndSelectedRead() throws Exception {
        ExpressItem owner = stagedOwner("JTTEST000001", "CaiNiao",
                "[" + node(TIME, "Synthetic account event") + "]");
        java.lang.reflect.Method normalize = Class.forName("me.pipi.deliveries.feature.express.ExpressKuaidi100TimelineCapture")
                .getDeclaredMethod("normalizedTracks", String.class, String.class);
        normalize.setAccessible(true);
        String tracks = (String) normalize.invoke(null,
                "{\"tracks\":[{\"time\":\"2026-09-10 10:00\",\"context\":\"运输中 运输中必须保留\","
                        + "\"displayContext\":\"运输中必须保留\",\"jtStatusLabel\":\"运输中\"}]}", TimelineSlot.JT_H5);
        java.lang.reflect.Method capture = me.pipi.deliveries.feature.express.ExpressDetailActivity.class
                .getDeclaredMethod("kuaidi100CapturedResult", String.class, String.class,
                        String.class, String.class, String.class);
        capture.setAccessible(true);
        ExpressQueryResult result = (ExpressQueryResult) capture.invoke(null,
                owner.waybill, "JTSD", "Synthetic carrier", "", tracks);
        assertNotNull(repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.JT_H5, result, 200L, false)), PHONE, "interface5"));
        ExpressRepository reopened = new ExpressRepository(context, database);
        ExpressItem saved = reopened.find(owner.rowId);
        ManualTimelineAuthorityPolicy.Candidate selected = reopened.manualTimelineCandidate(saved, TimelineSlot.JT_H5);
        assertNotNull(selected);
        org.json.JSONObject raw = new org.json.JSONArray(selected.result.tracksJson).getJSONObject(0);
        assertEquals("运输中 运输中必须保留", raw.getString("context"));
        assertEquals("运输中", raw.getString("jtStatusLabel"));
        assertEquals("运输中必须保留", raw.getString("displayContext"));
        assertEquals("运输中必须保留", ExpressTimeline.parse(selected.result.tracksJson, "", "").get(0).displayDetail);
        assertEquals(owner.latestDetail, saved.latestDetail);
        assertEquals(owner.latestDetail, ExpressTimeline.displayHeadline(saved));
        assertEquals(StatusSemantic.TRANSIT, selected.result.semantic);
        assertEquals(ExpressTimeline.parseTime("2026-09-10 10:00:00"), selected.result.statusEventTime);

        ExpressItem manual = reopened.saveManualQueryBatch(null, java.util.List.of(
                new ManualQuerySuccess(TimelineSlot.JT_H5, result.withWaybill("JTTEST000002"), 201L, false)),
                PHONE, "interface5");
        assertNotNull(manual);
        ExpressItem reloaded = reopened.find(manual.rowId);
        assertEquals("运输中 运输中必须保留", reloaded.latestDetail);
        assertEquals("运输中必须保留", ExpressTimeline.displayHeadline(reloaded));
    }

    @Test public void alignmentUsesTheJtDonorBodyWhileKeepingTheOriginalHistory() throws Exception {
        ExpressItem owner = stagedOwner("JTTEST-DONOR", "DouYin", "[" + node(TIME, "Synthetic old feed") + "]");
        String raw = "派送中 Synthetic JT donor";
        long statusAt = ExpressTimeline.parseTime("2026-09-10 10:00:00");
        String tracks = "[{\"time\":\"2026-09-10 10:00:00\",\"context\":\"" + raw
                + "\",\"displayContext\":\"Synthetic JT donor\",\"jtStatusLabel\":\"派送中\",\"_pipiStatusSource\":\"jt_h5\"}]";
        ExpressQueryResult result = new ExpressQueryResult(owner.waybill, "JTSD", "Synthetic carrier",
                StatusSemantic.DELIVERY, statusAt, "2026-09-10 10:00:00", raw, tracks, "", PHONE,
                TimelineSlot.JT_H5, "", "", "").withManualStatusEvidence("", true);
        assertNotNull(repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.JT_H5, result, 200L, false)), PHONE, "interface5"));
        var stored = repository.manualTimelineCandidate(owner, TimelineSlot.JT_H5);
        assertNotNull(stored);
        assertEquals(StatusSemantic.DELIVERY, stored.result.semantic);
        assertEquals(statusAt, stored.result.statusEventTime);
        Class<?> sidecars = Class.forName(ExpressRepository.class.getName() + "$VisibleProjectionSidecars");
        var read = ExpressRepository.class.getDeclaredMethod("rowProjectionSidecars",
                android.database.sqlite.SQLiteDatabase.class, ExpressItem.class); read.setAccessible(true);
        Object sources = read.invoke(repository, database.getReadableDatabase(), owner);
        Class<?> headline = Class.forName(ExpressRepository.class.getName() + "$AlignmentNode");
        var constructor = headline.getDeclaredConstructor(StatusSemantic.class, boolean.class); constructor.setAccessible(true);
        Object head = constructor.newInstance(StatusSemantic.UNKNOWN, false);
        var align = ExpressRepository.class.getDeclaredMethod("alignHeadlineToStatus",
                android.database.sqlite.SQLiteDatabase.class, ExpressItem.class, ExpressItem.class, sidecars, headline);
        align.setAccessible(true);
        ExpressItem projected = (ExpressItem) align.invoke(repository, database.getReadableDatabase(), owner,
                owner.withDisplayStatus(StatusSemantic.DELIVERY, statusAt), sources, head);
        assertEquals(raw, projected.latestDetail);
        assertEquals(owner.tracksJson, projected.tracksJson);
        assertEquals("Synthetic JT donor", ExpressTimeline.displayHeadline(projected));
        assertEquals("Synthetic JT donor", ExpressTimeline.displayHeadline(projected.withDisplayStatus(
                StatusSemantic.DELIVERY, statusAt).withAccountListMetadata("", 0L)
                .withSourceStatusStructured(!projected.sourceStatusStructured)));
    }

    @Test public void aFeedHeadlineCannotBorrowTheBodyFromItsDifferentSelectedJtHistory() throws Exception {
        ExpressItem owner = stagedOwner("JTTEST-FEED", "DouYin", "[]");
        String raw = "已揽件 Shared source text";
        ContentValues headline = new ContentValues();
        headline.put("lastLogisticDetail", raw);
        headline.put("logisticsGmtModified", TIME);
        database.getWritableDatabase().update(ExpressDatabase.EXPRESS_TABLE, headline,
                "_id=?", new String[]{Long.toString(owner.rowId)});
        owner = repository.find(owner.rowId);
        String jt = "[{\"time\":\"" + TIME + "\",\"context\":\"" + raw
                + "\",\"displayContext\":\"Shared source text\",\"jtStatusLabel\":\"已揽件\",\"_pipiStatusSource\":\"jt_h5\"}]";
        ExpressQueryResult result = new ExpressQueryResult(owner.waybill, "JTSD", "Synthetic carrier",
                StatusSemantic.PICKED, ExpressTimeline.parseTime(TIME), TIME, raw, jt, "", PHONE,
                TimelineSlot.JT_H5, "", "", "").withManualStatusEvidence("", true);
        var candidate = new ManualTimelineAuthorityPolicy.Candidate(TimelineSlot.JT_H5, result, 200L, true);
        var project = ExpressRepository.class.getDeclaredMethod("projectManualTimelineProjection",
                ExpressItem.class, ManualTimelineAuthorityPolicy.Candidate.class,
                ManualTimelineAuthorityPolicy.Candidate.class, ManualTimelineAuthorityPolicy.Candidate.class);
        project.setAccessible(true);
        Object projection = project.invoke(null, owner, candidate, null, candidate);
        var item = projection.getClass().getDeclaredField("item"); item.setAccessible(true);
        ExpressItem shown = (ExpressItem) item.get(projection);
        assertEquals(raw, shown.latestDetail);
        assertTrue(shown.tracksJson.contains("displayContext"));
        assertEquals(raw, ExpressTimeline.displayHeadline(shown));
    }

    @Test public void cainiaoH5IncrementsItsOwnSlotWithoutChangingFeedOrOtherSources() {
        ExpressItem owner = owner("CNSLOT000001", "CaiNiao", "interface5", false);
        ExpressQueryResult original = repository.automaticSourceTimeline(owner);
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(owner);
        assertTrue(repository.saveAutomaticDetailTimeline(owner, claim,
                h5(owner.waybill, TimelineSlot.CN_H5, "已揽收"), false));
        assertTrue(repository.saveAutomaticDetailTimeline(owner, claim,
                h5(owner.waybill, TimelineSlot.CN_H5, "第二条轨迹"), true));
        ManualTimelineAuthorityPolicy.Candidate saved = repository.manualTimelineCandidate(owner, TimelineSlot.CN_H5);
        assertNotNull(saved);
        assertTrue(saved.complete);
        assertEquals(2, ExpressTimeline.parse(saved.result.tracksJson, "", "").size());
        assertNull(repository.manualTimelineCandidate(owner, TimelineSlot.JD_H5));
        assertEquals(original.tracksJson, repository.automaticSourceTimeline(owner).tracksJson);
        assertEquals(original.semantic, repository.find(owner.rowId).sourceSemantic);
        assertEquals(original.statusEventTime, repository.find(owner.rowId).statusEventTime);
        assertEquals(original.latestDetail, repository.find(owner.rowId).latestDetail);
        assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
    }

    @Test public void projectedJdOwnerAcceptsOnlyItsRealWaybillAndKeepsFeedAuthority() {
        ExpressItem owner = owner("JDORDER000001", "JingDong", "interface5", true);
        assertTrue(repository.saveOrderProjection(owner, "interface5", "JDREAL000001", "京东快递"));
        owner = repository.find(owner.rowId);
        ExpressQueryResult feed = repository.automaticSourceTimeline(owner);
        assertNotNull(feed);
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(owner);
        assertTrue(repository.ownsManualQuery(owner, claim));
        assertTrue(repository.saveAutomaticDetailTimeline(owner, claim,
                h5("JDREAL000001", TimelineSlot.JD_H5, "已揽收"), true));
        assertFalse(repository.saveAutomaticDetailTimeline(owner, claim,
                h5("JDOTHER000001", TimelineSlot.JD_H5, "另一票"), true));
        assertEquals("JDREAL000001", repository.find(owner.rowId).displayWaybill());
        assertEquals(feed.tracksJson, repository.automaticSourceTimeline(owner).tracksJson);
        assertEquals(feed.latestDetail, repository.find(owner.rowId).latestDetail);
        assertEquals(feed.statusEventTime, repository.find(owner.rowId).statusEventTime);
        assertEquals(TimelineSlot.JD_H5, repository.manualDetailTimelineAuthority(owner).provider);
    }

    @Test public void partialJdCaptureProjectsIdentityButDoesNotPersistItsTimeline() {
        ExpressItem owner = owner("JDORDER000002", "JingDong", "interface5", true);
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(owner);
        assertTrue(repository.saveAutomaticDetailTimeline(owner, claim,
                h5("JDREAL000002", TimelineSlot.JD_H5, "部分轨迹"), false));
        ExpressItem projected = repository.find(owner.rowId);
        assertEquals("JDREAL000002", projected.displayWaybill());
        assertNull(repository.manualTimelineCandidate(projected, TimelineSlot.JD_H5));
        assertTrue(repository.saveAutomaticDetailTimeline(projected,
                repository.captureManualQueryOwner(projected),
                h5("JDREAL000002", TimelineSlot.JD_H5, "完整包轨迹"), true));
        assertFalse(repository.manualTimelineCandidate(projected, TimelineSlot.JD_H5)
                .result.tracksJson.contains("部分轨迹"));
    }

    @Test public void completeJdCapturesAccumulateButLaterPartialAddsNothing() {
        ExpressItem owner = owner("JDORDER000006", "JingDong", "interface5", true);
        assertTrue(repository.saveAutomaticDetailTimeline(owner,
                repository.captureManualQueryOwner(owner),
                h5("JDREAL000006", TimelineSlot.JD_H5, "第一轮完整轨迹"), true));
        ExpressItem projected = repository.find(owner.rowId);
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(projected);
        assertTrue(repository.saveAutomaticDetailTimeline(projected, claim,
                h5("JDREAL000006", TimelineSlot.JD_H5, "第二轮完整轨迹"), true));
        assertTrue(repository.saveAutomaticDetailTimeline(projected, claim,
                h5("JDREAL000006", TimelineSlot.JD_H5, "后来的部分轨迹"), false));
        ManualTimelineAuthorityPolicy.Candidate saved = repository.manualTimelineCandidate(projected, TimelineSlot.JD_H5);
        assertTrue(saved.complete);
        assertEquals(2, ExpressTimeline.parse(saved.result.tracksJson, "", "").size());
        assertTrue(saved.result.tracksJson.contains("第一轮完整轨迹"));
        assertTrue(saved.result.tracksJson.contains("第二轮完整轨迹"));
        assertFalse(saved.result.tracksJson.contains("后来的部分轨迹"));
    }

    @Test public void initialJdProjectionPublishesOnceWithBothIdentityAndTimelineCommitted() {
        ExpressItem owner = owner("JDORDER000007", "JingDong", "interface5", true);
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        AtomicInteger changes = new AtomicInteger();
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context ignored, Intent intent) {
                ExpressItem committed = repository.find(owner.rowId);
                assertEquals("JDREAL000007", committed.displayWaybill());
                assertNotNull(repository.manualTimelineCandidate(committed, TimelineSlot.JD_H5));
                assertFalse(database.getWritableDatabase().inTransaction());
                changes.incrementAndGet();
            }
        };
        context.registerReceiver(receiver, new IntentFilter(ExpressRepository.ACTION_CHANGED),
                Context.RECEIVER_NOT_EXPORTED);
        try {
            assertTrue(repository.saveAutomaticDetailTimeline(owner,
                    repository.captureManualQueryOwner(owner),
                    h5("JDREAL000007", TimelineSlot.JD_H5, "完整轨迹"), true));
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertEquals(1, changes.get());
            assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
        } finally {
            context.unregisterReceiver(receiver);
        }
    }

    @Test public void failedH5SidecarWriteRollsBackInitialProjectionAndOwnershipIdentity() {
        ExpressItem owner = owner("JDORDER000003", "JingDong", "interface5", true);
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(owner);
        database.getWritableDatabase().execSQL("CREATE TRIGGER reject_h5 BEFORE INSERT ON "
                + ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE
                + " BEGIN SELECT RAISE(ABORT,'Synthetic H5 failure'); END");
        try {
            repository.saveAutomaticDetailTimeline(owner, claim,
                    h5("JDREAL000003", TimelineSlot.JD_H5, "完整包轨迹"), true);
            fail("The projection must roll back with its timeline");
        } catch (SQLException expected) { }
        assertEquals("", repository.find(owner.rowId).projectedWaybill);
        assertEquals(0, count(ExpressDatabase.ORDER_PROJECTION_TABLE));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE));
        assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
        assertTrue(repository.ownsManualQuery(owner, claim));
    }

    @Test public void lateGenerationAndWrongProviderCannotWriteAnyH5Slot() {
        ExpressItem owner = owner("CNSLOT000002", "CaiNiao", "interface5", false);
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(owner);
        assertFalse(repository.saveAutomaticDetailTimeline(owner, claim,
                h5(owner.waybill, TimelineSlot.JD_H5, "错误来源"), true));
        ContentValues changed = new ContentValues();
        changed.put("uuid", "synthetic-new-generation");
        database.getWritableDatabase().update(ExpressDatabase.PHONE_TABLE, changed, "phone=?",
                new String[]{PHONE});
        assertFalse(repository.ownsManualQuery(owner, claim));
        assertFalse(repository.saveAutomaticDetailTimeline(owner, claim,
                h5(owner.waybill, TimelineSlot.CN_H5, "迟到轨迹"), true));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE));
    }

    @Test public void deletedOwnerClaimCannotWriteIntoRecreatedParcel() {
        ExpressItem original = owner("CNRECREATE000001", "CaiNiao", "interface5", false);
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(original);
        repository.delete(original.rowId);
        ExpressItem recreated = owner(original.waybill, "CaiNiao", "interface5", false);
        assertNotEquals(original.rowId, recreated.rowId);
        assertFalse(repository.ownsManualQuery(original, claim));
        assertFalse(repository.ownsManualQuery(recreated, claim));
        assertFalse(repository.saveAutomaticDetailTimeline(original, claim,
                h5(original.waybill, TimelineSlot.CN_H5, "删除前的迟到结果"), true));
        assertNull(repository.manualTimelineCandidate(recreated, TimelineSlot.CN_H5));
    }

    @Test public void accountQuerySidecarParticipatesInDetailWithoutMergingFeedIntoIt() {
        ExpressItem owner = owner("CNQUERY000001", "CaiNiao", "interface5", false);
        ExpressQueryResult query = h5(owner.waybill, TimelineSlot.V5_QUERY, "已揽收");
        saveOwnedAccountQuery(owner, query);
        ManualTimelineAuthorityPolicy.Candidate detail = repository.manualDetailTimelineAuthority(owner);
        assertNotNull(detail);
        assertEquals(TimelineSlot.V5_QUERY, detail.provider);
        assertEquals(query.tracksJson, detail.result.tracksJson);
        assertFalse(detail.result.tracksJson.contains("feed运输中"));
        assertEquals("feed运输中", repository.find(owner.rowId).latestDetail);
    }

    @Test public void shunFengFreshEligiblePackageCanReplaceAnOldStickyDetail() {
        ExpressItem owner = owner("SFFRESH000001", "ShunFeng", "interface5", false);
        ExpressQueryResult old = detailPackage(owner.waybill, TimelineSlot.V6_QUERY,
                TIME, true);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, old, 100L, true)),
                PHONE, "interface5");
        repository.rememberDetailSelection(owner, TimelineSlot.V6_QUERY);
        ExpressQueryResult fresh = detailPackage(owner.waybill, TimelineSlot.K100_H5,
                "2026-09-10 10:00:00", true);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.K100_H5, fresh, 200L, true)),
                PHONE, "interface5");

        ManualTimelineAuthorityPolicy.Candidate selected = repository.manualDetailTimelineAuthority(owner);
        assertNotNull(selected);
        assertEquals(TimelineSlot.K100_H5, selected.provider);
        assertEquals(fresh.tracksJson, selected.result.tracksJson);
        assertEquals(old.tracksJson, repository.manualTimelineCandidate(owner, TimelineSlot.V6_QUERY)
                .result.tracksJson);
        assertEquals(TIME, repository.automaticSourceTimeline(owner).latestTime);
    }

    /**
     * 夹具时间整体平移到最近（用户 2026-09-24 采纳，只改测试）：签收件在列表里只留 14 天，写死的 09-10 01:50
     * 在 09-24 01:50 过期后 listVisible 找不到这一行，这条测试就一直挂着。最新的夹具时间落在一小时前，feed
     * 与各包之间的相对间隔不变。
     */
    @Test public void shunFengCompleteK100StaysSelectedWhileUnknownHeadlineAlignsToOnlineStatus() throws Exception {
        long shift = System.currentTimeMillis() / 1000L * 1000L - 3_600_000L
                - ExpressSourcePolicy.parseEventTime("2026-09-10 01:50:00");
        java.util.function.UnaryOperator<String> at = fixed -> shifted(fixed, shift);
        ExpressItem owner = owner("SFSHARE4271", "ShunFeng", "interface5", false, at.apply(TIME));
        ExpressQueryResult online = onlineEvent(owner.waybill, at.apply("2026-09-10 01:05:00"));
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, online, 100L, false)),
                PHONE, "interface5");
        repository.rememberDetailSelection(owner, TimelineSlot.V6_QUERY);
        org.json.JSONArray nodes = new org.json.JSONArray();
        nodes.put(new org.json.JSONObject().put("time", at.apply("2026-09-10 01:50:00"))
                .put("context", "K100 latest event"));
        for (int i = 0; i < 16; i++) nodes.put(new org.json.JSONObject()
                .put("time", at.apply(String.format(java.util.Locale.ROOT, "2026-09-09 %02d:00:00", i)))
                .put("context", i == 0 ? "已揽收" : "K100 history " + i));
        ExpressQueryResult complete = new ExpressQueryResult(owner.waybill, "SF", "SF Express",
                StatusSemantic.UNKNOWN, 0L, at.apply("2026-09-10 01:50:00"), "K100 latest event",
                nodes.toString(), "", PHONE, TimelineSlot.K100_H5, "", "", "");
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.K100_H5, complete, 200L, true)),
                PHONE, "interface5");

        assertSharedK100Presentation(owner, complete, online, online);
        ExpressQueryResult laterPartial = onlineEvent(owner.waybill, at.apply("2026-09-10 01:06:00"));
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, laterPartial, 300L, false)),
                PHONE, "interface5");
        assertSharedK100Presentation(owner, complete, laterPartial, laterPartial);
        assertEquals(2, ExpressTimeline.parse(repository.manualTimelineCandidate(owner,
                TimelineSlot.V6_QUERY).result.tracksJson, "", "").size());
        assertEquals(17, ExpressTimeline.parse(repository.manualTimelineCandidate(owner,
                TimelineSlot.K100_H5).result.tracksJson, "", "").size());
        assertEquals(at.apply(TIME), repository.automaticSourceTimeline(owner).latestTime);
        ManualTimelineAuthorityPolicy.Candidate polling = repository.manualTimelineAuthority(owner);
        assertEquals(TimelineSlot.V6_QUERY, polling.provider);
        assertEquals(300L, polling.successAt);
        assertFalse(ExpressRepository.manualTimelinePollDue(owner, polling,
                300L + ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS - 1L));
        assertTrue(ExpressRepository.manualTimelinePollDue(owner, polling,
                300L + ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS));

        String signedAt = at.apply("2026-09-10 01:07:00");
        ExpressQueryResult signed = new ExpressQueryResult(owner.waybill, "SF", "SF Express",
                StatusSemantic.COMPLETED, ExpressSourcePolicy.parseEventTime(signedAt), signedAt,
                "Delivered event", "[{\"time\":\"" + signedAt + "\",\"context\":\"Delivered event\"}]",
                "", PHONE, TimelineSlot.V6_QUERY, "", "", "")
                .withManualStatusEvidence("Delivered", true);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, signed, 400L, false)),
                PHONE, "interface5");
        assertSharedK100Presentation(owner, complete, signed, signed);
        ExpressQueryResult laterDelivery = onlineEvent(owner.waybill, at.apply("2026-09-10 01:08:00"));
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY,
                        laterDelivery, 500L, false)),
                PHONE, "interface5");
        // Its node has no enum and is within five minutes of S; the newer donor does not roll S back.
        assertSharedK100Presentation(owner, complete, signed, laterDelivery);
        assertTrue(ExpressRepository.manualTimelinePollDue(repository.find(owner.rowId),
                repository.manualTimelineAuthority(owner),
                500L + ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS));
        assertFalse(ExpressRepository.manualTimelinePollDue(repository.find(owner.rowId),
                repository.manualTimelineAuthority(owner),
                ExpressSourcePolicy.parseEventTime(signedAt)));
    }

    @Test public void aKnownSameStateK100HeadlineKeepsItsNewestNodeAndItsOnlineStatusSource() throws Exception {
        long shift = System.currentTimeMillis() / 1000L * 1000L - 3_600_000L
                - ExpressSourcePolicy.parseEventTime("2026-09-10 01:50:00");
        java.util.function.UnaryOperator<String> at = fixed -> shifted(fixed, shift);
        ExpressItem owner = owner("SFSHAREKNOWN4271", "ShunFeng", "interface5", false, at.apply(TIME));
        ExpressQueryResult online = onlineEvent(owner.waybill, at.apply("2026-09-10 01:05:00"));
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, online, 100L, false)),
                PHONE, "interface5");
        org.json.JSONArray nodes = new org.json.JSONArray()
                .put(new org.json.JSONObject().put("time", at.apply("2026-09-10 01:50:00"))
                        .put("context", "K100 latest event").put("statusCode", "5"));
        for (int i = 0; i < 16; i++) nodes.put(new org.json.JSONObject()
                .put("time", at.apply(String.format(java.util.Locale.ROOT, "2026-09-09 %02d:00:00", i)))
                .put("context", i == 0 ? "已揽收" : "K100 history " + i));
        ExpressQueryResult complete = new ExpressQueryResult(owner.waybill, "SF", "SF Express",
                StatusSemantic.UNKNOWN, 0L, at.apply("2026-09-10 01:50:00"), "K100 latest event",
                nodes.toString(), "", PHONE, TimelineSlot.K100_H5, "", "", "");
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.K100_H5, complete, 200L, true)),
                PHONE, "interface5");
        ManualTimelineAuthorityPolicy.Candidate detail = repository.manualDetailTimelineAuthority(owner);
        assertEquals(TimelineSlot.K100_H5, detail.provider);
        assertEquals(17, ExpressTimeline.parse(detail.result.tracksJson, "", "").size());
        for (ExpressItem home : new ExpressItem[]{repository.find(owner.rowId),
                repository.listVisible("interface5").stream()
                        .filter(row -> row.rowId == owner.rowId).findFirst().orElseThrow()}) {
            assertEquals(complete.latestTime, home.latestTime);
            assertEquals(complete.latestDetail, home.latestDetail);
            assertEquals(detail.result.tracksJson, home.tracksJson);
        }
        ExpressQueryResult storedStatus = repository.manualTimelineCandidate(owner, TimelineSlot.V6_QUERY).result;
        assertEquals(online.semantic, storedStatus.semantic);
        assertEquals(online.statusEventTime, storedStatus.statusEventTime);
    }

    @Test public void nonShunFengAutomaticHomeKeepsItsFeedWhenK100IsFuller() {
        for (String provider : new String[]{"CaiNiao", "JingDong", "DouYin"}) {
            ExpressItem owner = owner("NONSFSHARE" + provider, provider, "interface5", false);
            repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                    java.util.List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY,
                            onlineEvent(owner.waybill, "2026-09-10 01:05:00"), 100L, false),
                            new ManualQuerySuccess(TimelineSlot.K100_H5,
                                    detailPackage(owner.waybill, TimelineSlot.K100_H5,
                                            "2026-09-10 01:50:00", true), 200L, true)),
                    PHONE, "interface5");
            ExpressItem home = repository.find(owner.rowId);
            assertEquals("feed运输中", home.latestDetail);
            assertEquals(TIME, home.latestTime);
            assertEquals(StatusSemantic.TRANSIT, home.semantic);
        }
    }

    /**
     * Pipi 1.4.0 parity (user decision 2026-09-17, backlog D-8): a JD-source owner's selected
     * carrier fallback packet is displayed whole with the owner's earlier order-stage nodes behind
     * it, while the selection, the packet cache and the feed cache all keep their own rows.
     */
    @Test public void jdFallbackDisplayKeepsOwnerOrderStageBehindThePacketAndCachesSeparate() {
        String ownerTracks = "[" + node("2026-09-09 10:00:00", "预计9月10日送达")
                + "," + node("2026-09-09 09:22:06", "待出库交付极兔速递，运单号为JDSTAGE000001")
                + "," + node("2026-09-09 08:49:46", "最快9月9日发货")
                + "," + node("2026-09-09 08:49:42", "您的订单已进入第三方卖家仓库，准备出库") + "]";
        ExpressItem owner = stagedOwner("JDSTAGE000001", "JingDong", ownerTracks);
        assertTrue(owner.isJingDongSource());
        ExpressQueryResult packet = new ExpressQueryResult("JDSTAGE000001", "JT", "极兔速递",
                StatusSemantic.TRANSIT, "2026-09-09 09:50:00", "快件运输中",
                "[" + node("2026-09-09 09:50:00", "快件运输中")
                        + "," + node("2026-09-09 09:48:37", "【DK测试网点】已揽收") + "]",
                "", PHONE, TimelineSlot.K100_H5);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.K100_H5, packet, 200L, true)),
                PHONE, "interface5");

        ManualTimelineAuthorityPolicy.Candidate selected = repository.manualDetailTimelineAuthority(owner);
        assertNotNull(selected);
        assertEquals(TimelineSlot.K100_H5, selected.provider);
        assertEquals(packet.tracksJson, selected.result.tracksJson);
        ExpressQueryResult source = repository.automaticSourceTimeline(owner);
        ExpressQueryResult displayed = ManualTimelineAuthorityPolicy.withOwnerOrderStage(owner, source, selected);
        java.util.List<ExpressTimeline.Track> rows = ExpressTimeline.parse(displayed.tracksJson, "", "");
        assertEquals(5, rows.size());
        assertEquals("2026-09-09 09:50:00", rows.get(0).time);
        assertEquals("2026-09-09 09:48:37", rows.get(1).time);
        assertEquals("2026-09-09 09:22:06", rows.get(2).time);
        assertEquals("2026-09-09 08:49:46", rows.get(3).time);
        assertEquals("2026-09-09 08:49:42", rows.get(4).time);
        assertFalse(displayed.tracksJson.contains("预计9月10日送达"));
        assertEquals(packet.latestDetail, displayed.latestDetail);
        assertEquals(TimelineSlot.K100_H5, displayed.timelineProvider);
        // Second read: the raw selection and both caches are untouched by the presentation.
        assertEquals(packet.tracksJson, repository.manualDetailTimelineAuthority(owner).result.tracksJson);
        assertEquals(packet.tracksJson,
                repository.manualTimelineCandidate(owner, TimelineSlot.K100_H5).result.tracksJson);
        assertEquals(4, ExpressTimeline.parse(repository.automaticSourceTimeline(owner).tracksJson, "", "").size());
        assertFalse(repository.automaticSourceTimeline(owner).tracksJson.contains("已揽收"));

        // Other automatic sources and JD H5 packets are shown exactly as selected.
        ExpressItem douyin = stagedOwner("DYSTAGE000001", "DouYin", ownerTracks.replace("JDSTAGE000001", "DYSTAGE000001"));
        assertFalse(douyin.isJingDongSource());
        ManualTimelineAuthorityPolicy.Candidate douyinPacket = new ManualTimelineAuthorityPolicy.Candidate(
                TimelineSlot.K100_H5, packet.withWaybill("DYSTAGE000001"), 200L, true);
        assertSame(douyinPacket.result, ManualTimelineAuthorityPolicy.withOwnerOrderStage(
                douyin, repository.automaticSourceTimeline(douyin), douyinPacket));
        ExpressItem order = owner("JDORDER000009", "JingDong", "interface5", true);
        assertTrue(repository.saveAutomaticDetailTimeline(order, repository.captureManualQueryOwner(order),
                h5("JDREAL000009", TimelineSlot.JD_H5, "已揽收"), true));
        order = repository.find(order.rowId);
        ManualTimelineAuthorityPolicy.Candidate h5Selected = repository.manualDetailTimelineAuthority(order);
        assertEquals(TimelineSlot.JD_H5, h5Selected.provider);
        assertSame(h5Selected.result, ManualTimelineAuthorityPolicy.withOwnerOrderStage(
                order, repository.automaticSourceTimeline(order), h5Selected));
    }

    private ExpressItem stagedOwner(String waybill, String provider, String tracksJson) {
        ExpressQueryResult feed = new ExpressQueryResult(waybill, "JT", "极兔速递", StatusSemantic.TRANSIT,
                ExpressSourcePolicy.parseEventTime("2026-09-09 10:00:00"), "2026-09-09 10:00:00",
                "预计9月10日送达", tracksJson, "", PHONE, "interface5", "", "", provider);
        repository.saveInterface5(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(waybill, "interface5");
        assertNotNull(owner);
        assertNotNull(repository.captureManualQueryOwner(owner));
        return owner;
    }

    private static String node(String time, String context) {
        return "{\"time\":\"" + time + "\",\"context\":\"" + context + "\"}";
    }

    private void assertSharedK100Presentation(ExpressItem owner, ExpressQueryResult complete,
            ExpressQueryResult online, ExpressQueryResult headlineDonor) {
        ManualTimelineAuthorityPolicy.Candidate detail = repository.manualDetailTimelineAuthority(owner);
        assertEquals(TimelineSlot.K100_H5, detail.provider);
        assertEquals(complete.latestTime,
                repository.manualTimelineCandidate(owner, TimelineSlot.K100_H5).result.latestTime);
        assertEquals(complete.latestDetail,
                repository.manualTimelineCandidate(owner, TimelineSlot.K100_H5).result.latestDetail);
        ExpressItem stored = repository.find(owner.rowId);
        assertEquals(complete.latestTime, stored.latestTime);
        assertEquals(complete.latestDetail, stored.latestDetail);
        ExpressItem displayed = repository.listVisible("interface5").stream()
                .filter(row -> row.rowId == owner.rowId).findFirst().orElseThrow();
        // An unknown headline far beyond S uses S's own timed donor, without changing the selected history.
        assertEquals(headlineDonor.latestTime, displayed.latestTime);
        assertEquals(headlineDonor.latestDetail, displayed.latestDetail);
        for (ExpressItem home : new ExpressItem[]{stored, displayed}) {
            assertEquals(TimelineSlot.K100_H5, home.manualTimelineProvider);
            assertEquals(detail.result.tracksJson, home.tracksJson);
            assertEquals(online.semantic, home.semantic);
            assertEquals(online.statusEventTime, home.statusEventTime);
            assertEquals(online.statusDescription, home.statusDescription);
        }
    }

    private static ExpressQueryResult onlineEvent(String waybill, String time) {
        return new ExpressQueryResult(waybill, "SF", "SF Express", StatusSemantic.DELIVERY,
                ExpressSourcePolicy.parseEventTime(time), time, "Online event " + time,
                "[{\"time\":\"" + time + "\",\"context\":\"Online event " + time + "\"}]", "", PHONE,
                TimelineSlot.V6_QUERY, "", "", "")
                .withManualStatusEvidence("Out for delivery", true);
    }

    @Test public void nonShunFengNewerAccountHistorySupersedesStaleStickyPackage() {
        ExpressItem owner = owner("CNFRESH000001", "CaiNiao", "interface5", false);
        ExpressQueryResult old = detailPackage(owner.waybill, TimelineSlot.V6_QUERY, TIME, true);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, old, 100L, true)),
                PHONE, "interface5");
        repository.rememberDetailSelection(owner, TimelineSlot.V6_QUERY);
        saveOwnedAccountQuery(owner, detailPackage(owner.waybill, TimelineSlot.V5_QUERY,
                "2026-09-10 10:00:00", true));
        assertEquals(TimelineSlot.V5_QUERY, repository.manualDetailTimelineAuthority(owner).provider);
    }

    @Test public void shunFengFreshPackageWithoutPickupCannotDisplaceStickyHistory() {
        ExpressItem owner = owner("SFFRESH000002", "ShunFeng", "interface5", false);
        ExpressQueryResult old = detailPackage(owner.waybill, TimelineSlot.V6_QUERY, TIME, true);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, old, 100L, true)),
                PHONE, "interface5");
        repository.rememberDetailSelection(owner, TimelineSlot.V6_QUERY);
        repository.saveAccountTimeline(detailPackage(owner.waybill, TimelineSlot.V5_QUERY,
                "2026-09-10 10:00:00", false), "interface5");
        assertEquals(TimelineSlot.V6_QUERY, repository.manualDetailTimelineAuthority(owner).provider);
    }

    @Test public void shunFengPartialManualOutranksStickyAccountQuery() {
        ExpressItem owner = owner("SFMANUAL000001", "ShunFeng", "interface5", false);
        ExpressQueryResult account = detailPackage(owner.waybill, TimelineSlot.V5_QUERY, TIME, true);
        repository.saveAccountTimeline(account, "interface5");
        repository.rememberDetailSelection(owner, TimelineSlot.V5_QUERY);
        ExpressQueryResult manual = detailPackage(owner.waybill, TimelineSlot.V6_QUERY,
                "2026-09-10 10:00:00", false);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, manual, 200L, false)),
                PHONE, "interface5");

        ManualTimelineAuthorityPolicy.Candidate selected = repository.manualDetailTimelineAuthority(owner);
        assertNotNull(selected);
        assertEquals(TimelineSlot.V6_QUERY, selected.provider);
        assertEquals(manual.tracksJson, selected.result.tracksJson);
        assertEquals(account.tracksJson, repository.accountTimeline(owner.waybill, "interface5").tracksJson);
        repository.rememberDetailSelection(owner, ManualTimelineAuthorityPolicy.PREFERRED_FEED);
        assertEquals(TimelineSlot.V6_QUERY, repository.manualDetailTimelineAuthority(owner).provider);
        assertEquals(manual.latestTime, repository.find(owner.rowId).latestTime);
    }

    @Test public void shunFengStickyFeedYieldsToACompleteFreshPackage() {
        ExpressItem owner = owner("SFFRESH000003", "ShunFeng", "interface5", false);
        repository.rememberDetailSelection(owner, ManualTimelineAuthorityPolicy.PREFERRED_FEED);
        ExpressQueryResult fresh = detailPackage(owner.waybill, TimelineSlot.V5_QUERY,
                "2026-09-10 10:00:00", true);
        saveOwnedAccountQuery(owner, fresh);
        ManualTimelineAuthorityPolicy.Candidate selected = repository.manualDetailTimelineAuthority(owner);
        assertNotNull(selected);
        assertEquals(TimelineSlot.V5_QUERY, selected.provider);
    }

    private void saveOwnedAccountQuery(ExpressItem owner, ExpressQueryResult result) {
        ExpressQueryResult raw = new ExpressQueryResult(result.waybill, result.courierCode,
                result.companyName, result.semantic, result.statusEventTime, result.latestTime,
                result.latestDetail, result.tracksJson, result.detailUrl, owner.phone,
                TimelineSlot.V5_QUERY, "", "", owner.sourceProvider)
                .withManualStatusEvidence(result.statusDescription, result.structuredStatusEvidence);
        assertTrue(repository.saveInterface5Query(raw, owner,
                repository.bindingGeneration(owner.phone, "interface5")));
    }

    private static ExpressQueryResult detailPackage(String waybill, String provider,
            String latest, boolean pickup) {
        return new ExpressQueryResult(waybill, "SF", "顺丰速运", StatusSemantic.TRANSIT,
                latest, "运输中", "[{\"time\":\"" + latest + "\",\"context\":\"运输中\"},"
                + "{\"time\":\"2026-09-09 09:00:00\",\"context\":\""
                + (pickup ? "已揽收" : "运输中") + "\"}]", "", PHONE, provider);
    }

    @Test public void recoveredRouteUpdatesOnlyTheMatchingSourceRouteAtom() {
        for (String binding : new String[]{"interface5", "interface6"}) {
            ExpressItem owner = owner("CNROUTE" + binding, "CaiNiao", binding, false);
            ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(owner);
            String iface = binding.equals("interface5") ? "v5" : "v6";
            String route = "https://page.cainiao.com/detail?secretkey=synthetic-route&from=" + binding;
            ExpressQueryResult recovery = route(owner, binding, iface, route);
            assertTrue(repository.saveRecoveredOwnerRoute(owner, claim, recovery));
            ExpressItem after = repository.find(owner.rowId);
            assertEquals(route, after.routeCredential);
            assertEquals(CainiaoRoute.token(iface), after.detailUrl);
            assertEquals(owner.latestDetail, after.latestDetail);
            assertEquals(owner.latestTime, after.latestTime);
            assertEquals(owner.statusEventTime, after.statusEventTime);
            assertEquals(owner.updatedAt, after.updatedAt);
            assertEquals(owner.tracksJson, after.tracksJson);
            assertEquals(owner.sourceSemantic, after.sourceSemantic);
            assertTrue(text(owner.rowId, "routeCredential").startsWith("enc:v1:"));
            String foreign = iface.equals("v5") ? "v6" : "v5";
            assertFalse(repository.saveRecoveredOwnerRoute(owner, claim, route(owner, binding, foreign, route)));
            assertFalse(repository.saveRecoveredOwnerRoute(owner, claim,
                    route(owner, binding, iface, "https://example.invalid/?secretkey=synthetic")));
        }
    }

    @Test public void routeRecoveryRejectsExpiredGenerationAndUnsupportedInterface6Jd() {
        ExpressItem cainiao = owner("CNROUTE000001", "CaiNiao", "interface5", false);
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(cainiao);
        ContentValues changed = new ContentValues();
        changed.put("uuid", "synthetic-route-generation");
        database.getWritableDatabase().update(ExpressDatabase.PHONE_TABLE, changed,
                "phone=?", new String[]{PHONE});
        assertFalse(repository.saveRecoveredOwnerRoute(cainiao, claim,
                route(cainiao, "interface5", "v5", "https://page.cainiao.com/detail?secretkey=synthetic")));
        assertEquals("", repository.find(cainiao.rowId).routeCredential);
        ExpressItem unsupported = owner("JDROUTE000001", "JingDong", "interface6", false);
        assertFalse(repository.saveRecoveredOwnerRoute(unsupported,
                repository.captureManualQueryOwner(unsupported),
                route(unsupported, "interface6", "v6", "https://un.m.jd.com/synthetic")));
        assertEquals("", repository.find(unsupported.rowId).routeCredential);
    }

    @Test public void queryTextProjectionAndBothQueryKeysCommitTogether() {
        ExpressItem owner = owner("JDORDER000004", "JingDong", "interface5", true);
        ExpressQueryResult query = new ExpressQueryResult(owner.waybill, "JD", "京东快递",
                StatusSemantic.PICKED, ExpressSourcePolicy.parseEventTime(TIME), TIME,
                "运单号为JDREAL000004", tracks("运单号为JDREAL000004"), "", PHONE,
                TimelineSlot.V5_QUERY, "", "", "JingDong");
        assertTrue(repository.saveInterface5Query(query, owner,
                repository.bindingGeneration(PHONE, "interface5")));
        ExpressItem projected = repository.find(owner.rowId);
        assertEquals("JDREAL000004", projected.displayWaybill());
        assertNotNull(repository.accountTimeline(owner.waybill, "interface5"));
        assertNotNull(repository.accountTimeline(projected.displayWaybill(), "interface5"));
        assertEquals("feed运输中", projected.latestDetail);
        assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
    }

    /**
     * 用户 2026-09-26（其余裁决 7，iOS 与 Lite 同）：小米轨迹文案只取运单号。「…交付极兔速递，运单号为…」投影出
     * 运单号，承运商留空——不从文案里取，交给内置表 → K100 免费识别 → 既有付费兜底。
     */
    @Test public void orderTextProjectsTheWaybillButNeverTheCarrierItNames() {
        ExpressItem owner = owner("JDORDER000009", "JingDong", "interface5", true);
        String text = "您的订单由第三方卖家拣货完成，待出库交付极兔速递，运单号为JT4006839564547";
        ExpressQueryResult query = new ExpressQueryResult(owner.waybill, "JD", "京东快递",
                StatusSemantic.PICKED, ExpressSourcePolicy.parseEventTime(TIME), TIME,
                text, tracks(text), "", PHONE, TimelineSlot.V5_QUERY, "", "", "JingDong");
        assertTrue(repository.saveInterface5Query(query, owner,
                repository.bindingGeneration(PHONE, "interface5")));
        ExpressItem projected = repository.find(owner.rowId);
        assertEquals("JT4006839564547", projected.displayWaybill());
        assertEquals("", projected.projectedCompanyName);
        assertNull("the carrier named by the text is not carrier evidence", projected.resolvedCarrier());
        assertTrue("the projected waybill goes to carrier recognition",
                me.pipi.deliveries.background.AccountCarrierRecognition.needsRecognition(projected));
    }

    @Test public void querySidecarFailureRollsBackTextProjection() {
        ExpressItem owner = owner("JDORDER000005", "JingDong", "interface5", true);
        ExpressQueryResult query = new ExpressQueryResult(owner.waybill, "JD", "京东快递",
                StatusSemantic.PICKED, ExpressSourcePolicy.parseEventTime(TIME), TIME,
                "运单号为JDREAL000005", tracks("运单号为JDREAL000005"), "", PHONE,
                TimelineSlot.V5_QUERY, "", "", "JingDong");
        database.getWritableDatabase().execSQL("CREATE TRIGGER reject_query BEFORE INSERT ON "
                + ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE
                + " BEGIN SELECT RAISE(ABORT,'Synthetic query failure'); END");
        try {
            repository.saveInterface5Query(query, owner, repository.bindingGeneration(PHONE, "interface5"));
            fail("Query projection cannot outlive a failed sidecar write");
        } catch (SQLException expected) { }
        assertEquals("", repository.find(owner.rowId).projectedWaybill);
        assertEquals(0, count(ExpressDatabase.ORDER_PROJECTION_TABLE));
        assertEquals(0, count(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE));
    }

    @Test public void queryStartedBeforeAnotherProjectionCannotContaminateItsCaches() {
        ExpressItem requestedOwner = owner("JDORDER000008", "JingDong", "interface5", true);
        String generation = repository.bindingGeneration(PHONE, "interface5");
        ExpressQueryResult first = new ExpressQueryResult(requestedOwner.waybill, "JD", "京东快递",
                StatusSemantic.PICKED, ExpressSourcePolicy.parseEventTime(TIME), TIME,
                "运单号为JDREAL000008A", tracks("运单号为JDREAL000008A"), "", PHONE,
                TimelineSlot.V5_QUERY, "", "", "JingDong");
        assertTrue(repository.saveInterface5Query(first, requestedOwner, generation));
        String orderCache = repository.accountTimeline(requestedOwner.waybill, "interface5").tracksJson;
        String waybillCache = repository.accountTimeline("JDREAL000008A", "interface5").tracksJson;

        ExpressQueryResult late = new ExpressQueryResult(requestedOwner.waybill, "JD", "京东快递",
                StatusSemantic.PICKED, ExpressSourcePolicy.parseEventTime(TIME), TIME,
                "运单号为JDREAL000008B", tracks("运单号为JDREAL000008B"), "", PHONE,
                TimelineSlot.V5_QUERY, "", "", "JingDong");
        assertFalse(repository.saveInterface5Query(late, requestedOwner, generation));
        assertEquals("JDREAL000008A", repository.find(requestedOwner.rowId).displayWaybill());
        assertEquals(orderCache, repository.accountTimeline(requestedOwner.waybill, "interface5").tracksJson);
        assertEquals(waybillCache, repository.accountTimeline("JDREAL000008A", "interface5").tracksJson);
        assertNull(repository.accountTimeline("JDREAL000008B", "interface5"));
    }

    @Test public void v5EmptyTimelineCanUseEligibleSavedDetailWithoutChangingFeedStatus() {
        for (String provider : new String[]{"CaiNiao", "JingDong", "DouYin"}) {
            ExpressItem owner = emptyOwner("EMPTYDETAIL" + provider, provider, "interface5");
            ExpressItem before = repository.find(owner.rowId);
            ExpressRepository.ManualTimelinePollClaim poll =
                    repository.claimManualTimelinePoll(before, System.currentTimeMillis());
            assertNotNull(provider, poll);
            repository.releaseManualTimelinePoll(poll);
            if (provider.equals("CaiNiao")) {
                assertTrue(repository.activateCainiaoManualFallback(owner,
                        repository.captureManualQueryOwner(owner)));
            }
            ExpressQueryResult complete = detailPackage(owner.waybill, TimelineSlot.K100_H5,
                    "2026-09-10 01:50:00", true);
            assertNotNull(repository.saveOwnerManualQueryBatch(owner,
                    repository.captureManualQueryOwner(owner), java.util.List.of(
                            new ManualQuerySuccess(TimelineSlot.K100_H5, complete, 200L, true)),
                    PHONE, "interface5"));
            ExpressItem saved = repository.find(owner.rowId);
            assertEquals(provider, complete.latestDetail, saved.latestDetail);
            assertEquals(complete.latestTime, saved.latestTime);
            assertEquals(complete.tracksJson, saved.tracksJson);
            assertEquals(before.semantic, saved.semantic);
            assertEquals(before.statusEventTime, saved.statusEventTime);
            assertEquals(before.statusDescription, saved.statusDescription);
            assertEquals("[]", repository.automaticSourceTimeline(owner).tracksJson);
            assertNull(repository.claimManualTimelinePoll(saved,
                    System.currentTimeMillis() + ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS));
            ExpressItem reloaded = new ExpressRepository(context, database).listVisible("interface5")
                    .stream().filter(row -> row.rowId == owner.rowId).findFirst().orElseThrow();
            assertEquals(saved.tracksJson, reloaded.tracksJson);
        }
    }

    @Test public void v5KnownStatusWithOneTimedNodeDoesNotNeedListOnline() {
        ExpressItem owner = owner("ONETIMEDJD", "JingDong", "interface5", false);
        assertNull(repository.claimManualTimelinePoll(owner, System.currentTimeMillis()));
        ExpressItem otherInterface = emptyOwner("EMPTYV6", "CaiNiao", "interface6");
        assertNull(repository.claimManualTimelinePoll(otherInterface, System.currentTimeMillis()));
        ExpressItem unprojected = owner("EMPTYORDER", "JingDong", "interface5", true);
        assertNull(repository.claimManualTimelinePoll(unprojected, System.currentTimeMillis()));
    }

    @Test public void missingStatusUsesCachedStructuredEvidenceWithoutReplacingFeedTracks() {
        ExpressItem owner = owner("STATUSONLYV5", "DouYin", "interface5", false);
        ContentValues unknown = new ContentValues();
        unknown.put("logsiticsStatus", StatusSemantic.UNKNOWN.storageCode);
        unknown.put("logisticsStatusDesc", "");
        unknown.put("statusEventTime", 0L);
        database.getWritableDatabase().update(ExpressDatabase.EXPRESS_TABLE,
                unknown, "_id=?", new String[]{Long.toString(owner.rowId)});
        owner = repository.find(owner.rowId);
        assertEquals(StatusSemantic.UNKNOWN, owner.semantic);
        assertTrue(ExpressRepository.automaticListQueryRequired(owner));
        long now = System.currentTimeMillis();
        ExpressRepository.ManualTimelinePollClaim first = repository.claimManualTimelinePoll(owner, now);
        assertNotNull(first);
        assertNull(repository.claimManualTimelinePoll(owner, now + 1L));
        repository.releaseManualTimelinePoll(first);
        String feedTracks = owner.tracksJson;
        String feedHeadline = owner.latestDetail;
        ExpressQueryResult donor = onlineEvent(owner.waybill, "2026-09-10 01:05:00");
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, donor, now, false)),
                PHONE, "interface5");
        ExpressItem saved = repository.find(owner.rowId);
        assertEquals(StatusSemantic.DELIVERY, saved.semantic);
        assertEquals(donor.statusEventTime, saved.statusEventTime);
        assertEquals(feedTracks, saved.tracksJson);
        assertEquals(feedHeadline, saved.latestDetail);
        assertFalse(ExpressRepository.automaticListQueryRequired(saved));
    }

    @Test public void signedEmptyV5ListRequiresStructuredCompletionToFreeze() throws Exception {
        ExpressItem owner = emptyOwner("FROZENEMPTYV5", "CaiNiao", "interface5");
        ContentValues signed = new ContentValues();
        signed.put("logsiticsStatus", StatusSemantic.COMPLETED.storageCode);
        signed.put("logisticsStatusDesc", "Delivered");
        signed.put("statusEventTime", ExpressSourcePolicy.parseEventTime(TIME));
        database.getWritableDatabase().update(ExpressDatabase.EXPRESS_TABLE,
                signed, "_id=?", new String[]{Long.toString(owner.rowId)});
        long now = System.currentTimeMillis();
        ExpressRepository.ManualTimelinePollClaim untrusted = repository.claimManualTimelinePoll(
                repository.find(owner.rowId), now);
        assertNotNull(untrusted);
        repository.releaseManualTimelinePoll(untrusted);
        signed.put("packageDyn", WorkerStatusProjection.attach("[]", WorkerStatusProjection.read(
                new org.json.JSONObject().put("normalizedStatus", new org.json.JSONObject()
                        .put("version", 1).put("scope", "SHIPMENT").put("semantic", "COMPLETED")
                        .put("code", "SERVER_ENUM").put("text", "Delivered").put("priority", 0)
                        .put("eventAtMs", ExpressSourcePolicy.parseEventTime(TIME))
                        .put("structured", true)))));
        database.getWritableDatabase().update(ExpressDatabase.EXPRESS_TABLE,
                signed, "_id=?", new String[]{Long.toString(owner.rowId)});
        assertNull(repository.claimManualTimelinePoll(repository.find(owner.rowId),
                now + ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS));
    }

    @Test public void cachedDetailFillsTracksButKeepsAnExistingUntimedFeedHeadline() {
        ExpressItem owner = emptyOwner("HEADLINEONLYV5", "CaiNiao", "interface5");
        ContentValues headline = new ContentValues();
        headline.put("lastLogisticDetail", "Original source headline");
        database.getWritableDatabase().update(ExpressDatabase.EXPRESS_TABLE,
                headline, "_id=?", new String[]{Long.toString(owner.rowId)});
        owner = repository.find(owner.rowId);
        ExpressQueryResult detail = h5(owner.waybill, TimelineSlot.CN_H5, "Saved detail event");
        assertTrue(repository.saveAutomaticDetailTimeline(owner,
                repository.captureManualQueryOwner(owner), detail, true));
        ExpressItem saved = repository.find(owner.rowId);
        assertEquals("Original source headline", saved.latestDetail);
        assertEquals("", saved.latestTime);
        assertEquals(detail.tracksJson, saved.tracksJson);
        assertFalse(ExpressRepository.automaticListQueryRequired(saved));
        assertEquals("[]", repository.automaticSourceTimeline(owner).tracksJson);
    }

    private ExpressItem emptyOwner(String id, String provider, String binding) {
        ExpressItem owner = owner(id, provider, binding, false);
        ContentValues empty = new ContentValues();
        empty.put("packageDyn", "[]");
        empty.put("lastLogisticDetail", "");
        empty.put("logisticsGmtModified", "");
        database.getWritableDatabase().update(ExpressDatabase.EXPRESS_TABLE,
                empty, "_id=?", new String[]{Long.toString(owner.rowId)});
        database.getWritableDatabase().delete(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE,
                "normalized_waybill=?", new String[]{ExpressSourcePolicy.normalizeWaybill(id)});
        return repository.find(owner.rowId);
    }

    private ExpressItem owner(String id, String provider, String binding, boolean order) {
        return owner(id, provider, binding, order, TIME);
    }
    private ExpressItem owner(String id, String provider, String binding, boolean order, String time) {
        ExpressQueryResult feed = new ExpressQueryResult(id, order ? "JD" : "ZTO",
                order ? "京东快递" : "中通快递", StatusSemantic.TRANSIT,
                ExpressSourcePolicy.parseEventTime(time), time, "feed运输中", tracks("feed运输中", time),
                "", PHONE, binding, "", "", provider);
        if (order) repository.saveInterface5OrderSummary(feed, PHONE);
        else if (binding.equals("interface5")) repository.saveInterface5(feed, PHONE);
        else repository.saveInterface6(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(id, binding);
        assertNotNull(owner);
        assertNotNull(repository.captureManualQueryOwner(owner));
        return owner;
    }
    private static ExpressQueryResult h5(String id, String provider, String detail) {
        return new ExpressQueryResult(id, "JD", "京东快递", StatusSemantic.UNKNOWN,
                0L, TIME, detail, tracks(detail), "", "", provider, "", "", "");
    }
    private static ExpressQueryResult route(ExpressItem owner, String binding, String iface, String route) {
        return new ExpressQueryResult(owner.waybill, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                1L, "2000-01-01 00:00:00", "unrelated query status", "[]", CainiaoRoute.token(iface),
                PHONE, TimelineSlot.forBindingSource(binding), iface, route, owner.sourceProvider);
    }
    private static String tracks(String detail) {
        return tracks(detail, TIME);
    }
    private static String tracks(String detail, String time) {
        return "[{\"time\":\"" + time + "\",\"context\":\"" + detail + "\"}]";
    }
    /** A fixture time moved by {@code shiftMs}, in the same Asia/Shanghai wall clock the parser reads. */
    private static String shifted(String fixed, long shiftMs) {
        java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.ROOT);
        format.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Shanghai"));
        return format.format(new java.util.Date(ExpressSourcePolicy.parseEventTime(fixed) + shiftMs));
    }
    private String text(long id, String column) {
        try (Cursor cursor = database.getReadableDatabase().query(ExpressDatabase.EXPRESS_TABLE,
                new String[]{column}, "_id=?", new String[]{Long.toString(id)}, null, null, null)) {
            assertTrue(cursor.moveToFirst()); return cursor.getString(0);
        }
    }
    private int count(String table) {
        try (Cursor cursor = database.getReadableDatabase().rawQuery("SELECT COUNT(*) FROM " + table, null)) {
            assertTrue(cursor.moveToFirst()); return cursor.getInt(0);
        }
    }
}
