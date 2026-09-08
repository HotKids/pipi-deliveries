package me.pipi.deliveries.data;

import org.json.JSONArray;
import org.json.JSONObject;

/** Exact schema-v2 table fixture shared by registry and refresh tests. */
public final class CarrierAuthorityFixture {
    private CarrierAuthorityFixture() {}

    public static JSONObject payload() throws Exception {
        JSONArray entries = new JSONArray()
                .put(entry("SF", "顺丰速运", "shunfeng", "95338", "sf", true,
                        values("SFEXPRESS", "SHUNFENG"), values(), values(),
                        values("顺丰", "顺丰快递")))
                .put(entry("ZTO", "中通快递", "zhongtong", "95311", "zto", true,
                        values("ZHONGTONG"), values(), values(), values("中通")))
                .put(entry("ZTOKY", "中通快运", "zhongtongkuaiyun", "", "zto", false,
                        values(), values(), values(), values()))
                .put(entry("YTO", "圆通速递", "yuantong", "95554", "yto", false,
                        values("YUANTONG"), values(), values(), values("圆通", "圆通快递")))
                .put(entry("STO", "申通快递", "shentong", "95543", "sto", false,
                        values("SHENTONG"), values(), values(), values("申通")))
                .put(entry("YD", "韵达快递", "yunda", "95546", "yd", false,
                        values("YUNDA"), values(), values(), values("韵达", "韵达速递")))
                .put(entry("JD", "京东快递", "jd", "950616", "jd", true,
                        values("JDKD", "JINGDONG", "JDLEX"), values("JD"), values(),
                        values("京东", "京东物流", "京东快递")))
                .put(entry("JDKY", "京东快运", "jingdongkuaiyun", "950616", "jd", false,
                        values(), values(), values(), values()))
                .put(entry("EMS", "EMS", "ems", "11183", "ems", false,
                        values("EYB"), values(), values(), values("邮政EMS", "邮政特快")))
                .put(entry("YZPY", "邮政快递", "youzhengguonei", "11183", "yzpy", false,
                        values("POST", "POSTB", "CHINAPOST", "YOUZHENGGUONEI", "YOUZHENGBK"),
                        values(), values(), values("邮政", "邮政快递包裹", "邮政国内标准", "中国邮政",
                                "邮政包裹", "包裹信件")))
                .put(entry("JTSD", "极兔速递", "jtexpress", "956025", "jtsd", false,
                        values("JT", "J&T", "JTEXPRESS", "JITU"), values(), values(),
                        values("极兔")))
                .put(entry("HTKY", "极兔速递", "huitongkuaidi", "", "jtsd", false,
                        values("BEST", "BESTQJT", "HUITONGKUAIDI"), values(), values(),
                        values("百世", "百世快递", "汇通")))
                .put(entry("DBL", "德邦快递", "debangkuaidi", "95353", "dbl", false,
                        values("DBKD", "DEBANGKUAIDI", "DEBANGWULIU"), values(),
                        values("debangwuliu"), values("德邦", "德邦物流")))
                .put(entry("KYSY", "跨越速运", "kuayue", "95324", "kysy", true,
                        values("KY", "KUAYUE", "KYE"), values(), values(), values("跨越")))
                .put(entry("ZJS", "宅急送", "zhaijisong", "4006789000", "zjs", false,
                        values("ZHAIJISONG"), values(), values(), values()))
                .put(entry("UC", "优速快递", "youshuwuliu", "", "uc", false,
                        values("YOUSHUWULIU"), values(), values(), values("优速")))
                .put(entry("DANNIAO", "丹鸟速递", "danniao", "", "danniao", false,
                        values("ZMKM", "ZMKMKD"), values(), values(),
                        values("丹鸟", "丹鸟快递", "菜鸟速递", "菜鸟直送", "菜鸟直送(丹鸟)",
                                "菜鸟直送（丹鸟）")));
        return new JSONObject()
                .put("schemaVersion", 2)
                .put("version", CarrierRegistry.AUTHORITY_VERSION)
                .put("source", CarrierRegistry.AUTHORITY_SOURCE)
                .put("entries", entries);
    }

    public static JSONObject entry(JSONObject payload, String standardCode) throws Exception {
        JSONArray entries = payload.getJSONArray("entries");
        for (int index = 0; index < entries.length(); index++) {
            JSONObject entry = entries.getJSONObject(index);
            if (standardCode.equals(entry.optString("standardCode"))) return entry;
        }
        throw new IllegalArgumentException("unknown fixture carrier");
    }

    private static JSONObject entry(
            String code, String name, String kuaidi100, String hotline, String iconKey,
            boolean phoneTail, JSONArray aliases, JSONArray prefixes,
            JSONArray kuaidiAliases, JSONArray nameAliases) throws Exception {
        return new JSONObject()
                .put("standardCode", code)
                .put("displayName", name)
                .put("kuaidi100Code", kuaidi100)
                .put("hotline", hotline)
                .put("iconKey", iconKey)
                .put("requiresPhoneTail", phoneTail)
                .put("codeAliases", aliases)
                .put("codePrefixAliases", prefixes)
                .put("kuaidi100CodeAliases", kuaidiAliases)
                .put("nameAliases", nameAliases);
    }

    private static JSONArray values(String... values) {
        JSONArray result = new JSONArray();
        for (String value : values) result.put(value);
        return result;
    }
}
