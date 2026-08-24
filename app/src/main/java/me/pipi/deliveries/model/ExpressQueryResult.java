package me.pipi.deliveries.model;

/** Source-neutral result produced by a provider adapter before repository arbitration. */
public final class ExpressQueryResult {
    public final String waybill;
    public final String courierCode;
    public final String companyName;
    public final StatusSemantic semantic;
    /** Provider-owned event time for {@link #semantic}; independent from the headline time. */
    public final long statusEventTime;
    public final String latestTime;
    public final String latestDetail;
    public final String tracksJson;
    public final String detailUrl;
    public final String phone;
    /** Local timeline provider; empty for account/discovery sources. */
    public final String timelineProvider;
    /** Source interface that supplied the automatic Cainiao detail route. */
    public final String routeInterface;
    /** Complete provider-returned detail route; encrypted before it is persisted. */
    public final String routeCredential;
    /** Exact upstream provider value carried by an account-source record. */
    public final String sourceProvider;

    public ExpressQueryResult(
            String waybill, String courierCode, String companyName,
            StatusSemantic semantic, String latestTime,
            String latestDetail, String tracksJson) {
        this(waybill, courierCode, companyName, semantic, latestTime,
                latestDetail, tracksJson, "", "", "");
    }

    public ExpressQueryResult(
            String waybill, String courierCode, String companyName,
            StatusSemantic semantic, String latestTime,
            String latestDetail, String tracksJson, String detailUrl) {
        this(waybill, courierCode, companyName, semantic, latestTime,
                latestDetail, tracksJson, detailUrl, "", "");
    }

    public ExpressQueryResult(
            String waybill, String courierCode, String companyName,
            StatusSemantic semantic, String latestTime,
            String latestDetail, String tracksJson, String detailUrl, String phone) {
        this(waybill, courierCode, companyName, semantic, latestTime,
                latestDetail, tracksJson, detailUrl, phone, "");
    }

    public ExpressQueryResult(
            String waybill, String courierCode, String companyName,
            StatusSemantic semantic, String latestTime,
            String latestDetail, String tracksJson, String detailUrl, String phone,
            String timelineProvider) {
        this(waybill, courierCode, companyName, semantic, latestTime, latestDetail,
                tracksJson, detailUrl, phone, timelineProvider, "", "");
    }

    public ExpressQueryResult(
            String waybill, String courierCode, String companyName,
            StatusSemantic semantic, String latestTime,
            String latestDetail, String tracksJson, String detailUrl, String phone,
            String timelineProvider, String routeInterface, String routeCredential) {
        this(waybill, courierCode, companyName, semantic, latestTime, latestDetail,
                tracksJson, detailUrl, phone, timelineProvider, routeInterface,
                routeCredential, "");
    }

    public ExpressQueryResult(
            String waybill, String courierCode, String companyName,
            StatusSemantic semantic, String latestTime,
            String latestDetail, String tracksJson, String detailUrl, String phone,
            String timelineProvider, String routeInterface, String routeCredential,
            String sourceProvider) {
        this(waybill, courierCode, companyName, semantic, 0L, latestTime,
                latestDetail, tracksJson, detailUrl, phone, timelineProvider,
                routeInterface, routeCredential, sourceProvider);
    }

    public ExpressQueryResult(
            String waybill, String courierCode, String companyName,
            StatusSemantic semantic, long statusEventTime, String latestTime,
            String latestDetail, String tracksJson, String detailUrl, String phone,
            String timelineProvider, String routeInterface, String routeCredential,
            String sourceProvider) {
        this.waybill = clean(waybill);
        this.courierCode = clean(courierCode);
        this.companyName = clean(companyName);
        this.semantic = semantic == null ? StatusSemantic.UNKNOWN : semantic;
        this.statusEventTime = Math.max(0L, statusEventTime);
        this.latestTime = clean(latestTime);
        this.latestDetail = clean(latestDetail);
        String tracks = clean(tracksJson);
        this.tracksJson = tracks.isEmpty() ? "[]" : tracks;
        this.detailUrl = clean(detailUrl);
        this.phone = clean(phone);
        this.timelineProvider = clean(timelineProvider).toLowerCase(java.util.Locale.ROOT);
        this.routeInterface = clean(routeInterface).toLowerCase(java.util.Locale.ROOT);
        this.routeCredential = clean(routeCredential);
        this.sourceProvider = clean(sourceProvider);
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
