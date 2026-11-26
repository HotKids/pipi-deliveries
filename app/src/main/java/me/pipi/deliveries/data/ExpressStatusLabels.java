package me.pipi.deliveries.data;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import me.pipi.deliveries.model.StatusSemantic;

/**
 * The one status label table (audit L5, user defaults of 2026-09-25): list, detail, widgets and
 * notification titles read their status word from here, so DANGER reads 异常件 and UNKNOWN reads
 * 暂无状态 on every surface. The Worker serves the table with the carrier authority snapshot as
 * {@code statusLabels} (kept in {@link CarrierRegistry} with that snapshot); {@link #bundled()} is
 * the same table for first-offline startup and for a Worker that does not serve it yet. Shared
 * fixture: deliveries/script/project/tests/fixtures/express/status-labels.v1.json.
 *
 * <p>Display only. The persisted status columns keep fixed storage words and codes
 * ({@code ExpressPresentation#label} / {@code StatusSemantic#label}), because stored rows are read
 * back through them.</p>
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
    private final JSONObject statusRules;
    private final JSONObject proseRules;

    private ExpressStatusLabels(
            Map<StatusSemantic, String> labels, Map<StatusSemantic, String> orderLabels,
            List<Subtype> subtypes, String unprojectedOrderScope,
            Map<StatusSemantic, StatusSemantic> unprojectedOrderSemantics,
            JSONObject statusRules, JSONObject proseRules) {
        this.labels = Collections.unmodifiableMap(new EnumMap<>(labels));
        this.orderLabels = orderLabels.isEmpty() ? Collections.emptyMap()
                : Collections.unmodifiableMap(new EnumMap<>(orderLabels));
        this.subtypes = Collections.unmodifiableList(new ArrayList<>(subtypes));
        this.unprojectedOrderScope = unprojectedOrderScope;
        this.unprojectedOrderSemantics = unprojectedOrderSemantics.isEmpty()
                ? Collections.emptyMap()
                : Collections.unmodifiableMap(new EnumMap<>(unprojectedOrderSemantics));
        this.statusRules = statusRules;
        this.proseRules = proseRules;
    }

    /** The word for one semantic; a valid table has one for every semantic, UNKNOWN included. */
    public String label(StatusSemantic semantic) {
        String value = labels.get(semantic == null ? StatusSemantic.UNKNOWN : semantic);
        return value == null ? "" : value;
    }

    /** The word an order row without a projected waybill uses for this semantic, or "". */
    public String orderLabel(StatusSemantic semantic) {
        if (semantic == StatusSemantic.CANCELLED) return label(semantic);
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

    /** The priority of a Worker-owned subtype of one semantic, or 0 when it is no subtype. */
    public int subtypePriority(StatusSemantic semantic, String code) {
        String wanted = code == null ? "" : code;
        for (Subtype subtype : subtypes) {
            if (subtype.semantic == semantic && subtype.code.equals(wanted)) return subtype.priority;
        }
        return 0;
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
     * The Worker's reference mapping for order rows without a projected waybill. Parsers and row
     * readers already apply that display semantic before presentation, so display never re-applies
     * it.
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
    private static volatile ExpressStatusLabels installed;

    /** Publishes the table that code lookup reads. Parse itself does not publish. */
    public static void adopt(ExpressStatusLabels table) {
        if (table != null) installed = table;
    }

    private static volatile Runnable readBarrier;

    /** Lets a host make reads wait for its startup table; without one, reads never wait. */
    public static void setReadBarrier(Runnable barrier) {
        readBarrier = barrier;
    }

    /** The published mapping table, or the bundled copy before the first publish. */
    public static ExpressStatusLabels rules() {
        Runnable barrier = readBarrier;
        if (barrier != null) barrier.run();
        ExpressStatusLabels current = installed;
        return current != null ? current : BUNDLED;
    }

    private static ExpressStatusLabels createBundled() {
        try {
            return parse(new JSONObject(StatusLabelRulesJson.JSON));
        } catch (Exception failure) {
            throw new ExceptionInInitializerError(failure);
        }
    }

    /**
     * Whole-token lookup in one statusRules group (semantic → codes). A missing group or code
     * returns null so the caller's existing switch stays in force.
     */
    public StatusSemantic code(String group, String rawCode) {
        return codeIn(statusRules, group, rawCode);
    }

    /**
     * Samsung JD descriptor override: raw status "派件" plus a listed description uses that
     * description's status alias. Missing policy returns null.
     */
    public StatusSemantic samsungDescriptorOverride(String raw, String description) {
        if (statusRules == null) return null;
        Object samsung = statusRules.opt("v3JD");
        if (!(samsung instanceof JSONObject)) return null;
        JSONObject policy = (JSONObject) samsung;
        Object overrides = policy.opt("descriptorOverrides");
        if (!(overrides instanceof JSONObject)) return null;
        String rawKey = raw == null ? "" : raw.trim();
        String described = description == null ? "" : description.trim();
        if (rawKey.isEmpty() || described.isEmpty()) return null;
        Object listed = ((JSONObject) overrides).opt(rawKey);
        if (!(listed instanceof JSONArray)) return null;
        boolean hit = false;
        JSONArray array = (JSONArray) listed;
        for (int index = 0; index < array.length(); index++) {
            Object item = array.opt(index);
            if (item instanceof String && described.equals(((String) item).trim())) {
                hit = true;
                break;
            }
        }
        if (!hit) return null;
        Object aliases = policy.opt("statusAliases");
        if (!(aliases instanceof JSONObject)) return null;
        Object semanticName = ((JSONObject) aliases).opt(described);
        if (!(semanticName instanceof String)) return null;
        StatusSemantic semantic = semantic((String) semanticName);
        return semantic == null || semantic == StatusSemantic.UNKNOWN ? null : semantic;
    }

    /** Exact v3JD.statusAliases lookup. Missing policy or key returns null. */
    public StatusSemantic samsungJdStatusAlias(String description) {
        JSONObject policy = objectAt(statusRules, "v3JD");
        if (policy == null) return null;
        JSONObject aliases = objectAt(policy, "statusAliases");
        if (aliases == null) return null;
        String described = description == null ? "" : description.trim();
        if (described.isEmpty()) return null;
        Object semanticName = aliases.opt(described);
        if (!(semanticName instanceof String)) return null;
        StatusSemantic semantic = semantic((String) semanticName);
        return semantic == null || semantic == StatusSemantic.UNKNOWN ? null : semantic;
    }

    /** samsungJd.descriptorStatus, or "" when the policy is missing. */
    public String samsungJdDescriptorStatus() {
        JSONObject policy = objectAt(statusRules, "v3JD");
        if (policy == null) return "";
        Object value = policy.opt("descriptorStatus");
        return value instanceof String ? ((String) value).trim() : "";
    }

    /** Exact OPPO JD cancelled-SIGN tuple from oppoJd.cancelledSignTuple. */
    public boolean oppoJdCancelledSign(String state, String stateDescription, String logisticDetail) {
        JSONObject policy = objectAt(statusRules, "v2JD");
        if (policy == null) return false;
        JSONObject tuple = objectAt(policy, "cancelledSignTuple");
        if (tuple == null) return false;
        return textEquals(tuple.opt("state"), state)
                && textEquals(tuple.opt("stateDesc"), stateDescription)
                && textEquals(tuple.opt("detail"), logisticDetail);
    }

    /** proseRules[group][field] string list. Missing group or field returns empty. */
    public List<String> proseWords(String group, String field) {
        JSONObject grouped = objectAt(proseRules, group);
        if (grouped == null || field == null || field.isEmpty()) return Collections.emptyList();
        Object listed = grouped.opt(field);
        if (!(listed instanceof JSONArray)) return Collections.emptyList();
        JSONArray array = (JSONArray) listed;
        List<String> words = new ArrayList<>();
        for (int index = 0; index < array.length(); index++) {
            Object item = array.opt(index);
            if (!(item instanceof String)) continue;
            String word = ((String) item).trim();
            if (!word.isEmpty()) words.add(word);
        }
        return words;
    }

    /** True when compactText contains any word from proseRules[group][field]. */
    public boolean proseContains(String group, String field, String compactText) {
        if (compactText == null || compactText.isEmpty()) return false;
        for (String word : proseWords(group, field)) {
            if (compactText.contains(word)) return true;
        }
        return false;
    }

    private static JSONObject objectAt(JSONObject root, String key) {
        if (root == null || key == null || key.isEmpty()) return null;
        Object value = root.opt(key);
        return value instanceof JSONObject ? (JSONObject) value : null;
    }

    private static boolean textEquals(Object expected, String actual) {
        if (!(expected instanceof String)) return false;
        return ((String) expected).trim().equals(actual == null ? "" : actual.trim());
    }

    private static StatusSemantic codeIn(JSONObject rules, String group, String rawCode) {
        if (rules == null || group == null || group.isEmpty()) return null;
        String wanted = rawCode == null ? "" : rawCode.trim();
        if (wanted.isEmpty()) return null;
        String folded = wanted.toUpperCase(Locale.ROOT);
        Object groupRaw = rules.opt(group);
        if (!(groupRaw instanceof JSONObject)) return null;
        JSONObject groupObject = (JSONObject) groupRaw;
        Iterator<String> keys = groupObject.keys();
        while (keys.hasNext()) {
            String semanticName = keys.next();
            StatusSemantic semantic = semantic(semanticName);
            if (semantic == null || semantic == StatusSemantic.UNKNOWN) continue;
            Object codes = groupObject.opt(semanticName);
            if (!(codes instanceof JSONArray)) continue;
            JSONArray array = (JSONArray) codes;
            for (int index = 0; index < array.length(); index++) {
                Object item = array.opt(index);
                if (!(item instanceof String)) continue;
                if (folded.equals(((String) item).trim().toUpperCase(Locale.ROOT))) return semantic;
            }
        }
        return null;
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
        JSONObject statusRules = root.opt("statusRules") instanceof JSONObject
                ? root.optJSONObject("statusRules") : null;
        JSONObject proseRules = root.opt("proseRules") instanceof JSONObject
                ? root.optJSONObject("proseRules") : null;
        statusRules = mergeBundledGroups(statusRules, BUNDLED == null ? null : BUNDLED.statusRules);
        proseRules = mergeBundledGroups(proseRules, BUNDLED == null ? null : BUNDLED.proseRules);
        return new ExpressStatusLabels(
                labels, orderLabels, subtypes, scope, unprojected, statusRules, proseRules);
    }

    /**
     * Remote tables overlay bundled groups wholesale. A missing group, or a missing
     * {@code statusRules}/{@code proseRules} object, keeps the bundled snapshot so G2 still
     * maps after a carrier refresh that omits the rules.
     */
    private static JSONObject mergeBundledGroups(JSONObject remote, JSONObject bundled) {
        if (bundled == null) return remote;
        JSONObject merged = copyObject(bundled);
        if (remote == null) return merged;
        Iterator<String> keys = remote.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            Object value = remote.opt(key);
            try {
                if (value instanceof JSONObject) {
                    merged.put(key, new JSONObject(value.toString()));
                } else if (value instanceof JSONArray) {
                    merged.put(key, new JSONArray(value.toString()));
                } else {
                    merged.put(key, value);
                }
            } catch (org.json.JSONException failure) {
                throw new IllegalArgumentException(failure);
            }
        }
        return merged;
    }

    private static JSONObject copyObject(JSONObject source) {
        if (source == null) return null;
        try {
            return new JSONObject(source.toString());
        } catch (org.json.JSONException failure) {
            throw new IllegalArgumentException(failure);
        }
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
