package me.pipi.deliveries.model;

import me.pipi.deliveries.R;
import me.pipi.deliveries.data.CarrierRegistry;

/** Immutable shipment record projected from the local server_express table. */
public final class ExpressItem {
    public final long rowId;
    public final String phone;
    public final String waybill;
    public final String courierCode;
    public final String companyName;
    public final StatusSemantic semantic;
    public final String statusDescription;
    public final String latestDetail;
    public final String latestTime;
    public final String tracksJson;
    public final String remark;
    public final String source;
    public final String detailUrl;
    public final long statusEventTime;
    public final long updatedAt;
    public final String stateOwner;
    public final String routeOwner;
    public final String routeInterface;
    public final String routeCredential;
    /** False when AndroidKeyStore could not decrypt the persisted credential this time. */
    public final boolean routeCredentialAvailable;
    public final String projectedWaybill;
    public final String projectedCompanyName;
    public final String projectedTracksJson;

    public ExpressItem(
            long rowId,
            String phone,
            String waybill,
            String courierCode,
            String companyName,
            StatusSemantic semantic,
            String statusDescription,
            String latestDetail,
            String latestTime,
            String tracksJson,
            String remark,
            String source,
            String detailUrl) {
        this(rowId, phone, waybill, courierCode, companyName, semantic,
                statusDescription, latestDetail, latestTime, tracksJson, remark,
                source, detailUrl, 0L, 0L, source, "");
    }

    public ExpressItem(
            long rowId,
            String phone,
            String waybill,
            String courierCode,
            String companyName,
            StatusSemantic semantic,
            String statusDescription,
            String latestDetail,
            String latestTime,
            String tracksJson,
            String remark,
            String source,
            String detailUrl,
            long statusEventTime,
            long updatedAt,
            String stateOwner,
            String routeOwner) {
        this(rowId, phone, waybill, courierCode, companyName, semantic,
                statusDescription, latestDetail, latestTime, tracksJson, remark,
                source, detailUrl, statusEventTime, updatedAt, stateOwner, routeOwner,
                "", "");
    }

    public ExpressItem(
            long rowId,
            String phone,
            String waybill,
            String courierCode,
            String companyName,
            StatusSemantic semantic,
            String statusDescription,
            String latestDetail,
            String latestTime,
            String tracksJson,
            String remark,
            String source,
            String detailUrl,
            long statusEventTime,
            long updatedAt,
            String stateOwner,
            String routeOwner,
            String routeInterface,
            String routeCredential) {
        this(rowId, phone, waybill, courierCode, companyName, semantic,
                statusDescription, latestDetail, latestTime, tracksJson, remark,
                source, detailUrl, statusEventTime, updatedAt, stateOwner, routeOwner,
                routeInterface, routeCredential, true, "", "", "");
    }

    public ExpressItem(
            long rowId,
            String phone,
            String waybill,
            String courierCode,
            String companyName,
            StatusSemantic semantic,
            String statusDescription,
            String latestDetail,
            String latestTime,
            String tracksJson,
            String remark,
            String source,
            String detailUrl,
            long statusEventTime,
            long updatedAt,
            String stateOwner,
            String routeOwner,
            String routeInterface,
            String routeCredential,
            boolean routeCredentialAvailable) {
        this(rowId, phone, waybill, courierCode, companyName, semantic,
                statusDescription, latestDetail, latestTime, tracksJson, remark,
                source, detailUrl, statusEventTime, updatedAt, stateOwner, routeOwner,
                routeInterface, routeCredential, routeCredentialAvailable, "", "", "");
    }

    public ExpressItem(
            long rowId,
            String phone,
            String waybill,
            String courierCode,
            String companyName,
            StatusSemantic semantic,
            String statusDescription,
            String latestDetail,
            String latestTime,
            String tracksJson,
            String remark,
            String source,
            String detailUrl,
            long statusEventTime,
            long updatedAt,
            String stateOwner,
            String routeOwner,
            String routeInterface,
            String routeCredential,
            boolean routeCredentialAvailable,
            String projectedWaybill,
            String projectedCompanyName,
            String projectedTracksJson) {
        this.rowId = rowId;
        this.phone = clean(phone);
        this.waybill = clean(waybill);
        this.courierCode = clean(courierCode);
        this.companyName = clean(companyName);
        this.semantic = semantic == null ? StatusSemantic.UNKNOWN : semantic;
        this.statusDescription = clean(statusDescription);
        this.latestDetail = clean(latestDetail);
        this.latestTime = clean(latestTime);
        this.tracksJson = clean(tracksJson);
        this.remark = clean(remark);
        this.source = clean(source);
        this.detailUrl = clean(detailUrl);
        this.statusEventTime = statusEventTime;
        this.updatedAt = updatedAt;
        this.stateOwner = clean(stateOwner);
        this.routeOwner = clean(routeOwner);
        this.routeInterface = clean(routeInterface).toLowerCase(java.util.Locale.ROOT);
        this.routeCredential = clean(routeCredential);
        this.routeCredentialAvailable = routeCredentialAvailable;
        this.projectedWaybill = clean(projectedWaybill);
        this.projectedCompanyName = clean(projectedCompanyName);
        this.projectedTracksJson = clean(projectedTracksJson);
    }

    public String displayStatus() {
        return semantic == StatusSemantic.UNKNOWN && !statusDescription.isEmpty()
                ? statusDescription : semantic.label;
    }

    public String displayCompany() {
        if (!projectedCompanyName.isEmpty()) {
            String projected = CarrierRegistry.displayName("", projectedCompanyName);
            return projected.isEmpty() ? projectedCompanyName : projected;
        }
        if (isAccountOrder()) return "京东购物";
        String display = CarrierRegistry.displayName(courierCode, companyName);
        return display.isEmpty() ? "快递" : display;
    }

    /** Account rows that expose only an order id always use our shopping asset. */
    public int displayIconResource() {
        if (!projectedCompanyName.isEmpty()) {
            return CarrierRegistry.icon("", projectedCompanyName);
        }
        if (isAccountOrder()) return R.drawable.jdshopping;
        return CarrierRegistry.icon(courierCode, companyName);
    }

    public String displayWaybill() {
        return projectedWaybill.isEmpty() ? waybill : projectedWaybill;
    }

    public String displayCourierCode() {
        return projectedCompanyName.isEmpty()
                ? courierCode : CarrierRegistry.queryCode("", projectedCompanyName);
    }

    public boolean isAccountOrder() {
        String owner = stateOwner.isEmpty() ? source : stateOwner;
        if (!("I5-JD".equalsIgnoreCase(owner)
                || "I5-JD".equalsIgnoreCase(source)
                || "I6-JD".equalsIgnoreCase(owner)
                || "I6-JD".equalsIgnoreCase(source))) {
            return false;
        }
        String code = courierCode.toUpperCase(java.util.Locale.ROOT);
        return "JD".equals(code) || "JDKD".equals(code) || "JDKY".equals(code)
                || companyName.contains("京东");
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
