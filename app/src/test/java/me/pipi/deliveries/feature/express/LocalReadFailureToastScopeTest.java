package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;

import org.junit.Test;

/**
 * Audit R8 (user default #13 of 2026-09-25): 「本地快递数据读取失败」 is shown only when the list
 * fails to load — as on iOS; the query box, the detail page and the account manager no longer
 * show it.
 */
public final class LocalReadFailureToastScopeTest {
    @Test public void onlyTheListLoadShowsTheLocalReadFailure() throws Exception {
        Path root = Files.isDirectory(Path.of("src/main/java")) ? Path.of("src/main/java")
                : Path.of("app/src/main/java");
        int uses = 0;
        String listUse = "";
        try (Stream<Path> files = Files.walk(root)) {
            for (Path file : (Iterable<Path>) files.filter(path -> path.toString().endsWith(".java"))::iterator) {
                if (file.endsWith("ExpressToastCopy.java")) continue;
                String source = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
                for (int at = source.indexOf("STATE_LOAD_FAILED"); at >= 0;
                        at = source.indexOf("STATE_LOAD_FAILED", at + 1)) {
                    uses++;
                    listUse = file.getFileName().toString();
                }
            }
        }
        assertEquals(1, uses);
        assertEquals("ExpressListActivity.java", listUse);
    }
}
