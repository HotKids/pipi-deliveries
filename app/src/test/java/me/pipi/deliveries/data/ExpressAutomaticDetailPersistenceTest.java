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
        repository.saveAccountTimeline(query, "interface5");
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

    @Test public void shunFengHomeAndDetailKeepCompleteK100AfterLaterOnlinePartial() throws Exception {
        ExpressItem owner = owner("SFSHARE4271", "ShunFeng", "interface5", false);
        ExpressQueryResult online = onlineEvent(owner.waybill, "2026-09-10 01:05:00");
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, online, 100L, false)),
                PHONE, "interface5");
        repository.rememberDetailSelection(owner, TimelineSlot.V6_QUERY);
        org.json.JSONArray nodes = new org.json.JSONArray();
        nodes.put(new org.json.JSONObject().put("time", "2026-09-10 01:50:00")
                .put("context", "K100 latest event"));
        for (int i = 0; i < 16; i++) nodes.put(new org.json.JSONObject()
                .put("time", String.format(java.util.Locale.ROOT, "2026-09-09 %02d:00:00", i))
                .put("context", i == 0 ? "已揽收" : "K100 history " + i));
        ExpressQueryResult complete = new ExpressQueryResult(owner.waybill, "SF", "SF Express",
                StatusSemantic.UNKNOWN, 0L, "2026-09-10 01:50:00", "K100 latest event",
                nodes.toString(), "", PHONE, TimelineSlot.K100_H5, "", "", "");
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.K100_H5, complete, 200L, true)),
                PHONE, "interface5");

        assertSharedK100Presentation(owner, complete, online);
        ExpressQueryResult laterPartial = onlineEvent(owner.waybill, "2026-09-10 01:06:00");
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, laterPartial, 300L, false)),
                PHONE, "interface5");
        assertSharedK100Presentation(owner, complete, laterPartial);
        assertEquals(2, ExpressTimeline.parse(repository.manualTimelineCandidate(owner,
                TimelineSlot.V6_QUERY).result.tracksJson, "", "").size());
        assertEquals(17, ExpressTimeline.parse(repository.manualTimelineCandidate(owner,
                TimelineSlot.K100_H5).result.tracksJson, "", "").size());
        assertEquals(TIME, repository.automaticSourceTimeline(owner).latestTime);
        ManualTimelineAuthorityPolicy.Candidate polling = repository.manualTimelineAuthority(owner);
        assertEquals(TimelineSlot.V6_QUERY, polling.provider);
        assertEquals(300L, polling.successAt);
        assertFalse(ExpressRepository.manualTimelinePollDue(owner, polling,
                300L + ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS - 1L));
        assertTrue(ExpressRepository.manualTimelinePollDue(owner, polling,
                300L + ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS));

        String signedAt = "2026-09-10 01:07:00";
        ExpressQueryResult signed = new ExpressQueryResult(owner.waybill, "SF", "SF Express",
                StatusSemantic.COMPLETED, ExpressSourcePolicy.parseEventTime(signedAt), signedAt,
                "Delivered event", "[{\"time\":\"" + signedAt + "\",\"context\":\"Delivered event\"}]",
                "", PHONE, TimelineSlot.V6_QUERY, "", "", "")
                .withManualStatusEvidence("Delivered", true);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, signed, 400L, false)),
                PHONE, "interface5");
        assertSharedK100Presentation(owner, complete, signed);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY,
                        onlineEvent(owner.waybill, "2026-09-10 01:08:00"), 500L, false)),
                PHONE, "interface5");
        assertSharedK100Presentation(owner, complete, signed);
        assertFalse(ExpressRepository.manualTimelinePollDue(repository.find(owner.rowId),
                repository.manualTimelineAuthority(owner),
                500L + ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS));
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

    private void assertSharedK100Presentation(ExpressItem owner, ExpressQueryResult complete,
            ExpressQueryResult online) {
        ManualTimelineAuthorityPolicy.Candidate detail = repository.manualDetailTimelineAuthority(owner);
        assertEquals(TimelineSlot.K100_H5, detail.provider);
        for (ExpressItem home : new ExpressItem[]{repository.find(owner.rowId),
                repository.listVisible("interface5").stream()
                        .filter(row -> row.rowId == owner.rowId).findFirst().orElseThrow()}) {
            assertEquals(TimelineSlot.K100_H5, home.manualTimelineProvider);
            assertEquals(complete.latestTime, home.latestTime);
            assertEquals(complete.latestDetail, home.latestDetail);
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

    @Test public void nonShunFengStickyPackageStillUsesItsFeedReference() {
        ExpressItem owner = owner("CNFRESH000001", "CaiNiao", "interface5", false);
        ExpressQueryResult old = detailPackage(owner.waybill, TimelineSlot.V6_QUERY, TIME, true);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                java.util.List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, old, 100L, true)),
                PHONE, "interface5");
        repository.rememberDetailSelection(owner, TimelineSlot.V6_QUERY);
        repository.saveAccountTimeline(detailPackage(owner.waybill, TimelineSlot.V5_QUERY,
                "2026-09-10 10:00:00", true), "interface5");
        assertEquals(TimelineSlot.V6_QUERY, repository.manualDetailTimelineAuthority(owner).provider);
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
        repository.saveAccountTimeline(fresh, "interface5");
        ManualTimelineAuthorityPolicy.Candidate selected = repository.manualDetailTimelineAuthority(owner);
        assertNotNull(selected);
        assertEquals(TimelineSlot.V5_QUERY, selected.provider);
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

    @Test public void v5EmptyTimelineCanUseSavedDetailWithoutChangingFeedStatus() {
        for (String provider : new String[]{"CaiNiao", "JingDong", "DouYin"}) {
            ExpressItem owner = emptyOwner("EMPTYDETAIL" + provider, provider, "interface5");
            ExpressItem before = repository.find(owner.rowId);
            ExpressRepository.ManualTimelinePollClaim poll =
                    repository.claimManualTimelinePoll(before, System.currentTimeMillis());
            assertNotNull(provider, poll);
            repository.releaseManualTimelinePoll(poll);
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

    @Test public void signedEmptyV5ListRemainsFrozen() {
        ExpressItem owner = emptyOwner("FROZENEMPTYV5", "CaiNiao", "interface5");
        ContentValues signed = new ContentValues();
        signed.put("logsiticsStatus", StatusSemantic.COMPLETED.storageCode);
        signed.put("logisticsStatusDesc", "Delivered");
        signed.put("statusEventTime", ExpressSourcePolicy.parseEventTime(TIME));
        database.getWritableDatabase().update(ExpressDatabase.EXPRESS_TABLE,
                signed, "_id=?", new String[]{Long.toString(owner.rowId)});
        assertNull(repository.claimManualTimelinePoll(repository.find(owner.rowId),
                System.currentTimeMillis()));
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
        ExpressQueryResult feed = new ExpressQueryResult(id, order ? "JD" : "ZTO",
                order ? "京东快递" : "中通快递", StatusSemantic.TRANSIT,
                ExpressSourcePolicy.parseEventTime(TIME), TIME, "feed运输中", tracks("feed运输中"),
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
        return "[{\"time\":\"" + TIME + "\",\"context\":\"" + detail + "\"}]";
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
