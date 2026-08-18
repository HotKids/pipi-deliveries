package me.pipi.deliveries.data;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import java.util.ArrayList;

/** SQLite schema for shipments, bound phones, local timelines and deletion tombstones. */
public final class ExpressDatabase extends SQLiteOpenHelper {
    private static final int LAST_LEGACY_SOURCE_VERSION = 7;
    public static final String DATABASE = "deliveries.db";
    public static final int VERSION = 13;
    public static final String EXPRESS_TABLE = "server_express";
    public static final String PHONE_TABLE = "express_phone";
    public static final String KUAIDI100_TIMELINE_TABLE = "aicy_k100_timeline";
    public static final String V4_TIMELINE_TABLE = "aicy_v4_timeline";
    public static final String INTERFACE6_TIMELINE_TABLE = "aicy_interface6_timeline";
    public static final String ACCOUNT_V5_TIMELINE_TABLE = "aicy_account_v5_timeline";
    public static final String ACCOUNT_V6_TIMELINE_TABLE = "aicy_account_v6_timeline";
    public static final String TOMBSTONE_TABLE = "aicy_express_tombstone";
    public static final String KUAIDI100_PENDING_TABLE = "aicy_k100_pending";
    public static final String ORDER_PROJECTION_TABLE = "aicy_order_projection";
    public static final String UNBOUND_ASSOCIATION_TABLE = "aicy_unbound_association";

    public ExpressDatabase(Context context) {
        super(context, DATABASE, null, VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        createExpressTables(db);
        ensureCanonicalColumns(db);
        createNativeSidecars(db);
        dropObsoleteTables(db);
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // Keep upgrades additive so installed users retain shipments and local timelines.
        createExpressTables(db);
        ensureCanonicalColumns(db);
        createNativeSidecars(db);
        if (oldVersion <= LAST_LEGACY_SOURCE_VERSION) {
            migrateLegacySourceNumbering(db);
        } else {
            migrateUnambiguousLegacySources(db);
        }
        migrateUnscopedPhoneBindings(db);
        migrateLegacyAccountTimelines(db);
        if (oldVersion < 11) migratePendingSourceKeys(db);
        sanitizePendingRouteOwnership(db);
        if (oldVersion < 12) migrateOrderProjectionSourceKeys(db);
        pruneAccountTimelines(db);
        dropObsoleteTables(db);
    }

    @Override
    public void onOpen(SQLiteDatabase db) {
        super.onOpen(db);
        createExpressTables(db);
        ensureCanonicalColumns(db);
        createNativeSidecars(db);
        dropObsoleteTables(db);
    }

    private static void createExpressTables(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS express_phone("
                + "_id INTEGER PRIMARY KEY AUTOINCREMENT,phone VARCHAR DEFAULT '',"
                + "bind_time INTEGER DEFAULT 0,sync_status VARCHAR DEFAULT '',uuid VARCHAR DEFAULT '')");
        db.execSQL("CREATE INDEX IF NOT EXISTS aicy_express_phone_source_idx "
                + "ON express_phone(sync_status,bind_time)");
        db.execSQL("CREATE TABLE IF NOT EXISTS server_express("
                + "_id INTEGER PRIMARY KEY AUTOINCREMENT,subPhone VARCHAR DEFAULT '',"
                + "senderPhone VARCHAR DEFAULT '',officialPhone VARCHAR DEFAULT '',"
                + "mailNo VARCHAR DEFAULT '',cpCode VARCHAR DEFAULT '',cpName VARCHAR DEFAULT '',"
                + "logsiticsStatus VARCHAR DEFAULT '',logisticsStatusDesc VARCHAR DEFAULT '',"
                + "lastLogisticDetail VARCHAR DEFAULT '',logisticsGmtModified VARCHAR DEFAULT '',"
                + "packageDyn VARCHAR DEFAULT '',canShow INTEGER DEFAULT 1,"
                + "interface5OrderNo VARCHAR DEFAULT '',"
                + "moreInfoUrl VARCHAR DEFAULT '',fromCp VARCHAR DEFAULT '',"
                + "remark VARCHAR DEFAULT '',isDeleted INTEGER DEFAULT 0,"
                + "data1 VARCHAR DEFAULT '',data2 VARCHAR DEFAULT '',data3 VARCHAR DEFAULT '',"
                + "normalizedMailNo VARCHAR DEFAULT '',statusEventTime INTEGER DEFAULT 0,"
                + "updatedAt INTEGER DEFAULT 0,stateOwner VARCHAR DEFAULT '',"
                + "routeOwner VARCHAR DEFAULT '',routeInterface VARCHAR DEFAULT '',"
                + "routeCredential VARCHAR DEFAULT '')");
        db.execSQL("CREATE INDEX IF NOT EXISTS aicy_express_mail_idx ON server_express(mailNo)");
    }

    private static void ensureCanonicalColumns(SQLiteDatabase db) {
        addColumnIfMissing(db, EXPRESS_TABLE, "normalizedMailNo", "VARCHAR DEFAULT ''");
        addColumnIfMissing(db, EXPRESS_TABLE, "statusEventTime", "INTEGER DEFAULT 0");
        addColumnIfMissing(db, EXPRESS_TABLE, "updatedAt", "INTEGER DEFAULT 0");
        addColumnIfMissing(db, EXPRESS_TABLE, "stateOwner", "VARCHAR DEFAULT ''");
        addColumnIfMissing(db, EXPRESS_TABLE, "routeOwner", "VARCHAR DEFAULT ''");
        addColumnIfMissing(db, EXPRESS_TABLE, "routeInterface", "VARCHAR DEFAULT ''");
        addColumnIfMissing(db, EXPRESS_TABLE, "routeCredential", "VARCHAR DEFAULT ''");
        db.execSQL("CREATE INDEX IF NOT EXISTS aicy_express_normalized_mail_idx "
                + "ON server_express(normalizedMailNo)");
    }

    private static void addColumnIfMissing(
            SQLiteDatabase db, String table, String column, String declaration) {
        try (Cursor cursor = db.rawQuery("PRAGMA table_info(" + table + ")", null)) {
            int name = cursor.getColumnIndex("name");
            while (cursor.moveToNext()) {
                if (column.equals(cursor.getString(name))) return;
            }
        }
        db.execSQL("ALTER TABLE " + table + " ADD COLUMN " + column + " " + declaration);
    }

    private static void createNativeSidecars(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS aicy_k100_timeline("
                + "normalized_waybill TEXT PRIMARY KEY NOT NULL,"
                + "waybill TEXT NOT NULL,courier_code TEXT DEFAULT '',"
                + "company_name TEXT DEFAULT '',status_code TEXT DEFAULT '',"
                + "latest_time TEXT DEFAULT '',latest_detail TEXT DEFAULT '',"
                + "tracks_json TEXT DEFAULT '[]',updated_at INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS aicy_v4_timeline("
                + "normalized_waybill TEXT PRIMARY KEY NOT NULL,"
                + "waybill TEXT NOT NULL,courier_code TEXT DEFAULT '',"
                + "company_name TEXT DEFAULT '',status_code TEXT DEFAULT '',"
                + "latest_time TEXT DEFAULT '',latest_detail TEXT DEFAULT '',"
                + "tracks_json TEXT DEFAULT '[]',updated_at INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS aicy_interface6_timeline("
                + "normalized_waybill TEXT PRIMARY KEY NOT NULL,"
                + "waybill TEXT NOT NULL,courier_code TEXT DEFAULT '',"
                + "company_name TEXT DEFAULT '',status_code TEXT DEFAULT '',"
                + "latest_time TEXT DEFAULT '',latest_detail TEXT DEFAULT '',"
                + "tracks_json TEXT DEFAULT '[]',updated_at INTEGER NOT NULL)");
        createTimelineTable(db, ACCOUNT_V5_TIMELINE_TABLE);
        createTimelineTable(db, ACCOUNT_V6_TIMELINE_TABLE);
        db.execSQL("CREATE TABLE IF NOT EXISTS aicy_express_tombstone("
                + "waybill_hash TEXT PRIMARY KEY NOT NULL,reason TEXT DEFAULT '',"
                + "created_at INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS aicy_k100_pending("
                + "normalized_waybill TEXT NOT NULL,"
                + "waybill TEXT NOT NULL,courier_code TEXT DEFAULT '',"
                + "company_name TEXT DEFAULT '',phone TEXT DEFAULT '',"
                + "binding_source TEXT DEFAULT 'interface6',"
                + "detail_url TEXT DEFAULT '',route_interface TEXT DEFAULT '',"
                + "route_credential TEXT DEFAULT '',"
                + "created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,"
                + "last_attempt_at INTEGER NOT NULL DEFAULT 0,"
                + "PRIMARY KEY(normalized_waybill,binding_source))");
        db.execSQL("CREATE TABLE IF NOT EXISTS aicy_order_projection("
                + "normalized_source_id TEXT NOT NULL,binding_source TEXT NOT NULL,"
                + "source_id TEXT NOT NULL,display_waybill TEXT NOT NULL,"
                + "normalized_display_waybill TEXT NOT NULL,"
                + "carrier_name TEXT DEFAULT '',tracks_json TEXT DEFAULT '[]',"
                + "updated_at INTEGER NOT NULL,"
                + "PRIMARY KEY(normalized_source_id,binding_source))");
        db.execSQL("CREATE TABLE IF NOT EXISTS aicy_unbound_association("
                + "waybill_hash TEXT NOT NULL,binding_source TEXT NOT NULL,"
                + "phone_hash TEXT NOT NULL,"
                + "PRIMARY KEY(waybill_hash,binding_source,phone_hash))");
        addColumnIfMissing(db, KUAIDI100_PENDING_TABLE,
                "detail_url", "TEXT DEFAULT ''");
        addColumnIfMissing(db, KUAIDI100_PENDING_TABLE,
                "route_interface", "TEXT DEFAULT ''");
        addColumnIfMissing(db, KUAIDI100_PENDING_TABLE,
                "route_credential", "TEXT DEFAULT ''");
        addColumnIfMissing(db, KUAIDI100_PENDING_TABLE,
                "binding_source", "TEXT DEFAULT 'interface6'");
        db.execSQL("CREATE INDEX IF NOT EXISTS aicy_k100_pending_attempt_idx "
                + "ON aicy_k100_pending(binding_source,last_attempt_at,created_at)");
        db.execSQL("CREATE INDEX IF NOT EXISTS aicy_unbound_association_phone_idx "
                + "ON aicy_unbound_association(binding_source,phone_hash)");
    }

    /** Adds account-source identity to pending-query keys without decrypting stored credentials. */
    private static void migratePendingSourceKeys(SQLiteDatabase db) {
        String replacement = KUAIDI100_PENDING_TABLE + "_source_key";
        db.execSQL("DROP TABLE IF EXISTS " + replacement);
        db.execSQL("CREATE TABLE " + replacement + "("
                + "normalized_waybill TEXT NOT NULL,waybill TEXT NOT NULL,"
                + "courier_code TEXT DEFAULT '',company_name TEXT DEFAULT '',"
                + "phone TEXT DEFAULT '',binding_source TEXT NOT NULL,"
                + "detail_url TEXT DEFAULT '',route_interface TEXT DEFAULT '',"
                + "route_credential TEXT DEFAULT '',created_at INTEGER NOT NULL,"
                + "updated_at INTEGER NOT NULL,last_attempt_at INTEGER NOT NULL DEFAULT 0,"
                + "PRIMARY KEY(normalized_waybill,binding_source))");
        db.execSQL("INSERT OR REPLACE INTO " + replacement
                + "(normalized_waybill,waybill,courier_code,company_name,phone,"
                + "binding_source,detail_url,route_interface,route_credential,created_at,"
                + "updated_at,last_attempt_at) SELECT normalized_waybill,waybill,courier_code,"
                + "company_name,phone,CASE WHEN LOWER(binding_source)='interface5'"
                + " THEN 'interface5' ELSE 'interface6' END,detail_url,route_interface,"
                + "route_credential,created_at,updated_at,last_attempt_at FROM "
                + KUAIDI100_PENDING_TABLE);
        db.execSQL("DROP TABLE " + KUAIDI100_PENDING_TABLE);
        db.execSQL("ALTER TABLE " + replacement + " RENAME TO "
                + KUAIDI100_PENDING_TABLE);
        db.execSQL("CREATE INDEX IF NOT EXISTS aicy_k100_pending_attempt_idx ON "
                + KUAIDI100_PENDING_TABLE
                + "(binding_source,last_attempt_at,created_at)");
    }

    /** Adds account-source identity to order projections without reading their route secrets. */
    private static void migrateOrderProjectionSourceKeys(SQLiteDatabase db) {
        String replacement = ORDER_PROJECTION_TABLE + "_source_key";
        db.execSQL("DROP TABLE IF EXISTS " + replacement);
        db.execSQL("CREATE TABLE " + replacement + "("
                + "normalized_source_id TEXT NOT NULL,binding_source TEXT NOT NULL,"
                + "source_id TEXT NOT NULL,display_waybill TEXT NOT NULL,"
                + "normalized_display_waybill TEXT NOT NULL,"
                + "carrier_name TEXT DEFAULT '',tracks_json TEXT DEFAULT '[]',"
                + "updated_at INTEGER NOT NULL,"
                + "PRIMARY KEY(normalized_source_id,binding_source))");
        copyOrderProjections(db, replacement, "interface5", "I5-JD", "I6-JD");
        copyOrderProjections(db, replacement, "interface6", "I6-JD", "I5-JD");
        db.execSQL("DROP TABLE " + ORDER_PROJECTION_TABLE);
        db.execSQL("ALTER TABLE " + replacement + " RENAME TO " + ORDER_PROJECTION_TABLE);
        pruneTombstonedOrderProjections(db);
        pruneOrphanedKuaidi100Timelines(db);
    }

    private static void copyOrderProjections(
            SQLiteDatabase db, String replacement, String bindingSource,
            String owner, String oppositeOwner) {
        db.execSQL("INSERT OR REPLACE INTO " + replacement
                + "(normalized_source_id,binding_source,source_id,display_waybill,"
                + "normalized_display_waybill,carrier_name,tracks_json,updated_at)"
                + " SELECT p.normalized_source_id,'" + bindingSource
                + "',p.source_id,p.display_waybill,"
                + "UPPER(REPLACE(REPLACE(TRIM(p.display_waybill),'-',''),'_','')),"
                + "p.carrier_name,'[]',"
                + "p.updated_at FROM " + ORDER_PROJECTION_TABLE + " p WHERE EXISTS (SELECT 1 FROM "
                + EXPRESS_TABLE + " s WHERE (s.normalizedMailNo=p.normalized_source_id"
                + " OR UPPER(s.mailNo)=UPPER(p.source_id))"
                + " AND (UPPER(s.stateOwner)='" + owner + "'"
                + " OR (COALESCE(s.stateOwner,'')='' AND UPPER(s.fromCp)='" + owner + "'))) ");
        db.execSQL("DELETE FROM " + replacement + " WHERE binding_source='" + bindingSource
                + "' AND EXISTS (SELECT 1 FROM " + EXPRESS_TABLE
                + " s WHERE (s.normalizedMailNo=" + replacement + ".normalized_source_id"
                + " OR UPPER(s.mailNo)=UPPER(" + replacement + ".source_id))"
                + " AND (UPPER(s.stateOwner)='" + oppositeOwner + "'"
                + " OR (COALESCE(s.stateOwner,'')='' AND UPPER(s.fromCp)='"
                + oppositeOwner + "')))");
    }

    private static void pruneTombstonedOrderProjections(SQLiteDatabase db) {
        ArrayList<String[]> rejected = new ArrayList<>();
        try (Cursor cursor = db.query(
                ORDER_PROJECTION_TABLE,
                new String[]{"normalized_source_id", "binding_source",
                        "normalized_display_waybill"},
                null, null, null, null, null)) {
            while (cursor.moveToNext()) {
                String displayHash = ExpressRepository.waybillHash(cursor.getString(2));
                try (Cursor tombstone = db.query(
                        TOMBSTONE_TABLE, new String[]{"waybill_hash"},
                        "waybill_hash=?", new String[]{displayHash},
                        null, null, null, "1")) {
                    if (tombstone.moveToFirst()) {
                        rejected.add(new String[]{cursor.getString(0), cursor.getString(1)});
                    }
                }
            }
        }
        for (String[] key : rejected) {
            db.delete(ORDER_PROJECTION_TABLE,
                    "normalized_source_id=? AND binding_source=?", key);
        }
    }

    private static void pruneOrphanedKuaidi100Timelines(SQLiteDatabase db) {
        String directReference = "SELECT 1 FROM " + EXPRESS_TABLE + " e"
                + " WHERE (e.normalizedMailNo=" + KUAIDI100_TIMELINE_TABLE
                + ".normalized_waybill OR UPPER(e.mailNo)=UPPER("
                + KUAIDI100_TIMELINE_TABLE + ".waybill))"
                + " AND e.canShow=1 AND e.isDeleted=0";
        String projectedReference = "SELECT 1 FROM " + ORDER_PROJECTION_TABLE + " p JOIN "
                + EXPRESS_TABLE + " e ON (e.normalizedMailNo=p.normalized_source_id"
                + " OR UPPER(e.mailNo)=UPPER(p.source_id))"
                + " WHERE (p.normalized_display_waybill=" + KUAIDI100_TIMELINE_TABLE
                + ".normalized_waybill OR UPPER(p.display_waybill)=UPPER("
                + KUAIDI100_TIMELINE_TABLE + ".waybill))"
                + " AND e.canShow=1 AND e.isDeleted=0"
                + " AND ((LOWER(p.binding_source)='interface5'"
                + " AND (UPPER(e.stateOwner)='I5-JD'"
                + " OR (COALESCE(e.stateOwner,'')='' AND UPPER(e.fromCp)='I5-JD')))"
                + " OR (LOWER(p.binding_source)='interface6'"
                + " AND (UPPER(e.stateOwner)='I6-JD'"
                + " OR (COALESCE(e.stateOwner,'')='' AND UPPER(e.fromCp)='I6-JD'))))";
        db.execSQL("DELETE FROM " + KUAIDI100_TIMELINE_TABLE
                + " WHERE NOT EXISTS (" + directReference + ")"
                + " AND NOT EXISTS (" + projectedReference + ")");
    }

    private static void createTimelineTable(SQLiteDatabase db, String table) {
        db.execSQL("CREATE TABLE IF NOT EXISTS " + table + "("
                + "normalized_waybill TEXT PRIMARY KEY NOT NULL,"
                + "waybill TEXT NOT NULL,courier_code TEXT DEFAULT '',"
                + "company_name TEXT DEFAULT '',status_code TEXT DEFAULT '',"
                + "latest_time TEXT DEFAULT '',latest_detail TEXT DEFAULT '',"
                + "tracks_json TEXT DEFAULT '[]',updated_at INTEGER NOT NULL)");
    }

    /** Swaps only the source numbering used by public database versions 7 and earlier. */
    private static void migrateLegacySourceNumbering(SQLiteDatabase db) {
        db.execSQL("UPDATE " + PHONE_TABLE + " SET sync_status=CASE LOWER(sync_status)"
                + " WHEN 'interface5' THEN 'interface6'"
                + " WHEN 'interface6' THEN 'interface5' ELSE sync_status END");
        for (String column : new String[]{"fromCp", "stateOwner", "routeOwner"}) {
            db.execSQL("UPDATE " + EXPRESS_TABLE + " SET " + column
                    + "=CASE UPPER(" + column + ")"
                    + " WHEN 'INTERFACE5' THEN 'INTERFACE6'"
                    + " WHEN 'INTERFACE6' THEN 'INTERFACE5'"
                    + " WHEN 'DISCOVERY' THEN 'INTERFACE5'"
                    + " WHEN 'I6-FALLBACK' THEN 'INTERFACE5'"
                    + " WHEN 'I6-JD' THEN 'I5-JD'"
                    + " WHEN 'I5-JD' THEN 'I6-JD' ELSE " + column + " END");
        }
        db.execSQL("UPDATE " + EXPRESS_TABLE + " SET routeInterface="
                + "CASE LOWER(routeInterface) WHEN 'v5' THEN 'v6'"
                + " WHEN 'v6' THEN 'v5' ELSE routeInterface END");
        db.execSQL("UPDATE " + EXPRESS_TABLE + " SET moreInfoUrl="
                + "CASE LOWER(moreInfoUrl) WHEN 'pipi-route:v5' THEN 'pipi-route:v6'"
                + " WHEN 'pipi-route:v6' THEN 'pipi-route:v5' ELSE moreInfoUrl END");
        db.execSQL("UPDATE " + KUAIDI100_PENDING_TABLE + " SET route_interface="
                + "CASE LOWER(route_interface) WHEN 'v5' THEN 'v6'"
                + " WHEN 'v6' THEN 'v5' ELSE route_interface END");
        db.execSQL("UPDATE " + KUAIDI100_PENDING_TABLE + " SET detail_url="
                + "CASE LOWER(detail_url) WHEN 'pipi-route:v5' THEN 'pipi-route:v6'"
                + " WHEN 'pipi-route:v6' THEN 'pipi-route:v5' ELSE detail_url END");
    }

    private static void migrateUnscopedPhoneBindings(SQLiteDatabase db) {
        db.execSQL("UPDATE " + PHONE_TABLE + " SET sync_status='interface6'"
                + " WHERE TRIM(LOWER(COALESCE(sync_status,''))) IN ('','native')");
    }

    private static void sanitizePendingRouteOwnership(SQLiteDatabase db) {
        db.execSQL("UPDATE " + KUAIDI100_PENDING_TABLE
                + " SET detail_url='',route_interface='',route_credential=''"
                + " WHERE (LOWER(binding_source)='interface5'"
                + " AND (LOWER(route_interface)='v6' OR LOWER(detail_url)='pipi-route:v6'))"
                + " OR (LOWER(binding_source)='interface6'"
                + " AND (LOWER(route_interface)='v5' OR LOWER(detail_url)='pipi-route:v5'))");
    }

    /** Repairs legacy-only owner markers even when an intermediate build already bumped the DB. */
    private static void migrateUnambiguousLegacySources(SQLiteDatabase db) {
        String markers = "'DISCOVERY','I6-FALLBACK','I6-JD'";
        String stateLegacy = "(UPPER(fromCp) IN (" + markers + ")"
                + " OR UPPER(stateOwner) IN (" + markers + "))";
        String routeLegacy = "UPPER(routeOwner) IN (" + markers + ")";
        // Intermediate builds could update a route without updating state ownership. Never
        // renumber a route whose explicit owner conflicts with the only safely identifiable row
        // markers; discard it so the selected source can rebuild it on its next sync.
        db.execSQL("UPDATE " + EXPRESS_TABLE
                + " SET moreInfoUrl='',routeInterface='',routeCredential='',routeOwner=''"
                + " WHERE (" + stateLegacy
                + " AND (COALESCE(routeOwner,'')=''"
                + " OR UPPER(routeOwner) NOT IN ('INTERFACE5'," + markers + ")))"
                + " OR (" + routeLegacy
                + " AND ((COALESCE(stateOwner,'')<>''"
                + " AND UPPER(stateOwner) NOT IN ('INTERFACE5'," + markers + "))"
                + " OR (COALESCE(stateOwner,'')='' AND COALESCE(fromCp,'')<>''"
                + " AND UPPER(fromCp) NOT IN ('INTERFACE5'," + markers + "))))");
        db.execSQL("UPDATE " + EXPRESS_TABLE
                + " SET routeOwner=CASE UPPER(routeOwner)"
                + " WHEN 'DISCOVERY' THEN 'INTERFACE5'"
                + " WHEN 'I6-FALLBACK' THEN 'INTERFACE5'"
                + " WHEN 'I6-JD' THEN 'I5-JD' ELSE routeOwner END,"
                + "routeInterface=CASE LOWER(routeInterface)"
                + " WHEN 'v6' THEN 'v5' ELSE routeInterface END,"
                + "moreInfoUrl=CASE LOWER(moreInfoUrl)"
                + " WHEN 'pipi-route:v6' THEN 'pipi-route:v5' ELSE moreInfoUrl END"
                + " WHERE " + routeLegacy);
        db.execSQL("UPDATE " + EXPRESS_TABLE
                + " SET fromCp=CASE UPPER(fromCp)"
                + " WHEN 'DISCOVERY' THEN 'INTERFACE5'"
                + " WHEN 'I6-FALLBACK' THEN 'INTERFACE5'"
                + " WHEN 'I6-JD' THEN 'I5-JD' ELSE fromCp END,"
                + "stateOwner=CASE UPPER(stateOwner)"
                + " WHEN 'DISCOVERY' THEN 'INTERFACE5'"
                + " WHEN 'I6-FALLBACK' THEN 'INTERFACE5'"
                + " WHEN 'I6-JD' THEN 'I5-JD' ELSE stateOwner END"
                + " WHERE " + stateLegacy);
    }

    private static void migrateLegacyAccountTimelines(SQLiteDatabase db) {
        String columns = "normalized_waybill,waybill,courier_code,company_name,status_code,"
                + "latest_time,latest_detail,tracks_json,updated_at";
        // The unscoped legacy sidecar was written only by the account source that is now v5.
        // If another source owns the same identity, fail closed and let it fetch its own timeline.
        db.execSQL("INSERT OR IGNORE INTO " + ACCOUNT_V5_TIMELINE_TABLE + "(" + columns + ") "
                + "SELECT " + columns + " FROM " + INTERFACE6_TIMELINE_TABLE + " t"
                + " WHERE EXISTS (SELECT 1 FROM server_express e WHERE"
                + " (e.normalizedMailNo=t.normalized_waybill"
                + " OR UPPER(e.mailNo)=UPPER(t.waybill))"
                + " AND (UPPER(e.stateOwner) IN ('INTERFACE5','I5-JD')"
                + " OR (COALESCE(e.stateOwner,'')=''"
                + " AND UPPER(e.fromCp) IN ('INTERFACE5','I5-JD'))))"
                + " AND NOT EXISTS (SELECT 1 FROM server_express e WHERE"
                + " (e.normalizedMailNo=t.normalized_waybill"
                + " OR UPPER(e.mailNo)=UPPER(t.waybill))"
                + " AND (UPPER(e.stateOwner) IN ('INTERFACE6','I6-JD')"
                + " OR (COALESCE(e.stateOwner,'')=''"
                + " AND UPPER(e.fromCp) IN ('INTERFACE6','I6-JD'))))");
    }

    private static void pruneAccountTimelines(SQLiteDatabase db) {
        pruneAccountTimeline(db, ACCOUNT_V5_TIMELINE_TABLE, "'INTERFACE5','I5-JD'");
        pruneAccountTimeline(db, ACCOUNT_V6_TIMELINE_TABLE, "'INTERFACE6','I6-JD'");
    }

    private static void pruneAccountTimeline(
            SQLiteDatabase db, String table, String owners) {
        db.execSQL("DELETE FROM " + table
                + " WHERE NOT EXISTS (SELECT 1 FROM " + EXPRESS_TABLE
                + " WHERE (" + EXPRESS_TABLE + ".normalizedMailNo="
                + table + ".normalized_waybill OR UPPER(" + EXPRESS_TABLE
                + ".mailNo)=UPPER(" + table + ".waybill))"
                + " AND " + EXPRESS_TABLE + ".canShow=1"
                + " AND " + EXPRESS_TABLE + ".isDeleted=0"
                + " AND (UPPER(stateOwner) IN (" + owners + ")"
                + " OR (COALESCE(stateOwner,'')=''"
                + " AND UPPER(fromCp) IN (" + owners + "))))");
    }

    private static void dropObsoleteTables(SQLiteDatabase db) {
        db.execSQL("DROP TABLE IF EXISTS aicy_query_history");
    }
}
