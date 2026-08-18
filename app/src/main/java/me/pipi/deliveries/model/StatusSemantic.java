package me.pipi.deliveries.model;

import java.util.Locale;

/** Provider-neutral delivery state used by every app surface. */
public enum StatusSemantic {
    CANCELLED("CANCELLED", "已取消"),
    DANGER("FAILED", "运输异常"),
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

    public static StatusSemantic fromStored(String code, String description) {
        String value = clean(code).toUpperCase(Locale.ROOT);
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

    public static StatusSemantic fromKuaidi100(String code, String topLevelState) {
        String value = clean(code).toUpperCase(Locale.ROOT);
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
            default:
                if ("3".equals(clean(topLevelState))) return COMPLETED;
                return UNKNOWN;
        }
    }

    /** Account-source ExpressState stateNum contract (101 through 111). */
    public static StatusSemantic fromAccountState(String stateNum, String stateText) {
        switch (clean(stateNum)) {
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
        switch (clean(description)) {
            case "取消": case "已取消": return CANCELLED;
            case "问题件": case "异常": case "运输异常": return DANGER;
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

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
