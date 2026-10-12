package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import android.app.Application;
import android.content.ContentValues;
import android.content.Context;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

import java.util.UUID;

/**
 * 用户 2026-09-28「修：进程换了就不算」: the manual-timeline poll lease in {@code owner_manual_retry} records the
 * process that took it. Lite runs in one process, so a lease another process took — a process since killed or
 * replaced — no longer blocks: neither the detail refresh (whose failed claim ends as
 * {@code refresh_claim_unavailable}) nor the list round's manual poll. A lease this process holds blocks exactly as
 * before, for at most its two minutes; so does one that names no process (written by an earlier version).
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ManualTimelinePollProcessLeaseTest {
    private static final long LEASE_MS = 2L * 60L * 1000L;

    /** The claims made by ExpressDetailActivity and by ExpressSyncEngine.claimListManualTimelinePoll. */
    private enum Path { DETAIL_OPEN, DETAIL_OR_HOME_PULL, BACKGROUND_ROUND }

    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;
    private int nextWaybill = 1;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
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
    public void leaseTakenByAnotherProcessNoLongerBlocks() {
        String[] foreignHolders = {
                "synthetic-previous-process:" + UUID.randomUUID(),
                UUID.randomUUID() + ":" + UUID.randomUUID(),
        };
        for (String foreign : foreignHolders) {
            for (Path path : Path.values()) {
                ExpressItem owner = manualOwner();
                long now = System.currentTimeMillis();
                long takenAt = now - 60_000L;
                assertNotNull(repository.claimForegroundManualTimelinePoll(owner, takenAt, true));
                replaceLeaseHolder(owner, foreign);
                assertNotNull(path + " must not wait for a holder that died with its process",
                        claim(path, owner, now));
            }
        }
    }

    @Test
    public void leaseHeldByThisProcessBlocksForItsTwoMinutes() {
        for (boolean earlierVersion : new boolean[]{false, true}) {
            for (Path path : Path.values()) {
                ExpressItem owner = manualOwner();
                long takenAt = System.currentTimeMillis() - 60_000L;
                assertNotNull(repository.claimForegroundManualTimelinePoll(owner, takenAt, true));
                if (earlierVersion) replaceLeaseHolder(owner, UUID.randomUUID().toString());
                assertNull(path + " waits for a live holder", claim(path, owner, takenAt + 60_000L));
                assertNull(path + " waits for a live holder", claim(path, owner, takenAt + LEASE_MS - 1L));
                assertNotNull(path + " after the two-minute bound", claim(path, owner, takenAt + LEASE_MS));
            }
        }
    }

    private ExpressRepository.ManualTimelinePollClaim claim(Path path, ExpressItem owner, long now) {
        switch (path) {
            case DETAIL_OPEN:
                return repository.claimForegroundManualTimelinePoll(owner, now, false);
            case DETAIL_OR_HOME_PULL:
                return repository.claimForegroundManualTimelinePoll(owner, now, true);
            default:
                return repository.claimManualTimelinePoll(owner, now);
        }
    }

    private void replaceLeaseHolder(ExpressItem owner, String token) {
        ContentValues values = new ContentValues();
        values.put("attempt_token", token);
        assertEquals(1, database.getWritableDatabase().update(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                values, "owner_row_id=?", new String[]{Long.toString(owner.rowId)}));
    }

    /** A manually added SF parcel in transit, synthetic identifiers only. */
    private ExpressItem manualOwner() {
        String waybill = "SFPROCESSLEASE" + nextWaybill++;
        String eventTime = "2026-09-28 09:00:00";
        ContentValues values = new ContentValues();
        values.put("subPhone", "");
        values.put("mailNo", waybill);
        values.put("normalizedMailNo", ExpressSourcePolicy.normalizeWaybill(waybill));
        values.put("cpCode", "SF");
        values.put("cpName", "顺丰速运");
        values.put("logsiticsStatus", StatusSemantic.TRANSIT.storageCode);
        values.put("logisticsStatusDesc", StatusSemantic.TRANSIT.label);
        values.put("lastLogisticDetail", "快件运输中");
        values.put("logisticsGmtModified", eventTime);
        values.put("packageDyn", "[{\"time\":\"" + eventTime + "\",\"context\":\"快件运输中\"}]");
        values.put("canShow", 1);
        values.put("isDeleted", 0);
        values.put("fromCp", "KD-100");
        values.put("stateOwner", "KD-100");
        values.put("data1", "");
        values.put("data3", "manual");
        values.put("updatedAt", 1L);
        long rowId = database.getWritableDatabase().insertOrThrow(ExpressDatabase.EXPRESS_TABLE, null, values);
        ExpressItem owner = repository.find(rowId);
        assertNotNull(owner);
        return owner;
    }
}
