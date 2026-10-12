package me.pipi.deliveries.background;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
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
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.shadows.ShadowLog;
import org.robolectric.util.ReflectionHelpers;

/**
 * 用户 2026-10-02「加一个限制 头条跟状态有一个更新时 另外（包含本地详情页）就要强制刷新跟上（以时间为准）」，弹窗「五分钟」
 * 「同取件码强刷（推荐）」. Synthetic parcels, with the requests replaced: more than five minutes either way is out
 * of step, the same three times force a row once, and a signed SF row's Picker runs past the signed freeze.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressStatusAlignmentTest {
    private static final String PHONE = "13800000088";
    private static final String SF = "SF1000000000088";
    private static final String ZTO = "ZT1000000000088";
    private static final String CAINIAO = "YT1000000000088";
    private static final long MINUTE = 60_000L;
    private static final long FIVE = ExpressRepository.STATUS_ALIGNMENT_MILLIS;

    private Context context;
    private ExpressRepository repository;
    private long base;
    private FakeSources sources;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        for (String prefs : new String[]{"deliveries_repository_migrations", ExpressStatusAlignment.PREFS}) {
            context.getSharedPreferences(prefs, 0).edit().clear().commit();
        }
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        repository.bindPhoneLocally(PHONE, "interface6");
        base = (System.currentTimeMillis() - 120L * MINUTE) / 1000L * 1000L;
        sources = new FakeSources();
        ShadowLog.clear();
    }

    @After public void tearDown() {
        ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void moreThanFiveMinutesEitherWayIsOutOfStep() {
        long s = base;
        assertFalse(ExpressStatusAlignment.outOfStep(s, s - FIVE, 0L));
        assertTrue(ExpressStatusAlignment.outOfStep(s, s - FIVE - 1L, 0L));
        assertFalse(ExpressStatusAlignment.outOfStep(s, s + FIVE, 0L));
        assertTrue(ExpressStatusAlignment.outOfStep(s, s + FIVE + 1L, 0L));
        // The detail page counts against either of the other two; an absent time never counts.
        assertTrue(ExpressStatusAlignment.outOfStep(s, s, s - FIVE - 1L));
        assertTrue(ExpressStatusAlignment.outOfStep(s, 0L, s + FIVE + 1L));
        assertFalse(ExpressStatusAlignment.outOfStep(s, 0L, 0L));
        assertFalse(ExpressStatusAlignment.outOfStep(s, 0L, s - FIVE));

        assertEquals("status_ahead", ExpressStatusAlignment.reason(s, s - FIVE - 1L, 0L));
        assertEquals("headline_ahead", ExpressStatusAlignment.reason(s, s + FIVE + 1L, 0L));
        assertEquals("detail_behind", ExpressStatusAlignment.reason(s, s, s - FIVE - 1L));
    }

    /**
     * 优化 1、3（用户 2026-10-03）：the set now lives in the row's own ledger, so a claim needs the row; the rule is unchanged —
     * the same set once per row, any time moving makes a new set. A row that is gone claims nothing.
     */
    @Test public void theSameThreeTimesAreClaimedOnce() throws Exception {
        long first = signedShunFengWithOlderPicker().rowId;
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.TRANSIT,
                base + 20L * MINUTE, at(20), "快件到达营业点",
                tracks(new String[][]{{at(20), "快件到达营业点"}, {at(0), "快件已揽收"}}),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.TRANSIT, base + 20L * MINUTE)), PHONE);
        long second = repository.findByWaybill(ZTO, "interface5").rowId;
        assertTrue(repository.claimLedger(first, ExpressRepository.LEDGER_STATUS_ALIGNMENT, "1|2|3"));
        assertFalse(repository.claimLedger(first, ExpressRepository.LEDGER_STATUS_ALIGNMENT, "1|2|3"));
        assertTrue("another row has its own set", repository.claimLedger(second, ExpressRepository.LEDGER_STATUS_ALIGNMENT, "1|2|3"));
        assertTrue("any time moving makes a new set", repository.claimLedger(first, ExpressRepository.LEDGER_STATUS_ALIGNMENT, "1|2|4"));
        assertFalse("a row that is gone claims nothing",
                repository.claimLedger(second + 1_000L, ExpressRepository.LEDGER_STATUS_ALIGNMENT, "1|2|3"));
    }

    /**
     * SF's coarse signed feed cannot stop either the ordinary poll or the alignment refresh.
     * The detailed response advances the headline and completes the alignment set.
     */
    @Test public void aSignedShunFengRowRunsItsPickerPastTheFreezeOnce() throws Exception {
        ExpressItem owner = signedShunFengWithOlderPicker();
        ExpressRepository.ManualTimelinePollClaim ordinary = ExpressSyncEngine.claimListManualTimelinePoll(
                repository, owner, System.currentTimeMillis(), false);
        assertNotNull(ordinary);
        repository.releaseManualTimelinePoll(ordinary);
        sources.picker = picker(StatusSemantic.COMPLETED, 110L, new String[][]{
                {at(110), "快件已签收"}, {at(20), "快件到达营业点"}, {at(0), "顺丰速运 已收取快件"}});

        assertEquals(1, check());
        assertEquals(0, sources.accountDetails);
        assertEquals(1, sources.pickers);
        ExpressItem refreshed = repository.find(owner.rowId);
        assertEquals("快件已签收", refreshed.latestDetail);
        assertEquals(at(110), refreshed.latestTime);
        assertTrue(logs().contains("alignmentReason=status_ahead"));

        assertEquals("aligned now: nothing more to force", 0, check());
        assertEquals(1, sources.pickers);
    }

    /** A Picker that brings nothing new leaves the same three times, so the next check does not force again. */
    @Test public void anUnchangedRowIsForcedOnceUntilATimeMoves() throws Exception {
        ExpressItem owner = signedShunFengWithOlderPicker();
        sources.picker = picker(StatusSemantic.TRANSIT, 20L, new String[][]{
                {at(20), "快件到达营业点"}, {at(0), "顺丰速运 已收取快件"}});

        assertEquals(1, check());
        assertEquals(0, check());
        assertEquals(1, sources.pickers);

        // Another refresh moves the Picker headline (still behind the signature): a new set, forced once more.
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY,
                        picker(StatusSemantic.DELIVERY, 30L, new String[][]{
                                {at(30), "快件派送中"}, {at(20), "快件到达营业点"}, {at(0), "顺丰速运 已收取快件"}}),
                        base + 31L * MINUTE, false)), PHONE, "interface5");
        assertEquals(at(30), repository.find(owner.rowId).latestTime);
        assertEquals(1, check());
        assertEquals(2, sources.pickers);
        assertEquals(0, check());
    }

    @Test public void aHeldPickerLeaseDoesNotSpendAnAlignmentAttempt() throws Exception {
        ExpressItem owner = signedShunFengWithOlderPicker();
        ExpressRepository.ManualTimelinePollClaim held =
                repository.claimStatusAlignmentManualTimelinePoll(owner, System.currentTimeMillis());
        assertNotNull(held);
        try {
            assertEquals(0, check());
            assertEquals(0, sources.pickers);
            assertEquals("", repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_STATUS_ALIGNMENT));
        } finally {
            repository.releaseManualTimelinePoll(held);
        }
        assertEquals(1, check());
        assertEquals(1, sources.pickers);
    }

    @Test public void anAlignmentLedgerCommitFailureMakesNoQueryAndRemainsRetryable() throws Exception {
        ExpressItem owner = signedShunFengWithOlderPicker();
        android.database.sqlite.SQLiteDatabase db = ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper"))
                .getWritableDatabase();
        db.execSQL("CREATE TRIGGER fail_alignment BEFORE INSERT ON " + ExpressDatabase.ROW_LEDGER_TABLE
                + " WHEN NEW.entry='" + ExpressRepository.LEDGER_STATUS_ALIGNMENT
                + "' BEGIN SELECT RAISE(ABORT, 'injected_alignment_failure'); END");
        try {
            assertEquals(0, check());
            assertEquals(0, sources.pickers);
            assertEquals("", repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_STATUS_ALIGNMENT));
        } finally {
            db.execSQL("DROP TRIGGER fail_alignment");
        }
        assertEquals(1, check());
        assertEquals(1, sources.pickers);
    }

    @Test public void noUpdateRetriesAfterTheNormalIntervalAtMostThreeTimes() throws Exception {
        ExpressItem owner = signedShunFengWithOlderPicker();
        ExpressRepository.StatusAlignmentProbe probe = probe(owner);
        String times = ExpressRepository.alignmentTimes(probe);
        long now = System.currentTimeMillis();
        java.util.Map<String, Long> before = repository.statusAlignmentEvidence(owner);
        assertTrue(repository.beginStatusAlignment(owner, times, now));
        repository.finishStatusAlignment(owner, times, before);
        assertFalse(repository.beginStatusAlignment(owner, times, now + 14L * MINUTE));
        assertTrue(repository.beginStatusAlignment(owner, times, now + 15L * MINUTE));
        repository.finishStatusAlignment(owner, times, before);
        assertTrue(repository.beginStatusAlignment(owner, times, now + 30L * MINUTE));
        repository.finishStatusAlignment(owner, times, before);
        assertFalse(repository.beginStatusAlignment(owner, times, now + 45L * MINUTE));
        assertFalse(new JSONObject(repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_STATUS_ALIGNMENT))
                .getBoolean("done"));
    }

    @Test public void anAlignedThenRepeatedTupleKeepsItsUnspentBudgetAndInterval() throws Exception {
        ExpressItem owner = alignedThenRepeatedTuple(1);
        String times = ExpressRepository.alignmentTimes(probe(owner));
        JSONObject record = new JSONObject(repository.ledgerValue(owner.rowId,
                ExpressRepository.LEDGER_STATUS_ALIGNMENT));
        assertEquals(1, record.getInt("attempts"));
        assertFalse(repository.beginStatusAlignment(owner, times, record.getLong("lastAt") + 14L * MINUTE));
        assertTrue(repository.beginStatusAlignment(owner, times, record.getLong("lastAt") + 15L * MINUTE));
        assertEquals(2, new JSONObject(repository.ledgerValue(owner.rowId,
                ExpressRepository.LEDGER_STATUS_ALIGNMENT)).getInt("attempts"));
    }

    @Test public void anAlignedThenRepeatedTupleCannotRefillItsSpentThreeAttempts() throws Exception {
        ExpressItem owner = alignedThenRepeatedTuple(3);
        JSONObject record = new JSONObject(repository.ledgerValue(owner.rowId,
                ExpressRepository.LEDGER_STATUS_ALIGNMENT));
        assertEquals(3, record.getInt("attempts"));
        assertFalse(repository.beginStatusAlignment(owner, ExpressRepository.alignmentTimes(probe(owner)),
                record.getLong("lastAt") + 15L * MINUTE));
    }

    private ExpressItem alignedThenRepeatedTuple(int attempts) throws Exception {
        ExpressItem owner = signedShunFengWithOlderPicker();
        String originalTimes = ExpressRepository.alignmentTimes(probe(owner));
        long now = System.currentTimeMillis();
        for (int attempt = 0; attempt < attempts; attempt++) {
            java.util.Map<String, Long> before = repository.statusAlignmentEvidence(owner);
            assertTrue(repository.beginStatusAlignment(owner, originalTimes, now + attempt * 15L * MINUTE));
            repository.finishStatusAlignment(owner, originalTimes, before);
        }
        String consumed = repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_STATUS_ALIGNMENT);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY,
                        picker(StatusSemantic.COMPLETED, 110L, new String[][]{
                                {at(110), "快件已签收"}, {at(0), "顺丰速运 已收取快件"}}), now, false)),
                PHONE, "interface5");
        ExpressRepository.StatusAlignmentProbe aligned = probe(owner);
        assertEquals(aligned.statusAt, aligned.headlineAt);
        assertEquals(aligned.statusAt, aligned.detailAt);
        assertEquals(consumed, repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_STATUS_ALIGNMENT));
        // A synthetic cache expiry restores the former source packet without rewriting the retry ledger.
        ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).getWritableDatabase()
                .delete(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null, null);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY,
                        picker(StatusSemantic.TRANSIT, 20L, new String[][]{
                                {at(20), "快件到达营业点"}, {at(0), "顺丰速运 已收取快件"}}), now, false)),
                PHONE, "interface5");
        assertEquals(originalTimes, ExpressRepository.alignmentTimes(probe(owner)));
        assertEquals(consumed, repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_STATUS_ALIGNMENT));
        return owner;
    }

    @Test public void aCorrectedKnownHeadlineResumesAnUnspentCompletedSet() throws Exception {
        ExpressItem owner = correctedKnownHeadlineWithCompletedSet(1);
        long now = System.currentTimeMillis();
        String times = ExpressRepository.alignmentTimes(probe(owner));
        assertTrue(repository.beginStatusAlignment(owner, times, now));
        JSONObject record = new JSONObject(repository.ledgerValue(owner.rowId,
                ExpressRepository.LEDGER_STATUS_ALIGNMENT));
        assertEquals(2, record.getInt("attempts"));
        assertFalse(record.getBoolean("done"));
        repository.finishStatusAlignment(owner, times, repository.statusAlignmentEvidence(owner));
        assertFalse("an enum correction at the same clock is not newer evidence",
                new JSONObject(repository.ledgerValue(owner.rowId,
                        ExpressRepository.LEDGER_STATUS_ALIGNMENT)).getBoolean("done"));
        assertFalse("the correction retains the ordinary interval",
                repository.beginStatusAlignment(owner, times, now + 14L * MINUTE));
    }

    @Test public void aCorrectedKnownHeadlineDoesNotExtendTheThreeAttemptBudget() throws Exception {
        ExpressItem owner = correctedKnownHeadlineWithCompletedSet(3);
        assertFalse(repository.beginStatusAlignment(owner, ExpressRepository.alignmentTimes(probe(owner)),
                System.currentTimeMillis()));
    }

    @Test public void aCompletedRecordWithoutStateSnapshotsKeepsOnlyItsConsumedAttempts() throws Exception {
        ExpressItem owner = correctedKnownHeadlineWithCompletedSet(1);
        JSONObject record = new JSONObject(repository.ledgerValue(owner.rowId,
                ExpressRepository.LEDGER_STATUS_ALIGNMENT));
        record.remove("status");
        record.remove("headlineStatus");
        repository.claimLedger(owner.rowId, ExpressRepository.LEDGER_STATUS_ALIGNMENT, record.toString());
        long last = record.getLong("lastAt");
        String times = ExpressRepository.alignmentTimes(probe(owner));
        assertFalse(repository.beginStatusAlignment(owner, times, last + 14L * MINUTE));
        assertTrue(repository.beginStatusAlignment(owner, times, last + 15L * MINUTE));
        assertEquals(2, new JSONObject(repository.ledgerValue(owner.rowId,
                ExpressRepository.LEDGER_STATUS_ALIGNMENT)).getInt("attempts"));
    }

    @Test public void aDuplicateFinishDoesNotPublishAnotherInvalidation() throws Exception {
        ExpressItem owner = signedShunFengWithOlderPicker();
        String times = ExpressRepository.alignmentTimes(probe(owner));
        java.util.Map<String, Long> before = repository.statusAlignmentEvidence(owner);
        assertTrue(repository.beginStatusAlignment(owner, times, System.currentTimeMillis()));
        long version = repository.invalidationVersion();
        repository.finishStatusAlignment(owner, times, before);
        assertEquals(version + 1L, repository.invalidationVersion());
        repository.finishStatusAlignment(owner, times, before);
        assertEquals(version + 1L, repository.invalidationVersion());
    }

    @Test public void aFailedCompletionCommitDoesNotConsumeTheDetailOnceGate() throws Exception {
        ExpressItem owner = signedShunFengWithOlderPicker();
        String times = ExpressRepository.alignmentTimes(probe(owner));
        java.util.Map<String, Long> before = repository.statusAlignmentEvidence(owner);
        long now = System.currentTimeMillis();
        assertTrue(repository.beginStatusAlignment(owner, times, now));
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY,
                        picker(StatusSemantic.DELIVERY, 30L, new String[][]{
                                {at(30), "更新的派送节点"}, {at(0), "顺丰速运 已收取快件"}}), now, false)),
                PHONE, "interface5");
        android.database.sqlite.SQLiteDatabase db = ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper"))
                .getWritableDatabase();
        db.execSQL("CREATE TRIGGER fail_alignment_finish BEFORE INSERT ON " + ExpressDatabase.ROW_LEDGER_TABLE
                + " WHEN NEW.entry='" + ExpressRepository.LEDGER_STATUS_ALIGNMENT
                + "' BEGIN SELECT RAISE(ABORT, 'injected_alignment_failure'); END");
        long version = repository.invalidationVersion();
        boolean failed = false;
        try {
            repository.finishStatusAlignment(owner, times, before);
        } catch (RuntimeException failure) {
            failed = true;
        } finally {
            db.execSQL("DROP TRIGGER fail_alignment_finish");
        }
        assertTrue(failed);
        JSONObject record = new JSONObject(repository.ledgerValue(owner.rowId,
                ExpressRepository.LEDGER_STATUS_ALIGNMENT));
        assertFalse(record.getBoolean("finished"));
        assertFalse(record.getBoolean("done"));
        assertEquals("", repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_DETAIL_WEB_LAG_QUERY));
        assertEquals(version, repository.invalidationVersion());
        repository.finishStatusAlignment(owner, times, before);
        assertTrue(new JSONObject(repository.ledgerValue(owner.rowId,
                ExpressRepository.LEDGER_STATUS_ALIGNMENT)).getBoolean("done"));
        assertEquals(times, repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_DETAIL_WEB_LAG_QUERY));
    }

    private ExpressItem correctedKnownHeadlineWithCompletedSet(int attempts) throws Exception {
        String json = new JSONArray().put(new JSONObject().put("time", at(110))
                .put("context", "配送节点").put("statusCode", "105")).toString();
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                base + 110L * MINUTE, at(110), "配送节点", json, "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, base + 110L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertEquals(StatusSemantic.DELIVERY, probe(owner).headlineSemantic);
        JSONObject record = new JSONObject().put("times", ExpressRepository.alignmentTimes(probe(owner)))
                .put("attempts", attempts).put("lastAt", System.currentTimeMillis() - 15L * MINUTE)
                .put("finished", true).put("done", true)
                .put("status", StatusSemantic.COMPLETED.name()).put("headlineStatus", StatusSemantic.COMPLETED.name());
        repository.claimLedger(owner.rowId, ExpressRepository.LEDGER_STATUS_ALIGNMENT, record.toString());
        return owner;
    }

    @Test public void advancingALaggingSlotCompletesTheSetBelowTheNewestGlobalTime() throws Exception {
        ExpressItem owner = signedShunFengWithOlderPicker();
        String times = ExpressRepository.alignmentTimes(probe(owner));
        java.util.Map<String, Long> before = repository.statusAlignmentEvidence(owner);
        long now = System.currentTimeMillis();
        assertTrue(repository.beginStatusAlignment(owner, times, now));
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY,
                        picker(StatusSemantic.DELIVERY, 30L, new String[][]{
                                {at(30), "更新的派送节点"}, {at(0), "顺丰速运 已收取快件"}}), now, false)),
                PHONE, "interface5");
        repository.finishStatusAlignment(owner, times, before);
        assertTrue(new JSONObject(repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_STATUS_ALIGNMENT))
                .getBoolean("done"));
        assertFalse(repository.beginStatusAlignment(owner, times, now + 15L * MINUTE));
    }

    /** An interface 5 row (not SF) asks its per-parcel account detail and its list round's Picker. */
    @Test public void anInterface5RowAsksItsAccountDetailAndPicker() throws Exception {
        ExpressQueryResult feed = new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                base + 110L * MINUTE, at(20), "快件到达营业点",
                tracks(new String[][]{{at(20), "快件到达营业点"}, {at(0), "快件已揽收"}}),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, base + 110L * MINUTE));
        repository.saveInterface5(feed, PHONE);

        assertEquals(1, check());
        assertEquals(1, sources.accountDetails);
        assertEquals(1, sources.pickers);
        assertEquals(0, check());
        assertEquals(1, sources.accountDetails);
    }

    /**
     * An interface 6 Cainiao row has no request a host without an Activity may make (its page capture is the
     * detail page's): the set is still recorded and logged once, and nothing is asked.
     */
    @Test public void aRowWithNothingRunnableIsNotRecorded() throws Exception {
        ExpressQueryResult feed = new ExpressQueryResult(CAINIAO, "YTO", "圆通速递", StatusSemantic.TRANSIT,
                base + 30L * MINUTE, at(60), "快件运输中", "[]", "", PHONE, TimelineSlot.V6_LIST, "", "",
                "CaiNiao").withWorkerStatus(structured(StatusSemantic.TRANSIT, base + 30L * MINUTE));
        repository.saveInterface6(feed, PHONE);
        assertNotNull(repository.findByWaybill(CAINIAO, "interface6"));

        assertEquals(0, check("interface6"));
        assertEquals(0, check("interface6"));
        assertEquals(0, sources.accountDetails + sources.pickers);
        String logs = logs();
        assertEquals(logs, 0, count(logs, "detail.refresh.alignment"));
    }

    /**
     * 用户 2026-10-02「头条 状态 详情页 都推进到了签收状态…就冻结快递 后续不再进行任何刷新」，弹窗「按时间对齐」「只停本机发起的
     * 请求」: a node ten minutes after the signing puts the headline out of step, but status, headline and detail all
     * reached the signing, so nothing is forced and the set stays unclaimed. 优化 3（用户 2026-10-03「已冻结的行不进对齐检查」）:
     * the frozen row is not checked at all, so no skip line is logged for it any more (it used to log one per set).
     */
    @Test public void aSignedFrozenRowOutOfStepIsNotForced() throws Exception {
        ExpressQueryResult feed = new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                base + 100L * MINUTE, at(110), "快件已由驿站代收",
                tracks(new String[][]{{at(110), "快件已由驿站代收"}, {at(100), "快件已签收"}, {at(0), "快件已揽收"}}),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, base + 100L * MINUTE));
        repository.saveInterface5(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertNotNull(owner);
        assertTrue(repository.signedFrozen(owner));

        assertEquals(0, check());
        assertEquals(0, sources.accountDetails + sources.pickers);
        String logs = logs();
        assertEquals(logs, 0, count(logs, "skipReason=signed_frozen"));
        assertEquals(logs, 0, count(logs, "trigger=status_alignment"));
        assertEquals(logs, 0, count(logs, "detail.refresh.alignment"));

        assertEquals(0, check());
        assertEquals("", repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_STATUS_ALIGNMENT));
        assertTrue("a frozen set is not claimed", repository.beginStatusAlignment(owner,
                ExpressStatusAlignment.times(base + 100L * MINUTE, base + 110L * MINUTE, base + 110L * MINUTE),
                System.currentTimeMillis()));
    }

    /**
     * 优化 3（用户 2026-10-03「四端都持久化、不因暂时消失删除」）：a check of another interface's list (the row is not in it)
     * used to drop the row's set, so the next check forced it again. The set stays until the row is really deleted.
     */
    @Test public void aRowOutOfViewKeepsItsSetUntilItIsDeleted() throws Exception {
        ExpressItem owner = signedShunFengWithOlderPicker();
        sources.picker = picker(StatusSemantic.TRANSIT, 20L, new String[][]{
                {at(20), "快件到达营业点"}, {at(0), "顺丰速运 已收取快件"}});
        assertEquals(1, check());
        String claimed = repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_STATUS_ALIGNMENT);
        assertFalse(claimed.isEmpty());

        assertEquals("the row is not in the interface 6 list", 0, check("interface6"));
        assertEquals(claimed, repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_STATUS_ALIGNMENT));
        assertEquals("the same set is not forced again", 0, check());
        assertEquals(1, sources.pickers);

        repository.delete(owner.rowId);
        assertEquals("the set goes with the row", "",
                repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_STATUS_ALIGNMENT));
    }

    /** 优化 1、3：the set is persisted, so a new process (a new repository on the same database) does not force it again. */
    @Test public void theSetSurvivesANewProcess() throws Exception {
        signedShunFengWithOlderPicker();
        sources.picker = picker(StatusSemantic.TRANSIT, 20L, new String[][]{
                {at(20), "快件到达营业点"}, {at(0), "顺丰速运 已收取快件"}});
        assertEquals(1, check());

        ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        repository = ExpressRepository.get(context);
        assertEquals(0, check());
        assertEquals(1, sources.pickers);
    }

    /**
     * 优化 3：the sets kept in the old preferences file are moved into the ledger once (rows that still exist; the frozen
     * skip marks are not needed any more) and the file is cleared, so an upgrade does not force the same set again.
     */
    @Test public void legacyPreferenceSetsMoveIntoTheLedger() throws Exception {
        ExpressItem owner = signedShunFengWithOlderPicker();
        ExpressRepository.StatusAlignmentProbe probe = probe(owner);
        String times = ExpressStatusAlignment.times(probe.statusAt, probe.headlineAt, probe.comparedDetailAt());
        context.getSharedPreferences(ExpressStatusAlignment.PREFS, 0).edit()
                .putString("row:" + owner.rowId, times)
                .putString("frozen:row:" + owner.rowId, times)
                .putString("row:987654", "1|2|3")
                .commit();

        ReflectionHelpers.setField(repository, "legacyStatusAlignmentMigrated", false);
        assertEquals("a legacy attempt has no evidence of completion and may retry", 1, check());
        assertEquals(1, sources.pickers);
        JSONObject record = new JSONObject(repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_STATUS_ALIGNMENT));
        assertEquals(times, record.getString("times"));
        assertEquals(2, record.getInt("attempts"));
        assertFalse(record.getBoolean("done"));
        assertEquals("", repository.ledgerValue(987654L, ExpressRepository.LEDGER_STATUS_ALIGNMENT));
        assertTrue(context.getSharedPreferences(ExpressStatusAlignment.PREFS, 0).getAll().isEmpty());
    }

    /**
     * 优化 2（用户 2026-10-03「v5 对不上并进对齐」）：a JD row whose list headline is three minutes off its status and detail is
     * not forced (the detail page's own one-minute query is gone, and five minutes is the only threshold); more than five
     * minutes is forced once with the same persisted set.
     */
    @Test public void aJingDongRowIsForcedOnlyBeyondFiveMinutes() throws Exception {
        String waybill = "JD9990000000188";
        repository.saveInterface5(new ExpressQueryResult(waybill, "JD", "京东快递", StatusSemantic.DELIVERY,
                base + 60L * MINUTE, at(57), "您的订单已到达【测试站】",
                tracks(new String[][]{{at(60), "您的订单正在派送中，请您准备签收"}, {at(57), "您的订单已到达【测试站】"},
                        {at(0), "您的快件已由京东快递揽收完成"}}),
                "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(structured(StatusSemantic.DELIVERY, base + 60L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(waybill, "interface5");
        assertNotNull(owner);
        ExpressRepository.StatusAlignmentProbe probe = probe(owner);
        assertEquals(base + 57L * MINUTE, probe.headlineAt);
        assertEquals(base + 60L * MINUTE, probe.detailAt);
        assertEquals(0, check());
        assertEquals(0, sources.accountDetails);

        repository.saveInterface5(new ExpressQueryResult(waybill, "JD", "京东快递", StatusSemantic.DELIVERY,
                base + 70L * MINUTE, at(57), "您的订单已到达【测试站】",
                tracks(new String[][]{{at(70), "您的订单正在派送中，请您准备签收"}, {at(57), "您的订单已到达【测试站】"},
                        {at(0), "您的快件已由京东快递揽收完成"}}),
                "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(structured(StatusSemantic.DELIVERY, base + 70L * MINUTE)), PHONE);
        assertEquals(1, check());
        assertEquals(1, sources.accountDetails);
        assertEquals(0, check());
        assertEquals(1, sources.accountDetails);
    }

    private ExpressRepository.StatusAlignmentProbe probe(ExpressItem owner) {
        for (ExpressRepository.StatusAlignmentProbe probe : repository.statusAlignmentProbes("interface5")) {
            if (probe.row.rowId == owner.rowId) return probe;
        }
        throw new AssertionError("no probe for the row");
    }

    /**
     * 「只强刷、不换头条」: a JD business-source row whose structured status is forty minutes ahead of its headline keeps
     * that headline on the list (the JD rules decide it), while the check still forces its refresh once.
     */
    @Test public void aJingDongRowIsForcedButKeepsItsHeadline() throws Exception {
        String waybill = "JD9990000000088";
        repository.saveInterface5(new ExpressQueryResult(waybill, "JD", "京东快递", StatusSemantic.DELIVERY,
                base + 60L * MINUTE, at(20), "您的订单已到达【测试站】",
                tracks(new String[][]{{at(60), "您的订单正在派送中，请您准备签收"}, {at(20), "您的订单已到达【测试站】"},
                        {at(0), "您的快件已由京东快递揽收完成"}}),
                "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(structured(StatusSemantic.DELIVERY, base + 60L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(waybill, "interface5");
        assertNotNull(owner);
        ExpressItem listed = null;
        for (ExpressItem row : repository.listVisible("interface5")) if (row.rowId == owner.rowId) listed = row;
        assertNotNull(listed);
        assertEquals("您的订单已到达【测试站】", listed.latestDetail);
        assertEquals(at(20), listed.latestTime);

        assertEquals(1, check());
        assertEquals(1, sources.accountDetails);
        assertEquals(0, sources.pickers);
        assertTrue(logs().contains("alignmentReason=status_ahead"));
    }

    /** A stopped round forces nothing and records nothing. */
    @Test public void aStoppedRoundForcesNothing() throws Exception {
        signedShunFengWithOlderPicker();
        assertEquals(0, ExpressStatusAlignment.check(context, repository, "interface5", () -> true, sources));
        assertEquals(0, sources.pickers);
        assertEquals(1, check());
    }

    private int check() {
        return check("interface5");
    }

    private int check(String binding) {
        return ExpressStatusAlignment.check(context, repository, binding, () -> false, sources);
    }

    private ExpressQueryResult shunFengFeed(long signedAtMinutes) throws Exception {
        return new ExpressQueryResult(SF, "SF", "顺丰速运", StatusSemantic.COMPLETED,
                base + signedAtMinutes * MINUTE, at(signedAtMinutes), "快件已签收",
                tracks(new String[][]{{at(signedAtMinutes), "快件已签收"}, {at(0), "顺丰速运 已收取快件"}}),
                "", PHONE, "interface5", "", "", "ShunFeng")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, base + signedAtMinutes * MINUTE));
    }

    private ExpressItem signedShunFengWithOlderPicker() throws Exception {
        repository.saveInterface5(shunFengFeed(110L), PHONE);
        ExpressItem owner = repository.findByWaybill(SF, "interface5");
        assertNotNull(owner);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY,
                        picker(StatusSemantic.TRANSIT, 20L, new String[][]{
                                {at(20), "快件到达营业点"}, {at(0), "顺丰速运 已收取快件"}}),
                        base + 21L * MINUTE, false)), PHONE, "interface5");
        return repository.find(owner.rowId);
    }

    private ExpressQueryResult picker(StatusSemantic semantic, long statusAtMinutes, String[][] nodes)
            throws Exception {
        return new ExpressQueryResult(SF, "SF", "顺丰速运", semantic, base + statusAtMinutes * MINUTE,
                nodes[0][0], nodes[0][1], tracks(nodes), "", PHONE, TimelineSlot.V6_QUERY, "", "", "")
                .withManualStatusEvidence(semantic.label, true);
    }

    private String at(long minutes) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));
        return format.format(new Date(base + minutes * MINUTE));
    }

    private static WorkerStatusProjection structured(StatusSemantic semantic, long eventAtMs) throws Exception {
        return WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1)
                        .put("scope", "SHIPMENT").put("semantic", semantic.name())
                        .put("code", "SERVER_ENUM").put("text", semantic.label).put("priority", 0)
                        .put("eventAtMs", eventAtMs).put("structured", true)));
    }

    private static String tracks(String[][] nodes) throws Exception {
        JSONArray value = new JSONArray();
        for (String[] node : nodes) value.put(new JSONObject().put("time", node[0]).put("context", node[1]));
        return value.toString();
    }

    private static String logs() {
        List<String> lines = new ArrayList<>();
        for (ShadowLog.LogItem item : ShadowLog.getLogsForTag("PipiExpress")) lines.add(item.msg);
        return String.join("\n", lines);
    }

    private static int count(String text, String needle) {
        int count = 0;
        for (int index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + 1)) count++;
        return count;
    }

    private static final class FakeSources implements ExpressStatusAlignment.Sources {
        int accountDetails;
        int pickers;
        ExpressQueryResult picker;

        @Override public ExpressQueryResult accountDetail(Context context, ExpressItem row) {
            accountDetails++;
            return null;
        }

        @Override public ExpressQueryResult picker(Context context, String waybill) {
            pickers++;
            return picker;
        }
    }
}
