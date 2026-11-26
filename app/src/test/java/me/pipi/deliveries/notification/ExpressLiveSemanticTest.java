package me.pipi.deliveries.notification;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Notification;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.Test;

/** Owner 2026-11-20 (修改 11), table 1.3-B: the delivery/pickup live title uses the green semantic. */
public final class ExpressLiveSemanticTest {
    @Test
    public void deliveryAndPickupLiveTitleUsesTheSafeSemantic() throws Exception {
        assertEquals(Notification.SEMANTIC_STYLE_SAFE, ExpressLiveNotifications.TITLE_SEMANTIC);
        String relative = "app/src/main/java/me/pipi/deliveries/notification/ExpressLiveNotifications.java";
        Path path = Path.of(relative);
        if (!Files.isRegularFile(path)) path = Path.of(relative.substring("app/".length()));
        String source = Files.readString(path, StandardCharsets.UTF_8);
        assertTrue(source.contains("SemanticText.annotate(spec.title, TITLE_SEMANTIC, 0,"));
        assertFalse(source.contains("SEMANTIC_STYLE_CAUTION"));
    }
}
