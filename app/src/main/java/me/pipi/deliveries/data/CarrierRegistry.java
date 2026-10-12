package me.pipi.deliveries.data;

import android.content.Context;
import android.net.Uri;

import me.pipi.deliveries.BuildConfig;
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
    private static final boolean BETA_BOOTSTRAP =
            "https://beta.pipiassistant.app".equals(BuildConfig.EXPRESS_GATEWAY_URL);
    public static final String AUTHORITY_VERSION = bootstrapVersion(BETA_BOOTSTRAP);
    public static final String AUTHORITY_SOURCE = "embedded-transition";

    /*
     * Audit C5 (user 2026-09-25): one validation contract with the Worker and Pipi, shared fixture
     * carrier-table-validation.v1.json. It checks structure, field types and namespace conflicts
     * only (BUILTIN_CARRIERS_FINAL §三, EXPRESS_OWNERSHIP_PLAN §4.2), never table content, so a
     * legitimate table edit (a hotline written with hyphens, a renamed carrier, a removed alias) is
     * never refused and Lite does not stay behind on an old table.
     */
    private static final Pattern STANDARD_CODE = Pattern.compile("[A-Z0-9]{2,16}");
    private static final Pattern CODE_PREFIX = Pattern.compile("[A-Z0-9]{1,16}");
    private static final Pattern KUAIDI100_CODE = Pattern.compile("[a-z0-9_-]{1,32}");
    private static final Pattern ICON_KEY = Pattern.compile("[a-z0-9_-]{1,32}");
    private static final Pattern AUTHORITY_VERSION_PATTERN =
            Pattern.compile("[A-Za-z0-9._-]{1,128}");
    private static final int MAXIMUM_SOURCE_LENGTH = 128;
    private static final int MAXIMUM_NAME_LENGTH = 64;
    private static final int MAXIMUM_HOTLINE_LENGTH = 32;
    private static final int MAXIMUM_ALIASES_PER_FIELD = 64;

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
        final String iconKey;
        final List<String> codeAliases;
        final List<String> codePrefixAliases;
        final List<String> kuaidi100CodeAliases;
        final List<String> nameAliases;

        Definition(
                Carrier value, String icon, List<String> aliases, List<String> prefixes,
                List<String> kuaidiAliases, List<String> names) {
            carrier = value;
            iconKey = icon;
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
        final ExpressStatusLabels statusLabels;

        Snapshot(
                Map<String, Carrier> internalCodes,
                Map<String, Carrier> rawCpCodes,
                Map<String, Carrier> kuaidi100Codes,
                Map<String, Carrier> prefixes, Map<String, Carrier> names, int count,
                ExpressStatusLabels labels) {
            byInternalCode = Collections.unmodifiableMap(internalCodes);
            byRawCpCode = Collections.unmodifiableMap(rawCpCodes);
            byKuaidi100Code = Collections.unmodifiableMap(kuaidi100Codes);
            byPrefix = Collections.unmodifiableMap(prefixes);
            byName = Collections.unmodifiableMap(names);
            size = count;
            statusLabels = labels;
        }
    }

    private static final Snapshot BOOTSTRAP =
            buildSnapshot(bootstrapDefinitions(BETA_BOOTSTRAP), ExpressStatusLabels.bundled());
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
        Object version = root.opt("version");
        if (!(version instanceof String)
                || !AUTHORITY_VERSION_PATTERN.matcher((String) version).matches()) {
            throw new IllegalArgumentException("carrier authority version is invalid");
        }
        if (requiredString(root, "source").length() > MAXIMUM_SOURCE_LENGTH) {
            throw new IllegalArgumentException("carrier authority source is too long");
        }
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
        // `version` identifies the carrier entries; the status label table rides along (audit L5).
        // A Worker that does not serve it yet keeps the bundled table; a malformed one rejects the
        // payload like any other malformed field.
        ExpressStatusLabels statusLabels = root.has("statusLabels")
                ? ExpressStatusLabels.parse(root.opt("statusLabels"))
                : ExpressStatusLabels.bundled();
        return new PreparedAuthority(buildSnapshot(definitions, statusLabels));
    }

    /** Atomically publishes all indexes from one already-validated Worker response. */
    public static void installAuthority(PreparedAuthority prepared) {
        if (prepared == null || prepared.snapshot == null) {
            throw new IllegalArgumentException("prepared carrier authority is required");
        }
        active = prepared.snapshot;
    }

    /** The status label table of the active snapshot (audit L5); the bundled copy until one is served. */
    public static ExpressStatusLabels statusLabels() {
        return active.statusLabels;
    }

    /** Resolves only an exact internal standard code. */
    public static Carrier resolve(String code) {
        return active.byInternalCode.get(normalizeCode(code));
    }

    /**
     * A projected order's stored carrier (audit C6, user 2026-09-25): recognition stores the exact
     * standard code, so 汇通 (HTKY, shown as 极兔速递 by its own table row) keeps its identity and its
     * Kuaidi100 code; carriers captured from a projection page are stored by name as before.
     */
    public static Carrier resolveProjected(String stored) {
        Carrier byCode = resolve(stored);
        return byCode != null ? byCode : resolveName(stored);
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

    /**
     * The bundled startup snapshot in the Worker's entry shape (audit C12): tests compare it with the
     * served table in the shared fixture, so this hand copy cannot drift from the Worker's.
     */
    static JSONArray bootstrapEntriesForTesting() throws org.json.JSONException {
        return bootstrapEntriesForTesting(BETA_BOOTSTRAP);
    }

    static JSONArray bootstrapEntriesForTesting(boolean beta) throws org.json.JSONException {
        JSONArray entries = new JSONArray();
        for (Definition definition : bootstrapDefinitions(beta)) {
            Carrier carrier = definition.carrier;
            JSONObject entry = new JSONObject()
                    .put("standardCode", carrier.standardCode)
                    .put("displayName", carrier.companyName)
                    .put("kuaidi100Code", carrier.kuaidi100Code)
                    .put("hotline", carrier.hotline)
                    .put("iconKey", definition.iconKey)
                    .put("codeAliases", new JSONArray(definition.codeAliases))
                    .put("nameAliases", new JSONArray(definition.nameAliases))
                    .put("requiresPhoneTail", carrier.requiresPhoneTail);
            if (!definition.kuaidi100CodeAliases.isEmpty()) {
                entry.put("kuaidi100CodeAliases", new JSONArray(definition.kuaidi100CodeAliases));
            }
            if (!definition.codePrefixAliases.isEmpty()) {
                entry.put("codePrefixAliases", new JSONArray(definition.codePrefixAliases));
            }
            entries.put(entry);
        }
        return entries;
    }

    static String bootstrapVersion(boolean beta) {
        return beta
                ? "b6009e8d0a72f68005d3fcc8139b19aeb7113df0751e3db45744632406d525f9"
                : "b6009e8d0a72f68005d3fcc8139b19aeb7113df0751e3db45744632406d525f9";
    }

    static int sizeForTesting() {
        return active.size;
    }

    static void resetForTesting() {
        active = BOOTSTRAP;
    }

    private static Snapshot buildSnapshot(
            List<Definition> definitions, ExpressStatusLabels statusLabels) {
        if (definitions == null || definitions.isEmpty()) {
            throw new IllegalArgumentException("carrier definitions are required");
        }
        LinkedHashMap<String, Carrier> internalCodes = new LinkedHashMap<>();
        LinkedHashMap<String, Carrier> rawCpCodes = new LinkedHashMap<>();
        LinkedHashMap<String, Carrier> kuaidi100Codes = new LinkedHashMap<>();
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
        }
        for (Definition definition : definitions) {
            Carrier carrier = definition.carrier;
            for (String alias : definition.codeAliases) {
                putUniqueAlias(rawCpCodes, normalizeCode(alias), carrier);
            }
            for (String alias : definition.kuaidi100CodeAliases) {
                putKuaidi100Alias(kuaidi100Codes, normalizeCode(alias), carrier);
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
                prefixes, names, definitions.size(), statusLabels);
    }

    private static Definition parseDefinition(JSONObject entry) {
        String standard = requiredString(entry, "standardCode");
        if (!STANDARD_CODE.matcher(standard).matches()) {
            throw new IllegalArgumentException("carrier standardCode is invalid");
        }
        String display = requiredString(entry, "displayName");
        if (display.length() > MAXIMUM_NAME_LENGTH) {
            throw new IllegalArgumentException("carrier displayName is too long");
        }
        String kuaidi100 = requiredString(entry, "kuaidi100Code");
        if (!KUAIDI100_CODE.matcher(kuaidi100).matches()) {
            throw new IllegalArgumentException("carrier kuaidi100Code is invalid");
        }
        Object rawHotline = entry.opt("hotline");
        if (!(rawHotline instanceof String)
                || ((String) rawHotline).length() > MAXIMUM_HOTLINE_LENGTH) {
            throw new IllegalArgumentException("carrier hotline is invalid");
        }
        String hotline = clean((String) rawHotline);
        String iconKey = requiredString(entry, "iconKey");
        if (!ICON_KEY.matcher(iconKey).matches()) {
            throw new IllegalArgumentException("carrier iconKey is invalid");
        }
        Object phoneTailValue = entry.opt("requiresPhoneTail");
        if (!(phoneTailValue instanceof Boolean)) {
            throw new IllegalArgumentException("carrier requiresPhoneTail is invalid");
        }
        boolean phoneTail = (Boolean) phoneTailValue;
        List<String> codeAliases = requiredArray(entry, "codeAliases", MAXIMUM_NAME_LENGTH);
        List<String> nameAliases = requiredArray(entry, "nameAliases", MAXIMUM_NAME_LENGTH);
        List<String> kuaidiAliases = optionalArray(entry, "kuaidi100CodeAliases", 32);
        for (String alias : kuaidiAliases) {
            if (!KUAIDI100_CODE.matcher(alias).matches()) {
                throw new IllegalArgumentException("carrier kuaidi100 alias is invalid");
            }
        }
        List<String> prefixes = optionalArray(entry, "codePrefixAliases", 16);
        for (String prefix : prefixes) {
            if (!CODE_PREFIX.matcher(prefix.toUpperCase(Locale.ROOT)).matches()) {
                throw new IllegalArgumentException("carrier code prefix is invalid");
            }
        }
        return new Definition(
                new Carrier(standard, display, kuaidi100, hotline,
                        iconForKey(iconKey), phoneTail),
                iconKey, codeAliases, prefixes, kuaidiAliases, nameAliases);
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
            Map<String, Carrier> aliases, String key, Carrier carrier) {
        if (key.isEmpty()) throw new IllegalArgumentException("carrier alias is empty");
        // Canonical K100 codes are installed first; an alias naming another carrier's code (or
        // another carrier's alias) is a namespace conflict that rejects the whole table.
        Carrier existing = aliases.get(key);
        if (existing == null) {
            aliases.put(key, carrier);
        } else if (existing != carrier) {
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

    private static List<String> requiredArray(JSONObject entry, String key, int maximumLength) {
        if (!entry.has(key)) throw new IllegalArgumentException("carrier alias list is required");
        return stringArray(entry.opt(key), maximumLength);
    }

    private static List<String> optionalArray(JSONObject entry, String key, int maximumLength) {
        return entry.has(key) ? stringArray(entry.opt(key), maximumLength) : List.of();
    }

    private static List<String> stringArray(Object value, int maximumLength) {
        if (!(value instanceof JSONArray)) {
            throw new IllegalArgumentException("carrier alias list is invalid");
        }
        JSONArray array = (JSONArray) value;
        if (array.length() > MAXIMUM_ALIASES_PER_FIELD) {
            throw new IllegalArgumentException("carrier alias list is too large");
        }
        ArrayList<String> result = new ArrayList<>(array.length());
        for (int index = 0; index < array.length(); index++) {
            Object raw = array.opt(index);
            if (!(raw instanceof String) || clean((String) raw).isEmpty()
                    || clean((String) raw).length() > maximumLength) {
                throw new IllegalArgumentException("carrier alias is invalid");
            }
            result.add(clean((String) raw));
        }
        return List.copyOf(result);
    }

    private static String requiredString(JSONObject object, String key) {
        Object raw = object.opt(key);
        if (!(raw instanceof String)) throw new IllegalArgumentException("carrier field is invalid");
        String value = clean((String) raw);
        if (value.isEmpty()) throw new IllegalArgumentException("carrier field is empty");
        return value;
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
                iconKey, aliases, prefixes, kuaidiAliases, nameAliases);
    }

    private static List<Definition> bootstrapDefinitions(boolean beta) {
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
                        // Formal promotion keeps the approved reverse alias in both startup tracks.
                        List.of(), List.of("youzhengbk"),
                        List.of("邮政", "邮政快递包裹", "中国邮政", "邮政国内标准", "邮政包裹", "包裹信件")),
                definition("JTSD", "极兔速递", "jtexpress", "956025", "jtsd", false,
                        List.of("JT", "J&T", "JTEXPRESS", "JITU"), List.of(), List.of(),
                        List.of("极兔")),
                definition("HTKY", "极兔速递", "huitongkuaidi", "956025", "jtsd", false,
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
