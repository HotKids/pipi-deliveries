package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Guards the compact search field without shrinking its touch target. */
public final class ExpressSearchFieldLayoutContractTest {
    @Test
    public void searchFieldUsesTheCompactFortyEightDpGeometry() throws Exception {
        String layout = projectFile("app/src/main/res/layout/activity_express_list.xml");
        String styles = projectFile("app/src/main/res/values/styles.xml");
        String dimensions = projectFile("app/src/main/res/values/dimens.xml");

        assertTrue(dimensions.contains(
                "<dimen name=\"express_search_field_height\">48dp</dimen>"));
        assertTrue(dimensions.contains(
                "<dimen name=\"express_search_field_corner_radius\">24dp</dimen>"));
        assertTrue(layout.contains(
                "android:layout_height=\"@dimen/express_search_field_height\""));
        assertTrue(layout.contains(
                "android:minHeight=\"@dimen/express_search_field_height\""));
        assertTrue(styles.contains(
                "<item name=\"boxCornerRadiusTopStart\">"
                        + "@dimen/express_search_field_corner_radius</item>"));
        assertTrue(styles.contains(
                "<item name=\"boxCornerRadiusBottomEnd\">"
                        + "@dimen/express_search_field_corner_radius</item>"));
    }

    private static String projectFile(String relative) throws Exception {
        Path current = Path.of("").toAbsolutePath();
        for (int depth = 0; current != null && depth < 8; depth++, current = current.getParent()) {
            Path candidate = current.resolve(relative);
            if (Files.exists(candidate)) {
                return Files.readString(candidate, StandardCharsets.UTF_8);
            }
        }
        throw new IllegalStateException("Project file not found: " + relative);
    }
}
