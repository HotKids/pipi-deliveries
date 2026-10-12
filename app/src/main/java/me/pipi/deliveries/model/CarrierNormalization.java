package me.pipi.deliveries.model;

/** Display-only carrier metadata returned by the shared sync normalization contract. */
public final class CarrierNormalization {
    public static final CarrierNormalization NONE = new CarrierNormalization(
            "", "", "", null, "");

    public final String standardCode;
    public final String displayName;
    public final String kuaidi100Code;
    /** Null means the Worker did not include a built-in-table decision. */
    public final Boolean builtIn;
    public final String tableVersion;

    public CarrierNormalization(
            String standardCode, String displayName, String kuaidi100Code,
            Boolean builtIn, String tableVersion) {
        this.standardCode = clean(standardCode);
        this.displayName = clean(displayName);
        this.kuaidi100Code = clean(kuaidi100Code);
        this.builtIn = builtIn;
        this.tableVersion = clean(tableVersion);
    }

    public boolean present() {
        return builtIn != null || !standardCode.isEmpty() || !displayName.isEmpty()
                || !kuaidi100Code.isEmpty() || !tableVersion.isEmpty();
    }

    public boolean recognized() {
        return Boolean.TRUE.equals(builtIn)
                && (!standardCode.isEmpty() || !displayName.isEmpty()
                || !kuaidi100Code.isEmpty());
    }

    /**
     * 表外承运商（用户 2026-09-26，其余裁决 29）：快递100 免费识别认得出、内置表换不出标准码时它给的名字。只作显示：
     * 没有标准码、不进表、没有专属图标。Worker 的表外结果从不带名字（builtIn=false 时 displayName 为空），所以
     * 「非内置 + 有名字」只会是客户端自己的识别结果。
     */
    public static CarrierNormalization offTable(String displayName, String kuaidi100Code) {
        return new CarrierNormalization("", displayName, kuaidi100Code, false, "");
    }

    /** The Kuaidi100 name of an off-table recognition; "" for anything else. */
    public String offTableName() {
        return Boolean.FALSE.equals(builtIn) && standardCode.isEmpty() ? displayName : "";
    }

    /** Marker version of {@link #exhausted()}; never a Worker table version. */
    static final String EXHAUSTED_VERSION = "client-recognition-exhausted";

    /**
     * T23 细则（用户 2026-09-26，其余裁决 32）：识别进入终态（连续 3 次失败，或付费级明确认不出）且快递100 没给名字。
     * 这一行不再无限期挂着：挂起的通知照常放行，承运商位置显示原始承运商码。只是本机记下的结论，不是承运商。
     */
    public static CarrierNormalization exhausted() {
        return new CarrierNormalization("", "", "", false, EXHAUSTED_VERSION);
    }

    public boolean recognitionExhausted() {
        return Boolean.FALSE.equals(builtIn) && standardCode.isEmpty() && displayName.isEmpty()
                && kuaidi100Code.isEmpty() && EXHAUSTED_VERSION.equals(tableVersion);
    }

    /** A verdict this client reached itself: a built-in carrier, an off-table name, or exhaustion. */
    public boolean localOutcome() {
        return recognized() || !offTableName().isEmpty() || recognitionExhausted();
    }

    /**
     * The projection carrier stored for an order whose parcel's carrier recognition is exhausted
     * (其余裁决 32). Never a name or a code: it shows the order's raw carrier code instead.
     */
    public static final String PROJECTION_EXHAUSTED = "#carrier-unrecognized";

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
