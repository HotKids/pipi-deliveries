package me.pipi.deliveries.background;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.WaybillReusePolicy;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.network.ExpressApi;

/**
 * 代码 5（用户 2026-10-03「照 Pipi / iOS 的做法改」；其余裁决 28「先识别承运商再落库、上列表、推送」）：within one sync round, the
 * account records that would add a new row are held back while the rest of the round's list is stored (every order
 * summary first, as the list sync requires), then recognised, then stored, so a new row is listed with its carrier from
 * the start. This is what Pipi's {@code recognizeBeforePublication} does for a new row (new rows last) and what iOS's
 * {@code fetchAccountParcels} does for every parcel before it merges the list.
 *
 * <ul>
 * <li>Which records: those {@link ExpressRepository#createsAutomaticRow} says would add a row (no row of the waybill
 * yet, qualified, inside the retention window) and whose carrier misses the built-in table
 * ({@link AccountCarrierRecognition#needsRecognition}). Existing rows keep today's order: stored first, recognised
 * afterwards in the round's enrichment loop.</li>
 * <li>How: the same chain and the same round as every other recognition of the round — built-in table, free
 * Kuaidi100, the existing paid classify; the round's one 30-second budget (其余裁决 37) and the cut-off order of
 * {@link CarrierRecognitionDeferrals} (截断排后).</li>
 * <li>Not recognised this round (no answer, a failure, the budget spent or cut off; 其余裁决 42): the row is stored as it
 * came and listed as before, its notification held while its carrier is pending (a first sighting is not notified in
 * any case), and the next round's enrichment loop recognises it again, as Pipi lists such a new row and iOS stores
 * the parcel with its direct carrier presentation.</li>
 * </ul>
 *
 * <p>Each waybill is asked at most once this way per round; the enrichment loop later in the round does not ask it
 * again ({@link #asked}).</p>
 */
final class NewRowCarrierRecognition {
    private final ExpressRepository repository;
    private final ExpressApi api;
    private final AccountCarrierRecognition.Budget budget;
    private final CarrierRecognitionDeferrals deferrals;
    private final Set<String> asked = new HashSet<>();
    /** The anchor each new record's recognition sent (优化 5 续), kept by its row once the row is stored. */
    private final Map<String, Long> anchors = new HashMap<>();

    NewRowCarrierRecognition(ExpressRepository repository, ExpressApi api,
            AccountCarrierRecognition.Budget budget, CarrierRecognitionDeferrals deferrals) {
        this.repository = repository;
        this.api = api;
        this.budget = budget;
        this.deferrals = deferrals;
    }

    /**
     * Whether {@code record} of {@code bindingSource} would add a new row whose carrier misses the built-in table, so it
     * waits until its carrier is recognised. Reads only.
     */
    boolean recognizedFirst(ExpressQueryResult record, String bindingSource) {
        if (record == null) return false;
        String key = normalize(record.waybill);
        return !key.isEmpty() && !asked.contains(key)
                && AccountCarrierRecognition.needsRecognition(
                        AccountCarrierRecognition.publicationCandidate(record, owner(bindingSource)))
                && repository.createsAutomaticRow(record, bindingSource);
    }

    /**
     * The carrier each of the held {@code records} of {@code bindingSource} is to be stored with, by normalized waybill;
     * records not recognised this round are absent and are stored as they came.
     */
    Map<String, CarrierNormalization> recognize(List<ExpressQueryResult> records, String bindingSource)
            throws InterruptedException {
        String owner = owner(bindingSource);
        LinkedHashMap<String, ExpressQueryResult> fresh = new LinkedHashMap<>();
        for (ExpressQueryResult record : records) {
            if (record == null) continue;
            String key = normalize(record.waybill);
            if (key.isEmpty() || fresh.containsKey(key) || asked.contains(key)) continue;
            fresh.put(key, record);
        }
        HashMap<String, CarrierNormalization> recognized = new HashMap<>();
        long now = System.currentTimeMillis();
        for (ExpressQueryResult record : deferrals.recognitionLast(
                new ArrayList<>(fresh.values()), value -> value.waybill)) {
            String key = normalize(record.waybill);
            asked.add(key);
            // 优化 5: the paid level carries the new parcel's own reuse anchor; 优化 5 续 keeps it as the row's.
            long anchor = WaybillReusePolicy.parcelAnchorAt(record, now);
            anchors.put(key, anchor);
            ExpressApi parcel = api.forParcel(anchor);
            boolean excludeJd = AccountCarrierRecognition.excludesJd(
                    AccountCarrierRecognition.publicationCandidate(record, owner), record.waybill);
            CarrierNormalization outcome = AccountCarrierRecognition.beforePublication(record, owner,
                    deferrals.tracking(AccountCarrierRecognition.bounded(budget,
                            waybill -> parcel.recognizeCarrierInSyncRound(waybill, excludeJd))));
            if (outcome != null) recognized.put(key, outcome);
        }
        return recognized;
    }

    private static String owner(String bindingSource) {
        return "interface6".equals(bindingSource) ? "INTERFACE6" : "INTERFACE5";
    }

    /**
     * 优化 5 续（用户 2026-10-03「第一次识别时记下锚点，之后不变」）：once the held records are stored, each new row keeps the
     * anchor its first recognition sent, so later recognitions of the row send the same one.
     */
    void rememberAnchors(String bindingSource) {
        try {
            for (Map.Entry<String, Long> anchor : anchors.entrySet()) {
                me.pipi.deliveries.model.ExpressItem row = repository.findByWaybill(anchor.getKey(), bindingSource);
                if (row != null) repository.rememberParcelAnchor(row.rowId, anchor.getValue());
            }
        } catch (RuntimeException failure) {
            // Best effort: the row's next recognition records its anchor from the row itself.
            android.util.Log.w("NewRowCarrier", "Anchor not recorded: " + failure.getClass().getSimpleName());
        } finally {
            anchors.clear();
        }
    }

    /** Whether this round already asked for {@code waybill} before storing its new row. */
    boolean asked(String waybill) {
        return asked.contains(normalize(waybill));
    }

    /** {@code record} with the carrier recognised for it this round, or as it came. */
    static ExpressQueryResult withRecognized(ExpressQueryResult record, Map<String, CarrierNormalization> recognized) {
        if (record == null || recognized == null || recognized.isEmpty()) return record;
        CarrierNormalization carrier = recognized.get(normalize(record.waybill));
        return carrier == null ? record : record.withCarrierNormalization(carrier);
    }

    static String normalize(String value) {
        return value == null ? "" : value.trim().toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", "");
    }
}
