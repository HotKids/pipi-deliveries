package me.pipi.deliveries.background;

import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public final class BootReceiverContractTest {
    @Test
    public void packageReplacementRefreshesExistingWidgets() throws Exception {
        Path sourcePath = Path.of(
                "app/src/main/java/me/pipi/deliveries/background/BootReceiver.java");
        if (!Files.isRegularFile(sourcePath)) {
            sourcePath = Path.of(
                    "src/main/java/me/pipi/deliveries/background/BootReceiver.java");
        }
        String source = Files.readString(sourcePath, StandardCharsets.UTF_8);

        assertTrue(source.contains("Intent.ACTION_MY_PACKAGE_REPLACED"));
        assertTrue(source.contains("ExpressWidgetProvider.refreshAll(context);"));
    }
}
