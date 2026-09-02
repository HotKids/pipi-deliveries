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
    /** Display-only normalization; raw courierCode/companyName stay provider-owned. */
    public final CarrierNormalization carrierNormalization;
    /** Provider-originated carrier evidence used only by the automatic ownership gate. */
    public final boolean carrierIdentityEvidence;
    /** Provider-owned coarse status text, independent from normalized status semantics. */
    public final String statusDescription;
    /** True only when an adapter observed an explicit provider status enum/code. */
    public final boolean structuredStatusEvidence;

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
        this(waybill, courierCode, companyName, semantic, statusEventTime, latestTime,
                latestDetail, tracksJson, detailUrl, phone, timelineProvider,
                routeInterface, routeCredential, sourceProvider, CarrierNormalization.NONE);
    }

    public ExpressQueryResult(
            String waybill, String courierCode, String companyName,
            StatusSemantic semantic, long statusEventTime, String latestTime,
            String latestDetail, String tracksJson, String detailUrl, String phone,
            String timelineProvider, String routeInterface, String routeCredential,
            String sourceProvider, CarrierNormalization carrierNormalization) {
        this(waybill, courierCode, companyName, semantic, statusEventTime, latestTime,
                latestDetail, tracksJson, detailUrl, phone, timelineProvider,
                routeInterface, routeCredential, sourceProvider, carrierNormalization,
                !clean(courierCode).isEmpty(),
                semantic == null ? "" : semantic.label, false);
    }

    private ExpressQueryResult(
            String waybill, String courierCode, String companyName,
            StatusSemantic semantic, long statusEventTime, String latestTime,
            String latestDetail, String tracksJson, String detailUrl, String phone,
            String timelineProvider, String routeInterface, String routeCredential,
            String sourceProvider, CarrierNormalization carrierNormalization,
            boolean carrierIdentityEvidence, String statusDescription,
            boolean structuredStatusEvidence) {
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
        this.carrierNormalization = carrierNormalization == null
                ? CarrierNormalization.NONE : carrierNormalization;
        this.carrierIdentityEvidence = carrierIdentityEvidence;
        String coarseStatus = clean(statusDescription);
        this.statusDescription = coarseStatus.isEmpty() ? this.semantic.label : coarseStatus;
        this.structuredStatusEvidence = structuredStatusEvidence;
    }

    public ExpressQueryResult withCarrierNormalization(CarrierNormalization value) {
        return new ExpressQueryResult(
                waybill, courierCode, companyName, semantic, statusEventTime,
                latestTime, latestDetail, tracksJson, detailUrl, phone,
                timelineProvider, routeInterface, routeCredential, sourceProvider, value,
                carrierIdentityEvidence, statusDescription, structuredStatusEvidence);
    }

    /** Marks a carrier name captured from the same provider's projection page as raw evidence. */
    public ExpressQueryResult withProjectedCarrierEvidence(String carrierName) {
        String evidence = clean(carrierName);
        if (!containsHan(evidence)) return this;
        return new ExpressQueryResult(
                waybill, courierCode, evidence, semantic, statusEventTime,
                latestTime, latestDetail, tracksJson, detailUrl, phone,
                timelineProvider, routeInterface, routeCredential, sourceProvider,
                carrierNormalization, true, statusDescription, structuredStatusEvidence);
    }

    /** Marks a Chinese company name read directly from the current provider response. */
    public ExpressQueryResult withRawCarrierNameEvidence(String rawCompanyName) {
        if (!containsHan(rawCompanyName)) return this;
        return withCarrierIdentityEvidence(true);
    }

    /** Preserves already-validated carrier provenance when an adapter copies a result. */
    public ExpressQueryResult withCarrierIdentityEvidence(boolean present) {
        if (carrierIdentityEvidence == present) return this;
        return new ExpressQueryResult(
                waybill, courierCode, companyName, semantic, statusEventTime,
                latestTime, latestDetail, tracksJson, detailUrl, phone,
                timelineProvider, routeInterface, routeCredential, sourceProvider,
                carrierNormalization, present, statusDescription, structuredStatusEvidence);
    }

    public ExpressQueryResult withManualStatusEvidence(
            String coarseStatus, boolean structured) {
        return new ExpressQueryResult(
                waybill, courierCode, companyName, semantic, statusEventTime,
                latestTime, latestDetail, tracksJson, detailUrl, phone,
                timelineProvider, routeInterface, routeCredential, sourceProvider,
                carrierNormalization, carrierIdentityEvidence, coarseStatus, structured);
    }

    private static boolean containsHan(String value) {
        String clean = clean(value);
        for (int index = 0; index < clean.length(); index++) {
            Character.UnicodeScript script = Character.UnicodeScript.of(clean.charAt(index));
            if (script == Character.UnicodeScript.HAN) return true;
        }
        return false;
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
