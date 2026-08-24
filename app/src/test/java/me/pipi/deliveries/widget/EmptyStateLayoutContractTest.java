package me.pipi.deliveries.widget;

import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.Test;

public final class EmptyStateLayoutContractTest {
    @Test
    public void homeGroupIsEnlargedAndCenteredInsideThePostSearchRegion() throws Exception {
        String layout = projectFile("app/src/main/res/layout/activity_express_list.xml");
        String region = block(layout, "@+id/home_content_region", "</FrameLayout>");
        String group = block(layout, "@+id/home_empty_group", "</LinearLayout>");

        assertTrue(layout.indexOf("@+id/home_query_container")
                < layout.indexOf("@+id/home_content_region"));
        assertTrue(region.contains("android:layout_height=\"0dp\""));
        assertTrue(region.contains("android:layout_weight=\"1\""));
        assertTrue(group.contains("android:layout_width=\"wrap_content\""));
        assertTrue(group.contains("android:layout_height=\"wrap_content\""));
        assertTrue(group.contains("android:layout_gravity=\"center\""));
        assertTrue(group.contains("android:layout_width=\"102dp\""));
        assertTrue(group.contains("android:layout_height=\"102dp\""));
        assertTrue(group.contains("android:layout_marginTop=\"6dp\""));
        assertTrue(group.contains("android:textSize=\"24sp\""));
    }

    @Test
    public void compactGroupCentersBelowItsReservedSearchHeader() throws Exception {
        String layout = projectFile("app/src/main/res/layout/express_widget_2x2.xml");
        String header = block(layout, "@+id/widget_compact_empty_header", "</FrameLayout>");
        String body = block(layout, "@+id/widget_compact_empty_body", "</FrameLayout>");
        String group = block(layout, "@+id/widget_compact_empty_group", "</LinearLayout>");

        assertTrue(layout.indexOf("@+id/widget_compact_empty_header")
                < layout.indexOf("@+id/widget_compact_empty_body"));
        assertTrue(header.contains("android:layout_height=\"24dp\""));
        assertTrue(header.contains("@+id/widget_compact_empty_search"));
        assertTrue(body.contains("android:layout_height=\"0dp\""));
        assertTrue(body.contains("android:layout_weight=\"1\""));
        assertWidgetGroup(group);
    }

    @Test
    public void widePipiEmptyStateCentersInsideThePostHeaderRegion() throws Exception {
        String layout = projectFile("app/src/main/res/layout/express_widget_4x2.xml");
        String emptySurface = block(
                layout, "@+id/widget_express_empty\"", "</LinearLayout>");

        assertTrue(layout.indexOf("@+id/widget_express_header")
                < layout.indexOf("@+id/widget_express_empty\""));
        assertTrue(emptySurface.contains("android:layout_height=\"0dp\""));
        assertTrue(emptySurface.contains("android:layout_weight=\"1\""));
        assertTrue(emptySurface.contains("android:gravity=\"center\""));
        assertTrue(emptySurface.contains("android:layout_width=\"32dp\""));
        assertTrue(emptySurface.contains("android:layout_height=\"32dp\""));
        assertTrue(emptySurface.contains("android:layout_marginTop=\"8dp\""));
        assertTrue(emptySurface.contains("android:textSize=\"14sp\""));
    }

    private static void assertWidgetGroup(String group) {
        assertTrue(group.contains("android:layout_width=\"wrap_content\""));
        assertTrue(group.contains("android:layout_height=\"wrap_content\""));
        assertTrue(group.contains("android:layout_gravity=\"center\""));
        assertTrue(group.contains("android:layout_width=\"68dp\""));
        assertTrue(group.contains("android:layout_height=\"68dp\""));
        assertTrue(group.contains("android:layout_marginTop=\"4dp\""));
        assertTrue(group.contains("android:textSize=\"16sp\""));
    }

    private static String block(String source, String id, String endTag) {
        int start = source.indexOf(id);
        int end = source.indexOf(endTag, start);
        assertTrue(start >= 0);
        assertTrue(end > start);
        return source.substring(start, end + endTag.length());
    }

    private static String projectFile(String relative) throws Exception {
        Path path = Path.of(relative);
        if (!Files.isRegularFile(path)) path = Path.of(relative.substring("app/".length()));
        return Files.readString(path, StandardCharsets.UTF_8);
    }
}
