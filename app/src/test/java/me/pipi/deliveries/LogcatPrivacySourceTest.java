package me.pipi.deliveries;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import org.junit.Test;

/**
 * G-LOW-16 (2026-11-20 review): Lite's production logcat carries no stack trace. A Log call names a caught failure by
 * its class only, as Pipi's LogcatRedactionSourceTest requires of Pipi (G-HIGH-19).
 */
public final class LogcatPrivacySourceTest {
    private static final Pattern LOG_CALL = Pattern.compile("\\b(?:android\\.util\\.)?Log\\.(?:w|e|i|d|v|wtf)\\(");

    @Test public void logcatCallsCarryNoThrowable() throws IOException {
        List<String> found = new ArrayList<>();
        for (Path file : sources()) {
            String text = Files.readString(file, StandardCharsets.UTF_8);
            Matcher call = LOG_CALL.matcher(text);
            while (call.find()) {
                List<String> arguments = arguments(text, call.end());
                // android.util.Log takes a Throwable only as the argument after the message.
                if (arguments.size() == 3) found.add(file.getFileName() + ": " + arguments);
            }
            if (text.contains("printStackTrace(") || text.contains("getStackTraceString(")) {
                found.add(file.getFileName() + ": stack trace text");
            }
        }
        assertEquals("Log calls with a Throwable argument: " + found, List.of(), found);
    }

    /** The top-level arguments of the call whose list starts at {@code from}, strings skipped. */
    private static List<String> arguments(String text, int from) {
        List<String> parts = new ArrayList<>();
        int depth = 1, start = from, index = from;
        while (index < text.length() && depth > 0) {
            char c = text.charAt(index);
            if (c == '"' || c == '\'') {
                char quote = c;
                index++;
                while (index < text.length() && text.charAt(index) != quote) {
                    index += text.charAt(index) == '\\' ? 2 : 1;
                }
            } else if (c == '(' || c == '[' || c == '{') {
                depth++;
            } else if (c == ')' || c == ']' || c == '}') {
                depth--;
                if (depth == 0) break;
            } else if (c == ',' && depth == 1) {
                parts.add(text.substring(start, index).trim());
                start = index + 1;
            }
            index++;
        }
        parts.add(text.substring(start, Math.min(index, text.length())).trim());
        return parts;
    }

    private static List<Path> sources() throws IOException {
        Path root = Paths.get("src/main/java");
        if (!Files.isDirectory(root)) root = Paths.get("app/src/main/java");
        assertTrue(Files.isDirectory(root));
        try (Stream<Path> walk = Files.walk(root)) {
            return walk.filter(path -> path.toString().endsWith(".java") || path.toString().endsWith(".kt"))
                    .sorted().collect(Collectors.toList());
        }
    }
}
