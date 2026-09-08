package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
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
        assertTrue(group.contains("android:layout_width=\"81.6dp\""));
        assertTrue(group.contains("android:layout_height=\"81.6dp\""));
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
        assertFalse(header.contains("@+id/widget_compact_empty_search"));
        assertTrue(body.contains("android:layout_height=\"0dp\""));
        assertTrue(body.contains("android:layout_weight=\"1\""));
        assertWidgetGroup(group);
    }

    @Test
    public void compactEmptySearchReusesTheWideSearchContractAtTheWideEdgeInset()
            throws Exception {
        String compact = projectFile("app/src/main/res/layout/express_widget_2x2.xml");
        String wide = projectFile("app/src/main/res/layout/express_widget_4x2.xml");
        String styles = projectFile("app/src/main/res/values/styles.xml");
        String dimens = projectFile("app/src/main/res/values/dimens.xml");
        String provider = projectFile(
                "app/src/main/java/me/pipi/deliveries/widget/ExpressWidgetProvider.java");
        String compactSearch = imageView(compact, "@+id/widget_compact_empty_search\"");
        String compactSearchFrame = block(
                compact, "@+id/widget_compact_empty_search_frame", "</FrameLayout>");
        String wideSearch = imageView(wide, "@+id/widget_express_search");
        String searchStyle = block(
                styles, "<style name=\"DeliveriesExpressWidgetSearch\"", "</style>");

        assertTrue(compactSearch.contains(
                "style=\"@style/DeliveriesExpressWidgetSearch\""));
        assertTrue(wideSearch.contains(
                "style=\"@style/DeliveriesExpressWidgetSearch\""));
        assertTrue(searchStyle.contains(
                "<item name=\"android:layout_width\">22dp</item>"));
        assertTrue(searchStyle.contains(
                "<item name=\"android:layout_height\">22dp</item>"));
        assertTrue(searchStyle.contains(
                "<item name=\"android:src\">@drawable/ic_search</item>"));
        assertTrue(searchStyle.contains(
                "<item name=\"android:tint\">?attr/colorOnSurfaceVariant</item>"));
        assertFalse(searchStyle.contains("android:padding"));

        assertTrue(dimens.contains(
                "<dimen name=\"express_widget_search_edge_inset\">14dp</dimen>"));
        assertTrue(wide.contains(
                "android:padding=\"@dimen/express_widget_search_edge_inset\""));
        assertTrue(compactSearchFrame.contains("android:layout_width=\"match_parent\""));
        assertTrue(compactSearchFrame.contains("android:layout_height=\"match_parent\""));
        assertTrue(compactSearchFrame.contains(
                "android:padding=\"@dimen/express_widget_search_edge_inset\""));
        assertTrue(compactSearch.contains("android:layout_gravity=\"top|end\""));
        assertFalse(compactSearch.contains("android:layout_marginTop"));
        assertFalse(compactSearch.contains("android:layout_marginEnd"));

        assertEquals(2, occurrences(
                provider, "ExpressWidgetPalette.emptyAccent(context)"));
        assertTrue(provider.contains(
                "views.setInt(R.id.widget_compact_empty_search, \"setColorFilter\", accent);"));
        assertTrue(provider.contains(
                "views.setInt(R.id.widget_express_search, \"setColorFilter\","));
        assertTrue(provider.contains(
                "views.setViewVisibility(R.id.widget_compact_empty_search_frame,"));

        assertEquals(2, occurrences(compact, "android:padding=\"14dp\""));
        assertTrue(provider.contains(
                "views.setViewPadding(R.id.widget_compact_content,"));
        assertTrue(provider.contains(
                "views.setViewPadding(R.id.widget_compact_empty,"));
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
        assertTrue(emptySurface.contains("android:layout_width=\"68dp\""));
        assertTrue(emptySurface.contains("android:layout_height=\"68dp\""));
        assertTrue(emptySurface.contains("android:layout_marginTop=\"4dp\""));
        assertTrue(emptySurface.contains("android:textSize=\"16sp\""));
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

    private static String imageView(String source, String id) {
        int idOffset = source.indexOf(id);
        int start = source.lastIndexOf("<ImageView", idOffset);
        int end = source.indexOf("/>", idOffset);
        assertTrue(idOffset >= 0);
        assertTrue(start >= 0);
        assertTrue(end > idOffset);
        return source.substring(start, end + 2);
    }

    private static int occurrences(String source, String needle) {
        int count = 0;
        int offset = 0;
        while ((offset = source.indexOf(needle, offset)) >= 0) {
            count++;
            offset += needle.length();
        }
        return count;
    }

    private static String projectFile(String relative) throws Exception {
        Path path = Path.of(relative);
        if (!Files.isRegularFile(path)) path = Path.of(relative.substring("app/".length()));
        return Files.readString(path, StandardCharsets.UTF_8);
    }
}
