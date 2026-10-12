package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import org.junit.Test;

/**
 * Audit C13 (user 2026-09-25): {@code ExpressApi.queryMoto} / {@code parseV4} read the raw Moto
 * status codes themselves and nothing in the app calls them (Lite has no v4_query caller since
 * 2026-09-12). They stay only for their own tests; this guard keeps any app code from wiring them
 * back in and bypassing the Worker's status projection.
 */
public final class LegacyPublicTimelineGuardTest {
    @Test
    public void noAppCodeCallsTheLegacyPublicTimelineAdapter() throws Exception {
        Path root = Files.isDirectory(Path.of("app/src/main/java"))
                ? Path.of("app/src/main/java") : Path.of("src/main/java");
        List<String> callers = new ArrayList<>();
        String api = "";
        try (Stream<Path> files = Files.walk(root)) {
            for (Path file : (Iterable<Path>) files.filter(path -> path.toString().endsWith(".java"))::iterator) {
                String source = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
                if (file.endsWith("network/ExpressApi.java")) {
                    api = source;
                    continue;
                }
                if (source.contains("queryMoto(") || source.contains("parseV4(")) {
                    callers.add(root.relativize(file).toString());
                }
            }
        }
        assertEquals("no caller outside ExpressApi", List.of(), callers);
        assertTrue(api.contains("public ExpressQueryResult queryMoto("));
        assertEquals("queryMoto is declared and never called inside ExpressApi", 1,
                count(api, "queryMoto("));
        assertEquals("parseV4 is only reached from queryMoto's executeV4", 2, count(api, "parseV4("));
    }

    private static int count(String source, String needle) {
        int count = 0;
        for (int at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) count++;
        return count;
    }
}
