package me.pipi.deliveries.background;

import android.content.Context;
import android.content.SharedPreferences;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.AbstractMap;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Function;
import java.util.function.LongSupplier;

import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.network.CarrierRecognitionTimeoutException;

import org.json.JSONObject;

/**
 * 用户 2026-09-27 第二轮清单：截断排后。A waybill whose recognition a sync round's budget truncated goes after
 * the others in the next round, so one that hangs every round cannot keep the rest from their turn: first the
 * waybills not truncated, then those the spent budget left unasked, and last the one whose request was cut off
 * in flight, each group in list order. Putting the cut one after the unasked ones was first an implementation
 * choice; the user confirmed it at the 2026-09-27 pre-commit check (截断排后细则，答「这样做」). With both at the
 * same place the waybill that hung would come first again. A mark is not a
 * failure and not a verdict: it only orders. It stays until the waybill is recognised or recognition gives up
 * on it (a terminal verdict); the next truncation records that round's reason instead. A request that timed out
 * on its own while the round waited (connect or read timeout, the shared request's budget) is marked cut off
 * too, with no failure counted: 用户 2026-09-27 提交前核对答复四（同步轮里单个请求自身超时「四端对齐 iOS」）.
 *
 * <p>Kept across a process restart in its own preferences file next to the recognition records
 * ({@code carrier_recognition_v1}), under the same key: the SHA-256 of the canonical waybill, never the
 * waybill itself. It is a separate file because the recognition cache reads every key of its own file as a
 * record. At most {@link #MAX_ENTRIES} marks are kept, the oldest giving way first.</p>
 */
final class CarrierRecognitionDeferrals {
    static final String PREFS = "carrier_recognition_deferred_v1";
    static final int MAX_ENTRIES = 256;
    /** Not truncated. */
    static final int NONE = 0;
    /** Not asked: the round's budget was already spent. */
    static final int SKIPPED = 1;
    /** Asked, and the request in flight was cancelled at the budget's end. */
    static final int CUT = 2;

    private final SharedPreferences preferences;
    private final LongSupplier clock;

    CarrierRecognitionDeferrals(SharedPreferences preferences, LongSupplier clock) {
        this.preferences = preferences;
        this.clock = clock;
    }

    static CarrierRecognitionDeferrals get(Context context) {
        Context application = context.getApplicationContext();
        if (application == null) application = context;
        return new CarrierRecognitionDeferrals(
                application.getSharedPreferences(PREFS, 0), System::currentTimeMillis);
    }

    /** {@link #NONE}, {@link #SKIPPED} or {@link #CUT}. */
    int mark(String waybill) {
        String key = key(waybill);
        if (key.isEmpty()) return NONE;
        return read(preferences.getString(key, null)).optInt("mark", NONE);
    }

    /** Records this round's truncation of {@code waybill}, replacing an earlier reason. */
    void defer(String waybill, boolean cut) {
        String key = key(waybill);
        if (key.isEmpty()) return;
        try {
            String value = new JSONObject()
                    .put("mark", cut ? CUT : SKIPPED)
                    .put("atMs", clock.getAsLong())
                    .toString();
            synchronized (preferences) {
                SharedPreferences.Editor editor = preferences.edit().putString(key, value);
                ArrayList<Map.Entry<String, Long>> others = new ArrayList<>();
                for (Map.Entry<String, ?> stored : preferences.getAll().entrySet()) {
                    if (key.equals(stored.getKey())) continue;
                    others.add(new AbstractMap.SimpleImmutableEntry<>(stored.getKey(),
                            read(String.valueOf(stored.getValue())).optLong("atMs", 0L)));
                }
                others.sort(Map.Entry.comparingByValue());
                for (int index = 0; index <= others.size() - MAX_ENTRIES; index++) {
                    editor.remove(others.get(index).getKey());
                }
                editor.apply();
            }
        } catch (Exception ignored) {
            // A lost mark only means the waybill keeps its place in the list next round.
        }
    }

    void clear(String waybill) {
        String key = key(waybill);
        if (key.isEmpty()) return;
        synchronized (preferences) {
            if (preferences.contains(key)) preferences.edit().remove(key).apply();
        }
    }

    /**
     * {@code rows} in the next round's recognition order: not truncated first, then left unasked, then cut
     * off, each group in the order given. {@code waybillOf} names the waybill a row would recognise.
     */
    <T> List<T> recognitionLast(List<T> rows, Function<T, String> waybillOf) {
        ArrayList<T> untruncated = new ArrayList<>();
        ArrayList<T> skipped = new ArrayList<>();
        ArrayList<T> cut = new ArrayList<>();
        for (T row : rows) {
            int mark = mark(waybillOf.apply(row));
            (mark == CUT ? cut : mark == SKIPPED ? skipped : untruncated).add(row);
        }
        untruncated.addAll(skipped);
        untruncated.addAll(cut);
        return untruncated;
    }

    /**
     * {@code recognizer} (already bounded by the round's budget) that marks a waybill the budget truncates
     * and clears the mark once an answer names the carrier, gives Kuaidi100's off-table name or reports the
     * terminal verdict. No answer yet (cooling, pending) and a failure leave the mark as it is.
     */
    AccountCarrierRecognition.Recognizer tracking(AccountCarrierRecognition.Recognizer recognizer) {
        return waybill -> {
            CarrierNormalization answer;
            try {
                answer = recognizer.recognize(waybill);
            } catch (AccountCarrierRecognition.BudgetSpentException truncated) {
                defer(waybill, truncated.cut);
                throw truncated;
            } catch (CarrierRecognitionTimeoutException timedOut) {
                // 用户 2026-09-27 提交前核对答复四：同步轮里请求自身超时，不计失败，只记截断标记（被取消的那一类）。
                defer(waybill, true);
                throw timedOut;
            }
            if (answer != null && answer.localOutcome()) clear(waybill);
            return answer;
        };
    }

    private static JSONObject read(String value) {
        if (value == null || value.isEmpty()) return new JSONObject();
        try {
            return new JSONObject(value);
        } catch (Exception malformed) {
            return new JSONObject();
        }
    }

    /** The recognition records' key: SHA-256 of the canonical waybill, "" when it is too short. */
    private static String key(String waybill) {
        String canonical = waybill == null ? ""
                : waybill.trim().toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", "");
        if (canonical.length() < 6) return "";
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(
                    canonical.getBytes(StandardCharsets.UTF_8));
            StringBuilder value = new StringBuilder(digest.length * 2);
            for (byte item : digest) value.append(String.format(Locale.ROOT, "%02x", item & 0xff));
            return value.toString();
        } catch (Exception impossible) {
            return "";
        }
    }
}
