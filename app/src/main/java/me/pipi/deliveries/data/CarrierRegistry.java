package me.pipi.deliveries.data;

import android.content.Context;
import android.net.Uri;

import me.pipi.deliveries.R;
import me.pipi.deliveries.model.CarrierNormalization;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Worker-backed courier registry shared by list, detail, widgets and stored icon URIs. */
public final class CarrierRegistry {
    public static final String AUTHORITY_VERSION =
            "6e4ec3e45a460dbea446093a9b7ccb81b2da80f716f57369bc32572d640dda0e";
    public static final String AUTHORITY_SOURCE = "embedded-transition";

    private static final Pattern STANDARD_CODE = Pattern.compile("[A-Z0-9]{1,32}");
    private static final Pattern CODE_ALIAS = Pattern.compile("[A-Z0-9&_\\-]{1,64}");
    private static final Pattern CODE_PREFIX = Pattern.compile("[A-Z0-9]{1,32}");
    private static final Pattern KUAIDI100_CODE = Pattern.compile("[A-Za-z0-9_\\-]{1,64}");
    private static final Pattern ICON_KEY = Pattern.compile("[a-z0-9_]{1,64}");
    private static final Pattern HOTLINE = Pattern.compile("[0-9]{3,20}");
    private static final Pattern AUTHORITY_VERSION_PATTERN =
            Pattern.compile("[A-Za-z0-9._\\-]{1,128}");

    public static final class Carrier {
        public final String standardCode;
        public final String companyName;
        public final String kuaidi100Code;
        public final String hotline;
        public final int iconResource;
        public final boolean requiresPhoneTail;

        Carrier(
                String code, String name, String kuaidi100, String officialHotline,
                int icon, boolean phoneTail) {
            standardCode = code;
            companyName = name;
            kuaidi100Code = kuaidi100;
            hotline = officialHotline;
            iconResource = icon;
            requiresPhoneTail = phoneTail;
        }
    }

    /** Opaque, fully validated replacement built before the active indexes are touched. */
    public static final class PreparedAuthority {
        private final Snapshot snapshot;

        private PreparedAuthority(Snapshot value) {
            snapshot = value;
        }
    }

    private static final class Definition {
        final Carrier carrier;
        final List<String> codeAliases;
        final List<String> codePrefixAliases;
        final List<String> kuaidi100CodeAliases;
        final List<String> nameAliases;

        Definition(
                Carrier value, List<String> aliases, List<String> prefixes,
                List<String> kuaidiAliases, List<String> names) {
            carrier = value;
            codeAliases = aliases;
            codePrefixAliases = prefixes;
            kuaidi100CodeAliases = kuaidiAliases;
            nameAliases = names;
        }
    }

    private static final class Snapshot {
        final Map<String, Carrier> byInternalCode;
        final Map<String, Carrier> byRawCpCode;
        final Map<String, Carrier> byKuaidi100Code;
        final Map<String, Carrier> byPrefix;
        final Map<String, Carrier> byName;
        final int size;

        Snapshot(
                Map<String, Carrier> internalCodes,
                Map<String, Carrier> rawCpCodes,
                Map<String, Carrier> kuaidi100Codes,
                Map<String, Carrier> prefixes, Map<String, Carrier> names, int count) {
            byInternalCode = Collections.unmodifiableMap(internalCodes);
            byRawCpCode = Collections.unmodifiableMap(rawCpCodes);
            byKuaidi100Code = Collections.unmodifiableMap(kuaidi100Codes);
            byPrefix = Collections.unmodifiableMap(prefixes);
            byName = Collections.unmodifiableMap(names);
            size = count;
        }
    }

    private static final Snapshot BOOTSTRAP = buildSnapshot(bootstrapDefinitions());
    private static volatile Snapshot active = BOOTSTRAP;

    private CarrierRegistry() {}

    /** Validates the complete Worker envelope and builds every replacement index off to the side. */
    public static PreparedAuthority prepareAuthority(JSONObject root) {
        if (root == null) throw new IllegalArgumentException("carrier authority is required");
        Object schema = root.opt("schemaVersion");
        if (!(schema instanceof Number) || ((Number) schema).intValue() != 2
                || ((Number) schema).doubleValue() != 2d) {
            throw new IllegalArgumentException("unsupported carrier authority schema");
        }
        requiredMatching(root, "version", 128, AUTHORITY_VERSION_PATTERN);
        requiredString(root, "source", 512);
        Object rawEntries = root.opt("entries");
        if (!(rawEntries instanceof JSONArray)) {
            throw new IllegalArgumentException("carrier authority entries are required");
        }
        JSONArray entries = (JSONArray) rawEntries;
        if (entries.length() < 17 || entries.length() > 256) {
            throw new IllegalArgumentException("carrier authority entry count is invalid");
        }

        ArrayList<Definition> definitions = new ArrayList<>(entries.length());
        for (int index = 0; index < entries.length(); index++) {
            Object raw = entries.opt(index);
            if (!(raw instanceof JSONObject)) {
                throw new IllegalArgumentException("carrier authority entry is invalid");
            }
            definitions.add(parseDefinition((JSONObject) raw));
        }
        Snapshot snapshot = buildSnapshot(definitions);
        validateRequiredContract(snapshot);
        return new PreparedAuthority(snapshot);
    }

    /** Atomically publishes all indexes from one already-validated Worker response. */
    public static void installAuthority(PreparedAuthority prepared) {
        if (prepared == null || prepared.snapshot == null) {
            throw new IllegalArgumentException("prepared carrier authority is required");
        }
        active = prepared.snapshot;
    }

    /** Resolves only an exact internal standard code. */
    public static Carrier resolve(String code) {
        return active.byInternalCode.get(normalizeCode(code));
    }

    /** Resolves only the table's exact normalized display-name namespace. */
    public static Carrier resolveName(String companyName) {
        return active.byName.get(normalizeName(companyName));
    }

    /** Resolves an upstream raw cpCode, including the table's explicit prefix rules. */
    public static Carrier resolveCpCode(String code) {
        Snapshot snapshot = active;
        String normalizedCode = normalizeCode(code);
        for (Map.Entry<String, Carrier> candidate : snapshot.byPrefix.entrySet()) {
            if (normalizedCode.startsWith(candidate.getKey())) return candidate.getValue();
        }
        return snapshot.byRawCpCode.get(normalizedCode);
    }

    /** Resolves only K100's canonical code namespace and its explicit reverse aliases. */
    public static Carrier resolveKuaidi100Code(String code) {
        return active.byKuaidi100Code.get(normalizeCode(code));
    }

    public static String companyNameFromCpCode(String code, String fallback) {
        Carrier carrier = resolveCpCode(code);
        if (carrier == null) carrier = resolveName(fallback);
        return carrier == null ? clean(fallback) : carrier.companyName;
    }

    public static String companyNameFromKuaidi100Code(String code, String fallback) {
        Carrier carrier = resolveKuaidi100Code(code);
        if (carrier == null) carrier = resolveName(fallback);
        return carrier == null ? clean(fallback) : carrier.companyName;
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
        Carrier carrier = presentationCarrier(code, fallback);
        return carrier == null ? clean(fallback) : carrier.companyName;
    }

    /** User-visible name only; source identities and every outbound protocol stay untouched. */
    public static String displayName(String code, String fallback) {
        Carrier carrier = presentationCarrier(code, fallback);
        return carrier == null ? clean(fallback) : carrier.companyName;
    }

    public static String queryCode(String code, String companyName) {
        Carrier carrier = presentationCarrier(code, companyName);
        return carrier == null ? clean(code) : carrier.kuaidi100Code;
    }

    /** Official carrier hotline shown by Lite's local express detail header. */
    public static String hotline(String code, String companyName) {
        Carrier carrier = presentationCarrier(code, companyName);
        return carrier == null ? "" : carrier.hotline;
    }

    static int sizeForTesting() {
        return active.size;
    }

    static void resetForTesting() {
        active = BOOTSTRAP;
    }

    /** Validates Worker/cache metadata against the active authority without reclassifying. */
    public static boolean matchesBuiltInContract(CarrierNormalization normalization) {
        if (normalization == null || !Boolean.TRUE.equals(normalization.builtIn)
                || clean(normalization.standardCode).isEmpty()) return false;
        Carrier carrier = active.byInternalCode.get(normalizeCode(normalization.standardCode));
        if (carrier == null
                || !carrier.standardCode.equalsIgnoreCase(normalization.standardCode)) return false;
        if (!clean(normalization.displayName).isEmpty()
                && !carrier.companyName.equals(normalization.displayName)) return false;
        return clean(normalization.kuaidi100Code).isEmpty()
                || carrier.kuaidi100Code.equalsIgnoreCase(normalization.kuaidi100Code);
    }

    private static Snapshot buildSnapshot(List<Definition> definitions) {
        if (definitions == null || definitions.isEmpty()) {
            throw new IllegalArgumentException("carrier definitions are required");
        }
        LinkedHashMap<String, Carrier> internalCodes = new LinkedHashMap<>();
        LinkedHashMap<String, Carrier> rawCpCodes = new LinkedHashMap<>();
        LinkedHashMap<String, Carrier> kuaidi100Codes = new LinkedHashMap<>();
        HashSet<String> canonicalKuaidi100Codes = new HashSet<>();
        LinkedHashMap<String, Carrier> prefixes = new LinkedHashMap<>();
        HashMap<String, Carrier> names = new HashMap<>();
        HashSet<String> standards = new HashSet<>();

        for (Definition definition : definitions) {
            Carrier carrier = definition.carrier;
            String standard = normalizeCode(carrier.standardCode);
            if (!standards.add(standard)) {
                throw new IllegalArgumentException("duplicate carrier standard code");
            }
            putUniqueAlias(internalCodes, standard, carrier);
            putUniqueAlias(rawCpCodes, standard, carrier);
            String kuaidi100Code = normalizeCode(carrier.kuaidi100Code);
            putUniqueAlias(kuaidi100Codes, kuaidi100Code, carrier);
            canonicalKuaidi100Codes.add(kuaidi100Code);
        }
        for (Definition definition : definitions) {
            Carrier carrier = definition.carrier;
            for (String alias : definition.codeAliases) {
                putUniqueAlias(rawCpCodes, normalizeCode(alias), carrier);
            }
            for (String alias : definition.kuaidi100CodeAliases) {
                putKuaidi100Alias(
                        kuaidi100Codes, canonicalKuaidi100Codes,
                        normalizeCode(alias), carrier);
            }
            for (String prefix : definition.codePrefixAliases) {
                putUniquePrefix(prefixes, normalizeCode(prefix), carrier);
            }
            addName(names, carrier.companyName, carrier);
            for (String name : definition.nameAliases) {
                addName(names, name, carrier);
            }
        }
        return new Snapshot(
                internalCodes, rawCpCodes, kuaidi100Codes,
                prefixes, names, definitions.size());
    }

    private static Definition parseDefinition(JSONObject entry) {
        String standard = requiredMatching(entry, "standardCode", 32, STANDARD_CODE);
        String display = requiredString(entry, "displayName", 64);
        String kuaidi100 = requiredMatching(entry, "kuaidi100Code", 64, KUAIDI100_CODE);
        String hotline = requiredStringAllowEmpty(entry, "hotline", 20);
        if (!hotline.isEmpty() && !HOTLINE.matcher(hotline).matches()) {
            throw new IllegalArgumentException("carrier hotline is invalid");
        }
        String iconKey = requiredMatching(entry, "iconKey", 64, ICON_KEY);
        Object phoneTailValue = entry.opt("requiresPhoneTail");
        if (!(phoneTailValue instanceof Boolean)) {
            throw new IllegalArgumentException("carrier requiresPhoneTail is invalid");
        }
        boolean phoneTail = (Boolean) phoneTailValue;
        List<String> codeAliases = optionalArray(entry, "codeAliases", CODE_ALIAS, true);
        List<String> prefixes = optionalArray(entry, "codePrefixAliases", CODE_PREFIX, true);
        List<String> kuaidiAliases = optionalArray(
                entry, "kuaidi100CodeAliases", KUAIDI100_CODE, false);
        List<String> nameAliases = optionalNameArray(entry, "nameAliases");
        return new Definition(
                new Carrier(standard, display, kuaidi100, hotline,
                        iconForKey(iconKey), phoneTail),
                codeAliases, prefixes, kuaidiAliases, nameAliases);
    }

    private static void validateRequiredContract(Snapshot snapshot) {
        requireAlias(snapshot.byRawCpCode, "EYB", "EMS");
        requireAlias(snapshot.byRawCpCode, "JDLEX", "JD");
        requireAlias(snapshot.byRawCpCode, "JITU", "JTSD");
        requireAlias(snapshot.byRawCpCode, "KYE", "KYSY");
        requireAlias(snapshot.byRawCpCode, "DEBANGWULIU", "DBL");
        requireAlias(snapshot.byKuaidi100Code, "DEBANGWULIU", "DBL");
        Carrier htky = snapshot.byInternalCode.get("HTKY");
        if (htky == null || !"极兔速递".equals(htky.companyName)) {
            throw new IllegalArgumentException("HTKY presentation contract is invalid");
        }
        Carrier jdPrefix = snapshot.byPrefix.get("JD");
        if (jdPrefix == null || !"JD".equals(jdPrefix.standardCode)) {
            throw new IllegalArgumentException("JD prefix contract is invalid");
        }
    }

    private static void requireAlias(
            Map<String, Carrier> aliases, String alias, String expected) {
        Carrier carrier = aliases.get(alias);
        if (carrier == null || !expected.equals(carrier.standardCode)) {
            throw new IllegalArgumentException("required carrier alias is missing");
        }
    }

    private static void putUniqueAlias(
            Map<String, Carrier> aliases, String key, Carrier carrier) {
        if (key.isEmpty()) throw new IllegalArgumentException("carrier alias is empty");
        Carrier existing = aliases.putIfAbsent(key, carrier);
        if (existing != null && existing != carrier) {
            throw new IllegalArgumentException("carrier alias is ambiguous");
        }
    }

    private static void putKuaidi100Alias(
            Map<String, Carrier> aliases, Set<String> canonicalCodes,
            String key, Carrier carrier) {
        if (key.isEmpty()) throw new IllegalArgumentException("carrier alias is empty");
        // Canonical K100 codes are installed first and can never be displaced by an alias.
        Carrier existing = aliases.get(key);
        if (existing == null) {
            aliases.put(key, carrier);
        } else if (existing != carrier && !canonicalCodes.contains(key)) {
            throw new IllegalArgumentException("carrier K100 alias is ambiguous");
        }
    }

    private static void putUniquePrefix(
            Map<String, Carrier> prefixes, String key, Carrier carrier) {
        if (key.isEmpty()) throw new IllegalArgumentException("carrier prefix is empty");
        for (Map.Entry<String, Carrier> existing : prefixes.entrySet()) {
            if (existing.getValue() != carrier
                    && (existing.getKey().startsWith(key)
                    || key.startsWith(existing.getKey()))) {
                throw new IllegalArgumentException("carrier prefixes overlap");
            }
        }
        Carrier existing = prefixes.putIfAbsent(key, carrier);
        if (existing != null && existing != carrier) {
            throw new IllegalArgumentException("carrier prefix is ambiguous");
        }
    }

    private static void addName(Map<String, Carrier> names, String name, Carrier carrier) {
        String key = normalizeName(name);
        if (!key.isEmpty()) names.putIfAbsent(key, carrier);
    }

    private static List<String> optionalArray(
            JSONObject entry, String key, Pattern pattern, boolean uppercase) {
        if (!entry.has(key)) return List.of();
        Object value = entry.opt(key);
        if (!(value instanceof JSONArray)) {
            throw new IllegalArgumentException("carrier alias list is invalid");
        }
        JSONArray array = (JSONArray) value;
        if (array.length() > 64) throw new IllegalArgumentException("carrier alias list is too large");
        ArrayList<String> result = new ArrayList<>(array.length());
        HashSet<String> unique = new HashSet<>();
        for (int index = 0; index < array.length(); index++) {
            Object raw = array.opt(index);
            if (!(raw instanceof String)) {
                throw new IllegalArgumentException("carrier alias is invalid");
            }
            String alias = clean((String) raw);
            if (alias.isEmpty() || alias.length() > 64 || containsControl(alias)
                    || !pattern.matcher(alias).matches()
                    || (uppercase && !alias.equals(alias.toUpperCase(Locale.ROOT)))) {
                throw new IllegalArgumentException("carrier alias is invalid");
            }
            String normalized = alias.toUpperCase(Locale.ROOT);
            if (!unique.add(normalized)) {
                throw new IllegalArgumentException("duplicate carrier alias");
            }
            result.add(alias);
        }
        return List.copyOf(result);
    }

    private static List<String> optionalNameArray(JSONObject entry, String key) {
        if (!entry.has(key)) return List.of();
        Object value = entry.opt(key);
        if (!(value instanceof JSONArray)) {
            throw new IllegalArgumentException("carrier name alias list is invalid");
        }
        JSONArray array = (JSONArray) value;
        if (array.length() > 64) {
            throw new IllegalArgumentException("carrier name alias list is too large");
        }
        ArrayList<String> result = new ArrayList<>(array.length());
        HashSet<String> unique = new HashSet<>();
        for (int index = 0; index < array.length(); index++) {
            Object raw = array.opt(index);
            if (!(raw instanceof String)) {
                throw new IllegalArgumentException("carrier name alias is invalid");
            }
            String alias = clean((String) raw);
            String normalized = normalizeName(alias);
            if (alias.isEmpty() || alias.length() > 64 || containsControl(alias)
                    || !unique.add(normalized)) {
                throw new IllegalArgumentException("carrier name alias is invalid");
            }
            result.add(alias);
        }
        return List.copyOf(result);
    }

    private static String requiredMatching(
            JSONObject object, String key, int maxLength, Pattern pattern) {
        String value = requiredString(object, key, maxLength);
        if (!pattern.matcher(value).matches()) {
            throw new IllegalArgumentException("carrier field is invalid");
        }
        return value;
    }

    private static String requiredString(JSONObject object, String key, int maxLength) {
        String value = requiredStringAllowEmpty(object, key, maxLength);
        if (value.isEmpty()) throw new IllegalArgumentException("carrier field is empty");
        return value;
    }

    private static String requiredStringAllowEmpty(
            JSONObject object, String key, int maxLength) {
        Object raw = object.opt(key);
        if (!(raw instanceof String)) throw new IllegalArgumentException("carrier field is invalid");
        String value = clean((String) raw);
        if (value.length() > maxLength || containsControl(value)) {
            throw new IllegalArgumentException("carrier field is invalid");
        }
        return value;
    }

    private static boolean containsControl(String value) {
        for (int index = 0; index < value.length(); index++) {
            if (Character.isISOControl(value.charAt(index))) return true;
        }
        return false;
    }

    private static Carrier presentationCarrier(String code, String companyName) {
        Carrier carrier = resolveCpCode(code);
        return carrier == null ? resolveName(companyName) : carrier;
    }

    private static String normalizeCode(String value) {
        return clean(value).toUpperCase(Locale.ROOT);
    }

    private static String normalizeName(String value) {
        return clean(value).replaceAll("\\s+", "").toUpperCase(Locale.ROOT);
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    private static int iconForKey(String key) {
        return switch (key) {
            case "sf" -> R.drawable.sf;
            case "zto" -> R.drawable.zto;
            case "yto" -> R.drawable.yto;
            case "sto" -> R.drawable.sto;
            case "yd" -> R.drawable.yd;
            case "jd" -> R.drawable.jd;
            case "ems" -> R.drawable.ems;
            case "yzpy" -> R.drawable.yzpy;
            case "jtsd" -> R.drawable.jtsd;
            case "dbl" -> R.drawable.dbl;
            case "kysy" -> R.drawable.kysy;
            case "zjs" -> R.drawable.zjs;
            case "uc" -> R.drawable.uc;
            case "danniao" -> R.drawable.danniao;
            default -> R.drawable.ic_card_express_cp_default;
        };
    }

    private static Definition definition(
            String code, String name, String kuaidi100, String hotline, String iconKey,
            boolean phoneTail, List<String> aliases, List<String> prefixes,
            List<String> kuaidiAliases, List<String> nameAliases) {
        return new Definition(
                new Carrier(code, name, kuaidi100, hotline, iconForKey(iconKey), phoneTail),
                aliases, prefixes, kuaidiAliases, nameAliases);
    }

    private static List<Definition> bootstrapDefinitions() {
        return List.of(
                definition("SF", "顺丰速运", "shunfeng", "95338", "sf", true,
                        List.of("SFEXPRESS", "SHUNFENG"), List.of(), List.of(),
                        List.of("顺丰", "顺丰快递")),
                definition("ZTO", "中通快递", "zhongtong", "95311", "zto", true,
                        List.of("ZHONGTONG"), List.of(), List.of(), List.of("中通")),
                definition("ZTOKY", "中通快运", "zhongtongkuaiyun", "", "zto", false,
                        List.of(), List.of(), List.of(), List.of()),
                definition("YTO", "圆通速递", "yuantong", "95554", "yto", false,
                        List.of("YUANTONG"), List.of(), List.of(), List.of("圆通", "圆通快递")),
                definition("STO", "申通快递", "shentong", "95543", "sto", false,
                        List.of("SHENTONG"), List.of(), List.of(), List.of("申通")),
                definition("YD", "韵达快递", "yunda", "95546", "yd", false,
                        List.of("YUNDA"), List.of(), List.of(), List.of("韵达", "韵达速递")),
                definition("JD", "京东快递", "jd", "950616", "jd", true,
                        List.of("JDKD", "JINGDONG", "JDLEX"), List.of("JD"), List.of(),
                        List.of("京东", "京东物流", "京东快递")),
                definition("JDKY", "京东快运", "jingdongkuaiyun", "950616", "jd", false,
                        List.of(), List.of(), List.of(), List.of()),
                definition("EMS", "EMS", "ems", "11183", "ems", false,
                        List.of("EYB"), List.of(), List.of(), List.of("邮政EMS", "邮政特快")),
                definition("YZPY", "邮政快递", "youzhengguonei", "11183", "yzpy", false,
                        List.of("POST", "POSTB", "CHINAPOST", "YOUZHENGGUONEI", "YOUZHENGBK"),
                        List.of(), List.of(),
                        List.of("邮政", "邮政快递包裹", "邮政国内标准", "中国邮政", "邮政包裹", "包裹信件")),
                definition("JTSD", "极兔速递", "jtexpress", "956025", "jtsd", false,
                        List.of("JT", "J&T", "JTEXPRESS", "JITU"), List.of(), List.of(),
                        List.of("极兔")),
                definition("HTKY", "极兔速递", "huitongkuaidi", "", "jtsd", false,
                        List.of("BEST", "BESTQJT", "HUITONGKUAIDI"), List.of(), List.of(),
                        List.of("百世", "百世快递", "汇通")),
                definition("DBL", "德邦快递", "debangkuaidi", "95353", "dbl", false,
                        List.of("DBKD", "DEBANGKUAIDI", "DEBANGWULIU"), List.of(),
                        List.of("debangwuliu"), List.of("德邦", "德邦物流")),
                definition("KYSY", "跨越速运", "kuayue", "95324", "kysy", true,
                        List.of("KY", "KUAYUE", "KYE"), List.of(), List.of(), List.of("跨越")),
                definition("ZJS", "宅急送", "zhaijisong", "4006789000", "zjs", false,
                        List.of("ZHAIJISONG"), List.of(), List.of(), List.of()),
                definition("UC", "优速快递", "youshuwuliu", "", "uc", false,
                        List.of("YOUSHUWULIU"), List.of(), List.of(), List.of("优速")),
                definition("DANNIAO", "丹鸟速递", "danniao", "", "danniao", false,
                        List.of("ZMKM", "ZMKMKD"), List.of(), List.of(),
                        List.of("丹鸟", "丹鸟快递", "菜鸟速递", "菜鸟直送", "菜鸟直送(丹鸟)",
                                "菜鸟直送（丹鸟）")));
    }
}
