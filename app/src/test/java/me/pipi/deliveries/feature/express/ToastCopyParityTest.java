package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.junit.Test;

/**
 * Audit R11 (user 2026-09-25): the express toast copy is one table on every client (AGENTS §11).
 * Pipi's Java and Dart copies were compared by check_runtime_guards.sh; nothing compared Lite with
 * iOS. This reads iOS services/express-toast-copy.ts and requires Lite's ExpressToastCopy to hold
 * exactly the same keys and words, except for the standalone pickup/handoff tab keys that exist
 * only on iOS (G-LOW-17).
 */
public final class ToastCopyParityTest {
    private static final Pattern ENTRY = Pattern.compile("^\\s*([A-Za-z0-9]+):\\s*\"([^\"]*)\",?\\s*$",
            Pattern.MULTILINE);
    private static final Set<String> IOS_ONLY_KEYS = Set.of(
            "PICKUP_RECORD_DELETED",
            "PICKUP_CODE_COPIED",
            "HANDOFF_CODE_COPIED",
            "HANDOFF_COMPLETED",
            "HANDOFF_EXPIRED",
            "PICKUP_RECORD_ACTION_FAILED");

    @Test public void liteAndIosHoldTheSameToastTable() throws Exception {
        String ios = new String(Files.readAllBytes(iosTable()), StandardCharsets.UTF_8);
        String body = ios.substring(ios.indexOf("EXPRESS_TOAST_COPY = Object.freeze({"),
                ios.indexOf("});"));
        Map<String, String> allIos = new TreeMap<>();
        Matcher matcher = ENTRY.matcher(body);
        while (matcher.find()) {
            allIos.put(matcher.group(1).replaceAll("([a-z0-9])([A-Z])", "$1_$2")
                    .toUpperCase(java.util.Locale.ROOT), matcher.group(2));
        }
        assertTrue(allIos.keySet().containsAll(IOS_ONLY_KEYS));
        Map<String, String> expected = new TreeMap<>(allIos);
        expected.keySet().removeAll(IOS_ONLY_KEYS);
        assertTrue(expected.size() >= 30);
        Map<String, String> lite = new TreeMap<>();
        for (Field field : ExpressToastCopy.class.getDeclaredFields()) {
            if (field.getType() != String.class || !Modifier.isStatic(field.getModifiers())) continue;
            field.setAccessible(true);
            lite.put(field.getName(), (String) field.get(null));
        }
        assertEquals(expected, lite);
    }

    private static Path iosTable() {
        for (String base : new String[]{"../script/project/services", "script/project/services",
                "deliveries/script/project/services"}) {
            Path candidate = Path.of(base, "express-toast-copy.ts");
            if (Files.isRegularFile(candidate)) return candidate;
        }
        throw new AssertionError("iOS express-toast-copy.ts not found");
    }
}
