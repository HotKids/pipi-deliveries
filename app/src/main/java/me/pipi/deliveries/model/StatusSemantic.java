package me.pipi.deliveries.model;

import java.util.Locale;

import org.json.JSONObject;

import me.pipi.deliveries.data.ExpressStatusLabels;

/** Provider-neutral delivery state used by every app surface. */
public enum StatusSemantic {
    CANCELLED("CANCELLED", "已取消"),
    DANGER("FAILED", "异常件"),
    ORDERED("CREATE", "已下单"),
    SHIPPED("SHIPPED", "已发货"),
    PICKED("GOT", "已揽件"),
    TRANSIT("TRANSPORT", "运输中"),
    DELIVERY("DELIVERING", "派送中"),
    WAITING_PICKUP("AGENT_SIGN", "待取件"),
    COMPLETED("SIGN", "已签收"),
    UNKNOWN("UNKNOWN", "暂无状态");

    public final String storageCode;
    public final String label;

    StatusSemantic(String storageCode, String label) {
        this.storageCode = storageCode;
        this.label = label;
    }

    public boolean terminal() {
        return this == COMPLETED || this == CANCELLED;
    }

    /**
     * Customs clearance (owner decision 2026-11-20 「清关中…应该属于运输中吧…显示清关中 属于运输中的分支」; the
     * Worker's express-status.js CUSTOMS_CLEARANCE_POLICY holds the same values). Meizu v6 maps Kuaidi100's
     * customs states into its coarse FAILED bucket and keeps the structured state name in the sibling
     * description field: only that exact description refines FAILED. 清关中 is the TRANSIT subtype
     * {@link #CUSTOMS_CLEARANCE_CODE}, 待清关 and 已清关 are plain TRANSIT, and every other description, or
     * none, stays FAILED (异常件). Track text is never read.
     */
    public static final String CUSTOMS_CLEARANCE_CODE = "CUSTOMS_CLEARANCE";
    static final String[] MEIZU_DESCRIPTION_FIELDS = {"logisticsStatusDesc", "stateName"};

    /** The common status code a Meizu v6 FAILED bucket refines to, or "" when it stays FAILED. */
    public static String meizuFailedDescriptionCode(String coarseStatus, String description) {
        if (!"FAILED".equals(clean(coarseStatus).toUpperCase(Locale.ROOT))) return "";
        switch (clean(description)) {
            case "清关中": return CUSTOMS_CLEARANCE_CODE;
            case "待清关":
            case "已清关": return "TRANSIT";
            default: return "";
        }
    }

    /**
     * A Meizu v6 row's or node's own structured description ({@link #MEIZU_DESCRIPTION_FIELDS} in order,
     * string or number, trimmed), or "": the value the customs refinement reads.
     */
    static String meizuDescription(JSONObject row) {
        if (row == null) return "";
        for (String field : MEIZU_DESCRIPTION_FIELDS) {
            Object value = row.opt(field);
            if ((value instanceof String || value instanceof Number)
                    && !String.valueOf(value).trim().isEmpty()) {
                return String.valueOf(value).trim();
            }
        }
        return "";
    }

    /**
     * Meizu v6 coarse status fields in the Worker's order (express-status.js {@code nodeStatus("v6")}).
     * The owner's 2026-11-21 answer 「Read it for every status」 lets the correctly spelled
     * {@code logisticsStatus} decide every Online status beside the upstream spelling
     * {@code logsiticsStatus}, {@code status} and {@code state}, as the Worker, Pipi, iOS and the Bot read
     * them (docs/EXPRESS_OWNERSHIP_PLAN_FINAL_20260830.md §6.4 amendment).
     */
    static final String[] MEIZU_COARSE_FIELDS = {"logsiticsStatus", "logisticsStatus", "status", "state"};

    /**
     * The Worker's v6 reading of one row's coarse status fields. A value counts as recognized when the
     * Worker's full {@code common} vocabulary in the bundled or served status label table knows it (owner
     * 2026-11-21 「Lite 用完整状态词表（推荐）」: the vocabulary the Worker and the Bot read, not only
     * {@code storedCodes}), so values such as RETURNED, 签收, FINISHED, 揽件, CLOSE, 在途 and MANUAL_SIGN
     * decide or disagree as they do in the Worker.
     */
    public static final class MeizuCoarseStatus {
        /**
         * The first recognized value in field order, trimmed and in its original case (the Worker
         * upper-cases its code), else the first non-empty value; "" when every field is empty or two
         * recognized values disagree (the Worker keeps the first recognized value as its code there).
         */
        public final String code;
        /** True when {@link #code} is a value the {@code common} vocabulary recognizes. */
        public final boolean recognized;
        /** True when two recognized values disagree: the row has no status (the Worker's UNKNOWN). */
        public final boolean conflict;
        /** The {@code common} vocabulary's semantic of {@link #code}, or UNKNOWN when none is recognized. */
        public final StatusSemantic recognizedSemantic;

        MeizuCoarseStatus(String code, StatusSemantic recognizedSemantic, boolean conflict) {
            this.code = code;
            this.recognizedSemantic = recognizedSemantic == null ? UNKNOWN : recognizedSemantic;
            this.recognized = this.recognizedSemantic != UNKNOWN;
            this.conflict = conflict;
        }

        /**
         * The status the row shows: none on a conflict, the recognized value's semantic, otherwise the
         * status the caller's description field names ({@link #fromStored} with no code). Only a recognized
         * value is structured evidence (owner 2026-11-21 「文案推出的状态不当结构化证据（推荐）」, AGENTS.md §9
         * 「状态看结构化，不看文案」); the description's status is display only, and the Worker gives such a
         * row no status at all.
         */
        public StatusSemantic semantic(String description) {
            if (conflict) return UNKNOWN;
            return recognized ? recognizedSemantic : fromStored("", description);
        }
    }

    /** A Meizu v6 coarse value's semantic in the {@code common} vocabulary, or UNKNOWN. */
    static StatusSemantic meizuCommonSemantic(String value) {
        StatusSemantic ruled = ExpressStatusLabels.rules().code("common", value);
        return ruled == null ? UNKNOWN : ruled;
    }

    /**
     * Reads {@link #MEIZU_COARSE_FIELDS} like the Worker: string or number values, trimmed; the first
     * value the {@code common} vocabulary recognizes (case-insensitively, as the Worker upper-cases it)
     * decides, an unrecognized value does not mask a recognized one, and recognized values whose
     * semantics disagree give no status.
     */
    public static MeizuCoarseStatus meizuCoarseStatus(JSONObject row) {
        String firstPresent = "";
        String recognized = "";
        StatusSemantic semantic = UNKNOWN;
        for (String field : MEIZU_COARSE_FIELDS) {
            Object raw = row == null ? null : row.opt(field);
            if (!(raw instanceof String || raw instanceof Number)) continue;
            String value = String.valueOf(raw).trim();
            if (value.isEmpty()) continue;
            if (firstPresent.isEmpty()) firstPresent = value;
            StatusSemantic candidate = meizuCommonSemantic(value);
            if (candidate == UNKNOWN) continue;
            if (semantic == UNKNOWN) {
                recognized = value;
                semantic = candidate;
            } else if (candidate != semantic) {
                return new MeizuCoarseStatus("", UNKNOWN, true);
            }
        }
        return recognized.isEmpty() ? new MeizuCoarseStatus(firstPresent, UNKNOWN, false)
                : new MeizuCoarseStatus(recognized, semantic, false);
    }

    /**
     * A Meizu Online timeline node's semantic from its own coarse fields, read like the Worker's
     * {@code nodeStatus("v6")} gives a node (owner 2026-11-21 「Read it for every status」 and 「Lite
     * 用完整状态词表（推荐）」): UNKNOWN when recognized values disagree, TRANSIT when the node's own
     * description refines a FAILED code (customs clearance, owner 2026-11-20), otherwise the recognized
     * value's {@code common} semantic. Returns null when no coarse value is recognized, so the caller keeps
     * its existing reading of the node's other structured fields (the Kuaidi100-style {@code statusCode}
     * Meizu nodes carry, for one); a Meizu node's description field is no structured status there
     * (owner 2026-11-21 「文案推出的状态不当结构化证据（推荐）」).
     */
    public static StatusSemantic meizuNodeSemantic(JSONObject node) {
        MeizuCoarseStatus coarse = meizuCoarseStatus(node);
        if (coarse.conflict) return UNKNOWN;
        if (!coarse.recognized) return null;
        if (!meizuFailedDescriptionCode(coarse.code, meizuDescription(node)).isEmpty()) return TRANSIT;
        return coarse.recognizedSemantic;
    }

    public static StatusSemantic fromStored(String code, String description) {
        String value = clean(code).toUpperCase(Locale.ROOT);
        StatusSemantic ruled = ExpressStatusLabels.rules().code("storedCodes", value);
        if (ruled != null) return ruled;
        switch (value) {
            case "CANCEL": case "CANCELLED": return CANCELLED;
            case "FAILED": case "PROBLEM": case "EXCEPTION": return DANGER;
            case "CREATE": case "ORDER": case "ORDERED": return ORDERED;
            case "SHIPPED": case "CONSIGN": return SHIPPED;
            case "GOT": case "ACCEPT": case "COLLECT": case "PICKED": return PICKED;
            case "TRANSPORT": case "TRANSIT": case "INTRANSIT": return TRANSIT;
            case "DELIVERING": case "DELIVERY": case "DISPATCH": return DELIVERY;
            case "AGENT_SIGN": case "WAITING_PICKUP": return WAITING_PICKUP;
            case "SIGN": case "SIGNED": case "COMPLETED": return COMPLETED;
            default: return fromLabel(description);
        }
    }

    /** Kuaidi100 resultv2=4 event status; response-summary state is intentionally excluded. */
    public static StatusSemantic fromKuaidi100EventCode(String code) {
        String value = clean(code).toUpperCase(Locale.ROOT);
        StatusSemantic ruled = ExpressStatusLabels.rules().code("k100", value);
        if (ruled != null) return ruled;
        switch (value) {
            case "101": case "102": return ORDERED;
            case "1": case "103": return PICKED;
            case "0": case "1001": case "1002": case "1003":
            case "7": case "8": case "10": case "11": case "12": return TRANSIT;
            case "5": return DELIVERY;
            case "501": return WAITING_PICKUP;
            case "3": case "301": case "302": case "303": case "304": return COMPLETED;
            case "401": return CANCELLED;
            case "2": case "4": case "6": case "13": case "14":
            case "201": case "202": case "203": case "204": case "205":
            case "206": case "207": case "208": case "209": case "210": return DANGER;
            default: return UNKNOWN;
        }
    }

    /** Kuaidi100's successful response summary belongs to the same provider display package. */
    public static StatusSemantic fromKuaidi100SummaryState(String state) {
        return "3".equals(clean(state)) ? COMPLETED : UNKNOWN;
    }

    /** Account-source ExpressState stateNum contract (101 through 111). */
    public static StatusSemantic fromAccountState(String stateNum, String stateText) {
        String state = clean(stateNum);
        StatusSemantic ruled = ExpressStatusLabels.rules().code("v5StateNum", state);
        if (ruled != null) return ruled;
        switch (state) {
            case "101": return ORDERED;
            case "102": return SHIPPED;
            case "103": return PICKED;
            case "104": return TRANSIT;
            case "105": return DELIVERY;
            case "106": return WAITING_PICKUP;
            case "107": return COMPLETED;
            case "108":
            case "109":
            case "110": return DANGER;
            case "111": return CANCELLED;
            default: return fromStored("", stateText);
        }
    }

    private static StatusSemantic fromLabel(String description) {
        String value = clean(description);
        StatusSemantic ruled = ExpressStatusLabels.rules().code("structuredDescriptions", value);
        if (ruled != null) return ruled;
        switch (value) {
            case "取消": case "已取消": return CANCELLED;
            case "问题件": case "异常件": case "异常": case "运输异常": return DANGER;
            case "已下单": return ORDERED;
            case "已发货": return SHIPPED;
            case "揽件": case "已揽件": return PICKED;
            case "在途": case "运输中": return TRANSIT;
            case "派件": case "派送中": return DELIVERY;
            case "待取": case "待取件": case "代取件": case "待领取": return WAITING_PICKUP;
            case "签收": case "已签收": return COMPLETED;
            default: return UNKNOWN;
        }
    }


    /** Only the independently captured JT label enters this finite whole-value table. */
    public static StatusSemantic fromJtLabel(String label) {
        String value = clean(label);
        StatusSemantic ruled = ExpressStatusLabels.rules().code("jtLabels", value);
        if (ruled != null) return ruled;
        switch (value) {
            case "取消": case "已取消": case "订单取消": case "取消订单": return CANCELLED;
            case "问题件": case "异常件": case "异常": case "运输异常": return DANGER;
            case "已下单": return ORDERED;
            case "已发货": return SHIPPED;
            case "揽件": case "已揽件": case "已揽收": return PICKED;
            case "在途": case "运输中": return TRANSIT;
            case "派件": case "派送中": return DELIVERY;
            case "待取": case "待取件": case "代取件": case "待领取": return WAITING_PICKUP;
            case "签收": case "已签收": return COMPLETED;
            default: return UNKNOWN;
        }
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
