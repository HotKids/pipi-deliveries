package me.pipi.deliveries.data;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/** SQLite schema for shipments, bound phones and local timelines. */
public final class ExpressDatabase extends SQLiteOpenHelper {
    private static final int LAST_LEGACY_SOURCE_VERSION = 7;
    public static final String DATABASE = "deliveries.db";
    public static final int VERSION = 20;
    public static final String EXPRESS_TABLE = "server_express";
    public static final String PHONE_TABLE = "express_phone";
    public static final String KUAIDI100_TIMELINE_TABLE = "aicy_k100_timeline";
    public static final String V4_TIMELINE_TABLE = "aicy_v4_timeline";
    public static final String INTERFACE6_TIMELINE_TABLE = "aicy_interface6_timeline";
    public static final String ACCOUNT_V5_TIMELINE_TABLE = "aicy_account_v5_timeline";
    public static final String ACCOUNT_V6_TIMELINE_TABLE = "aicy_account_v6_timeline";
    public static final String OWNER_MANUAL_TIMELINE_TABLE = "aicy_owner_manual_timeline";
    public static final String OWNER_MANUAL_ROUTE_TABLE = "aicy_owner_manual_route";
    public static final String OWNER_MANUAL_RETRY_TABLE = "aicy_owner_manual_retry";
    public static final String KUAIDI100_PENDING_TABLE = "aicy_k100_pending";
    public static final String ORDER_PROJECTION_TABLE = "aicy_order_projection";
    public static final String UNBOUND_ASSOCIATION_TABLE = "aicy_unbound_association";
    public static final String AUTOMATIC_OWNERSHIP_TABLE = "aicy_automatic_ownership";
    public static final String AUTOMATIC_OBSERVATION_TABLE = "aicy_automatic_observation";
    private final Context context;

    public ExpressDatabase(Context context) {
        super(context, DATABASE, null, VERSION);
        Context application = context.getApplicationContext();
        this.context = application == null ? context : application;
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
        if (oldVersion < 17) invalidateLegacyInterface5SfManualState(db);
        migrateUnscopedPhoneBindings(db);
        migrateLegacyAccountTimelines(db);
        if (oldVersion < 11) migratePendingSourceKeys(db);
        sanitizePendingRouteOwnership(db);
        if (oldVersion < 12) migrateOrderProjectionSourceKeys(db);
        ensurePhoneBindingGenerations(db);
        if (oldVersion == 19) migrateAutomaticBindingIdentity(db);
        if (oldVersion < 19) migrateAutomaticOwnership(db, activeBindingSource());
        if (oldVersion < 20) hydrateAutomaticOwnerBindingIdentity(db);
        pruneAccountTimelines(db);
        dropObsoleteTables(db);
    }

    @Override
    public void onDowngrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // Keep known rows readable when a newer database is opened by this schema version.
        // Unknown future columns and tables are intentionally left intact.
        createExpressTables(db);
        ensureCanonicalColumns(db);
        createNativeSidecars(db);
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
                + "routeCredential VARCHAR DEFAULT '',"
                + "carrierStandardCode VARCHAR DEFAULT '',"
                + "carrierDisplayName VARCHAR DEFAULT '',"
                + "carrierKuaidi100Code VARCHAR DEFAULT '',"
                + "carrierIsBuiltIn INTEGER DEFAULT -1,"
                + "carrierTableVersion VARCHAR DEFAULT '',"
                + "projectionRetryAt INTEGER DEFAULT 0,"
                + "projectionRetryRoute VARCHAR DEFAULT '')");
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
        addColumnIfMissing(db, EXPRESS_TABLE,
                "carrierStandardCode", "VARCHAR DEFAULT ''");
        addColumnIfMissing(db, EXPRESS_TABLE,
                "carrierDisplayName", "VARCHAR DEFAULT ''");
        addColumnIfMissing(db, EXPRESS_TABLE,
                "carrierKuaidi100Code", "VARCHAR DEFAULT ''");
        addColumnIfMissing(db, EXPRESS_TABLE,
                "carrierIsBuiltIn", "INTEGER DEFAULT -1");
        addColumnIfMissing(db, EXPRESS_TABLE,
                "carrierTableVersion", "VARCHAR DEFAULT ''");
        addColumnIfMissing(db, EXPRESS_TABLE,
                "projectionRetryAt", "INTEGER DEFAULT 0");
        addColumnIfMissing(db, EXPRESS_TABLE,
                "projectionRetryRoute", "VARCHAR DEFAULT ''");
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
        // Global timeline rows cannot be assigned to an account owner without ownership evidence,
        // so this owner-scoped cache intentionally starts empty on upgrade.
        db.execSQL("CREATE TABLE IF NOT EXISTS " + OWNER_MANUAL_TIMELINE_TABLE + "("
                + "owner_row_id INTEGER NOT NULL,normalized_waybill TEXT NOT NULL,"
                + "binding_source TEXT NOT NULL,provider TEXT NOT NULL,"
                + "waybill TEXT NOT NULL,courier_code TEXT DEFAULT '',"
                + "company_name TEXT DEFAULT '',status_code TEXT DEFAULT '',"
                + "status_event_time INTEGER NOT NULL DEFAULT 0,"
                + "status_description TEXT DEFAULT '',"
                + "structured_status INTEGER NOT NULL DEFAULT 0,"
                + "latest_time TEXT DEFAULT '',latest_detail TEXT DEFAULT '',"
                + "tracks_json TEXT DEFAULT '[]',detail_url TEXT DEFAULT '',"
                + "phone TEXT DEFAULT '',"
                + "success_at INTEGER NOT NULL,complete INTEGER NOT NULL DEFAULT 0,"
                + "PRIMARY KEY(owner_row_id,provider))");
        addColumnIfMissing(db, OWNER_MANUAL_TIMELINE_TABLE,
                "status_event_time", "INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db, OWNER_MANUAL_TIMELINE_TABLE,
                "status_description", "TEXT DEFAULT ''");
        addColumnIfMissing(db, OWNER_MANUAL_TIMELINE_TABLE,
                "structured_status", "INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db, OWNER_MANUAL_TIMELINE_TABLE,
                "detail_url", "TEXT DEFAULT ''");
        db.execSQL("CREATE INDEX IF NOT EXISTS aicy_owner_manual_timeline_waybill_idx ON "
                + OWNER_MANUAL_TIMELINE_TABLE
                + "(binding_source,normalized_waybill)");
        db.execSQL("CREATE INDEX IF NOT EXISTS aicy_owner_manual_timeline_success_idx ON "
                + OWNER_MANUAL_TIMELINE_TABLE + "(owner_row_id,success_at)");
        db.execSQL("CREATE TABLE IF NOT EXISTS " + OWNER_MANUAL_ROUTE_TABLE + "("
                + "owner_row_id INTEGER NOT NULL,normalized_waybill TEXT NOT NULL,"
                + "owner_source TEXT NOT NULL,owner_source_provider TEXT NOT NULL,"
                + "binding_source TEXT NOT NULL,binding_generation TEXT NOT NULL,"
                + "provider TEXT NOT NULL,detail_url TEXT NOT NULL,"
                + "success_at INTEGER NOT NULL,PRIMARY KEY(owner_row_id,provider))");
        db.execSQL("CREATE INDEX IF NOT EXISTS aicy_owner_manual_route_waybill_idx ON "
                + OWNER_MANUAL_ROUTE_TABLE + "(binding_source,normalized_waybill)");
        db.execSQL("CREATE TABLE IF NOT EXISTS " + OWNER_MANUAL_RETRY_TABLE + "("
                + "owner_row_id INTEGER PRIMARY KEY NOT NULL,"
                + "normalized_waybill TEXT NOT NULL,binding_source TEXT NOT NULL,"
                + "owner_fingerprint TEXT NOT NULL,"
                + "last_attempt_at INTEGER NOT NULL,"
                + "attempt_token TEXT NOT NULL DEFAULT '',"
                + "active_until INTEGER NOT NULL DEFAULT 0)");
        addColumnIfMissing(db, OWNER_MANUAL_RETRY_TABLE,
                "attempt_token", "TEXT NOT NULL DEFAULT ''");
        addColumnIfMissing(db, OWNER_MANUAL_RETRY_TABLE,
                "active_until", "INTEGER NOT NULL DEFAULT 0");
        db.execSQL("CREATE INDEX IF NOT EXISTS aicy_owner_manual_retry_due_idx ON "
                + OWNER_MANUAL_RETRY_TABLE + "(binding_source,last_attempt_at)");
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
        db.execSQL("CREATE INDEX IF NOT EXISTS aicy_order_projection_display_idx ON "
                + ORDER_PROJECTION_TABLE
                + "(normalized_display_waybill,binding_source)");
        db.execSQL("CREATE TABLE IF NOT EXISTS aicy_unbound_association("
                + "waybill_hash TEXT NOT NULL,binding_source TEXT NOT NULL,"
                + "phone_hash TEXT NOT NULL,"
                + "PRIMARY KEY(waybill_hash,binding_source,phone_hash))");
        createAutomaticOwnershipTables(db);
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

    private static void createAutomaticOwnershipTables(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS " + AUTOMATIC_OWNERSHIP_TABLE + "("
                + "normalized_waybill TEXT PRIMARY KEY NOT NULL,"
                + "owner_provider TEXT NOT NULL DEFAULT '',"
                + "owner_phone TEXT NOT NULL DEFAULT '',"
                + "owner_binding_generation TEXT NOT NULL DEFAULT '',"
                + "owner_row_id INTEGER NOT NULL DEFAULT 0,"
                + "claimed_at INTEGER NOT NULL DEFAULT 0,"
                + "last_observed_at INTEGER NOT NULL DEFAULT 0,"
                + "miss_count INTEGER NOT NULL DEFAULT 0,"
                + "release_reason TEXT NOT NULL DEFAULT '',"
                + "cooldown_until INTEGER NOT NULL DEFAULT 0,"
                + "display_frozen INTEGER NOT NULL DEFAULT 0)");
        addColumnIfMissing(db, AUTOMATIC_OWNERSHIP_TABLE,
                "owner_phone", "TEXT NOT NULL DEFAULT ''");
        addColumnIfMissing(db, AUTOMATIC_OWNERSHIP_TABLE,
                "owner_binding_generation", "TEXT NOT NULL DEFAULT ''");
        db.execSQL("CREATE INDEX IF NOT EXISTS aicy_automatic_ownership_provider_idx ON "
                + AUTOMATIC_OWNERSHIP_TABLE
                + "(owner_provider,owner_binding_generation,owner_row_id)");
        db.execSQL("CREATE TABLE IF NOT EXISTS " + AUTOMATIC_OBSERVATION_TABLE + "("
                + "normalized_waybill TEXT NOT NULL,"
                + "owner_provider TEXT NOT NULL,"
                + "binding_generation TEXT NOT NULL,"
                + "package_owner TEXT NOT NULL,"
                + "binding_source TEXT NOT NULL,"
                + "waybill TEXT NOT NULL,phone TEXT DEFAULT '',"
                + "courier_code TEXT DEFAULT '',company_name TEXT DEFAULT '',"
                + "status_code TEXT DEFAULT '',status_event_time INTEGER NOT NULL DEFAULT 0,"
                + "latest_time TEXT DEFAULT '',latest_detail TEXT DEFAULT '',"
                + "tracks_json TEXT DEFAULT '[]',source_provider TEXT DEFAULT '',"
                + "detail_url TEXT DEFAULT '',route_interface TEXT DEFAULT '',"
                + "route_credential TEXT DEFAULT '',"
                + "carrier_standard_code TEXT DEFAULT '',"
                + "carrier_display_name TEXT DEFAULT '',"
                + "carrier_kuaidi100_code TEXT DEFAULT '',"
                + "carrier_is_built_in INTEGER NOT NULL DEFAULT -1,"
                + "carrier_table_version TEXT DEFAULT '',"
                + "qualified INTEGER NOT NULL DEFAULT 0,"
                + "observed_at INTEGER NOT NULL,"
                + "PRIMARY KEY(normalized_waybill,owner_provider,binding_generation))");
        addColumnIfMissing(db, AUTOMATIC_OBSERVATION_TABLE,
                "binding_generation", "TEXT NOT NULL DEFAULT ''");
        addColumnIfMissing(db, AUTOMATIC_OBSERVATION_TABLE,
                "detail_url", "TEXT DEFAULT ''");
        addColumnIfMissing(db, AUTOMATIC_OBSERVATION_TABLE,
                "route_interface", "TEXT DEFAULT ''");
        addColumnIfMissing(db, AUTOMATIC_OBSERVATION_TABLE,
                "route_credential", "TEXT DEFAULT ''");
        db.execSQL("CREATE INDEX IF NOT EXISTS aicy_automatic_observation_candidate_idx ON "
                + AUTOMATIC_OBSERVATION_TABLE
                + "(normalized_waybill,qualified,observed_at,binding_generation)");
    }

    private static void ensurePhoneBindingGenerations(SQLiteDatabase db) {
        try (Cursor cursor = db.query(
                PHONE_TABLE, new String[]{"_id", "uuid"},
                null, null, null, null, null)) {
            while (cursor.moveToNext()) {
                if (!value(cursor, "uuid").isEmpty()) continue;
                android.content.ContentValues values = new android.content.ContentValues();
                values.put("uuid", UUID.randomUUID().toString());
                db.update(PHONE_TABLE, values, "_id=?",
                        new String[]{Long.toString(cursor.getLong(0))});
            }
        }
    }

    /** Rebuilds the v19 provider-only key so two accounts on one provider stay independent. */
    private static void migrateAutomaticBindingIdentity(SQLiteDatabase db) {
        String legacy = AUTOMATIC_OBSERVATION_TABLE + "_provider_key";
        db.execSQL("DROP TABLE IF EXISTS " + legacy);
        db.execSQL("ALTER TABLE " + AUTOMATIC_OBSERVATION_TABLE
                + " RENAME TO " + legacy);
        createAutomaticOwnershipTables(db);
        try (Cursor cursor = db.query(legacy, null, null, null, null, null, null)) {
            while (cursor.moveToNext()) {
                android.content.ContentValues values = copyRow(cursor);
                String source = value(cursor, "binding_source");
                String phone = value(cursor, "phone");
                String generation = bindingGeneration(db, phone, source);
                if (generation.isEmpty()) generation = legacyGeneration(source, phone);
                values.put("binding_generation", generation);
                db.insertWithOnConflict(AUTOMATIC_OBSERVATION_TABLE, null, values,
                        SQLiteDatabase.CONFLICT_REPLACE);
            }
        }
        db.execSQL("DROP TABLE " + legacy);
        createAutomaticOwnershipTables(db);
    }

    private static android.content.ContentValues copyRow(Cursor cursor) {
        android.content.ContentValues values = new android.content.ContentValues();
        for (String column : cursor.getColumnNames()) {
            int index = cursor.getColumnIndexOrThrow(column);
            if (cursor.isNull(index)) {
                values.putNull(column);
            } else if (cursor.getType(index) == Cursor.FIELD_TYPE_INTEGER) {
                values.put(column, cursor.getLong(index));
            } else if (cursor.getType(index) == Cursor.FIELD_TYPE_FLOAT) {
                values.put(column, cursor.getDouble(index));
            } else if (cursor.getType(index) == Cursor.FIELD_TYPE_BLOB) {
                values.put(column, cursor.getBlob(index));
            } else {
                values.put(column, cursor.getString(index));
            }
        }
        return values;
    }

    private static void hydrateAutomaticOwnerBindingIdentity(SQLiteDatabase db) {
        try (Cursor cursor = db.query(
                AUTOMATIC_OWNERSHIP_TABLE,
                new String[]{"normalized_waybill", "owner_provider", "owner_row_id",
                        "owner_phone", "owner_binding_generation"},
                null, null, null, null, null)) {
            while (cursor.moveToNext()) {
                if (!value(cursor, "owner_binding_generation").isEmpty()) continue;
                String provider = value(cursor, "owner_provider");
                if (provider.isEmpty()) continue;
                String phone = value(cursor, "owner_phone");
                if (phone.isEmpty()) {
                    long rowId = cursor.getLong(cursor.getColumnIndexOrThrow("owner_row_id"));
                    try (Cursor owner = db.query(
                            EXPRESS_TABLE, new String[]{"subPhone"}, "_id=?",
                            new String[]{Long.toString(rowId)}, null, null, null, "1")) {
                        if (owner.moveToFirst()) phone = value(owner, "subPhone");
                    }
                }
                String source = ExpressSourcePolicy.bindingSourceForOwner(provider);
                String generation = bindingGeneration(db, phone, source);
                if (generation.isEmpty()) generation = legacyGeneration(source, phone);
                android.content.ContentValues values = new android.content.ContentValues();
                values.put("owner_phone", phone);
                values.put("owner_binding_generation", generation);
                db.update(AUTOMATIC_OWNERSHIP_TABLE, values,
                        "normalized_waybill=?", new String[]{value(cursor,
                                "normalized_waybill")});
            }
        }
    }

    private static String bindingGeneration(
            SQLiteDatabase db, String phone, String bindingSource) {
        String digits = phoneDigits(phone);
        String only = "";
        int count = 0;
        String suffix = "";
        int suffixCount = 0;
        try (Cursor cursor = db.query(
                PHONE_TABLE, new String[]{"phone", "uuid"},
                "LOWER(sync_status)=?", new String[]{bindingSource.toLowerCase()},
                null, null, null)) {
            while (cursor.moveToNext()) {
                String generation = value(cursor, "uuid");
                if (generation.isEmpty()) continue;
                count++;
                only = generation;
                String boundDigits = phoneDigits(value(cursor, "phone"));
                if (!digits.isEmpty() && digits.equals(boundDigits)) {
                    return generation;
                }
                if (digits.length() >= 4 && boundDigits.endsWith(digits)) {
                    suffix = generation;
                    suffixCount++;
                }
            }
        }
        if (suffixCount == 1) return suffix;
        return digits.isEmpty() && count == 1 ? only : "";
    }

    private static String legacyGeneration(String bindingSource, String phone) {
        return "legacy:" + bindingSource.toLowerCase() + ":"
                + Integer.toHexString(phoneDigits(phone).hashCode());
    }

    private static String phoneDigits(String phone) {
        return phone == null ? "" : phone.replaceAll("\\D", "");
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
        db.execSQL("CREATE INDEX IF NOT EXISTS aicy_order_projection_display_idx ON "
                + ORDER_PROJECTION_TABLE
                + "(normalized_display_waybill,binding_source)");
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

    /** Lets the K100-first SF refresh run immediately after upgrading from the old source order. */
    private static void invalidateLegacyInterface5SfManualState(SQLiteDatabase db) {
        String ownerMatch = "EXISTS (SELECT 1 FROM " + EXPRESS_TABLE + " e"
                + " WHERE e._id=" + OWNER_MANUAL_TIMELINE_TABLE + ".owner_row_id"
                + " AND LOWER(TRIM(CASE WHEN TRIM(COALESCE(e.stateOwner,''))<>''"
                + " THEN e.stateOwner ELSE e.fromCp END))='interface5'"
                + " AND LOWER(TRIM(COALESCE(e.data1,'')))='shunfeng'"
                + " AND LOWER(TRIM(COALESCE(e.data3,'')))<>'manual')";
        db.execSQL("DELETE FROM " + OWNER_MANUAL_TIMELINE_TABLE
                + " WHERE (LOWER(TRIM(COALESCE(provider,'')))='interface5'"
                + " OR (LOWER(TRIM(COALESCE(provider,'')))='kuaidi100'"
                + " AND (UPPER(TRIM(COALESCE(status_code,'')))<>'SIGN'"
                + " OR status_event_time<=0)))"
                + " AND " + ownerMatch);

        String retryOwnerMatch = "EXISTS (SELECT 1 FROM " + EXPRESS_TABLE + " e"
                + " WHERE e._id=" + OWNER_MANUAL_RETRY_TABLE + ".owner_row_id"
                + " AND LOWER(TRIM(CASE WHEN TRIM(COALESCE(e.stateOwner,''))<>''"
                + " THEN e.stateOwner ELSE e.fromCp END))='interface5'"
                + " AND LOWER(TRIM(COALESCE(e.data1,'')))='shunfeng'"
                + " AND LOWER(TRIM(COALESCE(e.data3,'')))<>'manual')";
        db.execSQL("DELETE FROM " + OWNER_MANUAL_RETRY_TABLE
                + " WHERE " + retryOwnerMatch);
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

    /** Freezes the pre-upgrade card before first-qualified arbitration becomes active. */
    private static void migrateAutomaticOwnership(
            SQLiteDatabase db, String activeBindingSource) {
        String effectiveOwner = "UPPER(TRIM(CASE WHEN TRIM(COALESCE(stateOwner,''))<>''"
                + " THEN stateOwner ELSE fromCp END))";
        db.execSQL("DELETE FROM " + EXPRESS_TABLE
                + " WHERE LOWER(TRIM(COALESCE(data1,'')))='jingdong'"
                + " AND " + effectiveOwner + " IN ('INTERFACE1','I1-JD','V1','VIVO')");

        Map<String, LegacyOwnerCandidate> selected = new LinkedHashMap<>();
        try (Cursor cursor = db.query(
                EXPRESS_TABLE,
                null,
                "TRIM(COALESCE(normalizedMailNo,''))<>''"
                        + " AND LOWER(TRIM(COALESCE(data3,'')))<>'manual'",
                null, null, null, "updatedAt ASC, _id ASC")) {
            while (cursor.moveToNext()) {
                String owner = value(cursor, "stateOwner");
                if (owner.isEmpty()) owner = value(cursor, "fromCp");
                String provider = AutomaticOwnershipPolicy.providerForPackageOwner(owner);
                if (provider.isEmpty()) continue;
                String normalizedWaybill = legacyAutomaticIdentity(
                        db, value(cursor, "mailNo"), owner,
                        value(cursor, "normalizedMailNo"));
                if (normalizedWaybill.isEmpty()) continue;
                long observedAt = cursor.getLong(cursor.getColumnIndexOrThrow("updatedAt"));
                if (observedAt <= 0L) {
                    observedAt = cursor.getLong(
                            cursor.getColumnIndexOrThrow("statusEventTime"));
                }
                android.content.ContentValues observation = new android.content.ContentValues();
                observation.put("normalized_waybill", normalizedWaybill);
                observation.put("owner_provider", provider);
                String ownerPhone = value(cursor, "subPhone");
                String ownerBindingSource =
                        ExpressSourcePolicy.bindingSourceForOwner(provider);
                String ownerGeneration = bindingGeneration(
                        db, ownerPhone, ownerBindingSource);
                if (ownerGeneration.isEmpty()) {
                    ownerGeneration = legacyGeneration(ownerBindingSource, ownerPhone);
                }
                observation.put("binding_generation", ownerGeneration);
                observation.put("package_owner", ExpressSourcePolicy.source(owner));
                observation.put("binding_source", ownerBindingSource);
                observation.put("waybill", value(cursor, "mailNo"));
                observation.put("phone", ownerPhone);
                observation.put("courier_code", value(cursor, "cpCode"));
                observation.put("company_name", value(cursor, "cpName"));
                observation.put("status_code", value(cursor, "logsiticsStatus"));
                observation.put("status_event_time", cursor.getLong(
                        cursor.getColumnIndexOrThrow("statusEventTime")));
                observation.put("latest_time", value(cursor, "logisticsGmtModified"));
                observation.put("latest_detail", value(cursor, "lastLogisticDetail"));
                observation.put("tracks_json", value(cursor, "packageDyn"));
                observation.put("source_provider", value(cursor, "data1"));
                observation.put("detail_url", value(cursor, "moreInfoUrl"));
                observation.put("route_interface", value(cursor, "routeInterface"));
                observation.put("route_credential", value(cursor, "routeCredential"));
                observation.put("carrier_standard_code",
                        value(cursor, "carrierStandardCode"));
                observation.put("carrier_display_name",
                        value(cursor, "carrierDisplayName"));
                observation.put("carrier_kuaidi100_code",
                        value(cursor, "carrierKuaidi100Code"));
                observation.put("carrier_is_built_in", cursor.getInt(
                        cursor.getColumnIndexOrThrow("carrierIsBuiltIn")));
                observation.put("carrier_table_version",
                        value(cursor, "carrierTableVersion"));
                boolean hasRawCarrier = !value(cursor, "cpCode").isEmpty()
                        || containsHan(value(cursor, "cpName"));
                observation.put("qualified",
                        hasRawCarrier
                                && !value(cursor, "logsiticsStatus").isEmpty()
                                && !"UNKNOWN".equalsIgnoreCase(
                                value(cursor, "logsiticsStatus")) ? 1 : 0);
                observation.put("observed_at", observedAt);
                db.insertWithOnConflict(AUTOMATIC_OBSERVATION_TABLE, null, observation,
                        SQLiteDatabase.CONFLICT_REPLACE);
                LegacyOwnerCandidate candidate = new LegacyOwnerCandidate(
                        normalizedWaybill, provider, ownerPhone, ownerGeneration,
                        cursor.getLong(cursor.getColumnIndexOrThrow("_id")),
                        cursor.getLong(cursor.getColumnIndexOrThrow("statusEventTime")),
                        cursor.getLong(cursor.getColumnIndexOrThrow("updatedAt")),
                        ExpressSourcePolicy.bindingSourceForOwner(provider)
                                .equals(activeBindingSource));
                LegacyOwnerCandidate current = selected.get(candidate.normalizedWaybill);
                if (current == null || candidate.precedes(current)) {
                    selected.put(candidate.normalizedWaybill, candidate);
                }
            }
        }
        for (LegacyOwnerCandidate candidate : selected.values()) {
            android.content.ContentValues values = new android.content.ContentValues();
            long claimedAt = candidate.updatedAt > 0L
                    ? candidate.updatedAt : candidate.statusEventTime;
            values.put("normalized_waybill", candidate.normalizedWaybill);
            values.put("owner_provider", candidate.provider);
            values.put("owner_phone", candidate.phone);
            values.put("owner_binding_generation", candidate.bindingGeneration);
            values.put("owner_row_id", candidate.rowId);
            values.put("claimed_at", claimedAt);
            values.put("last_observed_at", claimedAt);
            values.put("miss_count", 0);
            values.put("release_reason", "");
            values.put("cooldown_until", 0L);
            values.put("display_frozen", 0);
            db.insertWithOnConflict(AUTOMATIC_OWNERSHIP_TABLE, null, values,
                    SQLiteDatabase.CONFLICT_REPLACE);
        }
    }

    private static String legacyAutomaticIdentity(
            SQLiteDatabase db, String waybill, String owner, String fallback) {
        if (ExpressSourcePolicy.isAccountOrderOwner(owner)) {
            String normalizedSource = ExpressSourcePolicy.normalizeWaybill(waybill);
            try (Cursor cursor = db.query(
                    ORDER_PROJECTION_TABLE, new String[]{"normalized_display_waybill"},
                    "normalized_source_id=? AND LOWER(binding_source)=?",
                    new String[]{normalizedSource,
                            ExpressSourcePolicy.bindingSourceForOwner(owner)},
                    null, null, null, "1")) {
                if (cursor.moveToFirst()) {
                    String projected = value(cursor, "normalized_display_waybill");
                    if (!projected.isEmpty()) return projected;
                }
            }
        }
        String normalized = ExpressSourcePolicy.normalizeWaybill(fallback);
        return normalized.isEmpty()
                ? ExpressSourcePolicy.normalizeWaybill(waybill) : normalized;
    }

    private String activeBindingSource() {
        String selected = context.getSharedPreferences("express_account_source", 0)
                .getString("active_interface", "v6");
        return "v5".equalsIgnoreCase(selected) ? "interface5" : "interface6";
    }

    private static String value(Cursor cursor, String column) {
        int index = cursor.getColumnIndex(column);
        return index < 0 || cursor.isNull(index) ? "" : cursor.getString(index).trim();
    }

    private static boolean containsHan(String value) {
        String clean = value == null ? "" : value.trim();
        for (int index = 0; index < clean.length(); index++) {
            if (Character.UnicodeScript.of(clean.charAt(index))
                    == Character.UnicodeScript.HAN) return true;
        }
        return false;
    }

    private static final class LegacyOwnerCandidate {
        final String normalizedWaybill;
        final String provider;
        final String phone;
        final String bindingGeneration;
        final long rowId;
        final long statusEventTime;
        final long updatedAt;
        final boolean activePartition;

        LegacyOwnerCandidate(
                String normalizedWaybill, String provider, String phone,
                String bindingGeneration, long rowId,
                long statusEventTime, long updatedAt, boolean activePartition) {
            this.normalizedWaybill = normalizedWaybill;
            this.provider = provider;
            this.phone = phone;
            this.bindingGeneration = bindingGeneration;
            this.rowId = rowId;
            this.statusEventTime = statusEventTime;
            this.updatedAt = updatedAt;
            this.activePartition = activePartition;
        }

        boolean precedes(LegacyOwnerCandidate other) {
            if (activePartition != other.activePartition) return activePartition;
            if (statusEventTime != other.statusEventTime) {
                return statusEventTime > other.statusEventTime;
            }
            if (updatedAt != other.updatedAt) return updatedAt > other.updatedAt;
            return rowId > other.rowId;
        }
    }

    private static void dropObsoleteTables(SQLiteDatabase db) {
        db.execSQL("DROP TABLE IF EXISTS aicy_query_history");
        db.execSQL("DROP TABLE IF EXISTS aicy_express_" + "tomb" + "stone");
    }
}
