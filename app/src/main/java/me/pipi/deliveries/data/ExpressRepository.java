package me.pipi.deliveries.data;

import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.CainiaoRoute;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.PendingExpressQuery;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.notification.ExpressNotifications;
import me.pipi.deliveries.widget.ExpressWidgetProvider;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Set;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/** Single persistence and outward-invalidation boundary for all express changes. */
public final class ExpressRepository {
    public static final String ACTION_CHANGED = "me.pipi.deliveries.EXPRESS_DATA_CHANGED";
    public static final String ACTION_SYNC_FINISHED =
            "me.pipi.deliveries.EXPRESS_SYNC_FINISHED";
    private static volatile ExpressRepository instance;

    private final Context context;
    private final ExpressDatabase helper;
    private final Object maintenanceLock = new Object();
    private int changeBatchDepth;
    private boolean invalidationPending;
    private final LinkedHashMap<Long, ExpressItem> notificationPending = new LinkedHashMap<>();
    private static final String MIGRATION_PREFS = "deliveries_repository_migrations";
    private static final String CANONICAL_MIGRATION = "canonical_v2";
    private static final String ICON_MIGRATION = "local_icons_v3";
    private static final String DELETION_MIGRATION = "hashed_deletions_v1";
    private static final String ROUTE_CREDENTIAL_MIGRATION = "route_credentials_v1";
    private static final String LAST_RETENTION_PRUNE = "last_signed_prune_at";
    static final long RETENTION_PRUNE_INTERVAL_MS = 60L * 60L * 1000L;
    static final long PENDING_QUERY_RETRY_INTERVAL_MS = 30L * 60L * 1000L;
    static final long PENDING_QUERY_TTL_MS = 7L * 24L * 60L * 60L * 1000L;
    private static final int PENDING_QUERY_BATCH_SIZE = 20;

    private ExpressRepository(Context context) {
        this.context = context.getApplicationContext();
        helper = new ExpressDatabase(this.context);
    }

    public static ExpressRepository get(Context context) {
        ExpressRepository local = instance;
        if (local == null) {
            synchronized (ExpressRepository.class) {
                local = instance;
                if (local == null) instance = local = new ExpressRepository(context);
            }
        }
        return local;
    }

    /** Coalesces a multi-provider sync into one widget refresh and one app broadcast. */
    public void runInChangeBatch(Runnable operation) {
        synchronized (this) {
            changeBatchDepth++;
        }
        try {
            operation.run();
        } finally {
            finishChangeBatch();
        }
    }

    /** Visible rows projected for one selected account interface. */
    public synchronized List<ExpressItem> listVisible(String bindingSource) {
        return listVisibleInternal(clean(bindingSource).toLowerCase(Locale.ROOT));
    }

    private List<ExpressItem> listVisibleInternal(String bindingSource) {
        LinkedHashMap<String, ExpressItem> canonical = new LinkedHashMap<>();
        try (Cursor cursor = helper.getReadableDatabase().query(
                ExpressDatabase.EXPRESS_TABLE, null,
                "canShow=1 AND isDeleted=0", null, null, null,
                "logisticsGmtModified DESC, _id DESC")) {
            while (cursor.moveToNext()) {
                ExpressItem candidate = read(cursor);
                if (!bindingSource.isEmpty()
                        && !ExpressSourcePolicy.belongsToBindingSource(
                        candidate, bindingSource)) continue;
                String normalized = ExpressSourcePolicy.normalizeWaybill(candidate.waybill);
                String key = normalized.isEmpty()
                        ? "row:" + candidate.rowId : normalized;
                ExpressItem previous = canonical.get(key);
                if (previous == null || winsCanonical(candidate, previous)) {
                    canonical.put(key, candidate);
                }
            }
        }
        ArrayList<ExpressItem> visible = new ArrayList<>(canonical.values());
        long now = System.currentTimeMillis();
        visible.removeIf(item -> ExpressVisibilityPolicy.isExpired(item, now));
        // Match Pipi: status groups first, then newest event/update within the group.
        visible.sort((left, right) -> {
            int status = Integer.compare(
                    visibleStatusRank(left.semantic), visibleStatusRank(right.semantic));
            if (status != 0) return status;
            int event = Long.compare(right.statusEventTime, left.statusEventTime);
            if (event != 0) return event;
            int updated = Long.compare(right.updatedAt, left.updatedAt);
            if (updated != 0) return updated;
            return Long.compare(right.rowId, left.rowId);
        });
        return visible;
    }

    /** Runs one-time data normalization away from activity and widget main threads. */
    public void runPendingMigrations() {
        boolean changed = false;
        synchronized (maintenanceLock) {
            SharedPreferences preferences =
                    context.getSharedPreferences(MIGRATION_PREFS, 0);
            if (!preferences.getBoolean(CANONICAL_MIGRATION, false)) {
                migrateCanonicalRows();
                preferences.edit().putBoolean(CANONICAL_MIGRATION, true).apply();
                changed = true;
            }
            if (!preferences.getBoolean(DELETION_MIGRATION, false)) {
                migrateDeletionRows();
                preferences.edit().putBoolean(DELETION_MIGRATION, true).apply();
                changed = true;
            }
            if (!preferences.getBoolean(ROUTE_CREDENTIAL_MIGRATION, false)) {
                if (migrateRouteCredentials()) {
                    preferences.edit().putBoolean(
                            ROUTE_CREDENTIAL_MIGRATION, true).apply();
                }
                changed = true;
            }
            if (!preferences.getBoolean(ICON_MIGRATION, false)) {
                normalizeLocalIcons();
                changed = true;
            }
        }
        if (changed) emitInvalidation();
    }

    /** Runs the terminal-state retention scan at most once per hour per installation. */
    public void pruneExpiredShipmentsIfDue() {
        long now = System.currentTimeMillis();
        ArrayList<ExpressItem> expired;
        synchronized (maintenanceLock) {
            SharedPreferences preferences = context.getSharedPreferences(MIGRATION_PREFS, 0);
            long previous = preferences.getLong(LAST_RETENTION_PRUNE, 0L);
            if (!isRetentionPruneDue(previous, now)) return;
            preferences.edit().putLong(LAST_RETENTION_PRUNE, now).apply();
            try {
                expired = pruneExpiredShipments(now);
            } catch (RuntimeException | Error failure) {
                preferences.edit().remove(LAST_RETENTION_PRUNE).apply();
                throw failure;
            }
        }
        for (ExpressItem item : expired) ExpressNotifications.cancel(context, item.rowId);
        if (!expired.isEmpty()) emitInvalidation();
    }

    static boolean isRetentionPruneDue(long previous, long now) {
        return previous <= 0L || now < previous
                || now - previous >= RETENTION_PRUNE_INTERVAL_MS;
    }

    /** Permanently removes rows already hidden by the terminal-state retention policy. */
    private ArrayList<ExpressItem> pruneExpiredShipments(long now) {
        LinkedHashMap<String, ExpressItem> candidates = new LinkedHashMap<>();
        // Timeline parsing is deliberately outside the write transaction. saveQuery performs its
        // tombstone check and row creation atomically. Every candidate is re-read below so an
        // update between this scan and the transaction cannot be deleted from a stale snapshot.
        try (Cursor cursor = helper.getReadableDatabase().query(
                ExpressDatabase.EXPRESS_TABLE, null,
                "canShow=1 AND isDeleted=0", null, null, null, null)) {
            while (cursor.moveToNext()) {
                ExpressItem item = read(cursor);
                if (!ExpressVisibilityPolicy.isExpired(item, now)) continue;
                String normalized = ExpressSourcePolicy.normalizeWaybill(item.waybill);
                String key = normalized.isEmpty() ? "row:" + item.rowId : normalized;
                candidates.putIfAbsent(key, item);
            }
        }
        if (candidates.isEmpty()) return new ArrayList<>();
        ArrayList<ExpressItem> expired = new ArrayList<>();
        SQLiteDatabase db = helper.getWritableDatabase();
        db.beginTransaction();
        try {
            for (ExpressItem candidate : candidates.values()) {
                String normalized = ExpressSourcePolicy.normalizeWaybill(candidate.waybill);
                String selection = normalized.isEmpty()
                        ? "_id=? AND canShow=1 AND isDeleted=0"
                        : "normalizedMailNo=? AND canShow=1 AND isDeleted=0";
                String[] selectionArgs = {normalized.isEmpty()
                        ? Long.toString(candidate.rowId) : normalized};
                ArrayList<ExpressItem> group = new ArrayList<>();
                boolean allExpired = true;
                try (Cursor cursor = db.query(
                        ExpressDatabase.EXPRESS_TABLE, null,
                        selection, selectionArgs, null, null, null)) {
                    while (cursor.moveToNext()) {
                        ExpressItem current = read(cursor);
                        group.add(current);
                        if (!ExpressVisibilityPolicy.isExpired(current, now)) {
                            allExpired = false;
                        }
                    }
                }
                if (allExpired && !group.isEmpty()) expired.addAll(group);
            }
            expireShipments(db, expired);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        return expired;
    }

    public synchronized ExpressItem find(long rowId) {
        try (Cursor cursor = helper.getReadableDatabase().query(
                ExpressDatabase.EXPRESS_TABLE, null, "_id=?",
                new String[]{Long.toString(rowId)}, null, null, null, "1")) {
            return cursor.moveToFirst() ? read(cursor) : null;
        }
    }

    /** Finds a canonical row only inside the selected account-source partition. */
    public synchronized ExpressItem findByWaybill(String waybill, String bindingSource) {
        String normalized = ExpressSourcePolicy.normalizeWaybill(waybill);
        if (normalized.isEmpty()) return null;
        String selectedSource = clean(bindingSource).toLowerCase(Locale.ROOT);
        try (Cursor cursor = helper.getReadableDatabase().query(
                ExpressDatabase.EXPRESS_TABLE, null,
                "(normalizedMailNo=? OR mailNo=?) AND isDeleted=0 AND canShow=1",
                new String[]{normalized, clean(waybill)},
                null, null, "_id ASC")) {
            ExpressItem best = null;
            while (cursor.moveToNext()) {
                ExpressItem candidate = read(cursor);
                if (!selectedSource.isEmpty()
                        && !ExpressSourcePolicy.belongsToBindingSource(
                        candidate, selectedSource)) continue;
                if (best == null || winsCanonical(candidate, best)) best = candidate;
            }
            return best;
        }
    }

    public synchronized boolean isTombstoned(String waybill) {
        String normalized = ExpressSourcePolicy.normalizeWaybill(waybill);
        return !normalized.isEmpty()
                && hasDeletionTombstone(helper.getReadableDatabase(), normalized);
    }

    /** Keeps an unbound account association scoped to its source until that phone is rebound. */
    public synchronized boolean hasUnboundPhoneAssociation(
            String waybill, String bindingSource) {
        String normalized = ExpressSourcePolicy.normalizeWaybill(waybill);
        if (normalized.isEmpty()) return false;
        return hasUnboundPhoneAssociation(
                helper.getReadableDatabase(), normalized, bindingSource);
    }

    public static boolean shouldSuppressAutomaticImport(
            boolean hasUnboundAssociation, String matchedBoundPhone) {
        return hasUnboundAssociation && clean(matchedBoundPhone).isEmpty();
    }

    /** Reuses an existing source-scoped association before account sync considers a fallback. */
    public synchronized String associatedPhone(String waybill, String bindingSource) {
        String normalized = ExpressSourcePolicy.normalizeWaybill(waybill);
        if (normalized.isEmpty()) return "";
        String selectedSource = clean(bindingSource).toLowerCase(Locale.ROOT);
        try (Cursor cursor = helper.getReadableDatabase().query(
                ExpressDatabase.EXPRESS_TABLE,
                new String[]{"subPhone", "fromCp", "stateOwner"},
                "normalizedMailNo=? OR mailNo=?",
                new String[]{normalized, clean(waybill)}, null, null,
                "isDeleted ASC, updatedAt DESC, _id DESC")) {
            while (cursor.moveToNext()) {
                String owner = clean(cursor.getString(2));
                if (owner.isEmpty()) owner = clean(cursor.getString(1));
                if (!selectedSource.isEmpty()
                        && !ExpressSourcePolicy.belongsToBindingSource(
                        owner, selectedSource)) continue;
                return clean(cursor.getString(0));
            }
        }
        return "";
    }

    /** K100 sidecar; kept separate so provider timelines are never mixed. */
    public synchronized ExpressQueryResult kuaidi100Timeline(String waybill) {
        return timeline(ExpressDatabase.KUAIDI100_TIMELINE_TABLE, waybill, "kuaidi100");
    }

    /** v4 public sidecar; one complete provider timeline is retained independently. */
    public synchronized ExpressQueryResult v4Timeline(String waybill) {
        return timeline(ExpressDatabase.V4_TIMELINE_TABLE, waybill, "v4");
    }

    /** Matches Pipi: use the complete v4 timeline when usable, otherwise K100. */
    public synchronized ExpressQueryResult preferredLocalTimeline(String waybill) {
        return preferredLocalTimeline(v4Timeline(waybill), kuaidi100Timeline(waybill));
    }

    static ExpressQueryResult preferredLocalTimeline(
            ExpressQueryResult publicTimeline, ExpressQueryResult kuaidi100Timeline) {
        return Kuaidi100TimelinePolicy.hasRealTracking(publicTimeline)
                ? publicTimeline : kuaidi100Timeline;
    }

    /** Each account interface keeps a complete, independent timeline for the same waybill. */
    public synchronized ExpressQueryResult accountTimeline(
            String waybill, String bindingSource) {
        String source = "interface5".equalsIgnoreCase(clean(bindingSource))
                ? "interface5" : "interface6";
        String table = "interface5".equals(source)
                ? ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE
                : ExpressDatabase.ACCOUNT_V6_TIMELINE_TABLE;
        return timeline(table, waybill, source);
    }

    public synchronized boolean hasAccountTimeline(String waybill, String bindingSource) {
        return Kuaidi100TimelinePolicy.hasRealTracking(
                accountTimeline(waybill, bindingSource));
    }

    private ExpressQueryResult timeline(String table, String waybill, String provider) {
        String normalized = ExpressSourcePolicy.normalizeWaybill(waybill);
        if (normalized.isEmpty()) return null;
        try (Cursor cursor = helper.getReadableDatabase().query(
                table, null,
                "normalized_waybill=?", new String[]{normalized},
                null, null, null, "1")) {
            if (!cursor.moveToFirst()) return null;
            StatusSemantic semantic = StatusSemantic.fromStored(
                    text(cursor, "status_code"), "");
            return new ExpressQueryResult(
                    text(cursor, "waybill"),
                    text(cursor, "courier_code"),
                    text(cursor, "company_name"),
                    semantic,
                    text(cursor, "latest_time"),
                    text(cursor, "latest_detail"),
                    text(cursor, "tracks_json"), "", "", provider);
        }
    }

    public synchronized ExpressQueryResult saveKuaidi100Timeline(ExpressQueryResult result) {
        return saveTimeline(ExpressDatabase.KUAIDI100_TIMELINE_TABLE, result);
    }

    public synchronized ExpressQueryResult saveV4Timeline(ExpressQueryResult result) {
        return saveTimeline(ExpressDatabase.V4_TIMELINE_TABLE, result);
    }

    /** Saves into the result's own sidecar, then returns the currently preferred whole source. */
    public synchronized ExpressQueryResult savePreferredTimeline(ExpressQueryResult result) {
        if (result == null) return null;
        if ("v4".equalsIgnoreCase(result.timelineProvider)) saveV4Timeline(result);
        else saveKuaidi100Timeline(result);
        return preferredLocalTimeline(result.waybill);
    }

    /** Whether K100 currently owns, or still needs to fill, only the list's second line. */
    public synchronized boolean needsKuaidi100Headline(ExpressItem item) {
        if (item == null) return false;
        ExpressQueryResult cached = timeline(
                ExpressDatabase.KUAIDI100_TIMELINE_TABLE, item.waybill, "kuaidi100");
        if (!Kuaidi100TimelinePolicy.shouldRefresh(
                item, cached, System.currentTimeMillis())) return false;
        if (ExpressStatusNormalizer.isHeadlinePlaceholder(
                item.latestDetail, item.semantic)) return true;
        return cached != null && !cached.latestDetail.isEmpty()
                && item.latestDetail.equals(cached.latestDetail);
    }

    /** Fills only the missing/latest-dynamic line; provider state and detail routing stay intact. */
    public void saveKuaidi100HeadlineFallback(
            ExpressQueryResult result, String bindingSource) {
        if (result == null) return;
        ExpressItem previous = findByWaybill(result.waybill, bindingSource);
        if (previous == null) return;
        ExpressQueryResult cachedBefore = kuaidi100Timeline(result.waybill);
        ExpressQueryResult merged = saveKuaidi100Timeline(result);
        if (merged == null || ExpressStatusNormalizer.isHeadlinePlaceholder(
                merged.latestDetail, merged.semantic)) return;
        ExpressItem current;
        synchronized (this) {
            ExpressItem latest = findByWaybill(result.waybill, bindingSource);
            if (latest == null) return;
            boolean empty = ExpressStatusNormalizer.isHeadlinePlaceholder(
                    latest.latestDetail, latest.semantic);
            boolean alreadyOwned = cachedBefore != null
                    && latest.latestDetail.equals(cachedBefore.latestDetail);
            if (!empty && !alreadyOwned) return;
            ContentValues values = new ContentValues();
            values.put("lastLogisticDetail", merged.latestDetail);
            values.put("logisticsGmtModified", merged.latestTime);
            values.put("updatedAt", System.currentTimeMillis());
            helper.getWritableDatabase().update(
                    ExpressDatabase.EXPRESS_TABLE, values, "_id=?",
                    new String[]{Long.toString(latest.rowId)});
            previous = latest;
            current = findByWaybill(result.waybill, bindingSource);
        }
        publishChange(previous, current);
    }

    public synchronized ExpressQueryResult saveAccountTimeline(
            ExpressQueryResult result, String bindingSource) {
        String table = "interface5".equalsIgnoreCase(clean(bindingSource))
                ? ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE
                : ExpressDatabase.ACCOUNT_V6_TIMELINE_TABLE;
        return saveTimeline(table, result);
    }

    private ExpressQueryResult saveTimeline(String table, ExpressQueryResult result) {
        if (result == null) return null;
        String normalized = ExpressSourcePolicy.normalizeWaybill(result.waybill);
        if (normalized.isEmpty()) return result;
        SQLiteDatabase db = helper.getWritableDatabase();
        db.beginTransaction();
        try {
            // A retention or manual-delete tombstone also permanently rejects late cache writes.
            if (hasDeletionTombstone(db, normalized)) return null;
            ExpressQueryResult merged = Kuaidi100TimelinePolicy.merge(
                    timeline(table, result.waybill,
                            ExpressDatabase.V4_TIMELINE_TABLE.equals(table) ? "v4"
                                    : ExpressDatabase.KUAIDI100_TIMELINE_TABLE.equals(table)
                            ? "kuaidi100"
                            : ExpressDatabase.ACCOUNT_V6_TIMELINE_TABLE.equals(table)
                            ? "interface6" : "interface5"), result);
            ContentValues values = new ContentValues();
            values.put("normalized_waybill", normalized);
            values.put("waybill", merged.waybill);
            values.put("courier_code", merged.courierCode);
            values.put("company_name", merged.companyName);
            values.put("status_code", merged.semantic.storageCode);
            values.put("latest_time", merged.latestTime);
            values.put("latest_detail", merged.latestDetail);
            values.put("tracks_json", merged.tracksJson);
            values.put("updated_at", System.currentTimeMillis());
            long inserted = db.insertWithOnConflict(
                    table, null, values, SQLiteDatabase.CONFLICT_REPLACE);
            if (inserted < 0L) {
                throw new IllegalStateException("Timeline persistence failed");
            }
            db.setTransactionSuccessful();
            return merged;
        } finally {
            db.endTransaction();
        }
    }

    public void saveQuery(ExpressQueryResult result, String phone, String source) {
        saveQuery(result, phone, source, false);
    }

    /** Keeps a K100 manual fallback under the interface that initiated the lookup. */
    public void saveManualKuaidi100(
            ExpressQueryResult result, String phone, String bindingSource) {
        saveQuery(result, phone,
                ExpressSourcePolicy.kuaidi100FallbackSource(bindingSource), false);
        if (Kuaidi100TimelinePolicy.hasRealTracking(result)
                && findByWaybill(result.waybill, bindingSource) != null) {
            saveKuaidi100Timeline(result);
        }
    }

    /** Interface 5 owns automatic account state, routing and its same-source timeline. */
    public void saveInterface5(ExpressQueryResult result, String phone) {
        saveQuery(result, phone, ExpressSourcePolicy.SOURCE_INTERFACE5, false);
        if (Kuaidi100TimelinePolicy.hasRealTracking(result)
                && findByWaybill(result.waybill, "interface5") != null) {
            saveAccountTimeline(result, "interface5");
        }
    }

    /** Interface 6 owns automatic account state and its direct detail route when selected. */
    public void saveInterface6(ExpressQueryResult result, String phone) {
        saveQuery(result, phone, ExpressSourcePolicy.SOURCE_INTERFACE6, false);
        if (Kuaidi100TimelinePolicy.hasRealTracking(result)
                && findByWaybill(result.waybill, "interface6") != null) {
            saveAccountTimeline(result, "interface6");
        }
    }

    /** Persists discovery state immediately without pretending a placeholder is a full timeline. */
    public void saveInterface5OrderSummary(ExpressQueryResult result, String phone) {
        saveQuery(result, phone, ExpressSourcePolicy.SOURCE_INTERFACE5_JD, true);
    }

    /** An account-only order id keeps its state and local timeline under the same owner. */
    public void saveInterface5Order(ExpressQueryResult result, String phone) {
        saveInterface5OrderSummary(result, phone);
        if (Kuaidi100TimelinePolicy.hasRealTracking(result)
                && findByWaybill(result.waybill, "interface5") != null) {
            saveAccountTimeline(result, "interface5");
            synchronized (this) {
                // Old builds may have queried the order id as if it were a K100 waybill.
                helper.getWritableDatabase().delete(
                        ExpressDatabase.KUAIDI100_TIMELINE_TABLE,
                        "normalized_waybill=?",
                        new String[]{ExpressSourcePolicy.normalizeWaybill(result.waybill)});
            }
        }
    }

    private void saveQuery(
            ExpressQueryResult result, String phone, String source, boolean forceFallback) {
        if (result == null) return;
        if (ExpressStatusNormalizer.isProviderErrorDetail(result.latestDetail)) return;
        String normalized = ExpressSourcePolicy.normalizeWaybill(result.waybill);
        if (normalized.isEmpty()) return;
        String incomingRouteCredential = preferNonEmpty(
                result.routeCredential,
                CainiaoRoute.isLegacyCredentialedUrl(result.detailUrl)
                        ? result.detailUrl : "");
        EncryptedExpressFields.Result encryptedIncomingRoute =
                EncryptedExpressFields.tryEncode(incomingRouteCredential);
        String incomingOwner = ExpressSourcePolicy.source(source);
        String incomingBindingSource = ExpressSourcePolicy.bindingSourceForOwner(incomingOwner);
        StatusSemantic incomingSemantic = ExpressStatusNormalizer.normalize(
                incomingOwner, result.semantic.storageCode,
                result.semantic.label, result.latestDetail);
        boolean hasIncomingHeadline = !ExpressStatusNormalizer.isHeadlinePlaceholder(
                result.latestDetail, incomingSemantic);
        long incomingEventTime = ExpressSourcePolicy.parseEventTime(result.latestTime);
        ExpressItem previous;
        ExpressItem saved;
        synchronized (this) {
            SQLiteDatabase db = helper.getWritableDatabase();
            // Keep the tombstone check and any row creation in one SQLite transaction. The
            // retention transaction can therefore run before or after this block, never inside it.
            db.beginTransaction();
            try {
                // User-deleted and retention-expired waybills are tombstoned. Account-wide
                // source responses may still contain them, but must never recreate their rows.
                if (hasDeletionTombstone(db, normalized)) return;
                // Association matching happens before this transaction. Recheck the binding here
                // so an unbind that won that race cannot be followed by a late account write.
                if (isAutomaticAccountOwner(incomingOwner)
                        && rejectsUnboundAutomaticWrite(
                                db, normalized, incomingBindingSource, phone)) return;
                previous = findByWaybill(result.waybill, incomingBindingSource);
                ContentValues values = new ContentValues();
                String currentOwner = previous == null ? ""
                        : previous.stateOwner.isEmpty() ? previous.source : previous.stateOwner;
                long currentEventTime = previous == null ? 0L : previous.statusEventTime;
                boolean protectsTerminal = previous != null && previous.semantic.terminal()
                        && previous.semantic != incomingSemantic;
                boolean fallbackFillsUnknown = forceFallback && previous != null
                        && previous.semantic == StatusSemantic.UNKNOWN
                        && incomingSemantic != StatusSemantic.UNKNOWN;
                boolean applyState = previous == null
                        || (fallbackFillsUnknown && !protectsTerminal)
                        || ExpressSourcePolicy.shouldApplyState(
                                currentOwner, previous.semantic, currentEventTime,
                                incomingOwner, incomingSemantic, incomingEventTime);
                boolean fallbackFillsHeadline = forceFallback && previous != null
                        && ExpressStatusNormalizer.isHeadlinePlaceholder(
                                previous.latestDetail, previous.semantic)
                        && (incomingEventTime <= 0L || currentEventTime <= 0L
                                || incomingEventTime >= currentEventTime);
                boolean applyHeadline = hasIncomingHeadline && (previous == null
                        || (fallbackFillsHeadline && !protectsTerminal)
                        || ExpressSourcePolicy.shouldApplyHeadline(
                                currentOwner, currentEventTime,
                                incomingOwner, incomingEventTime));

                values.put("subPhone", clean(phone).isEmpty() && previous != null
                        ? previous.phone : clean(phone));
                values.put("mailNo", clean(result.waybill));
                values.put("normalizedMailNo", normalized);
                if (previous == null || ExpressSourcePolicy.SOURCE_INTERFACE5.equals(incomingOwner)
                        || ExpressSourcePolicy.SOURCE_INTERFACE6.equals(incomingOwner)
                        || ExpressSourcePolicy.SOURCE_INTERFACE5_JD.equals(incomingOwner)) {
                    values.put("cpCode", clean(result.courierCode));
                    values.put("cpName", CarrierRegistry.companyName(
                            result.courierCode, result.companyName));
                    values.put("data2", CarrierRegistry.localIconUri(
                            context, result.courierCode, result.companyName));
                }
                if (applyState) {
                    values.put("logsiticsStatus", incomingSemantic.storageCode);
                    values.put("logisticsStatusDesc", incomingSemantic.label);
                    values.put("statusEventTime", incomingEventTime);
                    values.put("stateOwner", incomingOwner);
                    values.put("fromCp", incomingOwner);
                }
                if (applyHeadline) {
                    values.put("lastLogisticDetail", clean(result.latestDetail));
                    values.put("logisticsGmtModified", clean(result.latestTime));
                    values.put("packageDyn", clean(result.tracksJson));
                }
                String selectedRoute = ExpressSourcePolicy.selectDetailUrl(
                        previous == null ? "" : previous.detailUrl, result.detailUrl);
                boolean incomingRouteSelected = selectedRoute.equals(result.detailUrl)
                        && !selectedRoute.isEmpty();
                boolean useIncomingRouteFields = incomingRouteSelected
                        && (previous == null
                        || !clean(result.routeInterface).isEmpty()
                        || !incomingRouteCredential.isEmpty());
                if (useIncomingRouteFields && !encryptedIncomingRoute.available
                        && previous != null) {
                    // Keep the existing route and ciphertext paired if encryption is temporarily
                    // unavailable. A later discovery response can safely retry the enrichment.
                    selectedRoute = previous.detailUrl;
                    useIncomingRouteFields = false;
                }
                String routeInterface = useIncomingRouteFields
                        ? clean(result.routeInterface)
                        : previous == null ? "" : previous.routeInterface;
                if (routeInterface.isEmpty()) {
                    routeInterface = CainiaoRoute.interfaceFromToken(selectedRoute);
                }
                if (routeInterface.isEmpty()) {
                    routeInterface = CainiaoRoute.interfaceFromLegacyUrl(selectedRoute);
                }
                values.put("moreInfoUrl", selectedRoute);
                values.put("routeOwner", selectedRoute.isEmpty()
                        ? "" : previous != null && selectedRoute.equals(previous.detailUrl)
                        ? previous.routeOwner : incomingOwner);
                values.put("routeInterface", routeInterface);
                if (useIncomingRouteFields && encryptedIncomingRoute.available) {
                    values.put("routeCredential", encryptedIncomingRoute.value);
                }
                values.put("canShow", 1);
                values.put("isDeleted", 0);
                values.put("updatedAt", System.currentTimeMillis());
                int changed = previous == null ? 0 : db.update(
                        ExpressDatabase.EXPRESS_TABLE, values, "_id=?",
                        new String[]{Long.toString(previous.rowId)});
                if (changed == 0) {
                    if (!applyState) {
                        values.put("logsiticsStatus", StatusSemantic.UNKNOWN.storageCode);
                        values.put("logisticsStatusDesc", StatusSemantic.UNKNOWN.label);
                        values.put("stateOwner", incomingOwner);
                        values.put("fromCp", incomingOwner);
                    }
                    db.insertOrThrow(ExpressDatabase.EXPRESS_TABLE, null, values);
                }
                if (Kuaidi100TimelinePolicy.hasRealTracking(result)) {
                    db.delete(ExpressDatabase.KUAIDI100_PENDING_TABLE,
                            "normalized_waybill=? AND LOWER(binding_source)=?",
                            new String[]{normalized, incomingBindingSource});
                }
                saved = findByWaybill(result.waybill, incomingBindingSource);
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
        publishChange(previous, saved);
    }

    public void updateRemark(long rowId, String remark) {
        synchronized (this) {
            ContentValues values = new ContentValues();
            values.put("remark", clean(remark));
            helper.getWritableDatabase().update(
                    ExpressDatabase.EXPRESS_TABLE, values, "_id=?",
                    new String[]{Long.toString(rowId)});
        }
        publishChange(null, null);
    }

    public void delete(long rowId) {
        ArrayList<Long> removedRows = new ArrayList<>();
        synchronized (this) {
            SQLiteDatabase db = helper.getWritableDatabase();
            db.beginTransaction();
            try {
                ExpressItem target = find(rowId);
                if (target != null) {
                    String normalized = ExpressSourcePolicy.normalizeWaybill(target.waybill);
                    insertTombstone(db, normalized, "manual_delete");
                    collectRowIds(db, normalized, removedRows);
                    deleteWaybillRows(db, normalized, rowId);
                }
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
        if (removedRows.isEmpty()) removedRows.add(rowId);
        for (long removedRow : removedRows) ExpressNotifications.cancel(context, removedRow);
        publishChange(null, null);
    }

    public synchronized List<String> phones() {
        return phones("");
    }

    /** Returns only bindings owned by one account source; blank retains the global tail pool. */
    public synchronized List<String> phones(String syncSource) {
        ArrayList<String> values = new ArrayList<>();
        String source = clean(syncSource).toLowerCase(Locale.ROOT);
        String selection = source.isEmpty() ? null : "LOWER(sync_status)=?";
        String[] selectionArgs = source.isEmpty() ? null : new String[]{source};
        try (Cursor cursor = helper.getReadableDatabase().query(
                ExpressDatabase.PHONE_TABLE, new String[]{"phone"},
                selection, selectionArgs, null, null, "bind_time DESC")) {
            while (cursor.moveToNext()) {
                String value = clean(cursor.getString(0));
                if (!value.isEmpty() && !values.contains(value)) values.add(value);
            }
        }
        return values;
    }

    /** Preferred shipment phone first, then every bound phone, de-duplicated by last four digits. */
    public synchronized List<String> phoneCandidates(String preferred) {
        return phoneCandidates(preferred, "");
    }

    /** Limits K100 tail candidates to the interface that initiated the lookup. */
    public synchronized List<String> phoneCandidates(String preferred, String bindingSource) {
        ArrayList<String> candidates = new ArrayList<>();
        Set<String> tails = new HashSet<>();
        addPhoneCandidate(candidates, tails, preferred);
        for (String phone : phones(bindingSource)) addPhoneCandidate(candidates, tails, phone);
        return candidates;
    }

    /** Stores an untracked manual query outside the visible shipment table. */
    public boolean enqueuePendingManual(ExpressQueryResult result, String phone) {
        return enqueuePendingManual(result, phone, "interface6");
    }

    /** Stores the selected interface with a hidden query so later promotion cannot switch lists. */
    public boolean enqueuePendingManual(
            ExpressQueryResult result, String phone, String bindingSource) {
        if (result == null || Kuaidi100TimelinePolicy.hasRealTracking(result)) return false;
        String normalized = ExpressSourcePolicy.normalizeWaybill(result.waybill);
        if (normalized.isEmpty()) return false;
        String selectedBindingSource = normalizeBindingSource(bindingSource);
        String incomingRouteCredential = clean(result.routeCredential);
        EncryptedExpressFields.Result encryptedIncomingRoute =
                EncryptedExpressFields.tryEncode(incomingRouteCredential);
        long now = System.currentTimeMillis();
        synchronized (this) {
            SQLiteDatabase db = helper.getWritableDatabase();
            db.beginTransaction();
            try {
                if (hasDeletionTombstone(db, normalized)
                        || findByWaybill(result.waybill, selectedBindingSource) != null) {
                    return false;
                }
                long createdAt = now;
                String queuedCourier = "";
                String queuedCompany = "";
                String queuedPhone = "";
                String queuedDetailUrl = "";
                String queuedRouteInterface = "";
                String queuedStoredRouteCredential = "";
                try (Cursor cursor = db.query(
                        ExpressDatabase.KUAIDI100_PENDING_TABLE,
                        new String[]{"created_at", "courier_code", "company_name",
                                "phone", "detail_url", "route_interface", "route_credential"},
                        "normalized_waybill=? AND LOWER(binding_source)=?",
                        new String[]{normalized, selectedBindingSource},
                        null, null, null, "1")) {
                    if (cursor.moveToFirst()) {
                        long storedCreatedAt = cursor.getLong(0);
                        if (!isPendingQueryExpired(storedCreatedAt, now)) {
                            createdAt = storedCreatedAt;
                            queuedCourier = clean(cursor.getString(1));
                            queuedCompany = clean(cursor.getString(2));
                            queuedPhone = clean(cursor.getString(3));
                            queuedDetailUrl = clean(cursor.getString(4));
                            queuedRouteInterface = clean(cursor.getString(5));
                            queuedStoredRouteCredential = clean(cursor.getString(6));
                        }
                    }
                }
                ContentValues values = new ContentValues();
                values.put("normalized_waybill", normalized);
                values.put("waybill", clean(result.waybill));
                values.put("courier_code", preferNonEmpty(
                        result.courierCode, queuedCourier));
                values.put("company_name", CarrierRegistry.companyName(
                        preferNonEmpty(result.courierCode, queuedCourier),
                        preferNonEmpty(result.companyName, queuedCompany)));
                values.put("phone", preferNonEmpty(
                        preferNonEmpty(result.phone, phone), queuedPhone));
                values.put("binding_source", selectedBindingSource);
                values.put("detail_url", preferNonEmpty(
                        result.detailUrl, queuedDetailUrl));
                values.put("route_interface", preferNonEmpty(
                        result.routeInterface, queuedRouteInterface));
                if (!incomingRouteCredential.isEmpty() && encryptedIncomingRoute.available) {
                    values.put("route_credential", encryptedIncomingRoute.value);
                } else {
                    // REPLACE deletes the old row first, so explicitly carry its exact envelope
                    // forward whenever no safely encrypted replacement is available.
                    values.put("route_credential", queuedStoredRouteCredential);
                }
                values.put("created_at", createdAt);
                values.put("updated_at", now);
                // The foreground lookup just consumed one request. Wait before polling again.
                values.put("last_attempt_at", now);
                long inserted = db.insertWithOnConflict(
                        ExpressDatabase.KUAIDI100_PENDING_TABLE, null, values,
                        SQLiteDatabase.CONFLICT_REPLACE);
                if (inserted < 0L) {
                    throw new IllegalStateException("Pending query persistence failed");
                }
                db.setTransactionSuccessful();
                return true;
            } finally {
                db.endTransaction();
            }
        }
    }

    /** Claims due hidden manual items so simultaneous workers cannot query one item twice. */
    public synchronized List<PendingExpressQuery> claimPendingManualQueries(long now) {
        return claimPendingManualQueries(now, "interface6");
    }

    /** Claims only the hidden manual items owned by the currently selected interface. */
    public synchronized List<PendingExpressQuery> claimPendingManualQueries(
            long now, String bindingSource) {
        ArrayList<PendingExpressQuery> due = new ArrayList<>();
        String selectedBindingSource = normalizeBindingSource(bindingSource);
        SQLiteDatabase db = helper.getWritableDatabase();
        db.beginTransaction();
        try {
            maintainPendingQueryClocks(db, now);
            try (Cursor cursor = db.query(
                ExpressDatabase.KUAIDI100_PENDING_TABLE, null,
                "LOWER(binding_source)=?", new String[]{selectedBindingSource},
                null, null, "created_at ASC")) {
                while (cursor.moveToNext() && due.size() < PENDING_QUERY_BATCH_SIZE) {
                    long lastAttempt = number(cursor, "last_attempt_at");
                    if (!isPendingQueryDue(lastAttempt, now)) continue;
                    String normalized = text(cursor, "normalized_waybill");
                    EncryptedExpressFields.Result routeCredential =
                            EncryptedExpressFields.tryDecode(text(cursor, "route_credential"));
                    if (!routeCredential.available) continue;
                    PendingExpressQuery query = new PendingExpressQuery(
                            text(cursor, "waybill"), text(cursor, "courier_code"),
                            text(cursor, "company_name"), text(cursor, "phone"),
                            text(cursor, "binding_source"),
                            text(cursor, "detail_url"), text(cursor, "route_interface"),
                            routeCredential.value,
                            number(cursor, "created_at"), lastAttempt);
                    ContentValues values = new ContentValues();
                    values.put("last_attempt_at", now);
                    values.put("updated_at", now);
                    if (db.update(ExpressDatabase.KUAIDI100_PENDING_TABLE, values,
                            "normalized_waybill=? AND LOWER(binding_source)=?",
                            new String[]{normalized, selectedBindingSource}) > 0) {
                        due.add(query);
                    }
                }
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        return due;
    }

    public synchronized void removePendingManual(String waybill, String bindingSource) {
        String normalized = ExpressSourcePolicy.normalizeWaybill(waybill);
        if (normalized.isEmpty()) return;
        helper.getWritableDatabase().delete(
                ExpressDatabase.KUAIDI100_PENDING_TABLE,
                "normalized_waybill=? AND LOWER(binding_source)=?",
                new String[]{normalized, normalizeBindingSource(bindingSource)});
    }

    static boolean isPendingQueryDue(long lastAttempt, long now) {
        return lastAttempt <= 0L || now < lastAttempt
                || now - lastAttempt >= PENDING_QUERY_RETRY_INTERVAL_MS;
    }

    static boolean isPendingQueryExpired(long createdAt, long now) {
        return createdAt <= 0L || now >= createdAt
                && now - createdAt >= PENDING_QUERY_TTL_MS;
    }

    /** A wall-clock rollback restarts retention instead of pinning or deleting the query. */
    static long pendingCreatedAtAfterClockRollback(long createdAt, long now) {
        return createdAt > now ? now : createdAt;
    }

    private static void maintainPendingQueryClocks(SQLiteDatabase db, long now) {
        ArrayList<String[]> expired = new ArrayList<>();
        ArrayList<String[]> reset = new ArrayList<>();
        try (Cursor cursor = db.query(
                ExpressDatabase.KUAIDI100_PENDING_TABLE,
                new String[]{"normalized_waybill", "binding_source", "created_at"},
                null, null,
                null, null, null)) {
            while (cursor.moveToNext()) {
                long createdAt = cursor.getLong(2);
                if (isPendingQueryExpired(createdAt, now)) {
                    expired.add(new String[]{clean(cursor.getString(0)),
                            normalizeBindingSource(cursor.getString(1))});
                } else if (pendingCreatedAtAfterClockRollback(createdAt, now) != createdAt) {
                    reset.add(new String[]{clean(cursor.getString(0)),
                            normalizeBindingSource(cursor.getString(1))});
                }
            }
        }
        for (String[] key : expired) {
            db.delete(ExpressDatabase.KUAIDI100_PENDING_TABLE,
                    "normalized_waybill=? AND LOWER(binding_source)=?",
                    key);
        }
        ContentValues resetValues = new ContentValues();
        resetValues.put("created_at", now);
        resetValues.put("updated_at", now);
        resetValues.put("last_attempt_at", 0L);
        for (String[] key : reset) {
            db.update(ExpressDatabase.KUAIDI100_PENDING_TABLE, resetValues,
                    "normalized_waybill=? AND LOWER(binding_source)=?", key);
        }
    }

    public void bindPhoneLocally(String phone, String syncSource) {
        String value = clean(phone);
        if (value.isEmpty()) return;
        String source = clean(syncSource).toLowerCase(Locale.ROOT);
        if (source.isEmpty()) source = "native";
        synchronized (this) {
            SQLiteDatabase db = helper.getWritableDatabase();
            db.beginTransaction();
            try {
                int existing;
                try (Cursor cursor = db.rawQuery(
                        "SELECT COUNT(*) FROM express_phone"
                                + " WHERE phone=? AND LOWER(sync_status)=?",
                        new String[]{value, source})) {
                    existing = cursor.moveToFirst() ? cursor.getInt(0) : 0;
                }
                ContentValues values = new ContentValues();
                values.put("bind_time", System.currentTimeMillis());
                if (existing == 0) {
                    values.put("phone", value);
                    values.put("sync_status", source);
                    db.insertOrThrow(ExpressDatabase.PHONE_TABLE, null, values);
                } else {
                    if (db.update(ExpressDatabase.PHONE_TABLE, values,
                            "phone=? AND LOWER(sync_status)=?",
                            new String[]{value, source}) == 0) {
                        throw new IllegalStateException("Phone binding disappeared");
                    }
                }
                clearUnboundPhoneAssociations(
                        db, normalizeBindingSource(source), value);
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
        publishChange(null, null);
    }

    public void unbindPhone(String phone) {
        unbindPhone(phone, "");
    }

    /** Removes one source's binding without touching the same phone bound to another source. */
    public void unbindPhone(String phone, String syncSource) {
        String target = clean(phone);
        String targetDigits = normalizePhoneDigits(target);
        if (targetDigits.isEmpty()) return;
        String bindingSource = clean(syncSource).toLowerCase(Locale.ROOT);
        ArrayList<Long> removedRows = new ArrayList<>();
        ArrayList<String[]> suppressedAssociations = new ArrayList<>();
        ArrayList<String[]> removedPending = new ArrayList<>();
        synchronized (this) {
            SQLiteDatabase db = helper.getWritableDatabase();
            db.beginTransaction();
            try {
                String targetTail = targetDigits.length() < 4 ? ""
                        : targetDigits.substring(targetDigits.length() - 4);
                int sameTailBindings = 0;
                int totalBindings = 0;
                String phoneSelection = bindingSource.isEmpty()
                        ? null : "LOWER(sync_status)=?";
                String[] phoneSelectionArgs = bindingSource.isEmpty()
                        ? null : new String[]{bindingSource};
                try (Cursor cursor = db.query(ExpressDatabase.PHONE_TABLE,
                        new String[]{"phone"}, phoneSelection, phoneSelectionArgs,
                        null, null, null)) {
                    while (cursor.moveToNext()) {
                        totalBindings++;
                        String digits = normalizePhoneDigits(cursor.getString(0));
                        if (!targetTail.isEmpty() && digits.endsWith(targetTail)) {
                            sameTailBindings++;
                        }
                    }
                }
                boolean tailIsUnique = sameTailBindings == 1;
                try (Cursor cursor = db.query(ExpressDatabase.EXPRESS_TABLE,
                        new String[]{"_id", "subPhone", "normalizedMailNo", "mailNo",
                                "fromCp", "stateOwner"},
                        null, null, null, null, null)) {
                    while (cursor.moveToNext()) {
                        String associatedPhone = clean(cursor.getString(1));
                        String owner = clean(cursor.getString(5));
                        if (owner.isEmpty()) owner = clean(cursor.getString(4));
                        if (!bindingSource.isEmpty()
                                && !ownerBelongsToBindingSource(owner, bindingSource)) continue;
                        boolean soleAutomaticBinding = totalBindings == 1
                                && associatedPhone.isEmpty()
                                && !ExpressSourcePolicy.SOURCE_KUAIDI100.equals(
                                        ExpressSourcePolicy.source(owner))
                                && !ExpressSourcePolicy.SOURCE_V4.equals(
                                        ExpressSourcePolicy.source(owner));
                        if (!soleAutomaticBinding && !matchesPhoneAssociation(
                                associatedPhone, target, tailIsUnique)) continue;
                        long rowId = cursor.getLong(0);
                        removedRows.add(rowId);
                        if (isAutomaticAccountOwner(owner)) {
                            String normalized = clean(cursor.getString(2));
                            if (normalized.isEmpty()) {
                                normalized = ExpressSourcePolicy.normalizeWaybill(
                                        cursor.getString(3));
                            }
                            if (!normalized.isEmpty()) {
                                suppressedAssociations.add(new String[]{normalized,
                                        bindingSource.isEmpty()
                                                ? ExpressSourcePolicy.bindingSourceForOwner(owner)
                                                : normalizeBindingSource(bindingSource)});
                            }
                        }
                    }
                }
                try (Cursor cursor = db.query(ExpressDatabase.KUAIDI100_PENDING_TABLE,
                        new String[]{"normalized_waybill", "phone", "binding_source"},
                        null, null, null, null, null)) {
                    while (cursor.moveToNext()) {
                        String pendingBindingSource = normalizeBindingSource(cursor.getString(2));
                        if (!bindingSource.isEmpty()
                                && !bindingSource.equals(pendingBindingSource)) continue;
                        if (matchesPhoneAssociation(
                                clean(cursor.getString(1)), target, tailIsUnique)) {
                            removedPending.add(new String[]{
                                    clean(cursor.getString(0)), pendingBindingSource});
                        }
                    }
                }
                for (long rowId : removedRows) {
                    db.delete(ExpressDatabase.EXPRESS_TABLE, "_id=?",
                            new String[]{Long.toString(rowId)});
                }
                for (String[] association : suppressedAssociations) {
                    insertUnboundPhoneAssociation(
                            db, association[0], association[1], targetDigits);
                }
                for (String[] pendingKey : removedPending) {
                    db.delete(ExpressDatabase.KUAIDI100_PENDING_TABLE,
                            "normalized_waybill=? AND LOWER(binding_source)=?", pendingKey);
                }
                pruneHiddenTimelines(db);
                pruneHiddenOrderProjections(db);
                if (bindingSource.isEmpty()) {
                    db.delete(ExpressDatabase.PHONE_TABLE, "phone=?", new String[]{target});
                } else {
                    db.delete(ExpressDatabase.PHONE_TABLE,
                            "phone=? AND LOWER(sync_status)=?",
                            new String[]{target, bindingSource});
                }
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
        for (long rowId : removedRows) ExpressNotifications.cancel(context, rowId);
        publishChange(null, null);
    }

    private static boolean ownerBelongsToBindingSource(String owner, String bindingSource) {
        return ExpressSourcePolicy.belongsToBindingSource(owner, bindingSource);
    }

    private static boolean isAutomaticAccountOwner(String owner) {
        String source = ExpressSourcePolicy.source(owner);
        return ExpressSourcePolicy.SOURCE_INTERFACE5.equals(source)
                || ExpressSourcePolicy.SOURCE_INTERFACE6.equals(source)
                || ExpressSourcePolicy.SOURCE_INTERFACE5_JD.equals(source)
                || ExpressSourcePolicy.SOURCE_LEGACY_ACCOUNT_ORDER.equals(source)
                || ExpressSourcePolicy.SOURCE_DISCOVERY.equals(source);
    }

    private static boolean rejectsUnboundAutomaticWrite(
            SQLiteDatabase db, String normalizedWaybill,
            String bindingSource, String phone) {
        if (!hasUnboundPhoneAssociation(
                db, normalizedWaybill, bindingSource)) return false;
        String candidate = normalizePhoneDigits(phone);
        if (candidate.isEmpty()) return true;
        try (Cursor cursor = db.query(
                ExpressDatabase.PHONE_TABLE, new String[]{"phone"},
                "LOWER(sync_status)=?",
                new String[]{normalizeBindingSource(bindingSource)},
                null, null, null)) {
            while (cursor.moveToNext()) {
                if (candidate.equals(normalizePhoneDigits(cursor.getString(0)))) return false;
            }
        }
        return true;
    }

    private static boolean hasUnboundPhoneAssociation(
            SQLiteDatabase db, String normalizedWaybill, String bindingSource) {
        if (normalizedWaybill == null || normalizedWaybill.isEmpty()) return false;
        try (Cursor cursor = db.query(
                ExpressDatabase.UNBOUND_ASSOCIATION_TABLE,
                new String[]{"waybill_hash"},
                "waybill_hash=? AND binding_source=?",
                new String[]{waybillHash(normalizedWaybill),
                        normalizeBindingSource(bindingSource)},
                null, null, null, "1")) {
            return cursor.moveToFirst();
        }
    }

    private void normalizeLocalIcons() {
        if (context.getSharedPreferences(MIGRATION_PREFS, 0)
                .getBoolean(ICON_MIGRATION, false)) return;
        SQLiteDatabase db = helper.getWritableDatabase();
        db.beginTransaction();
        try {
            try (Cursor cursor = db.query(ExpressDatabase.EXPRESS_TABLE,
                    new String[]{"_id", "cpCode", "cpName", "data2"},
                    null, null, null, null, null)) {
                while (cursor.moveToNext()) {
                    String expected = CarrierRegistry.localIconUri(
                            context, cursor.getString(1), cursor.getString(2));
                    if (expected.equals(clean(cursor.getString(3)))) continue;
                    ContentValues values = new ContentValues();
                    values.put("data2", expected);
                    db.update(ExpressDatabase.EXPRESS_TABLE, values,
                            "_id=?", new String[]{Long.toString(cursor.getLong(0))});
                }
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        context.getSharedPreferences(MIGRATION_PREFS, 0).edit()
                .putBoolean(ICON_MIGRATION, true).apply();
    }

    /** Backfills the canonical projection without deleting or merging existing source rows. */
    private void migrateCanonicalRows() {
        SQLiteDatabase db = helper.getWritableDatabase();
        db.beginTransaction();
        try (Cursor cursor = db.query(
                ExpressDatabase.EXPRESS_TABLE, null, null, null, null, null, null)) {
            while (cursor.moveToNext()) {
                long rowId = number(cursor, "_id");
                String waybill = text(cursor, "mailNo");
                String source = ExpressSourcePolicy.source(text(cursor, "fromCp"));
                String owner = text(cursor, "stateOwner");
                if (owner.isEmpty() && !ExpressSourcePolicy.SOURCE_DISCOVERY.equals(source)) {
                    owner = source;
                } else if (!owner.isEmpty()) {
                    owner = ExpressSourcePolicy.source(owner);
                }
                boolean discoveryOnly = ExpressSourcePolicy.SOURCE_DISCOVERY.equals(source)
                        && (owner.isEmpty()
                        || ExpressSourcePolicy.SOURCE_DISCOVERY.equals(owner));
                if (discoveryOnly) owner = "";
                String detail = text(cursor, "lastLogisticDetail");
                StatusSemantic semantic = discoveryOnly ? StatusSemantic.UNKNOWN
                        : ExpressStatusNormalizer.normalize(
                                owner.isEmpty() ? source : owner,
                                text(cursor, "logsiticsStatus"),
                                text(cursor, "logisticsStatusDesc"),
                                detail);
                boolean placeholderDetail = ExpressStatusNormalizer
                        .isHeadlinePlaceholder(detail, semantic);
                ExpressTimeline.Track recovered = placeholderDetail
                        ? ExpressTimeline.latestMeaningful(
                                text(cursor, "packageDyn"), semantic) : null;
                if (recovered != null) detail = recovered.detail;
                long eventTime = number(cursor, "statusEventTime");
                if (discoveryOnly) {
                    eventTime = 0L;
                } else if (eventTime <= 0L) {
                    eventTime = ExpressSourcePolicy.parseEventTime(
                            text(cursor, "logisticsGmtModified"));
                }
                String detailUrl = ExpressSourcePolicy.selectDetailUrl(
                        "", text(cursor, "moreInfoUrl"));
                String routeOwner = detailUrl.isEmpty() ? "" : text(cursor, "routeOwner");
                if (!detailUrl.isEmpty() && routeOwner.isEmpty()) {
                    routeOwner = ExpressSourcePolicy.SOURCE_DISCOVERY.equals(source)
                            ? ExpressSourcePolicy.SOURCE_DISCOVERY : source;
                }

                ContentValues values = new ContentValues();
                values.put("normalizedMailNo", ExpressSourcePolicy.normalizeWaybill(waybill));
                values.put("fromCp", source);
                values.put("stateOwner", owner);
                values.put("logsiticsStatus", semantic.storageCode);
                values.put("logisticsStatusDesc", discoveryOnly ? ""
                        : semantic == StatusSemantic.UNKNOWN
                        ? text(cursor, "logisticsStatusDesc") : semantic.label);
                values.put("statusEventTime", eventTime);
                values.put("cpName", CarrierRegistry.companyName(
                        text(cursor, "cpCode"), text(cursor, "cpName")));
                if (discoveryOnly || placeholderDetail) {
                    values.put("lastLogisticDetail", recovered == null ? "" : detail);
                    values.put("logisticsGmtModified", recovered == null ? "" : recovered.time);
                }
                if (discoveryOnly) {
                    values.put("packageDyn", "");
                }
                values.put("moreInfoUrl", detailUrl);
                values.put("routeOwner", routeOwner);
                long updatedAt = number(cursor, "updatedAt");
                values.put("updatedAt", updatedAt > 0L ? updatedAt : eventTime);
                db.update(ExpressDatabase.EXPRESS_TABLE, values, "_id=?",
                        new String[]{Long.toString(rowId)});
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    /** Replaces legacy credential-bearing Cainiao URLs with an opaque route plus encrypted key. */
    private boolean migrateRouteCredentials() {
        boolean completed = true;
        SQLiteDatabase db = helper.getWritableDatabase();
        db.beginTransaction();
        try (Cursor cursor = db.query(
                ExpressDatabase.EXPRESS_TABLE, null, null, null, null, null, null)) {
            while (cursor.moveToNext()) {
                long rowId = number(cursor, "_id");
                String route = text(cursor, "moreInfoUrl");
                String routeInterface = text(cursor, "routeInterface");
                String storedRouteCredential = text(cursor, "routeCredential");
                EncryptedExpressFields.Result decodedRouteCredential =
                        EncryptedExpressFields.tryDecode(storedRouteCredential);
                if (!decodedRouteCredential.available) {
                    completed = false;
                    continue;
                }
                String routeCredential = decodedRouteCredential.value;
                if (CainiaoRoute.isLegacyCredentialedUrl(route)) {
                    if (routeInterface.isEmpty()) {
                        routeInterface = CainiaoRoute.interfaceFromLegacyUrl(route);
                    }
                    // Legacy builds stored the full provider URL in this plaintext column.
                    // Move the exact route into the encrypted field even if an older build had
                    // separately cached only its secretKey there.
                    routeCredential = route;
                    route = CainiaoRoute.token(routeInterface);
                } else if (CainiaoRoute.isToken(route) && routeInterface.isEmpty()) {
                    routeInterface = CainiaoRoute.interfaceFromToken(route);
                }
                ContentValues values = new ContentValues();
                values.put("moreInfoUrl", route);
                values.put("routeInterface", routeInterface);
                EncryptedExpressFields.Result encryptedRouteCredential =
                        EncryptedExpressFields.tryEncode(routeCredential);
                if (!encryptedRouteCredential.available) {
                    completed = false;
                    continue;
                }
                values.put("routeCredential", encryptedRouteCredential.value);
                db.update(ExpressDatabase.EXPRESS_TABLE, values, "_id=?",
                        new String[]{Long.toString(rowId)});
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        return completed;
    }

    private void publishChange(ExpressItem previous, ExpressItem current) {
        ExpressItem notifyNow = null;
        synchronized (this) {
            if (ExpressNotifications.shouldPostUpdate(previous, current)) {
                if (changeBatchDepth > 0) notificationPending.put(current.rowId, current);
                else notifyNow = current;
            }
            if (changeBatchDepth > 0) {
                invalidationPending = true;
                return;
            }
        }
        if (notifyNow != null) ExpressNotifications.post(context, notifyNow);
        emitInvalidation();
    }

    private void finishChangeBatch() {
        ArrayList<ExpressItem> notifications = new ArrayList<>();
        boolean invalidate = false;
        synchronized (this) {
            if (changeBatchDepth <= 0) return;
            changeBatchDepth--;
            if (changeBatchDepth > 0) return;
            invalidate = invalidationPending;
            invalidationPending = false;
            notifications.addAll(notificationPending.values());
            notificationPending.clear();
        }
        for (ExpressItem pending : notifications) {
            ExpressItem current = find(pending.rowId);
            if (current != null) ExpressNotifications.post(context, current);
        }
        if (invalidate) emitInvalidation();
    }

    private void emitInvalidation() {
        ExpressWidgetProvider.refreshAll(context);
        context.sendBroadcast(new Intent(ACTION_CHANGED).setPackage(context.getPackageName()));
    }

    private static boolean winsCanonical(ExpressItem candidate, ExpressItem current) {
        String candidateOwner = candidate.stateOwner.isEmpty()
                ? candidate.source : candidate.stateOwner;
        String currentOwner = current.stateOwner.isEmpty()
                ? current.source : current.stateOwner;
        int source = Integer.compare(
                ExpressSourcePolicy.stateRank(candidateOwner),
                ExpressSourcePolicy.stateRank(currentOwner));
        if (source != 0) return source > 0;
        int event = Long.compare(candidate.statusEventTime, current.statusEventTime);
        if (event != 0) return event > 0;
        int updated = Long.compare(candidate.updatedAt, current.updatedAt);
        if (updated != 0) return updated > 0;
        return candidate.rowId > current.rowId;
    }

    static int visibleStatusRank(StatusSemantic semantic) {
        if (semantic == null) return 7;
        switch (semantic) {
            case WAITING_PICKUP: return 0;
            case DELIVERY: return 1;
            case TRANSIT: return 2;
            case PICKED: return 3;
            case SHIPPED: return 4;
            case ORDERED: return 5;
            case DANGER: return 6;
            case UNKNOWN: return 7;
            case CANCELLED: return 8;
            case COMPLETED: return 9;
            default: return 7;
        }
    }

    private ExpressItem read(Cursor cursor) {
        String storedStatus = text(cursor, "logsiticsStatus");
        String statusDescription = text(cursor, "logisticsStatusDesc");
        String source = text(cursor, "fromCp");
        String latestDetail = text(cursor, "lastLogisticDetail");
        String stateOwner = text(cursor, "stateOwner");
        StatusSemantic semantic = ExpressStatusNormalizer.normalize(
                stateOwner.isEmpty() ? source : stateOwner,
                storedStatus, statusDescription, latestDetail);
        String effectiveOwner = stateOwner.isEmpty() ? source : stateOwner;
        String normalizedOwner = ExpressSourcePolicy.source(effectiveOwner);
        if (semantic == StatusSemantic.UNKNOWN
                && (ExpressSourcePolicy.SOURCE_INTERFACE5_JD.equals(normalizedOwner)
                || ExpressSourcePolicy.SOURCE_LEGACY_ACCOUNT_ORDER.equals(normalizedOwner))) {
            semantic = ExpressStatusNormalizer.inferAccountOrderStatus(
                    latestDetail, text(cursor, "packageDyn"));
        }
        EncryptedExpressFields.Result routeCredential =
                EncryptedExpressFields.tryDecode(text(cursor, "routeCredential"));
        // The projection is created by an isolated account-order row. Applying it to another
        // source row with the same normalized identity would leak display state across sources.
        OrderProjection projection = ExpressSourcePolicy.isAccountOrderOwner(normalizedOwner)
                ? orderProjection(text(cursor, "mailNo"),
                ExpressSourcePolicy.bindingSourceForOwner(normalizedOwner))
                : OrderProjection.EMPTY;
        return new ExpressItem(
                number(cursor, "_id"),
                text(cursor, "subPhone"),
                text(cursor, "mailNo"),
                text(cursor, "cpCode"),
                CarrierRegistry.companyName(
                        text(cursor, "cpCode"), text(cursor, "cpName")),
                semantic,
                statusDescription,
                latestDetail,
                text(cursor, "logisticsGmtModified"),
                text(cursor, "packageDyn"),
                text(cursor, "remark"),
                source,
                text(cursor, "moreInfoUrl"),
                number(cursor, "statusEventTime"),
                number(cursor, "updatedAt"),
                stateOwner,
                text(cursor, "routeOwner"),
                text(cursor, "routeInterface"),
                routeCredential.value,
                routeCredential.available,
                projection.waybill,
                projection.companyName,
                projection.tracksJson);
    }

    /** Saves a late-arriving display identity without replacing the stable account record id. */
    public synchronized boolean saveOrderProjection(
            String sourceId, String bindingSource, String displayWaybill,
            String companyName, String tracksJson) {
        String normalizedSource = ExpressSourcePolicy.normalizeWaybill(sourceId);
        String normalizedDisplay = ExpressSourcePolicy.normalizeWaybill(displayWaybill);
        String selectedBindingSource = normalizeBindingSource(bindingSource);
        if (normalizedSource.isEmpty() || normalizedDisplay.isEmpty()
                || normalizedSource.equals(normalizedDisplay)) return false;
        SQLiteDatabase db = helper.getWritableDatabase();
        long changed;
        db.beginTransaction();
        try {
            if (!canSaveOrderProjection(
                    hasDeletionTombstone(db, normalizedSource),
                    hasDeletionTombstone(db, normalizedDisplay))) return false;
            OrderProjection existing = orderProjection(sourceId, selectedBindingSource);
            ContentValues values = new ContentValues();
            values.put("normalized_source_id", normalizedSource);
            values.put("binding_source", selectedBindingSource);
            values.put("source_id", clean(sourceId));
            values.put("display_waybill", clean(displayWaybill));
            values.put("normalized_display_waybill", normalizedDisplay);
            values.put("carrier_name", clean(companyName).isEmpty()
                    ? existing.companyName : clean(companyName));
            // The isolated order page contributes display identity only. Its page timeline is
            // deliberately not mixed into the one selected local provider timeline.
            values.put("tracks_json", "[]");
            values.put("updated_at", System.currentTimeMillis());
            changed = db.insertWithOnConflict(
                    ExpressDatabase.ORDER_PROJECTION_TABLE, null, values,
                    SQLiteDatabase.CONFLICT_REPLACE);
            if (changed < 0L) {
                throw new IllegalStateException("Order projection persistence failed");
            }
            String previousDisplay = ExpressSourcePolicy.normalizeWaybill(existing.waybill);
            if (!previousDisplay.isEmpty() && !previousDisplay.equals(normalizedDisplay)) {
                deleteKuaidi100TimelineIfUnreferenced(db, previousDisplay);
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        if (changed >= 0L) emitInvalidation();
        return changed >= 0L;
    }

    static boolean canSaveOrderProjection(
            boolean sourceTombstoned, boolean displayWaybillTombstoned) {
        return !sourceTombstoned && !displayWaybillTombstoned;
    }

    private OrderProjection orderProjection(String sourceId, String bindingSource) {
        String normalized = ExpressSourcePolicy.normalizeWaybill(sourceId);
        if (normalized.isEmpty()) return OrderProjection.EMPTY;
        try (Cursor cursor = helper.getReadableDatabase().query(
                ExpressDatabase.ORDER_PROJECTION_TABLE,
                new String[]{"display_waybill", "carrier_name", "tracks_json"},
                "normalized_source_id=? AND LOWER(binding_source)=?",
                new String[]{normalized, normalizeBindingSource(bindingSource)},
                null, null, null, "1")) {
            if (!cursor.moveToFirst()) return OrderProjection.EMPTY;
            return new OrderProjection(text(cursor, "display_waybill"),
                    text(cursor, "carrier_name"), text(cursor, "tracks_json"));
        }
    }

    private static final class OrderProjection {
        static final OrderProjection EMPTY = new OrderProjection("", "", "");
        final String waybill;
        final String companyName;
        final String tracksJson;

        OrderProjection(String waybill, String companyName, String tracksJson) {
            this.waybill = clean(waybill);
            this.companyName = clean(companyName);
            this.tracksJson = clean(tracksJson);
        }
    }

    private static String text(Cursor cursor, String column) {
        int index = cursor.getColumnIndex(column);
        return index < 0 || cursor.isNull(index) ? "" : cursor.getString(index);
    }

    private static long number(Cursor cursor, String column) {
        int index = cursor.getColumnIndex(column);
        return index < 0 || cursor.isNull(index) ? 0L : cursor.getLong(index);
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    private static String normalizeBindingSource(String value) {
        return "interface5".equalsIgnoreCase(clean(value)) ? "interface5" : "interface6";
    }

    private static String preferNonEmpty(String primary, String fallback) {
        String value = clean(primary);
        return value.isEmpty() ? clean(fallback) : value;
    }

    private static void addPhoneCandidate(
            List<String> candidates, Set<String> tails, String phone) {
        String value = clean(phone);
        String digits = value.replaceAll("\\D", "");
        if (digits.length() < 4) return;
        String tail = digits.substring(digits.length() - 4);
        if (tails.add(tail)) candidates.add(value);
    }

    static boolean matchesPhoneAssociation(
            String associatedPhone, String removedPhone, boolean tailIsUnique) {
        String associated = normalizePhoneDigits(associatedPhone);
        String removed = normalizePhoneDigits(removedPhone);
        if (associated.isEmpty() || removed.isEmpty()) return false;
        if (associated.equals(removed)) return true;
        if (!tailIsUnique || associated.length() >= 11 || associated.length() < 4) return false;
        return removed.endsWith(associated.substring(associated.length() - 4));
    }

    /** Deletes a timeline only after no non-deleted source row for that waybill remains. */
    private static void pruneHiddenTimelines(SQLiteDatabase db) {
        pruneHiddenKuaidi100Timelines(db);
        pruneHiddenTimeline(db, ExpressDatabase.V4_TIMELINE_TABLE);
        pruneHiddenTimeline(db, ExpressDatabase.INTERFACE6_TIMELINE_TABLE);
        pruneHiddenAccountTimeline(db, ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE,
                "'INTERFACE5','I5-JD'");
        pruneHiddenAccountTimeline(db, ExpressDatabase.ACCOUNT_V6_TIMELINE_TABLE,
                "'INTERFACE6','I6-JD'");
    }

    private static void pruneHiddenOrderProjections(SQLiteDatabase db) {
        db.execSQL("DELETE FROM " + ExpressDatabase.ORDER_PROJECTION_TABLE
                + " WHERE NOT EXISTS (SELECT 1 FROM " + ExpressDatabase.EXPRESS_TABLE
                + " WHERE (" + ExpressDatabase.EXPRESS_TABLE + ".normalizedMailNo="
                + ExpressDatabase.ORDER_PROJECTION_TABLE + ".normalized_source_id"
                + " OR UPPER(" + ExpressDatabase.EXPRESS_TABLE + ".mailNo)=UPPER("
                + ExpressDatabase.ORDER_PROJECTION_TABLE + ".source_id))"
                + " AND " + ExpressDatabase.EXPRESS_TABLE + ".canShow=1"
                + " AND " + ExpressDatabase.EXPRESS_TABLE + ".isDeleted=0"
                + " AND ((LOWER(" + ExpressDatabase.ORDER_PROJECTION_TABLE
                + ".binding_source)='interface5'"
                + " AND (UPPER(stateOwner)='I5-JD'"
                + " OR (COALESCE(stateOwner,'')='' AND UPPER(fromCp)='I5-JD')))"
                + " OR (LOWER(" + ExpressDatabase.ORDER_PROJECTION_TABLE
                + ".binding_source)='interface6'"
                + " AND (UPPER(stateOwner)='I6-JD'"
                + " OR (COALESCE(stateOwner,'')='' AND UPPER(fromCp)='I6-JD')))))");
    }

    private static void pruneHiddenTimeline(SQLiteDatabase db, String table) {
        db.execSQL("DELETE FROM " + table
                + " WHERE NOT EXISTS (SELECT 1 FROM " + ExpressDatabase.EXPRESS_TABLE
                + " WHERE (" + ExpressDatabase.EXPRESS_TABLE + ".normalizedMailNo="
                + table + ".normalized_waybill OR UPPER("
                + ExpressDatabase.EXPRESS_TABLE + ".mailNo)=UPPER(" + table + ".waybill))"
                + " AND " + ExpressDatabase.EXPRESS_TABLE + ".canShow=1"
                + " AND " + ExpressDatabase.EXPRESS_TABLE + ".isDeleted=0)");
    }

    private static void pruneHiddenKuaidi100Timelines(SQLiteDatabase db) {
        ArrayList<String> cachedWaybills = new ArrayList<>();
        try (Cursor cursor = db.query(
                ExpressDatabase.KUAIDI100_TIMELINE_TABLE,
                new String[]{"normalized_waybill"}, null, null,
                null, null, null)) {
            while (cursor.moveToNext()) {
                String normalized = clean(cursor.getString(0));
                if (!normalized.isEmpty()) cachedWaybills.add(normalized);
            }
        }
        ArrayList<String> orphaned = new ArrayList<>();
        for (String normalized : cachedWaybills) {
            if (!hasVisibleKuaidi100Reference(db, normalized)) {
                orphaned.add(normalized);
            }
        }
        for (String normalized : orphaned) {
            db.delete(ExpressDatabase.KUAIDI100_TIMELINE_TABLE,
                    "normalized_waybill=?", new String[]{normalized});
        }
    }

    private static boolean hasVisibleKuaidi100Reference(
            SQLiteDatabase db, String normalizedWaybill) {
        try (Cursor cursor = db.query(
                ExpressDatabase.EXPRESS_TABLE, new String[]{"_id"},
                "(normalizedMailNo=? OR UPPER(REPLACE(REPLACE(TRIM(mailNo),'-',''),'_',''))=?)"
                        + " AND canShow=1 AND isDeleted=0",
                new String[]{normalizedWaybill, normalizedWaybill},
                null, null, null, "1")) {
            if (cursor.moveToFirst()) return true;
        }
        String projectionOwner = "((LOWER(p.binding_source)='interface5'"
                + " AND (UPPER(e.stateOwner)='I5-JD'"
                + " OR (COALESCE(e.stateOwner,'')='' AND UPPER(e.fromCp)='I5-JD')))"
                + " OR (LOWER(p.binding_source)='interface6'"
                + " AND (UPPER(e.stateOwner)='I6-JD'"
                + " OR (COALESCE(e.stateOwner,'')='' AND UPPER(e.fromCp)='I6-JD'))))";
        try (Cursor cursor = db.rawQuery(
                "SELECT 1 FROM " + ExpressDatabase.ORDER_PROJECTION_TABLE + " p JOIN "
                        + ExpressDatabase.EXPRESS_TABLE
                        + " e ON (e.normalizedMailNo=p.normalized_source_id"
                        + " OR UPPER(e.mailNo)=UPPER(p.source_id))"
                        + " WHERE (p.normalized_display_waybill=?"
                        + " OR UPPER(REPLACE(REPLACE(TRIM(p.display_waybill),'-',''),'_',''))=?)"
                        + " AND e.canShow=1 AND e.isDeleted=0 AND " + projectionOwner
                        + " LIMIT 1",
                new String[]{normalizedWaybill, normalizedWaybill})) {
            return cursor.moveToFirst();
        }
    }

    private static void deleteKuaidi100TimelineIfUnreferenced(
            SQLiteDatabase db, String normalizedWaybill) {
        if (normalizedWaybill == null || normalizedWaybill.isEmpty()
                || hasVisibleKuaidi100Reference(db, normalizedWaybill)) return;
        db.delete(ExpressDatabase.KUAIDI100_TIMELINE_TABLE,
                "normalized_waybill=?", new String[]{normalizedWaybill});
    }

    private static void pruneHiddenAccountTimeline(
            SQLiteDatabase db, String table, String owners) {
        db.execSQL("DELETE FROM " + table
                + " WHERE NOT EXISTS (SELECT 1 FROM " + ExpressDatabase.EXPRESS_TABLE
                + " WHERE (" + ExpressDatabase.EXPRESS_TABLE + ".normalizedMailNo="
                + table + ".normalized_waybill OR UPPER("
                + ExpressDatabase.EXPRESS_TABLE + ".mailNo)=UPPER(" + table + ".waybill))"
                + " AND " + ExpressDatabase.EXPRESS_TABLE + ".canShow=1"
                + " AND " + ExpressDatabase.EXPRESS_TABLE + ".isDeleted=0"
                + " AND (UPPER(stateOwner) IN (" + owners + ")"
                + " OR (COALESCE(stateOwner,'')=''"
                + " AND UPPER(fromCp) IN (" + owners + "))))");
    }

    /** Removes all shipment data after its retention window, retaining only a hash. */
    private static void expireShipments(
            SQLiteDatabase db, List<ExpressItem> expired) {
        HashSet<String> removedWaybills = new HashSet<>();
        for (ExpressItem item : expired) {
            String normalized = ExpressSourcePolicy.normalizeWaybill(item.waybill);
            if (normalized.isEmpty()) {
                db.delete(ExpressDatabase.EXPRESS_TABLE, "_id=?",
                        new String[]{Long.toString(item.rowId)});
                continue;
            }
            if (!removedWaybills.add(normalized)) continue;
            insertTombstone(db, normalized, "retention_expired");
            deleteWaybillRows(db, normalized, item.rowId);
        }
    }

    private static boolean hasDeletionTombstone(SQLiteDatabase db, String normalizedWaybill) {
        if (normalizedWaybill == null || normalizedWaybill.isEmpty()) return false;
        try (Cursor cursor = db.query(ExpressDatabase.TOMBSTONE_TABLE,
                new String[]{"waybill_hash"}, "waybill_hash=?",
                new String[]{waybillHash(normalizedWaybill)}, null, null, null, "1")) {
            return cursor.moveToFirst();
        }
    }

    private static boolean hasPendingManual(SQLiteDatabase db, String normalizedWaybill) {
        if (normalizedWaybill == null || normalizedWaybill.isEmpty()) return false;
        try (Cursor cursor = db.query(ExpressDatabase.KUAIDI100_PENDING_TABLE,
                new String[]{"normalized_waybill"}, "normalized_waybill=?",
                new String[]{normalizedWaybill}, null, null, null, "1")) {
            return cursor.moveToFirst();
        }
    }

    /** Converts older hidden rows into non-reversible tombstones and removes their payload. */
    private void migrateDeletionRows() {
        SQLiteDatabase db = helper.getWritableDatabase();
        ArrayList<String> normalizedWaybills = new ArrayList<>();
        db.beginTransaction();
        try (Cursor cursor = db.query(ExpressDatabase.EXPRESS_TABLE,
                new String[]{"mailNo", "normalizedMailNo"},
                "isDeleted=1 OR canShow=0", null, null, null, null)) {
            while (cursor.moveToNext()) {
                String normalized = clean(cursor.getString(1));
                if (normalized.isEmpty()) {
                    normalized = ExpressSourcePolicy.normalizeWaybill(cursor.getString(0));
                }
                if (!normalized.isEmpty() && !normalizedWaybills.contains(normalized)) {
                    normalizedWaybills.add(normalized);
                    insertTombstone(db, normalized, "hidden_row_migrated");
                }
            }
            db.delete(ExpressDatabase.EXPRESS_TABLE, "isDeleted=1 OR canShow=0", null);
            for (String normalized : normalizedWaybills) deleteTimelines(db, normalized);
            pruneHiddenTimelines(db);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    private static void insertTombstone(SQLiteDatabase db, String normalized, String reason) {
        if (normalized == null || normalized.isEmpty()) return;
        String hash = waybillHash(normalized);
        ContentValues values = new ContentValues();
        values.put("waybill_hash", hash);
        values.put("reason", clean(reason));
        values.put("created_at", System.currentTimeMillis());
        db.insertWithOnConflict(ExpressDatabase.TOMBSTONE_TABLE, null, values,
                SQLiteDatabase.CONFLICT_IGNORE);
        db.delete(ExpressDatabase.UNBOUND_ASSOCIATION_TABLE,
                "waybill_hash=?", new String[]{hash});
    }

    private static void insertUnboundPhoneAssociation(
            SQLiteDatabase db, String normalizedWaybill,
            String bindingSource, String phone) {
        String normalized = ExpressSourcePolicy.normalizeWaybill(normalizedWaybill);
        String phoneDigits = normalizePhoneDigits(phone);
        if (normalized.isEmpty() || phoneDigits.isEmpty()) return;
        db.execSQL("INSERT OR IGNORE INTO " + ExpressDatabase.UNBOUND_ASSOCIATION_TABLE
                        + "(waybill_hash,binding_source,phone_hash) VALUES(?,?,?)",
                new Object[]{waybillHash(normalized), normalizeBindingSource(bindingSource),
                        phoneAssociationHash(phoneDigits)});
    }

    private static void clearUnboundPhoneAssociations(
            SQLiteDatabase db, String bindingSource, String phone) {
        String digits = normalizePhoneDigits(phone);
        if (digits.isEmpty()) return;
        db.delete(ExpressDatabase.UNBOUND_ASSOCIATION_TABLE,
                "binding_source=? AND phone_hash=?",
                new String[]{normalizeBindingSource(bindingSource),
                        phoneAssociationHash(digits)});
    }

    private static void collectRowIds(
            SQLiteDatabase db, String normalized, List<Long> output) {
        if (normalized == null || normalized.isEmpty()) return;
        try (Cursor cursor = db.query(ExpressDatabase.EXPRESS_TABLE, new String[]{"_id"},
                "normalizedMailNo=?", new String[]{normalized}, null, null, null)) {
            while (cursor.moveToNext()) output.add(cursor.getLong(0));
        }
    }

    private static void deleteWaybillRows(SQLiteDatabase db, String normalized, long fallbackRowId) {
        if (normalized == null || normalized.isEmpty()) {
            db.delete(ExpressDatabase.EXPRESS_TABLE, "_id=?",
                    new String[]{Long.toString(fallbackRowId)});
            return;
        }
        db.delete(ExpressDatabase.EXPRESS_TABLE, "normalizedMailNo=?",
                new String[]{normalized});
        db.delete(ExpressDatabase.EXPRESS_TABLE, "_id=?",
                new String[]{Long.toString(fallbackRowId)});
        deleteTimelines(db, normalized);
        db.delete(ExpressDatabase.KUAIDI100_PENDING_TABLE,
                "normalized_waybill=?", new String[]{normalized});
    }

    private static void deleteTimelines(SQLiteDatabase db, String normalized) {
        ArrayList<String> projectedWaybills = new ArrayList<>();
        try (Cursor cursor = db.query(
                ExpressDatabase.ORDER_PROJECTION_TABLE,
                new String[]{"normalized_display_waybill"},
                "normalized_source_id=? OR normalized_display_waybill=?",
                new String[]{normalized, normalized},
                null, null, null)) {
            while (cursor.moveToNext()) {
                String projected = clean(cursor.getString(0));
                if (!projected.isEmpty() && !projectedWaybills.contains(projected)) {
                    projectedWaybills.add(projected);
                }
            }
        }
        db.delete(ExpressDatabase.V4_TIMELINE_TABLE,
                "normalized_waybill=?", new String[]{normalized});
        db.delete(ExpressDatabase.INTERFACE6_TIMELINE_TABLE,
                "normalized_waybill=?", new String[]{normalized});
        db.delete(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE,
                "normalized_waybill=?", new String[]{normalized});
        db.delete(ExpressDatabase.ACCOUNT_V6_TIMELINE_TABLE,
                "normalized_waybill=?", new String[]{normalized});
        db.delete(ExpressDatabase.ORDER_PROJECTION_TABLE,
                "normalized_source_id=? OR normalized_display_waybill=?",
                new String[]{normalized, normalized});
        deleteKuaidi100TimelineIfUnreferenced(db, normalized);
        for (String projected : projectedWaybills) {
            deleteKuaidi100TimelineIfUnreferenced(db, projected);
        }
    }

    static String waybillHash(String normalized) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(clean(normalized).toUpperCase(Locale.ROOT)
                            .getBytes(StandardCharsets.UTF_8));
            StringBuilder output = new StringBuilder(digest.length * 2);
            for (byte value : digest) output.append(String.format(
                    Locale.US, "%02x", value & 0xff));
            return output.toString();
        } catch (Exception impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    static String phoneAssociationHash(String phone) {
        String digits = normalizePhoneDigits(phone);
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(("unbound-phone\u0000" + digits)
                            .getBytes(StandardCharsets.UTF_8));
            StringBuilder output = new StringBuilder(digest.length * 2);
            for (byte value : digest) output.append(String.format(
                    Locale.US, "%02x", value & 0xff));
            return output.toString();
        } catch (Exception impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    private static String normalizePhoneDigits(String phone) {
        String digits = clean(phone).replaceAll("\\D", "");
        if (digits.length() == 13 && digits.startsWith("86")) digits = digits.substring(2);
        return digits;
    }
}
