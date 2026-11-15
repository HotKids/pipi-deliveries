package me.pipi.deliveries.data;

import android.content.Context;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.os.Build;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

import me.pipi.deliveries.model.ExpressItem;

/**
 * Lite 快递仓库 WAL 只读侧连接池与 {@code PRAGMA data_version} 列表投影快照缓存（{@code B-07} + {@code D-05}）：
 * <ol>
 *   <li>通过独立 {@link SQLiteDatabase#OPEN_READONLY} 侧连接采样 {@code PRAGMA data_version}，当外部连接提交或
 *       本仓状态变更时自动失效，3 秒共享窗口内无写提交直接复用最近一次投影快照；</li>
 *   <li>在 Android 15+（{@code VANILLA_ICE_CREAM}）上使用 {@link SQLiteDatabase#beginTransactionReadOnly()}
 *       独立只读事务执行 {@code listVisible} / {@code homeRows}，完全脱离 {@link ExpressRepository} 对象写监视器；</li>
 *   <li>若只读侧连接不可用（内存库、写事务重入或遗留脏包需落库修复），自动回退至监视器保护路径。</li>
 * </ol>
 */
final class ExpressReadSidePool {
    private static final long SHARE_WINDOW_NANOS = 3_000_000_000L;
    private static final long WALL_CLOCK_DRIFT_LIMIT_MS = 3_000L;

    static final class WriteRequiredException extends RuntimeException {}

    static final class Stamp {
        private final SQLiteDatabase writer;
        private final String bindingSource;
        private final long dataVersion;
        private final long invalidationVersion;
        private final Map<String, String> detailSelections;
        private final Map<String, ?> emptyOrderMarks;
        private final Object carrierStatusTable;
        private final long capturedWallMs;

        Stamp(
                SQLiteDatabase writer,
                String bindingSource,
                long dataVersion,
                long invalidationVersion,
                Map<String, String> detailSelections,
                Map<String, ?> emptyOrderMarks,
                Object carrierStatusTable,
                long capturedWallMs) {
            this.writer = writer;
            this.bindingSource = bindingSource;
            this.dataVersion = dataVersion;
            this.invalidationVersion = invalidationVersion;
            this.detailSelections = detailSelections;
            this.emptyOrderMarks = emptyOrderMarks;
            this.carrierStatusTable = carrierStatusTable;
            this.capturedWallMs = capturedWallMs;
        }

        boolean sameAs(Stamp other) {
            return other != null
                    && writer == other.writer
                    && bindingSource.equals(other.bindingSource)
                    && dataVersion == other.dataVersion
                    && invalidationVersion == other.invalidationVersion
                    && carrierStatusTable == other.carrierStatusTable
                    && Math.abs(other.capturedWallMs - capturedWallMs) <= WALL_CLOCK_DRIFT_LIMIT_MS
                    && Objects.equals(detailSelections, other.detailSelections)
                    && Objects.equals(emptyOrderMarks, other.emptyOrderMarks);
        }
    }

    private static final class Memo {
        final Stamp stamp;
        final long startedAtNanos;
        final List<ExpressItem> rows;

        Memo(Stamp stamp, long startedAtNanos, List<ExpressItem> rows) {
            this.stamp = stamp;
            this.startedAtNanos = startedAtNanos;
            this.rows = Collections.unmodifiableList(new ArrayList<>(rows));
        }
    }

    private final Context context;
    private final Object sideConnectionLock = new Object();
    private final Object listProjectionLock = new Object();
    private SQLiteDatabase sideConnectionsFor;
    private SQLiteDatabase stampConnection;
    private SQLiteDatabase listReadConnection;
    private volatile Memo latestMemo;
    private final AtomicInteger listVisibleComputations = new AtomicInteger();
    private final AtomicInteger listProjectionsWithoutMonitor = new AtomicInteger();
    private final AtomicInteger listProjectionFallbacks = new AtomicInteger();

    ExpressReadSidePool(Context context, ExpressDatabase helper) {
        this.context = context;
        if (helper != null) {
            helper.addCloseListener(this::close);
        }
    }

    List<ExpressItem> sharedListVisible(
            SQLiteDatabase writer,
            String bindingSource,
            long invalidationVersion,
            Map<String, String> detailSelections) {
        Memo memo = latestMemo;
        if (memo == null || System.nanoTime() - memo.startedAtNanos > SHARE_WINDOW_NANOS) {
            return null;
        }
        Stamp current = captureStamp(writer, bindingSource, invalidationVersion, detailSelections);
        return memo.stamp.sameAs(current) ? memo.rows : null;
    }

    List<ExpressItem> computeListVisibleReadOnly(
            SQLiteDatabase writer,
            String bindingSource,
            long invalidationVersion,
            Map<String, String> detailSelections,
            Function<SQLiteDatabase, List<ExpressItem>> projection) {
        if (!supportsReadOnlyTransactions()) return null;
        synchronized (listProjectionLock) {
            List<ExpressItem> shared = sharedListVisible(
                    writer, bindingSource, invalidationVersion, detailSelections);
            if (shared != null) return shared;
            Stamp before = captureStamp(
                    writer, bindingSource, invalidationVersion, detailSelections);
            long startedAtNanos = System.nanoTime();
            List<ExpressItem> computed = readOnlySide(writer, projection);
            if (computed == null) return null;
            List<ExpressItem> frozen = Collections.unmodifiableList(new ArrayList<>(computed));
            if (before != null) {
                latestMemo = new Memo(before, startedAtNanos, frozen);
            }
            listVisibleComputations.incrementAndGet();
            listProjectionsWithoutMonitor.incrementAndGet();
            return frozen;
        }
    }

    <T> T readOnlySide(SQLiteDatabase writer, Function<SQLiteDatabase, T> read) {
        if (!supportsReadOnlyTransactions()) return null;
        synchronized (listProjectionLock) {
            try {
                if (writer == null || !writer.isOpen() || writer.inTransaction()) {
                    return null;
                }
                SQLiteDatabase connection = sideConnection(writer, false);
                if (connection == null) return null;
                connection.beginTransactionReadOnly();
                try {
                    return read.apply(connection);
                } finally {
                    connection.endTransaction();
                }
            } catch (RuntimeException fallbackRequired) {
                listProjectionFallbacks.incrementAndGet();
                return null;
            }
        }
    }

    Stamp captureStamp(
            SQLiteDatabase writer,
            String bindingSource,
            long invalidationVersion,
            Map<String, String> detailSelections) {
        try {
            if (writer == null || !writer.isOpen() || writer.inTransaction()) return null;
            SQLiteDatabase stamp = sideConnection(writer, true);
            if (stamp == null) return null;
            long dataVersion = DatabaseUtils.longForQuery(stamp, "PRAGMA data_version", null);
            Map<String, ?> emptyMarks = context == null
                    ? Collections.emptyMap()
                    : new HashMap<>(context.getSharedPreferences(
                            JingDongEmptyOrderPages.PREFERENCES, 0).getAll());
            return new Stamp(
                    writer,
                    bindingSource,
                    dataVersion,
                    invalidationVersion,
                    detailSelections,
                    emptyMarks,
                    CarrierRegistry.statusLabels(),
                    System.currentTimeMillis());
        } catch (RuntimeException unavailable) {
            return null;
        }
    }

    void recordLockedComputation(Stamp preStamp, long startedAtNanos, List<ExpressItem> computed) {
        listVisibleComputations.incrementAndGet();
        if (preStamp != null && computed != null) {
            latestMemo = new Memo(preStamp, startedAtNanos, computed);
        }
    }

    void close() {
        latestMemo = null;
        synchronized (sideConnectionLock) {
            closeQuietly(stampConnection);
            closeQuietly(listReadConnection);
            stampConnection = null;
            listReadConnection = null;
            sideConnectionsFor = null;
        }
    }

    int listVisibleComputationsForTest() {
        return listVisibleComputations.get();
    }

    int listProjectionsWithoutMonitorForTest() {
        return listProjectionsWithoutMonitor.get();
    }

    int listProjectionFallbacksForTest() {
        return listProjectionFallbacks.get();
    }

    private static boolean supportsReadOnlyTransactions() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM;
    }

    private SQLiteDatabase sideConnection(SQLiteDatabase writer, boolean stampReader) {
        synchronized (sideConnectionLock) {
            if (sideConnectionsFor != writer) {
                closeQuietly(stampConnection);
                closeQuietly(listReadConnection);
                stampConnection = null;
                listReadConnection = null;
                sideConnectionsFor = writer;
            }
            SQLiteDatabase current = stampReader ? stampConnection : listReadConnection;
            if (current != null && current.isOpen()) return current;
            String path = writer.getPath();
            if (path == null || path.isEmpty() || ":memory:".equals(path)) return null;
            current = SQLiteDatabase.openDatabase(path, null, SQLiteDatabase.OPEN_READONLY);
            if (stampReader) {
                stampConnection = current;
            } else {
                listReadConnection = current;
            }
            return current;
        }
    }

    private static void closeQuietly(SQLiteDatabase db) {
        if (db == null) return;
        try {
            db.close();
        } catch (RuntimeException ignored) {
            // Read-only side connections hold no uncommitted writes.
        }
    }
}
