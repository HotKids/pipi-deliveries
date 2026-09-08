package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Guards the user-facing copy owned by the phone-management page. */
public final class ExpressManagerLayoutContractTest {
    @Test
    public void explanationStatesTheFivePhoneLimitAndAutomaticSync() throws Exception {
        String layout = projectFile("app/src/main/res/layout/activity_express_manager.xml");
        String strings = projectFile("app/src/main/res/values/strings.xml");

        assertTrue(layout.contains(
                "android:text=\"@string/card_sub_bind_tips_title_2\""));
        assertTrue(strings.contains(
                "<string name=\"card_sub_bind_tips_title_2\">"
                        + "最多可绑定 5 个手机号；绑定后，将自动同步关联的快递信息。"
                        + "</string>"));
    }

    private static String projectFile(String relative) throws Exception {
        Path path = Path.of(relative);
        if (!Files.isRegularFile(path)) path = Path.of(relative.substring("app/".length()));
        return Files.readString(path, StandardCharsets.UTF_8);
    }
}
