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

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
