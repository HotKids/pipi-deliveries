package me.pipi.deliveries.background;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;

import java.util.List;

import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.network.ExpressSubscriptionClient;
import me.pipi.deliveries.network.GatewayFailureFixture;

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
import org.robolectric.shadows.ShadowLog;
import org.robolectric.util.ReflectionHelpers;

/**
 * 用户 2026-09-28（Pixel 11 Pro，2026-09-27 15:29–16:39 与 09-28 00:53）：Worker 的小米列表上游到 20 秒上限回
 * 502 {"error":"upstream_unavailable"}，Lite 的 refresh.account.failed 与 refresh.failed 只记了
 * errorCategory=IllegalStateException，后者还是这一轮自己造的「All delivery sources failed」。两行都要按 iOS
 * 记 errorCategory / httpStatus / failureCode，refresh.failed 报的是账号列表那次真实的失败。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class,
        shadows = ExpressSyncGatewayFailureTest.Subscription.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class ExpressSyncGatewayFailureTest {
    private static final String PHONE = "13900009997";
    private Context context;
    private ExpressRepository repository;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        for (String name : new String[]{"deliveries_repository_migrations", "express_account_source",
                "express_network_success"}) {
            context.getSharedPreferences(name, 0).edit().clear().commit();
        }
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface6");
        ShadowLog.clear();
    }

    @After public void close() {
        ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void aWorkerUpstreamFailureIsLoggedAsTheIosCategoryOnBothFailureLines() {
        RuntimeException thrown = assertThrows(RuntimeException.class,
                () -> ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "foreground"));
        assertTrue("the round still fails for WorkManager", thrown instanceof IllegalStateException);
        String account = line(" ERROR refresh.account.failed ");
        assertTrue(account, account.endsWith(" errorCategory=service httpStatus=502 failureCode=upstream_unavailable"));
        String round = line(" ERROR refresh.failed ");
        assertTrue(round, round.contains(" result=failed errorCategory=service httpStatus=502 failureCode=upstream_unavailable"));
        assertFalse(round, round.contains("IllegalStateException") || round.contains("AllSourcesFailed"));
    }

    /** Left for later ⑤: the account list failure carries how long the request took, as iOS account.sync.failed. */
    @Test public void theAccountListFailureCarriesItsDuration() {
        assertThrows(RuntimeException.class,
                () -> ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "foreground"));
        String account = line(" ERROR refresh.account.failed ");
        assertTrue(account, account.matches(".* durationMs=\\d+ errorCategory=service .*"));
    }

    private static String line(String marker) {
        return ShadowLog.getLogsForTag("PipiExpress").stream().map(row -> row.msg)
                .filter(message -> message.contains(marker)).findFirst()
                .orElseThrow(() -> new AssertionError(marker));
    }

    @Implements(value = ExpressSubscriptionClient.class, isInAndroidSdk = false, callThroughByDefault = true)
    public static class Subscription {
        @Implementation protected List<ExpressQueryResult> query(Context context) {
            throw GatewayFailureFixture.upstreamUnavailable();
        }
    }
}
