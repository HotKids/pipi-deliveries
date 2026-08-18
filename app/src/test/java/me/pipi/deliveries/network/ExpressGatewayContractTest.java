package me.pipi.deliveries.network;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/** Prevents upstream endpoints and provider credentials from returning to the APK source set. */
public final class ExpressGatewayContractTest {
    @Test
    public void allAdaptersUseSemanticGatewayRoutesOnly() throws Exception {
        String api = source("me/pipi/deliveries/network/ExpressApi.java");
        String account = source("me/pipi/deliveries/network/ExpressDiscoveryClient.java");
        String subscription = source(
                "me/pipi/deliveries/network/ExpressSubscriptionClient.java");
        String adapters = api + account + subscription;

        assertTrue(api.contains("/api/express/classify"));
        assertTrue(api.contains("/api/express/timeline/preferred"));
        assertTrue(api.contains("/api/express/timeline/public"));
        assertTrue(account.contains("/api/express/accounts/code"));
        assertTrue(account.contains("/api/express/accounts/bind"));
        assertTrue(account.contains("/api/express/accounts/sync"));
        assertTrue(account.contains("/api/express/timeline/source"));
        assertTrue(account.contains("put(\"interface\", \"v5\")"));
        assertTrue(subscription.contains("/api/express/accounts/code"));
        assertTrue(subscription.contains("/api/express/accounts/bind"));
        assertTrue(subscription.contains("/api/express/accounts/sync"));
        assertTrue(subscription.contains("/api/express/timeline/source"));
        assertTrue(subscription.contains("put(\"interface\", \"v6\")"));

        assertFalse(api.contains("https://"));
        assertFalse(account.contains("https://"));
        assertFalse(subscription.contains("https://"));
        assertFalse(source("me/pipi/deliveries/feature/express/ExpressDetailActivity.java")
                .contains("/api/express/detail"));
        assertFalse(adapters.contains("Cipher.getInstance"));
        assertFalse(adapters.contains("SecretKeySpec"));
        assertFalse(adapters.contains("IvParameterSpec"));
        assertFalse(adapters.contains("MessageDigest.getInstance(\"MD5\")"));
    }

    @Test
    public void publicTimelineNeverActsAsAnAccountInterface() throws Exception {
        String api = source("me/pipi/deliveries/network/ExpressApi.java");
        String account = source("me/pipi/deliveries/network/ExpressDiscoveryClient.java");
        assertTrue(api.contains("/api/express/timeline/public"));
        assertFalse(api.contains("/api/express/accounts/"));
        assertFalse(account.contains("put(\"interface\", \"v4\")"));
        assertFalse(account.contains("put(\"interface\", \"v6\")"));
    }

    @Test
    public void bindingUsesSelectedAccountSourceAndSchedulesBackgroundImport() throws Exception {
        String login = source("me/pipi/deliveries/feature/express/ExpressLoginActivity.java");
        String sync = source("me/pipi/deliveries/background/ExpressSyncEngine.java");
        assertTrue(login.contains("ExpressAccountSource.isV5(this)"));
        assertTrue(login.contains("new ExpressDiscoveryClient().bind(this, number, verification)"));
        assertTrue(login.contains("new ExpressSubscriptionClient().bind(this, number, verification)"));
        assertTrue(login.contains("ExpressAccountSource.bindingSource(this)"));
        assertTrue(login.contains("ExpressScheduler.requestNow(this)"));
        assertTrue(sync.contains("discovery.sync(context, boundPhones)"));
        assertTrue(sync.contains("subscription.query(context)"));
    }

    @Test
    public void accountSourcePersistsDiscoveryBeforeDetailEnrichment() throws Exception {
        String account = source("me/pipi/deliveries/network/ExpressDiscoveryClient.java");
        String sync = source("me/pipi/deliveries/background/ExpressSyncEngine.java");
        int summaryWrite = account.indexOf(
                "repository.saveInterface5OrderSummary(jd, associatedPhone)");
        int detailPhase = account.indexOf("for (JSONObject item : discovered)");
        assertTrue(summaryWrite >= 0 && detailPhase > summaryWrite);
        assertTrue(account.contains("refreshKnown(Context context, ExpressItem item)"));
        assertTrue(sync.contains("discovery.refreshKnown(context, item)"));
    }

    @Test
    public void detailScreenNeverCallsTheGatewayToResolveAProviderRoute() throws Exception {
        String detail = source("me/pipi/deliveries/feature/express/ExpressDetailActivity.java");
        assertFalse(detail.contains("ExpressDetailGateway"));
        assertTrue(detail.contains("item.routeCredentialAvailable"));
        assertTrue(detail.contains("CainiaoRoute.isLegacyCredentialedUrl"));
        assertTrue(detail.contains("putExtra(EXTRA_ROUTE_INTERFACE"));
        assertTrue(detail.contains("putExtra(EXTRA_ROUTE_CREDENTIAL"));
        assertTrue(detail.contains("intent.getStringExtra(EXTRA_ROUTE_INTERFACE)"));
        assertTrue(detail.contains("intent.getStringExtra(EXTRA_ROUTE_CREDENTIAL)"));
        assertFalse(detail.contains("addJavascriptInterface"));
        assertFalse(detail.contains("@JavascriptInterface"));
    }

    @Test
    public void repositoryUsesOnlyNeutralProviderNames() throws Exception {
        List<String> forbidden = List.of(
                new String(new char[]{'m', 'e', 'i', 'z', 'u'}),
                new String(new char[]{'x', 'i', 'a', 'o', 'm', 'i'}),
                new String(new char[]{(char) 39749, (char) 26063}),
                new String(new char[]{(char) 23567, (char) 31859}));
        Path root = Files.isDirectory(Path.of("app/src/main"))
                ? Path.of(".") : Path.of("..");
        try (java.util.stream.Stream<Path> paths = Files.walk(root)) {
            for (Path path : (Iterable<Path>) paths::iterator) {
                if (!Files.isRegularFile(path) || !isRepositoryText(path)) continue;
                String content = Files.readString(path, StandardCharsets.UTF_8).toLowerCase();
                for (String value : forbidden) {
                    assertFalse(path + " contains a legacy provider name",
                            content.contains(value.toLowerCase()));
                }
            }
        }
    }

    private static boolean isRepositoryText(Path path) {
        String value = path.toString().replace('\\', '/');
        if (value.contains("/.git/") || value.contains("/build/")
                || value.contains("/dist/") || value.endsWith("/local.properties")) {
            return false;
        }
        return value.endsWith(".java") || value.endsWith(".xml")
                || value.endsWith(".md") || value.endsWith(".kts")
                || value.endsWith(".properties") || value.endsWith(".pro")
                || value.endsWith(".yml") || value.endsWith(".yaml")
                || value.endsWith(".sh");
    }

    private static String source(String relative) throws Exception {
        Path path = Path.of("src/main/java").resolve(relative);
        if (!Files.isRegularFile(path)) path = Path.of("app/src/main/java").resolve(relative);
        return Files.readString(path, StandardCharsets.UTF_8);
    }
}
