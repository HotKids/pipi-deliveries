package me.pipi.deliveries.data;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

import me.pipi.deliveries.model.StatusSemantic;

/**
 * The one status label table (audit L5, user defaults of 2026-09-25): list, detail, widgets and
 * notification titles read their status word from here ({@code ExpressItem#displayStatus}), so
 * DANGER reads 异常件 and UNKNOWN reads 暂无状态 on every surface. The Worker serves the table with
 * the carrier authority snapshot as {@code statusLabels} (kept in {@link CarrierRegistry} with that
 * snapshot); {@link #bundled()} is the same table for first-offline startup and for a Worker that
 * does not serve it yet. Same port as Pipi's ExpressStatusLabels. Shared fixture:
 * deliveries/script/project/tests/fixtures/express/status-labels.v1.json.
 *
 * <p>Display only. The persisted status columns keep {@link StatusSemantic#label} and storage
 * codes, because stored rows are read back through them.</p>
 */
public final class ExpressStatusLabels {
    static final int SCHEMA_VERSION = 1;
    private static final int MAXIMUM_SUBTYPES = 64;

    public static final class Subtype {
        final StatusSemantic semantic;
        final String code;
        final String label;
        final int priority;

        Subtype(StatusSemantic semantic, String code, String label, int priority) {
            this.semantic = semantic;
            this.code = code;
            this.label = label;
            this.priority = priority;
        }
    }

    private final Map<StatusSemantic, String> labels;
    private final Map<StatusSemantic, String> orderLabels;
    private final List<Subtype> subtypes;
    private final String unprojectedOrderScope;
    private final Map<StatusSemantic, StatusSemantic> unprojectedOrderSemantics;

    private ExpressStatusLabels(
            Map<StatusSemantic, String> labels, Map<StatusSemantic, String> orderLabels,
            List<Subtype> subtypes, String unprojectedOrderScope,
            Map<StatusSemantic, StatusSemantic> unprojectedOrderSemantics) {
        this.labels = Collections.unmodifiableMap(new EnumMap<>(labels));
        this.orderLabels = orderLabels.isEmpty() ? Collections.emptyMap()
                : Collections.unmodifiableMap(new EnumMap<>(orderLabels));
        this.subtypes = Collections.unmodifiableList(new ArrayList<>(subtypes));
        this.unprojectedOrderScope = unprojectedOrderScope;
        this.unprojectedOrderSemantics = unprojectedOrderSemantics.isEmpty()
                ? Collections.emptyMap()
                : Collections.unmodifiableMap(new EnumMap<>(unprojectedOrderSemantics));
    }

    /** The word for one semantic; a valid table has one for every semantic, UNKNOWN included. */
    public String label(StatusSemantic semantic) {
        String value = labels.get(semantic == null ? StatusSemantic.UNKNOWN : semantic);
        return value == null ? "" : value;
    }

    /** The word an order row without a projected waybill uses for this semantic, or "". */
    public String orderLabel(StatusSemantic semantic) {
        String value = semantic == null ? null : orderLabels.get(semantic);
        return value == null ? "" : value;
    }

    /** A Worker-owned subtype of one semantic (for example 待派送), or "". */
    public String subtypeLabel(StatusSemantic semantic, String code) {
        String wanted = code == null ? "" : code;
        for (Subtype subtype : subtypes) {
            if (subtype.semantic == semantic && subtype.code.equals(wanted)) return subtype.label;
        }
        return "";
    }

    public List<Subtype> subtypes() {
        return subtypes;
    }

    public Map<StatusSemantic, String> labels() {
        return labels;
    }

    public Map<StatusSemantic, String> orderLabels() {
        return orderLabels;
    }

    /**
     * The Worker's reference mapping for order rows without a projected waybill. Lite's row read
     * already applies that display semantic (ExpressSourcePolicy.accountOrderPresentationSemantic),
     * so display never re-applies it.
     */
    public String unprojectedOrderScope() {
        return unprojectedOrderScope;
    }

    public Map<StatusSemantic, StatusSemantic> unprojectedOrderSemantics() {
        return unprojectedOrderSemantics;
    }

    /** The bundled copy of status-labels.v1.json's table (schemaVersion 1). */
    public static ExpressStatusLabels bundled() {
        return BUNDLED;
    }

    private static final ExpressStatusLabels BUNDLED = createBundled();

    private static ExpressStatusLabels createBundled() {
        EnumMap<StatusSemantic, String> labels = new EnumMap<>(StatusSemantic.class);
        labels.put(StatusSemantic.UNKNOWN, "暂无状态");
        labels.put(StatusSemantic.ORDERED, "已下单");
        labels.put(StatusSemantic.SHIPPED, "已发货");
        labels.put(StatusSemantic.PICKED, "已揽件");
        labels.put(StatusSemantic.TRANSIT, "运输中");
        labels.put(StatusSemantic.DELIVERY, "派送中");
        labels.put(StatusSemantic.WAITING_PICKUP, "待取件");
        labels.put(StatusSemantic.COMPLETED, "已签收");
        labels.put(StatusSemantic.DANGER, "异常件");
        labels.put(StatusSemantic.CANCELLED, "已取消");
        EnumMap<StatusSemantic, String> orderLabels = new EnumMap<>(StatusSemantic.class);
        orderLabels.put(StatusSemantic.COMPLETED, "已完成");
        orderLabels.put(StatusSemantic.CANCELLED, "订单已取消");
        List<Subtype> subtypes = new ArrayList<>();
        // 用户 2026-10-02「驿站派送中 统一映射成 待派送」: the subtype's word; its semantic stays DELIVERY.
        subtypes.add(new Subtype(StatusSemantic.DELIVERY, "STA_DELIVERING", "待派送", 1));
        EnumMap<StatusSemantic, StatusSemantic> unprojected = new EnumMap<>(StatusSemantic.class);
        unprojected.put(StatusSemantic.PICKED, StatusSemantic.ORDERED);
        unprojected.put(StatusSemantic.SHIPPED, StatusSemantic.ORDERED);
        return new ExpressStatusLabels(labels, orderLabels, subtypes, "ORDER", unprojected);
    }

    /**
     * Validates structure and types only (audit C5: no table content is hard-coded here). Every
     * known semantic needs a non-empty word; keys this build does not know are ignored so a later
     * Worker may add them. Any malformed field rejects the whole carrier authority payload.
     */
    public static ExpressStatusLabels parse(Object raw) {
        if (!(raw instanceof JSONObject)) {
            throw new IllegalArgumentException("statusLabels must be an object");
        }
        JSONObject root = (JSONObject) raw;
        Object version = root.opt("schemaVersion");
        if (!(version instanceof Number) || ((Number) version).doubleValue() != SCHEMA_VERSION) {
            throw new IllegalArgumentException("unsupported statusLabels schemaVersion");
        }
        EnumMap<StatusSemantic, String> labels = semanticWords(root.opt("labels"), "labels");
        for (StatusSemantic semantic : StatusSemantic.values()) {
            if (!labels.containsKey(semantic)) {
                throw new IllegalArgumentException("statusLabels lacks " + semantic.name());
            }
        }
        EnumMap<StatusSemantic, String> orderLabels =
                semanticWords(root.opt("orderLabels"), "orderLabels");
        List<Subtype> subtypes = subtypes(root.opt("subtypes"));
        String scope = "";
        EnumMap<StatusSemantic, StatusSemantic> unprojected = new EnumMap<>(StatusSemantic.class);
        if (root.has("unprojectedOrder")) {
            Object value = root.opt("unprojectedOrder");
            if (!(value instanceof JSONObject)) {
                throw new IllegalArgumentException("unprojectedOrder must be an object");
            }
            JSONObject order = (JSONObject) value;
            scope = requiredText(order.opt("scope"), "unprojectedOrder.scope");
            Object mapping = order.opt("displaySemantic");
            if (!(mapping instanceof JSONObject)) {
                throw new IllegalArgumentException("displaySemantic must be an object");
            }
            JSONObject displaySemantic = (JSONObject) mapping;
            Iterator<String> keys = displaySemantic.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String target = requiredText(displaySemantic.opt(key), "displaySemantic");
                StatusSemantic from = semantic(key);
                StatusSemantic to = semantic(target);
                if (from == null) continue;
                if (to == null) {
                    throw new IllegalArgumentException("displaySemantic target is unknown");
                }
                unprojected.put(from, to);
            }
        }
        return new ExpressStatusLabels(labels, orderLabels, subtypes, scope, unprojected);
    }

    private static EnumMap<StatusSemantic, String> semanticWords(Object raw, String field) {
        if (!(raw instanceof JSONObject)) {
            throw new IllegalArgumentException(field + " must be an object");
        }
        JSONObject object = (JSONObject) raw;
        EnumMap<StatusSemantic, String> words = new EnumMap<>(StatusSemantic.class);
        Iterator<String> keys = object.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            String word = requiredText(object.opt(key), field);
            StatusSemantic semantic = semantic(key);
            if (semantic != null) words.put(semantic, word);
        }
        return words;
    }

    private static List<Subtype> subtypes(Object raw) {
        if (!(raw instanceof JSONArray)) {
            throw new IllegalArgumentException("subtypes must be an array");
        }
        JSONArray array = (JSONArray) raw;
        if (array.length() > MAXIMUM_SUBTYPES) {
            throw new IllegalArgumentException("too many status subtypes");
        }
        List<Subtype> values = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (int index = 0; index < array.length(); index++) {
            Object rawEntry = array.opt(index);
            if (!(rawEntry instanceof JSONObject)) {
                throw new IllegalArgumentException("status subtype must be an object");
            }
            JSONObject entry = (JSONObject) rawEntry;
            String semanticName = requiredText(entry.opt("semantic"), "subtype.semantic");
            String code = requiredText(entry.opt("code"), "subtype.code");
            String label = requiredText(entry.opt("label"), "subtype.label");
            Object rawPriority = entry.opt("priority");
            if (!(rawPriority instanceof Number)) {
                throw new IllegalArgumentException("subtype.priority must be a number");
            }
            double priority = ((Number) rawPriority).doubleValue();
            if (priority < 0 || priority > Integer.MAX_VALUE || priority != Math.rint(priority)) {
                throw new IllegalArgumentException("subtype.priority must be a whole number");
            }
            if (!seen.add(semanticName + "\n" + code)) {
                throw new IllegalArgumentException("conflicting status subtype");
            }
            StatusSemantic semantic = semantic(semanticName);
            if (semantic == null) continue;
            values.add(new Subtype(semantic, code, label, (int) priority));
        }
        return values;
    }

    private static String requiredText(Object raw, String field) {
        if (!(raw instanceof String) || ((String) raw).trim().isEmpty()) {
            throw new IllegalArgumentException(field + " must be a non-empty string");
        }
        return ((String) raw).trim();
    }

    private static StatusSemantic semantic(String name) {
        for (StatusSemantic value : StatusSemantic.values()) {
            if (value.name().equals(name)) return value;
        }
        return null;
    }
}
