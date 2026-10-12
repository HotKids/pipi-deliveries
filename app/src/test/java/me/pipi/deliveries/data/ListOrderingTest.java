package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;

import android.app.Application;
import android.content.Context;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
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

/**
 * Audit L13 (user 2026-09-25): inside one status group the list is ordered by the time each row
 * shows (its headline time), newest first, as on iOS and Pipi — not by the structured status time,
 * which can be newer than a row's newest shown node.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ListOrderingTest {
    private static final String PHONE = "13800000013";
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            .withZone(ZoneId.of("Asia/Shanghai"));
    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        repository.bindPhoneLocally(PHONE, "interface5");
    }

    @After public void tearDown() {
        database.close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void aGroupIsOrderedByTheTimeEachRowShows() throws Exception {
        long now = System.currentTimeMillis();
        // A: newer structured status, older shown node. B: older status, newer shown node.
        save("YT7000000000131", now - 10 * 60_000L, now - 60 * 60_000L, "A 的节点");
        save("YT7000000000132", now - 30 * 60_000L, now - 20 * 60_000L, "B 的节点");

        List<ExpressItem> rows = repository.listVisible("interface5");
        assertEquals(2, rows.size());
        assertEquals("YT7000000000132", rows.get(0).waybill);
        assertEquals("YT7000000000131", rows.get(1).waybill);
    }

    private void save(String waybill, long statusAt, long nodeAt, String detail) throws Exception {
        String time = TIME.format(Instant.ofEpochMilli(nodeAt));
        String tracks = new JSONArray().put(new JSONObject().put("time", time)
                .put("context", detail)).toString();
        repository.saveInterface5(new ExpressQueryResult(waybill, "YTO", "圆通速递",
                StatusSemantic.TRANSIT, statusAt, time, detail, tracks, "", PHONE,
                TimelineSlot.V5_QUERY, "", "", "CaiNiao")
                .withWorkerStatus(WorkerStatusProjection.read(new JSONObject()
                        .put("normalizedStatus", new JSONObject().put("version", 1)
                                .put("scope", "SHIPMENT").put("semantic", "TRANSIT")
                                .put("code", "104").put("text", "运输中").put("priority", 0)
                                .put("eventAtMs", statusAt).put("structured", true)))), PHONE);
    }
}
