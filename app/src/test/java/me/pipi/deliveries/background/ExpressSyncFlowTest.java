package me.pipi.deliveries.background;

import static org.junit.Assert.*;
import android.app.Application;
import android.content.Context;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import me.pipi.deliveries.network.ExpressSubscriptionClient;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.shadows.ShadowLog;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=31,manifest=Config.NONE,application=Application.class,shadows=ExpressSyncFlowTest.Subscription.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class ExpressSyncFlowTest {
    Context context;
    ExpressRepository repository;
    static final String PHONE="13900000001", WAYBILL="SF123456789012";
    @Before public void setUp() {
        context=RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class,"instance",null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        for (String name : new String[]{"deliveries_repository_migrations","express_account_source","express_network_success"})
            context.getSharedPreferences(name,0).edit().clear().commit();
        repository=ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE,"interface6");
        Subscription.accountQueries.set(0); Subscription.onlineQueries.set(0); Subscription.failList=false;
        ShadowLog.clear();
    }
    @After public void close() {
        ((ExpressDatabase)ReflectionHelpers.getField(repository,"helper")).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class,"instance",null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }
    @Test public void omittedSfKeepsItsAccountSnapshotAndOnlyCallsOnlineOnce() {
        String time="2026-09-12 10:00:00";
        ExpressQueryResult feed=new ExpressQueryResult(WAYBILL,"SF","顺丰速运",StatusSemantic.PICKED,
                ExpressTimeline.parseTime(time),time,"已揽收","[{\"time\":\""+time+"\",\"context\":\"已揽收\"}]",
                "",PHONE,TimelineSlot.V6_LIST,"","","ShunFeng").withAccountListMetadata(PHONE,ExpressTimeline.parseTime(time));
        repository.saveInterface6(feed,PHONE,repository.bindingGeneration(PHONE,"interface6"));
        ExpressItem before=repository.findByWaybill(WAYBILL,"interface6");
        int[] count={0,0,0};
        ExpressSyncEngine.syncAll(context,count,true,"list_pull");
        assertEquals(0,Subscription.accountQueries.get());
        assertEquals(1,Subscription.onlineQueries.get());
        assertArrayEquals(new int[]{2,2,1},count);
        ExpressItem after=repository.findByWaybill(WAYBILL,"interface6");
        assertEquals(before.rowId,after.rowId);
        assertEquals(before.listOriginAtMs,after.listOriginAtMs);
        assertEquals(PHONE,after.senderPhone);
        assertEquals(feed.tracksJson,repository.automaticSourceTimeline(after).tracksJson);
        assertNotNull(repository.manualTimelineCandidate(after,TimelineSlot.V6_QUERY));
    }
    @Test public void allFailedRefreshLogsFailureAndPropagatesWithoutAdvancingSuccessClock() {
        Subscription.failList=true;
        RuntimeException error=assertThrows(RuntimeException.class,
                ()->ExpressSyncEngine.syncAll(context,new int[]{0,0,0},false,"background"));
        assertNotNull(error);
        String logs=ShadowLog.getLogsForTag("PipiExpress").stream().map(row->row.msg).reduce("",(a,b)->a+"\n"+b);
        assertTrue(logs,logs.contains("WARNING refresh.failed"));
        assertTrue(logs,logs.contains("attempted=1"));
        assertTrue(logs,logs.contains("succeeded=0"));
        assertFalse(logs.contains("INFO refresh.succeeded"));
        assertFalse(logs.contains("Synthetic private response"));
        assertFalse(ExpressScheduler.hasRecentNetworkSuccess(context,"interface6",System.currentTimeMillis()));
    }
    @Implements(value=ExpressSubscriptionClient.class,isInAndroidSdk=false,callThroughByDefault=true)
    public static class Subscription {
        static final AtomicInteger accountQueries=new AtomicInteger(),onlineQueries=new AtomicInteger();
        static boolean failList;
        @Implementation protected List<ExpressQueryResult> query(Context context) {
            if (failList) throw new IllegalStateException("Synthetic private response");
            return List.of();
        }
        @Implementation protected ExpressQueryResult queryWaybill(Context context,String waybill,String code) {
            accountQueries.incrementAndGet();
            return null;
        }
        @Implementation protected ExpressQueryResult queryManual(Context context,String waybill,ExpressQueryCancellation cancellation) {
            onlineQueries.incrementAndGet();
            String time="2026-09-12 11:00:00";
            return new ExpressQueryResult(waybill,"SF","顺丰速运",StatusSemantic.TRANSIT,
                    ExpressTimeline.parseTime(time),time,"运输中","[{\"time\":\""+time+"\",\"context\":\"运输中\"}]",
                    "",PHONE,TimelineSlot.V6_QUERY,"","","").withManualStatusEvidence("运输中",true);
        }
    }
}
