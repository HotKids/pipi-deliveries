package me.pipi.deliveries.notification;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Notification;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

/** Owner 2026-11-27 (修改 29, A2 5-hue line): notification semantic follows the 5 status hue families. */
public final class ExpressLiveSemanticTest {
    @Test
    public void liveAndStatusSemanticFollowsFiveHueFamilies() throws Exception {
        assertEquals(Notification.SEMANTIC_STYLE_CAUTION, ExpressLiveNotifications.TITLE_SEMANTIC);
        assertEquals(Notification.SEMANTIC_STYLE_INFO, ExpressLiveNotifications.titleSemantic(StatusSemantic.ORDERED));
        assertEquals(Notification.SEMANTIC_STYLE_INFO, ExpressLiveNotifications.titleSemantic(StatusSemantic.SHIPPED));
        assertEquals(Notification.SEMANTIC_STYLE_INFO, ExpressLiveNotifications.titleSemantic(StatusSemantic.PICKED));
        assertEquals(Notification.SEMANTIC_STYLE_SAFE, ExpressLiveNotifications.titleSemantic(StatusSemantic.TRANSIT));
        assertEquals(Notification.SEMANTIC_STYLE_CAUTION, ExpressLiveNotifications.titleSemantic(StatusSemantic.DELIVERY));
        assertEquals(Notification.SEMANTIC_STYLE_CAUTION, ExpressLiveNotifications.titleSemantic(StatusSemantic.WAITING_PICKUP));
        assertEquals(Notification.SEMANTIC_STYLE_UNSPECIFIED, ExpressLiveNotifications.titleSemantic(StatusSemantic.COMPLETED));
        assertEquals(Notification.SEMANTIC_STYLE_UNSPECIFIED, ExpressLiveNotifications.titleSemantic(StatusSemantic.UNKNOWN));
        assertEquals(Notification.SEMANTIC_STYLE_DANGER, ExpressLiveNotifications.titleSemantic(StatusSemantic.DANGER));
        assertEquals(Notification.SEMANTIC_STYLE_DANGER, ExpressLiveNotifications.titleSemantic(StatusSemantic.CANCELLED));
        String relative = "app/src/main/java/me/pipi/deliveries/notification/ExpressLiveNotifications.java";
        Path path = Path.of(relative);
        if (!Files.isRegularFile(path)) path = Path.of(relative.substring("app/".length()));
        String source = Files.readString(path, StandardCharsets.UTF_8);
        assertTrue(source.contains("titleSemantic(spec.primary.semantic)"));
    }
}
