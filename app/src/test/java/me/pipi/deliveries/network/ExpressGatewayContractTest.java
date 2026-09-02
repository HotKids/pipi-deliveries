package me.pipi.deliveries.network;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/** Keeps account and public timeline providers behind the public Android gateway. */
public final class ExpressGatewayContractTest {
    @Test
    public void timelinesUseGatewayWhileFreeCarrierRecognitionStaysLocal() throws Exception {
        String api = source("me/pipi/deliveries/network/ExpressApi.java");
        String classifier = source(
                "me/pipi/deliveries/network/Kuaidi100CarrierDetector.java");
        String recognition = source(
                "me/pipi/deliveries/network/CarrierRecognitionCoordinator.java");
        String account = source("me/pipi/deliveries/network/ExpressDiscoveryClient.java");
        String subscription = source(
                "me/pipi/deliveries/network/ExpressSubscriptionClient.java");
        String adapters = api + account + subscription;

        assertFalse(api.contains("/api/express/classify"));
        assertTrue(recognition.contains("/api/express/classify"));
        assertTrue(recognition.contains("put(\"firstStageCompleted\", true)"));
        assertTrue(classifier.contains(
                "https://www.kuaidi100.com/autonumber/autoComNum"));
        assertTrue(classifier.contains("HttpClient.postForm"));
        assertFalse(api.contains("Kuaidi100QueryClient"));
        assertFalse(api.contains("/api/express/timeline/preferred"));
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
        assertTrue(subscription.contains("put(\"mode\", \"manual\")"));

        assertFalse(api.contains("https://"));
        assertFalse(account.contains("https://"));
        assertFalse(subscription.contains("https://"));
        assertFalse(source("me/pipi/deliveries/feature/express/ExpressDetailActivity.java")
                .contains("/api/express/detail"));
        assertFalse(adapters.contains("Cipher.getInstance"));
        assertFalse(adapters.contains("IvParameterSpec"));
        assertFalse(api.contains("Kuaidi100Credentials"));
        assertFalse(account.contains("detectManualCarrier"));
        assertFalse(source("me/pipi/deliveries/feature/express/ExpressListActivity.java")
                .contains("detectManualCarrier"));
        assertTrue(account.contains("AccountCarrierNormalizer.apply(item, result)"));
        assertTrue(subscription.contains("AccountCarrierNormalizer.apply(value, result)"));
        assertFalse(account.contains("Kuaidi100CarrierDetector"));
        assertFalse(subscription.contains("Kuaidi100CarrierDetector"));
        assertFalse(account.contains("CarrierRecognitionCoordinator"));
        assertFalse(subscription.contains("CarrierRecognitionCoordinator"));
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
        String account = source("me/pipi/deliveries/network/ExpressDiscoveryClient.java");
        String sync = source("me/pipi/deliveries/background/ExpressSyncEngine.java");
        assertTrue(login.contains("ExpressAccountSource.isV5(this)"));
        assertTrue(login.contains("new ExpressDiscoveryClient().bind(this, number, verification)"));
        assertTrue(login.contains("new ExpressSubscriptionClient().bind(this, number, verification)"));
        assertTrue(login.contains("ExpressAccountSource.bindingSource(this)"));
        assertTrue(login.contains("ExpressScheduler.requestNow(this)"));
        assertTrue(login.contains("ExpressPhoneBindingPolicy.hasCapacity("));
        assertTrue(login.contains("ExpressPhoneBindingPolicy.limitMessage()"));
        assertFalse(login.contains("最多可绑定 4 个手机号"));
        int firstLimitCheck = account.indexOf(
                "ExpressPhoneBindingPolicy.requireWithinLimit(result.size())");
        int secondLimitCheck = account.indexOf(
                "ExpressPhoneBindingPolicy.requireWithinLimit(result.size())",
                firstLimitCheck + 1);
        assertTrue(firstLimitCheck >= 0);
        assertTrue(secondLimitCheck > firstLimitCheck);
        assertFalse(account.contains("最多可绑定 4 个手机号"));
        assertTrue(sync.contains("discovery.sync(context, boundPhones)"));
        assertTrue(sync.contains("subscription.query(context)"));
    }

    @Test
    public void accountSourcePersistsDiscoveryBeforeDetailEnrichment() throws Exception {
        String account = source("me/pipi/deliveries/network/ExpressDiscoveryClient.java");
        String sync = source("me/pipi/deliveries/background/ExpressSyncEngine.java");
        int summaryWrite = account.indexOf("repository.saveInterface5OrderSummary(");
        int detailPhase = account.indexOf("for (JSONObject item : discovered)");
        assertTrue(summaryWrite >= 0 && detailPhase > summaryWrite);
        assertTrue(account.contains("refreshKnown(Context context, ExpressItem item)"));
        assertTrue(sync.contains("discovery.refreshKnown(context, item)"));
    }

    @Test
    public void detailScreenNeverCallsTheGatewayToResolveAProviderRoute() throws Exception {
        String detail = source("me/pipi/deliveries/feature/express/ExpressDetailActivity.java");
        String homeCapture = source(
                "me/pipi/deliveries/feature/express/ExpressHomeOrderProjectionCapture.java");
        assertFalse(detail.contains("ExpressDetailGateway"));
        assertTrue(detail.contains("item.routeCredentialAvailable"));
        assertTrue(detail.contains("CainiaoRoute.isLegacyCredentialedUrl"));
        assertTrue(detail.contains("putExtra(EXTRA_ROUTE_INTERFACE"));
        assertTrue(detail.contains("putExtra(EXTRA_ROUTE_CREDENTIAL"));
        assertTrue(detail.contains("intent.getStringExtra(EXTRA_ROUTE_INTERFACE)"));
        assertTrue(detail.contains("intent.getStringExtra(EXTRA_ROUTE_CREDENTIAL)"));
        assertFalse(detail.contains("addJavascriptInterface"));
        assertFalse(detail.contains("@JavascriptInterface"));
        assertTrue(homeCapture.contains("DOCUMENT_START_SCRIPT"));
        assertFalse(homeCapture.contains("addJavascriptInterface"));
        assertFalse(homeCapture.contains("@JavascriptInterface"));
    }

    @Test
    public void androidDistributionUsesHardwareBackedRequestSignatures() throws Exception {
        String gateway = source("me/pipi/deliveries/network/ExpressGatewayClient.java");
        String signer = source("me/pipi/deliveries/network/GatewaySessionSigner.java");
        String gradle = repositoryFile("app/build.gradle.kts");

        assertTrue(gateway.contains("GatewaySessionSigner"));
        assertTrue(signer.contains("/api/auth/challenge"));
        assertTrue(signer.contains("/api/auth/session"));
        assertTrue(signer.contains("AndroidKeyStore"));
        assertTrue(signer.contains("setAttestationChallenge"));
        assertTrue(signer.contains("X-Pipi-Session"));
        assertTrue(signer.contains("X-Pipi-Signature"));
        assertTrue(signer.contains("SHA256withRSA"));
        assertFalse(gateway.contains("Collections.emptyMap()"));
    }

    @Test
    public void releaseBuildNeverFallsBackToDebugSigning() throws Exception {
        String gradle = repositoryFile("app/build.gradle.kts");
        assertTrue(gradle.contains("Release signing configuration is required"));
        assertTrue(gradle.contains("signingConfig = releaseSigning"));
        assertFalse(gradle.contains("releaseSigning ?: signingConfigs.getByName(\"debug\")"));
    }

    @Test
    public void localBuildDefaultsToOfficiallySignedBetaTrack() throws Exception {
        String build = repositoryFile("build.sh");
        assertTrue(build.contains("MODE=\"${1:-beta}\""));
        assertTrue(build.contains("https://beta.pipiassistant.app"));
        assertTrue(build.contains("Pipi-Deliveries-beta.apk"));
        int betaCase = build.indexOf("beta)");
        int debugCase = build.indexOf("debug)");
        assertTrue(betaCase >= 0 && debugCase > betaCase);
        String betaBuild = build.substring(betaCase, debugCase);
        assertTrue(betaBuild.contains("load_release_signing"));
        assertTrue(betaBuild.contains(":app:assembleStandardRelease"));
        assertFalse(betaBuild.contains("assembleStandardDebug"));
    }

    @Test
    public void repositoryUsesOnlyNeutralProviderNames() throws Exception {
        List<String> forbidden = List.of(
                new String(new char[]{'x', 'i', 'a', 'o', 'm', 'i'}),
                new String(new char[]{(char) 39749, (char) 26063}),
                new String(new char[]{(char) 23567, (char) 31859}));
        Path root = Files.isDirectory(Path.of("app/src/main"))
                ? Path.of("app/src/main") : Path.of("src/main");
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

    private static String repositoryFile(String relative) throws Exception {
        Path path = Path.of(relative);
        if (!Files.isRegularFile(path)) path = Path.of("..").resolve(relative);
        return Files.readString(path, StandardCharsets.UTF_8);
    }
}
