package me.pipi.deliveries.model;

/** A manually entered waybill kept out of the visible list until K100 returns a real event. */
public final class PendingExpressQuery {
    public final String waybill;
    public final String courierCode;
    public final String companyName;
    public final String phone;
    public final String bindingSource;
    public final String detailUrl;
    public final String routeInterface;
    public final String routeCredential;
    public final long createdAt;
    public final long lastAttemptAt;

    public PendingExpressQuery(
            String waybill, String courierCode, String companyName, String phone,
            String bindingSource, String detailUrl, String routeInterface, String routeCredential,
            long createdAt, long lastAttemptAt) {
        this.waybill = clean(waybill);
        this.courierCode = clean(courierCode);
        this.companyName = clean(companyName);
        this.phone = clean(phone);
        this.bindingSource = "interface5".equalsIgnoreCase(clean(bindingSource))
                ? "interface5" : "interface6";
        this.detailUrl = clean(detailUrl);
        this.routeInterface = clean(routeInterface);
        this.routeCredential = clean(routeCredential);
        this.createdAt = createdAt;
        this.lastAttemptAt = lastAttemptAt;
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
