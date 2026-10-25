package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.os.Looper;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import me.pipi.deliveries.R;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.ManualQuerySuccess;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import me.pipi.deliveries.network.ExpressSubscriptionClient;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.RealObject;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        shadows = {ExpressFirstManualQueryTest.OnlineShadow.class,
                ExpressFirstManualQueryTest.CaptureShadow.class,
                me.pipi.deliveries.data.ExpressAutomaticDetailPersistenceTest.SyntheticSecretBox.class})
public final class ExpressFirstManualQueryTest {
    @Before public void reset() {
        OnlineShadow.fail = false;
        OnlineShadow.expired = false;
        OnlineShadow.stageBudget = 0;
        OnlineShadow.operationBudget = 0;
        OnlineShadow.result = null;
        OnlineShadow.beforeReturn = null;
        OnlineShadow.cancelOperation = false;
        CaptureShadow.routes.clear();
    }

    @Implements(value = ExpressSubscriptionClient.class, isInAndroidSdk = false)
    public static class OnlineShadow {
        static boolean fail;
        static boolean expired;
        static int stageBudget;
        static int operationBudget;
        static ExpressQueryResult result;
        static Runnable beforeReturn;
        static boolean cancelOperation;
        @Implementation protected ExpressQueryResult queryManual(Context context, String waybill,
                ExpressQueryCancellation cancellation) throws Exception {
            Method budget = ExpressQueryCancellation.class.getDeclaredMethod(
                    "remainingTimeoutMillis", int.class);
            budget.setAccessible(true);
            stageBudget = (Integer) budget.invoke(cancellation, 60000);
            Field parent = ExpressQueryCancellation.class.getDeclaredField("parent");
            parent.setAccessible(true);
            ExpressQueryCancellation operation = (ExpressQueryCancellation) parent.get(cancellation);
            operationBudget = (Integer) budget.invoke(operation == null ? cancellation : operation, 60000);
            if (cancelOperation) {
                operation.cancel();
                throw new java.util.concurrent.CancellationException("Synthetic whole-query cancellation");
            }
            if (expired) {
                cancellation.cancel();
                throw new InterruptedException("Synthetic Online stage deadline");
            }
            if (fail) throw new IllegalStateException("Synthetic Online failure");
            if (beforeReturn != null) beforeReturn.run();
            return result;
        }
    }

    @Implements(value = ExpressKuaidi100TimelineCapture.class, isInAndroidSdk = false)
    public static class CaptureShadow {
        static final List<String> routes = new ArrayList<>();
        @RealObject ExpressKuaidi100TimelineCapture capture;
        ExpressKuaidi100TimelineCapture.Callback callback;
        String route;
        @Implementation protected void __constructor__(Activity host, String route, String waybill,
                String phone, ExpressKuaidi100TimelineCapture.Callback callback) {
            this.route = route;
            this.callback = callback;
        }
        @Implementation protected boolean start() {
            routes.add(route);
            callback.onFinished(capture, "[{\"time\":\"2026-10-15 10:01:00\",\"context\":\"已揽收\"}]");
            return true;
        }
        @Implementation protected void usePhoneCandidates(List<String> phones) {}
        @Implementation protected boolean needsPhoneTail() { return false; }
        @Implementation protected void cancel() {}
    }

    @Test public void firstAddEmptyOnlineReachesFixedK100AndCommitsItsResult() throws Exception {
        verifyFirstAdd("LITEFIRSTEMPTY1234", "ZTO", false,
                "https://m.kuaidi100.com/app/query/?nu=LITEFIRSTEMPTY1234", TimelineSlot.K100_H5);
    }

    @Test public void firstAddFailedOnlineReachesFixedK100AndCommitsItsResult() throws Exception {
        verifyFirstAdd("LITEFIRSTFAILED1234", "ZTO", true,
                "https://m.kuaidi100.com/app/query/?nu=LITEFIRSTFAILED1234", TimelineSlot.K100_H5);
    }

    @Test public void firstAddExpiredOnlineStageStillReachesPrimaryWithinTheOperationBudget() throws Exception {
        OnlineShadow.expired = true;
        verifyFirstAdd("LITEFIRSTEXPIRED1234", "ZTO", false,
                "https://m.kuaidi100.com/app/query/?nu=LITEFIRSTEXPIRED1234", TimelineSlot.K100_H5);
    }

    @Test public void firstAddJtRetainsTheOfficialPrimaryRoute() throws Exception {
        verifyFirstAdd("LITEFIRSTJT1234", "JTSD", true,
                "https://jtsd.jtexpress.com.cn/pipi#/pages/checkGoods/sendDetail?waybillNo=LITEFIRSTJT1234&isFrom=serach",
                TimelineSlot.JT_H5);
    }

    @Test public void ordinaryCancellationKeepsTheFirstManualPreviewOpen() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        OnlineShadow.cancelOperation = true;
        ActivityController<ExpressDetailActivity> controller = Robolectric.buildActivity(
                ExpressDetailActivity.class, ExpressDetailActivity.manualQueryIntent(
                        context, "LITECANCELKEEP1234", "", "SF", "interface6"));
        ExpressDetailActivity activity = controller.get();
        activity.setTheme(R.style.AppTheme);
        controller.create().start().resume();
        try {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (System.nanoTime() < deadline) {
                Shadows.shadowOf(Looper.getMainLooper()).idle();
                if (OnlineShadow.stageBudget > 0 && !(Boolean) field(activity, "firstManualQueryInFlight")) break;
                Thread.sleep(5);
            }
            assertTrue(OnlineShadow.stageBudget > 0);
            assertFalse((Boolean) field(activity, "firstManualQueryInFlight"));
            assertFalse(activity.isFinishing());
            assertNotNull(field(activity, "previewResult"));
            ExpressQueryCancellation cancelled = new ExpressQueryCancellation(30000L);
            cancelled.cancel();
            org.robolectric.util.ReflectionHelpers.setField(activity, "firstManualQueryInFlight", true);
            org.robolectric.util.ReflectionHelpers.setField(activity, "firstManualQueryCancellation", cancelled);
            Method fail = ExpressDetailActivity.class.getDeclaredMethod("failFirstManualQuery",
                    Exception.class, String.class, String.class, ExpressQueryCancellation.class);
            fail.setAccessible(true);
            fail.invoke(activity, new java.util.concurrent.CancellationException("Synthetic cancellation callback"),
                    "LITECANCELKEEP1234", "SF", cancelled);
            assertFalse(activity.isFinishing());
            assertNotNull(field(activity, "previewResult"));
        } finally {
            controller.pause().stop().destroy();
        }
    }

    @Test public void deletingExistingSfDuringOnlineDoesNotQueryPrimaryOrQueueTheDeletedRow() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        ExpressRepository repository = ExpressRepository.get(context);
        String waybill = "LITEDELETEDSF1234", phone = "13800000001";
        repository.bindPhoneLocally(phone, "interface6");
        repository.saveInterface6(sfPacket(waybill, phone, "interface6", "2026-10-14 10:00:00",
                StatusSemantic.TRANSIT, "ShunFeng"), phone);
        ExpressItem owner = repository.findByWaybill(waybill, "interface6");
        OnlineShadow.beforeReturn = () -> repository.delete(owner.rowId);
        OnlineShadow.result = sfPacket(waybill, phone, TimelineSlot.V6_QUERY,
                "2026-10-15 10:00:00", StatusSemantic.TRANSIT, "");
        ActivityController<ExpressDetailActivity> controller = Robolectric.buildActivity(
                ExpressDetailActivity.class, ExpressDetailActivity.manualQueryIntent(
                        context, waybill, phone, "SF", "interface6"));
        ExpressDetailActivity activity = controller.get();
        activity.setTheme(R.style.AppTheme);
        controller.create().start().resume();
        try {
            ExecutorService worker = (ExecutorService) field(activity, "worker");
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (System.nanoTime() < deadline && !activity.isFinishing()) {
                Shadows.shadowOf(Looper.getMainLooper()).idle();
                Thread.sleep(5);
            }
            worker.submit(() -> {}).get(1, TimeUnit.SECONDS);
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertTrue(activity.isFinishing());
            assertEquals(ExpressToastCopy.DELETED, org.robolectric.shadows.ShadowToast.getTextOfLatestToast());
            assertTrue(CaptureShadow.routes.toString(), CaptureShadow.routes.isEmpty());
            assertNull(repository.find(owner.rowId));
            assertTrue(repository.claimPendingManualQueries(System.currentTimeMillis(), "interface6").isEmpty());
        } finally {
            controller.pause().stop().destroy();
        }
    }

    @Test public void addingExistingSfRendersTheAcceptedSavedPacketAfterTheQuery() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        ExpressRepository repository = ExpressRepository.get(context);
        String waybill = "LITEEXISTINGSF1234", phone = "13800000001";
        repository.bindPhoneLocally(phone, "interface6");
        ExpressQueryResult feed = sfPacket(waybill, phone, "interface6", "2026-10-14 10:00:00",
                StatusSemantic.TRANSIT, "ShunFeng");
        repository.saveInterface6(feed, phone);
        ExpressItem owner = repository.findByWaybill(waybill, "interface6");
        ExpressQueryResult accepted = sfPacket(waybill, phone, TimelineSlot.K100_H5,
                "2026-10-16 10:00:00", StatusSemantic.DELIVERY, "");
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.K100_H5, accepted, 100L, false)), phone, "interface6");
        repository.rememberDetailSelection(owner, TimelineSlot.K100_H5);
        OnlineShadow.result = sfPacket(waybill, phone, TimelineSlot.V6_QUERY,
                "2026-10-15 10:00:00", StatusSemantic.TRANSIT, "");
        ActivityController<ExpressDetailActivity> controller = Robolectric.buildActivity(
                ExpressDetailActivity.class, ExpressDetailActivity.manualQueryIntent(
                        context, waybill, phone, "SF", "interface6"));
        ExpressDetailActivity activity = controller.get();
        activity.setTheme(R.style.AppTheme);
        controller.create().start().resume();
        try {
            ExecutorService worker = (ExecutorService) field(activity, "worker");
            Future<?> drained = worker.submit(() -> {});
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (System.nanoTime() < deadline) {
                Shadows.shadowOf(Looper.getMainLooper()).idle();
                if (drained.isDone()) {
                    if (OnlineShadow.stageBudget > 0
                            && !(Boolean) field(activity, "firstManualQueryInFlight")) break;
                    drained = worker.submit(() -> {});
                }
                Thread.sleep(5);
            }
            drained.get(1, TimeUnit.SECONDS);
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertEquals(Activity.RESULT_OK, Shadows.shadowOf(activity).getResultCode());
            assertEquals(StatusSemantic.DELIVERY, repository.find(owner.rowId).semantic);
            ExpressQueryResult displayed = (ExpressQueryResult) field(activity, "previewResult");
            assertEquals(StatusSemantic.DELIVERY, displayed.semantic);
            assertEquals(accepted.statusEventTime, displayed.statusEventTime);
            assertEquals(accepted.latestDetail, displayed.latestDetail);
        } finally {
            controller.pause().stop().destroy();
        }
    }

    private static ExpressQueryResult sfPacket(String waybill, String phone, String provider,
            String at, StatusSemantic status, String source) {
        String detail = "Synthetic " + status;
        return new ExpressQueryResult(waybill, "SF", "SF Express", status,
                ExpressTimeline.parseTime(at), at, detail,
                "[{\"time\":\"" + at + "\",\"context\":\"" + detail + "\",\"statusCode\":\""
                        + (status == StatusSemantic.DELIVERY ? "5" : "0") + "\"}]",
                "", phone, provider, "", "", source).withManualStatusEvidence(status.label, true);
    }

    private void verifyFirstAdd(String waybill, String code, boolean failed, String route,
            String provider) throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        OnlineShadow.fail = failed;
        ActivityController<ExpressDetailActivity> controller = Robolectric.buildActivity(
                ExpressDetailActivity.class, ExpressDetailActivity.manualQueryIntent(
                        context, waybill, "", code, "interface6"));
        ExpressDetailActivity activity = controller.get();
        activity.setTheme(R.style.AppTheme);
        controller.create().start().resume();
        try {
            ExecutorService worker = (ExecutorService) field(activity, "worker");
            Future<?> drained = worker.submit(() -> {});
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (System.nanoTime() < deadline) {
                Shadows.shadowOf(Looper.getMainLooper()).idle();
                if (drained.isDone()) {
                    if (OnlineShadow.stageBudget > 0
                            && !(Boolean) field(activity, "firstManualQueryInFlight")) break;
                    drained = worker.submit(() -> {});
                }
                Thread.sleep(5);
            }
            drained.get(1, TimeUnit.SECONDS);
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertEquals(List.of(route), CaptureShadow.routes);
            assertTrue(OnlineShadow.stageBudget > 0 && OnlineShadow.stageBudget <= 15000);
            assertTrue(OnlineShadow.operationBudget > 15000 && OnlineShadow.operationBudget <= 30000);
            ExpressItem stored = ExpressRepository.get(context).findByWaybill(waybill, "interface6");
            assertNotNull(stored);
            assertEquals(Activity.RESULT_OK, Shadows.shadowOf(activity).getResultCode());
            assertEquals(provider, ExpressRepository.get(context).manualDetailTimelineAuthority(stored).provider);
        } finally {
            controller.pause().stop().destroy();
        }
    }

    private static Object field(Object target, String name) throws Exception {
        Field field = ExpressDetailActivity.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(target);
    }
}
