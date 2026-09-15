package me.pipi.deliveries.data;

import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.WorkerStatusProjection;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.model.CainiaoRoute;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.ManualQuerySuccess;
import me.pipi.deliveries.model.PendingExpressQuery;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressLog;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import me.pipi.deliveries.notification.ExpressNotifications;
import me.pipi.deliveries.widget.ExpressWidgetProvider;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;

/** Single persistence and outward-invalidation boundary for all express changes. */
public final class ExpressRepository {
    public static final String ACTION_CHANGED = "me.pipi.deliveries.EXPRESS_DATA_CHANGED";
    /** ACTION_SYNC_FINISHED 附带这轮的计数，列表页据此弹统一的下拉结果 toast。 */
    public static final String EXTRA_SYNC_ATTEMPTED = "attempted";
    public static final String EXTRA_SYNC_SUCCEEDED = "succeeded";
    public static final String EXTRA_SYNC_FAILED = "failed";
    public static final String EXTRA_SYNC_WORK_ID = "workId";
    public static final String EXTRA_SYNC_RETRYING = "retrying";
    public static final String EXTRA_SYNC_ACCOUNT_LIST_UPDATED = "accountListUpdated";
    public static final String ACTION_SYNC_FINISHED =
            "me.pipi.deliveries.EXPRESS_SYNC_FINISHED";
    private static volatile ExpressRepository instance;

    private final Context context;
    private final ExpressDatabase helper;
    private final Object maintenanceLock = new Object();
    private long invalidationVersion;
    private static final class ChangeBatch {
        int depth;
        boolean invalidationPending;
        final HashSet<Long> firstSeenRows = new HashSet<>();
    }
    private final ThreadLocal<ChangeBatch> changeBatch =
            ThreadLocal.withInitial(ChangeBatch::new);
    private static final String MIGRATION_PREFS = "deliveries_repository_migrations";
    private static final String CANONICAL_MIGRATION = "canonical_v2";
    private static final String ICON_MIGRATION = "local_icons_v3";
    private static final String HIDDEN_ROW_CLEANUP = "hashed_deletions_v1";
    private static final String ROUTE_CREDENTIAL_MIGRATION = "route_credentials_v1";
    /**
     * 2026-09-05 晚一次性清空 v5_query / v6_list 两张 sidecar：老版本把行上的 feed 节点当「初始包」
     * 存进去，再跟按件详情增量合并，包里就混着 feed 那条（feed 增量与 query 从此独立）。
     */
    private static final String ACCOUNT_SIDECAR_PURGE = "account_sidecar_feed_split_v1";
    /** 详情页上一轮显示的包（粘性选包，用户定 2026-09-05 晚）：rowId + 运单号 → 槽名 / "feed"。 */
    private static final String DETAIL_SELECTION_PREFS = "express_detail_selection";
    private static volatile Map<String, String> detailSelections;
    private static final String LAST_RETENTION_PRUNE = "last_signed_prune_at";
    static final long RETENTION_PRUNE_INTERVAL_MS = 60L * 60L * 1000L;
    static final long PENDING_QUERY_RETRY_INTERVAL_MS = 30L * 60L * 1000L;
    static final long PENDING_QUERY_TTL_MS = 24L * 60L * 60L * 1000L;
    // 后台手动链每票 10 分钟一次，与 iOS/Pipi 各级 10 分钟冷却同值（用户定 2026-09-05）；
    // 前台（进详情 / 下拉）仍按 30 秒守门，用户手势不受这条冷却约束。
    static final long MANUAL_TIMELINE_POLL_INTERVAL_MS = 10L * 60L * 1000L;
    static final long MANUAL_TIMELINE_FAILURE_COOLDOWN_MS = 6L * 60L * 60L * 1000L;
    static final long MANUAL_TIMELINE_FOREGROUND_INTERVAL_MS = 30L * 1000L;
    static final long MANUAL_TIMELINE_ACTIVE_LEASE_MS = 2L * 60L * 1000L;
    private static final int PENDING_QUERY_BATCH_SIZE = 20;

    ExpressRepository(Context context) {
        this(context, new ExpressDatabase(context.getApplicationContext()));
    }

    ExpressRepository(Context context, ExpressDatabase helper) {
        loadDetailSelections(context);
        this.context = context.getApplicationContext();
        this.helper = helper;
    }

    private boolean retentionAnchorsInitialized;

    private synchronized SQLiteDatabase database() {
        SQLiteDatabase db = helper.getWritableDatabase();
        if (!retentionAnchorsInitialized) {
            // Reentrant projections during anchoring use the same transaction. A failed scan
            // remains retryable, and no later mutation may advance an unanchored legacy row.
            retentionAnchorsInitialized = true;
            try {
                initializeSignedRetentionAnchors();
            } catch (RuntimeException failure) {
                retentionAnchorsInitialized = false;
                throw failure;
            }
        }
        return db;
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
            changeBatch.get().depth++;
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
        SQLiteDatabase db = database();
        VisibleProjectionSidecars sidecars = visibleProjectionSidecars(db);
        Map<String, AutomaticOwnershipState> ownership = automaticOwnershipStates(db);
        try (Cursor cursor = db.query(
                ExpressDatabase.EXPRESS_TABLE, null,
                "canShow=1 AND isDeleted=0", null, null, null,
                "logisticsGmtModified DESC, _id DESC")) {
            while (cursor.moveToNext()) {
                ExpressItem raw = readRaw(cursor, sidecars.orderProjections);
                String normalized = ExpressSourcePolicy.normalizeWaybill(raw.displayWaybill());
                AutomaticOwnershipState owner = ownership.get(normalized);
                ExpressItem candidate = owner != null && owner.displayFrozen
                        && raw.rowId == owner.ownerRowId
                        ? projectFrozenTimelineAuthorities(raw, sidecars)
                        : projectTimelineAuthorities(raw, sidecars);
                if (owner != null && owner.ownerRowId > 0L
                        && candidate.rowId != owner.ownerRowId) continue;
                if (owner == null && !bindingSource.isEmpty()
                        && !ExpressSourcePolicy.belongsToBindingSource(
                        candidate, bindingSource)) continue;
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
            if (!preferences.getBoolean(HIDDEN_ROW_CLEANUP, false)) {
                cleanLegacyHiddenRows();
                preferences.edit().putBoolean(HIDDEN_ROW_CLEANUP, true).apply();
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
            if (!preferences.getBoolean(ACCOUNT_SIDECAR_PURGE, false)) {
                purgeAccountSidecars();
                preferences.edit().putBoolean(ACCOUNT_SIDECAR_PURGE, true).apply();
                changed = true;
            }
        }
        if (changed) emitInvalidation();
    }

    private static synchronized void loadDetailSelections(Context context) {
        if (detailSelections != null || context == null) return;
        Map<String, String> loaded = new ConcurrentHashMap<>();
        try {
            android.content.SharedPreferences preferences = context.getSharedPreferences(
                    DETAIL_SELECTION_PREFS, 0);
            android.content.SharedPreferences.Editor migration = null;
            for (Map.Entry<String, ?> entry : preferences.getAll().entrySet()) {
                if (entry.getValue() instanceof String) {
                    String original = (String) entry.getValue();
                    String canonical = TimelineSlot.normalize(original);
                    if (canonical.isEmpty()) {
                        if (migration == null) migration = preferences.edit();
                        migration.remove(entry.getKey());
                        continue;
                    }
                    loaded.put(entry.getKey(), canonical);
                    if (!original.equals(canonical)) {
                        if (migration == null) migration = preferences.edit();
                        migration.putString(entry.getKey(), canonical);
                    }
                }
            }
            if (migration != null) migration.apply();
        } catch (RuntimeException ignored) {
            // A corrupt preference file only loses the sticky choice, never the caches.
        }
        detailSelections = loaded;
    }

    private static String detailSelectionKey(ExpressItem item) {
        if (item == null) return "";
        return item.rowId + "\u0000"
                + ExpressSourcePolicy.normalizeWaybill(item.displayWaybill());
    }

    /** 上一轮详情页显示的包；没有记录时为空串（照常排序）。 */
    static String preferredDetailProvider(ExpressItem item) {
        Map<String, String> selections = detailSelections;
        if (selections == null || item == null) return "";
        String value = selections.get(detailSelectionKey(item));
        return value == null ? "" : value;
    }

    /**
     * 记住详情页这次显示的是哪个包（用户定 2026-09-05 晚：下一轮点进来默认还显示它）。
     * provider 用统一槽名，行自己的 feed 包记作 {@link ManualTimelineAuthorityPolicy#PREFERRED_FEED}。
     */
    public void rememberDetailSelection(ExpressItem item, String provider) {
        String key = detailSelectionKey(item);
        String value = provider == null ? "" : provider.trim();
        if (key.isEmpty() || value.isEmpty()) return;
        if (!ManualTimelineAuthorityPolicy.PREFERRED_FEED.equals(value)) {
            value = TimelineSlot.normalize(value);
            if (value.isEmpty()) return;
        }
        synchronized (ExpressRepository.class) {
            loadDetailSelections(context);
            Map<String, String> selections = detailSelections;
            if (selections == null || value.equals(selections.get(key))) return;
            selections.put(key, value);
            context.getSharedPreferences(DETAIL_SELECTION_PREFS, 0).edit()
                    .putString(key, value).apply();
        }
    }

    /** Drops every account query sidecar so the next detail fetch rebuilds it from the query alone. */
    private void purgeAccountSidecars() {
        synchronized (this) {
            SQLiteDatabase db = database();
            db.delete(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE, null, null);
            db.delete(ExpressDatabase.ACCOUNT_V6_TIMELINE_TABLE, null, null);
        }
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
                // Serialize deletion and cancellation with notification replay.
                synchronized (this) {
                    expired = pruneExpiredShipments(now);
                    for (ExpressItem item : expired) ExpressNotifications.cancel(context, item.rowId);
                }
            } catch (RuntimeException | Error failure) {
                preferences.edit().remove(LAST_RETENTION_PRUNE).apply();
                throw failure;
            }
        }
        if (!expired.isEmpty()) emitInvalidation();
    }

    static boolean isRetentionPruneDue(long previous, long now) {
        return previous <= 0L || now < previous
                || now - previous >= RETENTION_PRUNE_INTERVAL_MS;
    }

    /** Permanently removes rows already hidden by the terminal-state retention policy. */
    private ArrayList<ExpressItem> pruneExpiredShipments(long now) {
        LinkedHashMap<String, ExpressItem> candidates = new LinkedHashMap<>();
        // Timeline parsing is deliberately outside the write transaction. Every candidate is
        // re-read below so an
        // update between this scan and the transaction cannot be deleted from a stale snapshot.
        try (Cursor cursor = database().query(
                ExpressDatabase.EXPRESS_TABLE, null,
                "canShow=1 AND isDeleted=0", null, null, null, null)) {
            while (cursor.moveToNext()) {
                ExpressItem item = read(cursor);
                if (!ExpressVisibilityPolicy.shouldDelete(item, now)) continue;
                String normalized = ExpressSourcePolicy.normalizeWaybill(item.waybill);
                String key = normalized.isEmpty() ? "row:" + item.rowId : normalized;
                candidates.putIfAbsent(key, item);
            }
        }
        if (candidates.isEmpty()) return new ArrayList<>();
        ArrayList<ExpressItem> expired = new ArrayList<>();
        SQLiteDatabase db = database();
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
                        if (!ExpressVisibilityPolicy.shouldDelete(current, now)) {
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
        try (Cursor cursor = database().query(
                ExpressDatabase.EXPRESS_TABLE, null, "_id=?",
                new String[]{Long.toString(rowId)}, null, null, null, "1")) {
            return cursor.moveToFirst() ? read(cursor) : null;
        }
    }

    private ExpressItem findRaw(long rowId) {
        return findRaw(database(), rowId);
    }

    private ExpressItem findRaw(SQLiteDatabase db, long rowId) {
        try (Cursor cursor = db.query(
                ExpressDatabase.EXPRESS_TABLE, null, "_id=?",
                new String[]{Long.toString(rowId)}, null, null, null, "1")) {
            return cursor.moveToFirst() ? readRaw(cursor, OrderProjection.EMPTY) : null;
        }
    }

    /** Reads the stable owner row together with its current account-order display identity. */
    private ExpressItem findManualOwner(long rowId) {
        return findManualOwner(database(), rowId);
    }

    private ExpressItem findManualOwner(SQLiteDatabase db, long rowId) {
        try (Cursor cursor = db.query(
                ExpressDatabase.EXPRESS_TABLE, null, "_id=?",
                new String[]{Long.toString(rowId)}, null, null, null, "1")) {
            if (!cursor.moveToFirst()) return null;
            String stateOwner = text(cursor, "stateOwner");
            String ownerSource = ExpressSourcePolicy.source(stateOwner.isEmpty()
                    ? text(cursor, "fromCp") : stateOwner);
            OrderProjection projection = ExpressSourcePolicy.isAccountOrderOwner(ownerSource)
                    ? orderProjection(
                    db, text(cursor, "mailNo"),
                    ExpressSourcePolicy.bindingSourceForOwner(ownerSource))
                    : OrderProjection.EMPTY;
            return readRaw(cursor, projection);
        }
    }

    /** Finds automatic rows in the selected partition and user-created rows globally. */
    public synchronized ExpressItem findByWaybill(String waybill, String bindingSource) {
        ExpressItem raw = findRawByWaybill(waybill, bindingSource);
        return projectTimelineAuthorities(raw);
    }

    /** User-entered duplicates follow the same visibility window as the list. */
    public synchronized ExpressItem findVisibleByWaybill(String waybill, String bindingSource) {
        ExpressItem item = findByWaybill(waybill, bindingSource);
        return ExpressVisibilityPolicy.isExpired(item, System.currentTimeMillis()) ? null : item;
    }

    private ExpressItem findRawByWaybill(String waybill, String bindingSource) {
        return findRawByWaybill(database(), waybill, bindingSource);
    }

    private ExpressItem findRawByWaybill(
            SQLiteDatabase db, String waybill, String bindingSource) {
        String normalized = ExpressSourcePolicy.normalizeWaybill(waybill);
        if (normalized.isEmpty()) return null;
        AutomaticOwnershipState ownership = automaticOwnershipState(db, normalized);
        if (ownership != null && ownership.ownerRowId > 0L) {
            // 按投影运单号（如京东订单投影出的极兔单）查到归属行时，也要带上订单投影：
            // 输入框的承运商后缀、已在列表的判定都靠它，否则京东订单行会退成「京东购物」，
            // 跟列表行显示的承运商对不上（2026-09-05 Fold7 实测）。
            ExpressItem owner = findManualOwner(db, ownership.ownerRowId);
            if (owner != null) return owner;
        }
        String selectedSource = clean(bindingSource).toLowerCase(Locale.ROOT);
        try (Cursor cursor = db.query(
                ExpressDatabase.EXPRESS_TABLE, null,
                "(normalizedMailNo=? OR mailNo=?) AND isDeleted=0 AND canShow=1",
                new String[]{normalized, clean(waybill)},
                null, null, "_id ASC")) {
            ExpressItem best = null;
            while (cursor.moveToNext()) {
                ExpressItem candidate = readRaw(cursor);
                if (!selectedSource.isEmpty()
                        && !ExpressSourcePolicy.belongsToBindingSource(
                        candidate, selectedSource)) continue;
                if (best == null || winsCanonical(candidate, best)) best = candidate;
            }
            return best;
        }
    }

    /** Keeps an unbound account association scoped to its source until that phone is rebound. */
    public synchronized boolean hasUnboundPhoneAssociation(
            String waybill, String bindingSource) {
        String normalized = ExpressSourcePolicy.normalizeWaybill(waybill);
        if (normalized.isEmpty()) return false;
        return hasUnboundPhoneAssociation(
                database(), normalized, bindingSource);
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
        try (Cursor cursor = database().query(
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
        return timeline(ExpressDatabase.KUAIDI100_TIMELINE_TABLE, waybill, TimelineSlot.K100_H5);
    }

    /** v4 public sidecar; one complete provider timeline is retained independently. */
    public synchronized ExpressQueryResult v4Timeline(String waybill) {
        return timeline(ExpressDatabase.V4_TIMELINE_TABLE, waybill, TimelineSlot.V4_QUERY);
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
        String source = normalizeBindingSource(bindingSource);
        String table = "interface5".equals(source)
                ? ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE
                : ExpressDatabase.ACCOUNT_V6_TIMELINE_TABLE;
        ExpressQueryResult result = timeline(table, waybill, TimelineSlot.forBindingSource(source));
        return "interface5".equals(source) ? cleanJdQuery(result) : result;
    }

    /**
     * 接口 5 账号件缓存里的详情是否已完整：终态、有时间节点、有揽收。完整就不再按时间重拉
     * （用户定 2026-09-05，三端同一道门）——原来每 6 小时把全部已签收件再拉一遍按件详情，
     * 首页一刷新就重写这些行（Fold7 实测 13:57 一次 26 票）。
     */
    public synchronized boolean accountDetailComplete(ExpressItem item) {
        if (item == null || item.semantic == null || !item.semantic.terminal()) return false;
        // 菜鸟/顺丰这类行的按件详情直接写在行上（packageDyn），没有账号时间线 sidecar；
        // Fold7 15:30 实测六票已签收的菜鸟件仍被重拉，就是只看了 sidecar。
        ExpressQueryResult own = new ExpressQueryResult(
                item.waybill, item.courierCode, item.companyName, item.semantic,
                item.latestTime, item.latestDetail, item.tracksJson);
        if (Kuaidi100TimelinePolicy.hasTimedTracking(own)
                && Kuaidi100TimelinePolicy.hasPickupEvidence(own)) return true;
        ExpressQueryResult chosen = accountTimeline(item.displayWaybill(), "interface5");
        if (!Kuaidi100TimelinePolicy.hasTimedTracking(chosen)) {
            chosen = accountTimeline(item.waybill, "interface5");
        }
        return Kuaidi100TimelinePolicy.hasTimedTracking(chosen)
                && Kuaidi100TimelinePolicy.hasPickupEvidence(chosen);
    }

    public synchronized boolean hasAccountTimeline(String waybill, String bindingSource) {
        return Kuaidi100TimelinePolicy.hasRealTracking(
                accountTimeline(waybill, bindingSource));
    }

    private ExpressQueryResult timeline(String table, String waybill, String provider) {
        return timeline(database(), table, waybill, provider);
    }

    private static ExpressQueryResult timeline(
            SQLiteDatabase db, String table, String waybill, String provider) {
        String normalized = ExpressSourcePolicy.normalizeWaybill(waybill);
        if (normalized.isEmpty()) return null;
        try (Cursor cursor = db.query(
                table, null,
                "normalized_waybill=?", new String[]{normalized},
                null, null, null, "1")) {
            if (!cursor.moveToFirst()) return null;
            return timeline(cursor, provider);
        }
    }

    private static ExpressQueryResult timeline(Cursor cursor, String provider) {
        StatusSemantic semantic = StatusSemantic.fromStored(
                text(cursor, "status_code"), "");
        return new ExpressQueryResult(
                text(cursor, "waybill"),
                text(cursor, "courier_code"),
                text(cursor, "company_name"),
                semantic,
                number(cursor, "status_event_time"),
                text(cursor, "latest_time"),
                text(cursor, "latest_detail"),
                text(cursor, "tracks_json"), "", "", provider, "", "", "")
                .withManualStatusEvidence(text(cursor, "status_description"),
                        number(cursor, "structured_status") != 0L);
    }

    public ExpressQueryResult saveKuaidi100Timeline(ExpressQueryResult result) {
        if (result == null) return null;
        // query 包只进 sidecar；已投影订单的列表行（feed）不因此变化，也没有通知可发
        //（用户定 2026-09-05 晚：feed 增量与 query 独立）。
        synchronized (this) {
            return saveTimeline(ExpressDatabase.KUAIDI100_TIMELINE_TABLE, result);
        }
    }

    public synchronized ExpressQueryResult saveV4Timeline(ExpressQueryResult result) {
        return saveTimeline(ExpressDatabase.V4_TIMELINE_TABLE, result);
    }

    public ExpressQueryResult saveAccountTimeline(
            ExpressQueryResult result, String bindingSource) {
        if (result == null) return null;
        String source = normalizeBindingSource(bindingSource);
        String table = "interface5".equals(source)
                ? ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE
                : ExpressDatabase.ACCOUNT_V6_TIMELINE_TABLE;
        // Unscoped query writes preserve source history only. Home takeover requires the
        // owner and binding checks in saveInterface5Query.
        synchronized (this) {
            if ("interface5".equals(source)) result = cleanJdQuery(result);
            return saveTimeline(table, result);
        }
    }

    /** Persists a projected order lookup only in the sidecar owned by its actual query source. */
    public ExpressQueryResult saveProjectedOrderTimeline(
            ExpressQueryResult result, String bindingSource) {
        if (!Kuaidi100TimelinePolicy.hasTimedTracking(result)) return null;
        String selectedSource = normalizeBindingSource(bindingSource);
        String provider = TimelineSlot.normalize(result.timelineProvider);
        if (TimelineSlot.forBindingSource(selectedSource).equals(provider)) {
            return saveAccountTimeline(result, selectedSource);
        }
        if (TimelineSlot.K100_H5.equals(provider)) {
            return saveKuaidi100Timeline(result);
        }
        if (TimelineSlot.V4_QUERY.equals(provider)) {
            return saveV4Timeline(result);
        }
        return null;
    }

    /** 表就是槽：每张时间线表只装一个接口的包（用户定 2026-09-05）。 */
    private static String slotForTable(String table) {
        if (ExpressDatabase.V4_TIMELINE_TABLE.equals(table)) return TimelineSlot.V4_QUERY;
        if (ExpressDatabase.KUAIDI100_TIMELINE_TABLE.equals(table)) return TimelineSlot.K100_H5;
        if (ExpressDatabase.ACCOUNT_V6_TIMELINE_TABLE.equals(table)) return TimelineSlot.V6_LIST;
        return TimelineSlot.V5_QUERY;
    }

    private ExpressQueryResult saveTimeline(String table, ExpressQueryResult result) {
        return saveTimeline(table, result, null);
    }

    private ExpressQueryResult saveTimeline(String table, ExpressQueryResult result, OwnerAttribution owner) {
        if (result == null) return null;
        String normalized = ExpressSourcePolicy.normalizeWaybill(result.waybill);
        if (normalized.isEmpty()) return result;
        SQLiteDatabase db = database();
        db.beginTransaction();
        try {
            ExpressQueryResult cached = timeline(table, result.waybill, slotForTable(table));
            boolean accountQuery = ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE.equals(table);
            ExpressQueryResult merged = accountQuery
                    ? Kuaidi100TimelinePolicy.mergeManualProvider(cached, result)
                    : Kuaidi100TimelinePolicy.merge(cached, result);
            if (ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE.equals(table)) {
                merged = cleanJdQuery(merged);
            }
            ContentValues values = new ContentValues();
            values.put("normalized_waybill", normalized);
            values.put("waybill", merged.waybill);
            values.put("courier_code", merged.courierCode);
            values.put("company_name", merged.companyName);
            values.put("status_code", merged.semantic.storageCode);
            if (accountQuery) {
                values.put("status_event_time", merged.statusEventTime);
                values.put("structured_status", merged.structuredStatusEvidence ? 1 : 0);
                values.put("status_description", merged.statusDescription);
                values.put("owner_attribution", owner == null ? "" : owner.queryKey());
                // Legacy history stays intact but cannot donate fields to a newly proven owner.
                ExpressQueryResult previousPresentation = owner != null
                        && owner.equals(accountQueryOwner(db, result.waybill))
                        ? accountQueryPresentation(db, result.waybill) : null;
                values.put("owner_presentation", owner == null ? ""
                        : queryPresentationKey(previousPresentation, cleanJdQuery(result)));
            }
            values.put("latest_time", merged.latestTime);
            values.put("latest_detail", merged.latestDetail);
            values.put("tracks_json", merged.tracksJson);
            values.put("updated_at", System.currentTimeMillis());
            long inserted = db.insertWithOnConflict(
                    table, null, values, SQLiteDatabase.CONFLICT_REPLACE);
            if (inserted < 0L) {
                throw new IllegalStateException("Timeline persistence failed");
            }
            // 冻结只由 feed 自己的已签收触发（saveAutomaticObservation 的 nowFrozen）；query 包
            // 落库不碰行的显示状态（用户定 2026-09-05 晚：feed 增量与 query 独立）。
            db.setTransactionSuccessful();
            return merged;
        } finally {
            db.endTransaction();
        }
    }

    private ArrayList<ExpressItem> projectedOrderOwnersForTimeline(String waybill) {
        String normalized = ExpressSourcePolicy.normalizeWaybill(waybill);
        ArrayList<ExpressItem> owners = new ArrayList<>();
        if (normalized.isEmpty()) return owners;
        Set<Long> seen = new HashSet<>();
        String select = "SELECT e.*,p.display_waybill AS projection_display_waybill,"
                + "p.carrier_name AS projection_carrier_name,"
                + "p.tracks_json AS projection_tracks_json,"
                + "p.binding_source AS projection_binding_source FROM "
                + ExpressDatabase.ORDER_PROJECTION_TABLE + " p JOIN "
                + ExpressDatabase.EXPRESS_TABLE + " e ON ";
        String where = " WHERE p.normalized_display_waybill=? "
                + "AND e.canShow=1 AND e.isDeleted=0";
        try (Cursor cursor = database().rawQuery(
                select + "e.normalizedMailNo=p.normalized_source_id" + where,
                new String[]{normalized})) {
            collectProjectedOrderOwners(cursor, owners, seen);
        }
        // Canonical normalization is backfilled asynchronously after an upgrade. Preserve the
        // indexed normalized join above, then cover only not-yet-backfilled rows through the raw
        // identity index so a timeline save still publishes its projected owner immediately.
        try (Cursor cursor = database().rawQuery(
                select + "e.mailNo=p.source_id" + where
                        + " AND COALESCE(e.normalizedMailNo,'')=''",
                new String[]{normalized})) {
            collectProjectedOrderOwners(cursor, owners, seen);
        }
        return owners;
    }

    private void collectProjectedOrderOwners(
            Cursor cursor, ArrayList<ExpressItem> owners, Set<Long> seen) {
        while (cursor.moveToNext()) {
            OrderProjection projection = new OrderProjection(
                    text(cursor, "projection_display_waybill"),
                    text(cursor, "projection_carrier_name"),
                    text(cursor, "projection_tracks_json"));
            ExpressItem owner = readRaw(cursor, projection);
            String ownerSource = owner.stateOwner.isEmpty()
                    ? owner.source : owner.stateOwner;
            if (owner.isAccountOrder() && normalizeBindingSource(
                    text(cursor, "projection_binding_source")).equals(
                    ExpressSourcePolicy.bindingSourceForOwner(ownerSource))
                    && seen.add(owner.rowId)) {
                owners.add(owner);
            }
        }
    }

    /** Returns the one durable manual-query timeline selected for this exact owner row. */
    public synchronized ManualTimelineAuthorityPolicy.Candidate manualTimelineAuthority(
            ExpressItem owner) {
        if (owner == null) return null;
        ExpressItem current = findManualOwner(owner.rowId);
        if (!sameOwnerIdentity(current, owner)) return null;
        return manualTimelineAuthority(database(), current);
    }

    /** Atomically reserves one background refresh across concurrent worker executions. */
    public synchronized ManualTimelinePollClaim claimManualTimelinePoll(
            ExpressItem owner, long now) {
        return claimManualTimelinePoll(owner, now, false, false);
    }

    /**
     * Atomically reserves one foreground refresh. A user-forced refresh may bypass elapsed-time
     * cooldowns, but never an attempt whose durable lease is still active.
     */
    public synchronized ManualTimelinePollClaim claimForegroundManualTimelinePoll(
            ExpressItem owner, long now, boolean force) {
        return claimManualTimelinePoll(owner, now, true, force);
    }

    private ManualTimelinePollClaim claimManualTimelinePoll(
            ExpressItem owner, long now, boolean foreground, boolean force) {
        if (owner == null) return null;
        ExpressItem current = findManualOwner(owner.rowId);
        if (!sameOwnerIdentity(current, owner)) return null;
        SQLiteDatabase db = database();
        db.beginTransaction();
        try {
            ExpressItem locked = findManualOwner(db, owner.rowId);
            if (!sameOwnerIdentity(locked, current)) return null;
            ManualTimelineAuthorityPolicy.Candidate authority =
                    manualTimelineAuthority(db, locked);
            ManualTimelineRetryState retry = manualTimelineRetryState(db, locked);
            if (!manualTimelineActiveLeaseAvailable(retry, now)) return null;
            if (foreground && !force && !manualTimelineForegroundIntervalDue(
                    retry.lastAttempt, now)) {
                return null;
            }
            // Foreground cadence is owned by the short interval gate above. Background success
            // cadence and failure cooldown must not delay an explicit detail refresh.
            boolean due = foreground
                    ? manualTimelineForegroundPollDue(locked, authority)
                    : locked.manuallyAdded || !isAutomaticAccountOwner(
                            locked.stateOwner.isEmpty() ? locked.source : locked.stateOwner)
                            ? backgroundTimelineRefreshAllowed(locked, authority, now)
                            : manualTimelinePollDue(projectManualTimeline(locked), authority,
                                    retry.lastAttempt, now);
            if (!due) return null;
            String token = UUID.randomUUID().toString();
            persistManualTimelineClaim(db, locked, now, token);
            db.setTransactionSuccessful();
            return new ManualTimelinePollClaim(locked.rowId, token);
        } finally {
            db.endTransaction();
        }
    }

    private static void persistManualTimelineClaim(
            SQLiteDatabase db, ExpressItem owner, long now, String token) {
        ContentValues values = new ContentValues();
        values.put("owner_row_id", owner.rowId);
        values.put("normalized_waybill",
                ExpressSourcePolicy.normalizeWaybill(owner.displayWaybill()));
        values.put("binding_source", ExpressSourcePolicy.bindingSourceForOwner(
                owner.stateOwner.isEmpty() ? owner.source : owner.stateOwner));
        values.put("owner_fingerprint", manualTimelineOwnerFingerprint(owner));
        values.put("last_attempt_at", now);
        values.put("attempt_token", clean(token));
        values.put("active_until", saturatedAdd(now, MANUAL_TIMELINE_ACTIVE_LEASE_MS));
        long inserted = db.insertWithOnConflict(
                ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                null, values, SQLiteDatabase.CONFLICT_REPLACE);
        if (inserted < 0L) {
            throw new IllegalStateException("Manual timeline retry persistence failed");
        }
    }

    private boolean manualTimelinePollClaimMatches(SQLiteDatabase db, ManualTimelinePollClaim claim) {
        try (Cursor cursor = db.query(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                new String[]{"attempt_token", "active_until"}, "owner_row_id=?",
                new String[]{Long.toString(claim.ownerRowId)}, null, null, null)) {
            return cursor.moveToFirst() && claim.token.equals(cursor.getString(0))
                    && cursor.getLong(1) > System.currentTimeMillis();
        }
    }

    /** Releases only the lease acquired by this caller; stale completions cannot clear a newer one. */
    public synchronized void releaseManualTimelinePoll(ManualTimelinePollClaim claim) {
        if (claim == null || claim.ownerRowId <= 0L || claim.token.isEmpty()) return;
        ContentValues values = new ContentValues();
        values.put("attempt_token", "");
        values.put("active_until", 0L);
        database().update(
                ExpressDatabase.OWNER_MANUAL_RETRY_TABLE, values,
                "owner_row_id=? AND attempt_token=?",
                new String[]{Long.toString(claim.ownerRowId), claim.token});
    }

    static boolean manualTimelineForegroundIntervalDue(long lastAttempt, long now) {
        return lastAttempt <= 0L || now < lastAttempt
                || now - lastAttempt >= MANUAL_TIMELINE_FOREGROUND_INTERVAL_MS;
    }

    static boolean manualTimelineActiveLeaseAvailable(
            ManualTimelineRetryState retry, long now) {
        return retry == null || retry.token.isEmpty() || now < retry.lastAttempt
                || retry.activeUntil <= now;
    }

    static boolean manualTimelinePollDue(
            ExpressItem owner, ManualTimelineAuthorityPolicy.Candidate authority, long now) {
        return manualTimelinePollDue(owner, authority, 0L, now);
    }

    private static boolean manualTimelineForegroundPollDue(
            ExpressItem owner, ManualTimelineAuthorityPolicy.Candidate authority) {
        if (owner == null || owner.semantic == StatusSemantic.CANCELLED) return false;
        // The account-owned header does not adjudicate the selected manual package. A source may
        // report completion before the complete manual timeline is available, so only cancellation
        // blocks the first attempt. Once authority exists, its projected package owns termination.
        if (authority == null) return owner.semantic != StatusSemantic.CANCELLED;
        if (!ManualTimelineAuthorityPolicy.isAuthoritative(authority)) return false;
        if (owner.semantic == StatusSemantic.COMPLETED) {
            // Pickup alone cannot freeze history that ends before the owner's signature.
            ExpressQueryResult presented = ManualTimelineAuthorityPolicy.automaticPresentationResult(
                    authority.result, sourcePackage(owner), java.util.Collections.singletonList(authority));
            return !ManualTimelineAuthorityPolicy.detailTimelineComplete(presented,
                    Math.max(owner.statusEventTime, ExpressTimeline.parseTime(owner.latestTime)));
        }
        if (!ManualTimelineAuthorityPolicy.isEffectivelyComplete(authority)) return true;
        return !manualAuthorityTerminal(authority);
    }

    static boolean manualTimelinePollDue(
            ExpressItem owner, ManualTimelineAuthorityPolicy.Candidate authority,
            long lastAttempt, long now) {
        if (!automaticListQueryRequired(owner)
                || !backgroundTimelineRefreshAllowed(owner, authority, now)) return false;
        if (authority == null) {
            return owner.semantic != StatusSemantic.CANCELLED
                    && manualTimelineRetryDue(lastAttempt, 0L, now);
        }
        if (!ManualTimelineAuthorityPolicy.isAuthoritative(authority)
                || now < authority.successAt
                || now - authority.successAt < MANUAL_TIMELINE_POLL_INTERVAL_MS) return false;
        return manualTimelineRetryDue(lastAttempt, authority.successAt, now);
    }

    /** List queries supplement missing fields after the same-ticket cache is projected. */
    public static boolean automaticListQueryRequired(ExpressItem item) {
        if (item == null || item.manuallyAdded || clean(item.displayWaybill()).isEmpty()
                || item.isAccountOrder() && item.projectedWaybill.isEmpty()) return false;
        if (item.isShunFengSource()) return true;
        return isInterface5Automatic(item)
                && ExpressSourcePolicy.normalizeWaybill(item.displayWaybill()).length() >= 6
                && (item.semantic == StatusSemantic.UNKNOWN
                || !Kuaidi100TimelinePolicy.hasTimedTracking(sourcePackage(item)));
    }

    private static boolean isInterface5Automatic(ExpressItem item) {
        if (item == null || item.manuallyAdded) return false;
        String owner = item.stateOwner.isEmpty() ? item.source : item.stateOwner;
        return "INTERFACE5".equalsIgnoreCase(owner) || "I5-JD".equalsIgnoreCase(owner);
    }

    private static boolean manualAuthorityTerminal(
            ManualTimelineAuthorityPolicy.Candidate authority) {
        return ManualTimelineAuthorityPolicy.isEffectivelyComplete(authority)
                && authority.result != null
                && authority.result.structuredStatusEvidence
                && (authority.result.semantic == StatusSemantic.CANCELLED
                    || trustedCompletion(authority.result, System.currentTimeMillis()));
    }

    /** Completion freezes background work only while its source time remains trustworthy. */
    public static boolean backgroundTimelineRefreshAllowed(ExpressItem owner,
            ManualTimelineAuthorityPolicy.Candidate authority, long now) {
        return owner != null && owner.semantic != StatusSemantic.CANCELLED
                && !trustedCompletion(sourcePackage(owner), now)
                && !trustedCompletion(authority == null ? null : authority.result, now);
    }

    private static boolean trustedCompletion(ExpressQueryResult result, long now) {
        return ManualTimelineAuthorityPolicy.hasStructuredStatus(result)
                && result.semantic == StatusSemantic.COMPLETED
                && result.statusEventTime > 0L && result.statusEventTime <= now;
    }

    private static boolean manualTimelineRetryDue(
            long lastAttempt, long latestSuccess, long now) {
        if (lastAttempt <= 0L || lastAttempt <= latestSuccess || now < lastAttempt) return true;
        return now - lastAttempt >= MANUAL_TIMELINE_FAILURE_COOLDOWN_MS;
    }

    /**
     * Commits every provider package from one owner refresh through one durable boundary. A stale
     * owner snapshot is update-only: if the row was deleted or replaced while the network request
     * was in flight, no package from that request is written.
     */
    public synchronized ManualQueryOwnerClaim captureManualQueryOwner(
            ExpressItem expectedOwner) {
        if (expectedOwner == null) return null;
        SQLiteDatabase db = database();
        ExpressItem current = findManualOwner(db, expectedOwner.rowId);
        if (!sameOwnerIdentity(current, expectedOwner)) return null;
        OwnerAttribution attribution = currentOwnerAttribution(db, current);
        return attribution == null ? null : new ManualQueryOwnerClaim(current, attribution);
    }

    public synchronized boolean ownsManualQuery(
            ExpressItem expectedOwner, ManualQueryOwnerClaim claim) {
        if (expectedOwner == null) return false;
        SQLiteDatabase db = database();
        ExpressItem current = findManualOwner(db, expectedOwner.rowId);
        return sameOwnerIdentity(current, expectedOwner)
                && manualQueryOwnerClaimMatches(db, current, claim);
    }

    /** Route recovery cannot apply a delayed account response to feed or shipment state. */
    public boolean saveRecoveredOwnerRoute(ExpressItem expectedOwner,
            ManualQueryOwnerClaim claim, ExpressQueryResult result) {
        if (expectedOwner == null || result == null) return false;
        synchronized (this) {
            SQLiteDatabase db = database();
            db.beginTransaction();
            try {
                ExpressItem current = findManualOwner(db, expectedOwner.rowId);
                if (!sameOwnerIdentity(current, expectedOwner)
                        || !manualQueryOwnerClaimMatches(db, current, claim)
                        || current.manuallyAdded
                        || !current.sourceProvider.equals(result.sourceProvider)
                        || !ExpressSourcePolicy.normalizeWaybill(current.waybill).equals(
                                ExpressSourcePolicy.normalizeWaybill(result.waybill))) return false;
                String owner = current.stateOwner.isEmpty() ? current.source : current.stateOwner;
                String binding = ExpressSourcePolicy.bindingSourceForOwner(owner);
                String sourceInterface = "interface5".equals(binding) ? "v5" : "v6";
                if (!TimelineSlot.forBindingSource(binding).equals(
                            TimelineSlot.normalize(result.timelineProvider))
                        || !sourceInterface.equals(result.routeInterface)) return false;
                String route = preferNonEmpty(result.routeCredential, result.detailUrl);
                if (current.isCainiaoSource()) {
                    if (!CainiaoRoute.isLegacyCredentialedUrl(route)) return false;
                } else if (AutomaticOwnershipPolicy.isJingDongSource(current.sourceProvider)) {
                    if (!"interface5".equals(binding)) return false;
                    try {
                        java.net.URI uri = java.net.URI.create(route);
                        String host = clean(uri.getHost()).toLowerCase(Locale.ROOT);
                        if (!"https".equalsIgnoreCase(uri.getScheme())
                                || !("jd.com".equals(host) || host.endsWith(".jd.com"))) return false;
                    } catch (IllegalArgumentException malformed) { return false; }
                } else return false;
                if (CainiaoRoute.isToken(result.detailUrl)
                        && !sourceInterface.equals(CainiaoRoute.interfaceFromToken(result.detailUrl))) return false;
                EncryptedExpressFields.Result encrypted = EncryptedExpressFields.tryEncode(route);
                if (!encrypted.available) return false;
                ContentValues values = new ContentValues();
                values.put("moreInfoUrl", CainiaoRoute.token(sourceInterface));
                values.put("routeOwner", ExpressSourcePolicy.source(owner));
                values.put("routeInterface", sourceInterface);
                values.put("routeCredential", encrypted.value);
                if (db.update(ExpressDatabase.EXPRESS_TABLE, values, "_id=?",
                        new String[]{Long.toString(current.rowId)}) != 1) return false;
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
        }
        publishChange();
        return true;
    }

    ExpressItem saveOwnerManualQueryBatch(
            ExpressItem expectedOwner, List<? extends ManualQuerySuccess> successes,
            String phone, String bindingSource) {
        return commitManualQueryBatch(
                expectedOwner, null, null, successes, phone, bindingSource, true, false);
    }

    public ExpressItem saveOwnerManualQueryBatch(
            ExpressItem expectedOwner, ManualQueryOwnerClaim expectedOwnerClaim,
            List<? extends ManualQuerySuccess> successes,
            String phone, String bindingSource) {
        if (expectedOwner == null || expectedOwnerClaim == null) return expectedOwner;
        return commitManualQueryBatch(
                expectedOwner, expectedOwnerClaim, null, successes,
                phone, bindingSource, true, false);
    }

    /**
     * Commits a foreground/manual query round. A non-null owner remains an update-only identity
     * boundary; only a query that started without an owner may create the first manual row.
     */
    ExpressItem saveManualQueryBatch(
            ExpressItem expectedOwner, List<? extends ManualQuerySuccess> successes,
            String phone, String bindingSource) {
        return commitManualQueryBatch(
                expectedOwner, null, null, successes, phone, bindingSource, false, true);
    }

    public ExpressItem saveManualQueryBatch(
            ExpressItem expectedOwner, ManualQueryOwnerClaim expectedOwnerClaim,
            List<? extends ManualQuerySuccess> successes,
            String phone, String bindingSource) {
        if (expectedOwner != null && expectedOwnerClaim == null) return expectedOwner;
        return commitManualQueryBatch(
                expectedOwner, expectedOwnerClaim, null, successes,
                phone, bindingSource, false, true);
    }

    /** Promotes only the exact hidden-query claim that produced this provider batch. */
    public ExpressItem savePendingManualQueryBatch(
            PendingExpressQuery expectedPending,
            List<? extends ManualQuerySuccess> successes) {
        if (expectedPending == null) return null;
        return commitManualQueryBatch(
                null, null, expectedPending, successes, expectedPending.phone,
                expectedPending.bindingSource, false, true);
    }

    public ExpressItem saveClaimedManualQueryBatch(
            ExpressItem owner, ManualQueryOwnerClaim ownerClaim,
            List<? extends ManualQuerySuccess> successes, String phone, String bindingSource,
            boolean ownerOnly, ManualTimelinePollClaim pollClaim,
            ExpressQueryCancellation cancellation) {
        if (owner != null && ownerClaim == null) return null;
        return commitManualQueryBatch(owner, ownerClaim, null, successes,
                phone, bindingSource, ownerOnly, !ownerOnly, pollClaim, cancellation);
    }

    private ExpressItem commitManualQueryBatch(
            ExpressItem expectedOwner, ManualQueryOwnerClaim expectedOwnerClaim,
            PendingExpressQuery expectedPending,
            List<? extends ManualQuerySuccess> successes,
            String fallbackPhone, String bindingSource,
            boolean ownerOnly, boolean saveSharedTimelines) {
        return commitManualQueryBatch(expectedOwner, expectedOwnerClaim, expectedPending,
                successes, fallbackPhone, bindingSource, ownerOnly, saveSharedTimelines, null, null);
    }

    private ExpressItem commitManualQueryBatch(
            ExpressItem expectedOwner, ManualQueryOwnerClaim expectedOwnerClaim,
            PendingExpressQuery expectedPending,
            List<? extends ManualQuerySuccess> successes,
            String fallbackPhone, String bindingSource,
            boolean ownerOnly, boolean saveSharedTimelines,
            ManualTimelinePollClaim pollClaim, ExpressQueryCancellation cancellation) {
        ArrayList<ManualQueryWrite> writes = manualQueryWrites(
                successes, fallbackPhone, expectedPending);
        // 手动查完没进列表（Fold7 2026-09-05 实测）却弹了成功、开了预览：这里每一条不落库的分支都打一行，
        // 下次一眼看出是哪道门。
        if (writes.isEmpty()) {
            ExpressLog.manualCommitSkipped("no_timed_result", "", successes == null
                    ? 0 : successes.size());
            return expectedOwner;
        }
        String normalized = ExpressSourcePolicy.normalizeWaybill(writes.get(0).result.waybill);
        if (normalized.isEmpty()) {
            ExpressLog.manualCommitSkipped("empty_waybill", "", writes.size());
            return expectedOwner;
        }
        if (expectedPending != null && !normalized.equals(
                ExpressSourcePolicy.normalizeWaybill(expectedPending.waybill))) return null;
        String selectedBindingSource = normalizeBindingSource(bindingSource);
        for (ManualQueryWrite write : writes) {
            if (!normalized.equals(
                    ExpressSourcePolicy.normalizeWaybill(write.result.waybill))) {
                throw new IllegalArgumentException(
                        "manual query batch must contain one waybill");
            }
        }

        ExpressItem previous;
        ExpressItem current;
        synchronized (this) {
            SQLiteDatabase db = database();
            long ownerRowId;
            db.beginTransaction();
            try {
                if (cancellation != null && cancellation.isCancelled()) return null;
                if (pollClaim != null && !manualTimelinePollClaimMatches(db, pollClaim)) return null;
                if (expectedPending != null
                        && !pendingManualClaimMatches(db, expectedPending)) {
                    return findRawByWaybill(db, writes.get(0).result.waybill,
                            selectedBindingSource);
                }
                ExpressItem raw = expectedOwner == null
                        ? findRawByWaybill(
                                db, writes.get(0).result.waybill, selectedBindingSource)
                        : findManualOwner(db, expectedOwner.rowId);
                if (expectedOwner != null && !sameOwnerIdentity(raw, expectedOwner)) {
                    return raw;
                }
                if (expectedOwnerClaim != null
                        && !manualQueryOwnerClaimMatches(db, raw, expectedOwnerClaim)) {
                    return raw;
                }
                // A request that started without an owner may only create that first owner. If an
                // owner appeared while the request was in flight, it has no captured attribution.
                if (expectedOwner == null && raw != null) {
                    ExpressLog.manualCommitSkipped("owner_appeared", normalized, writes.size());
                    return raw;
                }
                if (raw != null && !normalized.equals(
                        ExpressSourcePolicy.normalizeWaybill(raw.displayWaybill()))) {
                    ExpressLog.manualCommitSkipped("owner_waybill_mismatch", normalized, writes.size());
                    return raw;
                }
                String rawOwner = raw == null ? ""
                        : raw.stateOwner.isEmpty() ? raw.source : raw.stateOwner;
                if (ownerOnly && (raw == null
                        || !(raw.manuallyAdded || isAutomaticAccountOwner(rawOwner)))) {
                    return raw;
                }
                String incomingOwner = manualOwnerSource(
                        writes.get(0).provider, selectedBindingSource);
                if (raw == null && expectedOwner != null) {
                    ExpressLog.manualCommitSkipped("expected_owner_gone", normalized, writes.size());
                    return null;
                }
                if (raw == null && !selectedBindingSource.equals(
                        ExpressSourcePolicy.bindingSourceForOwner(incomingOwner))) {
                    ExpressLog.manualCommitSkipped("binding_source_mismatch", normalized, writes.size());
                    return null;
                }
                if (raw != null) {
                    String ownerBindingSource = ExpressSourcePolicy.bindingSourceForOwner(rawOwner);
                    if (!selectedBindingSource.equals(ownerBindingSource)
                            && !raw.manuallyAdded) {
                        ExpressLog.manualCommitSkipped("automatic_owner_other_binding", normalized, writes.size());
                        return raw;
                    }
                }

                previous = projectManualTimeline(raw);
                if (raw == null) {
                    ManualQueryWrite first = null;
                    for (ManualQueryWrite write : writes) {
                        if (write.hasTimeline || !write.routeUrl.isEmpty()) { first = write; break; }
                    }
                    if (first == null) return null;
                    incomingOwner = manualOwnerSource(first.provider, selectedBindingSource);
                    ownerRowId = db.insertOrThrow(
                            ExpressDatabase.EXPRESS_TABLE, null,
                            newManualOwnerValues(
                                    first.result, first.phone, normalized, incomingOwner));
                    raw = findManualOwner(db, ownerRowId);
                } else {
                    ownerRowId = raw.rowId;
                    if (!raw.manuallyAdded && manualResultMarksOwnerManual(raw)) {
                        ContentValues promotion = new ContentValues();
                        promotion.put("data3", "manual");
                        if (raw.phone.isEmpty() && !clean(fallbackPhone).isEmpty()) {
                            promotion.put("subPhone", clean(fallbackPhone));
                        }
                        if (db.update(ExpressDatabase.EXPRESS_TABLE, promotion, "_id=?",
                                new String[]{Long.toString(ownerRowId)}) != 1) {
                            throw new IllegalStateException("Manual owner disappeared");
                        }
                        raw = findManualOwner(db, ownerRowId);
                    }
                }
                if (raw == null) {
                    throw new IllegalStateException("Manual owner persistence failed");
                }
                String ownerBindingSource = ExpressSourcePolicy.bindingSourceForOwner(
                        raw.stateOwner.isEmpty() ? raw.source : raw.stateOwner);
                boolean displayFrozen = isAutomaticDisplayFrozen(db, ownerRowId);
                for (ManualQueryWrite write : writes) {
                    if (isForeignManualPackage(raw, write.result)) continue;
                    if (!write.routeUrl.isEmpty()) {
                        OwnerAttribution attribution = currentOwnerAttribution(db, raw);
                        if (attribution != null) {
                            saveManualRoute(db, attribution, write);
                        }
                    }
                    if (!write.hasTimeline
                            && !ManualTimelineAuthorityPolicy.hasStructuredStatus(write.result)) continue;
                    if (write.result.carrierNormalization.present()) {
                        ContentValues normalization = new ContentValues();
                        putCarrierNormalization(normalization, write.result.carrierNormalization);
                        if (db.update(ExpressDatabase.EXPRESS_TABLE, normalization, "_id=?",
                                new String[]{Long.toString(ownerRowId)}) != 1) {
                            throw new IllegalStateException("Manual owner disappeared");
                        }
                    }
                    if (displayFrozen) continue;
                    ManualTimelineAuthorityPolicy.Candidate cached = manualTimelineCandidate(
                            db, raw, write.provider);
                    ManualTimelineAuthorityPolicy.Candidate refreshed =
                            new ManualTimelineAuthorityPolicy.Candidate(
                                    write.provider, write.result,
                                    write.successAt, write.complete);
                    ManualTimelineAuthorityPolicy.Candidate merged =
                            ManualTimelineAuthorityPolicy.mergeSameProvider(cached, refreshed);
                    if (merged == null) {
                        throw new IllegalStateException(
                                "Manual timeline is not authoritative");
                    }
                    long inserted = db.insertWithOnConflict(
                            ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null,
                            manualTimelineValues(
                                    raw, merged, write.phone, ownerBindingSource),
                            SQLiteDatabase.CONFLICT_REPLACE);
                    if (inserted < 0L) {
                        throw new IllegalStateException("Manual timeline persistence failed");
                    }
                    if (saveSharedTimelines
                            && (raw.manuallyAdded || !raw.usesSourceManualTakeover())) {
                        saveSharedManualTimeline(db, write);
                    }
                }
                if (expectedPending != null) {
                    int removed = db.delete(ExpressDatabase.KUAIDI100_PENDING_TABLE,
                            "normalized_waybill=? AND LOWER(binding_source)=?"
                                    + " AND created_at=? AND last_attempt_at=?",
                            new String[]{normalized, selectedBindingSource,
                                    Long.toString(expectedPending.createdAt),
                                    Long.toString(expectedPending.lastAttemptAt)});
                    if (removed != 1) {
                        throw new IllegalStateException("Pending manual claim changed");
                    }
                }
                current = find(ownerRowId);
                current = stageNotification(db, previous, current);
                if (pollClaim != null && !manualTimelinePollClaimMatches(db, pollClaim)) return null;
                if (cancellation == null) db.setTransactionSuccessful();
                else if (!cancellation.commitIfActive(db::setTransactionSuccessful)) return null;
            } finally {
                db.endTransaction();
            }
        }
        publishChange();
        return current;
    }

    private static ArrayList<ManualQueryWrite> manualQueryWrites(
            List<? extends ManualQuerySuccess> successes,
            String fallbackPhone, PendingExpressQuery pending) {
        ArrayList<ManualQueryWrite> writes = new ArrayList<>();
        if (successes == null) return writes;
        for (ManualQuerySuccess success : successes) {
            if (success == null || success.result == null) continue;
            String provider = TimelineSlot.normalize(success.provider);
            if (provider.isEmpty()) {
                provider = TimelineSlot.normalize(success.result.timelineProvider);
            }
            if (provider.isEmpty()) continue;
            boolean hasTimeline = Kuaidi100TimelinePolicy.hasTimedTracking(success.result);
            String routeUrl = ManualRoutePolicy.meizuKuaidi100Url(
                    provider, success.result);
            if (!hasTimeline && routeUrl.isEmpty()
                    && !ManualTimelineAuthorityPolicy.hasStructuredStatus(success.result)) continue;
            ExpressQueryResult result = manualResultForProvider(
                    success.result, provider, pending);
            String phone = result.phone.isEmpty() ? clean(fallbackPhone) : result.phone;
            writes.add(new ManualQueryWrite(
                    provider, result, phone,
                    Math.max(1L, success.successAt), success.complete,
                    hasTimeline, routeUrl));
        }
        return writes;
    }

    private static ExpressQueryResult manualResultForProvider(
            ExpressQueryResult result, String provider, PendingExpressQuery pending) {
        String waybill = result.waybill;
        String courierCode = result.courierCode;
        String companyName = result.companyName;
        String detailUrl = result.detailUrl;
        String routeInterface = result.routeInterface;
        String routeCredential = result.routeCredential;
        String phone = result.phone;
        if (pending != null) {
            waybill = preferNonEmpty(waybill, pending.waybill);
            courierCode = preferNonEmpty(courierCode, pending.courierCode);
            companyName = preferNonEmpty(companyName, pending.companyName);
            detailUrl = preferNonEmpty(pending.detailUrl, detailUrl);
            routeInterface = preferNonEmpty(pending.routeInterface, routeInterface);
            routeCredential = preferNonEmpty(pending.routeCredential, routeCredential);
            phone = preferNonEmpty(phone, pending.phone);
        }
        return new ExpressQueryResult(
                waybill, courierCode, companyName,
                result.semantic, result.statusEventTime,
                result.latestTime, result.latestDetail, result.tracksJson,
                detailUrl, phone, provider, routeInterface, routeCredential,
                result.sourceProvider, result.carrierNormalization)
                .withCarrierIdentityEvidence(result.carrierIdentityEvidence)
                .withManualStatusEvidence(
                        result.statusDescription, result.structuredStatusEvidence);
    }

    private static String manualOwnerSource(String provider, String bindingSource) {
        String slot = TimelineSlot.normalize(provider);
        if (TimelineSlot.V5_QUERY.equals(slot)) return ExpressSourcePolicy.SOURCE_INTERFACE5;
        if (TimelineSlot.V6_LIST.equals(slot)) return ExpressSourcePolicy.SOURCE_INTERFACE6;
        // 接口 5 账号下，v4_query 只是手动链的一级，不是这行的归属来源：Meizu 失败、只有 v4_query
        // 成功时，行仍归 I5-K100（跟 EMS 那票一样），否则 bindingSourceForOwner(V4)=interface6 会被
        // 当成绑定来源不符而整批丢弃——查完没进列表的第二个真因（Fold7 2026-09-05 17:27 实测）。
        if (TimelineSlot.V4_QUERY.equals(slot)) {
            return "interface5".equalsIgnoreCase(bindingSource == null ? "" : bindingSource.trim())
                    ? ExpressSourcePolicy.kuaidi100FallbackSource(bindingSource)
                    : ExpressSourcePolicy.SOURCE_V4;
        }
        return ExpressSourcePolicy.kuaidi100FallbackSource(bindingSource);
    }

    private static boolean pendingManualClaimMatches(
            SQLiteDatabase db, PendingExpressQuery expected) {
        String normalized = ExpressSourcePolicy.normalizeWaybill(expected.waybill);
        if (normalized.isEmpty()) return false;
        try (Cursor cursor = db.query(
                ExpressDatabase.KUAIDI100_PENDING_TABLE,
                new String[]{"created_at", "last_attempt_at"},
                "normalized_waybill=? AND LOWER(binding_source)=?",
                new String[]{normalized, normalizeBindingSource(expected.bindingSource)},
                null, null, null, "1")) {
            return cursor.moveToFirst()
                    && cursor.getLong(0) == expected.createdAt
                    && cursor.getLong(1) == expected.lastAttemptAt;
        }
    }

    private static boolean manualQueryOwnerClaimMatches(
            SQLiteDatabase db, ExpressItem current, ManualQueryOwnerClaim claim) {
        if (claim == null || !sameOwnerIdentity(current, claim.owner)) return false;
        OwnerAttribution attribution = currentOwnerAttribution(db, current);
        return claim.attribution.equals(attribution);
    }

    private static OwnerAttribution currentOwnerAttribution(
            SQLiteDatabase db, ExpressItem owner) {
        if (db == null || owner == null || owner.rowId <= 0L) return null;
        String normalized = ExpressSourcePolicy.normalizeWaybill(owner.displayWaybill());
        String rawOwner = owner.stateOwner.isEmpty() ? owner.source : owner.stateOwner;
        String ownerSource = ExpressSourcePolicy.source(rawOwner);
        String bindingSource = ExpressSourcePolicy.bindingSourceForOwner(ownerSource);
        if (normalized.isEmpty() || ownerSource.isEmpty() || bindingSource.isEmpty()) return null;
        String generation = "";
        if (!owner.manuallyAdded && isAutomaticAccountOwner(ownerSource)) {
            String automaticIdentity = automaticIdentity(db, owner.waybill, ownerSource);
            AutomaticOwnershipState state = automaticOwnershipState(db, automaticIdentity);
            String ownershipProvider =
                    AutomaticOwnershipPolicy.providerForPackageOwner(ownerSource);
            if (state == null || state.ownerRowId != owner.rowId
                    || !ownershipProvider.equals(state.ownerProvider)
                    || !isCurrentBindingGeneration(
                    db, state.ownerPhone, bindingSource,
                    state.ownerBindingGeneration)) return null;
            generation = state.ownerBindingGeneration;
        }
        return new OwnerAttribution(
                owner.rowId, normalized, ownerSource, owner.sourceProvider,
                bindingSource, generation);
    }

    private static void saveManualRoute(
            SQLiteDatabase db, OwnerAttribution attribution, ManualQueryWrite write) {
        String routeUrl = ManualRoutePolicy.safeKuaidi100Url(write.routeUrl);
        if (routeUrl.isEmpty() || !routeUrl.equals(write.routeUrl)
                || !TimelineSlot.V6_QUERY.equals(write.provider)) {
            throw new IllegalStateException("Manual route validation changed");
        }
        ContentValues values = new ContentValues();
        values.put("owner_row_id", attribution.ownerRowId);
        values.put("normalized_waybill", attribution.normalizedWaybill);
        values.put("owner_source", attribution.ownerSource);
        values.put("owner_source_provider", attribution.ownerSourceProvider);
        values.put("binding_source", attribution.bindingSource);
        values.put("binding_generation", attribution.bindingGeneration);
        values.put("provider", TimelineSlot.V6_QUERY);
        values.put("detail_url", routeUrl);
        values.put("success_at", write.successAt);
        if (db.insertWithOnConflict(
                ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE, null,
                values, SQLiteDatabase.CONFLICT_REPLACE) < 0L) {
            throw new IllegalStateException("Manual route persistence failed");
        }
    }

    private void saveSharedManualTimeline(SQLiteDatabase db, ManualQueryWrite write) {
        String table;
        if (TimelineSlot.V5_QUERY.equals(write.provider)) {
            table = ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE;
        } else if (TimelineSlot.V6_LIST.equals(write.provider)) {
            table = ExpressDatabase.ACCOUNT_V6_TIMELINE_TABLE;
        } else if (TimelineSlot.V4_QUERY.equals(write.provider)) {
            table = ExpressDatabase.V4_TIMELINE_TABLE;
        } else if (TimelineSlot.K100_H5.equals(write.provider)) {
            table = ExpressDatabase.KUAIDI100_TIMELINE_TABLE;
        } else {
            // Other adapters remain isolated in the owner/provider sidecar above. Sharing the
            // legacy K100 table would merge packages from different providers.
            return;
        }
        String normalized = ExpressSourcePolicy.normalizeWaybill(write.result.waybill);
        ExpressQueryResult merged = Kuaidi100TimelinePolicy.merge(
                timeline(db, table, write.result.waybill, write.provider), write.result);
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
        if (db.insertWithOnConflict(
                table, null, values, SQLiteDatabase.CONFLICT_REPLACE) < 0L) {
            throw new IllegalStateException("Timeline persistence failed");
        }
    }


    private static final class ManualQueryWrite {
        final String provider;
        final ExpressQueryResult result;
        final String phone;
        final long successAt;
        final boolean complete;
        final boolean hasTimeline;
        final String routeUrl;

        ManualQueryWrite(
                String provider, ExpressQueryResult result, String phone,
                long successAt, boolean complete,
                boolean hasTimeline, String routeUrl) {
            this.provider = TimelineSlot.normalize(provider);
            this.result = result;
            this.phone = phone;
            this.successAt = successAt;
            this.complete = complete;
            this.hasTimeline = hasTimeline;
            this.routeUrl = clean(routeUrl);
        }
    }

    public static final class ManualQueryOwnerClaim {
        private final ExpressItem owner;
        private final OwnerAttribution attribution;

        private ManualQueryOwnerClaim(
                ExpressItem owner, OwnerAttribution attribution) {
            this.owner = owner;
            this.attribution = attribution;
        }
    }

    private static String queryPresentationKey(ExpressQueryResult previous, ExpressQueryResult incoming) {
        ExpressTimeline.Track latest = latestTimedTrack(incoming);
        String time = latest == null ? "" : latest.time;
        String detail = latest == null ? "" : latest.detail;
        if (previous != null && ExpressSourcePolicy.parseEventTime(previous.latestTime)
                >= ExpressSourcePolicy.parseEventTime(time)) {
            time = previous.latestTime;
            detail = previous.latestDetail;
        }
        boolean status = incoming.structuredStatusEvidence && incoming.semantic != StatusSemantic.UNKNOWN
                && incoming.statusEventTime > 0L;
        ExpressQueryResult statusOwner = status ? incoming : previous;
        if (previous != null && previous.structuredStatusEvidence
                && (!status || previous.statusEventTime >= incoming.statusEventTime
                || previous.semantic.terminal() && !incoming.semantic.terminal())) statusOwner = previous;
        if (previous != null && status && previous.structuredStatusEvidence
                && previous.semantic == incoming.semantic
                && WorkerStatusProjection.priority(previous) != WorkerStatusProjection.priority(incoming)) {
            statusOwner = WorkerStatusProjection.priority(previous) > WorkerStatusProjection.priority(incoming)
                    ? previous : incoming;
        }
        if (AutomaticOwnershipPolicy.isJingDongSource(incoming.sourceProvider)
                && incoming.semantic == StatusSemantic.COMPLETED
                && previous != null && previous.semantic == StatusSemantic.COMPLETED
                && previous.structuredStatusEvidence && previous.statusEventTime > 0L
                && previous.statusEventTime <= System.currentTimeMillis()) statusOwner = previous;
        return new org.json.JSONArray(java.util.Arrays.asList(time, detail,
                statusOwner == null ? "" : statusOwner.semantic.storageCode,
                statusOwner == null ? 0L : statusOwner.statusEventTime,
                statusOwner != null && statusOwner.structuredStatusEvidence,
                statusOwner == null ? "" : statusOwner.statusDescription,
                statusOwner == null || statusOwner.workerStatus == null
                        ? org.json.JSONObject.NULL : statusOwner.workerStatus.toJson())).toString();
    }

    private static ExpressQueryResult queryPresentation(ExpressQueryResult query, String value) {
        if (query == null || value == null || value.isEmpty()) return null;
        try {
            org.json.JSONArray fields = new org.json.JSONArray(value);
            String time = fields.getString(0);
            String detail = fields.getString(1);
            String tracks = new org.json.JSONArray().put(new org.json.JSONObject()
                    .put("time", time).put("context", detail)).toString();
            return new ExpressQueryResult(query.waybill, query.courierCode, query.companyName,
                    StatusSemantic.fromStored(fields.getString(2), ""), fields.getLong(3),
                    time, detail, tracks, "", "", TimelineSlot.V5_QUERY, "", "", "")
                    .withManualStatusEvidence(fields.getString(5), fields.getBoolean(4))
                    .withWorkerStatus(WorkerStatusProjection.read(new org.json.JSONObject()
                            .put("normalizedStatus", fields.optJSONObject(6))));
        } catch (org.json.JSONException invalid) {
            return null;
        }
    }

    private static ExpressQueryResult accountQueryPresentation(SQLiteDatabase db, String waybill) {
        try (Cursor cursor = db.query(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE,
                null, "normalized_waybill=?", new String[]{ExpressSourcePolicy.normalizeWaybill(waybill)},
                null, null, null, "1")) {
            return cursor.moveToFirst() ? queryPresentation(timeline(cursor, TimelineSlot.V5_QUERY),
                    text(cursor, "owner_presentation")) : null;
        }
    }

    private static OwnerAttribution accountQueryOwner(SQLiteDatabase db, String waybill) {
        try (Cursor cursor = db.query(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE,
                new String[]{"owner_attribution"}, "normalized_waybill=?",
                new String[]{ExpressSourcePolicy.normalizeWaybill(waybill)}, null, null, null, "1")) {
            return cursor.moveToFirst() ? OwnerAttribution.fromQueryKey(cursor.getString(0)) : null;
        }
    }

    private static final class OwnerAttribution {
        final long ownerRowId;
        final String normalizedWaybill;
        final String ownerSource;
        final String ownerSourceProvider;
        final String bindingSource;
        final String bindingGeneration;

        OwnerAttribution(
                long ownerRowId, String normalizedWaybill,
                String ownerSource, String ownerSourceProvider,
                String bindingSource, String bindingGeneration) {
            this.ownerRowId = ownerRowId;
            this.normalizedWaybill = clean(normalizedWaybill);
            this.ownerSource = ExpressSourcePolicy.source(ownerSource);
            this.ownerSourceProvider = clean(ownerSourceProvider);
            this.bindingSource = normalizeBindingSource(bindingSource);
            this.bindingGeneration = clean(bindingGeneration);
        }

        String queryKey() {
            return new org.json.JSONArray(java.util.Arrays.asList(ownerRowId, normalizedWaybill,
                    ownerSource, ownerSourceProvider, bindingSource, bindingGeneration)).toString();
        }

        static OwnerAttribution fromQueryKey(String value) {
            if (value == null || value.isEmpty()) return null;
            try {
                org.json.JSONArray fields = new org.json.JSONArray(value);
                if (fields.length() != 6) return null;
                return new OwnerAttribution(fields.getLong(0), fields.getString(1), fields.getString(2),
                        fields.getString(3), fields.getString(4), fields.getString(5));
            } catch (org.json.JSONException invalid) {
                return null;
            }
        }

        @Override
        public boolean equals(Object other) {
            if (this == other) return true;
            if (!(other instanceof OwnerAttribution)) return false;
            OwnerAttribution that = (OwnerAttribution) other;
            return ownerRowId == that.ownerRowId
                    && normalizedWaybill.equals(that.normalizedWaybill)
                    && ownerSource.equals(that.ownerSource)
                    && ownerSourceProvider.equals(that.ownerSourceProvider)
                    && bindingSource.equals(that.bindingSource)
                    && bindingGeneration.equals(that.bindingGeneration);
        }

        @Override
        public int hashCode() {
            int result = Long.hashCode(ownerRowId);
            result = 31 * result + normalizedWaybill.hashCode();
            result = 31 * result + ownerSource.hashCode();
            result = 31 * result + ownerSourceProvider.hashCode();
            result = 31 * result + bindingSource.hashCode();
            return 31 * result + bindingGeneration.hashCode();
        }
    }

    /**
     * Persists one successful result from the shared manual-query chain without mutating the
     * account-owned row. The row id is the local owner boundary and intentionally ignores phone
     * changes made by a later account refresh.
     */
    public ExpressItem saveOwnerManualTimeline(
            ExpressItem expectedOwner, ExpressQueryResult result,
            String phone, String bindingSource) {
        return saveOwnerManualTimeline(
                expectedOwner, result, phone, bindingSource, System.currentTimeMillis());
    }

    public ExpressItem saveOwnerManualTimeline(
            ExpressItem expectedOwner, ExpressQueryResult result,
            String phone, String bindingSource, long successfulAt) {
        return saveOwnerManualTimeline(
                expectedOwner, result, phone, bindingSource, successfulAt,
                result != null && ManualTimelineAuthorityPolicy.completeByContract(
                        result.timelineProvider));
    }

    public ExpressItem saveOwnerManualTimeline(
            ExpressItem expectedOwner, ExpressQueryResult result,
            String phone, String bindingSource, long successfulAt, boolean complete) {
        if (expectedOwner == null || !Kuaidi100TimelinePolicy.hasTimedTracking(result)) {
            return expectedOwner;
        }
        String provider = TimelineSlot.normalize(result.timelineProvider);
        if (provider.isEmpty()) return expectedOwner;
        String normalized = ExpressSourcePolicy.normalizeWaybill(result.waybill);
        if (normalized.isEmpty()) return expectedOwner;
        ExpressItem previous;
        ExpressItem current;
        synchronized (this) {
            ExpressItem raw = findManualOwner(expectedOwner.rowId);
            String rawOwner = raw == null ? ""
                    : raw.stateOwner.isEmpty() ? raw.source : raw.stateOwner;
            if (!sameOwnerIdentity(raw, expectedOwner)
                    || !(raw.manuallyAdded || isAutomaticAccountOwner(rawOwner))
                    || !normalized.equals(
                    ExpressSourcePolicy.normalizeWaybill(raw.displayWaybill()))) {
                return expectedOwner;
            }
            String selectedBindingSource = normalizeBindingSource(bindingSource);
            String ownerBindingSource = ExpressSourcePolicy.bindingSourceForOwner(
                    raw.stateOwner.isEmpty() ? raw.source : raw.stateOwner);
            if (!selectedBindingSource.equals(ownerBindingSource) && !raw.manuallyAdded) {
                return expectedOwner;
            }
            previous = projectManualTimeline(raw);
            SQLiteDatabase db = database();
            db.beginTransaction();
            try {
                ExpressItem locked = findManualOwner(db, raw.rowId);
                if (!sameOwnerIdentity(locked, raw)) return expectedOwner;
                if (isForeignManualPackage(locked, result)) return expectedOwner;
                boolean displayFrozen = isAutomaticDisplayFrozen(db, locked.rowId);
                String routeUrl = ManualRoutePolicy.meizuKuaidi100Url(provider, result);
                OwnerAttribution routeAttribution = currentOwnerAttribution(db, locked);
                if (!routeUrl.isEmpty() && routeAttribution != null) {
                    saveManualRoute(db, routeAttribution, new ManualQueryWrite(
                            provider, result, preferNonEmpty(phone, locked.phone),
                            Math.max(1L, successfulAt), complete, true, routeUrl));
                }
                if (result.carrierNormalization.present()) {
                    ContentValues normalization = new ContentValues();
                    putCarrierNormalization(normalization, result.carrierNormalization);
                    if (db.update(ExpressDatabase.EXPRESS_TABLE, normalization, "_id=?",
                            new String[]{Long.toString(locked.rowId)}) != 1) {
                        return expectedOwner;
                    }
                    locked = findManualOwner(db, locked.rowId);
                }
                if (!displayFrozen) {
                    ManualTimelineAuthorityPolicy.Candidate cached = manualTimelineCandidate(
                            db, locked, provider);
                    long successAt = Math.max(1L, successfulAt);
                    ManualTimelineAuthorityPolicy.Candidate refreshed =
                            new ManualTimelineAuthorityPolicy.Candidate(
                                    provider, result, successAt, complete);
                    ManualTimelineAuthorityPolicy.Candidate merged =
                            ManualTimelineAuthorityPolicy.mergeSameProvider(cached, refreshed);
                    if (merged == null) return expectedOwner;
                    ContentValues values = manualTimelineValues(
                            locked, merged, preferNonEmpty(phone, locked.phone),
                            ownerBindingSource);
                    long inserted = db.insertWithOnConflict(
                            ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                            null, values, SQLiteDatabase.CONFLICT_REPLACE);
                    if (inserted < 0L) {
                        throw new IllegalStateException("Manual timeline persistence failed");
                    }
                }
                current = projectManualTimeline(findManualOwner(expectedOwner.rowId));
                current = stageNotification(db, previous, current);
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
        publishChange();
        return current;
    }

    private static ContentValues manualTimelineValues(
            ExpressItem owner, ManualTimelineAuthorityPolicy.Candidate candidate,
            String phone, String bindingSource) {
        ExpressQueryResult result = candidate.result;
        ContentValues values = new ContentValues();
        values.put("owner_row_id", owner.rowId);
        values.put("normalized_waybill",
                ExpressSourcePolicy.normalizeWaybill(owner.displayWaybill()));
        values.put("binding_source", bindingSource);
        values.put("provider", candidate.provider);
        values.put("waybill", result.waybill);
        values.put("courier_code", result.courierCode);
        values.put("company_name", result.companyName);
        values.put("status_code", result.semantic.storageCode);
        values.put("status_event_time", manualStatusEventTime(result));
        values.put("status_description", result.statusDescription);
        values.put("structured_status", result.structuredStatusEvidence ? 1 : 0);
        values.put("latest_time", result.latestTime);
        values.put("latest_detail", result.latestDetail);
        values.put("tracks_json", result.tracksJson);
        values.put("detail_url", result.detailUrl);
        values.put("phone", clean(phone));
        values.put("success_at", candidate.successAt);
        values.put("complete", candidate.complete ? 1 : 0);
        return values;
    }

    private ManualTimelineAuthorityPolicy.Candidate manualTimelineAuthority(
            SQLiteDatabase db, ExpressItem owner) {
        return ManualTimelineAuthorityPolicy.selectForOwner(
                eligibleManualCandidates(owner, manualTimelineCandidates(db, owner)),
                owner != null && owner.manuallyAdded);
    }

    /** Returns Meizu's presentation route without projecting it into the shipment owner. */
    public synchronized String meizuManualDetailUrl(ExpressItem expectedOwner) {
        if (expectedOwner == null) return "";
        ExpressItem current = findManualOwner(expectedOwner.rowId);
        if (!sameOwnerIdentity(current, expectedOwner)) return "";
        SQLiteDatabase db = database();
        OwnerAttribution currentAttribution = currentOwnerAttribution(db, current);
        if (currentAttribution == null) return "";
        try (Cursor cursor = db.query(
                ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE,
                new String[]{"owner_row_id", "normalized_waybill", "owner_source",
                        "owner_source_provider", "binding_source", "binding_generation",
                        "provider", "detail_url"},
                "owner_row_id=?",
                new String[]{Long.toString(current.rowId)},
                null, null, "success_at DESC")) {
            while (cursor.moveToNext()) {
                if (!TimelineSlot.V6_QUERY.equals(TimelineSlot.normalize(text(cursor, "provider")))) continue;
                OwnerAttribution stored = new OwnerAttribution(
                        number(cursor, "owner_row_id"), text(cursor, "normalized_waybill"),
                        text(cursor, "owner_source"), text(cursor, "owner_source_provider"),
                        text(cursor, "binding_source"), text(cursor, "binding_generation"));
                if (!currentAttribution.equals(stored)) continue;
                return ManualRoutePolicy.safeKuaidi100Url(text(cursor, "detail_url"));
            }
        }
        return "";
    }

    /** Returns one exact provider cache without exposing a mixed timeline package. */
    public synchronized ManualTimelineAuthorityPolicy.Candidate manualTimelineCandidate(
            ExpressItem expectedOwner, String provider) {
        if (expectedOwner == null) return null;
        ExpressItem current = findManualOwner(expectedOwner.rowId);
        if (!sameOwnerIdentity(current, expectedOwner)) return null;
        return manualTimelineCandidate(
                database(), current, TimelineSlot.normalize(provider));
    }

    /**
     * SF Home shares the detail package; structured status retains its existing source authority.
     *
     * Only already-eligible same-parcel caches may advance SF's coarse feed reference.
     * Other sources retain their own feed reference; selection never starts a query.
     */
    public synchronized ManualTimelineAuthorityPolicy.Candidate manualDetailTimelineAuthority(
            ExpressItem expectedOwner) {
        if (expectedOwner == null) return null;
        ExpressItem current = findManualOwner(expectedOwner.rowId);
        if (!sameOwnerIdentity(current, expectedOwner)) return null;
        SQLiteDatabase db = database();
        ExpressQueryResult query = null;
        long querySuccessAt = 1L;
        if (isInterface5Automatic(current)) {
            for (String identity : new String[]{current.displayWaybill(), current.waybill}) {
                try (Cursor cursor = db.query(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE, null,
                        "normalized_waybill=?", new String[]{ExpressSourcePolicy.normalizeWaybill(identity)},
                        null, null, null, "1")) {
                    if (!cursor.moveToFirst()) continue;
                    ExpressQueryResult candidate = cleanJdTimeline(
                            timeline(cursor, TimelineSlot.V5_QUERY), current);
                    if (!Kuaidi100TimelinePolicy.hasTimedTracking(candidate)) continue;
                    query = candidate;
                    querySuccessAt = Math.max(1L, number(cursor, "updated_at"));
                    break;
                }
            }
        }
        List<ManualTimelineAuthorityPolicy.Candidate> candidates = manualTimelineCandidates(db, current);
        ManualTimelineAuthorityPolicy.DetailDecision decision = selectDetailTimelineDecision(
                current, candidates, query, querySuccessAt);
        logDetailSelection(current, candidates, query, decision.candidate, decision.reason);
        return decision.candidate;
    }

    private void logDetailSelection(ExpressItem owner,
            List<ManualTimelineAuthorityPolicy.Candidate> stored, ExpressQueryResult query,
            ManualTimelineAuthorityPolicy.Candidate selected, String selectionReason) {
        if (!ExpressLog.hasScope()) {
            try (ExpressLog.Scope ignored = ExpressLog.scope(ExpressLog.newFlowId("detail"), "cache_read",
                    "interface5".equals(ExpressSourcePolicy.bindingSourceForOwner(owner.stateOwner)) ? "v5" : "v6")) {
                logDetailSelection(owner, stored, query, selected, selectionReason);
            }
            return;
        }
        String sourceProvider = ExpressLog.source(owner.sourceProvider, owner.manuallyAdded);
        String feedProvider = "interface5".equals(ExpressSourcePolicy.bindingSourceForOwner(
                owner.stateOwner.isEmpty() ? owner.source : owner.stateOwner)) ? "v5_list" : TimelineSlot.V6_LIST;
        ExpressQueryResult feed = sourcePackage(owner);
        ArrayList<ManualTimelineAuthorityPolicy.Candidate> candidates = new ArrayList<>();
        candidates.add(new ManualTimelineAuthorityPolicy.Candidate(feedProvider, feed, 1L, false));
        if (stored != null) candidates.addAll(stored);
        if (query != null) candidates.add(new ManualTimelineAuthorityPolicy.Candidate(TimelineSlot.V5_QUERY, query, 1L, false));
        List<ManualTimelineAuthorityPolicy.Candidate> eligible = eligibleManualCandidates(owner, stored);
        boolean cainiaoActive = cainiaoManualFallbackActivated(owner);
        boolean sfManual = owner.isShunFengSource() && eligible.stream().anyMatch(
                ManualTimelineAuthorityPolicy::isShunFengManualCandidate);
        int available = 0;
        long reference = Math.max(owner.statusEventTime, ExpressTimeline.parseTime(owner.latestTime));
        boolean accountPresentation = !owner.manuallyAdded && !owner.isShunFengSource();
        ExpressQueryResult accountStatus = accountPresentation ? accountStatusPresentation(owner, query) : null;
        if (accountPresentation) reference = accountHistoryReference(feed, candidates);
        for (ManualTimelineAuthorityPolicy.Candidate candidate : candidates) {
            if (candidate == null || candidate.result == null) continue;
            ExpressQueryResult result = candidate.result;
            ExpressQueryResult quality = accountPresentation
                    ? ManualTimelineAuthorityPolicy.automaticPresentationResult(result, accountStatus, candidates)
                    : ManualTimelineAuthorityPolicy.presentationResult(result, candidates);
            boolean usable = Kuaidi100TimelinePolicy.hasTimedTracking(result);
            available++;
            String gateReason = !usable ? "no_tracks"
                    : candidate == candidates.get(0) ? sfManual ? "sf_manual_authority"
                        : Kuaidi100TimelinePolicy.timedTrackCount(feed) < ManualTimelineAuthorityPolicy.SOURCE_TIMELINE_MIN_TRACKS
                            && !ManualTimelineAuthorityPolicy.detailTimelineComplete(quality, reference)
                            && (eligible.stream().anyMatch(value -> Kuaidi100TimelinePolicy.timedTrackCount(value.result)
                                    >= ManualTimelineAuthorityPolicy.SOURCE_TIMELINE_MIN_TRACKS)
                                || Kuaidi100TimelinePolicy.timedTrackCount(query) >= ManualTimelineAuthorityPolicy.SOURCE_TIMELINE_MIN_TRACKS)
                            ? "source_summary_only" : null
                    : sfManual && !ManualTimelineAuthorityPolicy.isShunFengManualCandidate(candidate)
                        ? "sf_manual_authority" : manualCandidateRejectionReason(owner, candidate, cainiaoActive);
            ExpressLog.write("detail.timeline.candidate", "stage", "detail_refresh", "trigger", "cache_read",
                    "sourceProvider", sourceProvider, "waybillTail", ExpressLog.tail(owner.displayWaybill()),
                    "carrierCode", owner.displayCourierCode(), "automatic", !owner.manuallyAdded,
                    "timelineProvider", candidate.provider, "level", candidate.provider,
                    "captureComplete", candidate.complete, "structuredStatus", result.structuredStatusEvidence,
                    "statusSemantic", result.semantic, "statusEventAtMs", result.statusEventTime,
                    "latestTrackAtMs", Kuaidi100TimelinePolicy.latestTimedEventMillis(result),
                    "latestEventAtMs", ManualTimelineAuthorityPolicy.latestEventTime(result),
                    "effectiveTrackCount", Kuaidi100TimelinePolicy.timedTrackCount(result),
                    "detailComplete", ManualTimelineAuthorityPolicy.detailTimelineComplete(quality, reference),
                    "incompleteReason", ManualTimelineAuthorityPolicy.detailTimelineIncompleteReason(quality, reference),
                    "hasPickup", Kuaidi100TimelinePolicy.hasPickupEvidence(result),
                    "candidateEligible", gateReason == null, "gateReason", gateReason,
                    "cainiaoFallbackActive", cainiaoActive,
                    "waybillMatches", ExpressSourcePolicy.normalizeWaybill(result.waybill).equals(
                            ExpressSourcePolicy.normalizeWaybill(owner.displayWaybill())),
                    "waybillMatchesOrder", owner.isAccountOrder() && ExpressSourcePolicy.normalizeWaybill(result.waybill).equals(
                            ExpressSourcePolicy.normalizeWaybill(owner.waybill)),
                    "earliestTrackAtMs", earliestTimedTrackAt(result),
                    "foreignAnchorAtMs", foreignPackageAnchorAt(owner),
                    "foreignPackage", isForeignManualPackage(owner, result),
                    "result", usable ? "available" : "empty");
        }
        ExpressQueryResult result = selected == null ? feed : selected.result;
        String provider = selected == null ? feedProvider : selected.provider;
        ManualTimelineAuthorityPolicy.Candidate statusPresentation = ManualTimelineAuthorityPolicy.selectForOwner(
                eligible, owner.manuallyAdded, preferredDetailProvider(owner));
        ManualTimelineAuthorityPolicy.Candidate status = statusPresentationAuthority(owner,
                selectStatusAuthority(owner, eligible, query, statusPresentation), statusPresentation);
        boolean borrowed = hasStructuredStatus(status)
                && (owner.manuallyAdded || owner.isShunFengSource() || owner.semantic == StatusSemantic.UNKNOWN)
                && !(owner.semantic.terminal() && !status.result.semantic.terminal());
        if (!owner.manuallyAdded && !owner.isShunFengSource() && query != null
                && ManualTimelineAuthorityPolicy.hasStructuredStatus(query)
                && query.statusEventTime > owner.statusEventTime
                && !(owner.semantic.terminal() && !query.semantic.terminal())) {
            status = new ManualTimelineAuthorityPolicy.Candidate(TimelineSlot.V5_QUERY, query, 1L, false);
            borrowed = true;
        }
        StatusSemantic semantic = borrowed ? status.result.semantic : owner.semantic;
        long statusAt = borrowed ? status.result.statusEventTime : owner.statusEventTime;
        ExpressQueryResult presented = result == null ? null : new ExpressQueryResult(result.waybill,
                result.courierCode, result.companyName, semantic, statusAt, result.latestTime,
                result.latestDetail, WorkerStatusProjection.attach(result.tracksJson,
                        borrowed ? status.result.workerStatus : WorkerStatusProjection.cached(owner.tracksJson)),
                result.detailUrl, result.phone, result.timelineProvider,
                result.routeInterface, result.routeCredential, result.sourceProvider, result.carrierNormalization)
                .withManualStatusEvidence(borrowed ? status.result.statusDescription : owner.statusDescription,
                        borrowed || result.structuredStatusEvidence);
        reference = owner.manuallyAdded ? 0L : Math.max(statusAt,
                owner.isShunFengSource() ? ManualTimelineAuthorityPolicy.latestEventTime(result) : reference);
        String incomplete = owner.isShunFengSource() && !semantic.terminal() ? "sf_active"
                : ManualTimelineAuthorityPolicy.detailTimelineIncompleteReason(presented, reference);
        boolean complete = incomplete == null;
        ExpressItem displayed = projectTimelineAuthorities(owner);
        String headlineProvider = displayed.latestDetail.equals(owner.latestDetail)
                && displayed.latestTime.equals(owner.latestTime) ? feedProvider
                : query != null && latestTimedTrack(query) != null
                    && displayed.latestDetail.equals(latestTimedTrack(query).detail)
                    && displayed.latestTime.equals(latestTimedTrack(query).time) ? TimelineSlot.V5_QUERY : provider;
        ExpressLog.write("detail.timeline.selected", "stage", "detail_refresh", "trigger", "cache_read",
                "sourceProvider", sourceProvider, "waybillTail", ExpressLog.tail(owner.displayWaybill()),
                "carrierCode", owner.displayCourierCode(), "automatic", !owner.manuallyAdded,
                "selected", result != null, "candidateCount", candidates.size(), "availableCandidateCount", available,
                "timelineProvider", provider, "detailTimelineProvider", provider, "historyProvider", provider,
                "headlineProvider", headlineProvider, "statusProvider", borrowed ? status.provider : feedProvider,
                "selectionReason", selectionReason,
                "effectiveTrackCount", Kuaidi100TimelinePolicy.timedTrackCount(result),
                "detailEffectiveTrackCount", Kuaidi100TimelinePolicy.timedTrackCount(result),
                "feedEventAtMs", Math.max(feed.statusEventTime, Kuaidi100TimelinePolicy.latestTimedEventMillis(feed)),
                "latestTrackAtMs", Kuaidi100TimelinePolicy.latestTimedEventMillis(result),
                "latestEventAtMs", Math.max(Kuaidi100TimelinePolicy.latestTimedEventMillis(result), statusAt),
                "statusEventAtMs", statusAt, "statusSemantic", semantic,
                "signedRetainedAtMs", owner.signedRetainedAt,
                "structuredStatus", borrowed || result != null && result.structuredStatusEvidence,
                "detailComplete", complete, "incompleteReason", incomplete,
                "result", complete ? "complete" : "partial");
    }

    private ManualTimelineAuthorityPolicy.Candidate selectDetailTimeline(
            ExpressItem current, List<ManualTimelineAuthorityPolicy.Candidate> stored,
            ExpressQueryResult query, long querySuccessAt) {
        return selectDetailTimelineDecision(current, stored, query, querySuccessAt).candidate;
    }

    private ManualTimelineAuthorityPolicy.DetailDecision selectDetailTimelineDecision(
            ExpressItem current, List<ManualTimelineAuthorityPolicy.Candidate> stored,
            ExpressQueryResult query, long querySuccessAt) {
        String preferred = preferredDetailProvider(current);
        ArrayList<ManualTimelineAuthorityPolicy.Candidate> candidates = new ArrayList<>();
        if (stored != null) candidates.addAll(stored);
        if (current.isShunFengSource()) {
            ArrayList<ManualTimelineAuthorityPolicy.Candidate> manuals = new ArrayList<>();
            long latestManualEvent = 0L;
            for (ManualTimelineAuthorityPolicy.Candidate candidate : candidates) {
                if (!ManualTimelineAuthorityPolicy.isShunFengManualCandidate(candidate)) continue;
                manuals.add(candidate);
                latestManualEvent = Math.max(latestManualEvent,
                        ManualTimelineAuthorityPolicy.latestEventTime(candidate.result));
            }
            ManualTimelineAuthorityPolicy.DetailDecision manual =
                    ManualTimelineAuthorityPolicy.selectDetailDecision(manuals, latestManualEvent, preferred);
            if (manual.candidate != null) return new ManualTimelineAuthorityPolicy.DetailDecision(manual.candidate,
                    "only_eligible_history".equals(manual.reason) ? "sf_manual_history" : manual.reason);
            candidates.removeIf(candidate -> candidate == null
                    || !TimelineSlot.isAccount(candidate.provider)
                    && !TimelineSlot.isAutomaticH5(candidate.provider));
        }
        if (isInterface5Automatic(current) && Kuaidi100TimelinePolicy.hasTimedTracking(query)) {
            candidates.add(new ManualTimelineAuthorityPolicy.Candidate(TimelineSlot.V5_QUERY,
                    cleanJdTimeline(query, current), querySuccessAt, true));
        }
        candidates = eligibleManualCandidates(current, candidates);
        ExpressQueryResult source = sourcePackage(current);
        long reference = Kuaidi100TimelinePolicy.latestTimedEventMillis(source);
        if (current.isShunFengSource()) {
            for (ManualTimelineAuthorityPolicy.Candidate candidate : candidates) {
                if (ManualTimelineAuthorityPolicy.isAuthoritative(candidate)) {
                    reference = Math.max(reference,
                            Kuaidi100TimelinePolicy.latestTimedEventMillis(candidate.result));
                }
            }
        }
        if (!current.manuallyAdded && !current.isShunFengSource()) {
            return ManualTimelineAuthorityPolicy.selectAutomaticDetailDecision(candidates, source,
                    accountStatusPresentation(current, query), accountHistoryReference(source, candidates), preferred);
        }
        ManualTimelineAuthorityPolicy.DetailDecision selected =
                ManualTimelineAuthorityPolicy.selectDetailDecision(candidates, reference, preferred);
        ManualTimelineAuthorityPolicy.DetailDecision result = ManualTimelineAuthorityPolicy.selectOverSource(
                selected.candidate, source, preferred, reference);
        return result.candidate != null && "only_eligible_history".equals(result.reason)
                ? selected : result;
    }

    private static long accountHistoryReference(ExpressQueryResult source,
            List<ManualTimelineAuthorityPolicy.Candidate> candidates) {
        long reference = ManualTimelineAuthorityPolicy.latestEventTime(source);
        if (source != null) reference = Math.max(reference, source.statusEventTime);
        for (ManualTimelineAuthorityPolicy.Candidate candidate : candidates) {
            if (ManualTimelineAuthorityPolicy.isAuthoritative(candidate) && TimelineSlot.isAccount(candidate.provider)) {
                reference = Math.max(reference, ManualTimelineAuthorityPolicy.latestEventTime(candidate.result));
            }
        }
        return reference;
    }

    private ArrayList<ManualTimelineAuthorityPolicy.Candidate> eligibleManualCandidates(
            ExpressItem owner, List<ManualTimelineAuthorityPolicy.Candidate> candidates) {
        ArrayList<ManualTimelineAuthorityPolicy.Candidate> eligible = new ArrayList<>();
        boolean active = cainiaoManualFallbackActivated(owner);
        if (candidates != null) for (ManualTimelineAuthorityPolicy.Candidate candidate : candidates) {
            if (manualCandidateRejectionReason(owner, candidate, active) == null) eligible.add(candidate);
        }
        return eligible;
    }

    /** The same source boundary governs history, borrowed status and candidate diagnostics. */
    static String manualCandidateRejectionReason(ExpressItem owner,
            ManualTimelineAuthorityPolicy.Candidate candidate, boolean cainiaoFallbackActive) {
        if (candidate == null || candidate.result == null) return "no_tracks";
        if (isForeignManualPackage(owner, candidate.result)) return "foreign_package";
        if (!ManualTimelineAuthorityPolicy.isAuthoritative(candidate)
                && !ManualTimelineAuthorityPolicy.hasStructuredStatus(candidate)) return "provider_not_qualified";
        String provider = TimelineSlot.normalize(candidate.provider);
        if (TimelineSlot.V5_QUERY.equals(provider)
                && !ExpressSourcePolicy.normalizeWaybill(candidate.result.waybill).equals(
                        ExpressSourcePolicy.normalizeWaybill(owner.displayWaybill()))) return "waybill_mismatch";
        if (owner.isAccountOrder() && owner.projectedWaybill.isEmpty()
                && !TimelineSlot.V5_QUERY.equals(provider)) return "unprojected_order";
        if (cainiaoAutomaticNeedsH5Supplement(owner) && !cainiaoFallbackActive) {
            return TimelineSlot.CN_H5.equals(provider) || TimelineSlot.V5_QUERY.equals(provider)
                    ? null : "cainiao_h5_required";
        }
        if (TimelineSlot.JD_H5.equals(provider)
                && !"JingDong".equalsIgnoreCase(owner.sourceProvider)) return "source_policy";
        return null;
    }

    private static ExpressQueryResult accountStatusPresentation(ExpressItem owner, ExpressQueryResult query) {
        ExpressQueryResult source = sourcePackage(owner);
        ExpressItem presented = restoreAccountActivity(owner, query, true);
        return new ExpressQueryResult(source.waybill, source.courierCode, source.companyName,
                presented.semantic, presented.statusEventTime, source.latestTime, source.latestDetail,
                WorkerStatusProjection.attach(source.tracksJson, WorkerStatusProjection.cached(presented.tracksJson)),
                source.detailUrl, source.phone, source.timelineProvider, source.routeInterface,
                source.routeCredential, source.sourceProvider)
                .withManualStatusEvidence(presented.statusDescription, presented.semantic != StatusSemantic.UNKNOWN);
    }

    public synchronized ExpressQueryResult automaticSourceTimeline(ExpressItem expectedOwner) {
        ExpressItem current = expectedOwner == null ? null : findManualOwner(expectedOwner.rowId);
        return sameOwnerIdentity(current, expectedOwner) ? sourcePackage(current) : null;
    }

    static boolean cainiaoAutomaticNeedsH5Supplement(ExpressItem owner) {
        ExpressQueryResult source = sourcePackage(owner);
        return owner != null && !owner.manuallyAdded && owner.isCainiaoSource()
                && source != null && source.semantic != StatusSemantic.UNKNOWN
                && !Kuaidi100TimelinePolicy.hasPickupEvidence(source);
    }

    /** Called after a requested Cainiao H5 attempt failed to reach pickup, before manual work. */
    public synchronized boolean activateCainiaoManualFallback(
            ExpressItem expectedOwner, ManualQueryOwnerClaim claim) {
        if (expectedOwner == null) return false;
        SQLiteDatabase db = database();
        db.beginTransaction();
        try {
            ExpressItem current = findManualOwner(db, expectedOwner.rowId);
            if (!sameOwnerIdentity(current, expectedOwner)
                    || !manualQueryOwnerClaimMatches(db, current, claim)
                    || !cainiaoAutomaticNeedsH5Supplement(current)) return false;
            OwnerAttribution attribution = currentOwnerAttribution(db, current);
            if (attribution == null) return false;
            ContentValues values = new ContentValues();
            values.put("cainiaoH5FallbackActivatedAtMs", Math.max(1L, System.currentTimeMillis()));
            values.put("cainiaoH5FallbackOwner", attribution.queryKey());
            if (db.update(ExpressDatabase.EXPRESS_TABLE, values, "_id=?",
                    new String[]{Long.toString(current.rowId)}) != 1) return false;
            db.setTransactionSuccessful();
            return true;
        } finally { db.endTransaction(); }
    }

    public synchronized boolean cainiaoManualFallbackActivated(ExpressItem owner) {
        if (!cainiaoAutomaticNeedsH5Supplement(owner)) return false;
        SQLiteDatabase db = database();
        OwnerAttribution attribution = currentOwnerAttribution(db, owner);
        if (attribution == null) return false;
        try (Cursor cursor = db.query(ExpressDatabase.EXPRESS_TABLE,
                new String[]{"cainiaoH5FallbackActivatedAtMs", "cainiaoH5FallbackOwner"},
                "_id=?", new String[]{Long.toString(owner.rowId)}, null, null, null)) {
            return cursor.moveToFirst() && cursor.getLong(0) > 0L
                    && attribution.queryKey().equals(cursor.getString(1));
        }
    }

    /** Automatic H5 enriches detail only; projection and its single package commit together. */
    public boolean saveAutomaticDetailTimeline(ExpressItem expectedOwner,
            ManualQueryOwnerClaim claim, ExpressQueryResult result, boolean complete) {
        return saveAutomaticDetailTimeline(expectedOwner, claim, result, complete, null);
    }

    public boolean saveAutomaticDetailTimeline(ExpressItem expectedOwner,
            ManualQueryOwnerClaim claim, ExpressQueryResult result, boolean complete,
            ExpressQueryCancellation cancellation) {
        if (expectedOwner == null || result == null
                || !TimelineSlot.isAutomaticH5(result.timelineProvider)) return false;
        boolean changed = false;
        synchronized (this) {
            SQLiteDatabase db = database();
            db.beginTransaction();
            try {
                if (cancellation != null && cancellation.isCancelled()) return false;
                ExpressItem current = findManualOwner(db, expectedOwner.rowId);
                if (!sameOwnerIdentity(current, expectedOwner)
                        || !manualQueryOwnerClaimMatches(db, current, claim)
                        || current.manuallyAdded) return false;
                String bindingSource = ExpressSourcePolicy.bindingSourceForOwner(
                        current.stateOwner.isEmpty() ? current.source : current.stateOwner);
                if (!"interface5".equals(bindingSource) && !current.isCainiaoSource()) return false;
                String expectedProvider = current.isCainiaoSource() ? TimelineSlot.CN_H5
                        : "JingDong".equalsIgnoreCase(current.sourceProvider) ? TimelineSlot.JD_H5 : "";
                if (!expectedProvider.equals(result.timelineProvider)) return false;
                String normalized = ExpressSourcePolicy.normalizeWaybill(result.waybill);
                if (current.isAccountOrder() && current.projectedWaybill.isEmpty()) {
                    if (normalized.equals(ExpressSourcePolicy.normalizeWaybill(current.waybill))
                            || !saveOrderProjection(current, "interface5", result.waybill,
                                    result.companyName, false)) return false;
                    current = findManualOwner(db, current.rowId);
                    changed = true;
                }
                if (!normalized.equals(ExpressSourcePolicy.normalizeWaybill(current.displayWaybill()))) return false;
                result = cleanJdTimeline(result, current);
                if (isForeignManualPackage(current, result)) return false;
                boolean cainiaoReachedPickup = false;
                // Partial JD captures may resolve identity, but only a proven complete response
                // enters its durable incremental slot. CN keeps any valid timed response.
                if (Kuaidi100TimelinePolicy.hasTimedTracking(result)
                        && (!TimelineSlot.JD_H5.equals(result.timelineProvider) || complete)) {
                    ManualTimelineAuthorityPolicy.Candidate merged = ManualTimelineAuthorityPolicy.mergeSameProvider(
                            manualTimelineCandidate(db, current, result.timelineProvider),
                            new ManualTimelineAuthorityPolicy.Candidate(result.timelineProvider,
                                    result, System.currentTimeMillis(), complete));
                    if (merged == null) return false;
                    cainiaoReachedPickup = TimelineSlot.CN_H5.equals(result.timelineProvider)
                            && Kuaidi100TimelinePolicy.hasPickupEvidence(merged.result);
                    long inserted = db.insertWithOnConflict(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                            null, manualTimelineValues(current, merged, current.phone, bindingSource),
                            SQLiteDatabase.CONFLICT_REPLACE);
                    if (inserted < 0L) throw new IllegalStateException("Automatic detail persistence failed");
                    changed = true;
                }
                if (cainiaoReachedPickup) {
                    ContentValues values = new ContentValues();
                    values.put("cainiaoH5FallbackActivatedAtMs", 0L);
                    values.put("cainiaoH5FallbackOwner", "");
                    db.update(ExpressDatabase.EXPRESS_TABLE, values, "_id=?",
                            new String[]{Long.toString(current.rowId)});
                }
                if (cancellation == null) db.setTransactionSuccessful();
                else if (!cancellation.commitIfActive(db::setTransactionSuccessful)) return false;
            } finally { db.endTransaction(); }
        }
        if (changed) publishChange();
        return true;
    }

    private static ArrayList<ManualTimelineAuthorityPolicy.Candidate>
            manualTimelineCandidates(SQLiteDatabase db, ExpressItem owner) {
        ArrayList<ManualTimelineAuthorityPolicy.Candidate> candidates = new ArrayList<>();
        if (db == null || owner == null) return candidates;
        try (Cursor cursor = db.query(
                ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null,
                "owner_row_id=? AND normalized_waybill=? AND LOWER(binding_source)=?",
                new String[]{Long.toString(owner.rowId),
                        ExpressSourcePolicy.normalizeWaybill(owner.displayWaybill()),
                        ExpressSourcePolicy.bindingSourceForOwner(
                                owner.stateOwner.isEmpty() ? owner.source : owner.stateOwner)},
                null, null, null)) {
            while (cursor.moveToNext()) {
                candidates.add(cleanJdCandidate(manualTimelineCandidate(cursor), owner));
            }
        }
        return candidates;
    }

    private static ManualTimelineRetryState manualTimelineRetryState(
            SQLiteDatabase db, ExpressItem owner) {
        if (db == null || owner == null) return ManualTimelineRetryState.EMPTY;
        try (Cursor cursor = db.query(
                ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                new String[]{"last_attempt_at", "owner_fingerprint",
                        "attempt_token", "active_until"},
                "owner_row_id=? AND normalized_waybill=? AND LOWER(binding_source)=?",
                new String[]{Long.toString(owner.rowId),
                        ExpressSourcePolicy.normalizeWaybill(owner.displayWaybill()),
                        ExpressSourcePolicy.bindingSourceForOwner(
                                owner.stateOwner.isEmpty() ? owner.source : owner.stateOwner)},
                null, null, null, "1")) {
            if (!cursor.moveToFirst()) return ManualTimelineRetryState.EMPTY;
            if (!manualTimelineOwnerFingerprint(owner).equals(
                    text(cursor, "owner_fingerprint"))) {
                return ManualTimelineRetryState.EMPTY;
            }
            return new ManualTimelineRetryState(
                    number(cursor, "last_attempt_at"),
                    text(cursor, "attempt_token"),
                    number(cursor, "active_until"));
        }
    }

    private static long saturatedAdd(long value, long delta) {
        if (delta <= 0L) return value;
        return value > Long.MAX_VALUE - delta ? Long.MAX_VALUE : value + delta;
    }

    /** Opaque ownership token for one durable manual-timeline network attempt. */
    public static final class ManualTimelinePollClaim {
        private final long ownerRowId;
        private final String token;

        private ManualTimelinePollClaim(long ownerRowId, String token) {
            this.ownerRowId = ownerRowId;
            this.token = clean(token);
        }
    }

    static final class ManualTimelineRetryState {
        static final ManualTimelineRetryState EMPTY =
                new ManualTimelineRetryState(0L, "", 0L);
        final long lastAttempt;
        final String token;
        final long activeUntil;

        ManualTimelineRetryState(long lastAttempt, String token, long activeUntil) {
            this.lastAttempt = lastAttempt;
            this.token = clean(token);
            this.activeUntil = activeUntil;
        }
    }

    private static String manualTimelineOwnerFingerprint(ExpressItem owner) {
        if (owner == null) return "";
        String stateOwner = owner.stateOwner.isEmpty() ? owner.source : owner.stateOwner;
        return ExpressSourcePolicy.source(stateOwner) + "\n" + owner.sourceProvider
                + "\n" + owner.courierCode.toUpperCase(Locale.ROOT);
    }

    private ManualTimelineAuthorityPolicy.Candidate manualTimelineCandidate(
            SQLiteDatabase db, ExpressItem owner, String provider) {
        if (db == null || owner == null || clean(provider).isEmpty()) return null;
        ManualTimelineAuthorityPolicy.Candidate merged = null;
        try (Cursor cursor = db.query(
                ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null,
                "owner_row_id=? AND normalized_waybill=?",
                new String[]{Long.toString(owner.rowId),
                        ExpressSourcePolicy.normalizeWaybill(owner.displayWaybill())},
                null, null, "success_at ASC")) {
            while (cursor.moveToNext()) {
                if (!provider.equals(TimelineSlot.normalize(text(cursor, "provider")))) continue;
                // Legacy aliases belong to this same provider; retain their accumulated history.
                merged = ManualTimelineAuthorityPolicy.mergeSameProvider(merged,
                        cleanJdCandidate(manualTimelineCandidate(cursor), owner));
            }
        }
        return merged;
    }

    private static ManualTimelineAuthorityPolicy.Candidate manualTimelineCandidate(
            Cursor cursor) {
        String provider = TimelineSlot.normalize(text(cursor, "provider"));
        ExpressQueryResult result = new ExpressQueryResult(
                text(cursor, "waybill"), text(cursor, "courier_code"),
                text(cursor, "company_name"),
                StatusSemantic.fromStored(text(cursor, "status_code"), ""),
                number(cursor, "status_event_time"),
                text(cursor, "latest_time"), text(cursor, "latest_detail"),
                text(cursor, "tracks_json"), text(cursor, "detail_url"),
                text(cursor, "phone"), provider,
                "", "", "")
                .withManualStatusEvidence(
                        text(cursor, "status_description"),
                        number(cursor, "structured_status") != 0L);
        return sanitizeManualTimelineCandidate(new ManualTimelineAuthorityPolicy.Candidate(
                provider, result, number(cursor, "success_at"),
                ManualTimelineAuthorityPolicy.storedCompleteness(
                        provider, number(cursor, "complete") != 0L)));
    }

    static ManualTimelineAuthorityPolicy.Candidate sanitizeManualTimelineCandidate(
            ManualTimelineAuthorityPolicy.Candidate candidate) {
        if (candidate == null || candidate.result == null) return candidate;
        ExpressQueryResult result = candidate.result;
        boolean invalidatedMetadata = ExpressTimeline.containsProviderError(result.tracksJson)
                || ExpressStatusNormalizer.isProviderErrorDetail(result.latestDetail);
        if (!invalidatedMetadata) return candidate;
        String tracksJson = ExpressTimeline.mergeJson("[]", result.tracksJson);
        java.util.List<ExpressTimeline.Track> tracks =
                ExpressTimeline.parse(tracksJson, "", "");
        ExpressTimeline.Track latest = tracks.isEmpty() ? null : tracks.get(0);
        String latestTime = result.latestTime;
        String latestDetail = result.latestDetail;
        if (invalidatedMetadata
                || ExpressSourcePolicy.parseEventTime(latestTime) <= 0L
                || latestDetail.isEmpty()) {
            latestTime = latest == null ? "" : latest.time;
            latestDetail = latest == null ? "" : latest.detail;
        }
        StatusSemantic semantic = invalidatedMetadata
                ? StatusSemantic.UNKNOWN : result.semantic;
        long statusEventTime = invalidatedMetadata ? 0L : result.statusEventTime;
        ExpressQueryResult sanitized = new ExpressQueryResult(
                result.waybill, result.courierCode, result.companyName,
                semantic, statusEventTime, latestTime, latestDetail, tracksJson,
                result.detailUrl, result.phone, result.timelineProvider,
                result.routeInterface, result.routeCredential, result.sourceProvider,
                result.carrierNormalization)
                .withCarrierIdentityEvidence(result.carrierIdentityEvidence)
                .withManualStatusEvidence(
                        invalidatedMetadata ? "" : result.statusDescription,
                        !invalidatedMetadata && result.structuredStatusEvidence);
        return new ManualTimelineAuthorityPolicy.Candidate(
                candidate.provider, sanitized, candidate.successAt,
                !invalidatedMetadata && candidate.complete,
                invalidatedMetadata || candidate.providerErrorMetadataInvalidated);
    }

    public void saveQuery(ExpressQueryResult result, String phone, String source) {
        saveManualOwnerResult(result, phone, source,
                ExpressSourcePolicy.bindingSourceForOwner(source),
                System.currentTimeMillis());
    }

    /**
     * R-29 (AGENTS §9, 2026-09-03, same rule on iOS and Pipi): an automatic account row whose
     * real waybill was projected from a JD order anchors every manual package to its own first
     * timed feed node; a package with older nodes belongs to another parcel (reused waybill).
     */
    static boolean isForeignManualPackage(ExpressItem owner, ExpressQueryResult result) {
        if (owner == null || result == null || owner.manuallyAdded) return false;
        if (TimelineSlot.isAccount(TimelineSlot.normalize(result.timelineProvider))) return false;
        return ExpressTimeline.isForeignPackage(foreignPackageAnchorAt(owner), result.tracksJson);
    }

    private static long foreignPackageAnchorAt(ExpressItem owner) {
        if (owner == null || owner.manuallyAdded
                || !owner.isAccountOrder()
                || !"JingDong".equalsIgnoreCase(owner.sourceProvider)) return 0L;
        long origin = positiveMinimum(owner.listOriginAtMs,
                ExpressTimeline.accountListOriginAtMillis(owner.tracksJson));
        return origin > 0L ? origin - ExpressTimeline.FOREIGN_PACKAGE_ANCHOR_SLACK_MS : 0L;
    }

    private static long earliestTimedTrackAt(ExpressQueryResult result) {
        if (result == null) return 0L;
        long earliest = 0L;
        for (ExpressTimeline.Track track : ExpressTimeline.parse(result.tracksJson, "", "")) {
            earliest = positiveMinimum(earliest, ExpressSourcePolicy.parseEventTime(track.time));
        }
        return earliest;
    }

    /** Legacy foreign packets lose their dependent route, sticky choice and terminal latch together. */
    private ExpressItem repairForeignManualState(SQLiteDatabase db, ExpressItem owner) {
        if (owner == null || owner.manuallyAdded
                || !"JingDong".equalsIgnoreCase(owner.sourceProvider)) return owner;
        ArrayList<String> rejected = new ArrayList<>();
        boolean rejectedCompletion = false;
        boolean retainedCompletion = trustedCompletion(sourcePackage(owner), System.currentTimeMillis());
        try (Cursor cursor = db.query(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null,
                "owner_row_id=? AND normalized_waybill=? AND LOWER(binding_source)=?",
                new String[]{Long.toString(owner.rowId),
                        ExpressSourcePolicy.normalizeWaybill(owner.displayWaybill()),
                        ExpressSourcePolicy.bindingSourceForOwner(owner.stateOwner.isEmpty()
                                ? owner.source : owner.stateOwner)}, null, null, null)) {
            while (cursor.moveToNext()) {
                ManualTimelineAuthorityPolicy.Candidate candidate = manualTimelineCandidate(cursor);
                if (isForeignManualPackage(owner, candidate.result)) {
                    rejected.add(text(cursor, "provider"));
                    rejectedCompletion |= candidate.result.semantic == StatusSemantic.COMPLETED;
                } else retainedCompletion |= trustedCompletion(candidate.result, System.currentTimeMillis());
            }
        }
        if (rejected.isEmpty()) return owner;
        try (Cursor cursor = db.query(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE, null,
                "normalized_waybill=?", new String[]{ExpressSourcePolicy.normalizeWaybill(owner.waybill)},
                null, null, null)) {
            if (cursor.moveToFirst()) {
                OwnerAttribution stored = OwnerAttribution.fromQueryKey(text(cursor, "owner_attribution"));
                if (stored != null && stored.equals(currentOwnerAttribution(db, owner))) {
                    retainedCompletion |= trustedCompletion(cleanJdTimeline(
                            timeline(cursor, TimelineSlot.V5_QUERY), owner), System.currentTimeMillis());
                }
            }
        }
        db.beginTransaction();
        try {
            for (String provider : rejected) {
                String[] args = {Long.toString(owner.rowId), provider};
                db.delete(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, "owner_row_id=? AND provider=?", args);
                db.delete(ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE, "owner_row_id=? AND provider=?", args);
                if (TimelineSlot.normalize(provider).equals(preferredDetailProvider(owner))) {
                    String key = detailSelectionKey(owner);
                    detailSelections.remove(key);
                    context.getSharedPreferences(DETAIL_SELECTION_PREFS, 0).edit().remove(key).apply();
                }
            }
            if (rejectedCompletion && !retainedCompletion) {
                ContentValues retained = new ContentValues();
                retained.put("signedRetainedAt", 0L);
                db.update(ExpressDatabase.EXPRESS_TABLE, retained, "_id=?",
                        new String[]{Long.toString(owner.rowId)});
                ContentValues frozen = new ContentValues();
                frozen.put("display_frozen", 0);
                db.update(ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, frozen, "owner_row_id=?",
                        new String[]{Long.toString(owner.rowId)});
                owner = owner.withSignedRetainedAt(0L);
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        return owner;
    }

    /** Commits a successful foreground/manual result through the existing owner source. */
    public void saveManualQueryResult(
            ExpressQueryResult result, String phone, String bindingSource) {
        saveManualQueryResult(
                result, phone, bindingSource, System.currentTimeMillis());
    }

    public void saveManualQueryResult(
            ExpressQueryResult result, String phone, String bindingSource,
            long successfulAt) {
        saveManualQueryResult(
                result, phone, bindingSource, successfulAt,
                result != null && ManualTimelineAuthorityPolicy.completeByContract(
                        result.timelineProvider));
    }

    public void saveManualQueryResult(
            ExpressQueryResult result, String phone, String bindingSource,
            long successfulAt, boolean complete) {
        if (result == null) return;
        String provider = TimelineSlot.normalize(result.timelineProvider);
        String source = manualOwnerSource(provider, bindingSource);
        ExpressItem owner = saveManualOwnerResult(
                result, phone, source, bindingSource, successfulAt, complete);
        if (owner == null) return;
        if (!owner.manuallyAdded && owner.usesSourceManualTakeover()) return;
        if (TimelineSlot.isAccount(provider)) {
            saveAccountTimeline(result, TimelineSlot.bindingSourceOf(provider));
        } else if (TimelineSlot.V4_QUERY.equals(provider)) {
            saveV4Timeline(result);
        } else if (TimelineSlot.V6_QUERY.equals(provider)) {
            // Meizu query history stays in its owner-scoped sidecar, outside shared caches.
        } else {
            saveKuaidi100Timeline(result);
        }
    }

    private ExpressItem saveManualOwnerResult(
            ExpressQueryResult result, String phone, String source, String bindingSource,
            long successfulAt) {
        return saveManualOwnerResult(
                result, phone, source, bindingSource, successfulAt,
                result != null && ManualTimelineAuthorityPolicy.completeByContract(
                        result.timelineProvider));
    }

    private ExpressItem saveManualOwnerResult(
            ExpressQueryResult result, String phone, String source, String bindingSource,
            long successfulAt, boolean complete) {
        if (!Kuaidi100TimelinePolicy.hasTimedTracking(result)) return null;
        ExpressItem owner;
        synchronized (this) {
            owner = findRawByWaybill(result.waybill, bindingSource);
        }
        // R-29 (AGENTS §9, 2026-09-03): for an account-projected waybill a provider package
        // older than the order's own first feed node minus a day is another parcel's history.
        if (isForeignManualPackage(owner, result)) return owner;
        if (owner == null || manualResultMarksOwnerManual(owner)) {
            if (owner == null || !owner.manuallyAdded) {
                return saveNewManualOwnerTimeline(
                        owner, result, phone, source, bindingSource, successfulAt, complete);
            }
            return saveOwnerManualTimeline(
                    owner, result, phone, bindingSource, successfulAt, complete);
        }
        if (!manualResultWritesOwnerRow(owner)) {
            return saveOwnerManualTimeline(
                    owner, result, phone, bindingSource, successfulAt, complete);
        }
        saveQuery(result, phone, source, false, false, false);
        synchronized (this) {
            owner = findRawByWaybill(result.waybill, bindingSource);
        }
        return owner;
    }

    /** Creates or promotes a manual owner and its first visible provider package atomically. */
    private ExpressItem saveNewManualOwnerTimeline(
            ExpressItem expectedOwner, ExpressQueryResult result,
            String phone, String source, String bindingSource, long successfulAt,
            boolean complete) {
        String normalized = ExpressSourcePolicy.normalizeWaybill(result.waybill);
        String provider = TimelineSlot.normalize(result.timelineProvider);
        String selectedBindingSource = normalizeBindingSource(bindingSource);
        String incomingOwner = ExpressSourcePolicy.source(source);
        if (normalized.isEmpty() || provider.isEmpty()
                || selectedBindingSource.isEmpty()
                || !selectedBindingSource.equals(
                ExpressSourcePolicy.bindingSourceForOwner(incomingOwner))) return expectedOwner;

        ExpressItem previous;
        ExpressItem current;
        synchronized (this) {
            SQLiteDatabase db = database();
            db.beginTransaction();
            try {
                ExpressItem raw = findRawByWaybill(result.waybill, selectedBindingSource);
                if (expectedOwner != null && !sameOwnerIdentity(raw, expectedOwner)) {
                    return expectedOwner;
                }
                if (raw != null && !raw.manuallyAdded
                        && !manualResultMarksOwnerManual(raw)) return raw;
                previous = projectManualTimeline(raw);
                if (raw == null) {
                    long rowId = db.insertOrThrow(
                            ExpressDatabase.EXPRESS_TABLE, null,
                            newManualOwnerValues(
                                    result, phone, normalized, incomingOwner));
                    raw = findRaw(rowId);
                } else if (!raw.manuallyAdded) {
                    ContentValues promotion = new ContentValues();
                    promotion.put("data3", "manual");
                    if (raw.phone.isEmpty() && !clean(phone).isEmpty()) {
                        promotion.put("subPhone", clean(phone));
                    }
                    db.update(ExpressDatabase.EXPRESS_TABLE, promotion, "_id=?",
                            new String[]{Long.toString(raw.rowId)});
                    raw = findRaw(raw.rowId);
                }
                if (raw == null || !raw.manuallyAdded) {
                    throw new IllegalStateException("Manual owner persistence failed");
                }
                String ownerBindingSource = ExpressSourcePolicy.bindingSourceForOwner(
                        raw.stateOwner.isEmpty() ? raw.source : raw.stateOwner);
                if (!selectedBindingSource.equals(ownerBindingSource)) {
                    throw new IllegalStateException("Manual owner source changed");
                }
                String routeUrl = ManualRoutePolicy.meizuKuaidi100Url(provider, result);
                OwnerAttribution routeAttribution = currentOwnerAttribution(db, raw);
                if (!routeUrl.isEmpty() && routeAttribution != null) {
                    saveManualRoute(db, routeAttribution, new ManualQueryWrite(
                            provider, result, preferNonEmpty(phone, raw.phone),
                            Math.max(1L, successfulAt), complete, true, routeUrl));
                }
                ManualTimelineAuthorityPolicy.Candidate cached = manualTimelineCandidate(
                        db, raw, provider);
                ManualTimelineAuthorityPolicy.Candidate refreshed =
                        new ManualTimelineAuthorityPolicy.Candidate(
                                provider, result, Math.max(1L, successfulAt), complete);
                ManualTimelineAuthorityPolicy.Candidate merged =
                        ManualTimelineAuthorityPolicy.mergeSameProvider(cached, refreshed);
                if (merged == null) {
                    throw new IllegalStateException("Manual timeline is not authoritative");
                }
                long inserted = db.insertWithOnConflict(
                        ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null,
                        manualTimelineValues(
                                raw, merged, preferNonEmpty(phone, raw.phone),
                                ownerBindingSource),
                        SQLiteDatabase.CONFLICT_REPLACE);
                if (inserted < 0L) {
                    throw new IllegalStateException("Manual timeline persistence failed");
                }
                db.delete(ExpressDatabase.KUAIDI100_PENDING_TABLE,
                        "normalized_waybill=?", new String[]{normalized});
                current = findByWaybill(result.waybill, selectedBindingSource);
                current = stageNotification(db, previous, current);
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
        publishChange();
        return current;
    }

    private ContentValues newManualOwnerValues(
            ExpressQueryResult result, String phone,
            String normalized, String incomingOwner) {
        // Meizu's K100 URL is presentation-only manual sidecar state. It must not become the
        // shipment owner's source route when Meizu happens to create the first manual package.
        boolean meizuManualPackage = TimelineSlot.V6_QUERY.equals(
                TimelineSlot.normalize(result.timelineProvider));
        String selectedRoute = meizuManualPackage ? ""
                : ExpressSourcePolicy.selectDetailUrl("", result.detailUrl);
        String routeInterface = clean(result.routeInterface);
        if (routeInterface.isEmpty()) {
            routeInterface = CainiaoRoute.interfaceFromToken(selectedRoute);
        }
        if (routeInterface.isEmpty()) {
            routeInterface = CainiaoRoute.interfaceFromLegacyUrl(selectedRoute);
        }
        if (CainiaoRoute.isLegacyCredentialedUrl(selectedRoute)) {
            selectedRoute = CainiaoRoute.token(routeInterface);
        }
        String routeCredential = preferNonEmpty(
                result.routeCredential,
                CainiaoRoute.isLegacyCredentialedUrl(selectedRoute) ? selectedRoute : "");
        EncryptedExpressFields.Result encryptedRoute =
                EncryptedExpressFields.tryEncode(routeCredential);
        if (!routeCredential.isEmpty() && !encryptedRoute.available) {
            selectedRoute = "";
            routeInterface = "";
        } else if (CainiaoRoute.isLegacyCredentialedUrl(selectedRoute)) {
            selectedRoute = CainiaoRoute.token(routeInterface);
        }

        ContentValues values = new ContentValues();
        values.put("subPhone", clean(phone));
        values.put("mailNo", clean(result.waybill));
        values.put("normalizedMailNo", normalized);
        values.put("cpCode", clean(result.courierCode));
        values.put("cpName", CarrierRegistry.companyName(
                result.courierCode, result.companyName));
        putCarrierNormalization(values, result.carrierNormalization);
        values.put("data2", CarrierRegistry.localIconUri(
                context, result.courierCode, result.companyName));
        values.put("data3", "manual");
        values.put("logsiticsStatus", StatusSemantic.UNKNOWN.storageCode);
        values.put("logisticsStatusDesc", StatusSemantic.UNKNOWN.label);
        values.put("lastLogisticDetail", "");
        values.put("logisticsGmtModified", "");
        values.put("packageDyn", "[]");
        values.put("statusEventTime", 0L);
        values.put("stateOwner", incomingOwner);
        values.put("fromCp", incomingOwner);
        values.put("moreInfoUrl", selectedRoute);
        values.put("routeOwner", selectedRoute.isEmpty() ? "" : incomingOwner);
        values.put("routeInterface", routeInterface);
        if (encryptedRoute.available) {
            values.put("routeCredential", encryptedRoute.value);
        }
        values.put("canShow", 1);
        values.put("isDeleted", 0);
        values.put("updatedAt", System.currentTimeMillis());
        return values;
    }

    private static void putCarrierNormalization(
            ContentValues values, CarrierNormalization normalization) {
        if (values == null || normalization == null || !normalization.present()) return;
        values.put("carrierStandardCode", normalization.standardCode);
        values.put("carrierDisplayName", normalization.displayName);
        values.put("carrierKuaidi100Code", normalization.kuaidi100Code);
        values.put("carrierIsBuiltIn", normalization.builtIn == null
                ? -1 : normalization.builtIn ? 1 : 0);
        values.put("carrierTableVersion", normalization.tableVersion);
    }

    static boolean manualResultWritesOwnerRow(ExpressItem owner) {
        if (owner == null) return true;
        String currentOwner = owner.stateOwner.isEmpty() ? owner.source : owner.stateOwner;
        return !isAutomaticAccountOwner(currentOwner);
    }

    static boolean manualResultMarksOwnerManual(ExpressItem owner) {
        if (owner == null || owner.manuallyAdded) return true;
        String currentOwner = owner.stateOwner.isEmpty() ? owner.source : owner.stateOwner;
        return !isAutomaticAccountOwner(currentOwner);
    }

    /** Interface 5 owns automatic account state, routing and its same-source timeline. */
    public void saveInterface5(ExpressQueryResult result, String phone) {
        saveInterface5(result, phone, bindingGeneration(phone, "interface5"));
    }

    public void saveInterface5(
            ExpressQueryResult result, String phone, String bindingGeneration) {
        saveAutomaticObservation(
                result, phone, ExpressSourcePolicy.SOURCE_INTERFACE5,
                bindingGeneration, System.currentTimeMillis());

    }

    /** Interface 6 owns automatic account state and its direct detail route when selected. */
    public void saveInterface6(ExpressQueryResult result, String phone) {
        saveInterface6(result, phone, bindingGeneration(phone, "interface6"));
    }

    public void saveInterface6(
            ExpressQueryResult result, String phone, String bindingGeneration) {
        saveAutomaticObservation(
                result, phone, ExpressSourcePolicy.SOURCE_INTERFACE6,
                bindingGeneration, System.currentTimeMillis());
    }

    /** Persists discovery state immediately without pretending a placeholder is a full timeline. */
    public void saveInterface5OrderSummary(ExpressQueryResult result, String phone) {
        saveInterface5OrderSummary(
                result, phone, bindingGeneration(phone, "interface5"));
    }

    public void saveInterface5OrderSummary(
            ExpressQueryResult result, String phone, String bindingGeneration) {
        saveAutomaticObservation(
                projectedOrderCarrierEvidence(result), phone,
                ExpressSourcePolicy.SOURCE_INTERFACE5_JD,
                bindingGeneration, System.currentTimeMillis());
    }

    private ExpressQueryResult projectedOrderCarrierEvidence(ExpressQueryResult result) {
        if (result == null || result.carrierIdentityEvidence) return result;
        OrderProjection projection = orderProjection(
                result.waybill, "interface5");
        return projection.companyName.isEmpty()
                ? result : result.withProjectedCarrierEvidence(projection.companyName);
    }

    /** Query history is update-only and belongs to the owner that initiated the request. */
    public synchronized boolean saveInterface5Query(
            ExpressQueryResult result, ExpressItem expectedOwner, String bindingGeneration) {
        if ((!Kuaidi100TimelinePolicy.hasRealTracking(result)
                && !ManualTimelineAuthorityPolicy.hasStructuredStatus(result))
                || expectedOwner == null) return false;
        SQLiteDatabase db = database();

        db.beginTransaction();
        try {
            ExpressItem current = findManualOwner(db, expectedOwner.rowId);
            if (!sameOwnerIdentity(current, expectedOwner)
                    || !ExpressSourcePolicy.normalizeWaybill(current.projectedWaybill).equals(
                    ExpressSourcePolicy.normalizeWaybill(expectedOwner.projectedWaybill))
                    || !ExpressSourcePolicy.normalizeWaybill(result.waybill).equals(
                    ExpressSourcePolicy.normalizeWaybill(current.waybill))) return false;
            OwnerAttribution attribution = currentOwnerAttribution(db, current);
            if (attribution == null || !"interface5".equals(attribution.bindingSource)
                    || !clean(bindingGeneration).equals(attribution.bindingGeneration)
                    || !isCurrentBindingGeneration(db, current.phone, "interface5", bindingGeneration)
                    || !current.sourceProvider.equalsIgnoreCase(result.sourceProvider)) return false;
            if (current.isAccountOrder() && current.projectedWaybill.isEmpty()) {
                me.pipi.deliveries.feature.express.ExpressOrderTextIdentity.Identity identity =
                        me.pipi.deliveries.feature.express.ExpressOrderTextIdentity.fromTracksJson(
                                result.tracksJson, current.waybill);
                if (identity != null) {
                    if (!saveOrderProjection(current, "interface5", identity.waybill, identity.companyName, false)) return false;

                }
            }
            attribution = currentOwnerAttribution(db, findManualOwner(db, current.rowId));
            if (attribution == null) return false;
            ExpressQueryResult cleanedQuery = cleanJdQuery(result);
            ExpressLog.write("account.query.prepared", "waybillTail", ExpressLog.tail(current.displayWaybill()),
                    "sourceProvider", ExpressLog.source(current.sourceProvider, false),
                    "timelineProvider", TimelineSlot.V5_QUERY,
                    "statusSemantic", cleanedQuery.semantic, "statusEventAtMs", cleanedQuery.statusEventTime,
                    "structuredStatus", cleanedQuery.structuredStatusEvidence,
                    "shoppingCompletionRemoved", cleanedQuery != result,
                    "effectiveTrackCount", Kuaidi100TimelinePolicy.timedTrackCount(cleanedQuery));
            saveTimeline(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE, cleanedQuery, attribution);
            String projectedWaybill = orderProjection(result.waybill, "interface5").waybill;
            if (!projectedWaybill.isEmpty()
                    && !ExpressSourcePolicy.normalizeWaybill(projectedWaybill).equals(
                    ExpressSourcePolicy.normalizeWaybill(result.waybill))) {
                saveTimeline(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE,
                        cleanJdQuery(result.withWaybill(projectedWaybill)), attribution);
            }
            if (current.isAccountOrder()) {
                // Older builds treated an order id as a K100 waybill.
                db.delete(ExpressDatabase.KUAIDI100_TIMELINE_TABLE, "normalized_waybill=?",
                        new String[]{ExpressSourcePolicy.normalizeWaybill(result.waybill)});
            }
            anchorSignedRetention(db, projectTimelineAuthorities(findRaw(db, current.rowId)),
                    System.currentTimeMillis());
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        publishChange();
        return true;
    }

    /** Persists one complete automatic observation and applies only the frozen global owner. */
    void saveAutomaticObservation(
            ExpressQueryResult result, String phone, String packageOwner,
            String bindingGeneration, long observedAt) {
        if (result == null
                || ExpressStatusNormalizer.isProviderErrorDetail(result.latestDetail)) return;
        String provider = AutomaticOwnershipPolicy.providerForPackageOwner(packageOwner);
        if (provider.isEmpty()) return;
        ExpressItem previousPresented = null;
        ExpressItem currentPresented = null;
        boolean changed = false;
        synchronized (this) {
            SQLiteDatabase db = database();
            db.beginTransaction();
            try {
                String normalized = automaticIdentity(db, result.waybill, packageOwner);
                if (normalized.isEmpty()) return;
                String bindingSource = ExpressSourcePolicy.bindingSourceForOwner(provider);
                String effectivePhone = preferNonEmpty(result.phone, phone);
                if (!isCurrentBindingGeneration(
                        db, effectivePhone, bindingSource, bindingGeneration)) return;
                if (rejectsUnboundAutomaticWrite(
                        db, normalized, bindingSource, effectivePhone)) return;
                // A projected order can supply the first structured completion for its parcel.
                if (ExpressSourcePolicy.SOURCE_INTERFACE5_JD.equals(
                        ExpressSourcePolicy.source(packageOwner))
                        && result.semantic == StatusSemantic.COMPLETED
                        && !orderProjection(result.waybill, bindingSource).waybill.isEmpty()
                        && (!result.structuredStatusEvidence
                        || JingDongOrderCompletionPolicy.clean(result, result.waybill).semantic
                                != StatusSemantic.COMPLETED)) {
                    return;
                }
                ExpressQueryResult cleaned = cleanJdAutomaticPacket(result, packageOwner);
                if (cleaned != result && !Kuaidi100TimelinePolicy.hasTimedTracking(cleaned)
                        && !ManualTimelineAuthorityPolicy.hasStructuredStatus(cleaned)) return;
                result = cleaned;
                // 留存窗口外的件不首次入库（Pipi 的 expiredRejected 同口径）：上游列表还会
                // 列出 8 月底签收的订单，每小时清理后再导入就会「已下单 → 已签收」重新通知。
                if (findAnyRawByIdentity(db, normalized) == null
                        && ExpressVisibilityPolicy.isExpiredResult(
                        result, Math.max(1L, observedAt))) {
                    ExpressLog.retentionRejected(result, "expired");
                    return;
                }
                boolean qualified = AutomaticOwnershipPolicy.isQualified(packageOwner, result);
                if (qualified) {
                    upsertAutomaticObservation(
                            db, normalized, provider, packageOwner,
                            result, effectivePhone, bindingGeneration,
                            Math.max(1L, observedAt));
                }
                AutomaticOwnershipState ownership = automaticOwnershipState(db, normalized);
                boolean sameOwner = ownership != null
                        && provider.equals(ownership.ownerProvider)
                        && clean(bindingGeneration).equals(
                        ownership.ownerBindingGeneration);
                if (ownership == null && !qualified) {
                    if (ExpressSourcePolicy.isAccountOrderOwner(packageOwner)) {
                        ExpressItem provisional = findAnyRawByIdentity(db, normalized);
                        if (provisional == null || (!provisional.manuallyAdded
                                && ExpressSourcePolicy.isAccountOrderOwner(
                                provisional.stateOwner.isEmpty()
                                        ? provisional.source : provisional.stateOwner))) {
                            previousPresented = projectTimelineAuthorities(provisional);
                            long rowId = materializeAutomaticPackage(
                                    db, provisional, result, phone, packageOwner,
                                    Math.max(1L, observedAt), provisional != null);
                            currentPresented = projectTimelineAuthorities(findRaw(db, rowId));
                            changed = true;
                        }
                    }
                } else if (qualified || sameOwner) {
                    ExpressItem target = ownership == null
                            ? findAnyRawByIdentity(db, normalized)
                            : findRaw(db, ownership.ownerRowId);
                    // A provisional order may already have a signed, owner-attributed query.
                    previousPresented = target == null ? null
                            : projectTimelineAuthorities(findManualOwner(db, target.rowId));
                    OwnerAttribution targetAttribution = currentOwnerAttribution(db, previousPresented);
                    if (targetAttribution != null && bindingSource.equals(targetAttribution.bindingSource)
                            && clean(bindingGeneration).equals(targetAttribution.bindingGeneration)
                            && previousPresented != null && previousPresented.isJingDongSource()
                            && previousPresented.semantic == StatusSemantic.COMPLETED
                            && ExpressLifecycleTimes.signedEvidenceAt(previousPresented, null,
                                    System.currentTimeMillis()) > 0L
                            && result.semantic == StatusSemantic.COMPLETED
                            && (ExpressSourcePolicy.isAccountOrderOwner(packageOwner)
                            || result.workerStatus != null && "ORDER".equals(result.workerStatus.scope))) return;
                    if (ownership == null || ownership.ownerProvider.isEmpty()) {
                        previousPresented = projectTimelineAuthorities(target);
                        long rowId = materializeAutomaticPackage(
                                db, target, result, phone, packageOwner,
                                Math.max(1L, observedAt), false);
                        putAutomaticOwnership(
                                db, normalized, provider, effectivePhone,
                                bindingGeneration, rowId,
                                Math.max(1L, observedAt), Math.max(1L, observedAt),
                                0, "", ownership == null ? 0L : ownership.cooldownUntil,
                                AutomaticOwnershipPolicy.isJingDongSource(result.sourceProvider)
                                        && result.semantic == StatusSemantic.COMPLETED);
                        currentPresented = projectTimelineAuthorities(findRaw(db, rowId));
                        changed = true;
                    } else if (sameOwner) {
                        long rowId = target == null
                                ? materializeAutomaticPackage(
                                db, null, result, phone, packageOwner,
                                Math.max(1L, observedAt), false)
                                : target.rowId;
                        previousPresented = projectTimelineAuthorities(target);
                        boolean frozen = ownership.displayFrozen
                                || target != null
                                && AutomaticOwnershipPolicy.isJingDongSource(
                                target.sourceProvider)
                                && target.sourceSemantic == StatusSemantic.COMPLETED;
                        if (!frozen && target != null) {
                            materializeAutomaticPackage(
                                    db, target, result, phone, packageOwner,
                                    Math.max(1L, observedAt), true);
                        } else if (frozen && target != null
                                && result.carrierNormalization.present()) {
                            ContentValues normalization = new ContentValues();
                            putCarrierNormalization(
                                    normalization, result.carrierNormalization);
                            db.update(ExpressDatabase.EXPRESS_TABLE, normalization, "_id=?",
                                    new String[]{Long.toString(target.rowId)});
                        }
                        boolean nowFrozen = frozen
                                || AutomaticOwnershipPolicy.isJingDongSource(
                                result.sourceProvider)
                                && result.semantic == StatusSemantic.COMPLETED;
                        putAutomaticOwnership(
                                db, normalized, provider, effectivePhone,
                                bindingGeneration, rowId,
                                ownership.claimedAt,
                                Math.max(ownership.lastObservedAt, observedAt),
                                0, "", ownership.cooldownUntil, nowFrozen);
                        currentPresented = projectTimelineAuthorities(findRaw(db, rowId));
                        changed = !frozen || result.carrierNormalization.present();
                    } else if (ownership.missCount > 0
                            && observedAt >= ownership.cooldownUntil) {
                        previousPresented = projectTimelineAuthorities(target);
                        long rowId = materializeAutomaticPackage(
                                db, target, result, phone, packageOwner,
                                Math.max(1L, observedAt), false);
                        putAutomaticOwnership(
                                db, normalized, provider, effectivePhone,
                                bindingGeneration, rowId,
                                Math.max(1L, observedAt), Math.max(1L, observedAt),
                                0, "", Math.max(1L, observedAt)
                                        + AutomaticOwnershipPolicy.TAKEOVER_COOLDOWN_MS,
                                AutomaticOwnershipPolicy.isJingDongSource(result.sourceProvider)
                                        && result.semantic == StatusSemantic.COMPLETED);
                        currentPresented = projectTimelineAuthorities(findRaw(db, rowId));
                        changed = true;
                    }
                }
                if (changed) currentPresented = stageNotification(db, previousPresented, currentPresented);
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
        if (changed) publishChange();
    }

    private void upsertAutomaticObservation(
            SQLiteDatabase db, String normalized, String provider, String packageOwner,
            ExpressQueryResult result, String phone, String bindingGeneration,
            long observedAt) {
        result = cleanJdAutomaticPacket(result, packageOwner);
        ContentValues values = new ContentValues();
        values.put("normalized_waybill", normalized);
        values.put("owner_provider", provider);
        values.put("binding_generation", clean(bindingGeneration));
        values.put("package_owner", ExpressSourcePolicy.source(packageOwner));
        values.put("binding_source", ExpressSourcePolicy.bindingSourceForOwner(provider));
        values.put("waybill", clean(result.waybill));
        values.put("phone", preferNonEmpty(result.phone, phone));
        values.put("courier_code", clean(result.courierCode));
        values.put("company_name", clean(result.companyName));
        values.put("status_code", result.semantic.storageCode);
        values.put("status_event_time", result.workerStatus != null ? result.statusEventTime
                : result.semantic == StatusSemantic.UNKNOWN
                && AutomaticOwnershipPolicy.isJingDongSource(result.sourceProvider) ? 0L
                : result.statusEventTime > 0L
                ? result.statusEventTime
                : ExpressSourcePolicy.parseEventTime(result.latestTime));
        values.put("latest_time", clean(result.latestTime));
        values.put("latest_detail", clean(result.latestDetail));
        values.put("tracks_json", clean(result.tracksJson).isEmpty()
                ? "[]" : clean(result.tracksJson));
        values.put("source_provider", clean(result.sourceProvider));
        long originAt = positiveMinimum(result.listOriginAtMs,
                ExpressTimeline.accountListOriginAtMillis(result.tracksJson));
        try (Cursor previous = db.query(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                new String[]{"list_origin_at_ms", "tracks_json", "source_provider"},
                "normalized_waybill=? AND owner_provider=? AND binding_generation=?",
                new String[]{normalized, provider, bindingGeneration}, null, null, null)) {
            if (previous.moveToFirst() && result.sourceProvider.equalsIgnoreCase(
                    text(previous, "source_provider"))) {
                originAt = positiveMinimum(originAt, positiveMinimum(number(previous, "list_origin_at_ms"),
                        ExpressTimeline.accountListOriginAtMillis(text(previous, "tracks_json"))));
            }
        }
        values.put("list_origin_at_ms", originAt);
        values.put("sender_phone", result.senderPhone);
        String routeInterface = clean(result.routeInterface);
        String routeCredential = preferNonEmpty(
                result.routeCredential,
                CainiaoRoute.isLegacyCredentialedUrl(result.detailUrl)
                        ? result.detailUrl : "");
        if (routeInterface.isEmpty()) {
            routeInterface = CainiaoRoute.interfaceFromToken(result.detailUrl);
        }
        if (routeInterface.isEmpty()) {
            routeInterface = CainiaoRoute.interfaceFromLegacyUrl(result.detailUrl);
        }
        String detailUrl = ExpressSourcePolicy.selectDetailUrl("", result.detailUrl);
        if (CainiaoRoute.isLegacyCredentialedUrl(detailUrl)) {
            detailUrl = CainiaoRoute.token(routeInterface);
        }
        EncryptedExpressFields.Result encryptedRoute =
                EncryptedExpressFields.tryEncode(routeCredential);
        values.put("detail_url", encryptedRoute.available ? detailUrl : "");
        values.put("route_interface", encryptedRoute.available ? routeInterface : "");
        values.put("route_credential", encryptedRoute.available
                ? encryptedRoute.value : "");
        CarrierNormalization normalization = result.carrierNormalization;
        values.put("carrier_standard_code", normalization.standardCode);
        values.put("carrier_display_name", normalization.displayName);
        values.put("carrier_kuaidi100_code", normalization.kuaidi100Code);
        values.put("carrier_is_built_in", normalization.builtIn == null
                ? -1 : normalization.builtIn ? 1 : 0);
        values.put("carrier_table_version", normalization.tableVersion);
        values.put("qualified", 1);
        values.put("observed_at", observedAt);
        if (db.insertWithOnConflict(
                ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE, null, values,
                SQLiteDatabase.CONFLICT_REPLACE) < 0L) {
            throw new IllegalStateException("Automatic observation persistence failed");
        }
    }

    private long materializeAutomaticPackage(
            SQLiteDatabase db, ExpressItem target, ExpressQueryResult result,
            String phone, String packageOwner, long observedAt,
            boolean preserveSameOwnerRoute) {
        String senderPhone = result.senderPhone;
        long originAt = positiveMinimum(result.listOriginAtMs,
                ExpressTimeline.accountListOriginAtMillis(result.tracksJson));
        boolean sameListOwner = target != null && !target.manuallyAdded
                && ExpressSourcePolicy.source(packageOwner).equals(ExpressSourcePolicy.source(
                        target.stateOwner.isEmpty() ? target.source : target.stateOwner))
                && target.sourceProvider.equalsIgnoreCase(result.sourceProvider)
                && ExpressSourcePolicy.normalizeWaybill(target.waybill).equals(
                        ExpressSourcePolicy.normalizeWaybill(result.waybill));
        if (sameListOwner) originAt = positiveMinimum(originAt, positiveMinimum(target.listOriginAtMs,
                ExpressTimeline.accountListOriginAtMillis(target.tracksJson)));
        // A list snapshot belongs to one owner. Provider handoffs must not inherit its origin.
        if (preserveSameOwnerRoute && target != null
                && ExpressSourcePolicy.source(packageOwner).equals(ExpressSourcePolicy.source(
                        target.stateOwner.isEmpty() ? target.source : target.stateOwner))
                && !clean(target.sourceProvider).isEmpty()
                && target.sourceProvider.equalsIgnoreCase(clean(result.sourceProvider))) {
            originAt = positiveMinimum(originAt, positiveMinimum(target.listOriginAtMs,
                    ExpressTimeline.accountListOriginAtMillis(target.tracksJson)));
            result = mergeSameOwnerFeed(target, result);
        }
        result = cleanJdAutomaticPacket(result, packageOwner);
        ContentValues values = new ContentValues();
        if (preserveSameOwnerRoute && isProjectedJdParcel(target)) {
            // Preserve the read-side correction before replacing the history that proved it.
            values.put("signedRetainedAt", target.signedRetainedAt);
        }
        String courierCode = preserveSameOwnerRoute && target != null
                ? preferNonEmpty(result.courierCode, target.courierCode)
                : clean(result.courierCode);
        String companyName = preserveSameOwnerRoute && target != null
                ? preferNonEmpty(result.companyName, target.companyName)
                : clean(result.companyName);
        values.put("subPhone", preferNonEmpty(result.phone, phone));
        values.put("senderPhone", senderPhone);
        values.put("listOriginAtMs", originAt);
        values.put("mailNo", clean(result.waybill));
        values.put("normalizedMailNo",
                ExpressSourcePolicy.normalizeWaybill(result.waybill));
        values.put("cpCode", courierCode);
        values.put("cpName", companyName);
        CarrierNormalization normalization = result.carrierNormalization;
        // Recognized carrier identity belongs to the waybill, not the account route.
        if (target != null
                && ExpressSourcePolicy.normalizeWaybill(target.waybill).equals(
                        ExpressSourcePolicy.normalizeWaybill(result.waybill))
                && ((target.carrierNormalization.recognized() && !normalization.recognized())
                        || (preserveSameOwnerRoute && !normalization.present()))) {
            normalization = target.carrierNormalization;
        }
        values.put("carrierStandardCode", normalization.standardCode);
        values.put("carrierDisplayName", normalization.displayName);
        values.put("carrierKuaidi100Code", normalization.kuaidi100Code);
        values.put("carrierIsBuiltIn", normalization.builtIn == null
                ? -1 : normalization.builtIn ? 1 : 0);
        values.put("carrierTableVersion", normalization.tableVersion);
        values.put("data1", clean(result.sourceProvider));
        values.put("data2", CarrierRegistry.localIconUri(
                context,
                normalization.recognized()
                        ? normalization.standardCode : courierCode,
                normalization.recognized()
                        ? normalization.displayName : companyName));
        values.put("data3", "");
        values.put("logsiticsStatus", result.semantic.storageCode);
        values.put("logisticsStatusDesc", result.workerStatus == null ? result.semantic.label : result.workerStatus.text);
        values.put("statusEventTime", result.workerStatus != null ? result.statusEventTime
                : result.semantic == StatusSemantic.UNKNOWN
                && AutomaticOwnershipPolicy.isJingDongSource(result.sourceProvider) ? 0L
                : result.statusEventTime > 0L
                ? result.statusEventTime
                : ExpressSourcePolicy.parseEventTime(result.latestTime));
        values.put("lastLogisticDetail", clean(result.latestDetail));
        values.put("logisticsGmtModified", clean(result.latestTime));
        values.put("packageDyn", clean(result.tracksJson).isEmpty()
                ? "[]" : clean(result.tracksJson));
        String normalizedOwner = ExpressSourcePolicy.source(packageOwner);
        values.put("stateOwner", normalizedOwner);
        values.put("fromCp", normalizedOwner);

        String currentRoute = preserveSameOwnerRoute && target != null
                ? target.detailUrl : "";
        String selectedRoute = ExpressSourcePolicy.selectDetailUrl(
                currentRoute, result.detailUrl);
        String incomingCredential = preferNonEmpty(
                result.routeCredential,
                CainiaoRoute.isLegacyCredentialedUrl(result.detailUrl)
                        ? result.detailUrl : "");
        EncryptedExpressFields.Result encryptedRoute =
                EncryptedExpressFields.tryEncode(incomingCredential);
        boolean incomingSelected = !selectedRoute.isEmpty()
                && selectedRoute.equals(result.detailUrl);
        if (incomingSelected && !incomingCredential.isEmpty() && !encryptedRoute.available) {
            selectedRoute = currentRoute;
            incomingSelected = false;
        }
        String routeInterface = incomingSelected ? clean(result.routeInterface)
                : preserveSameOwnerRoute && target != null ? target.routeInterface : "";
        if (routeInterface.isEmpty()) {
            routeInterface = CainiaoRoute.interfaceFromToken(selectedRoute);
        }
        if (routeInterface.isEmpty()) {
            routeInterface = CainiaoRoute.interfaceFromLegacyUrl(selectedRoute);
        }
        values.put("moreInfoUrl", selectedRoute);
        values.put("routeOwner", selectedRoute.isEmpty() ? "" : normalizedOwner);
        values.put("routeInterface", routeInterface);
        if (incomingSelected && encryptedRoute.available) {
            values.put("routeCredential", encryptedRoute.value);
        } else if (!preserveSameOwnerRoute || selectedRoute.isEmpty()) {
            values.put("routeCredential", "");
        }
        values.put("projectionRetryAt", 0L);
        values.put("projectionRetryRoute", "");
        values.put("canShow", 1);
        values.put("isDeleted", 0);
        values.put("updatedAt", observedAt);

        if (target == null) {
            long inserted = db.insertOrThrow(
                    ExpressDatabase.EXPRESS_TABLE, null, values);
            if (inserted <= 0L) {
                throw new IllegalStateException("Automatic owner persistence failed");
            }
            return inserted;
        }
        int changed = db.update(
                ExpressDatabase.EXPRESS_TABLE, values, "_id=?",
                new String[]{Long.toString(target.rowId)});
        if (changed != 1) throw new IllegalStateException("Automatic owner changed");
        return target.rowId;
    }

    private static long positiveMinimum(long left, long right) {
        return left > 0L && right > 0L ? Math.min(left, right) : Math.max(left, right);
    }

    static ExpressQueryResult mergeSameOwnerFeed(ExpressItem target, ExpressQueryResult result) {
        if (target == null || result == null) return result;
        if (!ExpressSourcePolicy.normalizeWaybill(target.waybill).equals(
                ExpressSourcePolicy.normalizeWaybill(result.waybill))) return result;
        if ("interface5".equals(ExpressSourcePolicy.bindingSourceForOwner(
                target.stateOwner.isEmpty() ? target.source : target.stateOwner))) {
            WorkerStatusProjection oldStatus = WorkerStatusProjection.cached(target.tracksJson);
            long previousStatusAt = target.statusEventTime > 0L ? target.statusEventTime
                    : oldStatus == null && target.sourceSemantic.terminal() ? ExpressTimeline.parseTime(target.latestTime) : 0L;
            long now = System.currentTimeMillis();
            boolean frozen = target.sourceSemantic == StatusSemantic.COMPLETED
                    ? ExpressLifecycleTimes.signedEvidenceAt(target, null, now) > 0L
                    : target.sourceSemantic == StatusSemantic.CANCELLED && previousStatusAt > 0L && previousStatusAt <= now;
            long oldEvent = Math.max(previousStatusAt, ExpressTimeline.parseTime(target.latestTime));
            long nextEvent = Math.max(result.statusEventTime, ExpressTimeline.parseTime(result.latestTime));
            boolean acceptsState = !frozen && result.semantic != StatusSemantic.UNKNOWN
                    && (target.sourceSemantic == StatusSemantic.UNKNOWN
                    || result.statusEventTime >= target.statusEventTime
                    && ExpressSourcePolicy.shouldApplyState(target.stateOwner,
                            target.sourceSemantic, target.statusEventTime, target.stateOwner,
                            result.semantic, result.statusEventTime));
            if (!frozen && result.semantic == target.sourceSemantic && oldStatus != null
                    && oldStatus.matches(target.sourceSemantic, target.statusEventTime)
                    && oldStatus.priority != WorkerStatusProjection.priority(result)) {
                acceptsState = WorkerStatusProjection.priority(result) > oldStatus.priority;
            }
            boolean orderRegression = target.isAccountOrder() && !target.projectedWaybill.isEmpty()
                    && result.semantic == StatusSemantic.ORDERED
                    && target.sourceSemantic != StatusSemantic.UNKNOWN && target.sourceSemantic != StatusSemantic.ORDERED;
            boolean headline = !frozen && !orderRegression
                    && !result.latestDetail.isEmpty()
                    && !ExpressStatusNormalizer.isProviderErrorDetail(result.latestDetail)
                    && (ExpressTimeline.parseTime(result.latestTime) >= ExpressTimeline.parseTime(target.latestTime)
                    || ExpressStatusNormalizer.isHeadlinePlaceholder(target.latestDetail, target.sourceSemantic));
            return new ExpressQueryResult(result.waybill, result.courierCode, result.companyName,
                    acceptsState ? result.semantic : target.sourceSemantic,
                    acceptsState ? result.statusEventTime : previousStatusAt,
                    headline ? result.latestTime : target.latestTime,
                    headline ? result.latestDetail : target.latestDetail,
                    WorkerStatusProjection.attach(
                            !frozen && !orderRegression && nextEvent >= oldEvent ? result.tracksJson : target.tracksJson,
                            acceptsState ? result.workerStatus : WorkerStatusProjection.cached(target.tracksJson)),
                    result.detailUrl, result.phone, result.timelineProvider, result.routeInterface,
                    result.routeCredential, result.sourceProvider, result.carrierNormalization)
                    .withCarrierIdentityEvidence(result.carrierIdentityEvidence)
                    .withManualStatusEvidence(result.statusDescription, result.structuredStatusEvidence)
                    .withAccountListMetadata(result.senderPhone, positiveMinimum(target.listOriginAtMs,
                            positiveMinimum(result.listOriginAtMs,
                                    ExpressTimeline.accountListOriginAtMillis(target.tracksJson))));
        }
        ExpressQueryResult existing = new ExpressQueryResult(
                target.waybill, target.courierCode, target.companyName, target.semantic,
                target.latestTime, target.latestDetail, target.tracksJson);
        if (!Kuaidi100TimelinePolicy.hasTimedTracking(existing)) return result;
        long existingLatest = Kuaidi100TimelinePolicy.latestTimedEventMillis(existing);
        long incomingLatest = Kuaidi100TimelinePolicy.latestTimedEventMillis(result);
        if (incomingLatest <= 0L) {
            incomingLatest = result.statusEventTime > 0L ? result.statusEventTime
                    : ExpressSourcePolicy.parseEventTime(result.latestTime);
        }
        int existingCount = Kuaidi100TimelinePolicy.timedTrackCount(existing);
        int incomingCount = Kuaidi100TimelinePolicy.timedTrackCount(result);
        // 摘要更新（更晚的事件）照常覆盖头条；只有摘要不比行新、节点又更少时才保住行上的详情。
        if (incomingLatest > existingLatest || incomingCount >= existingCount) {
            return withMergedSourceHistory(sourcePackage(target), result);
        }
        String tracks = ExpressTimeline.mergeJson(target.tracksJson, result.tracksJson);
        long statusEventTime = result.workerStatus != null ? result.statusEventTime
                : target.statusEventTime > 0L ? target.statusEventTime : existingLatest;
        tracks = WorkerStatusProjection.attach(tracks, result.workerStatus);
        // 状态跟着摘要走（终态等结构化状态是摘要给的），头条/时间/节点保留详情。
        return new ExpressQueryResult(
                result.waybill, result.courierCode, result.companyName, result.semantic,
                statusEventTime, target.latestTime, target.latestDetail, tracks,
                result.detailUrl, result.phone, result.timelineProvider,
                result.routeInterface, result.routeCredential, result.sourceProvider,
                result.carrierNormalization)
                .withCarrierIdentityEvidence(result.carrierIdentityEvidence)
                .withManualStatusEvidence(
                        result.statusDescription, result.structuredStatusEvidence);
    }

    private static void putAutomaticOwnership(
            SQLiteDatabase db, String normalized, String provider,
            String phone, String bindingGeneration, long rowId,
            long claimedAt, long lastObservedAt, int missCount,
            String releaseReason, long cooldownUntil, boolean displayFrozen) {
        ContentValues values = new ContentValues();
        values.put("normalized_waybill", normalized);
        values.put("owner_provider", clean(provider).isEmpty()
                ? "" : ExpressSourcePolicy.source(provider));
        values.put("owner_phone", clean(phone));
        values.put("owner_binding_generation", clean(bindingGeneration));
        values.put("owner_row_id", rowId);
        values.put("claimed_at", claimedAt);
        values.put("last_observed_at", lastObservedAt);
        values.put("miss_count", Math.max(0, missCount));
        values.put("release_reason", clean(releaseReason));
        values.put("cooldown_until", cooldownUntil);
        values.put("display_frozen", displayFrozen ? 1 : 0);
        if (db.insertWithOnConflict(
                ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, null, values,
                SQLiteDatabase.CONFLICT_REPLACE) < 0L) {
            throw new IllegalStateException("Automatic ownership persistence failed");
        }
    }

    private ExpressItem findAnyRawByIdentity(SQLiteDatabase db, String normalized) {
        AutomaticOwnershipState ownership = automaticOwnershipState(db, normalized);
        if (ownership != null && ownership.ownerRowId > 0L) {
            ExpressItem owner = findRaw(db, ownership.ownerRowId);
            if (owner != null) return owner;
        }
        ExpressItem best = null;
        try (Cursor cursor = db.query(
                ExpressDatabase.EXPRESS_TABLE, null,
                "normalizedMailNo=? AND canShow=1 AND isDeleted=0",
                new String[]{normalized}, null, null, "_id ASC")) {
            while (cursor.moveToNext()) {
                ExpressItem candidate = readRaw(cursor, OrderProjection.EMPTY);
                if (candidate.manuallyAdded) return candidate;
                if (best == null || winsCanonical(candidate, best)) best = candidate;
            }
        }
        if (best != null) return best;
        try (Cursor cursor = db.query(
                ExpressDatabase.ORDER_PROJECTION_TABLE,
                new String[]{"normalized_source_id", "binding_source"},
                "normalized_display_waybill=?", new String[]{normalized},
                null, null, "updated_at DESC", "1")) {
            if (!cursor.moveToFirst()) return null;
            String source = text(cursor, "normalized_source_id");
            try (Cursor owner = db.query(
                    ExpressDatabase.EXPRESS_TABLE, null,
                    "normalizedMailNo=? AND canShow=1 AND isDeleted=0",
                    new String[]{source}, null, null, "_id DESC", "1")) {
                return owner.moveToFirst()
                        ? readRaw(owner, OrderProjection.EMPTY) : null;
            }
        }
    }

    /** Records a schema-valid account refresh; request failures must never call this method. */
    public void recordAutomaticRefreshExecuted(
            String ownerProvider, Map<String, Set<String>> seenByGeneration,
            long completedAt) {
        String provider = AutomaticOwnershipPolicy.providerForPackageOwner(ownerProvider);
        if (provider.isEmpty()) return;
        long now = Math.max(1L, completedAt);
        ArrayList<ExpressItem[]> changes = new ArrayList<>();
        synchronized (this) {
            SQLiteDatabase db = database();
            db.beginTransaction();
            try {
                Map<String, Set<String>> canonicalSeen = new HashMap<>();
                if (seenByGeneration != null) {
                    for (Map.Entry<String, Set<String>> entry
                            : seenByGeneration.entrySet()) {
                        String generation = clean(entry.getKey());
                        if (!generation.isEmpty()) {
                            canonicalSeen.put(generation,
                                    canonicalSeenIdentities(db, entry.getValue()));
                        }
                    }
                }
                ArrayList<AutomaticOwnershipState> owned = new ArrayList<>();
                try (Cursor cursor = db.query(
                        ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, null,
                        "owner_provider=?", new String[]{provider},
                        null, null, null)) {
                    while (cursor.moveToNext()) {
                        owned.add(automaticOwnershipState(cursor));
                    }
                }
                for (AutomaticOwnershipState state : owned) {
                        Set<String> seen = canonicalSeen.get(
                                state.ownerBindingGeneration);
                        if (seen == null) continue;
                        ExpressItem owner = findRaw(db, state.ownerRowId);
                        if (owner == null) continue;
                        if (seen.contains(state.normalizedWaybill)) {
                            putAutomaticOwnership(
                                    db, state.normalizedWaybill, provider,
                                    state.ownerPhone, state.ownerBindingGeneration,
                                    state.ownerRowId,
                                    state.claimedAt, state.lastObservedAt,
                                    0, "", state.cooldownUntil, state.displayFrozen);
                            continue;
                        }
                        ExpressItem displayed = projectTimelineAuthorities(owner);
                        if (displayed != null
                                && displayed.semantic == StatusSemantic.COMPLETED) {
                            putAutomaticOwnership(
                                    db, state.normalizedWaybill, provider,
                                    state.ownerPhone, state.ownerBindingGeneration,
                                    state.ownerRowId,
                                    state.claimedAt, state.lastObservedAt,
                                    0, "", state.cooldownUntil, state.displayFrozen);
                            continue;
                        }
                        AutomaticObservation next = latestQualifiedObservation(
                                db, state.normalizedWaybill, provider,
                                state.ownerBindingGeneration);
                        if (next == null || now < state.cooldownUntil) {
                            putAutomaticOwnership(
                                    db, state.normalizedWaybill, provider,
                                    state.ownerPhone, state.ownerBindingGeneration,
                                    state.ownerRowId,
                                    state.claimedAt, state.lastObservedAt,
                                    1, "misfire_waiting", state.cooldownUntil,
                                    state.displayFrozen);
                            continue;
                        }
                        ExpressItem previous = projectTimelineAuthorities(owner);
                        long rowId = materializeAutomaticPackage(
                                db, owner, next.result, next.phone,
                                next.packageOwner, now, false);
                        boolean frozen = AutomaticOwnershipPolicy.isJingDongSource(
                                next.result.sourceProvider)
                                && next.result.semantic == StatusSemantic.COMPLETED;
                        putAutomaticOwnership(
                                db, state.normalizedWaybill, next.provider,
                                next.phone, next.bindingGeneration, rowId,
                                now, next.observedAt, 0, "",
                                now + AutomaticOwnershipPolicy.TAKEOVER_COOLDOWN_MS,
                                frozen);
                        changes.add(new ExpressItem[]{
                                previous,
                                projectTimelineAuthorities(findRaw(db, rowId))});
                }
                for (ExpressItem[] change : changes) change[1] = stageNotification(db, change[0], change[1]);
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
        if (!changes.isEmpty()) publishChange();
    }

    /** Compatibility helper for tests and callers that refresh every current binding together. */
    public void recordAutomaticRefreshExecuted(
            String ownerProvider, Set<String> seenWaybills, long completedAt) {
        String provider = AutomaticOwnershipPolicy.providerForPackageOwner(ownerProvider);
        String source = ExpressSourcePolicy.bindingSourceForOwner(provider);
        Map<String, Set<String>> byGeneration = new HashMap<>();
        for (String generation : bindingGenerations(source).values()) {
            byGeneration.put(generation, seenWaybills == null
                    ? new HashSet<>() : new HashSet<>(seenWaybills));
        }
        recordAutomaticRefreshExecuted(ownerProvider, byGeneration, completedAt);
    }

    private static Set<String> canonicalSeenIdentities(
            SQLiteDatabase db, Set<String> seenWaybills) {
        HashSet<String> seen = new HashSet<>();
        if (seenWaybills == null) return seen;
        for (String waybill : seenWaybills) {
            String normalized = ExpressSourcePolicy.normalizeWaybill(waybill);
            if (normalized.isEmpty()) continue;
            seen.add(normalized);
            try (Cursor cursor = db.query(
                    ExpressDatabase.ORDER_PROJECTION_TABLE,
                    new String[]{"normalized_display_waybill"},
                    "normalized_source_id=?", new String[]{normalized},
                    null, null, null)) {
                while (cursor.moveToNext()) {
                    String projected = text(cursor, "normalized_display_waybill");
                    if (!projected.isEmpty()) seen.add(projected);
                }
            }
        }
        return seen;
    }

    private static AutomaticObservation latestQualifiedObservation(
            SQLiteDatabase db, String normalized, String excludedProvider,
            String excludedGeneration) {
        try (Cursor cursor = db.query(
                ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE, null,
                "normalized_waybill=? AND qualified=1"
                        + " AND NOT (owner_provider=? AND binding_generation=?)",
                new String[]{normalized, excludedProvider, excludedGeneration}, null, null,
                "observed_at DESC, owner_provider ASC, binding_generation ASC", "1")) {
            return cursor.moveToFirst() ? automaticObservation(cursor) : null;
        }
    }

    private static AutomaticObservation automaticObservation(Cursor cursor) {
        Boolean builtIn = null;
        int storedBuiltIn = (int) number(cursor, "carrier_is_built_in");
        if (storedBuiltIn >= 0) builtIn = storedBuiltIn != 0;
        CarrierNormalization normalization = new CarrierNormalization(
                text(cursor, "carrier_standard_code"),
                text(cursor, "carrier_display_name"),
                text(cursor, "carrier_kuaidi100_code"), builtIn,
                text(cursor, "carrier_table_version"));
        String provider = text(cursor, "owner_provider");
        EncryptedExpressFields.Result routeCredential =
                EncryptedExpressFields.tryDecode(text(cursor, "route_credential"));
        ExpressQueryResult result = new ExpressQueryResult(
                text(cursor, "waybill"), text(cursor, "courier_code"),
                text(cursor, "company_name"),
                StatusSemantic.fromStored(text(cursor, "status_code"), ""),
                number(cursor, "status_event_time"),
                text(cursor, "latest_time"), text(cursor, "latest_detail"),
                text(cursor, "tracks_json"),
                routeCredential.available ? text(cursor, "detail_url") : "",
                text(cursor, "phone"), text(cursor, "binding_source"),
                routeCredential.available ? text(cursor, "route_interface") : "",
                routeCredential.available ? routeCredential.value : "",
                text(cursor, "source_provider"), normalization)
                .withAccountListMetadata(text(cursor, "sender_phone"), number(cursor, "list_origin_at_ms"));
        return new AutomaticObservation(
                provider, text(cursor, "binding_generation"),
                text(cursor, "package_owner"), text(cursor, "phone"),
                number(cursor, "observed_at"), result);
    }

    private static final class AutomaticObservation {
        final String provider;
        final String bindingGeneration;
        final String packageOwner;
        final String phone;
        final long observedAt;
        final ExpressQueryResult result;

        AutomaticObservation(
                String provider, String bindingGeneration,
                String packageOwner, String phone,
                long observedAt, ExpressQueryResult result) {
            this.provider = ExpressSourcePolicy.source(provider);
            this.bindingGeneration = clean(bindingGeneration);
            this.packageOwner = ExpressSourcePolicy.source(packageOwner);
            this.phone = clean(phone);
            this.observedAt = observedAt;
            this.result = result;
        }
    }

    private void saveQuery(
            ExpressQueryResult result, String phone, String source,
            boolean forceFallback, boolean manuallyAdded,
            boolean persistSourceProvider) {
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
        ExpressQueryResult packageResult = result;
        StatusSemantic incomingSemantic = result.workerStatus != null ? result.semantic : ExpressStatusNormalizer.normalize(
                incomingOwner, result.semantic.storageCode,
                result.semantic.label, result.latestDetail);
        boolean hasIncomingHeadline = !ExpressStatusNormalizer.isHeadlinePlaceholder(
                result.latestDetail, incomingSemantic);
        long incomingEventTime = result.workerStatus != null || result.statusEventTime > 0L
                ? result.statusEventTime
                : ExpressSourcePolicy.parseEventTime(result.latestTime);
        ExpressItem previous;
        ExpressItem previousPresented;
        ExpressItem saved;
        synchronized (this) {
            SQLiteDatabase db = database();
            db.beginTransaction();
            try {
                // Association matching happens before this transaction. Recheck the binding here
                // so an unbind that won that race cannot be followed by a late account write.
                if (isAutomaticAccountOwner(incomingOwner)
                        && rejectsUnboundAutomaticWrite(
                                db, normalized, incomingBindingSource, phone)) return;
                previous = findRawByWaybill(result.waybill, incomingBindingSource);
                previousPresented = projectTimelineAuthorities(previous);
                ContentValues values = new ContentValues();
                String currentOwner = previous == null ? ""
                        : previous.stateOwner.isEmpty() ? previous.source : previous.stateOwner;
                StatusSemantic previousSourceSemantic = previous == null
                        ? StatusSemantic.UNKNOWN : previous.sourceSemantic;
                long currentEventTime = previous == null ? 0L : previous.statusEventTime;
                ExpressQueryResult storedPackage = sourcePackage(previous);
                if (previous != null
                        && !ExpressSourcePolicy.isAccountOrderOwner(currentOwner)
                        && ExpressSourcePolicy.source(currentOwner).equals(incomingOwner)
                        && sourceProviderCompatible(
                                incomingOwner,
                                previous.sourceProvider, result.sourceProvider)
                        && Kuaidi100TimelinePolicy.isCompletedTimedPackage(storedPackage)) {
                    packageResult = Kuaidi100TimelinePolicy.merge(storedPackage, result);
                    incomingSemantic = packageResult.workerStatus != null ? packageResult.semantic : ExpressStatusNormalizer.normalize(
                            incomingOwner, packageResult.semantic.storageCode,
                            packageResult.semantic.label, packageResult.latestDetail);
                    hasIncomingHeadline = !ExpressStatusNormalizer.isHeadlinePlaceholder(
                            packageResult.latestDetail, incomingSemantic);
                    incomingEventTime = packageResult.workerStatus != null || packageResult.statusEventTime > 0L
                            ? packageResult.statusEventTime
                            : ExpressSourcePolicy.parseEventTime(packageResult.latestTime);
                } else if (shouldMergeRouteLessInterface5History(
                        previous, currentOwner, incomingOwner, result)) {
                    packageResult = withMergedSourceHistory(storedPackage, result);
                    incomingSemantic = packageResult.workerStatus != null ? packageResult.semantic : ExpressStatusNormalizer.normalize(
                            incomingOwner, packageResult.semantic.storageCode,
                            packageResult.semantic.label, packageResult.latestDetail);
                    hasIncomingHeadline = !ExpressStatusNormalizer.isHeadlinePlaceholder(
                            packageResult.latestDetail, incomingSemantic);
                    incomingEventTime = packageResult.workerStatus != null || packageResult.statusEventTime > 0L
                            ? packageResult.statusEventTime
                            : ExpressSourcePolicy.parseEventTime(packageResult.latestTime);
                }
                boolean terminalTransition = previous != null
                        && previousSourceSemantic.terminal()
                        && previousSourceSemantic != incomingSemantic;
                boolean fallbackFillsUnknown = forceFallback && previous != null
                        && previousSourceSemantic == StatusSemantic.UNKNOWN
                        && incomingSemantic != StatusSemantic.UNKNOWN;
                boolean applyState = previous == null
                        || (fallbackFillsUnknown && !terminalTransition)
                        || ExpressSourcePolicy.shouldApplyState(
                                currentOwner, previousSourceSemantic, currentEventTime,
                                incomingOwner, incomingSemantic, incomingEventTime);
                if (previous != null && currentOwner.equals(incomingOwner)
                        && previousSourceSemantic == incomingSemantic) {
                    WorkerStatusProjection oldStatus = WorkerStatusProjection.cached(previous.tracksJson);
                    int oldPriority = oldStatus != null && oldStatus.matches(previousSourceSemantic, currentEventTime)
                            ? oldStatus.priority : 0;
                    int newPriority = WorkerStatusProjection.priority(packageResult);
                    if (oldPriority != newPriority) applyState = newPriority > oldPriority;
                }
                boolean rejectedTerminalTransition = terminalTransition && !applyState;
                boolean fallbackFillsHeadline = forceFallback && previous != null
                        && ExpressStatusNormalizer.isHeadlinePlaceholder(
                                previous.latestDetail, previousSourceSemantic)
                        && (incomingEventTime <= 0L || currentEventTime <= 0L
                                || incomingEventTime >= currentEventTime);
                boolean applyHeadline = hasIncomingHeadline && !rejectedTerminalTransition
                        && (previous == null
                        || fallbackFillsHeadline
                        || ExpressSourcePolicy.shouldApplyHeadline(
                                currentOwner, currentEventTime,
                                incomingOwner, incomingEventTime));

                values.put("subPhone", clean(phone).isEmpty() && previous != null
                        ? previous.phone : clean(phone));
                values.put("mailNo", clean(result.waybill));
                values.put("normalizedMailNo", normalized);
                if (shouldPersistSourceProvider(
                        incomingOwner, persistSourceProvider, result.sourceProvider)) {
                    values.put("data1", clean(result.sourceProvider));
                }
                values.put("data3", manuallyAdded ? "manual" : "");
                if (previous == null || ExpressSourcePolicy.SOURCE_INTERFACE5.equals(incomingOwner)
                        || ExpressSourcePolicy.SOURCE_INTERFACE6.equals(incomingOwner)
                        || ExpressSourcePolicy.SOURCE_INTERFACE5_JD.equals(incomingOwner)) {
                    values.put("cpCode", clean(packageResult.courierCode));
                    values.put("cpName", CarrierRegistry.companyName(
                            packageResult.courierCode, packageResult.companyName));
                    CarrierNormalization normalization = result.carrierNormalization.present()
                            ? result.carrierNormalization : packageResult.carrierNormalization;
                    if (normalization.present()) {
                        values.put("carrierStandardCode", normalization.standardCode);
                        values.put("carrierDisplayName", normalization.displayName);
                        values.put("carrierKuaidi100Code", normalization.kuaidi100Code);
                        values.put("carrierIsBuiltIn", normalization.builtIn == null
                                ? -1 : normalization.builtIn ? 1 : 0);
                        values.put("carrierTableVersion", normalization.tableVersion);
                    } else if (previous != null
                            && !clean(previous.courierCode).equalsIgnoreCase(
                            clean(packageResult.courierCode))) {
                        values.put("carrierStandardCode", "");
                        values.put("carrierDisplayName", "");
                        values.put("carrierKuaidi100Code", "");
                        values.put("carrierIsBuiltIn", -1);
                        values.put("carrierTableVersion", "");
                    }
                    values.put("data2", CarrierRegistry.localIconUri(
                            context,
                            normalization.recognized()
                                    ? normalization.standardCode : packageResult.courierCode,
                            normalization.recognized()
                                    ? normalization.displayName : packageResult.companyName));
                }
                if (applyState) {
                    values.put("logsiticsStatus", incomingSemantic.storageCode);
                    values.put("logisticsStatusDesc", packageResult.workerStatus == null
                            ? incomingSemantic.label : packageResult.workerStatus.text);
                    values.put("statusEventTime", incomingEventTime);
                    values.put("stateOwner", incomingOwner);
                    values.put("fromCp", incomingOwner);
                }
                if (applyHeadline) {
                    values.put("lastLogisticDetail", clean(packageResult.latestDetail));
                    values.put("logisticsGmtModified", clean(packageResult.latestTime));
                    values.put("packageDyn", WorkerStatusProjection.attach(clean(packageResult.tracksJson),
                            applyState ? packageResult.workerStatus
                                    : previous == null ? null : WorkerStatusProjection.cached(previous.tracksJson)));
                }
                if (applyState && !applyHeadline && packageResult.workerStatus != null) {
                    values.put("packageDyn", WorkerStatusProjection.attach(
                            previous == null ? "[]" : previous.tracksJson, packageResult.workerStatus));
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
                saved = projectTimelineAuthorities(
                        findRawByWaybill(result.waybill, incomingBindingSource));
                saved = stageNotification(db, previousPresented, saved);
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
        publishChange();
    }

    private static boolean shouldMergeRouteLessInterface5History(
            ExpressItem previous, String currentOwner, String incomingOwner,
            ExpressQueryResult refreshed) {
        if (previous == null || refreshed == null || previous.manuallyAdded
                || previous.isInterface5ShunFengSource()
                || previous.usesInterface5AccountTimeline()
                || !ExpressSourcePolicy.SOURCE_INTERFACE5.equals(incomingOwner)
                || !ExpressSourcePolicy.SOURCE_INTERFACE5.equals(
                        ExpressSourcePolicy.source(currentOwner))
                || !clean(previous.detailUrl).isEmpty()
                || !clean(refreshed.detailUrl).isEmpty()) return false;
        String cachedProvider = clean(previous.sourceProvider);
        String refreshedProvider = clean(refreshed.sourceProvider);
        return !cachedProvider.isEmpty() && !refreshedProvider.isEmpty()
                && cachedProvider.equalsIgnoreCase(refreshedProvider);
    }

    private static boolean sourceProviderCompatible(
            String owner, String cached, String refreshed) {
        String cachedProvider = clean(cached);
        String refreshedProvider = clean(refreshed);
        if (ExpressSourcePolicy.SOURCE_INTERFACE5.equals(
                ExpressSourcePolicy.source(owner))) {
            return !cachedProvider.isEmpty() && !refreshedProvider.isEmpty()
                    && cachedProvider.equalsIgnoreCase(refreshedProvider);
        }
        return cachedProvider.isEmpty() || refreshedProvider.isEmpty()
                || cachedProvider.equalsIgnoreCase(refreshedProvider);
    }

    /** Feed increments preserve incoming presentation and union only their own history. */
    private static ExpressQueryResult withMergedSourceHistory(
            ExpressQueryResult cached, ExpressQueryResult refreshed) {
        if (cached == null || refreshed == null) return refreshed;
        return new ExpressQueryResult(
                refreshed.waybill, refreshed.courierCode, refreshed.companyName,
                refreshed.semantic, refreshed.statusEventTime,
                refreshed.latestTime, refreshed.latestDetail,
                WorkerStatusProjection.attach(ExpressTimeline.mergeJson(cached.tracksJson, refreshed.tracksJson),
                        refreshed.workerStatus),
                refreshed.detailUrl, refreshed.phone, refreshed.timelineProvider,
                refreshed.routeInterface, refreshed.routeCredential,
                refreshed.sourceProvider, refreshed.carrierNormalization)
                .withCarrierIdentityEvidence(refreshed.carrierIdentityEvidence)
                .withManualStatusEvidence(
                        refreshed.statusDescription, refreshed.structuredStatusEvidence);
    }

    private static ExpressQueryResult sourcePackage(ExpressItem value) {
        if (value == null) return null;
        String owner = value.stateOwner.isEmpty() ? value.source : value.stateOwner;
        return new ExpressQueryResult(
                value.waybill, value.courierCode, value.companyName,
                value.sourceSemantic, value.statusEventTime,
                value.latestTime, value.latestDetail, value.tracksJson,
                value.detailUrl, value.phone,
                ExpressSourcePolicy.bindingSourceForOwner(owner), value.routeInterface,
                value.routeCredential, value.sourceProvider, value.carrierNormalization)
                .withAccountListMetadata(value.senderPhone, value.listOriginAtMs);
    }

    private ExpressQueryResult cleanJdAutomaticPacket(ExpressQueryResult result, String ownerSource) {
        if (result == null || !AutomaticOwnershipPolicy.isJingDongSource(result.sourceProvider)
                || !"interface5".equals(ExpressSourcePolicy.bindingSourceForOwner(ownerSource))) {
            return result;
        }
        boolean order = ExpressSourcePolicy.isAccountOrderOwner(ownerSource);
        if (order && orderProjection(result.waybill, "interface5").waybill.isEmpty()) return result;
        return JingDongOrderCompletionPolicy.clean(result, order ? result.waybill : "");
    }

    private ExpressQueryResult cleanJdQuery(ExpressQueryResult result) {
        if (result == null) return null;
        ExpressItem owner = findRawByWaybill(result.waybill, "interface5");
        if (owner == null) {
            List<ExpressItem> projected = projectedOrderOwnersForTimeline(result.waybill);
            for (ExpressItem candidate : projected) {
                if (isProjectedJdParcel(candidate)) {
                    owner = candidate;
                    break;
                }
            }
        }
        return cleanJdTimeline(result, owner);
    }

    private static boolean isProjectedJdParcel(ExpressItem owner) {
        if (owner == null || owner.manuallyAdded
                || !AutomaticOwnershipPolicy.isJingDongSource(owner.sourceProvider)) return false;
        String source = owner.stateOwner.isEmpty() ? owner.source : owner.stateOwner;
        return "interface5".equals(ExpressSourcePolicy.bindingSourceForOwner(source))
                && !owner.displayWaybill().isEmpty()
                && (!owner.isAccountOrder() || !owner.projectedWaybill.isEmpty());
    }

    private static ExpressQueryResult cleanJdTimeline(ExpressQueryResult result, ExpressItem owner) {
        if (!isProjectedJdParcel(owner)) return result;
        return JingDongOrderCompletionPolicy.clean(
                result, owner.isAccountOrder() ? owner.waybill : "");
    }

    private static ManualTimelineAuthorityPolicy.Candidate cleanJdCandidate(
            ManualTimelineAuthorityPolicy.Candidate candidate, ExpressItem owner) {
        if (candidate == null) return null;
        if (isForeignManualPackage(owner, candidate.result)) return null;
        ExpressQueryResult cleaned = cleanJdTimeline(candidate.result, owner);
        return cleaned == candidate.result ? candidate : new ManualTimelineAuthorityPolicy.Candidate(
                candidate.provider, cleaned, candidate.successAt,
                candidate.complete && Kuaidi100TimelinePolicy.hasTimedTracking(cleaned),
                candidate.providerErrorMetadataInvalidated);
    }

    private static ExpressItem cleanJdOwner(ExpressItem owner) {
        if (!isProjectedJdParcel(owner)) return owner;
        ExpressQueryResult original = sourcePackage(owner);
        ExpressQueryResult clean = cleanJdTimeline(original, owner);
        if (clean == original) return owner;
        long retainedAt = owner.signedRetainedAt;
        if (JingDongOrderCompletionPolicy.containsAt(
                original, owner.isAccountOrder() ? owner.waybill : "", retainedAt)) {
            retainedAt = clean.semantic == StatusSemantic.COMPLETED ? clean.statusEventTime : 0L;
        }
        return new ExpressItem(owner.rowId, owner.phone, owner.waybill, owner.courierCode,
                owner.companyName, clean.semantic, clean.statusDescription, clean.latestDetail,
                clean.latestTime, clean.tracksJson, owner.remark, owner.source, owner.detailUrl,
                clean.statusEventTime, owner.updatedAt, owner.stateOwner, owner.routeOwner,
                owner.routeInterface, owner.routeCredential, owner.routeCredentialAvailable,
                owner.projectedWaybill, owner.projectedCompanyName, owner.projectedTracksJson,
                owner.sourceProvider, owner.manuallyAdded, owner.manualTimelineProvider,
                owner.manualTimelineSuccessAt, clean.semantic, owner.carrierNormalization,
                retainedAt);
    }

    public void delete(long rowId) {
        ArrayList<Long> removedRows = new ArrayList<>();
        synchronized (this) {
            SQLiteDatabase db = database();
            db.beginTransaction();
            try {
                ExpressItem target = find(rowId);
                if (target != null) {
                    String normalized = ExpressSourcePolicy.normalizeWaybill(target.waybill);
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
        publishChange();
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
        try (Cursor cursor = database().query(
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

    /** Queues a new manual waybill without turning display recognition into raw carrier data. */
    public boolean enqueuePendingManual(
            String waybill, String phone, String bindingSource) {
        return enqueuePendingManual(new ExpressQueryResult(
                        waybill, "", "", StatusSemantic.UNKNOWN,
                        "", "", "[]", "", phone, ""),
                phone, bindingSource);
    }

    /** Retains the first durable namespace while keeping one hidden query across account toggles. */
    public boolean enqueuePendingManual(
            ExpressQueryResult result, String phone, String bindingSource) {
        if (result == null || Kuaidi100TimelinePolicy.hasTimedTracking(result)) return false;
        String normalized = ExpressSourcePolicy.normalizeWaybill(result.waybill);
        if (normalized.isEmpty()) return false;
        String selectedBindingSource = normalizeBindingSource(bindingSource);
        String incomingRouteCredential = clean(result.routeCredential);
        EncryptedExpressFields.Result encryptedIncomingRoute =
                EncryptedExpressFields.tryEncode(incomingRouteCredential);
        long now = System.currentTimeMillis();
        synchronized (this) {
            SQLiteDatabase db = database();
            db.beginTransaction();
            try {
                if (findByWaybill(result.waybill, selectedBindingSource) != null) {
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
                        new String[]{"binding_source", "created_at", "courier_code", "company_name",
                                "phone", "detail_url", "route_interface", "route_credential"},
                        "normalized_waybill=?", new String[]{normalized},
                        null, null, "created_at ASC")) {
                    while (cursor.moveToNext()) {
                        long storedCreatedAt = cursor.getLong(1);
                        if (isPendingQueryExpired(storedCreatedAt, now)) continue;
                        selectedBindingSource = normalizeBindingSource(cursor.getString(0));
                        createdAt = storedCreatedAt;
                        queuedCourier = clean(cursor.getString(2));
                        queuedCompany = clean(cursor.getString(3));
                        queuedPhone = clean(cursor.getString(4));
                        queuedDetailUrl = clean(cursor.getString(5));
                        queuedRouteInterface = clean(cursor.getString(6));
                        queuedStoredRouteCredential = clean(cursor.getString(7));
                        break;
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
                db.delete(ExpressDatabase.KUAIDI100_PENDING_TABLE,
                        "normalized_waybill=? AND LOWER(binding_source)<>?",
                        new String[]{normalized, selectedBindingSource});
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

    /** Claims hidden manual items independently from the currently selected automatic interface. */
    public synchronized List<PendingExpressQuery> claimPendingManualQueries(
            long now, String bindingSource) {
        ArrayList<PendingExpressQuery> due = new ArrayList<>();
        SQLiteDatabase db = database();
        db.beginTransaction();
        try {
            maintainPendingQueryClocks(db, now);
            try (Cursor cursor = db.query(
                ExpressDatabase.KUAIDI100_PENDING_TABLE, null,
                null, null,
                null, null, "created_at ASC")) {
                while (cursor.moveToNext() && due.size() < PENDING_QUERY_BATCH_SIZE) {
                    long lastAttempt = number(cursor, "last_attempt_at");
                    if (!isPendingQueryDue(lastAttempt, now)) continue;
                    String normalized = text(cursor, "normalized_waybill");
                    String storedBindingSource = normalizeBindingSource(
                            text(cursor, "binding_source"));
                    EncryptedExpressFields.Result routeCredential =
                            EncryptedExpressFields.tryDecode(text(cursor, "route_credential"));
                    if (!routeCredential.available) continue;
                    PendingExpressQuery query = new PendingExpressQuery(
                            text(cursor, "waybill"), text(cursor, "courier_code"),
                            text(cursor, "company_name"), text(cursor, "phone"),
                            text(cursor, "binding_source"),
                            text(cursor, "detail_url"), text(cursor, "route_interface"),
                            routeCredential.value,
                            number(cursor, "created_at"), now);
                    ContentValues values = new ContentValues();
                    values.put("last_attempt_at", now);
                    values.put("updated_at", now);
                    if (db.update(ExpressDatabase.KUAIDI100_PENDING_TABLE, values,
                            "normalized_waybill=? AND LOWER(binding_source)=?",
                            new String[]{normalized, storedBindingSource}) > 0) {
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
        database().delete(
                ExpressDatabase.KUAIDI100_PENDING_TABLE,
                "normalized_waybill=?", new String[]{normalized});
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
            SQLiteDatabase db = database();
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
                    values.put("uuid", UUID.randomUUID().toString());
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
        publishChange();
    }

    /** Captures the exact account generations that one network request is authorized to write. */
    public synchronized Map<String, String> bindingGenerations(String syncSource) {
        String source = normalizeBindingSource(syncSource);
        LinkedHashMap<String, String> result = new LinkedHashMap<>();
        SQLiteDatabase db = database();
        try (Cursor cursor = db.query(
                ExpressDatabase.PHONE_TABLE, new String[]{"phone", "uuid"},
                "LOWER(sync_status)=?", new String[]{source},
                null, null, "bind_time ASC, _id ASC")) {
            while (cursor.moveToNext()) {
                String phone = clean(cursor.getString(0));
                String generation = clean(cursor.getString(1));
                if (!phone.isEmpty() && !generation.isEmpty()) {
                    result.put(normalizePhoneDigits(phone), generation);
                }
            }
        }
        return result;
    }

    public synchronized String bindingGeneration(String phone, String syncSource) {
        return bindingGeneration(
                database(), phone, normalizeBindingSource(syncSource));
    }

    private static String bindingGeneration(
            SQLiteDatabase db, String phone, String bindingSource) {
        String target = normalizePhoneDigits(phone);
        if (target.isEmpty()) return "";
        String suffix = "";
        int suffixCount = 0;
        try (Cursor cursor = db.query(
                ExpressDatabase.PHONE_TABLE, new String[]{"phone", "uuid"},
                "LOWER(sync_status)=?", new String[]{normalizeBindingSource(bindingSource)},
                null, null, null)) {
            while (cursor.moveToNext()) {
                String bound = normalizePhoneDigits(cursor.getString(0));
                if (target.equals(bound)) {
                    return clean(cursor.getString(1));
                }
                if (target.length() >= 4 && bound.endsWith(target)) {
                    suffix = clean(cursor.getString(1));
                    suffixCount++;
                }
            }
        }
        return suffixCount == 1 ? suffix : "";
    }

    private static boolean isCurrentBindingGeneration(
            SQLiteDatabase db, String phone, String bindingSource, String generation) {
        String expected = clean(generation);
        return !expected.isEmpty()
                && expected.equals(bindingGeneration(db, phone, bindingSource));
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
        ArrayList<ExpressItem[]> changes = new ArrayList<>();
        synchronized (this) {
            SQLiteDatabase db = database();
            db.beginTransaction();
            try {
                ArrayList<BindingRecord> removedBindings = new ArrayList<>();
                try (Cursor cursor = db.query(ExpressDatabase.PHONE_TABLE,
                        new String[]{"phone", "sync_status", "uuid"},
                        bindingSource.isEmpty() ? null : "LOWER(sync_status)=?",
                        bindingSource.isEmpty() ? null : new String[]{bindingSource},
                        null, null, null)) {
                    while (cursor.moveToNext()) {
                        String boundPhone = clean(cursor.getString(0));
                        if (!targetDigits.equals(normalizePhoneDigits(boundPhone))) continue;
                        removedBindings.add(new BindingRecord(
                                boundPhone, normalizeBindingSource(cursor.getString(1)),
                                clean(cursor.getString(2))));
                    }
                }
                long now = Math.max(1L, System.currentTimeMillis());
                for (BindingRecord removed : removedBindings) {
                    ArrayList<String> identities = new ArrayList<>();
                    try (Cursor cursor = db.query(
                            ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                            new String[]{"normalized_waybill"},
                            "binding_source=? AND binding_generation=?",
                            new String[]{removed.source, removed.generation},
                            null, null, null)) {
                        while (cursor.moveToNext()) {
                            String normalized = clean(cursor.getString(0));
                            if (!normalized.isEmpty() && !identities.contains(normalized)) {
                                identities.add(normalized);
                            }
                        }
                    }
                    db.delete(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                            "binding_source=? AND binding_generation=?",
                            new String[]{removed.source, removed.generation});
                    for (String normalized : identities) {
                        insertUnboundPhoneAssociation(
                                db, normalized, removed.source, targetDigits);
                    }
                    db.delete(ExpressDatabase.KUAIDI100_PENDING_TABLE,
                            "LOWER(binding_source)=? AND phone=?",
                            new String[]{removed.source, removed.phone});

                    ArrayList<AutomaticOwnershipState> invalidated = new ArrayList<>();
                    try (Cursor cursor = db.query(
                            ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, null,
                            "owner_binding_generation=?",
                            new String[]{removed.generation}, null, null, null)) {
                        while (cursor.moveToNext()) {
                            invalidated.add(automaticOwnershipState(cursor));
                        }
                    }
                    for (AutomaticOwnershipState state : invalidated) {
                        ExpressItem owner = findRaw(db, state.ownerRowId);
                        if (owner == null) continue;
                        ExpressItem previous = projectTimelineAuthorities(owner);
                        AutomaticObservation next = latestQualifiedObservation(
                                db, state.normalizedWaybill,
                                state.ownerProvider, state.ownerBindingGeneration);
                        if (next == null) {
                            putAutomaticOwnership(
                                    db, state.normalizedWaybill, "", "", "",
                                    state.ownerRowId, state.claimedAt,
                                    state.lastObservedAt, 0, "binding_invalidated",
                                    state.cooldownUntil, state.displayFrozen);
                        } else {
                            long rowId = materializeAutomaticPackage(
                                    db, owner, next.result, next.phone,
                                    next.packageOwner, now, false);
                            boolean frozen = AutomaticOwnershipPolicy.isJingDongSource(
                                    next.result.sourceProvider)
                                    && next.result.semantic == StatusSemantic.COMPLETED;
                            putAutomaticOwnership(
                                    db, state.normalizedWaybill, next.provider,
                                    next.phone, next.bindingGeneration, rowId,
                                    now, next.observedAt, 0, "", state.cooldownUntil,
                                    frozen);
                        }
                        changes.add(new ExpressItem[]{previous,
                                projectTimelineAuthorities(findRaw(db, state.ownerRowId))});
                    }
                    db.delete(ExpressDatabase.PHONE_TABLE,
                            "phone=? AND LOWER(sync_status)=?",
                            new String[]{removed.phone, removed.source});
                }
                for (ExpressItem[] change : changes) change[1] = stageNotification(db, change[0], change[1]);
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
        publishChange();
    }

    private static final class BindingRecord {
        final String phone;
        final String source;
        final String generation;

        BindingRecord(String phone, String source, String generation) {
            this.phone = clean(phone);
            this.source = normalizeBindingSource(source);
            this.generation = clean(generation);
        }
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
        SQLiteDatabase db = database();
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
        SQLiteDatabase db = database();
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
        SQLiteDatabase db = database();
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

    /** Resolve legacy source/manual presentation before any refresh can advance updatedAt. */
    private void initializeSignedRetentionAnchors() {
        SQLiteDatabase db = database();
        db.beginTransaction();
        try (Cursor cursor = db.query(ExpressDatabase.EXPRESS_TABLE, null,
                "COALESCE(signedRetainedAt,0)=0 AND canShow=1 AND isDeleted=0",
                null, null, null, null)) {
            long now = System.currentTimeMillis();
            while (cursor.moveToNext()) anchorSignedRetention(db, read(cursor), now);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    private static ExpressItem anchorSignedRetention(
            SQLiteDatabase db, ExpressItem item, long now) {
        if (item == null || item.signedRetainedAt > 0L
                || item.semantic != StatusSemantic.COMPLETED) return item;
        long anchor = ExpressLifecycleTimes.signedEvidenceAt(item, null, now);
        if (anchor <= 0L) anchor = Math.max(1L, now);
        ContentValues values = new ContentValues();
        values.put("signedRetainedAt", anchor);
        int changed = db.update(ExpressDatabase.EXPRESS_TABLE, values,
                "_id=? AND COALESCE(signedRetainedAt,0)=0",
                new String[]{Long.toString(item.rowId)});
        if (changed == 0) {
            try (Cursor cursor = db.query(ExpressDatabase.EXPRESS_TABLE,
                    new String[]{"signedRetainedAt"}, "_id=?",
                    new String[]{Long.toString(item.rowId)}, null, null, null)) {
                if (!cursor.moveToFirst()) return item;
                anchor = cursor.getLong(0);
            }
        }
        return item.withSignedRetainedAt(anchor);
    }

    /** Store the obligation in the same transaction as its visible business change. */
    private ExpressItem stageNotification(SQLiteDatabase db, ExpressItem previous, ExpressItem current) {
        if (!db.inTransaction()) throw new IllegalStateException("Notification requires transaction");
        current = anchorSignedRetention(db, current, System.currentTimeMillis());
        if (changeBatch.get().depth > 0 && previous == null && current != null) {
            changeBatch.get().firstSeenRows.add(current.rowId);
        }
        if (ExpressVisibilityPolicy.isHiddenSigned(current, System.currentTimeMillis())
                || !ExpressNotifications.shouldPostUpdate(previous, current)) return current;
        if (changeBatch.get().depth > 0 && changeBatch.get().firstSeenRows.contains(current.rowId)) {
            ExpressLog.notificationSkipped(current, "first_seen_in_batch");
            return current;
        }
        ExpressLog.notificationDecided(previous, current, changeBatch.get().depth > 0);
        ContentValues values = new ContentValues();
        values.put("owner_row_id", current.rowId);
        values.put("event_token", UUID.randomUUID().toString());
        if (db.insertWithOnConflict(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null,
                values, SQLiteDatabase.CONFLICT_REPLACE) < 0L) {
            throw new IllegalStateException("Notification persistence failed");
        }
        return current;
    }

    private void publishChange() {
        synchronized (this) {
            if (changeBatch.get().depth > 0) {
                changeBatch.get().invalidationPending = true;
                return;
            }
        }
        replayPendingNotifications();
        emitInvalidation();
    }

    private void finishChangeBatch() {
        boolean invalidate;
        synchronized (this) {
            if (changeBatch.get().depth <= 0) return;
            changeBatch.get().depth--;
            if (changeBatch.get().depth > 0) return;
            invalidate = changeBatch.get().invalidationPending;
            changeBatch.get().invalidationPending = false;
            changeBatch.get().firstSeenRows.clear();
        }
        replayPendingNotifications();
        if (invalidate) emitInvalidation();
    }

    /** Replays the latest committed presentation per row, using its stable Android notification ID. */
    public synchronized void replayPendingNotifications() {
        if (changeBatch.get().depth > 0) return;
        SQLiteDatabase db = database();
        LinkedHashMap<Long, String> pending = new LinkedHashMap<>();
        try (Cursor cursor = db.query(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE,
                new String[]{"owner_row_id", "event_token"}, null, null, null, null,
                "owner_row_id")) {
            while (cursor.moveToNext()) pending.put(cursor.getLong(0), cursor.getString(1));
        }
        for (Map.Entry<Long, String> event : pending.entrySet()) {
            try {
                ExpressItem current = find(event.getKey());
                // Hidden rows retain their caches, but must not return through a delayed notification.
                if (current != null && !ExpressVisibilityPolicy.isHiddenSigned(current, System.currentTimeMillis())) {
                    if (!ExpressNotifications.post(context, current)) continue;
                }
                db.delete(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE,
                        "owner_row_id=? AND event_token=?",
                        new String[]{Long.toString(event.getKey()), event.getValue()});
            } catch (RuntimeException failure) {
                // Keep the row for the next process startup or completed sync batch.
                android.util.Log.w("ExpressRepository", "Notification remains pending");
            }
        }
    }

    public synchronized long invalidationVersion() {
        return invalidationVersion;
    }

    private void emitInvalidation() {
        ExpressWidgetProvider.refreshAll(context);
        synchronized (this) { invalidationVersion++; }
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
        return projectTimelineAuthorities(readRaw(cursor));
    }

    private ExpressItem readRaw(Cursor cursor) {
        return readRaw(cursor, (Map<String, OrderProjection>) null);
    }

    private ExpressItem readRaw(
            Cursor cursor, Map<String, OrderProjection> projections) {
        String stateOwner = text(cursor, "stateOwner");
        String normalizedOwner = ExpressSourcePolicy.source(stateOwner.isEmpty()
                ? text(cursor, "fromCp") : stateOwner);
        // The projection is created by an isolated account-order row. Applying it to another
        // source row with the same normalized identity would leak display state across sources.
        OrderProjection projection = OrderProjection.EMPTY;
        if (ExpressSourcePolicy.isAccountOrderOwner(normalizedOwner)) {
            String projectionKey = orderProjectionKey(
                    text(cursor, "mailNo"),
                    ExpressSourcePolicy.bindingSourceForOwner(normalizedOwner));
            projection = projections == null
                    ? orderProjection(text(cursor, "mailNo"),
                    ExpressSourcePolicy.bindingSourceForOwner(normalizedOwner))
                    : projections.getOrDefault(projectionKey, OrderProjection.EMPTY);
        }
        return readRaw(cursor, projection);
    }

    private boolean isBoundSender(String senderPhone, String bindingSource) {
        String sender = normalizePhoneDigits(senderPhone);
        return sender.length() == 11 && !bindingGeneration(sender, bindingSource).isEmpty();
    }

    private ExpressItem readRaw(Cursor cursor, OrderProjection projection) {
        String storedStatus = text(cursor, "logsiticsStatus");
        String statusDescription = text(cursor, "logisticsStatusDesc");
        String source = text(cursor, "fromCp");
        String latestDetail = text(cursor, "lastLogisticDetail");
        String sourceTracksJson = text(cursor, "packageDyn");
        String stateOwner = text(cursor, "stateOwner");
        WorkerStatusProjection projectedStatus = WorkerStatusProjection.cached(sourceTracksJson);
        StatusSemantic sourceSemantic = projectedStatus != null
                && projectedStatus.matches(StatusSemantic.fromStored(storedStatus, ""), number(cursor, "statusEventTime"))
                ? projectedStatus.semantic : ExpressStatusNormalizer.normalize(
                stateOwner.isEmpty() ? source : stateOwner,
                storedStatus, statusDescription, latestDetail);
        String effectiveOwner = stateOwner.isEmpty() ? source : stateOwner;
        String normalizedOwner = ExpressSourcePolicy.source(effectiveOwner);
        if (sourceSemantic == StatusSemantic.UNKNOWN && projectedStatus == null
                && (ExpressSourcePolicy.SOURCE_INTERFACE5_JD.equals(normalizedOwner)
                || ExpressSourcePolicy.SOURCE_LEGACY_ACCOUNT_ORDER.equals(normalizedOwner))) {
            sourceSemantic = ExpressStatusNormalizer.inferAccountOrderStatus(
                    latestDetail, text(cursor, "packageDyn"));
        }
        EncryptedExpressFields.Result routeCredential =
                EncryptedExpressFields.tryDecode(text(cursor, "routeCredential"));
        OrderProjection safeProjection = projection == null
                ? OrderProjection.EMPTY : projection;
        StatusSemantic semantic = ExpressSourcePolicy.accountOrderPresentationSemantic(
                normalizedOwner, safeProjection.waybill, sourceSemantic);
        return repairForeignManualState(database(), cleanJdOwner(new ExpressItem(
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
                sourceTracksJson,
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
                safeProjection.waybill,
                safeProjection.companyName,
                safeProjection.tracksJson,
                text(cursor, "data1"),
                "manual".equals(text(cursor, "data3")),
                "", 0L, sourceSemantic, carrierNormalization(cursor), number(cursor, "signedRetainedAt")))
                .withAccountListMetadata(text(cursor, "senderPhone"), positiveMinimum(
                        number(cursor, "listOriginAtMs"), ExpressTimeline.accountListOriginAtMillis(sourceTracksJson)),
                        !"manual".equals(text(cursor, "data3")) && isBoundSender(
                                text(cursor, "senderPhone"), ExpressSourcePolicy.bindingSourceForOwner(effectiveOwner))));
    }

    private ExpressItem projectManualTimeline(ExpressItem owner) {
        if (owner == null) return null;
        ArrayList<ManualTimelineAuthorityPolicy.Candidate> candidates =
                manualTimelineCandidates(database(), owner);
        return projectManualTimelineForOwner(owner, candidates,
                accountTimeline(owner.waybill, "interface5"));
    }

    private ExpressItem projectTimelineAuthorities(ExpressItem owner) {
        if (owner == null) return null;
        if (owner != null && isAutomaticDisplayFrozen(owner.rowId)) {
            return projectFrozenTimelineAuthorities(owner)
                    .withAccountListMetadata(owner.senderPhone, owner.listOriginAtMs, owner.sender);
        }
        ExpressQueryResult query = owner == null ? null : accountTimeline(owner.waybill, "interface5");
        ExpressItem presented = projectManualTimeline(owner);
        OwnerAttribution cachedOwner = owner == null ? null : accountQueryOwner(database(), owner.waybill);
        boolean sameAccount = cachedOwner != null && cachedOwner.equals(currentOwnerAttribution(database(), owner));
        return restoreAccountActivity(presented,
                sameAccount ? accountQueryPresentation(database(), owner.waybill) : query, sameAccount)
                .withAccountListMetadata(owner.senderPhone, owner.listOriginAtMs, owner.sender);
    }

    /** Replays only the completed package that caused a JD-source display freeze. */
    private ExpressItem projectFrozenTimelineAuthorities(ExpressItem owner) {
        if (owner == null || owner.semantic == StatusSemantic.COMPLETED
                || owner.sourceSemantic == StatusSemantic.COMPLETED) return owner;
        ManualTimelineAuthorityPolicy.Candidate manualAuthority =
                completedCandidate(manualTimelineAuthority(
                        database(), owner));
        return projectManualTimeline(owner, manualAuthority);
    }

    private ExpressItem projectTimelineAuthorities(
            ExpressItem owner, VisibleProjectionSidecars sidecars) {
        if (owner == null) return null;
        ExpressQueryResult query = sidecars.interface5Timelines.get(
                ExpressSourcePolicy.normalizeWaybill(owner.waybill));
        ExpressItem presented = projectManualTimelineForOwner(owner,
                sidecars.manualTimelines.get(manualTimelineKey(owner)), query);
        OwnerAttribution cachedOwner = sidecars.interface5Owners.get(
                ExpressSourcePolicy.normalizeWaybill(owner.waybill));
        boolean sameAccount = cachedOwner != null && cachedOwner.equals(currentOwnerAttribution(database(), owner));
        return restoreAccountActivity(presented, sameAccount ? sidecars.interface5Presentations.get(
                ExpressSourcePolicy.normalizeWaybill(owner.waybill)) : query, sameAccount)
                .withAccountListMetadata(owner.senderPhone, owner.listOriginAtMs, owner.sender);
    }

    private ExpressItem projectManualTimelineForOwner(ExpressItem owner,
            List<ManualTimelineAuthorityPolicy.Candidate> candidates, ExpressQueryResult query) {
        candidates = eligibleManualCandidates(owner, candidates);
        String preferred = preferredDetailProvider(owner);
        ManualTimelineAuthorityPolicy.Candidate statusPresentation =
                ManualTimelineAuthorityPolicy.selectForOwner(candidates, owner.manuallyAdded, preferred);
        ManualTimelineAuthorityPolicy.Candidate displayed = owner.isShunFengSource()
                || isAutomaticAccountOwner(owner.stateOwner.isEmpty() ? owner.source : owner.stateOwner)
                && !Kuaidi100TimelinePolicy.hasTimedTracking(sourcePackage(owner))
                ? selectDetailTimeline(owner, candidates, query, 1L) : null;
        return projectManualTimeline(owner, displayed == null ? statusPresentation : displayed,
                selectStatusAuthority(owner, candidates, query, statusPresentation), statusPresentation);
    }

    /** Account queries join status arbitration without becoming Home timeline candidates. */
    private static ManualTimelineAuthorityPolicy.Candidate selectStatusAuthority(ExpressItem owner,
            List<ManualTimelineAuthorityPolicy.Candidate> manual, ExpressQueryResult query,
            ManualTimelineAuthorityPolicy.Candidate statusPresentation) {
        ArrayList<ManualTimelineAuthorityPolicy.Candidate> candidates = new ArrayList<>();
        if (manual != null) candidates.addAll(manual);
        if (owner != null && !owner.manuallyAdded
                && "interface5".equals(ExpressSourcePolicy.bindingSourceForOwner(
                        owner.stateOwner.isEmpty() ? owner.source : owner.stateOwner))
                && query != null && ExpressSourcePolicy.normalizeWaybill(owner.waybill).equals(
                        ExpressSourcePolicy.normalizeWaybill(query.waybill))) {
            query = cleanJdTimeline(query, owner);
            candidates.add(new ManualTimelineAuthorityPolicy.Candidate(
                    TimelineSlot.V5_QUERY, query, 1L, false));
        }
        boolean preserveSigned = owner != null && owner.signedRetainedAt > 0L;
        if (!preserveSigned && hasOwnedManualStatusPresentation(owner, statusPresentation)) {
            candidates.removeIf(candidate -> candidate == null || candidate.result == null
                    || candidate.result.semantic != statusPresentation.result.semantic);
        }
        return ManualTimelineAuthorityPolicy.selectStructuredStatus(candidates, preserveSigned);
    }

    /** Newer account evidence advances Home without rewriting the independent feed slot. */
    private static ExpressItem restoreAccountActivity(
            ExpressItem owner, ExpressQueryResult query, boolean sameAccount) {
        if (owner == null || owner.manuallyAdded || owner.isShunFengSource()
                || !"interface5".equals(ExpressSourcePolicy.bindingSourceForOwner(
                        owner.stateOwner.isEmpty() ? owner.source : owner.stateOwner))
                || query == null || !ExpressSourcePolicy.normalizeWaybill(owner.waybill).equals(
                        ExpressSourcePolicy.normalizeWaybill(query.waybill))) return owner;
        query = cleanJdTimeline(query, owner);
        ExpressTimeline.Track latest = latestTimedTrack(query);
        boolean takeActivity = latest != null && (owner.latestDetail.isEmpty()
                || sameAccount && ExpressSourcePolicy.parseEventTime(latest.time)
                > ExpressSourcePolicy.parseEventTime(owner.latestTime));
        WorkerStatusProjection ownerStatus = WorkerStatusProjection.cached(owner.tracksJson);
        int ownerPriority = ownerStatus != null && ownerStatus.matches(owner.semantic, owner.statusEventTime)
                ? ownerStatus.priority : 0;
        int queryPriority = WorkerStatusProjection.priority(query);
        boolean sameSemantic = query.semantic == owner.semantic;
        boolean takeStatus = sameAccount && ManualTimelineAuthorityPolicy.hasStructuredStatus(query)
                && (!sameSemantic || queryPriority >= ownerPriority)
                && (query.statusEventTime > owner.statusEventTime || sameSemantic && queryPriority > ownerPriority)
                && !(owner.semantic.terminal() && !query.semantic.terminal());
        if (!takeActivity && !takeStatus) return owner;
        return new ExpressItem(
                owner.rowId, owner.phone, owner.waybill, owner.courierCode, owner.companyName,
                takeStatus ? query.semantic : owner.semantic,
                takeStatus ? query.statusDescription : owner.statusDescription,
                takeActivity ? latest.detail : owner.latestDetail,
                takeActivity ? latest.time : owner.latestTime,
                WorkerStatusProjection.attach(owner.tracksJson, takeStatus ? query.workerStatus
                        : WorkerStatusProjection.cached(owner.tracksJson)),
                owner.remark, owner.source, owner.detailUrl,
                takeStatus ? query.statusEventTime : owner.statusEventTime, owner.updatedAt,
                owner.stateOwner, owner.routeOwner, owner.routeInterface,
                owner.routeCredential, owner.routeCredentialAvailable,
                owner.projectedWaybill, owner.projectedCompanyName, owner.projectedTracksJson,
                owner.sourceProvider, owner.manuallyAdded,
                owner.manualTimelineProvider, owner.manualTimelineSuccessAt, owner.sourceSemantic,
                owner.carrierNormalization, owner.signedRetainedAt);
    }

    private ExpressItem projectFrozenTimelineAuthorities(
            ExpressItem owner, VisibleProjectionSidecars sidecars) {
        if (owner == null || owner.semantic == StatusSemantic.COMPLETED
                || owner.sourceSemantic == StatusSemantic.COMPLETED) return owner;
        ManualTimelineAuthorityPolicy.Candidate authority = completedCandidate(
                ManualTimelineAuthorityPolicy.selectForOwner(eligibleManualCandidates(owner,
                        sidecars.manualTimelines.get(manualTimelineKey(owner))), owner.manuallyAdded));
        return projectManualTimeline(owner, authority);
    }

    private static ManualTimelineAuthorityPolicy.Candidate completedCandidate(
            ManualTimelineAuthorityPolicy.Candidate candidate) {
        return candidate != null && candidate.complete && candidate.result != null
                && candidate.result.semantic == StatusSemantic.COMPLETED ? candidate : null;
    }



    private static String orderProjectionKey(String sourceId, String bindingSource) {
        return ExpressSourcePolicy.normalizeWaybill(sourceId) + '\u0000'
                + normalizeBindingSource(bindingSource);
    }

    private static String manualTimelineKey(ExpressItem owner) {
        if (owner == null) return "";
        String stateOwner = owner.stateOwner.isEmpty() ? owner.source : owner.stateOwner;
        return owner.rowId + "\u0000"
                + ExpressSourcePolicy.normalizeWaybill(owner.displayWaybill()) + "\u0000"
                + ExpressSourcePolicy.bindingSourceForOwner(stateOwner);
    }

    private static String manualTimelineKey(Cursor cursor) {
        return number(cursor, "owner_row_id") + "\u0000"
                + ExpressSourcePolicy.normalizeWaybill(
                text(cursor, "normalized_waybill")) + "\u0000"
                + normalizeBindingSource(text(cursor, "binding_source"));
    }

    private static VisibleProjectionSidecars visibleProjectionSidecars(SQLiteDatabase db) {
        Map<String, OrderProjection> projections = new HashMap<>();
        try (Cursor cursor = db.query(
                ExpressDatabase.ORDER_PROJECTION_TABLE,
                new String[]{"normalized_source_id", "binding_source", "display_waybill",
                        "carrier_name", "tracks_json"},
                null, null, null, null, null)) {
            while (cursor.moveToNext()) {
                projections.put(orderProjectionKey(
                                text(cursor, "normalized_source_id"),
                                text(cursor, "binding_source")),
                        new OrderProjection(text(cursor, "display_waybill"),
                                text(cursor, "carrier_name"), text(cursor, "tracks_json")));
            }
        }
        Map<String, List<ManualTimelineAuthorityPolicy.Candidate>> manual = new HashMap<>();
        try (Cursor cursor = db.query(
                ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null,
                null, null, null, null, null)) {
            while (cursor.moveToNext()) {
                manual.computeIfAbsent(manualTimelineKey(cursor), ignored -> new ArrayList<>())
                        .add(manualTimelineCandidate(cursor));
            }
        }
        Map<String, ExpressQueryResult> interface5 = new HashMap<>();
        Map<String, OwnerAttribution> interface5Owners = new HashMap<>();
        Map<String, ExpressQueryResult> interface5Presentations = new HashMap<>();
        try (Cursor cursor = db.query(
                ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE, null,
                null, null, null, null, null)) {
            while (cursor.moveToNext()) {
                String normalized = ExpressSourcePolicy.normalizeWaybill(
                        text(cursor, "normalized_waybill"));
                if (!normalized.isEmpty()) {
                    interface5.put(normalized, timeline(cursor, TimelineSlot.V5_QUERY));
                    interface5Owners.put(normalized, OwnerAttribution.fromQueryKey(text(cursor, "owner_attribution")));
                    interface5Presentations.put(normalized, queryPresentation(interface5.get(normalized),
                            text(cursor, "owner_presentation")));
                }
            }
        }
        return new VisibleProjectionSidecars(
                projections, manual, interface5, interface5Owners, interface5Presentations);
    }

    private static final class VisibleProjectionSidecars {
        final Map<String, OrderProjection> orderProjections;
        final Map<String, List<ManualTimelineAuthorityPolicy.Candidate>> manualTimelines;
        final Map<String, ExpressQueryResult> interface5Timelines;
        final Map<String, OwnerAttribution> interface5Owners;
        final Map<String, ExpressQueryResult> interface5Presentations;

        VisibleProjectionSidecars(
                Map<String, OrderProjection> orderProjections,
                Map<String, List<ManualTimelineAuthorityPolicy.Candidate>> manualTimelines,
                Map<String, ExpressQueryResult> interface5Timelines,
                Map<String, OwnerAttribution> interface5Owners,
                Map<String, ExpressQueryResult> interface5Presentations) {
            this.orderProjections = orderProjections;
            this.manualTimelines = manualTimelines;
            this.interface5Timelines = interface5Timelines;
            this.interface5Owners = interface5Owners;
            this.interface5Presentations = interface5Presentations;
        }
    }



    static ExpressItem projectManualTimeline(
            ExpressItem owner, ManualTimelineAuthorityPolicy.Candidate authority) {
        return projectManualTimeline(owner, authority, null);
    }

    static ExpressItem projectManualTimeline(
            ExpressItem owner, ManualTimelineAuthorityPolicy.Candidate authority,
            ManualTimelineAuthorityPolicy.Candidate structuredTerminalAuthority) {
        return projectManualTimeline(owner, authority, structuredTerminalAuthority, authority);
    }

    private static ExpressItem projectManualTimeline(
            ExpressItem owner, ManualTimelineAuthorityPolicy.Candidate authority,
            ManualTimelineAuthorityPolicy.Candidate structuredTerminalAuthority,
            ManualTimelineAuthorityPolicy.Candidate statusPresentation) {
        authority = sanitizeManualTimelineCandidate(authority);
        statusPresentation = sanitizeManualTimelineCandidate(statusPresentation);
        structuredTerminalAuthority = sanitizeManualTimelineCandidate(
                structuredTerminalAuthority);
        ManualTimelineAuthorityPolicy.Candidate statusAuthority = statusPresentationAuthority(
                owner, structuredTerminalAuthority, statusPresentation);
        if (owner != null && owner.semantic == StatusSemantic.UNKNOWN
                && hasStructuredStatus(statusAuthority)) {
            owner = withBorrowedStatus(owner, statusAuthority.result);
        }
        String currentOwner = owner == null ? ""
                : owner.stateOwner.isEmpty() ? owner.source : owner.stateOwner;
        if (owner == null || authority == null
                || !ManualTimelineAuthorityPolicy.isAuthoritative(authority)
                || !(owner.manuallyAdded || isAutomaticAccountOwner(currentOwner))) return owner;
        boolean missingV5Timeline = isAutomaticAccountOwner(currentOwner)
                && !Kuaidi100TimelinePolicy.hasTimedTracking(sourcePackage(owner));
        if (owner.isCainiaoSource() && !missingV5Timeline) return owner;
        // V5 may fill an empty timeline from persisted detail; other interfaces keep their gate.
        if (!owner.manuallyAdded && owner.isJingDongSource() && !missingV5Timeline
                && (Kuaidi100TimelinePolicy.hasTimedTracking(sourcePackage(owner))
                || !TimelineSlot.KDNIAO.equals(TimelineSlot.normalize(authority.provider)))) {
            return owner;
        }
        // Only SF replaces an existing timed feed with the selected manual package.
        if (!owner.manuallyAdded && !owner.isShunFengSource()
                && Kuaidi100TimelinePolicy.hasTimedTracking(sourcePackage(owner))) {
            return owner;
        }
        ExpressTimeline.Track latest = latestTimedTrack(authority.result);
        if (latest == null) return owner;
        StatusSemantic manualSemantic = hasStructuredStatus(statusAuthority)
                ? statusAuthority.result.semantic : StatusSemantic.UNKNOWN;
        boolean takeStructuredStatus = manualSemantic != StatusSemantic.UNKNOWN
                && (owner.manuallyAdded || owner.isShunFengSource() || owner.semantic == StatusSemantic.UNKNOWN)
                && !(owner.semantic.terminal() && !manualSemantic.terminal());
        StatusSemantic semantic = takeStructuredStatus ? manualSemantic : owner.semantic;
        long statusEventTime = takeStructuredStatus
                ? manualStatusEventTime(statusAuthority.result) : owner.statusEventTime;
        String latestTime = clean(authority.result.latestTime);
        String latestDetail = clean(authority.result.latestDetail);
        if (ExpressSourcePolicy.parseEventTime(latestTime) <= 0L || latestDetail.isEmpty()) {
            latestTime = latest.time;
            latestDetail = latest.detail;
        }
        if (isInterface5Automatic(owner) && !owner.isShunFengSource()
                && !owner.latestDetail.isEmpty()
                && !ExpressStatusNormalizer.isProviderErrorDetail(owner.latestDetail)) {
            latestTime = owner.latestTime;
            latestDetail = owner.latestDetail;
        }
        ManualTimelineAuthorityPolicy.Candidate descriptionAuthority =
                statusPresentation == null ? authority : statusPresentation;
        boolean unstructuredH5 = !hasStructuredStatus(descriptionAuthority)
                && (TimelineSlot.K100_H5.equals(TimelineSlot.normalize(descriptionAuthority.provider))
                || TimelineSlot.isAutomaticH5(descriptionAuthority.provider));
        String statusDescription = descriptionAuthority.providerErrorMetadataInvalidated || unstructuredH5
                || isInterface5Automatic(owner) && !owner.isShunFengSource()
                ? owner.statusDescription : descriptionAuthority.result.statusDescription;
        return new ExpressItem(
                owner.rowId, owner.phone, owner.waybill, owner.courierCode, owner.companyName,
                semantic, statusDescription, latestDetail, latestTime,
                WorkerStatusProjection.attach(authority.result.tracksJson, takeStructuredStatus
                        ? statusAuthority.result.workerStatus : WorkerStatusProjection.cached(owner.tracksJson)),
                owner.remark, owner.source, owner.detailUrl,
                statusEventTime, owner.updatedAt,
                owner.stateOwner, owner.routeOwner, owner.routeInterface,
                owner.routeCredential, owner.routeCredentialAvailable,
                owner.projectedWaybill, owner.projectedCompanyName, owner.projectedTracksJson,
                owner.sourceProvider, owner.manuallyAdded,
                authority.provider, authority.successAt, owner.sourceSemantic,
                owner.carrierNormalization, owner.signedRetainedAt);
    }

    private static ManualTimelineAuthorityPolicy.Candidate statusPresentationAuthority(ExpressItem owner,
            ManualTimelineAuthorityPolicy.Candidate structuredTerminalAuthority,
            ManualTimelineAuthorityPolicy.Candidate statusPresentation) {
        ManualTimelineAuthorityPolicy.Candidate statusAuthority =
                owner != null && owner.semantic == StatusSemantic.UNKNOWN
                        && !hasOwnedManualStatusPresentation(owner, statusPresentation)
                        && hasStructuredStatus(structuredTerminalAuthority)
                        ? structuredTerminalAuthority
                        : hasStructuredStatus(statusPresentation) ? statusPresentation : structuredTerminalAuthority;
        if (hasStructuredStatus(statusAuthority) && hasStructuredStatus(structuredTerminalAuthority)
                && statusAuthority.result.semantic == structuredTerminalAuthority.result.semantic
                && WorkerStatusProjection.priority(structuredTerminalAuthority.result)
                        > WorkerStatusProjection.priority(statusAuthority.result)) {
            statusAuthority = structuredTerminalAuthority;
        }
        if (owner != null && owner.signedRetainedAt > 0L
                && hasStructuredStatus(structuredTerminalAuthority)
                && structuredTerminalAuthority.result.semantic == StatusSemantic.COMPLETED) {
            statusAuthority = structuredTerminalAuthority;
        }
        return statusAuthority;
    }

    private static boolean hasOwnedManualStatusPresentation(ExpressItem owner,
            ManualTimelineAuthorityPolicy.Candidate presentation) {
        return owner != null && (owner.manuallyAdded || owner.isShunFengSource())
                && hasStructuredStatus(presentation);
    }

    private static long manualStatusEventTime(ExpressQueryResult result) {
        return result == null ? 0L : Math.max(0L, result.statusEventTime);
    }

    private static boolean hasStructuredStatus(ManualTimelineAuthorityPolicy.Candidate candidate) {
        return ManualTimelineAuthorityPolicy.hasStructuredStatus(candidate);
    }

    private static ExpressItem withBorrowedStatus(ExpressItem owner, ExpressQueryResult donor) {
        return new ExpressItem(
                owner.rowId, owner.phone, owner.waybill, owner.courierCode, owner.companyName,
                donor.semantic, donor.statusDescription, owner.latestDetail, owner.latestTime,
                WorkerStatusProjection.attach(owner.tracksJson, donor.workerStatus),
                owner.remark, owner.source, owner.detailUrl,
                manualStatusEventTime(donor), owner.updatedAt,
                owner.stateOwner, owner.routeOwner, owner.routeInterface,
                owner.routeCredential, owner.routeCredentialAvailable,
                owner.projectedWaybill, owner.projectedCompanyName, owner.projectedTracksJson,
                owner.sourceProvider, owner.manuallyAdded, owner.manualTimelineProvider,
                owner.manualTimelineSuccessAt, owner.sourceSemantic,
                owner.carrierNormalization, owner.signedRetainedAt);
    }

    private static ExpressTimeline.Track latestTimedTrack(ExpressQueryResult result) {
        if (result == null) return null;
        for (ExpressTimeline.Track track : ExpressTimeline.parse(result.tracksJson, "", "")) {
            if (ExpressSourcePolicy.parseEventTime(track.time) > 0L
                    && !ExpressStatusNormalizer.isProviderErrorDetail(track.detail)) return track;
        }
        return null;
    }

    static boolean sameOwnerIdentity(ExpressItem current, ExpressItem expected) {
        if (current == null || expected == null || current.rowId != expected.rowId) return false;
        String currentOwner = current.stateOwner.isEmpty() ? current.source : current.stateOwner;
        String expectedOwner = expected.stateOwner.isEmpty()
                ? expected.source : expected.stateOwner;
        return ExpressSourcePolicy.normalizeWaybill(current.waybill).equals(
                ExpressSourcePolicy.normalizeWaybill(expected.waybill))
                && ExpressSourcePolicy.source(currentOwner).equals(
                ExpressSourcePolicy.source(expectedOwner))
                && current.sourceProvider.equals(expected.sourceProvider)
                && current.courierCode.equalsIgnoreCase(expected.courierCode);
    }

    static boolean shouldPersistSourceProvider(
            String incomingOwner, boolean authorizedAccountWrite, String sourceProvider) {
        if (!authorizedAccountWrite || clean(sourceProvider).isEmpty()) return false;
        String owner = ExpressSourcePolicy.source(incomingOwner);
        return ExpressSourcePolicy.SOURCE_INTERFACE5.equals(owner)
                || ExpressSourcePolicy.SOURCE_INTERFACE5_JD.equals(owner)
                || ExpressSourcePolicy.SOURCE_INTERFACE6.equals(owner)
                || ExpressSourcePolicy.SOURCE_LEGACY_ACCOUNT_ORDER.equals(owner);
    }

    /** Reads retry state only when the caller still names the same account-order owner. */
    public synchronized OrderProjectionRetryState orderProjectionRetryState(
            ExpressItem expectedOwner) {
        ExpressItem current = expectedOwner == null ? null : findRaw(expectedOwner.rowId);
        if (!ExpressOrderProjectionIdentity.matches(
                ExpressOrderProjectionIdentity.snapshot(expectedOwner), current)
                || !current.isAccountOrder()) {
            return OrderProjectionRetryState.EMPTY;
        }
        try (Cursor cursor = database().query(
                ExpressDatabase.EXPRESS_TABLE,
                new String[]{"projectionRetryAt", "projectionRetryRoute"},
                "_id=?", new String[]{Long.toString(current.rowId)},
                null, null, null, "1")) {
            if (!cursor.moveToFirst()) return OrderProjectionRetryState.EMPTY;
            return new OrderProjectionRetryState(
                    cursor.getLong(0), clean(cursor.getString(1)));
        }
    }

    public synchronized void recordOrderProjectionFailure(
            ExpressItem expectedOwner, long failedAt, String routeFingerprint) {
        updateOrderProjectionRetry(
                expectedOwner, Math.max(0L, failedAt), clean(routeFingerprint));
    }

    private void updateOrderProjectionRetry(
            ExpressItem expectedOwner, long failedAt, String routeFingerprint) {
        ExpressItem current = expectedOwner == null ? null : findRaw(expectedOwner.rowId);
        if (!ExpressOrderProjectionIdentity.matches(
                ExpressOrderProjectionIdentity.snapshot(expectedOwner), current)
                || !current.isAccountOrder()) return;
        ContentValues values = new ContentValues();
        values.put("projectionRetryAt", failedAt);
        values.put("projectionRetryRoute", routeFingerprint);
        database().update(
                ExpressDatabase.EXPRESS_TABLE, values, "_id=?",
                new String[]{Long.toString(current.rowId)});
    }

    public static final class OrderProjectionRetryState {
        static final OrderProjectionRetryState EMPTY =
                new OrderProjectionRetryState(0L, "");
        public final long failedAt;
        public final String routeFingerprint;

        OrderProjectionRetryState(long failedAt, String routeFingerprint) {
            this.failedAt = failedAt;
            this.routeFingerprint = clean(routeFingerprint);
        }
    }

    /** Saves a late-arriving display identity without replacing the stable account record id. */
    public boolean saveOrderProjection(
            ExpressItem expectedOwner, String bindingSource, String displayWaybill,
            String companyName) {
        return saveOrderProjection(expectedOwner, bindingSource, displayWaybill, companyName, true, null);
    }

    public boolean saveOrderProjection(
            ExpressItem expectedOwner, String bindingSource, String displayWaybill,
            String companyName, ExpressQueryCancellation cancellation) {
        return saveOrderProjection(expectedOwner, bindingSource, displayWaybill, companyName, true, cancellation);
    }

    private boolean saveOrderProjection(
            ExpressItem expectedOwner, String bindingSource, String displayWaybill,
            String companyName, boolean publish) {
        return saveOrderProjection(expectedOwner, bindingSource, displayWaybill, companyName, publish, null);
    }

    private boolean saveOrderProjection(
            ExpressItem expectedOwner, String bindingSource, String displayWaybill,
            String companyName, boolean publish, ExpressQueryCancellation cancellation) {
        if (expectedOwner == null) return false;
        ExpressOrderProjectionIdentity.Snapshot expectedIdentity =
                ExpressOrderProjectionIdentity.snapshot(expectedOwner);
        String normalizedSource = ExpressSourcePolicy.normalizeWaybill(expectedOwner.waybill);
        String normalizedDisplay = ExpressSourcePolicy.normalizeWaybill(displayWaybill);
        String selectedBindingSource = normalizeBindingSource(bindingSource);
        if (normalizedSource.isEmpty() || normalizedDisplay.isEmpty()
                || normalizedSource.equals(normalizedDisplay)) return false;
        ExpressItem previous;
        ExpressItem current;
        boolean saved = false;
        synchronized (this) {
            ExpressItem before = findRaw(expectedOwner.rowId);
            if (!ExpressOrderProjectionIdentity.matches(expectedIdentity, before)
                    || !before.isAccountOrder()) {
                return false;
            }
            previous = projectTimelineAuthorities(before);
            SQLiteDatabase db = database();
            db.beginTransaction();
            try {
                if (cancellation != null && cancellation.isCancelled()) return false;
                ExpressItem locked = findRaw(db, expectedOwner.rowId);
                if (!ExpressOrderProjectionIdentity.matches(expectedIdentity, locked)
                        || !locked.isAccountOrder()) return false;
                String lockedOwner = locked.stateOwner.isEmpty()
                        ? locked.source : locked.stateOwner;
                if (!selectedBindingSource.equals(
                        ExpressSourcePolicy.bindingSourceForOwner(lockedOwner))) return false;
                OrderProjection existing = orderProjection(
                        db, locked.waybill, selectedBindingSource);
                boolean sameWaybill = normalizedDisplay.equals(
                        ExpressSourcePolicy.normalizeWaybill(existing.waybill));
                CarrierRegistry.Carrier existingCarrier = sameWaybill
                        ? projectedCarrier(normalizedDisplay, existing.companyName) : null;
                CarrierRegistry.Carrier incomingCarrier = projectedCarrier(normalizedDisplay, companyName);
                String projectedCarrier = existingCarrier != null ? existingCarrier.companyName
                        : incomingCarrier != null ? incomingCarrier.companyName
                        : clean(companyName).isEmpty() && sameWaybill ? existing.companyName
                        : clean(companyName);
                ContentValues values = new ContentValues();
                values.put("normalized_source_id", normalizedSource);
                values.put("binding_source", selectedBindingSource);
                values.put("source_id", locked.waybill);
                values.put("display_waybill", clean(displayWaybill));
                values.put("normalized_display_waybill", normalizedDisplay);
                values.put("carrier_name", projectedCarrier);
                // The isolated order page contributes display identity only. Its page timeline is
                // deliberately not mixed into the one selected local provider timeline.
                values.put("tracks_json", "[]");
                values.put("updated_at", System.currentTimeMillis());
                long changed = db.insertWithOnConflict(
                        ExpressDatabase.ORDER_PROJECTION_TABLE, null, values,
                        SQLiteDatabase.CONFLICT_REPLACE);
                if (changed < 0L) {
                    throw new IllegalStateException("Order projection persistence failed");
                }
                String previousDisplay = ExpressSourcePolicy.normalizeWaybill(existing.waybill);
                if (!previousDisplay.isEmpty()
                        && !previousDisplay.equals(normalizedDisplay)) {
                    rekeyAutomaticIdentity(db, previousDisplay, normalizedDisplay);
                }
                rekeyAutomaticIdentity(db, normalizedSource, normalizedDisplay);
                if (!previousDisplay.isEmpty() && !previousDisplay.equals(normalizedDisplay)) {
                    deleteKuaidi100TimelineIfUnreferenced(db, previousDisplay);
                }
                ContentValues retry = new ContentValues();
                retry.put("projectionRetryAt", 0L);
                retry.put("projectionRetryRoute", "");
                int retryRows = db.update(
                        ExpressDatabase.EXPRESS_TABLE, retry, "_id=?",
                        new String[]{Long.toString(locked.rowId)});
                if (retryRows != 1) {
                    throw new IllegalStateException("Order projection owner changed");
                }
                String generation = bindingGeneration(
                        db, locked.phone, selectedBindingSource);
                if (!projectedCarrier.isEmpty() && !generation.isEmpty()) {
                    long observedAt = System.currentTimeMillis();
                    ExpressQueryResult projectedPackage = new ExpressQueryResult(
                            locked.waybill, locked.courierCode, locked.companyName,
                            locked.sourceSemantic, locked.statusEventTime,
                            locked.latestTime, locked.latestDetail, locked.tracksJson,
                            locked.detailUrl, locked.phone, selectedBindingSource,
                            locked.routeInterface, locked.routeCredential,
                            locked.sourceProvider, locked.carrierNormalization)
                            .withProjectedCarrierEvidence(projectedCarrier);
                    if (AutomaticOwnershipPolicy.isQualified(
                            ExpressSourcePolicy.SOURCE_INTERFACE5_JD, projectedPackage)) {
                        upsertAutomaticObservation(
                                db, normalizedDisplay, ExpressSourcePolicy.SOURCE_INTERFACE5,
                                ExpressSourcePolicy.SOURCE_INTERFACE5_JD,
                                projectedPackage, locked.phone, generation, observedAt);
                        AutomaticOwnershipState ownership = automaticOwnershipState(
                                db, normalizedDisplay);
                        if (ownership == null || ownership.ownerProvider.isEmpty()) {
                            putAutomaticOwnership(
                                    db, normalizedDisplay, ExpressSourcePolicy.SOURCE_INTERFACE5,
                                    locked.phone, generation, locked.rowId,
                                    observedAt, observedAt, 0, "",
                                    ownership == null ? 0L : ownership.cooldownUntil,
                                    AutomaticOwnershipPolicy.isJingDongSource(
                                            projectedPackage.sourceProvider)
                                            && projectedPackage.semantic
                                            == StatusSemantic.COMPLETED);
                        }
                    }
                }
                current = find(expectedOwner.rowId);
                if (publish) current = stageNotification(db, previous, current);
                if (cancellation == null) db.setTransactionSuccessful();
                else if (!cancellation.commitIfActive(db::setTransactionSuccessful)) return false;
                saved = true;
            } finally {
                db.endTransaction();
            }
        }
        if (saved && publish) publishChange();
        return saved;
    }

    private static CarrierRegistry.Carrier projectedCarrier(String waybill, String companyName) {
        CarrierRegistry.Carrier carrier = CarrierRegistry.resolveName(companyName);
        return carrier != null && "JD".equals(carrier.standardCode)
                && !ExpressSourcePolicy.normalizeWaybill(waybill).startsWith("JD") ? null : carrier;
    }

    /** Carrier recognition is independent of a same-order route or raw-carrier refresh. */
    private static boolean sameProjectedCarrierOwner(ExpressItem expected, ExpressItem current) {
        if (current == null || !current.isAccountOrder() || current.rowId != expected.rowId
                || !current.phone.equals(expected.phone)) return false;
        String expectedOwner = expected.stateOwner.isEmpty() ? expected.source : expected.stateOwner;
        String currentOwner = current.stateOwner.isEmpty() ? current.source : current.stateOwner;
        return ExpressSourcePolicy.normalizeWaybill(current.waybill).equals(
                ExpressSourcePolicy.normalizeWaybill(expected.waybill))
                && ExpressSourcePolicy.bindingSourceForOwner(currentOwner).equals(
                        ExpressSourcePolicy.bindingSourceForOwner(expectedOwner));
    }

    /** Repairs an unresolved projection without replacing a known carrier on the same waybill. */
    public boolean saveOrderProjectionCarrier(
            ExpressItem expectedOwner, String bindingSource, String projectedWaybill,
            String companyName) {
        if (expectedOwner == null || !expectedOwner.isAccountOrder()) return false;
        CarrierRegistry.Carrier carrier = projectedCarrier(projectedWaybill, companyName);
        if (carrier == null) return false;
        String normalizedDisplay = ExpressSourcePolicy.normalizeWaybill(projectedWaybill);
        String expectedDisplay = ExpressSourcePolicy.normalizeWaybill(
                expectedOwner.projectedWaybill);
        String selectedBindingSource = normalizeBindingSource(bindingSource);
        if (normalizedDisplay.isEmpty() || !normalizedDisplay.equals(expectedDisplay)) {
            return false;
        }
        ExpressItem previous;
        ExpressItem current;
        boolean saved = false;
        synchronized (this) {
            ExpressItem before = findRaw(expectedOwner.rowId);
            if (!sameProjectedCarrierOwner(expectedOwner, before)) return false;
            previous = projectTimelineAuthorities(before);
            SQLiteDatabase db = database();
            db.beginTransaction();
            try {
                ExpressItem locked = findRaw(db, expectedOwner.rowId);
                if (!sameProjectedCarrierOwner(expectedOwner, locked)) return false;
                String lockedOwner = locked.stateOwner.isEmpty()
                        ? locked.source : locked.stateOwner;
                if (!selectedBindingSource.equals(
                        ExpressSourcePolicy.bindingSourceForOwner(lockedOwner))) return false;
                OrderProjection projection = orderProjection(
                        db, locked.waybill, selectedBindingSource);
                if (!normalizedDisplay.equals(
                        ExpressSourcePolicy.normalizeWaybill(projection.waybill))) return false;
                if (projectedCarrier(normalizedDisplay, projection.companyName) != null) return false;
                ContentValues values = new ContentValues();
                values.put("carrier_name", carrier.companyName);
                values.put("updated_at", System.currentTimeMillis());
                int changed = db.update(
                        ExpressDatabase.ORDER_PROJECTION_TABLE, values,
                        "normalized_source_id=? AND LOWER(binding_source)=?"
                                + " AND normalized_display_waybill=?",
                        new String[]{
                                ExpressSourcePolicy.normalizeWaybill(locked.waybill),
                                selectedBindingSource, normalizedDisplay});
                if (changed != 1) return false;
                current = find(expectedOwner.rowId);
                current = stageNotification(db, previous, current);
                db.setTransactionSuccessful();
                saved = true;
            } finally {
                db.endTransaction();
            }
        }
        if (saved) publishChange();
        return saved;
    }

    /**
     * Fills the display-only carrier normalization of one account row the Worker's built-in-table
     * sidecar left unresolved (EXPRESS_OWNERSHIP_PLAN §3.1 裁决 A, 2026-09-03). Raw carrier
     * fields, status and routes never change; the row must still carry the same real waybill.
     * Account feeds can replace an empty carrier code with a platform label during recognition.
     */
    public boolean saveRecognizedCarrier(
            ExpressItem expected, CarrierNormalization normalization) {
        if (expected == null || normalization == null || !normalization.recognized()) {
            return false;
        }
        ExpressItem previous;
        ExpressItem current;
        boolean saved = false;
        synchronized (this) {
            ExpressItem before = findRaw(expected.rowId);
            if (before == null || before.isAccountOrder() || before.manuallyAdded
                    || !ExpressSourcePolicy.normalizeWaybill(before.waybill).equals(
                            ExpressSourcePolicy.normalizeWaybill(expected.waybill))) return false;
            previous = projectTimelineAuthorities(before);
            SQLiteDatabase db = database();
            db.beginTransaction();
            try {
                ContentValues values = new ContentValues();
                putCarrierNormalization(values, normalization);
                saved = db.update(ExpressDatabase.EXPRESS_TABLE, values, "_id=?",
                        new String[]{String.valueOf(before.rowId)}) == 1;
                current = find(expected.rowId);
                if (saved) current = stageNotification(db, previous, current);
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
        if (saved) publishChange();
        return saved;
    }

    /** Converges a provisional order identity on the real carrier waybill in one transaction. */
    private static void rekeyAutomaticIdentity(
            SQLiteDatabase db, String fromIdentity, String toIdentity) {
        String from = ExpressSourcePolicy.normalizeWaybill(fromIdentity);
        String to = ExpressSourcePolicy.normalizeWaybill(toIdentity);
        if (from.isEmpty() || to.isEmpty() || from.equals(to)) return;

        try (Cursor cursor = db.query(
                ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE, null,
                "normalized_waybill=?", new String[]{from},
                null, null, null)) {
            while (cursor.moveToNext()) {
                String provider = text(cursor, "owner_provider");
                String generation = text(cursor, "binding_generation");
                long observedAt = number(cursor, "observed_at");
                long existingObservedAt = -1L;
                try (Cursor existing = db.query(
                        ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                        new String[]{"observed_at"},
                        "normalized_waybill=? AND owner_provider=?"
                                + " AND binding_generation=?",
                        new String[]{to, provider, generation},
                        null, null, null, "1")) {
                    if (existing.moveToFirst()) existingObservedAt = existing.getLong(0);
                }
                if (existingObservedAt > observedAt) continue;
                ContentValues values = copyCursorRow(cursor);
                values.put("normalized_waybill", to);
                if (db.insertWithOnConflict(
                        ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE, null, values,
                        SQLiteDatabase.CONFLICT_REPLACE) < 0L) {
                    throw new IllegalStateException("Automatic observation rekey failed");
                }
            }
        }
        AutomaticOwnershipState fromOwner = automaticOwnershipState(db, from);
        AutomaticOwnershipState toOwner = automaticOwnershipState(db, to);
        if (fromOwner != null && toOwner == null) {
            ContentValues values = new ContentValues();
            values.put("normalized_waybill", to);
            if (db.update(ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, values,
                    "normalized_waybill=?", new String[]{from}) != 1) {
                throw new IllegalStateException("Automatic ownership rekey failed");
            }
        } else if (fromOwner != null) {
            db.delete(ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE,
                    "normalized_waybill=?", new String[]{from});
        }
        db.delete(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                "normalized_waybill=?", new String[]{from});
    }

    private static ContentValues copyCursorRow(Cursor cursor) {
        ContentValues values = new ContentValues();
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

    private OrderProjection orderProjection(String sourceId, String bindingSource) {
        return orderProjection(database(), sourceId, bindingSource);
    }

    private static OrderProjection orderProjection(
            SQLiteDatabase db, String sourceId, String bindingSource) {
        String normalized = ExpressSourcePolicy.normalizeWaybill(sourceId);
        if (normalized.isEmpty()) return OrderProjection.EMPTY;
        try (Cursor cursor = db.query(
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

    private static String automaticIdentity(
            SQLiteDatabase db, String waybill, String packageOwner) {
        String sourceIdentity = ExpressSourcePolicy.normalizeWaybill(waybill);
        if (sourceIdentity.isEmpty()) return "";
        if (!ExpressSourcePolicy.isAccountOrderOwner(packageOwner)) return sourceIdentity;
        OrderProjection projection = orderProjection(
                db, waybill, ExpressSourcePolicy.bindingSourceForOwner(packageOwner));
        String projected = ExpressSourcePolicy.normalizeWaybill(projection.waybill);
        return projected.isEmpty() ? sourceIdentity : projected;
    }

    private static AutomaticOwnershipState automaticOwnershipState(
            SQLiteDatabase db, String normalizedWaybill) {
        if (db == null || clean(normalizedWaybill).isEmpty()) return null;
        try (Cursor cursor = db.query(
                ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, null,
                "normalized_waybill=?", new String[]{normalizedWaybill},
                null, null, null, "1")) {
            return cursor.moveToFirst() ? automaticOwnershipState(cursor) : null;
        }
    }

    private boolean isAutomaticDisplayFrozen(long ownerRowId) {
        return isAutomaticDisplayFrozen(database(), ownerRowId);
    }

    private static boolean isAutomaticDisplayFrozen(
            SQLiteDatabase db, long ownerRowId) {
        if (db == null || ownerRowId <= 0L) return false;
        try (Cursor cursor = db.query(
                ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE,
                new String[]{"display_frozen"}, "owner_row_id=?",
                new String[]{Long.toString(ownerRowId)},
                null, null, null, "1")) {
            return cursor.moveToFirst() && cursor.getInt(0) != 0;
        }
    }

    private static Map<String, AutomaticOwnershipState> automaticOwnershipStates(
            SQLiteDatabase db) {
        Map<String, AutomaticOwnershipState> states = new HashMap<>();
        try (Cursor cursor = db.query(
                ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, null,
                null, null, null, null, null)) {
            while (cursor.moveToNext()) {
                AutomaticOwnershipState state = automaticOwnershipState(cursor);
                states.put(state.normalizedWaybill, state);
            }
        }
        return states;
    }

    private static AutomaticOwnershipState automaticOwnershipState(Cursor cursor) {
        return new AutomaticOwnershipState(
                text(cursor, "normalized_waybill"), text(cursor, "owner_provider"),
                text(cursor, "owner_phone"),
                text(cursor, "owner_binding_generation"),
                number(cursor, "owner_row_id"), number(cursor, "claimed_at"),
                number(cursor, "last_observed_at"), (int) number(cursor, "miss_count"),
                text(cursor, "release_reason"), number(cursor, "cooldown_until"),
                number(cursor, "display_frozen") != 0L);
    }

    private static final class AutomaticOwnershipState {
        final String normalizedWaybill;
        final String ownerProvider;
        final String ownerPhone;
        final String ownerBindingGeneration;
        final long ownerRowId;
        final long claimedAt;
        final long lastObservedAt;
        final int missCount;
        final String releaseReason;
        final long cooldownUntil;
        final boolean displayFrozen;

        AutomaticOwnershipState(
                String normalizedWaybill, String ownerProvider,
                String ownerPhone, String ownerBindingGeneration, long ownerRowId,
                long claimedAt, long lastObservedAt, int missCount,
                String releaseReason, long cooldownUntil, boolean displayFrozen) {
            this.normalizedWaybill = clean(normalizedWaybill);
            this.ownerProvider = clean(ownerProvider).isEmpty()
                    ? "" : ExpressSourcePolicy.source(ownerProvider);
            this.ownerPhone = clean(ownerPhone);
            this.ownerBindingGeneration = clean(ownerBindingGeneration);
            this.ownerRowId = ownerRowId;
            this.claimedAt = claimedAt;
            this.lastObservedAt = lastObservedAt;
            this.missCount = Math.max(0, missCount);
            this.releaseReason = clean(releaseReason);
            this.cooldownUntil = cooldownUntil;
            this.displayFrozen = displayFrozen;
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

    private static CarrierNormalization carrierNormalization(Cursor cursor) {
        int builtInIndex = cursor.getColumnIndex("carrierIsBuiltIn");
        Boolean builtIn = null;
        if (builtInIndex >= 0 && !cursor.isNull(builtInIndex)) {
            int value = cursor.getInt(builtInIndex);
            if (value >= 0) builtIn = value != 0;
        }
        return new CarrierNormalization(
                text(cursor, "carrierStandardCode"),
                text(cursor, "carrierDisplayName"),
                text(cursor, "carrierKuaidi100Code"),
                builtIn,
                text(cursor, "carrierTableVersion"));
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
        return TimelineSlot.V5_QUERY.equals(TimelineSlot.normalize(value))
                ? "interface5" : "interface6";
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
        pruneHiddenOwnerManualTimelines(db);
        pruneHiddenOwnerManualRoutes(db);
        pruneHiddenOwnerManualRetries(db);
        pruneHiddenKuaidi100Timelines(db);
        pruneHiddenTimeline(db, ExpressDatabase.V4_TIMELINE_TABLE);
        pruneHiddenAccountTimeline(db, ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE,
                "'INTERFACE5','I5-JD'");
        pruneHiddenAccountTimeline(db, ExpressDatabase.ACCOUNT_V6_TIMELINE_TABLE,
                "'INTERFACE6','I6-JD'");
    }

    private static void pruneHiddenOwnerManualTimelines(SQLiteDatabase db) {
        db.execSQL("DELETE FROM " + ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE
                + " WHERE NOT EXISTS (SELECT 1 FROM " + ExpressDatabase.EXPRESS_TABLE
                + " WHERE " + ExpressDatabase.EXPRESS_TABLE + "._id="
                + ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE + ".owner_row_id"
                + " AND " + ExpressDatabase.EXPRESS_TABLE + ".canShow=1"
                + " AND " + ExpressDatabase.EXPRESS_TABLE + ".isDeleted=0)");
    }

    private static void pruneHiddenOwnerManualRoutes(SQLiteDatabase db) {
        db.execSQL("DELETE FROM " + ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE
                + " WHERE NOT EXISTS (SELECT 1 FROM " + ExpressDatabase.EXPRESS_TABLE
                + " WHERE " + ExpressDatabase.EXPRESS_TABLE + "._id="
                + ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE + ".owner_row_id"
                + " AND " + ExpressDatabase.EXPRESS_TABLE + ".canShow=1"
                + " AND " + ExpressDatabase.EXPRESS_TABLE + ".isDeleted=0)");
    }

    private static void pruneHiddenOwnerManualRetries(SQLiteDatabase db) {
        db.execSQL("DELETE FROM " + ExpressDatabase.OWNER_MANUAL_RETRY_TABLE
                + " WHERE NOT EXISTS (SELECT 1 FROM " + ExpressDatabase.EXPRESS_TABLE
                + " WHERE " + ExpressDatabase.EXPRESS_TABLE + "._id="
                + ExpressDatabase.OWNER_MANUAL_RETRY_TABLE + ".owner_row_id"
                + " AND " + ExpressDatabase.EXPRESS_TABLE + ".canShow=1"
                + " AND " + ExpressDatabase.EXPRESS_TABLE + ".isDeleted=0)");
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

    /** Removes all shipment data after its retention window. */
    private static void expireShipments(
            SQLiteDatabase db, List<ExpressItem> expired) {
        HashSet<String> removedWaybills = new HashSet<>();
        for (ExpressItem item : expired) {
            String normalized = ExpressSourcePolicy.normalizeWaybill(item.waybill);
            if (normalized.isEmpty()) {
                db.delete(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, "owner_row_id=?",
                        new String[]{Long.toString(item.rowId)});
                db.delete(ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE, "owner_row_id=?",
                        new String[]{Long.toString(item.rowId)});
                db.delete(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE, "owner_row_id=?",
                        new String[]{Long.toString(item.rowId)});
                db.delete(ExpressDatabase.EXPRESS_TABLE, "_id=?",
                        new String[]{Long.toString(item.rowId)});
                continue;
            }
            if (!removedWaybills.add(normalized)) continue;
            deleteWaybillRows(db, normalized, item.rowId);
        }
    }

    /** Removes rows hidden by legacy builds without creating a persistent deletion registry. */
    private void cleanLegacyHiddenRows() {
        SQLiteDatabase db = database();
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
            db.delete(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, "owner_row_id=?",
                    new String[]{Long.toString(fallbackRowId)});
            db.delete(ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE, "owner_row_id=?",
                    new String[]{Long.toString(fallbackRowId)});
            db.delete(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE, "owner_row_id=?",
                    new String[]{Long.toString(fallbackRowId)});
            db.delete(ExpressDatabase.EXPRESS_TABLE, "_id=?",
                    new String[]{Long.toString(fallbackRowId)});
            return;
        }
        db.delete(ExpressDatabase.EXPRESS_TABLE, "normalizedMailNo=?",
                new String[]{normalized});
        db.delete(ExpressDatabase.EXPRESS_TABLE, "_id=?",
                new String[]{Long.toString(fallbackRowId)});
        db.delete(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "normalized_waybill=? OR owner_row_id=?",
                new String[]{normalized, Long.toString(fallbackRowId)});
        db.delete(ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE,
                "normalized_waybill=? OR owner_row_id=?",
                new String[]{normalized, Long.toString(fallbackRowId)});
        db.delete(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "normalized_waybill=? OR owner_row_id=?",
                new String[]{normalized, Long.toString(fallbackRowId)});
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
        db.delete(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE,
                "normalized_waybill=?", new String[]{normalized});
        db.delete(ExpressDatabase.ACCOUNT_V6_TIMELINE_TABLE,
                "normalized_waybill=?", new String[]{normalized});
        db.delete(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "normalized_waybill=?", new String[]{normalized});
        db.delete(ExpressDatabase.OWNER_MANUAL_ROUTE_TABLE,
                "normalized_waybill=?", new String[]{normalized});
        db.delete(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "normalized_waybill=?", new String[]{normalized});
        db.delete(ExpressDatabase.ORDER_PROJECTION_TABLE,
                "normalized_source_id=? OR normalized_display_waybill=?",
                new String[]{normalized, normalized});
        deleteKuaidi100TimelineIfUnreferenced(db, normalized);
        for (String projected : projectedWaybills) {
            if (hasVisibleKuaidi100Reference(db, projected)) continue;
            for (String table : new String[]{ExpressDatabase.KUAIDI100_TIMELINE_TABLE,
                    ExpressDatabase.V4_TIMELINE_TABLE, ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE,
                    ExpressDatabase.ACCOUNT_V6_TIMELINE_TABLE, ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE,
                    ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE}) {
                db.delete(table, "normalized_waybill=?", new String[]{projected});
            }
        }
        if (!hasVisibleKuaidi100Reference(db, normalized)) {
            db.delete(ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE,
                    "normalized_waybill=?", new String[]{normalized});
            db.delete(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                    "normalized_waybill=?", new String[]{normalized});
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
