package me.pipi.deliveries.data;

import java.util.Locale;

/** Canonical provider slots shared by cache writes and diagnostics; old names are read aliases. */
public final class TimelineSlot {
    public static final String V5_QUERY = "v5_query";
    public static final String V6_LIST = "v6_list";
    public static final String V4_QUERY = "v4_query";
    public static final String V6_QUERY = "v6_query";
    public static final String K100_H5 = "k100_h5";
    public static final String CN_H5 = "cn_h5";
    public static final String JD_H5 = "jd_h5";
    public static final String KDNIAO = "kdniao";

    private TimelineSlot() {}

    public static boolean isAutomaticH5(String value) {
        return CN_H5.equals(normalize(value)) || JD_H5.equals(normalize(value));
    }

    public static String normalize(String value) {
        String clean = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        switch (clean) {
            case "interface5":
                return V5_QUERY;
            case "interface6":
                return V6_LIST;
            case "v4":
                return V4_QUERY;
            case "meizu":
            case "meizu_picker":
            case "v6_picker":
                return V6_QUERY;
            case "kuaidi100":
            case "web":
                return K100_H5;
            default:
                return clean;
        }
    }

    /** 账号槽（v5_query / v6_list）：节点按账号接口的状态码解码。 */
    public static boolean isAccount(String value) {
        String slot = normalize(value);
        return V5_QUERY.equals(slot) || V6_LIST.equals(slot);
    }

    /** 账号槽对应的绑定来源；非账号槽返回空串。 */
    public static String bindingSourceOf(String value) {
        String slot = normalize(value);
        if (V5_QUERY.equals(slot)) return "interface5";
        if (V6_LIST.equals(slot)) return "interface6";
        return "";
    }

    /** 绑定来源对应的账号槽。 */
    public static String forBindingSource(String bindingSource) {
        String clean = bindingSource == null ? "" : bindingSource.trim().toLowerCase(Locale.ROOT);
        return "interface5".equals(clean) || V5_QUERY.equals(clean) ? V5_QUERY : V6_LIST;
    }
}
