package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.annotation.SuppressLint;
import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.database.SQLException;
import android.database.sqlite.SQLiteDatabase;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.model.ManualQuerySuccess;
import me.pipi.deliveries.model.PendingExpressQuery;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressQueryCancellation;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressRepositoryDatabaseTest {
    @Test public void newerV5QueryAdvancesHomeAndSurvivesOlderFeedAfterReload() {
        String waybill = "ZTTESTQUERY011";
        String phone = "13900000043";
        String oldTime = relativeTime(-120_000L);
        String queryTime = relativeTime(-60_000L);
        repository.bindPhoneLocally(phone, "interface5");
        ExpressQueryResult feed = accountResult(waybill, phone, StatusSemantic.PICKED,
                oldTime, "Feed pickup", "[{\"time\":\"" + oldTime + "\",\"context\":\"Feed pickup\"}]", "", "CaiNiao");
        repository.saveInterface5(feed, phone);
        ExpressItem owner = repository.findByWaybill(waybill, "interface5");
        assertTrue(repository.saveInterface5Query(accountResult(waybill, phone, StatusSemantic.DELIVERY,
                queryTime, "Query delivery", "[{\"time\":\"" + queryTime + "\",\"context\":\"Query delivery\"}]", "", "CaiNiao")
                        .withManualStatusEvidence("Delivery", true),
                owner, repository.bindingGeneration(phone, "interface5")));
        database.close();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        repository.saveInterface5(feed, phone);
        ExpressItem presented = repository.findByWaybill(waybill, "interface5");
        assertEquals("Query delivery", presented.latestDetail);
        assertEquals(StatusSemantic.DELIVERY, presented.semantic);
        assertEquals(ExpressSourcePolicy.parseEventTime(queryTime), presented.statusEventTime);
        assertEquals("Query delivery", repository.listVisible("interface5").get(0).latestDetail);
        assertEquals("CaiNiao", presented.sourceProvider);
        String newer = relativeTime(-10_000L);
        repository.saveInterface5(accountResult(waybill, phone, StatusSemantic.COMPLETED, newer,
                "New feed signature", "[{\"time\":\"" + newer + "\",\"context\":\"New feed signature\"}]", "", "CaiNiao"), phone);
        presented = repository.findByWaybill(waybill, "interface5");
        assertEquals("New feed signature", presented.latestDetail);
        assertEquals(StatusSemantic.COMPLETED, presented.semantic);
        assertTrue(repository.accountTimeline(waybill, "interface5").tracksJson.contains("Query delivery"));
        assertFalse(repository.accountTimeline(waybill, "interface5").tracksJson.contains("New feed signature"));
    }

    @Test public void unscopedQueryCannotAdvanceAnExistingAccountHeadline() {
        String phone = "13900000043";
        String waybill = "ZTTESTUNSCOPED";
        repository.bindPhoneLocally(phone, "interface5");
        repository.saveInterface5(accountResult(waybill, phone, StatusSemantic.PICKED,
                relativeTime(-120_000L), "Feed pickup", "[]", "", "CaiNiao"), phone);
        repository.saveAccountTimeline(accountResult(waybill, phone, StatusSemantic.DELIVERY,
                relativeTime(-60_000L), "Unscoped query", "[]", "", "CaiNiao")
                .withManualStatusEvidence("Delivery", true), "interface5");
        assertEquals("Feed pickup", repository.findByWaybill(waybill, "interface5").latestDetail);
        assertEquals("Feed pickup", repository.listVisible("interface5").get(0).latestDetail);
    }

    @Test public void queryWithoutStructuredEvidenceAdvancesActivityButNotStatus() {
        String phone = "13900000043";
        String waybill = "ZTTESTQUERYPROSE";
        repository.bindPhoneLocally(phone, "interface5");
        repository.saveInterface5(accountResult(waybill, phone, StatusSemantic.PICKED,
                relativeTime(-120_000L), "Feed pickup", "[]", "", "CaiNiao"), phone);
        ExpressItem owner = repository.findByWaybill(waybill, "interface5");
        String time = relativeTime(-60_000L);
        assertTrue(repository.saveInterface5Query(accountResult(waybill, phone, StatusSemantic.DELIVERY,
                time, "Query prose", "[{\"time\":\"" + time + "\",\"context\":\"Query prose\"}]", "", "CaiNiao"),
                owner, repository.bindingGeneration(phone, "interface5")));
        ExpressItem presented = repository.findByWaybill(waybill, "interface5");
        assertEquals("Query prose", presented.latestDetail);
        assertEquals(StatusSemantic.PICKED, presented.semantic);
        assertEquals(owner.statusEventTime, presented.statusEventTime);
    }

    @Test public void queryFromRemovedBindingCannotAdvanceReboundOwner() {
        String phone = "13900000043";
        String waybill = "ZTTESTQUERYREBIND";
        repository.bindPhoneLocally(phone, "interface5");
        ExpressQueryResult feed = accountResult(waybill, phone, StatusSemantic.PICKED,
                relativeTime(-120_000L), "Feed pickup", "[]", "", "CaiNiao");
        repository.saveInterface5(feed, phone);
        ExpressItem oldOwner = repository.findByWaybill(waybill, "interface5");
        String oldGeneration = repository.bindingGeneration(phone, "interface5");
        ExpressQueryResult query = accountResult(waybill, phone, StatusSemantic.DELIVERY,
                relativeTime(-60_000L), "Old account query", "[]", "", "CaiNiao")
                .withManualStatusEvidence("Delivery", true);
        assertTrue(repository.saveInterface5Query(query, oldOwner, oldGeneration));
        repository.unbindPhone(phone, "interface5");
        repository.bindPhoneLocally(phone, "interface5");
        repository.saveInterface5(feed, phone);
        assertFalse(repository.saveInterface5Query(query, oldOwner, oldGeneration));
        assertEquals("Feed pickup", repository.findByWaybill(waybill, "interface5").latestDetail);
    }

    @Test public void jtH5AndLegacyK100PackagesRemainIndependentAfterReload() {
        ExpressItem owner = insertOwner("JTTEST7496", "13900000002", StatusSemantic.TRANSIT);
        repository.saveKuaidi100Timeline(timedResult(owner.waybill,
                "2026-09-10 09:00:00", "Synthetic K100 event", TimelineSlot.K100_H5));
        repository.saveOwnerManualTimeline(owner,
                timedResult(owner.waybill, "2026-09-10 09:00:00", "Synthetic K100 event", TimelineSlot.K100_H5),
                owner.phone, "interface5");
        repository.saveOwnerManualTimeline(owner,
                timedResult(owner.waybill, "2026-09-10 10:00:00", "已揽件 Synthetic JT event", TimelineSlot.JT_H5),
                owner.phone, "interface5");
        database.close();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        ManualTimelineAuthorityPolicy.Candidate jt = repository.manualTimelineCandidate(owner, TimelineSlot.JT_H5);
        ManualTimelineAuthorityPolicy.Candidate k100 = repository.manualTimelineCandidate(owner, TimelineSlot.K100_H5);
        assertNotNull(jt);
        assertNotNull(k100);
        assertEquals(TimelineSlot.JT_H5, jt.result.timelineProvider);
        assertTrue(jt.result.tracksJson.contains("Synthetic JT event"));
        assertFalse(jt.result.tracksJson.contains("Synthetic K100 event"));
        assertTrue(k100.result.tracksJson.contains("Synthetic K100 event"));
        assertFalse(k100.result.tracksJson.contains("Synthetic JT event"));
        assertFalse(repository.kuaidi100Timeline(owner.waybill).tracksJson.contains("Synthetic JT event"));
        repository.saveOwnerManualTimeline(owner, null, owner.phone, "interface5");
        assertEquals(k100.result.tracksJson,
                repository.manualTimelineCandidate(owner, TimelineSlot.K100_H5).result.tracksJson);
    }

    @Test public void jtOnlyManualSuccessCreatesOwnerWithIndependentTimeline() {
        String waybill = "JTTEST123456";
        String time = relativeTime(-60_000L);
        ExpressQueryResult jt = new ExpressQueryResult(waybill, "JTSD", "Synthetic carrier",
                StatusSemantic.UNKNOWN, time, "已揽件 Synthetic JT event",
                "[{\"time\":\"" + time + "\",\"context\":\"已揽件 Synthetic JT event\"}]",
                "", "", TimelineSlot.JT_H5);
        ExpressItem saved = repository.saveManualQueryBatch(null,
                Arrays.asList(new ManualQuerySuccess(TimelineSlot.JT_H5, jt, 1_000L, true)),
                "1234", "interface5");
        assertNotNull(saved);
        assertTrue(saved.manuallyAdded);
        assertEquals(TimelineSlot.JT_H5, repository.manualDetailTimelineAuthority(saved).provider);
        assertNull(repository.kuaidi100Timeline(waybill));
    }

    @org.robolectric.annotation.Implements(android.app.NotificationManager.class)
    public static class FailingNotifications extends org.robolectric.shadows.ShadowNotificationManager {
        static boolean fail;
        static int attempts;

        @org.robolectric.annotation.Implementation
        @Override
        public void notify(int id, android.app.Notification notification) {
            attempts++;
            if (fail) throw new IllegalStateException("Synthetic notification failure");
            super.notify(id, notification);
        }
    }

    @Test
    @Config(shadows = FailingNotifications.class)
    public void committedNotificationSurvivesDeliveryFailureAndRepositoryRecreation() {
        FailingNotifications.attempts = 0;
        FailingNotifications.fail = false;
        String waybill = "SFNOTIFICATION0001";
        repository.saveManualQueryResult(timedResult(waybill,
                "2026-09-08 09:00:00", "运输中", "v4"), "", "interface5");
        assertEquals(0, FailingNotifications.attempts);
        FailingNotifications.fail = true;
        repository.runInChangeBatch(() -> {
            repository.saveManualQueryResult(
                    timedResult(waybill, "2026-09-08 10:00:00", "已签收", "v4"),
                    "", "interface5");
            assertEquals(1, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null, null));
        });
        assertEquals(StatusSemantic.COMPLETED,
                repository.findByWaybill(waybill, "interface5").semantic);
        assertEquals(1, FailingNotifications.attempts);
        FailingNotifications.fail = false;
        database.close();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        repository.runInChangeBatch(() -> {});
        assertEquals(2, FailingNotifications.attempts);
        repository.runInChangeBatch(() -> {});
        assertEquals(2, FailingNotifications.attempts);
    }

    @Test
    public void notificationOutboxFailureRollsBackItsBusinessUpdate() {
        String waybill = "SFNOTIFICATION0002";
        repository.saveManualQueryResult(timedResult(waybill,
                "2026-09-08 09:00:00", "运输中", "v4"), "", "interface5");
        database.getWritableDatabase().execSQL("CREATE TRIGGER fail_notification_insert "
                + "BEFORE INSERT ON express_notification_outbox "
                + "BEGIN SELECT RAISE(ABORT, 'Synthetic outbox failure'); END");
        try {
            repository.saveManualQueryResult(timedResult(waybill,
                    "2026-09-08 10:00:00", "已签收", "v4"), "", "interface5");
        } catch (RuntimeException expected) {
            // Business state and the notification obligation must fail together.
        }
        assertEquals(StatusSemantic.TRANSIT,
                repository.findByWaybill(waybill, "interface5").semantic);
        assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null, null));
    }

    @Test
    @Config(shadows = FailingNotifications.class)
    public void newlyDiscoveredBatchNeverCreatesANotificationObligation() {
        FailingNotifications.attempts = 0;
        FailingNotifications.fail = false;
        repository.runInChangeBatch(() -> {
            repository.saveManualQueryResult(timedResult("SFNOTIFICATION0003",
                    "2026-09-08 09:00:00", "运输中", "v4"), "", "interface5");
            repository.saveManualQueryResult(timedResult("SFNOTIFICATION0003",
                    "2026-09-08 10:00:00", "已签收", "v4"), "", "interface5");
        });
        assertEquals(0, FailingNotifications.attempts);
        assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null, null));
    }

    @Test
    @Config(shadows = FailingNotifications.class)
    public void deletedOwnerDiscardsItsPendingNotification() {
        FailingNotifications.attempts = 0;
        FailingNotifications.fail = false;
        String waybill = "SFNOTIFICATION0004";
        repository.saveManualQueryResult(timedResult(waybill,
                "2026-09-08 09:00:00", "运输中", "v4"), "", "interface5");
        FailingNotifications.fail = true;
        repository.saveManualQueryResult(timedResult(waybill,
                "2026-09-08 10:00:00", "已签收", "v4"), "", "interface5");
        assertEquals(1, FailingNotifications.attempts);
        FailingNotifications.fail = false;
        repository.delete(repository.findByWaybill(waybill, "interface5").rowId);
        repository.runInChangeBatch(() -> {});
        assertEquals(1, FailingNotifications.attempts);
        assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null, null));
    }

    @Test
    @Config(shadows = FailingNotifications.class)
    public void retentionRemovesReplayedNotificationsInEitherOrder() {
        FailingNotifications.attempts = 0;
        FailingNotifications.fail = false;
        for (boolean pruneFirst : new boolean[]{false, true}) {
            FailingNotifications.attempts = 0;
            ExpressItem expired = insertOwner("SFEXPIRED" + pruneFirst, "", StatusSemantic.COMPLETED);
            ContentValues pending = new ContentValues();
            pending.put("owner_row_id", expired.rowId);
            pending.put("event_token", "synthetic-event");
            database.getWritableDatabase().insertOrThrow(
                    ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null, pending);
            context.getSharedPreferences("deliveries_repository_migrations", 0).edit()
                    .remove("last_signed_prune_at").commit();
            if (pruneFirst) repository.pruneExpiredShipmentsIfDue();
            repository.replayPendingNotifications();
            if (!pruneFirst) repository.pruneExpiredShipmentsIfDue();
            assertNull(repository.find(expired.rowId));
            assertEquals(0, FailingNotifications.attempts);
            assertEquals(0, context.getSystemService(android.app.NotificationManager.class)
                    .getActiveNotifications().length);
            assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null, null));
        }
    }

    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0)
                .edit().clear().commit();
        database = new ExpressDatabase(context);
        database.getWritableDatabase();
        repository = new ExpressRepository(context, database);
    }

    @After
    public void tearDown() {
        database.close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test
    public void manualPollClaimIsOwnerScopedAndOnlyItsCallerReleasesIt() {
        ExpressItem first = insertOwner("SFTEST000001", "13900000001", StatusSemantic.TRANSIT);
        ExpressItem second = insertOwner("SFTEST000002", "13900000002", StatusSemantic.TRANSIT);
        long now = 2_000_000L;

        ExpressRepository.ManualTimelinePollClaim firstClaim =
                repository.claimManualTimelinePoll(first, now);
        assertNotNull(firstClaim);
        assertNull(repository.claimManualTimelinePoll(first, now + 1L));
        ExpressRepository.ManualTimelinePollClaim secondClaim =
                repository.claimManualTimelinePoll(second, now);
        assertNotNull(secondClaim);
        assertEquals(2, count(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE, null, null));

        ExpressItem saved = repository.saveOwnerManualTimeline(
                first, timedResult(first.waybill, "2026-08-24 09:00:00", "快件已揽收"),
                first.phone, "interface5");
        assertNotNull(saved);
        ManualTimelineAuthorityPolicy.Candidate authority =
                repository.manualTimelineAuthority(first);
        assertNotNull(authority);
        assertTrue(authority.result.tracksJson.contains("快件已揽收"));
        assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "owner_row_id=?", new String[]{Long.toString(first.rowId)}));

        repository.saveOwnerManualTimeline(
                first, timedResult(first.waybill,
                        "2026-08-24 10:00:00", "快件运输中"),
                first.phone, "interface5");
        ManualTimelineAuthorityPolicy.Candidate merged =
                repository.manualTimelineAuthority(first);
        assertNotNull(merged);
        assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=?", new String[]{Long.toString(first.rowId)}));
        assertTrue(merged.result.tracksJson.contains("快件已揽收"));
        assertTrue(merged.result.tracksJson.contains("快件运输中"));
        assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "owner_row_id=?", new String[]{Long.toString(second.rowId)}));
    }

    @Test
    public void persistedCompletePackageBeatsNewerPartialProviderPackage() {
        ExpressItem owner = insertOwner(
                "SFTEST000003", "13900000003", StatusSemantic.TRANSIT);
        repository.saveOwnerManualTimeline(
                owner,
                timedResult(owner.waybill, "2026-08-24 12:00:00", "Moto 运输中", "v4"),
                owner.phone, "interface5", 200L, false);

        ManualTimelineAuthorityPolicy.Candidate partial =
                repository.manualTimelineAuthority(owner);
        assertNotNull(partial);
        assertFalse(partial.complete);

        repository.saveOwnerManualTimeline(
                owner,
                timedResult(owner.waybill, "2026-08-24 10:00:00", "K100 已揽收"),
                owner.phone, "interface5", 100L, true);

        ManualTimelineAuthorityPolicy.Candidate selected =
                repository.manualTimelineAuthority(owner);
        assertNotNull(selected);
        assertTrue(selected.complete);
        assertEquals("k100_h5", selected.provider);
        assertEquals("K100 已揽收", selected.result.latestDetail);
    }

    @Test
    public void unavailableNewManualQueryStaysHiddenWithNoInventedRawCarrier() {
        String waybill = "JDAP000000000001";

        assertTrue(repository.enqueuePendingManual(
                waybill, "", "interface5"));
        assertTrue(repository.enqueuePendingManual(
                waybill, "", "interface6"));
        assertEquals(1, count(ExpressDatabase.KUAIDI100_PENDING_TABLE,
                "normalized_waybill=?", new String[]{waybill}));
        assertNull(repository.findByWaybill(waybill, "interface5"));
        assertNull(repository.findByWaybill(waybill, "interface6"));
        assertEquals(0, repository.listVisible("interface6").size());

        List<me.pipi.deliveries.model.PendingExpressQuery> pending =
                repository.claimPendingManualQueries(
                        System.currentTimeMillis() + 31L * 60L * 1000L,
                        "interface6");
        assertEquals(1, pending.size());
        assertEquals("interface5", pending.get(0).bindingSource);
        assertEquals(waybill, pending.get(0).waybill);
        assertEquals("", pending.get(0).courierCode);
        assertEquals("", pending.get(0).companyName);
    }

    @Test
    public void repositoryConstructionDefersDatabaseOpenUntilFirstUse() {
        database.close();
        java.io.File file = context.getDatabasePath("deliveries.db");
        context.deleteDatabase("deliveries.db");
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        assertFalse(file.exists());
        repository.listVisible("interface5");
        assertTrue(file.exists());
    }

    @Test
    public void foregroundCanCompleteSignedHistoryWhileBackgroundRemainsFrozen() {
        ExpressItem owner = insertOwner("SFSIGNEDINCOMPLETE", "13900000006", StatusSemantic.COMPLETED);
        assertNull(repository.claimManualTimelinePoll(owner, 5_000_000L));
        assertNotNull(repository.claimForegroundManualTimelinePoll(owner, 5_000_000L, false));
    }

    @Test
    public void independentH5SaveCannotEraseTheActiveLeaseOrForegroundCadence() {
        ExpressItem owner = insertOwner("SFH5LEASE", "13900000006", StatusSemantic.TRANSIT);
        long now = System.currentTimeMillis();
        ExpressRepository.ManualTimelinePollClaim poll = repository.claimForegroundManualTimelinePoll(owner, now, false);
        repository.saveOwnerManualTimeline(owner, timedResult(owner.waybill,
                "2026-09-10 10:00:00", "运输中", TimelineSlot.K100_H5), owner.phone, "interface5");
        assertNull(repository.claimForegroundManualTimelinePoll(owner, now + 1L, true));
        repository.releaseManualTimelinePoll(poll);
        assertNull(repository.claimForegroundManualTimelinePoll(owner, now + 29_999L, false));
        assertNotNull(repository.claimForegroundManualTimelinePoll(owner, now + 30_000L, false));
    }

    @Test
    public void legacyLocalTimelineUsesTheSameLeaseWithoutAnAccountOwner() {
        ContentValues values = shipmentValues("LEGACYV4LEASE", "", "SF", "顺丰速运",
                "V4", "", StatusSemantic.TRANSIT);
        long rowId = database.getWritableDatabase().insertOrThrow(ExpressDatabase.EXPRESS_TABLE, null, values);
        ExpressItem owner = repository.find(rowId);
        long now = System.currentTimeMillis();
        ExpressRepository.ManualTimelinePollClaim background = repository.claimManualTimelinePoll(owner, now);
        assertNotNull(background);
        assertNull(repository.claimForegroundManualTimelinePoll(owner, now + 1L, true));
        repository.releaseManualTimelinePoll(background);
        assertNotNull(repository.claimForegroundManualTimelinePoll(owner, now + 30_000L, false));
    }

    @Test
    public void successfulForegroundCommitRetainsLeaseAndShortCadenceAcrossRecreation() {
        ExpressQueryResult initial = timedResult("SFLEASESUCCESS", "2026-09-10 09:00:00", "运输中", "v4");
        ExpressItem owner = repository.saveManualQueryBatch(null,
                List.of(new ManualQuerySuccess("v4", initial, System.currentTimeMillis(), false)),
                "", "interface5");
        assertNotNull(repository.captureManualQueryOwner(owner));
        long now = System.currentTimeMillis();
        ExpressRepository.ManualTimelinePollClaim poll = repository.claimForegroundManualTimelinePoll(owner, now, false);
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(owner);
        ExpressQueryResult result = timedResult(owner.waybill, "2026-09-10 10:00:00", "运输中", "v4");
        assertNotNull(repository.saveClaimedManualQueryBatch(owner, claim,
                List.of(new ManualQuerySuccess("v4", result, now, false)), owner.phone,
                "interface5", true, poll, new ExpressQueryCancellation(10_000L)));
        assertNull(repository.claimForegroundManualTimelinePoll(owner, now + 1L, true));
        assertNull(repository.claimManualTimelinePoll(owner, now + 1L));
        repository.releaseManualTimelinePoll(poll);
        database.close();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        assertNull(repository.claimForegroundManualTimelinePoll(owner, now + 29_999L, false));
        assertNotNull(repository.claimForegroundManualTimelinePoll(owner, now + 30_000L, false));
    }

    @Test
    public void expiredAttemptCannotWriteOrReleaseTheReplacementLease() {
        ExpressQueryResult initial = timedResult("SFLEASESTALE", "2026-09-10 09:00:00", "运输中", "v4");
        ExpressItem owner = repository.saveManualQueryBatch(null,
                List.of(new ManualQuerySuccess("v4", initial, System.currentTimeMillis(), false)),
                "", "interface5");
        assertNotNull(repository.captureManualQueryOwner(owner));
        long now = System.currentTimeMillis();
        ExpressRepository.ManualTimelinePollClaim stale = repository.claimForegroundManualTimelinePoll(
                owner, now - ExpressRepository.MANUAL_TIMELINE_ACTIVE_LEASE_MS, false);
        ExpressRepository.ManualTimelinePollClaim active = repository.claimForegroundManualTimelinePoll(owner, now, false);
        assertNotNull(active);
        ExpressQueryResult result = timedResult(owner.waybill, "2026-09-10 10:00:00", "运输中", "v4");
        assertNull(repository.saveClaimedManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess("v4", result, now, false)), owner.phone,
                "interface5", true, stale, new ExpressQueryCancellation(10_000L)));
        assertEquals("2026-09-10 09:00:00",
                repository.manualTimelineCandidate(owner, "v4").result.latestTime);
        repository.releaseManualTimelinePoll(stale);
        assertNull(repository.claimForegroundManualTimelinePoll(owner, now + 1L, true));
    }

    @Test
    public void cancellationWhileWaitingForRepositoryDoesNotCreateManualOwner() throws Exception {
        ExpressQueryCancellation cancellation = new ExpressQueryCancellation(10_000L);
        ExpressQueryResult result = timedResult("SFCANCELWAIT", "2026-09-10 10:00:00", "运输中", "v4");
        java.util.concurrent.ExecutorService worker = java.util.concurrent.Executors.newSingleThreadExecutor();
        try {
            java.util.concurrent.Future<ExpressItem> pending;
            synchronized (repository) {
                java.util.concurrent.CountDownLatch started = new java.util.concurrent.CountDownLatch(1);
                pending = worker.submit(() -> {
                    started.countDown();
                    return repository.saveClaimedManualQueryBatch(null, null,
                            List.of(new ManualQuerySuccess("v4", result, System.currentTimeMillis(), false)),
                            "", "interface5", false, null, cancellation);
                });
                assertTrue(started.await(1L, java.util.concurrent.TimeUnit.SECONDS));
                cancellation.cancel();
            }
            assertNull(pending.get(2L, java.util.concurrent.TimeUnit.SECONDS));
            assertNull(repository.findByWaybill(result.waybill, "interface5"));
        } finally { worker.shutdownNow(); }
    }

    @org.robolectric.annotation.Implements(value = me.pipi.deliveries.notification.ExpressNotifications.class,
            isInAndroidSdk = false)
    public static class CancelBeforeCommit {
        static ExpressQueryCancellation cancellation;
        @org.robolectric.annotation.Implementation
        protected static boolean shouldPostUpdate(ExpressItem previous, ExpressItem current) {
            if (cancellation != null) cancellation.cancel();
            return false;
        }
    }

    @Test
    @Config(shadows = CancelBeforeCommit.class)
    public void cancellationAfterWritesRollsBackOwnerAndEverySidecar() {
        ExpressQueryCancellation cancellation = new ExpressQueryCancellation(10_000L);
        CancelBeforeCommit.cancellation = cancellation;
        ExpressQueryResult result = timedResult("SFCANCELCOMMIT", "2026-09-10 10:00:00", "运输中", "v4");
        assertNull(repository.saveClaimedManualQueryBatch(null, null,
                List.of(new ManualQuerySuccess("v4", result, System.currentTimeMillis(), false)),
                "", "interface5", false, null, cancellation));
        assertTrue(cancellation.isCancelled());
        assertNull(repository.findByWaybill(result.waybill, "interface5"));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null, null));
        assertEquals(0, count(ExpressDatabase.V4_TIMELINE_TABLE, null, null));
        assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null, null));
    }

    @Test
    public void foregroundManualPollSeparatesForceCooldownFromActiveLease() {
        ExpressItem owner = insertOwner(
                "SFTEST000003", "13900000003", StatusSemantic.TRANSIT);
        long now = 3_000_000L;

        ExpressRepository.ManualTimelinePollClaim first =
                repository.claimForegroundManualTimelinePoll(owner, now, false);
        assertNotNull(first);
        assertNull(repository.claimForegroundManualTimelinePoll(owner, now + 1L, true));

        repository.releaseManualTimelinePoll(first);
        assertNull(repository.claimForegroundManualTimelinePoll(owner, now + 1L, false));
        ExpressRepository.ManualTimelinePollClaim forced =
                repository.claimForegroundManualTimelinePoll(owner, now + 1L, true);
        assertNotNull(forced);

        repository.releaseManualTimelinePoll(first);
        assertNull(repository.claimForegroundManualTimelinePoll(owner, now + 2L, true));
        repository.releaseManualTimelinePoll(forced);

        ExpressRepository.ManualTimelinePollClaim afterInterval =
                repository.claimForegroundManualTimelinePoll(
                        owner, now + 1L
                                + ExpressRepository.MANUAL_TIMELINE_FOREGROUND_INTERVAL_MS,
                        false);
        assertNotNull(afterInterval);
        repository.releaseManualTimelinePoll(afterInterval);
    }

    @Test
    public void foregroundManualPollUsesShortCadenceAfterARecentSuccessfulTimeline() {
        ExpressItem owner = insertOwner(
                "SFTEST000005", "13900000005", StatusSemantic.TRANSIT);
        repository.saveOwnerManualTimeline(
                owner, timedResult(owner.waybill,
                        "2026-08-24 09:00:00", "快件运输中"),
                owner.phone, "interface5");
        long now = ExpressSourcePolicy.parseEventTime("2026-08-24 09:01:00");

        ExpressRepository.ManualTimelinePollClaim first =
                repository.claimForegroundManualTimelinePoll(owner, now, false);
        assertNotNull(first);
        repository.releaseManualTimelinePoll(first);
        assertNull(repository.claimForegroundManualTimelinePoll(
                owner, now + ExpressRepository.MANUAL_TIMELINE_FOREGROUND_INTERVAL_MS - 1L,
                false));
        ExpressRepository.ManualTimelinePollClaim automatic =
                repository.claimForegroundManualTimelinePoll(
                        owner, now + ExpressRepository.MANUAL_TIMELINE_FOREGROUND_INTERVAL_MS,
                        false);
        assertNotNull(automatic);
        repository.releaseManualTimelinePoll(automatic);

        ExpressRepository.ManualTimelinePollClaim forced =
                repository.claimForegroundManualTimelinePoll(
                        owner, now + ExpressRepository.MANUAL_TIMELINE_FOREGROUND_INTERVAL_MS + 1L,
                        true);
        assertNotNull(forced);
        repository.releaseManualTimelinePoll(forced);
    }

    @Test
    public void expiredManualLeaseCanRecoverAndPartialTerminalStillSeeksACompletePackage() {
        ExpressItem owner = insertOwner(
                "SFTEST000004", "13900000004", StatusSemantic.TRANSIT);
        long now = 4_000_000L;
        assertNotNull(repository.claimForegroundManualTimelinePoll(owner, now, true));

        ExpressRepository.ManualTimelinePollClaim recovered =
                repository.claimForegroundManualTimelinePoll(
                        owner, now + ExpressRepository.MANUAL_TIMELINE_ACTIVE_LEASE_MS, true);
        assertNotNull(recovered);
        repository.releaseManualTimelinePoll(recovered);

        ExpressQueryResult completed = timedResult(
                owner.waybill, "2026-08-24 12:00:00", "快件已签收", "v4");
        assertNotNull(repository.saveOwnerManualTimeline(
                owner, completed, owner.phone, "interface5"));
        ExpressItem current = repository.find(owner.rowId);
        assertNotNull(current);
        assertEquals(StatusSemantic.COMPLETED, current.semantic);
        ExpressRepository.ManualTimelinePollClaim fallback =
                repository.claimForegroundManualTimelinePoll(
                        current,
                        now + ExpressRepository.MANUAL_TIMELINE_ACTIVE_LEASE_MS + 1L,
                        true);
        assertNotNull(fallback);
        repository.releaseManualTimelinePoll(fallback);
    }

    @Test
    public void rawCompletedOwnerCanStillAcquireItsFirstManualTimeline() {
        ExpressItem owner = insertOwner(
                "SFTEST000006", "13900000006", StatusSemantic.COMPLETED);

        ExpressRepository.ManualTimelinePollClaim claim =
                repository.claimForegroundManualTimelinePoll(owner, 5_000_000L, true);

        assertNotNull(claim);
    }

    @Test
    public void rawCompletedOwnerKeepsRefreshingANonterminalManualTimeline() {
        ExpressItem owner = insertOwner(
                "SFTEST000007", "13900000007", StatusSemantic.COMPLETED);
        assertNotNull(repository.saveOwnerManualTimeline(
                owner, timedResult(owner.waybill,
                        "2026-08-24 09:00:00", "快件运输中"),
                owner.phone, "interface5"));
        ExpressItem projected = repository.find(owner.rowId);
        assertNotNull(projected);
        assertEquals(StatusSemantic.COMPLETED, projected.semantic);
        assertEquals("快件运输中", projected.latestDetail);

        ExpressRepository.ManualTimelinePollClaim claim =
                repository.claimForegroundManualTimelinePoll(projected, 5_100_000L, true);

        assertNotNull(claim);
    }

    @Test
    public void manualLeaseCanRecoverAfterWallClockRollback() {
        ExpressRepository.ManualTimelineRetryState retry =
                new ExpressRepository.ManualTimelineRetryState(
                        10_000L, "active", 20_000L);

        assertTrue(ExpressRepository.manualTimelineActiveLeaseAvailable(retry, 9_999L));
        assertFalse(ExpressRepository.manualTimelineActiveLeaseAvailable(retry, 10_001L));
        assertTrue(ExpressRepository.manualTimelineActiveLeaseAvailable(retry, 20_000L));
    }

    @Test
    public void manualDeleteRemovesItsSidecarsButUnbindKeepsIndependentTimelineCache() {
        ExpressItem deleted = insertOwner(
                "SFTEST000011", "13900000011", StatusSemantic.TRANSIT);
        ExpressItem retained = insertOwner(
                "SFTEST000012", "13900000012", StatusSemantic.TRANSIT);
        repository.bindPhoneLocally(retained.phone, "interface5");
        repository.saveInterface5(accountResult(
                retained.waybill, retained.phone, StatusSemantic.TRANSIT,
                "2026-08-24 10:00:00", "账号来源运输中",
                "[{\"time\":\"2026-08-24 10:00:00\","
                        + "\"context\":\"账号来源运输中\"}]",
                "", "ShunFeng"), retained.phone);
        retained = repository.findByWaybill(retained.waybill, "interface5");
        saveAndClaimAgain(deleted);
        saveAndClaimAgain(retained);

        repository.delete(deleted.rowId);

        assertNull(repository.find(deleted.rowId));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=?", new String[]{Long.toString(deleted.rowId)}));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "owner_row_id=?", new String[]{Long.toString(deleted.rowId)}));
        assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=?", new String[]{Long.toString(retained.rowId)}));
        assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "owner_row_id=?", new String[]{Long.toString(retained.rowId)}));

        repository.unbindPhone(retained.phone, "interface5");
        assertNotNull(repository.find(retained.rowId));
        assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=?", new String[]{Long.toString(retained.rowId)}));
        assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "owner_row_id=?", new String[]{Long.toString(retained.rowId)}));
    }

    @Test
    public void automaticFeedCanRecreateAUserClearedShipment() {
        String waybill = "ZTTEST000013";
        String phone = "13900000013";
        repository.bindPhoneLocally(phone, "interface5");
        ExpressQueryResult first = accountResult(
                waybill, phone, StatusSemantic.TRANSIT,
                "2026-08-24 09:00:00", "快件已揽收", "[]", "", "CaiNiao");
        repository.saveInterface5(first, phone);
        ExpressItem saved = repository.findByWaybill(waybill, "interface5");
        assertNotNull(saved);

        repository.delete(saved.rowId);
        assertNull(repository.findByWaybill(waybill, "interface5"));

        ExpressQueryResult nextFeed = accountResult(
                waybill, phone, StatusSemantic.TRANSIT,
                "2026-08-24 10:00:00", "快件运输中", "[]", "", "CaiNiao");
        repository.saveInterface5(nextFeed, phone);

        ExpressItem recreated = repository.findByWaybill(waybill, "interface5");
        assertNotNull(recreated);
        assertTrue(recreated.rowId != saved.rowId);
        assertEquals("快件运输中", recreated.latestDetail);
    }

    @Test
    public void staleManualSnapshotCannotRecreateADeletedManualOwner() {
        String waybill = "MANUALTEST000014";
        ExpressQueryResult first = timedResult(
                waybill, "2026-08-24 09:00:00", "快件已揽收");
        repository.saveManualQueryResult(first, "0014", "interface6");
        ExpressItem captured = repository.findByWaybill(waybill, "interface6");
        assertNotNull(captured);
        assertTrue(captured.manuallyAdded);

        repository.delete(captured.rowId);
        repository.saveOwnerManualTimeline(
                captured,
                timedResult(waybill, "2026-08-24 10:00:00", "快件运输中"),
                "0014", "interface6");

        assertNull(repository.findByWaybill(waybill, "interface6"));
        assertEquals(0, count(ExpressDatabase.EXPRESS_TABLE, null, null));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null, null));
    }

    @Test
    public void manualRecognitionPersistsWithoutOverwritingTheRawCarrierCode() {
        String waybill = "MANUALTEST000015";
        ExpressQueryResult raw = timedResult(
                waybill, "2026-08-24 09:00:00", "快件运输中");
        ExpressQueryResult recognized = new ExpressQueryResult(
                raw.waybill, "RAW-CODE", "RAW-CODE", raw.semantic,
                raw.statusEventTime, raw.latestTime, raw.latestDetail, raw.tracksJson,
                raw.detailUrl, raw.phone, raw.timelineProvider, raw.routeInterface,
                raw.routeCredential, raw.sourceProvider,
                new CarrierNormalization(
                        "KYSY", "跨越速运", "kuayue", true, "worker-v1"));

        repository.saveManualQueryResult(recognized, "0015", "interface6");

        ExpressItem saved = repository.findByWaybill(waybill, "interface6");
        assertNotNull(saved);
        assertEquals("RAW-CODE", saved.courierCode);
        assertEquals("KYSY", saved.carrierNormalization.standardCode);
        assertEquals("跨越速运", saved.displayCompany());
    }

    @Test
    public void retentionRemovesManualTimelineAndRetryTogether() {
        ExpressItem expired = insertOwner(
                "SFTEST000021", "13900000021", StatusSemantic.COMPLETED);
        repository.saveOwnerManualTimeline(
                expired, timedResult(expired.waybill,
                        "2020-01-01 09:00:00", "快件已签收"),
                expired.phone, "interface5");
        insertRetry(expired, 1_000L);

        repository.pruneExpiredShipmentsIfDue();

        assertNull(repository.find(expired.rowId));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=?", new String[]{Long.toString(expired.rowId)}));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "owner_row_id=?", new String[]{Long.toString(expired.rowId)}));
    }

    @Test
    public void projectionSuccessAndOwnerDeletionCannotLeaveRetryState() {
        ExpressItem order = insertOrder("JDORDER000001", "13900000031");
        repository.recordOrderProjectionFailure(order, 1_000L, "route-a");
        ExpressRepository.OrderProjectionRetryState failed =
                repository.orderProjectionRetryState(order);
        assertEquals(1_000L, failed.failedAt);
        assertEquals("route-a", failed.routeFingerprint);

        assertTrue(repository.saveOrderProjection(
                order, "interface5", "SFPROJECT00001", "顺丰速运"));
        ExpressRepository.OrderProjectionRetryState cleared =
                repository.orderProjectionRetryState(order);
        assertEquals(0L, cleared.failedAt);
        assertEquals("", cleared.routeFingerprint);

        repository.recordOrderProjectionFailure(order, 2_000L, "route-a");
        repository.delete(order.rowId);
        ExpressRepository.OrderProjectionRetryState deleted =
                repository.orderProjectionRetryState(order);
        assertEquals(0L, deleted.failedAt);
        assertEquals("", deleted.routeFingerprint);
    }

    @Test
    public void lookupByProjectedWaybillCarriesTheOrderProjection() {
        ExpressItem order = insertOrder("JDORDER000201", "13900000201");
        assertTrue(repository.saveOrderProjection(
                order, "interface5", "JT4006839564547", "极兔速递"));
        // 设备上按件详情落库后归属表以投影运单号为键指向订单行（saveOrderProjection 会把
        // 归属从订单号改键到投影运单号）；这里直接写归属行复现那一步。
        ContentValues ownership = new ContentValues();
        ownership.put("normalized_waybill",
                ExpressSourcePolicy.normalizeWaybill("JT4006839564547"));
        ownership.put("owner_provider", "interface5");
        ownership.put("owner_row_id", order.rowId);
        ownership.put("claimed_at", 1_000L);
        ownership.put("last_observed_at", 1_000L);
        database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, null, ownership);

        ExpressItem byProjectedWaybill = repository.findByWaybill(
                "JT4006839564547", "interface5");
        ExpressItem byOrderId = repository.findByWaybill(order.waybill, "interface5");

        assertNotNull(byProjectedWaybill);
        assertEquals(order.rowId, byProjectedWaybill.rowId);
        assertEquals("极兔速递", byProjectedWaybill.displayCompany());
        assertEquals("JT4006839564547", byProjectedWaybill.displayWaybill());
        assertNotNull(byOrderId);
        assertEquals("极兔速递", byOrderId.displayCompany());
        assertEquals("JT4006839564547", byOrderId.displayWaybill());
    }

    @Test
    public void expiredSummaryForAnUnknownIdentityIsNotImported() {
        String phone = "13900000301";
        repository.bindPhoneLocally(phone, "interface5");
        repository.saveInterface5OrderSummary(new ExpressQueryResult(
                "JDORDER000301", "JD", "京东购物", StatusSemantic.COMPLETED,
                relativeTime(-22L * 24L * 60L * 60L * 1000L), "订单已完成", "[]",
                "", phone, "interface5", "", "", "JingDong"), phone);
        assertNull(repository.findByWaybill("JDORDER000301", "interface5"));

        repository.saveInterface5OrderSummary(new ExpressQueryResult(
                "JDORDER000302", "JD", "京东购物", StatusSemantic.COMPLETED,
                relativeTime(-24L * 60L * 60L * 1000L), "订单已完成", "[]",
                "", phone, "interface5", "", "", "JingDong"), phone);
        assertNotNull(repository.findByWaybill("JDORDER000302", "interface5"));
    }

    @Test
    public void rowFirstSeenInsideAChangeBatchDoesNotNotifyWithinThatBatch() {
        String phone = "13900000303";
        repository.bindPhoneLocally(phone, "interface5");
        android.app.NotificationManager notifications =
                context.getSystemService(android.app.NotificationManager.class);
        assertNotNull(notifications);
        notifications.cancelAll();
        String signedAt = relativeTime(-60L * 60L * 1000L);

        repository.runInChangeBatch(() -> {
            repository.saveInterface5OrderSummary(new ExpressQueryResult(
                    "JDORDER000303", "JD", "京东购物", StatusSemantic.TRANSIT,
                    relativeTime(-2L * 60L * 60L * 1000L), "订单运输中", "[]",
                    "", phone, "interface5", "", "", "JingDong"), phone);
            ExpressItem order = repository.findByWaybill("JDORDER000303", "interface5");
            assertNotNull(order);
            assertTrue(repository.saveOrderProjection(
                    order, "interface5", "JD0256719000303", "京东快递"));
            // The same batch receives a carrier-scoped signature for the real waybill.
            repository.saveInterface5(new ExpressQueryResult(
                    "JD0256719000303", "JD", "京东快递", StatusSemantic.COMPLETED,
                    signedAt, "快件已签收", timedTracks(signedAt, "快件已签收"),
                    "", phone, "interface5", "", "", "JingDong"), phone);
        });
        ExpressItem imported = repository.findByWaybill("JD0256719000303", "interface5");
        assertNotNull(imported);
        assertEquals(StatusSemantic.COMPLETED, imported.semantic);
        assertEquals(0, notifications.getActiveNotifications().length);

        repository.saveInterface5OrderSummary(new ExpressQueryResult(
                "JDORDER000304", "JD", "京东购物", StatusSemantic.TRANSIT,
                relativeTime(-2L * 60L * 60L * 1000L), "订单运输中", "[]",
                "", phone, "interface5", "", "", "JingDong"), phone);
        ExpressItem known = repository.findByWaybill("JDORDER000304", "interface5");
        assertNotNull(known);
        assertTrue(repository.saveOrderProjection(
                known, "interface5", "JD0256719000304", "京东快递"));
        repository.runInChangeBatch(() -> repository.saveInterface5(
                new ExpressQueryResult(
                        "JD0256719000304", "JD", "京东快递", StatusSemantic.COMPLETED,
                        signedAt, "快件已签收", timedTracks(signedAt, "快件已签收"),
                        "", phone, "interface5", "", "", "JingDong"), phone));
        assertEquals(1, notifications.getActiveNotifications().length);
        notifications.cancelAll();
    }

    @Test
    public void frozenJingDongRowNeverNotifiesAgain() {
        String phone = "13900000305";
        repository.bindPhoneLocally(phone, "interface5");
        String signedAt = relativeTime(-60L * 60L * 1000L);
        repository.saveInterface5OrderSummary(new ExpressQueryResult(
                "JDORDER000305", "JD", "京东购物", StatusSemantic.TRANSIT,
                relativeTime(-2L * 60L * 60L * 1000L), "订单运输中", "[]",
                "", phone, "interface5", "", "", "JingDong"), phone);
        ExpressItem order = repository.findByWaybill("JDORDER000305", "interface5");
        assertNotNull(order);
        assertFalse(me.pipi.deliveries.notification.ExpressNotifications.isFrozenJingDong(order));
        assertTrue(repository.saveOrderProjection(
                order, "interface5", "JD0256719000305", "京东快递"));
        // Freeze requires the real waybill's carrier signature, not order completion.
        repository.saveInterface5(new ExpressQueryResult(
                "JD0256719000305", "JD", "京东快递", StatusSemantic.COMPLETED,
                signedAt, "快件已签收", timedTracks(signedAt, "快件已签收"),
                "", phone, "interface5", "", "", "JingDong"), phone);
        ExpressItem frozen = repository.findByWaybill("JD0256719000305", "interface5");
        assertNotNull(frozen);
        assertEquals(StatusSemantic.COMPLETED, frozen.semantic);
        assertTrue(me.pipi.deliveries.notification.ExpressNotifications.isFrozenJingDong(frozen));

        ExpressItem transit = insertOrder("JDORDER000306", "13900000306");
        assertFalse(me.pipi.deliveries.notification.ExpressNotifications.shouldPostUpdate(
                frozen, transit));
        assertTrue(me.pipi.deliveries.notification.ExpressNotifications.shouldPostUpdate(
                transit, frozen));
    }

    @Test
    public void projectionCommitIsScopedToStableOwnerAndBinding() {
        ExpressItem primary = insertOrder("JDORDER000101", "13900000101");
        ExpressItem secondary = insertOrder(
                "JDORDER0001019", "13900000102", "I6-JD", "v6");
        repository.recordOrderProjectionFailure(primary, 1_001L, "route-primary");
        repository.recordOrderProjectionFailure(secondary, 1_002L, "route-secondary");

        assertFalse(repository.saveOrderProjection(
                primary, "interface6", "JD0256719000101", "京东快递"));
        assertEquals(1_001L, rawRetryAt(primary.rowId));
        assertEquals(0, count(ExpressDatabase.ORDER_PROJECTION_TABLE, null, null));

        assertTrue(repository.saveOrderProjection(
                primary, "interface5", "JD0256719000101", "京东快递"));
        assertEquals(0L, rawRetryAt(primary.rowId));
        assertEquals(1_002L, rawRetryAt(secondary.rowId));
        assertEquals("JD0256719000101", repository.find(primary.rowId).displayWaybill());
        assertEquals(secondary.waybill, repository.find(secondary.rowId).displayWaybill());
        assertEquals(1, count(ExpressDatabase.ORDER_PROJECTION_TABLE,
                "normalized_source_id=? AND binding_source=?",
                new String[]{ExpressSourcePolicy.normalizeWaybill(primary.waybill),
                        "interface5"}));
        assertEquals(0, count(ExpressDatabase.ORDER_PROJECTION_TABLE,
                "normalized_source_id=? AND binding_source=?",
                new String[]{ExpressSourcePolicy.normalizeWaybill(secondary.waybill),
                        "interface6"}));

        ContentValues replacement = new ContentValues();
        replacement.put("mailNo", "JDORDERREPLACED");
        replacement.put("normalizedMailNo",
                ExpressSourcePolicy.normalizeWaybill("JDORDERREPLACED"));
        assertEquals(1, database.getWritableDatabase().update(
                ExpressDatabase.EXPRESS_TABLE, replacement, "_id=?",
                new String[]{Long.toString(secondary.rowId)}));

        assertFalse(repository.saveOrderProjection(
                secondary, "interface6", "JD0256719000102", "京东快递"));
        assertEquals(1_002L, rawRetryAt(secondary.rowId));
        assertEquals(0, count(ExpressDatabase.ORDER_PROJECTION_TABLE,
                "binding_source=?", new String[]{"interface6"}));
    }

    @Test
    public void recognitionUpdatesOnlyTheMatchingProjectionCarrier() {
        ExpressItem order = insertOrder("JDORDER000104", "13900000104");
        assertTrue(repository.saveOrderProjection(
                order, "interface5", "SFPROJECT00004", ""));
        ExpressItem projected = repository.find(order.rowId);
        assertNotNull(projected);
        assertEquals("快递", projected.displayCompany());
        assertEquals("", projected.displayCourierCode());

        assertFalse(repository.saveOrderProjectionCarrier(
                projected, "interface5", "SFPROJECT00004", "无法识别的承运商"));
        assertFalse(repository.saveOrderProjectionCarrier(
                projected, "interface6", "SFPROJECT00004", "顺丰速运"));
        assertFalse(repository.saveOrderProjectionCarrier(
                projected, "interface5", "SFPROJECT00005", "顺丰速运"));
        assertEquals("快递", repository.find(order.rowId).displayCompany());

        assertTrue(repository.saveOrderProjectionCarrier(
                projected, "interface5", "SFPROJECT00004", "顺丰速运"));
        ExpressItem recognized = repository.find(order.rowId);
        assertNotNull(recognized);
        assertEquals("顺丰速运", recognized.displayCompany());
        assertEquals("shunfeng", recognized.displayCourierCode());
        assertEquals("JD", rawExpressText(order.rowId, "cpCode"));
        assertEquals("京东购物", rawExpressText(order.rowId, "cpName"));
        assertEquals("JingDong", recognized.sourceProvider);
        assertFalse(repository.saveOrderProjectionCarrier(
                recognized, "interface5", "SFPROJECT00004", "圆通速递"));
        assertEquals("顺丰速运", repository.find(order.rowId).displayCompany());
    }

    @Test
    public void staleCaptureCannotCommitOrCoolAChangedOwnerContract() {
        ExpressItem captured = insertOrder("JDORDER000103", "13900000103");
        String attemptedRoute = ExpressOrderProjectionIdentity.routeFingerprint(captured);
        repository.recordOrderProjectionFailure(captured, 1_003L, attemptedRoute);
        assertEquals(1_003L, rawRetryAt(captured.rowId));
        assertEquals(attemptedRoute, rawRetryRoute(captured.rowId));

        ContentValues changedContract = new ContentValues();
        // Change only the route contract. Provider/courier changes were already guarded by the
        // legacy identity check and would not prove that a stale capture cannot cross routes.
        changedContract.put("routeInterface", "v6");
        assertEquals(1, database.getWritableDatabase().update(
                ExpressDatabase.EXPRESS_TABLE, changedContract, "_id=?",
                new String[]{Long.toString(captured.rowId)}));
        ExpressItem current = repository.find(captured.rowId);
        assertNotNull(current);
        String currentRoute = ExpressOrderProjectionIdentity.routeFingerprint(current);
        assertFalse(attemptedRoute.equals(currentRoute));

        ContentValues currentCooldown = new ContentValues();
        currentCooldown.put("projectionRetryAt", 2_003L);
        currentCooldown.put("projectionRetryRoute", currentRoute);
        assertEquals(1, database.getWritableDatabase().update(
                ExpressDatabase.EXPRESS_TABLE, currentCooldown, "_id=?",
                new String[]{Long.toString(captured.rowId)}));

        assertFalse(repository.saveOrderProjection(
                captured, "interface5", "JD0256719000103", "京东快递"));
        repository.recordOrderProjectionFailure(captured, 3_003L, attemptedRoute);
        assertEquals(2_003L, rawRetryAt(captured.rowId));
        assertEquals(currentRoute, rawRetryRoute(captured.rowId));
        assertEquals(0, count(ExpressDatabase.ORDER_PROJECTION_TABLE, null, null));
    }

    @Test
    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    public void carrierSidecarSaveNeverPublishesOrRewritesTheFeedRow() {
        ExpressItem order = insertOrder("JDORDER000102", "13900000102");
        String displayWaybill = "JD0256719000102";
        assertTrue(repository.saveOrderProjection(
                order, "interface5", displayWaybill, "京东快递"));
        ContentValues legacyCanonicalState = new ContentValues();
        legacyCanonicalState.put("normalizedMailNo", "");
        assertEquals(1, database.getWritableDatabase().update(
                ExpressDatabase.EXPRESS_TABLE, legacyCanonicalState, "_id=?",
                new String[]{Long.toString(order.rowId)}));

        AtomicInteger broadcasts = new AtomicInteger();
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context ignored, Intent intent) {
                if (ExpressRepository.ACTION_CHANGED.equals(intent.getAction())) {
                    broadcasts.incrementAndGet();
                }
            }
        };
        context.registerReceiver(receiver, new IntentFilter(ExpressRepository.ACTION_CHANGED));
        try {
            repository.saveKuaidi100Timeline(timedResult(
                    displayWaybill, "2026-08-24 15:00:00", "K100 快件已到达深圳"));

            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            // 用户定 2026-09-05 晚：query 包只进 sidecar，列表行不变、不广播；投影身份照旧可读。
            assertEquals(0, broadcasts.get());
            ExpressItem projected = repository.find(order.rowId);
            assertNotNull(projected);
            assertEquals(displayWaybill, projected.displayWaybill());
            assertEquals("", projected.manualTimelineProvider);
            assertFalse(projected.tracksJson.contains("K100 快件已到达深圳"));
            assertEquals("快件运输中", projected.latestDetail);
            assertEquals("K100 快件已到达深圳",
                    repository.kuaidi100Timeline(displayWaybill).latestDetail);
        } finally {
            context.unregisterReceiver(receiver);
        }
    }

    @Test
    public void projectedOrderPresentsItsLatestCarrierStateAcrossRepositoryReads() {
        String orderId = "JDORDER000104";
        String phone = "13900000104";
        ContentValues values = shipmentValues(
                orderId, phone, "JD", "京东购物", "I5-JD", "JingDong",
                StatusSemantic.TRANSIT);
        values.put("lastLogisticDetail", "圆通快件正在转运中心运输");
        long rowId = database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.EXPRESS_TABLE, null, values);

        ExpressItem unprojected = repository.find(rowId);
        assertNotNull(unprojected);
        // 用户定 2026-09-08：只有「已揽收（含待揽件）且还没有运单号」才降级成已下单，运输中这类
        // 状态照来源显示。
        assertEquals(StatusSemantic.TRANSIT, unprojected.semantic);
        assertEquals("运输中", unprojected.displayStatus());

        assertTrue(repository.saveOrderProjection(
                unprojected, "interface5", "YT0256719000104", "圆通速递"));

        ExpressItem projected = repository.find(rowId);
        assertNotNull(projected);
        assertEquals(StatusSemantic.TRANSIT, projected.sourceSemantic);
        assertEquals(StatusSemantic.TRANSIT, projected.semantic);
        assertEquals("运输中", projected.displayStatus());
        assertEquals("圆通快件正在转运中心运输", projected.latestDetail);
        assertEquals("YT0256719000104", projected.displayWaybill());

        ExpressItem byOrder = repository.findByWaybill(orderId, "interface5");
        assertNotNull(byOrder);
        assertEquals(StatusSemantic.TRANSIT, byOrder.semantic);
        List<ExpressItem> visible = repository.listVisible("interface5");
        assertEquals(1, visible.size());
        assertEquals(StatusSemantic.TRANSIT, visible.get(0).semantic);
        assertEquals(0, repository.listVisible("interface6").size());
    }

    @Test
    public void projectedOrderKeepsItsFeedStateWhileTheCarrierPackageStaysInItsSidecar() {
        String orderId = "JDORDER000032";
        String phone = "13900000032";
        ContentValues values = shipmentValues(
                orderId, phone, "JD", "京东购物", "I5-JD", "JingDong",
                StatusSemantic.ORDERED);
        long rowId = database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.EXPRESS_TABLE, null, values);

        ExpressItem unprojected = repository.find(rowId);
        assertNotNull(unprojected);
        assertEquals(StatusSemantic.ORDERED, unprojected.semantic);
        assertEquals(StatusSemantic.ORDERED, unprojected.sourceSemantic);

        repository.bindPhoneLocally(phone, "interface5");
        repository.saveInterface5OrderSummary(new ExpressQueryResult(
                orderId, "JD", "京东购物", StatusSemantic.TRANSIT,
                "2026-08-24 12:00:00", "订单运输中", "[]",
                "", phone, "interface5", "", "", "JingDong"), phone);
        ExpressItem refreshed = repository.find(rowId);
        assertNotNull(refreshed);
        assertEquals(StatusSemantic.TRANSIT, refreshed.semantic);
        assertEquals(StatusSemantic.TRANSIT, refreshed.sourceSemantic);
        assertEquals("订单运输中", refreshed.latestDetail);

        android.app.NotificationManager notifications =
                context.getSystemService(android.app.NotificationManager.class);
        assertNotNull(notifications);
        notifications.cancelAll();

        assertTrue(repository.saveOrderProjection(
                repository.find(rowId), "interface5", "JD0256719746857", "京东快递"));
        ExpressItem projected = repository.find(rowId);
        assertNotNull(projected);
        // 投影到运单后列表直接显示 feed 的状态（iOS withAccountPresentation 同口径）。
        assertEquals(StatusSemantic.TRANSIT, projected.semantic);
        assertEquals(StatusSemantic.TRANSIT, projected.sourceSemantic);
        assertEquals("JD0256719746857", projected.displayWaybill());
        notifications.cancelAll();

        String signedAt = relativeTime(-60L * 60L * 1000L);
        ExpressQueryResult carrierSigned = new ExpressQueryResult(
                "JD0256719746857", "JD", "京东快递", StatusSemantic.COMPLETED,
                ExpressSourcePolicy.parseEventTime(signedAt), signedAt, "快件已签收",
                "[{\"time\":\"" + signedAt + "\",\"context\":\"快件已签收\"}]",
                "", phone, "kuaidi100", "", "", "");
        repository.saveKuaidi100Timeline(carrierSigned);

        // 用户定 2026-09-05 晚：feed 增量与 query 独立。承运商包只在 sidecar 里，列表行的状态、
        // 头条、可见性都还是 feed 的，query 落库也不发通知。
        ExpressItem found = repository.find(rowId);
        ExpressItem byOrder = repository.findByWaybill(orderId, "interface5");
        List<ExpressItem> visible = repository.listVisible("interface5");
        assertNotNull(found);
        assertNotNull(byOrder);
        assertEquals(StatusSemantic.TRANSIT, found.semantic);
        assertEquals("订单运输中", found.latestDetail);
        assertEquals("订单运输中", byOrder.latestDetail);
        assertEquals(1, visible.size());
        assertEquals("快件已签收",
                repository.kuaidi100Timeline("JD0256719746857").latestDetail);
        assertEquals(0, notifications.getActiveNotifications().length);

        // Order completion cannot replace an established carrier shipment or notify it.
        repository.saveInterface5OrderSummary(new ExpressQueryResult(
                orderId, "JD", "京东购物", StatusSemantic.COMPLETED,
                "2026-08-24 14:00:00", "订单已完成", "[]",
                "", phone, "interface5", "", "", "JingDong"), phone);
        ExpressItem afterOrderCompletion = repository.find(rowId);
        assertNotNull(afterOrderCompletion);
        assertEquals(StatusSemantic.TRANSIT, afterOrderCompletion.semantic);
        assertEquals("订单运输中", afterOrderCompletion.latestDetail);
        assertEquals(0, notifications.getActiveNotifications().length);

        repository.saveInterface5(new ExpressQueryResult(
                "JD0256719746857", "JD", "京东快递", StatusSemantic.COMPLETED,
                signedAt, "快件已签收", timedTracks(signedAt, "快件已签收"),
                "", phone, "interface5", "", "", "JingDong"), phone);
        ExpressItem completed = repository.find(rowId);
        assertNotNull(completed);
        assertEquals(StatusSemantic.COMPLETED, completed.semantic);
        assertEquals(1, notifications.getActiveNotifications().length);
        assertEquals("快件已签收",
                repository.kuaidi100Timeline("JD0256719746857").latestDetail);
        notifications.cancelAll();
    }

    @Test
    public void projectedInterface5OrderKeepsSourceAndK100SidecarsSeparateAndPrefersSource() {
        String orderId = "JDORDER000106";
        String displayWaybill = "SF0256719000106";
        ExpressItem order = insertOrder(orderId, "13900000106");
        assertTrue(repository.saveOrderProjection(
                order, "interface5", displayWaybill, "顺丰速运"));

        ExpressQueryResult kuaidi100 = timedResult(
                displayWaybill, "2026-08-24 12:00:00", "K100 轨迹", "kuaidi100");
        assertNotNull(repository.saveProjectedOrderTimeline(kuaidi100, "interface5"));
        assertNull(repository.accountTimeline(displayWaybill, "interface5"));
        assertEquals("K100 轨迹",
                repository.kuaidi100Timeline(displayWaybill).latestDetail);

        ExpressQueryResult source = timedResult(
                displayWaybill, "2026-08-24 11:00:00", "接口 5 轨迹",
                "interface5", "JingDong");
        assertNotNull(repository.saveProjectedOrderTimeline(source, "interface5"));
        assertEquals("接口 5 轨迹",
                repository.accountTimeline(displayWaybill, "interface5").latestDetail);
        assertEquals("K100 轨迹",
                repository.kuaidi100Timeline(displayWaybill).latestDetail);

        ExpressItem found = repository.find(order.rowId);
        ExpressItem byOrder = repository.findByWaybill(orderId, "interface5");
        List<ExpressItem> visible = repository.listVisible("interface5");
        assertNotNull(found);
        assertNotNull(byOrder);
        assertEquals(1, visible.size());
        // 列表归 feed（用户定 2026-09-05 晚）：两个 query 包都只在各自 sidecar 里，行上的头条不变。
        assertEquals(order.latestDetail, found.latestDetail);
        assertEquals(order.latestDetail, byOrder.latestDetail);
        assertEquals(order.latestDetail, visible.get(0).latestDetail);
        assertFalse(found.tracksJson.contains("接口 5 轨迹"));
        assertFalse(found.tracksJson.contains("K100 轨迹"));
        assertEquals("JingDong", found.sourceProvider);
        assertEquals("shunfeng", found.displayCourierCode());
    }

    @Test
    public void projectedCarrierTimelineCannotRegressTimedCompletedSource() {
        String orderId = "JDORDER000105";
        String phone = "13900000105";
        String signedAt = "2026-08-24 12:00:00";
        ContentValues values = shipmentValues(
                orderId, phone, "JD", "京东购物", "I5-JD", "JingDong",
                StatusSemantic.COMPLETED);
        values.put("statusEventTime", ExpressSourcePolicy.parseEventTime(signedAt));
        values.put("logisticsGmtModified", signedAt);
        values.put("lastLogisticDetail", "顺丰快件已签收");
        values.put("packageDyn", "[{\"time\":\"" + signedAt
                + "\",\"context\":\"顺丰快件已签收\"}]");
        long rowId = database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.EXPRESS_TABLE, null, values);
        ExpressItem order = repository.find(rowId);
        assertNotNull(order);
        assertTrue(repository.saveOrderProjection(
                order, "interface5", "SF0256719000105", "顺丰速运"));

        repository.saveKuaidi100Timeline(timedResult(
                "SF0256719000105", "2026-08-24 13:00:00", "快件运输中"));

        ExpressItem presented = repository.find(rowId);
        assertNotNull(presented);
        assertEquals(StatusSemantic.COMPLETED, presented.semantic);
        assertEquals("已签收", presented.displayStatus());
        assertEquals(signedAt, presented.latestTime);
        assertEquals("顺丰快件已签收", presented.latestDetail);
        assertTrue(presented.tracksJson.contains("顺丰快件已签收"));
        assertFalse(presented.tracksJson.contains("快件运输中"));
    }

    @Test
    public void projectedOrderKeepsTheNewerNonterminalCarrierPackage() {
        String orderId = "JDORDER000106";
        String phone = "13900000106";
        String dispatchAt = "2026-08-24 13:00:00";
        ContentValues values = shipmentValues(
                orderId, phone, "JD", "京东购物", "I5-JD", "JingDong",
                StatusSemantic.DELIVERY);
        values.put("statusEventTime", ExpressSourcePolicy.parseEventTime(dispatchAt));
        values.put("logisticsGmtModified", dispatchAt);
        values.put("lastLogisticDetail", "圆通快件正在派送");
        values.put("packageDyn", "[{\"time\":\"" + dispatchAt
                + "\",\"context\":\"圆通快件正在派送\"}]");
        long rowId = database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.EXPRESS_TABLE, null, values);
        ExpressItem order = repository.find(rowId);
        assertNotNull(order);
        assertTrue(repository.saveOrderProjection(
                order, "interface5", "YT0256719000106", "圆通速递"));

        repository.saveKuaidi100Timeline(timedResult(
                "YT0256719000106", "2026-08-24 12:00:00", "快件运输中"));

        ExpressItem presented = repository.find(rowId);
        assertNotNull(presented);
        assertEquals(StatusSemantic.DELIVERY, presented.semantic);
        assertEquals("派送中", presented.displayStatus());
        assertEquals(dispatchAt, presented.latestTime);
        assertEquals("圆通快件正在派送", presented.latestDetail);
        assertTrue(presented.tracksJson.contains("圆通快件正在派送"));
        assertFalse(presented.tracksJson.contains("快件运输中"));
    }

    @Test
    public void completedAccountPackagesRejectLaterWeakSummaries() {
        assertCompletedPackageSurvivesWeakSummary(
                "ZTTEST000034", "13900000034", "INTERFACE5");
        assertCompletedPackageSurvivesWeakSummary(
                "YTTEST000035", "13900000035", "INTERFACE6");
    }

    @Test
    public void automaticOwnershipPromotionReplacesTheManualDisplayPackage() {
        assertCompletedManualPackageSurvivesAccountOwnershipPromotion(
                "SFTEST000036", "13900000036", "interface5");
        assertCompletedManualPackageSurvivesAccountOwnershipPromotion(
                "SFTEST000037", "13900000037", "interface6");
    }

    @Test
    public void sameOwnerFeedSummaryRetainsOriginAndRejectsForeignHistory() {
        String waybill = "JDFEEDORIGIN0001";
        String phone = "13910000801";
        repository.bindPhoneLocally(phone, "interface5");
        String generation = repository.bindingGeneration(phone, "interface5");
        repository.saveAutomaticObservation(
                automaticPacket(waybill, phone, "interface5", "JD", "京东快递",
                        StatusSemantic.ORDERED, "已下单",
                        timedTracks("2026-09-01 12:00:00", "已下单"), "JingDong", "v5"),
                phone, ExpressSourcePolicy.SOURCE_INTERFACE5_JD, generation, 1_000L);
        repository.saveAutomaticObservation(
                automaticPacket(waybill, phone, "interface5", "JD", "京东快递",
                        StatusSemantic.COMPLETED, "已签收",
                        timedTracks("2026-09-06 12:00:00", "已签收"), "JingDong", "v5"),
                phone, ExpressSourcePolicy.SOURCE_INTERFACE5_JD, generation, 2_000L);
        ExpressItem owner = repository.findByWaybill(waybill, "interface5");
        assertNotNull(owner);
        assertEquals("已签收", owner.latestDetail);
        assertTrue(owner.tracksJson.contains("已下单"));
        assertTrue(me.pipi.deliveries.model.ExpressTimeline.isForeignPackage(owner.tracksJson,
                timedTracks("2025-11-18 12:00:00", "已签收")));

        String realWaybill = "JTFEEDORIGIN0001";
        repository.saveAccountTimeline(accountResultFor(
                TimelineSlot.V5_QUERY, realWaybill, phone, StatusSemantic.COMPLETED,
                "2026-09-06 12:00:00", "快件已签收",
                "[{\"time\":\"2026-09-06 12:00:00\",\"context\":\"快件已签收\"},"
                        + "{\"time\":\"2026-09-01 12:00:00\",\"context\":\"已揽收\"}]",
                "", "JingDong"), "interface5");
        assertTrue(repository.saveOrderProjection(owner, "interface5", realWaybill, "极兔速递"));
        ExpressItem signedProjection = repository.findByWaybill(waybill, "interface5");
        String detailTracks = repository.accountTimeline(realWaybill, "interface5").tracksJson;
        repository.saveInterface5OrderSummary(automaticPacket(
                waybill, phone, "interface5", "JD", "京东购物", StatusSemantic.COMPLETED,
                "您的订单已完成，期待您的评价",
                timedTracks("2026-09-08 12:00:00", "您的订单已完成，期待您的评价"),
                "JingDong", "v5"), phone, generation);
        ExpressItem afterOrderSummary = repository.findByWaybill(waybill, "interface5");
        assertEquals(realWaybill, afterOrderSummary.displayWaybill());
        assertEquals(signedProjection.latestDetail, afterOrderSummary.latestDetail);
        assertEquals(signedProjection.tracksJson, afterOrderSummary.tracksJson);
        assertEquals(detailTracks,
                repository.accountTimeline(realWaybill, "interface5").tracksJson);
    }

    @Test
    public void jdCarrierHistoryDropsShoppingCompletionAndRepairsLegacyRead() throws Exception {
        String waybill = "JDREVIEW0001";
        String phone = "13910000901";
        String review = "您的订单[测试商品]已完成，40京豆等您拿，完成评价即有机会获得，不要错过呦！";
        String signedTime = "2026-09-09 10:00:00";
        String reviewTime = "2026-09-09 11:00:00";
        String tracks = new org.json.JSONArray()
                .put(new org.json.JSONObject().put("time", reviewTime).put("context", review))
                .put(new org.json.JSONObject().put("time", signedTime).put("context", "真实承运商签收")
                        .put("statusCode", "107").put("_pipiStatusSource", "interface5"))
                .toString();
        repository.bindPhoneLocally(phone, "interface5");
        String generation = repository.bindingGeneration(phone, "interface5");
        ExpressQueryResult packet = accountResultFor("interface5", waybill, phone,
                StatusSemantic.COMPLETED, reviewTime, review, tracks, "", "JingDong");
        repository.saveAutomaticObservation(packet, phone, ExpressSourcePolicy.SOURCE_INTERFACE5,
                generation, ExpressSourcePolicy.parseEventTime(reviewTime));
        ExpressItem saved = repository.findByWaybill(waybill, "interface5");
        assertNotNull(saved);
        assertEquals("真实承运商签收", saved.latestDetail);
        assertEquals(signedTime, saved.latestTime);
        assertEquals(ExpressSourcePolicy.parseEventTime(signedTime), saved.statusEventTime);
        assertFalse(saved.tracksJson.contains("京豆"));

        ContentValues legacy = new ContentValues();
        legacy.put("lastLogisticDetail", review);
        legacy.put("logisticsGmtModified", reviewTime);
        legacy.put("statusEventTime", ExpressSourcePolicy.parseEventTime(reviewTime));
        legacy.put("signedRetainedAt", ExpressSourcePolicy.parseEventTime(reviewTime));
        legacy.put("packageDyn", tracks);
        database.getWritableDatabase().update(ExpressDatabase.EXPRESS_TABLE, legacy, "_id=?",
                new String[]{Long.toString(saved.rowId)});
        ExpressItem repaired = repository.find(saved.rowId);
        assertEquals("真实承运商签收", repaired.latestDetail);
        assertEquals(ExpressSourcePolicy.parseEventTime(signedTime), repaired.statusEventTime);
        assertEquals(ExpressSourcePolicy.parseEventTime(signedTime), repaired.signedRetainedAt);
        assertEquals(ExpressSourcePolicy.parseEventTime(signedTime),
                ExpressLifecycleTimes.signedAt(repaired, null, ExpressSourcePolicy.parseEventTime(reviewTime)));
        assertFalse(repaired.tracksJson.contains("京豆"));
        assertEquals(repaired.tracksJson, repository.find(saved.rowId).tracksJson);

        long independentAnchor = ExpressSourcePolicy.parseEventTime("2026-09-09 09:30:00");
        legacy.put("signedRetainedAt", independentAnchor);
        database.getWritableDatabase().update(ExpressDatabase.EXPRESS_TABLE, legacy, "_id=?",
                new String[]{Long.toString(saved.rowId)});
        assertEquals(independentAnchor, repository.find(saved.rowId).signedRetainedAt);

        repository.saveAccountTimeline(packet, "interface5");
        ExpressQueryResult query = repository.accountTimeline(waybill, "interface5");
        assertEquals("真实承运商签收", query.latestDetail);
        assertFalse(query.tracksJson.contains("京豆"));
        ContentValues legacyQuery = new ContentValues();
        legacyQuery.put("latest_detail", review);
        legacyQuery.put("latest_time", reviewTime);
        legacyQuery.put("tracks_json", tracks);
        database.getWritableDatabase().update(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE,
                legacyQuery, "normalized_waybill=?", new String[]{waybill});
        assertFalse(repository.accountTimeline(waybill, "interface5").tracksJson.contains("京豆"));
        assertFalse(repository.manualDetailTimelineAuthority(repaired).result.tracksJson.contains("京豆"));
    }

    @Test
    public void jdProjectionCleansExistingOrderHistoryButJdCarrierAloneDoesNot() throws Exception {
        String orderId = "123456789012345";
        String realWaybill = "YTOPROJECTEDREVIEW";
        String phone = "13910000902";
        String review = "您的订单" + orderId
                + "已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。";
        String reviewTime = "2026-09-09 11:00:00";
        String tracks = new org.json.JSONArray()
                .put(new org.json.JSONObject().put("time", reviewTime).put("context", review))
                .put(new org.json.JSONObject().put("time", "2026-09-09 10:00:00")
                        .put("context", "真实承运签收").put("statusCode", "107")
                        .put("_pipiStatusSource", "interface5"))
                .toString();
        repository.bindPhoneLocally(phone, "interface5");
        String generation = repository.bindingGeneration(phone, "interface5");
        repository.saveAutomaticObservation(accountResultFor("interface5", orderId, phone,
                StatusSemantic.COMPLETED, reviewTime, review, tracks, "", "JingDong"), phone,
                ExpressSourcePolicy.SOURCE_INTERFACE5_JD, generation,
                ExpressSourcePolicy.parseEventTime(reviewTime));
        ExpressItem order = repository.findByWaybill(orderId, "interface5");
        assertTrue(order.tracksJson.contains("本次购物"));
        assertTrue(repository.saveOrderProjection(order, "interface5", realWaybill, "圆通速递"));
        ExpressItem projected = repository.find(order.rowId);
        assertEquals(realWaybill, projected.displayWaybill());
        assertEquals("真实承运签收", projected.latestDetail);
        assertEquals(ExpressSourcePolicy.parseEventTime("2026-09-09 10:00:00"), projected.statusEventTime);
        repository.saveAccountTimeline(accountResultFor("v5_query", orderId, phone,
                StatusSemantic.COMPLETED, reviewTime, review, tracks, "", "JingDong"), "interface5");
        assertFalse(repository.accountTimeline(orderId, "interface5").tracksJson.contains("本次购物"));

        ExpressQueryResult other = new ExpressQueryResult("JDOTHERREVIEW", "JD", "京东快递",
                StatusSemantic.COMPLETED, ExpressSourcePolicy.parseEventTime(reviewTime),
                reviewTime, review, tracks, "", phone, "interface5", "", "", "Douyin");
        repository.saveAutomaticObservation(other, phone, ExpressSourcePolicy.SOURCE_INTERFACE5,
                generation, ExpressSourcePolicy.parseEventTime(reviewTime));
        ExpressItem otherOwner = repository.findByWaybill(other.waybill, "interface5");
        assertNotNull(otherOwner);
        assertEquals(review, otherOwner.latestDetail);
        assertTrue(otherOwner.tracksJson.contains("本次购物"));
    }

    @Test
    public void jdCarrierReviewOnlyIncrementCannotReplaceShipmentStatus() {
        String waybill = "JDREVIEWINCREMENT";
        String phone = "13910000903";
        String transitTime = "2026-09-09 10:00:00";
        repository.bindPhoneLocally(phone, "interface5");
        String generation = repository.bindingGeneration(phone, "interface5");
        repository.saveAutomaticObservation(accountResultFor("interface5", waybill, phone,
                StatusSemantic.TRANSIT, transitTime, "真实运输节点",
                timedTracks(transitTime, "真实运输节点"), "", "JingDong"), phone,
                ExpressSourcePolicy.SOURCE_INTERFACE5, generation, 1_000L);
        ExpressItem original = repository.findByWaybill(waybill, "interface5");
        String review = "您的订单[测试商品]已完成，40京豆等您拿，完成评价即有机会获得，不要错过呦！";
        repository.saveAutomaticObservation(accountResultFor("interface5", waybill, phone,
                StatusSemantic.COMPLETED, "2026-09-09 11:00:00", review,
                timedTracks("2026-09-09 11:00:00", review), "", "JingDong"), phone,
                ExpressSourcePolicy.SOURCE_INTERFACE5, generation, 2_000L);
        ExpressItem current = repository.find(original.rowId);
        assertEquals(original.semantic, current.semantic);
        assertEquals(original.statusEventTime, current.statusEventTime);
        assertEquals(original.latestDetail, current.latestDetail);
        assertEquals(original.latestTime, current.latestTime);
        assertEquals(original.tracksJson, current.tracksJson);
    }

    @Test
    public void projectedCarrierHistoryRejectsOrderCompletionBeforeFeedSigns() {
        String orderId = "JDORDERORIGIN0002";
        String realWaybill = "JTPROJECTED0002";
        String phone = "13910000803";
        repository.bindPhoneLocally(phone, "interface5");
        String generation = repository.bindingGeneration(phone, "interface5");
        repository.saveAutomaticObservation(
                automaticPacket(orderId, phone, "interface5", "JD", "京东快递",
                        StatusSemantic.TRANSIT, "快件运输中",
                        timedTracks("2026-09-05 12:00:00", "快件运输中"), "JingDong", "v5"),
                phone, ExpressSourcePolicy.SOURCE_INTERFACE5_JD, generation, 1_000L);
        ExpressItem owner = repository.findByWaybill(orderId, "interface5");
        assertTrue(repository.saveOrderProjection(owner, "interface5", realWaybill, "极兔速递"));
        repository.saveAccountTimeline(accountResultFor(
                TimelineSlot.V5_QUERY, realWaybill, phone, StatusSemantic.COMPLETED,
                "2026-09-06 12:00:00", "快件已签收",
                "[{\"time\":\"2026-09-06 12:00:00\",\"context\":\"快件已签收\"},"
                        + "{\"time\":\"2026-09-01 12:00:00\",\"context\":\"已揽收\"}]",
                "", "JingDong"), "interface5");
        ExpressItem before = repository.findByWaybill(orderId, "interface5");
        String detailTracks = repository.accountTimeline(realWaybill, "interface5").tracksJson;
        repository.saveInterface5OrderSummary(automaticPacket(
                orderId, phone, "interface5", "JD", "京东购物", StatusSemantic.COMPLETED,
                "您的订单已完成，期待您的评价",
                timedTracks("2026-09-08 12:00:00", "您的订单已完成，期待您的评价"),
                "JingDong", "v5"), phone, generation);
        ExpressItem after = repository.findByWaybill(orderId, "interface5");
        assertEquals(realWaybill, after.displayWaybill());
        assertEquals(before.sourceSemantic, after.sourceSemantic);
        assertEquals(before.latestDetail, after.latestDetail);
        assertEquals(before.latestTime, after.latestTime);
        assertEquals(before.tracksJson, after.tracksJson);
        assertEquals(detailTracks, repository.accountTimeline(realWaybill, "interface5").tracksJson);

        repository.saveAutomaticObservation(
                accountResultFor("interface5", realWaybill, phone, StatusSemantic.COMPLETED,
                        "2026-09-09 12:00:00", "承运商已签收",
                        timedTracks("2026-09-09 12:00:00", "承运商已签收"), "", "JingDong"),
                phone, ExpressSourcePolicy.SOURCE_INTERFACE5, generation, 3_000L);
        ExpressItem signed = repository.findByWaybill(realWaybill, "interface5");
        assertNotNull(signed);
        assertEquals(StatusSemantic.COMPLETED, signed.sourceSemantic);
        assertEquals("承运商已签收", signed.latestDetail);
    }

    @Test
    public void changedAutomaticSourceDoesNotInheritThePreviousFeedOrigin() {
        String waybill = "FEEDSOURCE0001";
        String phone = "13910000802";
        repository.bindPhoneLocally(phone, "interface5");
        String generation = repository.bindingGeneration(phone, "interface5");
        repository.saveAutomaticObservation(
                automaticPacket(waybill, phone, "interface5", "ZTO", "中通快递",
                        StatusSemantic.ORDERED, "已下单",
                        timedTracks("2026-09-01 12:00:00", "已下单"), "CaiNiao", "v5"),
                phone, ExpressSourcePolicy.SOURCE_INTERFACE5, generation, 1_000L);
        repository.saveAutomaticObservation(
                automaticPacket(waybill, phone, "interface5", "ZTO", "中通快递",
                        StatusSemantic.TRANSIT, "运输中",
                        timedTracks("2026-09-06 12:00:00", "运输中"), "DouYin", "v5"),
                phone, ExpressSourcePolicy.SOURCE_INTERFACE5, generation, 2_000L);
        ExpressItem owner = repository.findByWaybill(waybill, "interface5");
        assertNotNull(owner);
        assertTrue(owner.tracksJson.contains("运输中"));
        assertFalse(owner.tracksJson.contains("已下单"));
    }

    @Test
    public void firstQualifiedAutomaticPacketWinsAndV6MayOwnAnEmptyTimeline() {
        String waybill = "ZTOWNERSHIP0001";
        String phone6 = "13910000001";
        String phone5 = "13810000001";
        repository.bindPhoneLocally(phone6, "interface6");
        repository.bindPhoneLocally(phone5, "interface5");
        String generation6 = repository.bindingGeneration(phone6, "interface6");
        String generation5 = repository.bindingGeneration(phone5, "interface5");

        repository.saveAutomaticObservation(
                automaticPacket(waybill, phone6, "interface6", "ZTO", "中通快递",
                        StatusSemantic.TRANSIT, "接口六首包", "[]", "CaiNiao", "v6"),
                phone6, ExpressSourcePolicy.SOURCE_INTERFACE6, generation6, 1_000L);
        repository.saveAutomaticObservation(
                automaticPacket(waybill, phone5, "interface5", "YTO", "圆通速递",
                        StatusSemantic.DELIVERY, "接口五后包",
                        timedTracks("2026-08-29 12:00:00", "接口五后包"),
                        "CaiNiao", "v5"),
                phone5, ExpressSourcePolicy.SOURCE_INTERFACE5, generation5, 2_000L);

        ExpressItem owner = repository.findByWaybill(waybill, "interface6");
        assertNotNull(owner);
        assertEquals("INTERFACE6", owner.stateOwner);
        assertEquals("ZTO", owner.courierCode);
        assertEquals("接口六首包", owner.latestDetail);
        assertEquals("[]", owner.tracksJson);
        assertEquals(2, count(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                "normalized_waybill=?", new String[]{
                ExpressSourcePolicy.normalizeWaybill(waybill)}));
    }

    @Test
    public void rawChineseCarrierNameCanEstablishOwnershipAndLaterOmissionStillUpdates() {
        String waybill = "SFOWNERSHIPRAWNAME";
        String phone = "13810000011";
        repository.bindPhoneLocally(phone, "interface5");
        String generation = repository.bindingGeneration(phone, "interface5");
        ExpressQueryResult first = automaticPacket(
                waybill, phone, "interface5", "", "顺丰速运",
                StatusSemantic.TRANSIT, "首轮运输中",
                timedTracks("2026-08-29 12:00:00", "首轮运输中"),
                "CaiNiao", "v5")
                .withRawCarrierNameEvidence("顺丰速运");

        repository.saveAutomaticObservation(
                first, phone, ExpressSourcePolicy.SOURCE_INTERFACE5,
                generation, 1_000L);
        repository.saveAutomaticObservation(
                automaticPacket(
                        waybill, phone, "interface5", "", "",
                        StatusSemantic.DELIVERY, "后续派送中",
                        timedTracks("2026-08-29 13:00:00", "后续派送中"),
                        "CaiNiao", "v5"),
                phone, ExpressSourcePolicy.SOURCE_INTERFACE5,
                generation, 2_000L);

        ExpressItem updated = repository.findByWaybill(waybill, "interface5");
        assertNotNull(updated);
        assertEquals(StatusSemantic.DELIVERY, updated.semantic);
        assertEquals("后续派送中", updated.latestDetail);
        assertEquals("顺丰速运", updated.companyName);
        assertEquals("INTERFACE5", updated.stateOwner);
    }

    @Test
    public void missingRawCarrierCannotEstablishFirstAutomaticOwnership() {
        String waybill = "SFOWNERSHIPNORAW";
        String phone = "13810000012";
        repository.bindPhoneLocally(phone, "interface5");

        repository.saveAutomaticObservation(
                automaticPacket(
                        waybill, phone, "interface5", "", "",
                        StatusSemantic.TRANSIT, "运输中", "[]", "CaiNiao", "v5"),
                phone, ExpressSourcePolicy.SOURCE_INTERFACE5,
                repository.bindingGeneration(phone, "interface5"), 1_000L);

        assertNull(repository.findByWaybill(waybill, "interface5"));
        assertEquals(0, count(ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE,
                "normalized_waybill=?", new String[]{
                        ExpressSourcePolicy.normalizeWaybill(waybill)}));
    }

    @Test
    public void manualStructuredStatusEvidenceSurvivesDatabaseRoundTrip() {
        ExpressItem owner = insertOwner(
                "SFSTRUCTURED0001", "13900000061", StatusSemantic.TRANSIT);
        ExpressQueryResult manual = timedResult(
                owner.waybill, "2026-08-29 13:00:00", "快件待取件", "v4")
                .withManualStatusEvidence("待取件", true);

        repository.saveOwnerManualTimeline(
                owner, manual, owner.phone, "interface5", 2_000L, true);

        ManualTimelineAuthorityPolicy.Candidate restored =
                repository.manualTimelineAuthority(owner);
        assertNotNull(restored);
        assertTrue(restored.result.structuredStatusEvidence);
        assertEquals("待取件", restored.result.statusDescription);
        ExpressItem projected = repository.find(owner.rowId);
        assertEquals(manual.semantic, projected.semantic);
        assertEquals("待取件", projected.statusDescription);
    }

    @Test
    public void legacyMeizuSlotsAccumulateIntoCanonicalQueryWithoutLosingHistory() {
        for (String alias : new String[]{"v6_picker", "meizu_picker"}) {
            String waybill = "SFLEGACY" + alias.replace("_", "").toUpperCase(Locale.ROOT);
            repository.saveManualQueryResult(timedResult(waybill,
                    "2026-09-08 09:00:00", "Earlier event", "meizu"),
                    "0061", "interface5", 1_000L, false);
            ExpressItem owner = repository.findByWaybill(waybill, "interface5");
            ContentValues legacy = new ContentValues();
            legacy.put("provider", alias);
            legacy.put("complete", 1);
            database.getWritableDatabase().update(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                    legacy, "owner_row_id=?", new String[]{Long.toString(owner.rowId)});

            ManualTimelineAuthorityPolicy.Candidate cached =
                    repository.manualTimelineCandidate(owner, "v6_query");
            assertNotNull(cached);
            assertEquals("v6_query", cached.provider);
            assertEquals("v6_query", cached.result.timelineProvider);
            // The rename preserves stored data; the existing Meizu partial contract still applies.
            assertFalse(cached.complete);
            assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                    "owner_row_id=? AND complete=1", new String[]{Long.toString(owner.rowId)}));

            repository.saveOwnerManualTimeline(owner, timedResult(waybill,
                    "2026-09-08 10:00:00", "Later event", "v6_query"),
                    owner.phone, "interface5", 2_000L, false);
            ManualTimelineAuthorityPolicy.Candidate updated =
                    repository.manualTimelineCandidate(owner, "v6_query");
            assertEquals(2, me.pipi.deliveries.model.ExpressTimeline.parse(
                    updated.result.tracksJson, "", "").size());
            assertTrue(updated.result.tracksJson.contains("Earlier event"));
            assertTrue(updated.result.tracksJson.contains("Later event"));
            assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                    "owner_row_id=? AND provider='v6_query'",
                    new String[]{Long.toString(owner.rowId)}));
            repository.saveOwnerManualTimeline(owner, timedResult(waybill,
                    "2026-09-08 10:00:00", "Later event", alias),
                    owner.phone, "interface5", 3_000L, false);
            assertEquals(2, me.pipi.deliveries.model.ExpressTimeline.parse(
                    repository.manualTimelineCandidate(owner, "v6_query").result.tracksJson,
                    "", "").size());
            assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                    "owner_row_id=? AND provider=? AND success_at=3000",
                    new String[]{Long.toString(owner.rowId), alias}));
        }
    }

    @Test
    public void legacyMeizuRouteAndStickySelectionReadAsQueryAndNewRoutesAreCanonical() {
        String waybill = "SFLEGACYROUTE001";
        String route = "https://m.kuaidi100.com/result.jsp?nu=" + waybill;
        ExpressQueryResult result = new ExpressQueryResult(waybill, "SF", "SF Express",
                StatusSemantic.TRANSIT, "2026-09-08 09:00:00", "Earlier event",
                timedTracks("2026-09-08 09:00:00", "Earlier event"), route, "0061", "meizu");
        repository.saveManualQueryResult(result, "0061", "interface5", 1_000L, false);
        ExpressItem owner = repository.findByWaybill(waybill, "interface5");
        ContentValues legacy = new ContentValues();
        legacy.put("provider", "meizu_picker");
        database.getWritableDatabase().update(ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE,
                legacy, "owner_row_id=?", new String[]{Long.toString(owner.rowId)});
        String key = owner.rowId + "\u0000" + ExpressSourcePolicy.normalizeWaybill(waybill);
        context.getSharedPreferences("express_detail_selection", 0).edit()
                .putString(key, "v6_picker").commit();
        org.robolectric.util.ReflectionHelpers.setStaticField(
                ExpressRepository.class, "detailSelections", null);
        repository = new ExpressRepository(context, database);
        assertEquals(route, repository.meizuManualDetailUrl(owner));
        assertEquals("v6_query", ExpressRepository.preferredDetailProvider(owner));
        repository.saveOwnerManualTimeline(owner, result, owner.phone,
                "interface5", 2_000L, false);
        assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE,
                "owner_row_id=? AND provider='v6_query' AND success_at=2000",
                new String[]{Long.toString(owner.rowId)}));
        repository.rememberDetailSelection(owner, "meizu_picker");
        assertEquals("v6_query", context.getSharedPreferences("express_detail_selection", 0)
                .getString(key, ""));
    }

    @Test
    public void meizuPickerRouteStaysInItsProviderSidecarWithoutChangingOwnerRoute() {
        String waybill = "MEIZUPICKER0001";
        String route = "https://m.kuaidi100.com/result.jsp?nu=MEIZUPICKER0001";
        ExpressQueryResult meizu = new ExpressQueryResult(
                waybill, "ZTO", "中通快递", StatusSemantic.TRANSIT,
                "2026-08-29 12:00:00", "魅族 Picker 运输中",
                timedTracks("2026-08-29 12:00:00", "魅族 Picker 运输中"),
                route, "", "meizu");

        repository.saveManualQueryResult(
                meizu, "0061", "interface6", 1_000L, false);

        ExpressItem owner = repository.findByWaybill(waybill, "interface6");
        assertNotNull(owner);
        assertTrue(owner.manuallyAdded);
        assertNotNull(repository.findByWaybill(waybill, "interface5"));
        assertEquals(1, repository.listVisible("interface5").size());
        assertEquals(1, repository.listVisible("interface6").size());
        assertEquals("", owner.detailUrl);
        assertEquals("", owner.routeInterface);
        assertEquals(route, repository.meizuManualDetailUrl(owner));
        String source = owner.source;
        String stateOwner = owner.stateOwner;
        String sourceProvider = owner.sourceProvider;

        ExpressQueryResult oppo = timedResult(
                waybill, "2026-08-29 13:00:00", "OPPO 运输中", "oppo");
        repository.saveOwnerManualTimeline(
                owner, oppo, owner.phone, "interface5", 2_000L, false);

        ExpressItem afterOppo = repository.find(owner.rowId);
        assertEquals(source, afterOppo.source);
        assertEquals(stateOwner, afterOppo.stateOwner);
        assertEquals(sourceProvider, afterOppo.sourceProvider);
        assertEquals("", afterOppo.detailUrl);
        assertEquals(route, repository.meizuManualDetailUrl(afterOppo));
        assertEquals("v6_query", repository.manualTimelineAuthority(afterOppo).provider);
        assertEquals("v6_query", repository.manualDetailTimelineAuthority(afterOppo).provider);
        assertEquals(2, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=?", new String[]{Long.toString(owner.rowId)}));
    }

    @Test
    public void motoOnlyManualSuccessStillCreatesTheRowUnderInterface5() {
        String waybill = "MOTOONLY0000001";
        String time = relativeTime(-60L * 60L * 1000L);
        ExpressQueryResult moto = new ExpressQueryResult(
                waybill, "YTO", "圆通速递", StatusSemantic.PICKED, time, "快件已揽收",
                "[{\"time\":\"" + time + "\",\"context\":\"快件已揽收\"}]",
                "", "", TimelineSlot.V4_QUERY);

        ExpressItem saved = repository.saveManualQueryBatch(
                null,
                Arrays.asList(new ManualQuerySuccess(TimelineSlot.V4_QUERY, moto, 1_000L, false)),
                "0062", "interface5");

        assertNotNull(saved);
        assertTrue(saved.manuallyAdded);
        ExpressItem listed = repository.findByWaybill(waybill, "interface5");
        assertNotNull(listed);
        assertEquals(saved.rowId, listed.rowId);
        assertEquals(1, repository.listVisible("interface5").size());
    }

    @Test
    public void urlOnlyMeizuRoutePersistsWithoutCreatingATimelineCandidate() {
        String waybill = "MEIZUROUTEONLY001";
        String route = "https://m.kuaidi100.com/result.jsp?nu=MEIZUROUTEONLY001";
        ExpressQueryResult meizu = new ExpressQueryResult(
                waybill, "ZTO", "中通快递", StatusSemantic.UNKNOWN,
                "", "", "[]", route, "", "meizu");

        ExpressItem saved = repository.saveManualQueryBatch(
                null,
                Arrays.asList(new ManualQuerySuccess("meizu", meizu, 1_000L, false)),
                "0062", "interface6");

        assertNotNull(saved);
        assertTrue(saved.manuallyAdded);
        assertEquals(route, repository.meizuManualDetailUrl(saved));
        assertNull(repository.manualTimelineCandidate(saved, "meizu"));
        assertNull(repository.manualDetailTimelineAuthority(saved));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=?", new String[]{Long.toString(saved.rowId)}));
        assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE,
                "owner_row_id=?", new String[]{Long.toString(saved.rowId)}));

        database.close();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        ExpressItem restored = repository.findByWaybill(waybill, "interface6");
        assertNotNull(restored);
        assertEquals(route, repository.meizuManualDetailUrl(restored));
    }

    @Test
    public void urlOnlyMeizuOwnerAndRouteRollBackTogether() {
        String waybill = "MEIZUROUTEROLLBACK1";
        ExpressQueryResult meizu = urlOnlyMeizu(
                waybill, "https://m.kuaidi100.com/result.jsp?nu=" + waybill);
        database.getWritableDatabase().execSQL(
                "CREATE TRIGGER reject_manual_route BEFORE INSERT ON "
                        + ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE
                        + " BEGIN SELECT RAISE(ABORT,'forced route failure'); END");

        try {
            repository.saveManualQueryBatch(
                    null,
                    Arrays.asList(new ManualQuerySuccess("meizu", meizu, 1_000L, false)),
                    "1062", "interface6");
            org.junit.Assert.fail("Expected route write failure");
        } catch (SQLException expected) {
            // The first owner and its route atom share one transaction.
        }

        assertNull(repository.findByWaybill(waybill, "interface6"));
        assertEquals(0, count(ExpressDatabase.EXPRESS_TABLE, null, null));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE, null, null));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null, null));
    }

    @Test
    public void deletedOwnerRejectsLateMeizuRouteWithoutResurrection() {
        String waybill = "MEIZUROUTEDELETE01";
        ExpressQueryResult initial = urlOnlyMeizu(
                waybill, "https://m.kuaidi100.com/result.jsp?nu=initial");
        ExpressItem owner = repository.saveManualQueryBatch(
                null,
                Arrays.asList(new ManualQuerySuccess("meizu", initial, 1_000L, false)),
                "2062", "interface6");
        assertNotNull(owner);
        ExpressRepository.ManualQueryOwnerClaim claim =
                repository.captureManualQueryOwner(owner);
        assertNotNull(claim);

        repository.delete(owner.rowId);
        ExpressQueryResult late = urlOnlyMeizu(
                waybill, "https://m.kuaidi100.com/result.jsp?nu=late");
        repository.saveManualQueryBatch(
                owner, claim,
                Arrays.asList(new ManualQuerySuccess("meizu", late, 2_000L, false)),
                "2062", "interface6");

        assertNull(repository.findByWaybill(waybill, "interface6"));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE, null, null));
        assertEquals(0, count(ExpressDatabase.EXPRESS_TABLE, null, null));
    }

    @Test
    public void bindingGenerationChangeHidesRouteAndRejectsItsLateWrite() {
        String waybill = "MEIZUROUTEGEN0001";
        String phone = "13900000063";
        repository.bindPhoneLocally(phone, "interface5");
        String generation = repository.bindingGeneration(phone, "interface5");
        repository.saveAutomaticObservation(
                automaticPacket(
                        waybill, phone, "interface5", "ZTO", "中通快递",
                        StatusSemantic.TRANSIT, "菜鸟运输中", "[]", "CaiNiao", "v5"),
                phone, ExpressSourcePolicy.SOURCE_INTERFACE5, generation, 500L);
        ExpressItem owner = repository.findByWaybill(waybill, "interface5");
        assertNotNull(owner);
        ExpressRepository.ManualQueryOwnerClaim claim =
                repository.captureManualQueryOwner(owner);
        assertNotNull(claim);
        String firstRoute = "https://m.kuaidi100.com/result.jsp?nu=first";
        repository.saveOwnerManualQueryBatch(
                owner, claim,
                Arrays.asList(new ManualQuerySuccess(
                        "meizu", urlOnlyMeizu(waybill, firstRoute), 1_000L, false)),
                phone, "interface5");
        assertEquals(firstRoute, repository.meizuManualDetailUrl(owner));

        ContentValues changedGeneration = new ContentValues();
        changedGeneration.put("uuid", "replacement-generation");
        assertEquals(1, database.getWritableDatabase().update(
                ExpressDatabase.PHONE_TABLE, changedGeneration,
                "phone=? AND LOWER(sync_status)='interface5'", new String[]{phone}));
        assertEquals("", repository.meizuManualDetailUrl(owner));

        String lateRoute = "https://m.kuaidi100.com/result.jsp?nu=late";
        repository.saveOwnerManualQueryBatch(
                owner, claim,
                Arrays.asList(new ManualQuerySuccess(
                        "meizu", urlOnlyMeizu(waybill, lateRoute), 2_000L, false)),
                phone, "interface5");
        try (Cursor cursor = database.getReadableDatabase().query(
                ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE,
                new String[]{"detail_url", "success_at"}, "owner_row_id=?",
                new String[]{Long.toString(owner.rowId)}, null, null, null, "1")) {
            assertTrue(cursor.moveToFirst());
            assertEquals(firstRoute, cursor.getString(0));
            assertEquals(1_000L, cursor.getLong(1));
        }
    }

    @Test
    public void projectedJingDongOwnerScopesMeizuRouteToItsRealWaybill() {
        String orderId = "JDORDERMEIZU0001";
        String displayWaybill = "JDMEIZUWAYBILL001";
        String phone = "13900000064";
        repository.bindPhoneLocally(phone, "interface5");
        String generation = repository.bindingGeneration(phone, "interface5");
        repository.saveInterface5OrderSummary(
                automaticPacket(
                        orderId, phone, "interface5", "JD", "京东购物",
                        StatusSemantic.TRANSIT, "订单运输中", "[]", "JingDong", ""),
                phone, generation);
        ExpressItem order = repository.findByWaybill(orderId, "interface5");
        assertNotNull(order);
        assertTrue(repository.saveOrderProjection(
                order, "interface5", displayWaybill, "京东快递"));
        ExpressItem projected = repository.find(order.rowId);
        assertEquals(displayWaybill, projected.displayWaybill());
        ExpressRepository.ManualQueryOwnerClaim claim =
                repository.captureManualQueryOwner(projected);
        assertNotNull(claim);
        String route = "https://m.kuaidi100.com/result.jsp?nu=" + displayWaybill;

        repository.saveOwnerManualQueryBatch(
                projected, claim,
                Arrays.asList(new ManualQuerySuccess(
                        "meizu", urlOnlyMeizu(displayWaybill, route), 4_000L, false)),
                phone, "interface5");

        ExpressItem restored = repository.find(order.rowId);
        assertEquals(route, repository.meizuManualDetailUrl(restored));
        assertNull(repository.manualTimelineCandidate(restored, "meizu"));
        try (Cursor cursor = database.getReadableDatabase().query(
                ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE,
                new String[]{"normalized_waybill", "owner_source", "binding_generation"},
                "owner_row_id=?", new String[]{Long.toString(order.rowId)},
                null, null, null, "1")) {
            assertTrue(cursor.moveToFirst());
            assertEquals(displayWaybill, cursor.getString(0));
            assertEquals("I5-JD", cursor.getString(1));
            assertEquals(generation, cursor.getString(2));
        }
    }

    @Test
    public void currentPendingClaimPromotesUrlOnlyMeizuOwnerAndRouteTogether() {
        String waybill = "MEIZUROUTEPENDING1";
        ExpressQueryResult routeOnly = urlOnlyMeizu(
                waybill, "https://m.kuaidi100.com/result.jsp?nu=pending");
        assertTrue(repository.enqueuePendingManual(routeOnly, "3062", "interface6"));
        long claimAt = System.currentTimeMillis()
                + ExpressRepository.PENDING_QUERY_RETRY_INTERVAL_MS;
        PendingExpressQuery pending = repository.claimPendingManualQueries(
                claimAt, "interface6").get(0);

        ExpressItem saved = repository.savePendingManualQueryBatch(
                pending,
                Arrays.asList(new ManualQuerySuccess(
                        "meizu", routeOnly, 3_000L, false)));

        assertNotNull(saved);
        assertTrue(saved.manuallyAdded);
        assertEquals(routeOnly.detailUrl, repository.meizuManualDetailUrl(saved));
        assertNull(repository.manualTimelineCandidate(saved, "meizu"));
        assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE,
                "owner_row_id=?", new String[]{Long.toString(saved.rowId)}));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=?", new String[]{Long.toString(saved.rowId)}));
        assertEquals(0, count(ExpressDatabase.KUAIDI100_PENDING_TABLE,
                "normalized_waybill=?", new String[]{waybill}));
    }

    @Test
    public void pendingMeizuRouteCannotAttachToOwnerThatAppearedDuringQuery() {
        String waybill = "MEIZUROUTEPENDING2";
        String phone = "13900000065";
        repository.bindPhoneLocally(phone, "interface5");
        String generation = repository.bindingGeneration(phone, "interface5");
        ExpressQueryResult routeOnly = urlOnlyMeizu(
                waybill, "https://m.kuaidi100.com/result.jsp?nu=pending-race");
        assertTrue(repository.enqueuePendingManual(routeOnly, phone, "interface5"));
        long claimAt = System.currentTimeMillis()
                + ExpressRepository.PENDING_QUERY_RETRY_INTERVAL_MS;
        PendingExpressQuery pending = repository.claimPendingManualQueries(
                claimAt, "interface5").get(0);

        repository.saveAutomaticObservation(
                automaticPacket(
                        waybill, phone, "interface5", "ZTO", "中通快递",
                        StatusSemantic.TRANSIT, "自动同步运输中", "[]", "CaiNiao", "v5"),
                phone, ExpressSourcePolicy.SOURCE_INTERFACE5, generation, 500L);
        ExpressItem automaticOwner = repository.findByWaybill(waybill, "interface5");
        assertNotNull(automaticOwner);

        repository.savePendingManualQueryBatch(
                pending,
                Arrays.asList(new ManualQuerySuccess(
                        "meizu", routeOnly, 3_000L, false)));

        ExpressItem unchanged = repository.findByWaybill(waybill, "interface5");
        assertNotNull(unchanged);
        assertFalse(unchanged.manuallyAdded);
        assertEquals("", repository.meizuManualDetailUrl(unchanged));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE, null, null));
        assertEquals(1, count(ExpressDatabase.KUAIDI100_PENDING_TABLE,
                "normalized_waybill=?", new String[]{waybill}));
    }

    @Test
    public void untrustedMeizuUrlsNeverCreateAnOwnerOrRoute() {
        for (String route : Arrays.asList(
                "http://m.kuaidi100.com/result.jsp?nu=unsafe",
                "https://kuaidi100.com.evil.example/result.jsp?nu=unsafe")) {
            ExpressQueryResult result = urlOnlyMeizu("MEIZUROUTEUNSAFE", route);
            assertNull(repository.saveManualQueryBatch(
                    null,
                    Arrays.asList(new ManualQuerySuccess("meizu", result, 1_000L, false)),
                    "4062", "interface6"));
        }
        assertEquals(0, count(ExpressDatabase.EXPRESS_TABLE, null, null));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE, null, null));
    }

    @Test
    public void meizuSidecarCannotChangeAnAutomaticOwnersSourceIdentity() {
        String phone = "13900000062";
        repository.bindPhoneLocally(phone, "interface5");
        String generation = repository.bindingGeneration(phone, "interface5");
        repository.saveAutomaticObservation(
                automaticPacket(
                        "SFMEIZUOWNER001", phone, "interface5", "SF", "顺丰速运",
                        StatusSemantic.TRANSIT, "顺丰运输中", "[]", "ShunFeng", "v5"),
                phone, ExpressSourcePolicy.SOURCE_INTERFACE5, generation, 500L);
        ExpressItem owner = repository.findByWaybill("SFMEIZUOWNER001", "interface5");
        assertNotNull(owner);
        String route = "https://m.kuaidi100.com/result.jsp?nu=SFMEIZUOWNER001";
        ExpressQueryResult meizu = new ExpressQueryResult(
                owner.waybill, "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "2026-08-29 12:00:00", "Picker 运输中",
                timedTracks("2026-08-29 12:00:00", "Picker 运输中"),
                route, "", "meizu");

        repository.saveOwnerManualTimeline(
                owner, meizu, owner.phone, "interface5", 1_000L, false);

        ExpressItem refreshed = repository.find(owner.rowId);
        assertEquals(owner.source, refreshed.source);
        assertEquals(owner.stateOwner, refreshed.stateOwner);
        assertEquals(owner.sourceProvider, refreshed.sourceProvider);
        assertEquals(owner.detailUrl, refreshed.detailUrl);
        assertEquals(route, repository.meizuManualDetailUrl(refreshed));
    }

    @Test
    public void executedMissTransfersNewestCandidateAndHonorsCooldownAndCompletion() {
        String waybill = "ZTOWNERSHIP0002";
        String phone6 = "13910000002";
        String phone5 = "13810000002";
        repository.bindPhoneLocally(phone6, "interface6");
        repository.bindPhoneLocally(phone5, "interface5");
        String generation6 = repository.bindingGeneration(phone6, "interface6");
        String generation5 = repository.bindingGeneration(phone5, "interface5");
        repository.saveAutomaticObservation(
                automaticPacket(waybill, phone6, "interface6", "ZTO", "中通快递",
                        StatusSemantic.TRANSIT, "接口六", "[]", "CaiNiao", "v6"),
                phone6, ExpressSourcePolicy.SOURCE_INTERFACE6, generation6, 1_000L);
        repository.saveAutomaticObservation(
                automaticPacket(waybill, phone5, "interface5", "YTO", "圆通速递",
                        StatusSemantic.DELIVERY, "接口五候选", "[]", "CaiNiao", "v5"),
                phone5, ExpressSourcePolicy.SOURCE_INTERFACE5, generation5, 2_000L);

        // A candidate observation alone never steals ownership.
        assertEquals("INTERFACE6",
                repository.findByWaybill(waybill, "interface6").stateOwner);
        repository.recordAutomaticRefreshExecuted(
                ExpressSourcePolicy.SOURCE_INTERFACE6,
                seenByGeneration(generation6), 3_000L);
        assertEquals("INTERFACE5",
                repository.findByWaybill(waybill, "interface5").stateOwner);

        repository.saveAutomaticObservation(
                automaticPacket(waybill, phone6, "interface6", "ZTO", "中通快递",
                        StatusSemantic.TRANSIT, "接口六恢复", "[]", "CaiNiao", "v6"),
                phone6, ExpressSourcePolicy.SOURCE_INTERFACE6, generation6, 4_000L);
        repository.recordAutomaticRefreshExecuted(
                ExpressSourcePolicy.SOURCE_INTERFACE5,
                seenByGeneration(generation5), 5_000L);
        assertEquals("INTERFACE5",
                repository.findByWaybill(waybill, "interface5").stateOwner);

        long afterCooldown = 3_000L + AutomaticOwnershipPolicy.TAKEOVER_COOLDOWN_MS + 1L;
        repository.recordAutomaticRefreshExecuted(
                ExpressSourcePolicy.SOURCE_INTERFACE5,
                seenByGeneration(generation5), afterCooldown);
        assertEquals("INTERFACE6",
                repository.findByWaybill(waybill, "interface6").stateOwner);

        String completedWaybill = "ZTOWNERSHIP0003";
        repository.saveAutomaticObservation(
                automaticPacket(completedWaybill, phone6, "interface6", "ZTO", "中通快递",
                        StatusSemantic.COMPLETED, "已签收", "[]", "CaiNiao", "v6"),
                phone6, ExpressSourcePolicy.SOURCE_INTERFACE6, generation6, 6_000L);
        repository.saveAutomaticObservation(
                automaticPacket(completedWaybill, phone5, "interface5", "YTO", "圆通速递",
                        StatusSemantic.TRANSIT, "运输中", "[]", "CaiNiao", "v5"),
                phone5, ExpressSourcePolicy.SOURCE_INTERFACE5, generation5, 7_000L);
        repository.recordAutomaticRefreshExecuted(
                ExpressSourcePolicy.SOURCE_INTERFACE6,
                seenByGeneration(generation6), afterCooldown + 1L);
        assertEquals("INTERFACE6",
                repository.findByWaybill(completedWaybill, "interface6").stateOwner);
    }

    @Test
    public void explicitUnbindTransfersOnlyTheCandidateOwnRouteAtom() {
        String waybill = "ZTOWNERSHIP0004";
        String phone6 = "13910000004";
        String phone5 = "13810000004";
        repository.bindPhoneLocally(phone6, "interface6");
        repository.bindPhoneLocally(phone5, "interface5");
        repository.saveAutomaticObservation(
                automaticPacket(waybill, phone6, "interface6", "ZTO", "中通快递",
                        StatusSemantic.TRANSIT, "接口六", "[]", "CaiNiao", "v6"),
                phone6, ExpressSourcePolicy.SOURCE_INTERFACE6,
                repository.bindingGeneration(phone6, "interface6"), 1_000L);
        repository.saveAutomaticObservation(
                automaticPacket(waybill, phone5, "interface5", "YTO", "圆通速递",
                        StatusSemantic.DELIVERY, "接口五", "[]", "CaiNiao", "v5"),
                phone5, ExpressSourcePolicy.SOURCE_INTERFACE5,
                repository.bindingGeneration(phone5, "interface5"), 2_000L);

        repository.unbindPhone(phone6, "interface6");

        ExpressItem transferred = repository.findByWaybill(waybill, "interface5");
        assertNotNull(transferred);
        assertEquals("INTERFACE5", transferred.stateOwner);
        assertEquals("pipi-route:v5", transferred.detailUrl);
        assertEquals("v5", transferred.routeInterface);
        assertFalse("pipi-route:v6".equals(transferred.detailUrl));
    }

    @Test
    public void sameProviderBindingsKeepExactIssuerAndTransferOnExactUnbind() {
        String waybill = "ZTOWNERSHIP0008";
        String firstPhone = "13810000008";
        String secondPhone = "13710000008";
        repository.bindPhoneLocally(firstPhone, "interface5");
        repository.bindPhoneLocally(secondPhone, "interface5");
        repository.saveAutomaticObservation(
                automaticPacket(waybill, firstPhone, "interface5", "ZTO", "中通快递",
                        StatusSemantic.TRANSIT, "第一绑定", "[]", "CaiNiao", "v5"),
                firstPhone, ExpressSourcePolicy.SOURCE_INTERFACE5,
                repository.bindingGeneration(firstPhone, "interface5"), 1_000L);
        repository.saveAutomaticObservation(
                automaticPacket(waybill, secondPhone, "interface5", "ZTO", "中通快递",
                        StatusSemantic.DELIVERY, "第二绑定", "[]", "CaiNiao", "v5"),
                secondPhone, ExpressSourcePolicy.SOURCE_INTERFACE5,
                repository.bindingGeneration(secondPhone, "interface5"), 2_000L);
        assertEquals("第一绑定",
                repository.findByWaybill(waybill, "interface5").latestDetail);

        repository.unbindPhone(firstPhone, "interface5");

        ExpressItem transferred = repository.findByWaybill(waybill, "interface5");
        assertNotNull(transferred);
        assertEquals(secondPhone, transferred.phone);
        assertEquals("第二绑定", transferred.latestDetail);
        assertEquals(StatusSemantic.DELIVERY, transferred.semantic);
    }

    @Test
    public void staleBindingGenerationCannotWriteAfterRebind() {
        String waybill = "ZTOWNERSHIP0005";
        String phone = "13910000005";
        repository.bindPhoneLocally(phone, "interface6");
        String stale = repository.bindingGeneration(phone, "interface6");
        repository.unbindPhone(phone, "interface6");
        repository.bindPhoneLocally(phone, "interface6");
        assertFalse(stale.equals(repository.bindingGeneration(phone, "interface6")));

        repository.saveAutomaticObservation(
                automaticPacket(waybill, phone, "interface6", "ZTO", "中通快递",
                        StatusSemantic.TRANSIT, "迟到旧响应", "[]", "CaiNiao", "v6"),
                phone, ExpressSourcePolicy.SOURCE_INTERFACE6, stale, 1_000L);

        assertNull(repository.findByWaybill(waybill, "interface6"));
        assertEquals(0, count(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                "normalized_waybill=?", new String[]{
                        ExpressSourcePolicy.normalizeWaybill(waybill)}));
    }

    @Test
    public void projectedOrderRekeysProvisionalOwnerWithoutStealingRealWaybillOwner() {
        String orderId = "JDORDEROWNERSHIP0006";
        String realWaybill = "ZTOWNERSHIP0006";
        String phone5 = "13810000006";
        String phone6 = "13910000006";
        repository.bindPhoneLocally(phone5, "interface5");
        repository.bindPhoneLocally(phone6, "interface6");
        repository.saveAutomaticObservation(
                automaticPacket(realWaybill, phone6, "interface6", "ZTO", "中通快递",
                        StatusSemantic.TRANSIT, "真实运单接口六", "[]", "CaiNiao", "v6"),
                phone6, ExpressSourcePolicy.SOURCE_INTERFACE6,
                repository.bindingGeneration(phone6, "interface6"), 1_000L);
        repository.saveAutomaticObservation(
                automaticPacket(orderId, phone5, "interface5", "JD", "京东购物",
                        StatusSemantic.ORDERED, "订单已发货", "[]", "JingDong", "v5"),
                phone5, ExpressSourcePolicy.SOURCE_INTERFACE5_JD,
                repository.bindingGeneration(phone5, "interface5"), 2_000L);
        ExpressItem provisional = repository.findByWaybill(orderId, "interface5");
        assertNotNull(provisional);

        assertTrue(repository.saveOrderProjection(
                provisional, "interface5", realWaybill, "中通快递"));

        List<ExpressItem> visible = repository.listVisible("interface6");
        assertEquals(1, visible.size());
        assertEquals("INTERFACE6", visible.get(0).stateOwner);
        assertEquals(realWaybill, visible.get(0).waybill);
        assertEquals(0, count(ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE,
                "normalized_waybill=?", new String[]{
                        ExpressSourcePolicy.normalizeWaybill(orderId)}));
        assertEquals(1, count(ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE,
                "normalized_waybill=?", new String[]{
                        ExpressSourcePolicy.normalizeWaybill(realWaybill)}));
        assertEquals(2, count(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                "normalized_waybill=?", new String[]{
                        ExpressSourcePolicy.normalizeWaybill(realWaybill)}));
    }

    @Test
    public void jdCompletedEmptyOwnerFreezesDisplayButStillHealsNormalization() {
        String waybill = "JDOWNERSHIP0007";
        String phone = "13810000007";
        repository.bindPhoneLocally(phone, "interface5");
        String generation = repository.bindingGeneration(phone, "interface5");
        repository.saveAutomaticObservation(
                automaticPacket(waybill, phone, "interface5", "ZTO", "中通快递",
                        StatusSemantic.TRANSIT, "订单运输中", "[]", "JingDong", "v5"),
                phone, ExpressSourcePolicy.SOURCE_INTERFACE5, generation, 1_000L);
        ExpressItem owner = repository.findByWaybill(waybill, "interface5");
        repository.saveOwnerManualTimeline(owner, timedResult(
                waybill, "2026-08-29 12:00:00", "第三方运输节点"),
                phone, "interface5", 2_000L);
        repository.saveAutomaticObservation(
                automaticPacket(waybill, phone, "interface5", "ZTO", "中通快递",
                        StatusSemantic.COMPLETED, "已签收", "[]", "JingDong", "v5"),
                phone, ExpressSourcePolicy.SOURCE_INTERFACE5, generation, 3_000L);

        CarrierNormalization healed = new CarrierNormalization(
                "SF", "顺丰速运", "shunfeng", true, "table-v2");
        repository.saveAutomaticObservation(
                automaticPacket(waybill, phone, "interface5", "RAW", "原始名称",
                        StatusSemantic.TRANSIT, "后续运输节点",
                        timedTracks("2026-08-29 13:00:00", "后续运输节点"),
                        "JingDong", "v5").withCarrierNormalization(healed),
                phone, ExpressSourcePolicy.SOURCE_INTERFACE5, generation, 4_000L);

        ExpressItem frozen = repository.findByWaybill(waybill, "interface5");
        assertNotNull(frozen);
        assertEquals(StatusSemantic.COMPLETED, frozen.semantic);
        assertEquals("[]", frozen.tracksJson);
        assertEquals("已签收", frozen.latestDetail);
        assertEquals("SF", frozen.carrierNormalization.standardCode);
        assertEquals("zhongtong", frozen.displayCourierCode());
        assertEquals("中通快递", frozen.displayCompany());
        assertFalse(frozen.tracksJson.contains("后续运输节点"));
        assertFalse(frozen.tracksJson.contains("第三方运输节点"));
    }

    @Test
    public void newerStateCorrectionReplacesCancelledStatusAndHeadlineTogether() {
        String waybill = "ZTTEST000033";
        String phone = "13900000033";
        ContentValues values = shipmentValues(
                waybill, phone, "ZTO", "中通快递", "INTERFACE5", "CaiNiao",
                StatusSemantic.CANCELLED);
        values.put("lastLogisticDetail", "订单已取消");
        values.put("logisticsGmtModified", "2026-08-24 09:00:00");
        values.put("statusEventTime",
                ExpressSourcePolicy.parseEventTime("2026-08-24 09:00:00"));
        long rowId = database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.EXPRESS_TABLE, null, values);

        repository.bindPhoneLocally(phone, "interface5");
        repository.saveInterface5(new ExpressQueryResult(
                waybill, "ZTO", "中通快递", StatusSemantic.TRANSIT,
                "2026-08-24 12:00:00", "快件正在运输", "[]",
                "", phone, "interface5", "", "", "CaiNiao"), phone);

        ExpressItem corrected = repository.find(rowId);
        assertNotNull(corrected);
        assertEquals(StatusSemantic.TRANSIT, corrected.sourceSemantic);
        assertEquals(StatusSemantic.TRANSIT, corrected.semantic);
        assertEquals("快件正在运输", corrected.latestDetail);
    }

    @Test
    public void routeLessInterface5SummaryDoesNotCreateAnUnreadAccountTimeline() {
        String waybill = "ZTTEST000041";
        String time = "2026-08-24 09:00:00";
        ExpressQueryResult summary = new ExpressQueryResult(
                waybill, "ZTO", "中通快递", StatusSemantic.TRANSIT,
                time, "快件运输中",
                "[{\"time\":\"" + time + "\",\"context\":\"快件运输中\"}]",
                "", "13900000041", "", "", "", "CaiNiao");

        repository.bindPhoneLocally(summary.phone, "interface5");
        repository.saveInterface5(new ExpressQueryResult(
                summary.waybill, summary.courierCode, summary.companyName,
                summary.semantic, summary.statusEventTime,
                summary.latestTime, summary.latestDetail, summary.tracksJson,
                summary.detailUrl, summary.phone, "interface5", "", "",
                summary.sourceProvider), summary.phone);

        ExpressItem persisted = repository.findByWaybill(waybill, "interface5");
        assertNotNull(persisted);
        assertTrue(persisted.tracksJson.contains("快件运输中"));
        assertFalse(persisted.usesInterface5AccountTimeline());
        assertNull(repository.accountTimeline(waybill, "interface5"));
    }

    @Test
    public void routeLessInterface5CompletionKeepsSameProviderHistoryInOwnerRow() {
        String waybill = "ZTTEST000042";
        String phone = "13900000042";
        repository.bindPhoneLocally(phone, "interface5");
        repository.saveInterface5(accountResult(
                waybill, phone, StatusSemantic.TRANSIT,
                "2026-08-24 10:00:00", "快件到达转运中心",
                "[{\"time\":\"2026-08-24 10:00:00\","
                        + "\"context\":\"快件到达转运中心\"},"
                        + "{\"time\":\"2026-08-24 09:00:00\","
                        + "\"context\":\"快件已揽收\"}]",
                "", "CaiNiao"), phone);

        repository.saveInterface5(accountResult(
                waybill, phone, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "快件已签收",
                "[{\"time\":\"2026-08-24 12:00:00\","
                        + "\"context\":\"快件已签收\"}]",
                "", "cainiao"), phone);

        ExpressItem completed = repository.findByWaybill(waybill, "interface5");
        assertNotNull(completed);
        assertEquals(StatusSemantic.COMPLETED, completed.semantic);
        assertEquals("快件已签收", completed.latestDetail);
        assertTrue(completed.tracksJson.contains("快件已签收"));
        assertTrue(completed.tracksJson.contains("快件到达转运中心"));
        assertTrue(completed.tracksJson.contains("快件已揽收"));
        assertNull(repository.accountTimeline(waybill, "interface5"));
    }

    @Test
    public void routedInterface5CompletionPreservesFeedAndItsSeparateSidecar() {
        String waybill = "ZTTEST000043";
        String phone = "13900000043";
        String route = me.pipi.deliveries.model.CainiaoRoute.token("v5");
        repository.bindPhoneLocally(phone, "interface5");
        repository.saveInterface5(accountResult(
                waybill, phone, StatusSemantic.TRANSIT,
                "2026-08-24 10:00:00", "快件到达转运中心",
                "[{\"time\":\"2026-08-24 10:00:00\","
                        + "\"context\":\"快件到达转运中心\"},"
                        + "{\"time\":\"2026-08-24 09:00:00\","
                        + "\"context\":\"快件已揽收\"}]",
                route, "CaiNiao"), phone);

        repository.saveInterface5(accountResult(
                waybill, phone, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "快件已签收",
                "[{\"time\":\"2026-08-24 12:00:00\","
                        + "\"context\":\"快件已签收\"}]",
                route, "CaiNiao"), phone);

        ExpressItem queryOwner = repository.findByWaybill(waybill, "interface5");
        assertNull(repository.accountTimeline(waybill, "interface5"));
        assertTrue(repository.saveInterface5Query(accountResult(
                waybill, phone, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "快件已签收",
                "[{\"time\":\"2026-08-24 12:00:00\",\"context\":\"快件已签收\"},"
                        + "{\"time\":\"2026-08-24 10:00:00\",\"context\":\"快件到达转运中心\"},"
                        + "{\"time\":\"2026-08-24 09:00:00\",\"context\":\"快件已揽收\"}]",
                route, "CaiNiao"), queryOwner, repository.bindingGeneration(phone, "interface5")));

        ExpressItem ownerRow = repository.findByWaybill(waybill, "interface5");
        ExpressQueryResult sidecar = repository.accountTimeline(waybill, "interface5");
        assertNotNull(ownerRow);
        assertNotNull(sidecar);
        assertEquals(StatusSemantic.COMPLETED, sidecar.semantic);
        assertTrue(sidecar.tracksJson.contains("快件已签收"));
        assertTrue(sidecar.tracksJson.contains("快件到达转运中心"));
        assertTrue(sidecar.tracksJson.contains("快件已揽收"));
        assertTrue(ownerRow.tracksJson.contains("快件到达转运中心"));
        assertEquals(1, count(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE,
                "normalized_waybill=?", new String[]{
                        ExpressSourcePolicy.normalizeWaybill(waybill)}));
    }

    @Test
    public void routeLessHistoryDoesNotCrossProviderOrAccountSource() {
        String providerWaybill = "ZTTEST000044";
        String interface5Phone = "13900000044";
        repository.bindPhoneLocally(interface5Phone, "interface5");
        repository.saveInterface5(accountResult(
                providerWaybill, interface5Phone, StatusSemantic.TRANSIT,
                "2026-08-24 10:00:00", "旧来源运输节点",
                "[{\"time\":\"2026-08-24 10:00:00\","
                        + "\"context\":\"旧来源运输节点\"}]",
                "", "CaiNiao"), interface5Phone);
        repository.saveInterface5(accountResult(
                providerWaybill, interface5Phone, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "新来源签收节点",
                "[{\"time\":\"2026-08-24 12:00:00\","
                        + "\"context\":\"新来源签收节点\"}]",
                "", "JingDong"), interface5Phone);

        ExpressItem providerChanged = repository.findByWaybill(
                providerWaybill, "interface5");
        assertNotNull(providerChanged);
        assertTrue(providerChanged.tracksJson.contains("新来源签收节点"));
        assertFalse(providerChanged.tracksJson.contains("旧来源运输节点"));

        String sourceWaybill = "ZTTEST000045";
        String interface6Phone = "13900000045";
        repository.bindPhoneLocally(interface6Phone, "interface6");
        repository.bindPhoneLocally(interface6Phone, "interface5");
        repository.saveInterface6(accountResultFor("interface6",
                sourceWaybill, interface6Phone, StatusSemantic.TRANSIT,
                "2026-08-24 10:00:00", "接口六运输节点",
                "[{\"time\":\"2026-08-24 10:00:00\","
                        + "\"context\":\"接口六运输节点\"}]",
                "", "CaiNiao"), interface6Phone);
        repository.saveInterface5(accountResult(
                sourceWaybill, interface6Phone, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "接口五签收节点",
                "[{\"time\":\"2026-08-24 12:00:00\","
                        + "\"context\":\"接口五签收节点\"}]",
                "", "CaiNiao"), interface6Phone);

        ExpressItem interface5 = repository.findByWaybill(sourceWaybill, "interface5");
        ExpressItem interface6 = repository.findByWaybill(sourceWaybill, "interface6");
        assertNotNull(interface5);
        assertNotNull(interface6);
        assertFalse(interface5.tracksJson.contains("接口五签收节点"));
        assertTrue(interface5.tracksJson.contains("接口六运输节点"));
        assertTrue(interface6.tracksJson.contains("接口六运输节点"));
        assertFalse(interface6.tracksJson.contains("接口五签收节点"));
    }

    @Test
    public void completedRouteLessHistoryDoesNotCrossProvider() {
        String waybill = "ZTTEST000046";
        String phone = "13900000046";
        repository.bindPhoneLocally(phone, "interface5");
        repository.saveInterface5(accountResult(
                waybill, phone, StatusSemantic.COMPLETED,
                relativeTime(-2L * 60L * 60L * 1000L), "旧来源签收节点",
                "[{\"time\":\"" + relativeTime(-2L * 60L * 60L * 1000L) + "\","
                        + "\"context\":\"旧来源签收节点\"}]",
                "", "CaiNiao"), phone);

        repository.saveInterface5(accountResult(
                waybill, phone, StatusSemantic.COMPLETED,
                relativeTime(-60L * 60L * 1000L), "新来源签收节点",
                "[{\"time\":\"" + relativeTime(-60L * 60L * 1000L) + "\","
                        + "\"context\":\"新来源签收节点\"}]",
                "", "JingDong"), phone);

        ExpressItem refreshed = repository.findByWaybill(waybill, "interface5");
        assertNotNull(refreshed);
        assertEquals(StatusSemantic.COMPLETED, refreshed.semantic);
        assertTrue(refreshed.tracksJson.contains("新来源签收节点"));
        assertFalse(refreshed.tracksJson.contains("旧来源签收节点"));
    }

    @Test
    public void completedRouteLessHistoryRequiresKnownProviderOnBothResponses() {
        for (int index = 0; index < 2; index += 1) {
            String waybill = "ZTTEST000047" + index;
            String phone = "1390000004" + (7 + index);
            String cachedProvider = index == 0 ? "" : "CaiNiao";
            String refreshedProvider = index == 0 ? "CaiNiao" : "";
            repository.bindPhoneLocally(phone, "interface5");
            repository.saveInterface5(accountResult(
                    waybill, phone, StatusSemantic.COMPLETED,
                    relativeTime(-2L * 60L * 60L * 1000L), "旧记录" + index,
                    "[{\"time\":\"" + relativeTime(-2L * 60L * 60L * 1000L) + "\","
                            + "\"context\":\"旧记录" + index + "\"}]",
                    "", cachedProvider), phone);
            repository.saveInterface5(accountResult(
                    waybill, phone, StatusSemantic.COMPLETED,
                    relativeTime(-60L * 60L * 1000L), "新记录" + index,
                    "[{\"time\":\"" + relativeTime(-60L * 60L * 1000L) + "\","
                            + "\"context\":\"新记录" + index + "\"}]",
                    "", refreshedProvider), phone);

            ExpressItem refreshed = repository.findByWaybill(waybill, "interface5");
            assertNotNull(refreshed);
            assertTrue(refreshed.tracksJson.contains("新记录" + index));
            assertFalse(refreshed.tracksJson.contains("旧记录" + index));
        }
    }

    @Test
    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    public void failedSidecarWriteDoesNotPublishAndCommittedPackageFeedsEveryRead()
            throws Exception {
        ExpressItem owner = insertOwner(
                "SFTEST000051", "13900000051", StatusSemantic.WAITING_PICKUP);
        long eventTime = System.currentTimeMillis();
        ExpressQueryResult completed = structuredCompletedMotoResult(owner.waybill, eventTime);
        AtomicInteger broadcasts = new AtomicInteger();
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context ignored, Intent intent) {
                if (ExpressRepository.ACTION_CHANGED.equals(intent.getAction())) {
                    broadcasts.incrementAndGet();
                }
            }
        };
        context.registerReceiver(receiver, new IntentFilter(ExpressRepository.ACTION_CHANGED));
        try {
            database.getWritableDatabase().execSQL(
                    "CREATE TRIGGER reject_manual_sidecar BEFORE INSERT ON "
                            + ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE
                            + " BEGIN SELECT RAISE(ABORT,'forced test failure'); END");
            try {
                repository.saveOwnerManualTimeline(
                        owner, completed, owner.phone, "interface5");
                org.junit.Assert.fail("Expected sidecar write failure");
            } catch (SQLException expected) {
                // The transaction must roll back before any projected state is published.
            }

            assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                    "owner_row_id=?", new String[]{Long.toString(owner.rowId)}));
            assertEquals(StatusSemantic.WAITING_PICKUP,
                    repository.find(owner.rowId).semantic);
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertEquals(0, broadcasts.get());

            database.getWritableDatabase().execSQL("DROP TRIGGER reject_manual_sidecar");
            ExpressItem saved = repository.saveOwnerManualTimeline(
                    owner, completed, owner.phone, "interface5");
            ExpressItem found = repository.find(owner.rowId);
            ExpressItem byWaybill = repository.findByWaybill(
                    owner.waybill, "interface5");
            List<ExpressItem> visible = repository.listVisible("interface5");

            assertProjectedPackage(saved, completed);
            assertProjectedPackage(found, completed);
            assertProjectedPackage(byWaybill, completed);
            assertEquals(1, visible.size());
            assertProjectedPackage(visible.get(0), completed);
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertEquals(1, broadcasts.get());
        } finally {
            context.unregisterReceiver(receiver);
        }
    }

    @Test
    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    public void newManualOwnerAndSidecarCommitOrRollbackTogether() throws Exception {
        String waybill = "SFTEST000061";
        ExpressQueryResult completed = structuredCompletedMotoResult(
                waybill, System.currentTimeMillis());
        AtomicInteger broadcasts = new AtomicInteger();
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context ignored, Intent intent) {
                if (ExpressRepository.ACTION_CHANGED.equals(intent.getAction())) {
                    broadcasts.incrementAndGet();
                }
            }
        };
        context.registerReceiver(receiver, new IntentFilter(ExpressRepository.ACTION_CHANGED));
        try {
            database.getWritableDatabase().execSQL(
                    "CREATE TRIGGER reject_new_manual_sidecar BEFORE INSERT ON "
                            + ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE
                            + " BEGIN SELECT RAISE(ABORT,'forced test failure'); END");
            try {
                repository.saveManualQueryResult(completed, "1515", "interface6");
                org.junit.Assert.fail("Expected sidecar write failure");
            } catch (SQLException expected) {
                // Owner identity and its first visible provider package share one transaction.
            }

            assertEquals(0, count(ExpressDatabase.EXPRESS_TABLE, null, null));
            assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null, null));
            assertNull(repository.findByWaybill(waybill, "interface6"));
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertEquals(0, broadcasts.get());

            database.getWritableDatabase().execSQL("DROP TRIGGER reject_new_manual_sidecar");
            repository.saveManualQueryResult(completed, "1515", "interface6");

            ExpressItem saved = repository.findByWaybill(waybill, "interface6");
            assertProjectedPackage(saved, completed);
            assertTrue(saved.manuallyAdded);
            assertEquals("1515", saved.phone);
            assertEquals(1, count(ExpressDatabase.EXPRESS_TABLE, null, null));
            assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null, null));
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertEquals(1, broadcasts.get());
        } finally {
            context.unregisterReceiver(receiver);
        }
    }

    @Test
    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    public void wholeManualRoundRollsBackTogetherAndPublishesOnce() throws Exception {
        String waybill = "ZTBATCH000001";
        ExpressQueryResult picker = timedResult(
                waybill, "2026-09-01 09:00:00", "Picker 运输中", "meizu");
        ExpressQueryResult moto = timedResult(
                waybill, "2026-09-01 10:00:00", "Moto 运输中 1", "v4");
        ExpressQueryResult motoLater = timedResult(
                waybill, "2026-09-01 11:00:00", "Moto 运输中 2", "v4");
        List<ManualQuerySuccess> successes = Arrays.asList(
                new ManualQuerySuccess("meizu", picker, 1_000L, false),
                new ManualQuerySuccess("v4", moto, 2_000L, false),
                new ManualQuerySuccess("v4", motoLater, 3_000L, false));
        AtomicInteger broadcasts = new AtomicInteger();
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context ignored, Intent intent) {
                if (ExpressRepository.ACTION_CHANGED.equals(intent.getAction())) {
                    broadcasts.incrementAndGet();
                }
            }
        };
        context.registerReceiver(receiver, new IntentFilter(ExpressRepository.ACTION_CHANGED));
        try {
            database.getWritableDatabase().execSQL(
                    "CREATE TRIGGER reject_second_manual_provider BEFORE INSERT ON "
                            + ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE
                            + " WHEN NEW.latest_detail='Moto 运输中 2'"
                            + " BEGIN SELECT RAISE(ABORT,'forced batch failure'); END");
            try {
                repository.saveManualQueryBatch(
                        null, successes, "1234", "interface5");
                org.junit.Assert.fail("Expected batch write failure");
            } catch (SQLException expected) {
                // The first owner and every provider package belong to one transaction.
            }

            assertEquals(0, count(ExpressDatabase.EXPRESS_TABLE, null, null));
            assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null, null));
            assertEquals(0, count(ExpressDatabase.V4_TIMELINE_TABLE, null, null));
            assertNull(repository.findByWaybill(waybill, "interface5"));
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertEquals(0, broadcasts.get());

            database.getWritableDatabase().execSQL(
                    "DROP TRIGGER reject_second_manual_provider");
            ExpressItem saved = repository.saveManualQueryBatch(
                    null, successes, "1234", "interface5");

            assertNotNull(saved);
            assertTrue(saved.manuallyAdded);
            assertEquals("I5-K100", saved.stateOwner);
            assertEquals(2, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                    "owner_row_id=?", new String[]{Long.toString(saved.rowId)}));
            ManualTimelineAuthorityPolicy.Candidate pickerCache =
                    repository.manualTimelineCandidate(saved, "meizu");
            ManualTimelineAuthorityPolicy.Candidate motoCache =
                    repository.manualTimelineCandidate(saved, "v4");
            assertNotNull(pickerCache);
            assertNotNull(motoCache);
            assertTrue(pickerCache.result.tracksJson.contains("Picker 运输中"));
            assertFalse(pickerCache.result.tracksJson.contains("Moto 运输中 1"));
            assertFalse(pickerCache.result.tracksJson.contains("Moto 运输中 2"));
            assertTrue(motoCache.result.tracksJson.contains("Moto 运输中 1"));
            assertTrue(motoCache.result.tracksJson.contains("Moto 运输中 2"));
            assertFalse(motoCache.result.tracksJson.contains("Picker 运输中"));
            assertEquals("v4_query", repository.manualTimelineAuthority(saved).provider);
            // 列表/状态归 Picker，详情按「完整性 → 有效节点数」独立选：moto 的两条压过 Picker
            // 的一条（用户定 2026-09-04，三端同口径）。
            assertEquals("v4_query", repository.manualDetailTimelineAuthority(saved).provider);
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertEquals(1, broadcasts.get());
        } finally {
            context.unregisterReceiver(receiver);
        }
    }

    @Test
    public void deletedManualOwnerRejectsItsInFlightBatchWithoutResurrection() {
        String waybill = "ZTBATCH000002";
        ExpressQueryResult initial = timedResult(
                waybill, "2026-09-01 09:00:00", "初始轨迹", "v4");
        ExpressItem owner = repository.saveManualQueryBatch(
                null,
                Arrays.asList(new ManualQuerySuccess("v4", initial, 1_000L, false)),
                "2234", "interface6");
        assertNotNull(owner);

        repository.delete(owner.rowId);
        ExpressQueryResult late = timedResult(
                waybill, "2026-09-01 11:00:00", "迟到轨迹", "v4");
        repository.saveManualQueryBatch(
                owner,
                Arrays.asList(new ManualQuerySuccess("v4", late, 2_000L, false)),
                "2234", "interface6");

        assertNull(repository.findByWaybill(waybill, "interface6"));
        assertEquals(0, count(ExpressDatabase.EXPRESS_TABLE,
                "normalizedMailNo=?", new String[]{waybill}));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "normalized_waybill=?", new String[]{waybill}));
    }

    @Test
    public void removedPendingClaimCannotPromoteItsInFlightBatch() {
        String waybill = "ZTBATCH000003";
        assertTrue(repository.enqueuePendingManual(
                waybill, "3234", "interface6"));
        long claimAt = System.currentTimeMillis()
                + ExpressRepository.PENDING_QUERY_RETRY_INTERVAL_MS;
        List<PendingExpressQuery> claimed = repository.claimPendingManualQueries(
                claimAt, "interface6");
        assertEquals(1, claimed.size());
        PendingExpressQuery pending = claimed.get(0);
        assertEquals(claimAt, pending.lastAttemptAt);

        repository.removePendingManual(waybill, "interface6");
        ExpressQueryResult late = timedResult(
                waybill, "2026-09-01 12:00:00", "迟到待查询轨迹", "v4");
        repository.savePendingManualQueryBatch(
                pending,
                Arrays.asList(new ManualQuerySuccess("v4", late, 3_000L, false)));

        assertNull(repository.findByWaybill(waybill, "interface6"));
        assertEquals(0, count(ExpressDatabase.EXPRESS_TABLE,
                "normalizedMailNo=?", new String[]{waybill}));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "normalized_waybill=?", new String[]{waybill}));
    }

    @Test
    public void currentPendingClaimPromotesOwnerAndSidecarTogether() {
        String waybill = "ZTBATCH000004";
        assertTrue(repository.enqueuePendingManual(
                waybill, "4234", "interface6"));
        long claimAt = System.currentTimeMillis()
                + ExpressRepository.PENDING_QUERY_RETRY_INTERVAL_MS;
        PendingExpressQuery pending = repository.claimPendingManualQueries(
                claimAt, "interface6").get(0);
        ExpressQueryResult result = timedResult(
                waybill, "2026-09-01 13:00:00", "待查询已恢复", "v4");

        ExpressItem saved = repository.savePendingManualQueryBatch(
                pending,
                Arrays.asList(new ManualQuerySuccess("v4", result, 4_000L, false)));

        assertNotNull(saved);
        assertTrue(saved.manuallyAdded);
        assertEquals("4234", saved.phone);
        assertEquals(0, count(ExpressDatabase.KUAIDI100_PENDING_TABLE,
                "normalized_waybill=?", new String[]{waybill}));
        assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=?", new String[]{Long.toString(saved.rowId)}));
    }

    @Test
    public void supersededPendingGenerationRejectsTheOlderBatch() {
        String waybill = "ZTBATCH000005";
        assertTrue(repository.enqueuePendingManual(
                waybill, "5234", "interface6"));
        long firstClaimAt = System.currentTimeMillis()
                + ExpressRepository.PENDING_QUERY_RETRY_INTERVAL_MS;
        PendingExpressQuery first = repository.claimPendingManualQueries(
                firstClaimAt, "interface6").get(0);
        long secondClaimAt = firstClaimAt
                + ExpressRepository.PENDING_QUERY_RETRY_INTERVAL_MS;
        PendingExpressQuery second = repository.claimPendingManualQueries(
                secondClaimAt, "interface6").get(0);
        ExpressQueryResult result = timedResult(
                waybill, "2026-09-01 14:00:00", "新一轮待查询轨迹", "v4");
        List<ManualQuerySuccess> successes = Arrays.asList(
                new ManualQuerySuccess("v4", result, 5_000L, false));

        assertNull(repository.savePendingManualQueryBatch(first, successes));
        assertNull(repository.findByWaybill(waybill, "interface6"));
        assertEquals(1, count(ExpressDatabase.KUAIDI100_PENDING_TABLE,
                "normalized_waybill=?", new String[]{waybill}));

        ExpressItem saved = repository.savePendingManualQueryBatch(second, successes);
        assertNotNull(saved);
        assertEquals(0, count(ExpressDatabase.KUAIDI100_PENDING_TABLE,
                "normalized_waybill=?", new String[]{waybill}));
    }

    @Test
    public void manualBatchIsAtomicAndItsTerminalPackageNeverFreezesTheFeedRow() {
        String waybill = "JDBATCH000006";
        String phone = "13900000066";
        repository.bindPhoneLocally(phone, "interface5");
        String generation = repository.bindingGeneration(phone, "interface5");
        repository.saveAutomaticObservation(
                automaticPacket(
                        waybill, phone, "interface5", "ZTO", "中通快递",
                        StatusSemantic.TRANSIT, "京东运输中", "[]", "JingDong", "v5"),
                phone, ExpressSourcePolicy.SOURCE_INTERFACE5, generation, 1_000L);
        ExpressItem owner = repository.findByWaybill(waybill, "interface5");
        assertNotNull(owner);
        ExpressQueryResult pickerTransit = timedResult(
                waybill, "2026-09-01 15:00:00", "Picker 运输中", "meizu");
        ExpressQueryResult completed = timedResult(
                waybill, "2026-09-01 16:00:00", "K100 已签收", "kuaidi100");
        List<ManualQuerySuccess> successes = Arrays.asList(
                new ManualQuerySuccess("meizu", pickerTransit, 6_000L, false),
                new ManualQuerySuccess("kuaidi100", completed, 7_000L, true));

        database.getWritableDatabase().execSQL(
                "CREATE TRIGGER reject_terminal_manual_provider BEFORE INSERT ON "
                        + ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE
                        + " WHEN NEW.latest_detail='K100 已签收'"
                        + " BEGIN SELECT RAISE(ABORT,'forced terminal failure'); END");
        try {
            repository.saveOwnerManualQueryBatch(
                    owner, successes, phone, "interface5");
            org.junit.Assert.fail("Expected terminal batch write failure");
        } catch (SQLException expected) {
            // A staged provider package cannot latch terminal presentation by itself.
        }
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=?", new String[]{Long.toString(owner.rowId)}));
        assertEquals(0, automaticDisplayFrozen(waybill));

        database.getWritableDatabase().execSQL(
                "DROP TRIGGER reject_terminal_manual_provider");
        ExpressItem saved = repository.saveOwnerManualQueryBatch(
                owner, successes, phone, "interface5");

        assertNotNull(saved);
        assertEquals(StatusSemantic.TRANSIT, saved.semantic);
        assertEquals(StatusSemantic.COMPLETED,
                repository.manualDetailTimelineAuthority(saved).result.semantic);
        // 用户定 2026-09-05 晚：冻结只由 feed 自己的已签收触发，手动链的终态包不再冻结行。
        assertEquals(0, automaticDisplayFrozen(waybill));
    }

    private void saveAndClaimAgain(ExpressItem owner) {
        repository.saveOwnerManualTimeline(
                owner, timedResult(owner.waybill,
                        "2026-08-24 09:00:00", "快件运输中"),
                owner.phone, "interface5");
        ManualTimelineAuthorityPolicy.Candidate authority =
                repository.manualTimelineAuthority(owner);
        assertNotNull(authority);
        assertNotNull(repository.claimManualTimelinePoll(
                owner, authority.successAt + ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS));
    }

    private ExpressItem insertOwner(
            String waybill, String phone, StatusSemantic semantic) {
        ContentValues values = shipmentValues(
                waybill, phone, "SF", "顺丰速运", "INTERFACE5", "ShunFeng", semantic);
        long rowId = database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.EXPRESS_TABLE, null, values);
        ExpressItem item = repository.find(rowId);
        assertNotNull(item);
        return item;
    }

    @Test
    public void borrowedSignedStatusSurvivesNewPickerAndRepositoryRecreationWithUnknownFeed() {
        String waybill = "BORROWEDSIGNED0001";
        String phone = "13900000001";
        repository.bindPhoneLocally(phone, "interface5");
        repository.saveAutomaticObservation(automaticPacket(waybill, phone, "interface5",
                "ZTO", "中通快递", StatusSemantic.TRANSIT, "快件已揽收",
                timedTracks(relativeTime(-120000L), "快件已揽收"), "DouYin", "v5"),
                phone, ExpressSourcePolicy.SOURCE_INTERFACE5,
                repository.bindingGeneration(phone, "interface5"), System.currentTimeMillis());
        ExpressItem established = repository.findByWaybill(waybill, "interface5");
        assertNotNull(established);
        long rowId = established.rowId;
        ContentValues unknown = new ContentValues();
        unknown.put("logsiticsStatus", StatusSemantic.UNKNOWN.storageCode);
        unknown.put("logisticsStatusDesc", "");
        unknown.put("statusEventTime", 0L);
        database.getWritableDatabase().update(ExpressDatabase.EXPRESS_TABLE, unknown,
                "_id=?", new String[]{Long.toString(rowId)});
        ExpressItem owner = repository.find(rowId);
        assertEquals(StatusSemantic.UNKNOWN, owner.semantic);
        assertNotNull(repository.captureManualQueryOwner(owner));
        long signedAt = System.currentTimeMillis() - 60000L;
        ExpressQueryResult signed = structuredCompletedMotoResult(waybill, signedAt);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess("v4", signed, signedAt, false)), "", "interface5");
        ExpressItem borrowed = repository.find(rowId);
        assertEquals(StatusSemantic.COMPLETED, borrowed.semantic);
        assertEquals(StatusSemantic.UNKNOWN, borrowed.sourceSemantic);
        assertEquals(signedAt, borrowed.statusEventTime);
        assertTrue(borrowed.signedRetainedAt > 0L);
        String newerTime = relativeTime(0L);
        ExpressQueryResult picker = new ExpressQueryResult(waybill, "ZTO", "中通快递",
                StatusSemantic.TRANSIT, System.currentTimeMillis(), newerTime, "较新的运输节点",
                timedTracks(newerTime, "较新的运输节点"), "", "", "meizu", "", "", "")
                .withManualStatusEvidence("运输中", true);
        repository.saveOwnerManualQueryBatch(borrowed, repository.captureManualQueryOwner(borrowed),
                List.of(new ManualQuerySuccess("meizu", picker, System.currentTimeMillis(), false)),
                "", "interface5");
        database.close();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        ExpressItem restored = repository.find(rowId);
        assertEquals(StatusSemantic.UNKNOWN, restored.sourceSemantic);
        assertEquals(StatusSemantic.COMPLETED, restored.semantic);
        assertEquals(signedAt, restored.statusEventTime);
        assertEquals(owner.tracksJson, restored.tracksJson);
        assertEquals(owner.latestDetail, restored.latestDetail);
    }

    @Test
    public void statusOnlyDonorPersistsWithoutReplacingTheManualTimelineOrCreatingAnEmptyOwner() {
        String waybill = "STATUSONLY0001";
        ExpressQueryResult history = new ExpressQueryResult(waybill, "ZTO", "中通快递",
                StatusSemantic.UNKNOWN, 0L, relativeTime(-60000L), "快件已揽收",
                timedTracks(relativeTime(-60000L), "快件已揽收"), "", "", "meizu", "", "", "");
        ExpressItem owner = repository.saveManualQueryBatch(null,
                List.of(new ManualQuerySuccess("meizu", history, System.currentTimeMillis(), false)),
                "", "interface5");
        assertEquals(StatusSemantic.UNKNOWN, owner.semantic);
        ExpressQueryResult status = new ExpressQueryResult(waybill, "ZTO", "中通快递",
                StatusSemantic.COMPLETED, 0L, "", "", "[]", "", "", "v4", "", "", "")
                .withManualStatusEvidence("已签收", true);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess("v4", status, System.currentTimeMillis(), false)),
                "", "interface5");
        database.close();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        ExpressItem restored = repository.find(owner.rowId);
        assertEquals(StatusSemantic.COMPLETED, restored.semantic);
        assertEquals(0L, restored.statusEventTime);
        assertEquals(history.tracksJson, restored.tracksJson);
        assertEquals(owner.latestDetail, restored.latestDetail);
        ExpressQueryResult noHistory = new ExpressQueryResult("STATUSONLYEMPTY", "ZTO", "中通快递",
                StatusSemantic.COMPLETED, 0L, "", "", "[]", "", "", "v4", "", "", "")
                .withManualStatusEvidence("已签收", true);
        assertNull(repository.saveManualQueryBatch(null,
                List.of(new ManualQuerySuccess("v4", noHistory, System.currentTimeMillis(), false)),
                "", "interface5"));
        assertNull(repository.findByWaybill("STATUSONLYEMPTY", "interface5"));
    }

    @Test
    public void borrowedStatusWithoutEventTimeRemainsZeroAfterPersistenceAndSameSourceMerge() {
        String waybill = "BORROWEDTIMEZERO001";
        String time = relativeTime(-60000L);
        ExpressQueryResult donor = new ExpressQueryResult(waybill, "ZTO", "中通快递",
                StatusSemantic.COMPLETED, 0L, time, "结构化签收但没有状态时间",
                timedTracks(time, "结构化签收但没有状态时间"), "", "", "v4", "", "", "")
                .withManualStatusEvidence("已签收", true);
        ExpressItem owner = repository.saveManualQueryBatch(null,
                List.of(new ManualQuerySuccess("v4", donor, System.currentTimeMillis(), false)),
                "", "interface5");
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess("v4", donor, System.currentTimeMillis() + 1L, false)),
                "", "interface5");
        database.close();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        assertEquals(StatusSemantic.COMPLETED, repository.find(owner.rowId).semantic);
        assertEquals(0L, repository.find(owner.rowId).statusEventTime);
    }

    private ExpressItem insertOrder(String orderId, String phone) {
        return insertOrder(orderId, phone, "I5-JD", "v5");
    }

    private ExpressItem insertOrder(
            String orderId, String phone, String owner, String routeInterface) {
        ContentValues values = shipmentValues(
                orderId, phone, "JD", "京东购物", owner, "JingDong",
                StatusSemantic.TRANSIT);
        values.put("moreInfoUrl", "pipi-route:" + routeInterface);
        values.put("routeInterface", routeInterface);
        long rowId = database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.EXPRESS_TABLE, null, values);
        ExpressItem item = repository.find(rowId);
        assertNotNull(item);
        assertTrue(item.isAccountOrder());
        return item;
    }

    private long rawRetryAt(long rowId) {
        try (Cursor cursor = database.getReadableDatabase().query(
                ExpressDatabase.EXPRESS_TABLE, new String[]{"projectionRetryAt"},
                "_id=?", new String[]{Long.toString(rowId)}, null, null, null, "1")) {
            assertTrue(cursor.moveToFirst());
            return cursor.getLong(0);
        }
    }

    private String rawRetryRoute(long rowId) {
        try (Cursor cursor = database.getReadableDatabase().query(
                ExpressDatabase.EXPRESS_TABLE, new String[]{"projectionRetryRoute"},
                "_id=?", new String[]{Long.toString(rowId)}, null, null, null, "1")) {
            assertTrue(cursor.moveToFirst());
            return cursor.getString(0);
        }
    }

    private String rawExpressText(long rowId, String column) {
        try (Cursor cursor = database.getReadableDatabase().query(
                ExpressDatabase.EXPRESS_TABLE, new String[]{column},
                "_id=?", new String[]{Long.toString(rowId)}, null, null, null, "1")) {
            assertTrue(cursor.moveToFirst());
            return cursor.getString(0);
        }
    }

    private int automaticDisplayFrozen(String waybill) {
        try (Cursor cursor = database.getReadableDatabase().query(
                ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE,
                new String[]{"display_frozen"}, "normalized_waybill=?",
                new String[]{ExpressSourcePolicy.normalizeWaybill(waybill)},
                null, null, null, "1")) {
            assertTrue(cursor.moveToFirst());
            return cursor.getInt(0);
        }
    }

    private static ContentValues shipmentValues(
            String waybill, String phone, String courierCode, String company,
            String owner, String sourceProvider, StatusSemantic semantic) {
        String eventTime = semantic == StatusSemantic.COMPLETED
                ? "2020-01-01 09:00:00" : "2026-08-24 09:00:00";
        String detail = semantic == StatusSemantic.COMPLETED
                ? "快件已签收" : "快件运输中";
        ContentValues values = new ContentValues();
        values.put("subPhone", phone);
        values.put("mailNo", waybill);
        values.put("normalizedMailNo", ExpressSourcePolicy.normalizeWaybill(waybill));
        values.put("cpCode", courierCode);
        values.put("cpName", company);
        values.put("logsiticsStatus", semantic.storageCode);
        values.put("logisticsStatusDesc", semantic.label);
        values.put("lastLogisticDetail", detail);
        values.put("logisticsGmtModified", eventTime);
        values.put("packageDyn", "[{\"time\":\"" + eventTime
                + "\",\"context\":\"" + detail + "\"}]");
        values.put("canShow", 1);
        values.put("isDeleted", 0);
        values.put("fromCp", owner);
        values.put("stateOwner", owner);
        values.put("data1", sourceProvider);
        values.put("updatedAt", 1L);
        return values;
    }

    private static String relativeTime(long offsetMs) {
        return new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.CHINA)
                .format(new java.util.Date(System.currentTimeMillis() + offsetMs));
    }

    private static ExpressQueryResult timedResult(
            String waybill, String time, String detail) {
        return timedResult(waybill, time, detail, "kuaidi100");
    }

    private static ExpressQueryResult urlOnlyMeizu(String waybill, String route) {
        return new ExpressQueryResult(
                waybill, "ZTO", "中通快递", StatusSemantic.UNKNOWN,
                "", "", "[]", route, "", "meizu");
    }

    private static ExpressQueryResult timedResult(
            String waybill, String time, String detail, String provider) {
        return timedResult(waybill, time, detail, provider, "");
    }

    private static ExpressQueryResult timedResult(
            String waybill, String time, String detail,
            String provider, String sourceProvider) {
        StatusSemantic semantic = detail.contains("签收")
                ? StatusSemantic.COMPLETED : StatusSemantic.TRANSIT;
        return new ExpressQueryResult(
                waybill, "SF", "顺丰速运", semantic,
                0L, time, detail,
                "[{\"time\":\"" + time + "\",\"context\":\""
                        + detail + "\"}]",
                "", "", provider, "", "", sourceProvider)
                .withManualStatusEvidence(semantic.label, "v4".equals(provider));
    }

    private static ExpressQueryResult accountResult(
            String waybill, String phone, StatusSemantic semantic,
            String time, String detail, String tracks,
            String detailUrl, String sourceProvider) {
        return accountResultFor("interface5", waybill, phone, semantic, time, detail,
                tracks, detailUrl, sourceProvider);
    }

    private static ExpressQueryResult accountResultFor(
            String timelineProvider, String waybill, String phone, StatusSemantic semantic,
            String time, String detail, String tracks,
            String detailUrl, String sourceProvider) {
        return new ExpressQueryResult(
                waybill, "ZTO", "中通快递", semantic,
                ExpressSourcePolicy.parseEventTime(time), time, detail, tracks,
                detailUrl, phone, timelineProvider,
                detailUrl.isEmpty() ? "" : "v5", "", sourceProvider);
    }

    private static ExpressQueryResult automaticPacket(
            String waybill, String phone, String timelineProvider,
            String courierCode, String companyName, StatusSemantic semantic,
            String detail, String tracks, String sourceProvider, String routeInterface) {
        String time = "2026-08-29 12:00:00";
        String route = routeInterface.isEmpty() ? ""
                : me.pipi.deliveries.model.CainiaoRoute.token(routeInterface);
        return new ExpressQueryResult(
                waybill, courierCode, companyName, semantic,
                ExpressSourcePolicy.parseEventTime(time), time, detail, tracks,
                route, phone, timelineProvider, routeInterface, "", sourceProvider);
    }

    private static String timedTracks(String time, String detail) {
        return "[{\"time\":\"" + time + "\",\"context\":\"" + detail + "\"}]";
    }

    private static Map<String, java.util.Set<String>> seenByGeneration(String generation) {
        Map<String, java.util.Set<String>> seen = new HashMap<>();
        seen.put(generation, new HashSet<>());
        return seen;
    }

    private static ExpressQueryResult structuredCompletedMotoResult(
            String waybill, long eventTime) {
        String time = new SimpleDateFormat(
                "yyyy-MM-dd HH:mm:ss", Locale.CHINA).format(eventTime);
        String detail = "K100 已签收";
        return new ExpressQueryResult(
                waybill, "SF", "顺丰速运", StatusSemantic.COMPLETED,
                eventTime, time, detail,
                "[{\"time\":\"" + time + "\",\"context\":\"" + detail
                        + "\",\"_pipiStatusSource\":\"v4\"}]",
                "", "", "v4", "", "", "")
                .withManualStatusEvidence(StatusSemantic.COMPLETED.label, true);
    }

    private static void assertProjectedPackage(
            ExpressItem item, ExpressQueryResult expected) throws Exception {
        assertNotNull(item);
        assertEquals(StatusSemantic.COMPLETED, item.semantic);
        assertEquals(expected.statusEventTime, item.statusEventTime);
        assertEquals(expected.latestTime, item.latestTime);
        assertEquals(expected.latestDetail, item.latestDetail);
        assertEquals(expected.tracksJson, item.tracksJson);
        assertEquals(TimelineSlot.normalize(expected.timelineProvider), item.manualTimelineProvider);
    }

    private static void assertCarrierProjection(
            ExpressItem item, ExpressQueryResult expected) {
        assertNotNull(item);
        assertEquals(expected.waybill, item.displayWaybill());
        assertEquals(StatusSemantic.COMPLETED, item.semantic);
        assertEquals(expected.statusEventTime, item.statusEventTime);
        assertEquals(expected.latestTime, item.latestTime);
        assertEquals(expected.latestDetail, item.latestDetail);
        assertEquals(expected.tracksJson, item.tracksJson);
    }

    private void assertCompletedPackageSurvivesWeakSummary(
            String waybill, String phone, String owner) {
        String signedAt = "2026-08-24 09:00:00";
        String expectedCourier = owner.startsWith("INTERFACE5") ? "ZTO" : "YTO";
        String expectedCompany = owner.startsWith("INTERFACE5") ? "中通快递" : "圆通速递";
        ContentValues values = shipmentValues(
                waybill, phone, expectedCourier, expectedCompany, owner,
                "CaiNiao", StatusSemantic.COMPLETED);
        values.put("lastLogisticDetail", "快件已签收");
        values.put("logisticsGmtModified", signedAt);
        values.put("statusEventTime", ExpressSourcePolicy.parseEventTime(signedAt));
        values.put("packageDyn", "[{\"time\":\"" + signedAt
                + "\",\"context\":\"快件已签收\"}]");
        long rowId = database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.EXPRESS_TABLE, null, values);
        String bindingSource = owner.endsWith("5") ? "interface5" : "interface6";
        repository.bindPhoneLocally(phone, bindingSource);
        ExpressQueryResult weak = new ExpressQueryResult(
                waybill, "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "2026-08-24 12:00:00", "快件到达转运中心",
                "[{\"time\":\"2026-08-24 12:00:00\","
                        + "\"context\":\"快件到达转运中心\"}]",
                "", phone, bindingSource, "", "", "CaiNiao");
        if ("interface5".equals(bindingSource)) repository.saveInterface5(weak, phone);
        else repository.saveInterface6(weak, phone);

        ExpressItem retained = repository.find(rowId);
        assertNotNull(retained);
        assertEquals(StatusSemantic.TRANSIT, retained.semantic);
        assertEquals("SF", retained.courierCode);
        assertEquals("顺丰速运", retained.companyName);
        assertEquals("快件到达转运中心", retained.latestDetail);
        assertFalse(retained.tracksJson.contains("快件已签收"));
        assertTrue(retained.tracksJson.contains("快件到达转运中心"));
    }

    private void assertCompletedManualPackageSurvivesAccountOwnershipPromotion(
            String waybill, String phone, String bindingSource) {
        repository.bindPhoneLocally(phone, bindingSource);
        String signedAt = "2026-08-25 09:00:00";
        ExpressQueryResult signed = new ExpressQueryResult(
                waybill, "SF", "顺丰速运", StatusSemantic.COMPLETED,
                ExpressSourcePolicy.parseEventTime(signedAt), signedAt, "快件已签收",
                "[{\"time\":\"" + signedAt
                        + "\",\"context\":\"快件已签收\",\"statusCode\":\"3\"}]",
                "", phone, "meizu", "", "", "")
                .withManualStatusEvidence(StatusSemantic.COMPLETED.label, true);
        repository.saveManualQueryResult(signed, phone, bindingSource);
        ExpressItem manual = repository.findByWaybill(waybill, bindingSource);
        assertNotNull(manual);
        assertTrue(manual.manuallyAdded);
        assertEquals(StatusSemantic.COMPLETED, manual.semantic);
        android.app.NotificationManager notifications =
                context.getSystemService(android.app.NotificationManager.class);
        assertNotNull(notifications);
        notifications.cancelAll();

        String transitAt = "2026-08-25 12:00:00";
        ExpressQueryResult discovered = new ExpressQueryResult(
                waybill, "SF", "顺丰速运", StatusSemantic.TRANSIT,
                ExpressSourcePolicy.parseEventTime(transitAt), transitAt,
                "快件到达转运中心",
                "[{\"time\":\"" + transitAt
                        + "\",\"context\":\"快件到达转运中心\"}]",
                "", phone, bindingSource, "", "", "CaiNiao");
        if ("interface5".equals(bindingSource)) {
            repository.saveInterface5(discovered, phone);
        } else {
            repository.saveInterface6(discovered, phone);
        }

        ExpressItem retained = repository.findByWaybill(waybill, bindingSource);
        assertNotNull(retained);
        assertFalse(retained.manuallyAdded);
        assertEquals("interface5".equals(bindingSource)
                ? "INTERFACE5" : "INTERFACE6", retained.stateOwner);
        assertEquals(StatusSemantic.TRANSIT, retained.sourceSemantic);
        assertEquals(StatusSemantic.TRANSIT, retained.semantic);
        assertEquals("", retained.manualTimelineProvider);
        assertEquals(transitAt, retained.latestTime);
        assertEquals("快件到达转运中心", retained.latestDetail);
        assertTrue(retained.tracksJson.contains("快件到达转运中心"));
    }

    private void insertRetry(ExpressItem owner, long attemptAt) {
        ContentValues values = new ContentValues();
        values.put("owner_row_id", owner.rowId);
        values.put("normalized_waybill", ExpressSourcePolicy.normalizeWaybill(owner.waybill));
        values.put("binding_source", "interface5");
        values.put("owner_fingerprint", "retention-test");
        values.put("last_attempt_at", attemptAt);
        database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.OWNER_MANUAL_RETRY_TABLE, null, values);
    }

    private int count(String table, String selection, String[] args) {
        try (Cursor cursor = database.getReadableDatabase().query(
                table, new String[]{"COUNT(*)"}, selection, args,
                null, null, null)) {
            cursor.moveToFirst();
            return cursor.getInt(0);
        }
    }

    /** A sparse feed update preserves its history without mixing in query sidecars. */
    @Test
    public void summaryRewriteKeepsTheRicherRowDetail() {
        ExpressItem row = new ExpressItem(
                7L, "13800138000", "73724083630238", "ZTO", "中通快递",
                StatusSemantic.COMPLETED, "已签收", "您的快件已送达，签收人：家门口",
                "2026-08-28 10:03:49",
                "[{\"time\":\"2026-08-28 10:03:49\",\"context\":\"您的快件已送达，签收人：家门口\"},"
                        + "{\"time\":\"2026-08-28 08:12:00\",\"context\":\"派送中\"}]",
                "", "interface5", "");
        ExpressQueryResult summary = new ExpressQueryResult(
                "73724083630238", "ZTO", "中通快递", StatusSemantic.COMPLETED,
                "", "已签收", "[]");
        ExpressQueryResult kept = ExpressRepository.mergeSameOwnerFeed(row, summary);
        assertEquals("您的快件已送达，签收人：家门口", kept.latestDetail);
        assertEquals("2026-08-28 10:03:49", kept.latestTime);
        assertEquals(2, Kuaidi100TimelinePolicy.timedTrackCount(kept));
        assertTrue(kept.statusEventTime > 0L);
        // 摘要带来更晚的事件：照常覆盖。
        ExpressQueryResult newer = new ExpressQueryResult(
                "73724083630238", "ZTO", "中通快递", StatusSemantic.COMPLETED,
                "2026-08-29 09:00:00", "已取件", "[]");
        assertEquals("已取件", ExpressRepository.mergeSameOwnerFeed(row, newer).latestDetail);
        // Both observations belong to the same feed, so its summary remains in the union.
        ExpressQueryResult sameMinuteSummary = new ExpressQueryResult(
                "73724083630238", "ZTO", "中通快递", StatusSemantic.COMPLETED,
                "2026-08-28 10:03:49", "已签收",
                "[{\"time\":\"2026-08-28 10:03:49\",\"context\":\"已签收\"}]");
        ExpressQueryResult keptAgain = ExpressRepository.mergeSameOwnerFeed(
                row, sameMinuteSummary);
        assertEquals(3, Kuaidi100TimelinePolicy.timedTrackCount(keptAgain));
        assertTrue(keptAgain.tracksJson.contains("\"context\":\"已签收\""));
    }
}
