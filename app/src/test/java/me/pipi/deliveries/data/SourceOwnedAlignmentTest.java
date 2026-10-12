package me.pipi.deliveries.data;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.Context;
import java.util.List;
import me.pipi.deliveries.model.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;

/** Carrier identity cannot change the business source's alignment and signed-freeze rules. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class SourceOwnedAlignmentTest {
    private static final String PHONE = "13900006464", WAYBILL = "SFSOURCEBOUNDARY";
    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;
    private long base;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        repository.bindPhoneLocally(PHONE, "interface5");
        base = (System.currentTimeMillis() - 3_600_000) / 1000 * 1000;
    }

    @After public void close() { database.close(); context.deleteDatabase(ExpressDatabase.DATABASE); }

    @Test public void cainiaoSourceWithSfCarrierUsesItsKnownNewerHeadlineStatus() throws Exception {
        ExpressItem owner = save("Cainiao", "SF", StatusSemantic.DELIVERY, base, base + 120_000);
        ExpressItem shown = repository.listVisibleForHome("interface5").get(0);
        assertFalse(owner.isShunFengSource());
        assertEquals("SF", owner.courierCode);
        assertEquals(StatusSemantic.COMPLETED, shown.semantic);
        assertEquals(base + 120_000, shown.statusEventTime);
        assertFalse(probe(owner).headlineCoarse);
    }

    @Test public void sfSourceWithAnotherCarrierStillKeepsItsCoarseHeadlineBehindTheGate() throws Exception {
        ExpressItem owner = save("ShunFeng", "ZTO", StatusSemantic.DELIVERY, base, base + 120_000);
        assertTrue(owner.isShunFengSource());
        assertEquals(StatusSemantic.DELIVERY, repository.listVisibleForHome("interface5").get(0).semantic);
        assertTrue(probe(owner).headlineCoarse);
    }

    @Test public void aNonSfSourceWithSfCarrierCanReachTheOrdinarySignedTriple() throws Exception {
        ExpressItem owner = save("Cainiao", "SF", StatusSemantic.COMPLETED, base, base);
        assertFalse(probe(owner).headlineCoarse);
        assertFalse(probe(owner).detailCoarse);
        assertTrue(repository.signedFrozen(owner));
    }

    @Test public void aRealSfSourceStillNeedsNonCoarseSigningEvidence() throws Exception {
        ExpressItem owner = save("ShunFeng", "SF", StatusSemantic.COMPLETED, base, base);
        assertTrue(probe(owner).headlineCoarse);
        assertTrue(probe(owner).detailCoarse);
        assertFalse(repository.signedFrozen(owner));
    }

    private ExpressItem save(String provider, String code, StatusSemantic state, long statusAt, long headAt)
            throws Exception {
        String time = java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
                .withZone(java.time.ZoneId.of("Asia/Shanghai"))
                .format(java.time.Instant.ofEpochMilli(headAt));
        String tracks = new JSONArray().put(new JSONObject().put("time", time).put("context", "快件已签收")
                .put("statusCode", "107")).toString();
        repository.saveInterface5(new ExpressQueryResult(WAYBILL, code, "Synthetic carrier", state,
                statusAt, time, "快件已签收", tracks, "", PHONE, "interface5", "", "", provider)
                .withWorkerStatus(WorkerStatusProjection.read(new JSONObject().put("normalizedStatus",
                        new JSONObject().put("version", 1).put("scope", "SHIPMENT")
                                .put("semantic", state.name()).put("code", "SERVER_ENUM")
                                .put("text", state.label).put("priority", 5).put("eventAtMs", statusAt)
                                .put("structured", true)))), PHONE);
        ExpressItem owner = repository.findByWaybill(WAYBILL, "interface5");
        assertNotNull(owner);
        return owner;
    }

    private ExpressRepository.StatusAlignmentProbe probe(ExpressItem owner) {
        for (ExpressRepository.StatusAlignmentProbe probe : repository.statusAlignmentProbes("interface5")) {
            if (probe.row.rowId == owner.rowId) return probe;
        }
        throw new AssertionError("Missing alignment probe");
    }
}
