package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

import java.util.HashMap;
import java.util.Map;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressDatabaseContractTest {
    private Context context;
    private ExpressDatabase helper;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        helper = new ExpressDatabase(context);
    }

    @After
    public void tearDown() {
        helper.close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test
    public void nativeSidecarsExposeTheirRealKeysAndRetryIdentity() {
        SQLiteDatabase db = helper.getWritableDatabase();
        Map<String, Column> timeline = columns(db, ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE);
        Map<String, Column> route = columns(db, ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE);
        Map<String, Column> retry = columns(db, ExpressDatabase.OWNER_MANUAL_RETRY_TABLE);
        Map<String, Column> shipments = columns(db, ExpressDatabase.EXPRESS_TABLE);

        assertEquals(1, timeline.get("owner_row_id").primaryKeyOrder);
        assertEquals(2, timeline.get("provider").primaryKeyOrder);
        assertTrue(timeline.get("normalized_waybill").notNull);
        assertTrue(timeline.get("binding_source").notNull);
        assertTrue(timeline.get("success_at").notNull);
        assertEquals(1, retry.get("owner_row_id").primaryKeyOrder);
        assertTrue(retry.get("normalized_waybill").notNull);
        assertTrue(retry.get("binding_source").notNull);
        assertTrue(retry.get("owner_fingerprint").notNull);
        assertTrue(retry.get("last_attempt_at").notNull);
        assertTrue(shipments.containsKey("projectionRetryAt"));
        assertTrue(shipments.containsKey("projectionRetryRoute"));
        assertTrue(timeline.get("status_event_time").notNull);
        assertTrue(timeline.containsKey("status_description"));
        assertTrue(timeline.get("structured_status").notNull);
        assertTrue(timeline.containsKey("detail_url"));
        assertEquals(1, route.get("owner_row_id").primaryKeyOrder);
        assertEquals(2, route.get("provider").primaryKeyOrder);
        assertTrue(route.get("normalized_waybill").notNull);
        assertTrue(route.get("owner_source").notNull);
        assertTrue(route.get("owner_source_provider").notNull);
        assertTrue(route.get("binding_source").notNull);
        assertTrue(route.get("binding_generation").notNull);
        assertTrue(route.get("detail_url").notNull);
        assertEquals(20, ExpressDatabase.VERSION);
        assertTrue(shipments.containsKey("carrierStandardCode"));
        assertTrue(shipments.containsKey("carrierDisplayName"));
        assertTrue(shipments.containsKey("carrierKuaidi100Code"));
        assertTrue(shipments.containsKey("carrierIsBuiltIn"));
        assertTrue(shipments.containsKey("carrierTableVersion"));
    }

    @Test
    public void version14UpgradePreservesRowsAndAddsCurrentState() {
        SQLiteDatabase legacy = context.openOrCreateDatabase(
                ExpressDatabase.DATABASE, Context.MODE_PRIVATE, null);
        createVersion14Schema(legacy);
        ContentValues row = new ContentValues();
        row.put("mailNo", "UPGRADE000001");
        row.put("normalizedMailNo", "UPGRADE000001");
        row.put("fromCp", "INTERFACE5");
        row.put("stateOwner", "INTERFACE5");
        legacy.insertOrThrow(ExpressDatabase.EXPRESS_TABLE, null, row);
        legacy.setVersion(14);
        legacy.close();

        SQLiteDatabase upgraded = helper.getWritableDatabase();

        assertEquals(ExpressDatabase.VERSION, upgraded.getVersion());
        assertTrue(columns(upgraded, ExpressDatabase.EXPRESS_TABLE)
                .containsKey("projectionRetryAt"));
        assertTrue(columns(upgraded, ExpressDatabase.EXPRESS_TABLE)
                .containsKey("projectionRetryRoute"));
        assertTrue(columns(upgraded, ExpressDatabase.OWNER_MANUAL_RETRY_TABLE)
                .containsKey("owner_fingerprint"));
        try (Cursor cursor = upgraded.query(
                ExpressDatabase.EXPRESS_TABLE,
                new String[]{"mailNo", "projectionRetryAt", "projectionRetryRoute"},
                "normalizedMailNo=?", new String[]{"UPGRADE000001"},
                null, null, null)) {
            assertTrue(cursor.moveToFirst());
            assertEquals("UPGRADE000001", cursor.getString(0));
            assertEquals(0L, cursor.getLong(1));
            assertEquals("", cursor.getString(2));
        }
    }

    @Test
    public void futureSchemaDowngradePreservesKnownRows() {
        SQLiteDatabase current = helper.getWritableDatabase();
        ContentValues row = new ContentValues();
        row.put("mailNo", "DOWNGRADE000001");
        row.put("normalizedMailNo", "DOWNGRADE000001");
        current.insertOrThrow(ExpressDatabase.EXPRESS_TABLE, null, row);
        current.execSQL("CREATE TABLE future_extension(value TEXT)");
        helper.close();

        SQLiteDatabase future = context.openOrCreateDatabase(
                ExpressDatabase.DATABASE, Context.MODE_PRIVATE, null);
        future.setVersion(ExpressDatabase.VERSION + 1);
        future.close();

        helper = new ExpressDatabase(context);
        SQLiteDatabase downgraded = helper.getWritableDatabase();

        assertEquals(ExpressDatabase.VERSION, downgraded.getVersion());
        assertTrue(tableExists(downgraded, "future_extension"));
        try (Cursor cursor = downgraded.query(
                ExpressDatabase.EXPRESS_TABLE, new String[]{"mailNo"},
                "normalizedMailNo=?", new String[]{"DOWNGRADE000001"},
                null, null, null)) {
            assertTrue(cursor.moveToFirst());
            assertEquals("DOWNGRADE000001", cursor.getString(0));
        }
    }

    @Test
    public void version15UpgradePreservesManualTimelineAndAddsStatusEventTime() {
        SQLiteDatabase legacy = context.openOrCreateDatabase(
                ExpressDatabase.DATABASE, Context.MODE_PRIVATE, null);
        createVersion14Schema(legacy);
        legacy.execSQL("ALTER TABLE " + ExpressDatabase.EXPRESS_TABLE
                + " ADD COLUMN projectionRetryAt INTEGER DEFAULT 0");
        legacy.execSQL("ALTER TABLE " + ExpressDatabase.EXPRESS_TABLE
                + " ADD COLUMN projectionRetryRoute VARCHAR DEFAULT ''");
        legacy.execSQL("CREATE TABLE " + ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE + "("
                + "owner_row_id INTEGER NOT NULL,normalized_waybill TEXT NOT NULL,"
                + "binding_source TEXT NOT NULL,provider TEXT NOT NULL,"
                + "waybill TEXT NOT NULL,courier_code TEXT DEFAULT '',"
                + "company_name TEXT DEFAULT '',status_code TEXT DEFAULT '',"
                + "latest_time TEXT DEFAULT '',latest_detail TEXT DEFAULT '',"
                + "tracks_json TEXT DEFAULT '[]',phone TEXT DEFAULT '',"
                + "success_at INTEGER NOT NULL,complete INTEGER NOT NULL DEFAULT 0,"
                + "PRIMARY KEY(owner_row_id,provider))");
        ContentValues sidecar = new ContentValues();
        sidecar.put("owner_row_id", 91L);
        sidecar.put("normalized_waybill", "UPGRADE000091");
        sidecar.put("binding_source", "interface5");
        sidecar.put("provider", "kuaidi100");
        sidecar.put("waybill", "UPGRADE000091");
        sidecar.put("status_code", "SIGN");
        sidecar.put("latest_time", "2026-08-24 12:00:00");
        sidecar.put("latest_detail", "快件已签收");
        sidecar.put("success_at", 123L);
        sidecar.put("complete", 1);
        legacy.insertOrThrow(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null, sidecar);
        legacy.setVersion(15);
        legacy.close();

        SQLiteDatabase upgraded = helper.getWritableDatabase();

        assertEquals(ExpressDatabase.VERSION, upgraded.getVersion());
        Column eventTime = columns(
                upgraded, ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE)
                .get("status_event_time");
        assertTrue(eventTime.notNull);
        try (Cursor cursor = upgraded.query(
                ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                new String[]{"waybill", "status_code", "status_event_time"},
                "owner_row_id=?", new String[]{"91"}, null, null, null)) {
            assertTrue(cursor.moveToFirst());
            assertEquals("UPGRADE000091", cursor.getString(0));
            assertEquals("SIGN", cursor.getString(1));
            assertEquals(0L, cursor.getLong(2));
        }
    }

    @Test
    public void version16UpgradeInvalidatesOnlyLegacyInterface5SfManualState() {
        SQLiteDatabase legacy = context.openOrCreateDatabase(
                ExpressDatabase.DATABASE, Context.MODE_PRIVATE, null);
        createVersion16Schema(legacy);
        insertOwner(legacy, 101L, "SF-UPGRADE-101", " interface5 ", " ShunFeng ", "");
        insertOwner(legacy, 102L, "OTHER-UPGRADE-102", "INTERFACE5", "CaiNiao", "");
        insertOwner(legacy, 103L, "SF-UPGRADE-103", "INTERFACE6", "ShunFeng", "");
        insertOwner(legacy, 104L, "SF-UPGRADE-104", "INTERFACE5", "ShunFeng", "manual");
        insertOwner(legacy, 105L, "SF-UPGRADE-105", "INTERFACE5", "ShunFeng", "");
        insertManualSidecar(legacy, 101L, "SF-UPGRADE-101", "interface5");
        insertManualSidecar(legacy, 101L, "SF-UPGRADE-101", "kuaidi100");
        insertManualSidecar(legacy, 102L, "OTHER-UPGRADE-102", "interface5");
        insertManualSidecar(legacy, 103L, "SF-UPGRADE-103", "interface5");
        insertManualSidecar(legacy, 104L, "SF-UPGRADE-104", "interface5");
        insertManualSidecar(legacy, 105L, "SF-UPGRADE-105", "kuaidi100");
        ContentValues completed = new ContentValues();
        completed.put("status_code", "SIGN");
        completed.put("status_event_time", 123L);
        legacy.update(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, completed,
                "owner_row_id=? AND provider=?", new String[]{"105", "kuaidi100"});
        for (long ownerId = 101L; ownerId <= 105L; ownerId++) {
            insertRetryReservation(legacy, ownerId, "UPGRADE-" + ownerId);
        }
        legacy.setVersion(16);
        legacy.close();

        SQLiteDatabase upgraded = helper.getWritableDatabase();

        assertEquals(ExpressDatabase.VERSION, upgraded.getVersion());
        assertEquals(5, count(upgraded, ExpressDatabase.EXPRESS_TABLE, null, null));
        assertEquals(0, count(upgraded, ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=? AND provider=?", new String[]{"101", "interface5"}));
        assertEquals(0, count(upgraded, ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=? AND provider=?", new String[]{"101", "kuaidi100"}));
        assertEquals(1, count(upgraded, ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=? AND provider=?", new String[]{"102", "interface5"}));
        assertEquals(1, count(upgraded, ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=? AND provider=?", new String[]{"103", "interface5"}));
        assertEquals(1, count(upgraded, ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=? AND provider=?", new String[]{"104", "interface5"}));
        assertEquals(1, count(upgraded, ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=? AND provider=?", new String[]{"105", "kuaidi100"}));
        assertEquals(0, count(upgraded, ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "owner_row_id=?", new String[]{"101"}));
        assertEquals(1, count(upgraded, ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "owner_row_id=?", new String[]{"102"}));
        assertEquals(1, count(upgraded, ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "owner_row_id=?", new String[]{"103"}));
        assertEquals(1, count(upgraded, ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "owner_row_id=?", new String[]{"104"}));
        assertEquals(0, count(upgraded, ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "owner_row_id=?", new String[]{"105"}));
    }

    @Test
    public void version18UpgradeFreezesOnlyEligibleOwnersAndHydratesUniqueLegacyTail() {
        SQLiteDatabase legacy = context.openOrCreateDatabase(
                ExpressDatabase.DATABASE, Context.MODE_PRIVATE, null);
        createVersion14Schema(legacy);
        ContentValues binding = new ContentValues();
        binding.put("phone", "13910000009");
        binding.put("bind_time", 100L);
        binding.put("sync_status", "interface6");
        binding.put("uuid", "generation-0009");
        legacy.insertOrThrow(ExpressDatabase.PHONE_TABLE, null, binding);

        ContentValues automatic = legacyShipment(
                201L, "MIGRATE000009", "INTERFACE6", "ZTO", "中通快递", "0009");
        automatic.put("updatedAt", 200L);
        automatic.put("statusEventTime", 180L);
        automatic.put("data1", "CaiNiao");
        legacy.insertOrThrow(ExpressDatabase.EXPRESS_TABLE, null, automatic);

        ContentValues chineseNameOnly = legacyShipment(
                204L, "MIGRATE000204", "INTERFACE6", "", "顺丰速运", "0009");
        chineseNameOnly.put("updatedAt", 210L);
        chineseNameOnly.put("statusEventTime", 190L);
        chineseNameOnly.put("data1", "CaiNiao");
        legacy.insertOrThrow(ExpressDatabase.EXPRESS_TABLE, null, chineseNameOnly);

        ContentValues deletedVivoJd = legacyShipment(
                202L, "VIVOJD000202", "VIVO", "JD", "京东购物", "0009");
        deletedVivoJd.put("data1", "JingDong");
        legacy.insertOrThrow(ExpressDatabase.EXPRESS_TABLE, null, deletedVivoJd);

        ContentValues manual = legacyShipment(
                203L, "MANUAL000203", "KD-100", "SF", "顺丰速运", "");
        manual.put("data3", "manual");
        legacy.insertOrThrow(ExpressDatabase.EXPRESS_TABLE, null, manual);
        legacy.setVersion(18);
        legacy.close();

        SQLiteDatabase upgraded = helper.getWritableDatabase();

        assertEquals(0, count(upgraded, ExpressDatabase.EXPRESS_TABLE,
                "normalizedMailNo=?", new String[]{"VIVOJD000202"}));
        assertEquals(1, count(upgraded, ExpressDatabase.EXPRESS_TABLE,
                "normalizedMailNo=?", new String[]{"MIGRATE000009"}));
        assertEquals(0, count(upgraded, ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE,
                "normalized_waybill=?", new String[]{"MANUAL000203"}));
        try (Cursor owner = upgraded.query(
                ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE,
                new String[]{"owner_provider", "owner_binding_generation", "owner_row_id"},
                "normalized_waybill=?", new String[]{"MIGRATE000009"},
                null, null, null)) {
            assertTrue(owner.moveToFirst());
            assertEquals("INTERFACE6", owner.getString(0));
            assertEquals("generation-0009", owner.getString(1));
            assertEquals(201L, owner.getLong(2));
        }
        try (Cursor observation = upgraded.query(
                ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                new String[]{"owner_provider", "binding_generation", "qualified"},
                "normalized_waybill=?", new String[]{"MIGRATE000009"},
                null, null, null)) {
            assertTrue(observation.moveToFirst());
            assertEquals("INTERFACE6", observation.getString(0));
            assertEquals("generation-0009", observation.getString(1));
            assertEquals(1, observation.getInt(2));
        }
        try (Cursor observation = upgraded.query(
                ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                new String[]{"courier_code", "company_name", "qualified"},
                "normalized_waybill=?", new String[]{"MIGRATE000204"},
                null, null, null)) {
            assertTrue(observation.moveToFirst());
            assertEquals("", observation.getString(0));
            assertEquals("顺丰速运", observation.getString(1));
            assertEquals(1, observation.getInt(2));
        }
    }

    private static void createVersion16Schema(SQLiteDatabase db) {
        createVersion14Schema(db);
        db.execSQL("ALTER TABLE " + ExpressDatabase.EXPRESS_TABLE
                + " ADD COLUMN projectionRetryAt INTEGER DEFAULT 0");
        db.execSQL("ALTER TABLE " + ExpressDatabase.EXPRESS_TABLE
                + " ADD COLUMN projectionRetryRoute VARCHAR DEFAULT ''");
        db.execSQL("CREATE TABLE " + ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE + "("
                + "owner_row_id INTEGER NOT NULL,normalized_waybill TEXT NOT NULL,"
                + "binding_source TEXT NOT NULL,provider TEXT NOT NULL,"
                + "waybill TEXT NOT NULL,courier_code TEXT DEFAULT '',"
                + "company_name TEXT DEFAULT '',status_code TEXT DEFAULT '',"
                + "status_event_time INTEGER NOT NULL DEFAULT 0,"
                + "latest_time TEXT DEFAULT '',latest_detail TEXT DEFAULT '',"
                + "tracks_json TEXT DEFAULT '[]',phone TEXT DEFAULT '',"
                + "success_at INTEGER NOT NULL,complete INTEGER NOT NULL DEFAULT 0,"
                + "PRIMARY KEY(owner_row_id,provider))");
        db.execSQL("CREATE TABLE " + ExpressDatabase.OWNER_MANUAL_RETRY_TABLE + "("
                + "owner_row_id INTEGER PRIMARY KEY NOT NULL,"
                + "normalized_waybill TEXT NOT NULL,binding_source TEXT NOT NULL,"
                + "owner_fingerprint TEXT NOT NULL,last_attempt_at INTEGER NOT NULL)");
    }

    private static void insertOwner(
            SQLiteDatabase db, long rowId, String waybill,
            String owner, String provider, String manualMarker) {
        ContentValues values = new ContentValues();
        values.put("_id", rowId);
        values.put("mailNo", waybill);
        values.put("normalizedMailNo", waybill.replace("-", ""));
        values.put("fromCp", owner);
        values.put("stateOwner", owner);
        values.put("data1", provider);
        values.put("data3", manualMarker);
        db.insertOrThrow(ExpressDatabase.EXPRESS_TABLE, null, values);
    }

    private static ContentValues legacyShipment(
            long rowId, String waybill, String owner,
            String courierCode, String companyName, String phoneTail) {
        ContentValues values = new ContentValues();
        values.put("_id", rowId);
        values.put("mailNo", waybill);
        values.put("normalizedMailNo", waybill);
        values.put("subPhone", phoneTail);
        values.put("cpCode", courierCode);
        values.put("cpName", companyName);
        values.put("logsiticsStatus", "TRANSIT");
        values.put("logisticsStatusDesc", "运输中");
        values.put("lastLogisticDetail", "运输中");
        values.put("logisticsGmtModified", "2026-08-30 12:00:00");
        values.put("fromCp", owner);
        values.put("stateOwner", owner);
        return values;
    }

    private static void insertManualSidecar(
            SQLiteDatabase db, long ownerId, String waybill, String provider) {
        ContentValues values = new ContentValues();
        values.put("owner_row_id", ownerId);
        values.put("normalized_waybill", waybill.replace("-", ""));
        values.put("binding_source", "interface5");
        values.put("provider", provider);
        values.put("waybill", waybill);
        values.put("status_code", "AGENT_SIGN");
        values.put("status_event_time", 123L);
        values.put("latest_time", "2026-08-24 12:00:00");
        values.put("latest_detail", "待取件");
        values.put("tracks_json", "[{\"time\":\"2026-08-24 12:00:00\","
                + "\"context\":\"待取件\"}]");
        values.put("success_at", 456L);
        values.put("complete", 1);
        db.insertOrThrow(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null, values);
    }

    private static void insertRetryReservation(
            SQLiteDatabase db, long ownerId, String normalizedWaybill) {
        ContentValues values = new ContentValues();
        values.put("owner_row_id", ownerId);
        values.put("normalized_waybill", normalizedWaybill.replace("-", ""));
        values.put("binding_source", "interface5");
        values.put("owner_fingerprint", "fingerprint-" + ownerId);
        values.put("last_attempt_at", 789L);
        db.insertOrThrow(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE, null, values);
    }

    private static int count(
            SQLiteDatabase db, String table, String selection, String[] args) {
        try (Cursor cursor = db.query(
                table, new String[]{"COUNT(*)"}, selection, args,
                null, null, null)) {
            assertTrue(cursor.moveToFirst());
            return cursor.getInt(0);
        }
    }

    private static boolean tableExists(SQLiteDatabase db, String table) {
        try (Cursor cursor = db.query(
                "sqlite_master", new String[]{"name"},
                "type='table' AND name=?", new String[]{table},
                null, null, null)) {
            return cursor.moveToFirst();
        }
    }

    private static void createVersion14Schema(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE express_phone("
                + "_id INTEGER PRIMARY KEY AUTOINCREMENT,phone VARCHAR DEFAULT '',"
                + "bind_time INTEGER DEFAULT 0,sync_status VARCHAR DEFAULT '',"
                + "uuid VARCHAR DEFAULT '')");
        db.execSQL("CREATE TABLE server_express("
                + "_id INTEGER PRIMARY KEY AUTOINCREMENT,subPhone VARCHAR DEFAULT '',"
                + "senderPhone VARCHAR DEFAULT '',officialPhone VARCHAR DEFAULT '',"
                + "mailNo VARCHAR DEFAULT '',cpCode VARCHAR DEFAULT '',cpName VARCHAR DEFAULT '',"
                + "logsiticsStatus VARCHAR DEFAULT '',logisticsStatusDesc VARCHAR DEFAULT '',"
                + "lastLogisticDetail VARCHAR DEFAULT '',logisticsGmtModified VARCHAR DEFAULT '',"
                + "packageDyn VARCHAR DEFAULT '',canShow INTEGER DEFAULT 1,"
                + "interface5OrderNo VARCHAR DEFAULT '',moreInfoUrl VARCHAR DEFAULT '',"
                + "fromCp VARCHAR DEFAULT '',remark VARCHAR DEFAULT '',isDeleted INTEGER DEFAULT 0,"
                + "data1 VARCHAR DEFAULT '',data2 VARCHAR DEFAULT '',data3 VARCHAR DEFAULT '',"
                + "normalizedMailNo VARCHAR DEFAULT '',statusEventTime INTEGER DEFAULT 0,"
                + "updatedAt INTEGER DEFAULT 0,stateOwner VARCHAR DEFAULT '',"
                + "routeOwner VARCHAR DEFAULT '',routeInterface VARCHAR DEFAULT '',"
                + "routeCredential VARCHAR DEFAULT '')");
    }

    private static Map<String, Column> columns(SQLiteDatabase db, String table) {
        HashMap<String, Column> result = new HashMap<>();
        try (Cursor cursor = db.rawQuery("PRAGMA table_info(" + table + ")", null)) {
            int name = cursor.getColumnIndexOrThrow("name");
            int notNull = cursor.getColumnIndexOrThrow("notnull");
            int primaryKey = cursor.getColumnIndexOrThrow("pk");
            while (cursor.moveToNext()) {
                result.put(cursor.getString(name), new Column(
                        cursor.getInt(notNull) != 0, cursor.getInt(primaryKey)));
            }
        }
        return result;
    }

    private static final class Column {
        final boolean notNull;
        final int primaryKeyOrder;

        Column(boolean notNull, int primaryKeyOrder) {
            this.notNull = notNull;
            this.primaryKeyOrder = primaryKeyOrder;
        }
    }
}
