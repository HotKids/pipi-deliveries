package me.pipi.deliveries.widget;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Guards the separate Android 12 standard and Android 10 compatibility artifacts. */
public final class ExpressCompatibilityContractTest {
    @Test
    public void flavorsKeepTheStandardFloorAndAddApi29Compatibility() throws Exception {
        String gradle = projectFile("app/build.gradle.kts");
        assertTrue(gradle.contains("create(\"standard\")"));
        assertTrue(gradle.contains("create(\"compat\")"));
        assertTrue(gradle.contains("minSdk = 31"));
        assertTrue(gradle.contains("minSdk = 29"));
    }

    @Test
    public void api31WidgetCollectionIsIsolatedFromTheLegacyProvider() throws Exception {
        String provider = source("ExpressWidgetProvider.java");
        String api31 = source("ExpressWidgetApi31.java");
        String legacy = source("ExpressWidgetLegacyService.java");

        assertFalse(provider.contains("RemoteViews.RemoteCollectionItems"));
        assertFalse(provider.contains("setViewLayoutHeight"));
        assertTrue(api31.contains("RemoteViews.RemoteCollectionItems"));
        assertTrue(api31.contains("setViewLayoutHeight"));
        assertTrue(legacy.contains("RemoteViewsService"));
        assertTrue(provider.contains("Build.VERSION.SDK_INT < 31"));
    }

    private static String source(String name) throws Exception {
        return projectFile("app/src/main/java/me/pipi/deliveries/widget/" + name);
    }

    private static String projectFile(String relative) throws Exception {
        Path path = Path.of(relative);
        if (!Files.isRegularFile(path) && relative.startsWith("app/")) {
            path = Path.of(relative.substring("app/".length()));
        }
        return Files.readString(path, StandardCharsets.UTF_8);
    }
}
