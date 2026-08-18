package me.pipi.deliveries.data;

import android.content.Context;
import android.net.Uri;

import me.pipi.deliveries.R;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Pipi's local courier registry, shared by list, detail, widgets and stored icon URIs. */
public final class CarrierRegistry {
    public static final class Carrier {
        public final String standardCode;
        public final String companyName;
        public final String kuaidi100Code;
        public final int iconResource;
        public final boolean requiresPhoneTail;

        Carrier(String code, String name, String kuaidi100, int icon, boolean phoneTail) {
            standardCode = code;
            companyName = name;
            kuaidi100Code = kuaidi100;
            iconResource = icon;
            requiresPhoneTail = phoneTail;
        }
    }

    private static final Map<String, Carrier> BY_ALIAS = new HashMap<>();
    private static final Map<String, Carrier> BY_NAME = new HashMap<>();

    static {
        add(new Carrier("SF", "顺丰速运", "shunfeng", R.drawable.sf, true),
                "SFEXPRESS", "SHUNFENG");
        add(new Carrier("ZTO", "中通快递", "zhongtong", R.drawable.zto, true),
                "ZHONGTONG");
        add(new Carrier("ZTOKY", "中通快运", "zhongtongkuaiyun", R.drawable.zto, false));
        add(new Carrier("YTO", "圆通速递", "yuantong", R.drawable.yto, false), "YUANTONG");
        add(new Carrier("STO", "申通快递", "shentong", R.drawable.sto, false), "SHENTONG");
        add(new Carrier("YD", "韵达快递", "yunda", R.drawable.yd, false), "YUNDA");
        add(new Carrier("JD", "京东快递", "jd", R.drawable.jd, false),
                "JDKD", "JINGDONG");
        add(new Carrier("JDKY", "京东快运", "jingdongkuaiyun", R.drawable.jd, false));
        add(new Carrier("EMS", "EMS", "ems", R.drawable.ems, false));
        add(new Carrier("EMSGJ", "EMS 国际", "emsguoji", R.drawable.emsgj, false));
        add(new Carrier("YZPY", "邮政包裹", "youzhengguonei", R.drawable.yzpy, false),
                "POST", "POSTB", "CHINAPOST", "YOUZHENGGUONEI", "YOUZHENGBK");
        add(new Carrier("JTSD", "极兔速递", "jtexpress", R.drawable.jtsd, false),
                "JT", "JTEXPRESS");
        add(new Carrier("HTKY", "百世快递", "huitongkuaidi",
                R.drawable.ic_card_express_cp_default, false),
                "BEST", "BESTQJT", "HUITONGKUAIDI");
        add(new Carrier("DBL", "德邦快递", "debangkuaidi", R.drawable.dbl, false),
                "DBKD", "DEBANGKUAIDI", "DEBANGWULIU");
        add(new Carrier("KYSY", "跨越速运", "kuayue", R.drawable.kysy, true),
                "KY", "KUAYUE");
        add(new Carrier("ZJS", "宅急送", "zhaijisong", R.drawable.zjs, false), "ZHAIJISONG");
        add(new Carrier("UC", "优速快递", "youshuwuliu", R.drawable.uc, false), "YOUSHUWULIU");
        add(new Carrier("DANNIAO", "丹鸟速递", "danniao", R.drawable.danniao, false),
                "ZMKMKD");

        aliasName("顺丰", "SF"); aliasName("顺丰快递", "SF");
        aliasName("中通", "ZTO"); aliasName("圆通", "YTO"); aliasName("圆通快递", "YTO");
        aliasName("申通", "STO"); aliasName("韵达", "YD"); aliasName("韵达速递", "YD");
        aliasName("京东", "JD"); aliasName("京东物流", "JD");
        aliasName("邮政", "YZPY"); aliasName("邮政快递", "YZPY");
        aliasName("邮政快递包裹", "YZPY"); aliasName("邮政国内标准", "YZPY");
        aliasName("中国邮政", "YZPY"); aliasName("包裹信件", "YZPY");
        aliasName("极兔", "JTSD"); aliasName("百世", "HTKY"); aliasName("百世快递", "HTKY");
        aliasName("德邦", "DBL"); aliasName("德邦物流", "DBL");
        aliasName("丹鸟", "DANNIAO"); aliasName("丹鸟快递", "DANNIAO");
        aliasName("菜鸟速递", "DANNIAO"); aliasName("菜鸟直送", "DANNIAO");
        aliasName("菜鸟直送(丹鸟)", "DANNIAO");
        aliasName("菜鸟直送（丹鸟）", "DANNIAO");
    }

    private CarrierRegistry() {}

    private static void add(Carrier carrier, String... aliases) {
        BY_ALIAS.put(normalizeCode(carrier.standardCode), carrier);
        BY_ALIAS.put(normalizeCode(carrier.kuaidi100Code), carrier);
        BY_NAME.put(normalizeName(carrier.companyName), carrier);
        for (String alias : aliases) BY_ALIAS.put(normalizeCode(alias), carrier);
    }

    private static void aliasName(String name, String code) {
        Carrier carrier = BY_ALIAS.get(normalizeCode(code));
        if (carrier != null) BY_NAME.put(normalizeName(name), carrier);
    }

    public static Carrier resolve(String code, String companyName) {
        Carrier carrier = BY_ALIAS.get(normalizeCode(code));
        if (carrier != null) return carrier;
        return BY_NAME.get(normalizeName(companyName));
    }

    public static int icon(String code, String companyName) {
        Carrier carrier = presentationCarrier(code, companyName);
        return carrier == null ? R.drawable.ic_card_express_cp_default : carrier.iconResource;
    }

    public static String localIconUri(Context context, String code, String companyName) {
        int resource = icon(code, companyName);
        return new Uri.Builder()
                .scheme("android.resource")
                .authority(context.getPackageName())
                .appendPath(Integer.toString(resource))
                .build()
                .toString();
    }

    public static String companyName(String code, String fallback) {
        Carrier carrier = resolve(code, fallback);
        return carrier == null ? clean(fallback) : carrier.companyName;
    }

    /** User-visible name only; source identities and every outbound protocol stay untouched. */
    public static String displayName(String code, String fallback) {
        Carrier carrier = presentationCarrier(code, fallback);
        return carrier == null ? clean(fallback) : carrier.companyName;
    }

    public static String queryCode(String code, String companyName) {
        Carrier carrier = resolve(code, companyName);
        return carrier == null ? clean(code) : carrier.kuaidi100Code;
    }

    /** Only accepts unambiguous, carrier-owned alphabetic prefixes. */
    public static Carrier guessByWaybill(String waybill) {
        String value = clean(waybill).toUpperCase(Locale.ROOT)
                .replaceAll("[^A-Z0-9]", "");
        if (value.startsWith("SF")) return resolve("SF", "");
        if (value.startsWith("JD")) return resolve("JD", "");
        if (value.startsWith("JT")) return resolve("JTSD", "");
        if (value.startsWith("YT")) return resolve("YTO", "");
        if (value.startsWith("ZTO")) return resolve("ZTO", "");
        if (value.startsWith("STO")) return resolve("STO", "");
        if (value.startsWith("YD")) return resolve("YD", "");
        if (value.startsWith("EMS")) return resolve("EMS", "");
        if (value.startsWith("KYE") || value.startsWith("KY")) {
            return resolve("KYSY", "");
        }
        if (value.startsWith("ZJS")) return resolve("ZJS", "");
        return null;
    }

    /** Official carrier hotline shown by Pipi's local express detail header. */
    public static String hotline(String code, String companyName) {
        Carrier carrier = resolve(code, companyName);
        if (carrier == null) return "";
        switch (carrier.standardCode) {
            case "SF": return "95338";
            case "ZTO": return "95311";
            case "YTO": return "95554";
            case "STO": return "95543";
            case "YD": return "95546";
            case "JD":
            case "JDKY": return "950616";
            case "EMS":
            case "YZPY": return "11183";
            case "JTSD":
            case "HTKY": return "956025";
            case "DBL": return "95353";
            case "KYSY": return "95324";
            case "ZJS": return "4006789000";
            default: return "";
        }
    }

    private static Carrier presentationCarrier(String code, String companyName) {
        Carrier carrier = resolve(code, companyName);
        if (carrier != null && "HTKY".equals(carrier.standardCode)) {
            Carrier jtexpress = BY_ALIAS.get(normalizeCode("JTSD"));
            if (jtexpress != null) return jtexpress;
        }
        return carrier;
    }

    private static String normalizeCode(String value) {
        String code = clean(value).toUpperCase(Locale.ROOT);
        if (code.startsWith("VIVO_")) code = code.substring(5);
        return code.replaceAll("[^A-Z0-9]", "");
    }

    private static String normalizeName(String value) {
        return clean(value).replaceAll("\\s+", "").toUpperCase(Locale.ROOT);
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
