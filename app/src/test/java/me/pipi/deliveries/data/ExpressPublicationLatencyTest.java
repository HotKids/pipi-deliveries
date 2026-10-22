package me.pipi.deliveries.data;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.Context;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.widget.ExpressWidgetProvider;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.SQLiteMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class,
        shadows = {ExpressPublicationLatencyTest.BlockingWidgets.class,
                ExpressPublicationLatencyTest.BlockingNotifications.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressPublicationLatencyTest {
    private Context context;
    private ExpressRepository repository;
    private ExecutorService caller;

    @Implements(value = ExpressWidgetProvider.class, isInAndroidSdk = false)
    public static class BlockingWidgets {
        static CountDownLatch entered;
        static CountDownLatch release;

        @Implementation public static void refreshAll(Context ignored) {
            entered.countDown();
            try { release.await(5L, TimeUnit.SECONDS); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        }
    }

    @Implements(android.app.NotificationManager.class)
    public static class BlockingNotifications extends ExpressRepositoryDatabaseTest.FailingNotifications {
        static CountDownLatch entered;
        static CountDownLatch release;
        static boolean failCancel;
        @Implementation @Override public void notify(int id, android.app.Notification notification) {
            if (entered != null) entered.countDown();
            if (release != null) try { release.await(5L, TimeUnit.SECONDS); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            super.notify(id, notification);
        }
        @Implementation @Override public void cancel(int id) {
            if (failCancel) throw new IllegalStateException("Synthetic cancel failure");
            super.cancel(id);
        }
    }

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        repository = new ExpressRepository(context);
        caller = Executors.newSingleThreadExecutor();
        BlockingWidgets.entered = new CountDownLatch(1);
        BlockingWidgets.release = new CountDownLatch(1);
        ExpressRepositoryDatabaseTest.FailingNotifications.attempts = 0;
        ExpressRepositoryDatabaseTest.FailingNotifications.fail = false;
        BlockingNotifications.entered = null;
        BlockingNotifications.release = null;
        BlockingNotifications.failCancel = false;
    }

    @After public void tearDown() throws Exception {
        BlockingWidgets.release.countDown();
        if (BlockingNotifications.release != null) BlockingNotifications.release.countDown();
        caller.shutdown();
        assertTrue(caller.awaitTermination(3L, TimeUnit.SECONDS));
        try {
            Field worker = ExpressRepository.class.getDeclaredField("PUBLICATION_WORKER");
            worker.setAccessible(true);
            ((ExecutorService) worker.get(null)).submit(() -> {}).get(3L, TimeUnit.SECONDS);
        } catch (NoSuchFieldException baseline) {
            // The pre-fix implementation has no deferred publication queue.
        }
        Field helper = ExpressRepository.class.getDeclaredField("helper");
        helper.setAccessible(true);
        ((ExpressDatabase) helper.get(repository)).close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void committedMutationAndLocalReadsDoNotWaitForWidgetRendering() throws Exception {
        java.util.concurrent.Future<?> saved = caller.submit(() -> repository.saveManualQueryResult(
                result("SFLATENCY0001", StatusSemantic.TRANSIT), "", "interface5"));
        assertTrue(BlockingWidgets.entered.await(2L, TimeUnit.SECONDS));
        saved.get(1L, TimeUnit.SECONDS);
        assertTrue(repository.invalidationVersion() > 0L);
        assertNotNull(repository.findByWaybill("SFLATENCY0001", "interface5"));
    }

    @Test public void deferredNotificationsKeepTheirOutboxAndCannotReviveADeletedOwner() throws Exception {
        java.util.concurrent.Future<?> saved = caller.submit(() -> repository.saveManualQueryResult(
                result("SFLATENCY0002", StatusSemantic.TRANSIT), "", "interface5"));
        assertTrue(BlockingWidgets.entered.await(2L, TimeUnit.SECONDS));
        saved.get(1L, TimeUnit.SECONDS);
        repository.saveManualQueryResult(result("SFLATENCY0002", StatusSemantic.COMPLETED), "", "interface5");
        assertEquals(0, ExpressRepositoryDatabaseTest.FailingNotifications.attempts);
        Field helper = ExpressRepository.class.getDeclaredField("helper");
        helper.setAccessible(true);
        android.database.sqlite.SQLiteDatabase db = ((ExpressDatabase) helper.get(repository)).getReadableDatabase();
        assertEquals(1L, android.database.DatabaseUtils.queryNumEntries(db,
                ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
        repository.delete(repository.findByWaybill("SFLATENCY0002", "interface5").rowId);
        assertNull(repository.findByWaybill("SFLATENCY0002", "interface5"));
        BlockingWidgets.release.countDown();
        Field worker = ExpressRepository.class.getDeclaredField("PUBLICATION_WORKER");
        worker.setAccessible(true);
        ((ExecutorService) worker.get(null)).submit(() -> {}).get(3L, TimeUnit.SECONDS);
        assertEquals(0, ExpressRepositoryDatabaseTest.FailingNotifications.attempts);
        assertEquals(0L, android.database.DatabaseUtils.queryNumEntries(db,
                ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
    }

    @Test public void blockedNotificationDoesNotHoldLocalReadsOrDeletionAndCannotSurviveDeletion() throws Exception {
        BlockingWidgets.release.countDown();
        repository.saveManualQueryResult(result("SFLATENCY0003", StatusSemantic.TRANSIT), "", "interface5");
        drain();
        BlockingNotifications.entered = new CountDownLatch(1);
        BlockingNotifications.release = new CountDownLatch(1);
        repository.saveManualQueryResult(result("SFLATENCY0003", StatusSemantic.COMPLETED), "", "interface5");
        assertTrue(BlockingNotifications.entered.await(2L, TimeUnit.SECONDS));
        assertNotNull(caller.submit(() -> repository.homeRows("interface5")).get(1L, TimeUnit.SECONDS));
        long id = repository.findByWaybill("SFLATENCY0003", "interface5").rowId;
        caller.submit(() -> repository.delete(id)).get(1L, TimeUnit.SECONDS);
        assertNull(repository.find(id));
        BlockingNotifications.release.countDown();
        drain();
        assertEquals(0, context.getSystemService(android.app.NotificationManager.class).getActiveNotifications().length);
        assertEquals(0L, android.database.DatabaseUtils.queryNumEntries(database(), ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
    }

    @Test public void cancellationFailureSurvivesRepositoryRecreation() throws Exception {
        BlockingWidgets.release.countDown();
        repository.saveManualQueryResult(result("SFLATENCY0004", StatusSemantic.TRANSIT), "", "interface5");
        repository.saveManualQueryResult(result("SFLATENCY0004", StatusSemantic.COMPLETED), "", "interface5");
        drain();
        assertEquals(1, context.getSystemService(android.app.NotificationManager.class).getActiveNotifications().length);
        BlockingNotifications.failCancel = true;
        repository.delete(repository.findByWaybill("SFLATENCY0004", "interface5").rowId);
        drain();
        assertEquals(1L, android.database.DatabaseUtils.queryNumEntries(database(), ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
        Field helper = ExpressRepository.class.getDeclaredField("helper"); helper.setAccessible(true);
        ((ExpressDatabase) helper.get(repository)).close();
        repository = new ExpressRepository(context);
        BlockingNotifications.failCancel = false;
        repository.replayPendingNotifications();
        assertEquals(0, context.getSystemService(android.app.NotificationManager.class).getActiveNotifications().length);
        assertEquals(0L, android.database.DatabaseUtils.queryNumEntries(database(), ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
    }

    @Test public void oldPostAcknowledgementCannotEraseANewerPendingStatus() throws Exception {
        BlockingWidgets.release.countDown();
        repository.saveManualQueryResult(result("SFLATENCY0005", StatusSemantic.TRANSIT), "", "interface5");
        drain();
        BlockingNotifications.entered = new CountDownLatch(1);
        BlockingNotifications.release = new CountDownLatch(1);
        repository.saveManualQueryResult(result("SFLATENCY0005", StatusSemantic.DELIVERY), "", "interface5");
        assertTrue(BlockingNotifications.entered.await(2L, TimeUnit.SECONDS));
        String oldToken = eventToken();
        repository.saveManualQueryResult(result("SFLATENCY0005", StatusSemantic.COMPLETED), "", "interface5");
        assertNotEquals(oldToken, eventToken());
        BlockingNotifications.release.countDown();
        drain();
        assertEquals(2, ExpressRepositoryDatabaseTest.FailingNotifications.attempts);
        assertEquals(0L, android.database.DatabaseUtils.queryNumEntries(database(), ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
        var active = context.getSystemService(android.app.NotificationManager.class).getActiveNotifications();
        assertEquals(1, active.length);
        assertTrue(active[0].getNotification().extras.getString("android.title").contains("已签收"));
    }

    @Test public void delayedCancellationCannotRemoveTheRecreatedParcelsNotification() throws Exception {
        BlockingWidgets.release.countDown();
        repository.saveManualQueryResult(result("SFLATENCY0006", StatusSemantic.TRANSIT), "", "interface5");
        drain();
        long oldId = repository.findByWaybill("SFLATENCY0006", "interface5").rowId;
        BlockingNotifications.entered = new CountDownLatch(1);
        BlockingNotifications.release = new CountDownLatch(1);
        repository.saveManualQueryResult(result("SFLATENCY0006", StatusSemantic.DELIVERY), "", "interface5");
        assertTrue(BlockingNotifications.entered.await(2L, TimeUnit.SECONDS));
        caller.submit(() -> repository.delete(oldId)).get(1L, TimeUnit.SECONDS);
        repository.saveManualQueryResult(result("SFLATENCY0006", StatusSemantic.TRANSIT), "", "interface5");
        long newId = repository.findByWaybill("SFLATENCY0006", "interface5").rowId;
        assertTrue("AUTOINCREMENT preserves the notification identity of the replacement", newId > oldId);
        repository.saveManualQueryResult(result("SFLATENCY0006", StatusSemantic.COMPLETED), "", "interface5");
        BlockingNotifications.release.countDown();
        drain();
        var active = context.getSystemService(android.app.NotificationManager.class).getActiveNotifications();
        assertEquals(1, active.length);
        assertEquals((int) newId, active[0].getId());
        assertNull(repository.find(oldId));
        assertEquals(StatusSemantic.COMPLETED, repository.find(newId).semantic);
    }

    private String eventToken() throws Exception {
        try (android.database.Cursor cursor = database().query(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE,
                new String[]{"event_token"}, null, null, null, null, null)) {
            assertTrue(cursor.moveToFirst()); return cursor.getString(0);
        }
    }

    private android.database.sqlite.SQLiteDatabase database() throws Exception {
        Field helper = ExpressRepository.class.getDeclaredField("helper"); helper.setAccessible(true);
        return ((ExpressDatabase) helper.get(repository)).getReadableDatabase();
    }
    private static void drain() throws Exception {
        Field worker = ExpressRepository.class.getDeclaredField("PUBLICATION_WORKER"); worker.setAccessible(true);
        ((ExecutorService) worker.get(null)).submit(() -> {}).get(3L, TimeUnit.SECONDS);
    }

    private static ExpressQueryResult result(String waybill, StatusSemantic semantic) {
        long time = System.currentTimeMillis() - (semantic == StatusSemantic.COMPLETED ? 60_000L : 120_000L);
        java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.CHINA);
        format.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Shanghai"));
        String stamp = format.format(new java.util.Date(time));
        return new ExpressQueryResult(waybill, "SF", "顺丰速运", semantic, time,
                stamp, semantic.name(), "[{\"time\":\"" + stamp + "\",\"context\":\"" + semantic.name() + "\"}]",
                "", "", TimelineSlot.V4_QUERY, "", "", "")
                .withManualStatusEvidence(semantic.label, true);
    }
}
