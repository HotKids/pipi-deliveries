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
    /** Persisted account/provider state retained for refresh requests. */
    public final StatusSemantic sourceSemantic;
    /** User-visible state after local presentation policies and timeline projection. */
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
    /** Exact upstream provider value retained from the account-source record. */
    public final String sourceProvider;
    /** Display-only carrier projection; raw courierCode/companyName remain untouched. */
    public final CarrierNormalization carrierNormalization;
    /** True only for rows created by the app's shared manual-query flow. */
    public final boolean manuallyAdded;
    /** Selected durable manual timeline provider; empty before the first successful lookup. */
    public final String manualTimelineProvider;
    /** Success clock of the selected manual timeline, independent from account refreshes. */
    public final long manualTimelineSuccessAt;

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
        this(rowId, phone, waybill, courierCode, companyName, semantic,
                statusDescription, latestDetail, latestTime, tracksJson, remark,
                source, detailUrl, statusEventTime, updatedAt, stateOwner, routeOwner,
                routeInterface, routeCredential, routeCredentialAvailable, projectedWaybill,
                projectedCompanyName, projectedTracksJson, "");
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
            String projectedTracksJson,
            String sourceProvider) {
        this(rowId, phone, waybill, courierCode, companyName, semantic,
                statusDescription, latestDetail, latestTime, tracksJson, remark,
                source, detailUrl, statusEventTime, updatedAt, stateOwner, routeOwner,
                routeInterface, routeCredential, routeCredentialAvailable, projectedWaybill,
                projectedCompanyName, projectedTracksJson, sourceProvider,
                false, "", 0L);
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
            String projectedTracksJson,
            String sourceProvider,
            boolean manuallyAdded,
            String manualTimelineProvider,
            long manualTimelineSuccessAt) {
        this(rowId, phone, waybill, courierCode, companyName, semantic,
                statusDescription, latestDetail, latestTime, tracksJson, remark,
                source, detailUrl, statusEventTime, updatedAt, stateOwner, routeOwner,
                routeInterface, routeCredential, routeCredentialAvailable, projectedWaybill,
                projectedCompanyName, projectedTracksJson, sourceProvider,
                manuallyAdded, manualTimelineProvider, manualTimelineSuccessAt, semantic);
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
            String projectedTracksJson,
            String sourceProvider,
            boolean manuallyAdded,
            String manualTimelineProvider,
            long manualTimelineSuccessAt,
            StatusSemantic sourceSemantic) {
        this(rowId, phone, waybill, courierCode, companyName, semantic,
                statusDescription, latestDetail, latestTime, tracksJson, remark,
                source, detailUrl, statusEventTime, updatedAt, stateOwner, routeOwner,
                routeInterface, routeCredential, routeCredentialAvailable, projectedWaybill,
                projectedCompanyName, projectedTracksJson, sourceProvider,
                manuallyAdded, manualTimelineProvider, manualTimelineSuccessAt,
                sourceSemantic, CarrierNormalization.NONE);
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
            String projectedTracksJson,
            String sourceProvider,
            boolean manuallyAdded,
            String manualTimelineProvider,
            long manualTimelineSuccessAt,
            StatusSemantic sourceSemantic,
            CarrierNormalization carrierNormalization) {
        this.rowId = rowId;
        this.phone = clean(phone);
        this.waybill = clean(waybill);
        this.courierCode = clean(courierCode);
        this.companyName = clean(companyName);
        this.semantic = semantic == null ? StatusSemantic.UNKNOWN : semantic;
        this.sourceSemantic = sourceSemantic == null ? StatusSemantic.UNKNOWN : sourceSemantic;
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
        this.sourceProvider = clean(sourceProvider);
        this.carrierNormalization = carrierNormalization == null
                ? CarrierNormalization.NONE : carrierNormalization;
        this.manuallyAdded = manuallyAdded;
        this.manualTimelineProvider = clean(manualTimelineProvider).toLowerCase(
                java.util.Locale.ROOT);
        this.manualTimelineSuccessAt = Math.max(0L, manualTimelineSuccessAt);
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
        if (!projectedWaybill.isEmpty()) return "快递";
        if (isAccountOrder()) return "京东购物";
        CarrierRegistry.Carrier exactCarrier = matchingExactCarrierNormalization();
        if (exactCarrier != null) return exactCarrier.companyName;
        CarrierRegistry.Carrier rawCarrier = CarrierRegistry.resolveCpCode(courierCode);
        if (rawCarrier != null) return rawCarrier.companyName;
        if (carrierNormalization.recognized()) {
            CarrierRegistry.Carrier current = CarrierRegistry.resolve(
                    carrierNormalization.standardCode);
            if (current != null) return current.companyName;
            if (!carrierNormalization.displayName.isEmpty()) {
                return carrierNormalization.displayName;
            }
        }
        String display = CarrierRegistry.displayName(courierCode, companyName);
        if (CarrierRegistry.resolveCpCode(courierCode) != null
                || CarrierRegistry.resolveName(companyName) != null) return display;
        if (!courierCode.isEmpty()) return courierCode;
        return display.isEmpty() ? "快递" : display;
    }

    /** Account rows that expose only an order id always use our shopping asset. */
    public int displayIconResource() {
        if (!projectedCompanyName.isEmpty()) {
            return CarrierRegistry.icon("", projectedCompanyName);
        }
        if (!projectedWaybill.isEmpty()) {
            return R.drawable.ic_card_express_cp_default;
        }
        if (isAccountOrder()) return R.drawable.jdshopping;
        CarrierRegistry.Carrier exactCarrier = matchingExactCarrierNormalization();
        if (exactCarrier != null) return exactCarrier.iconResource;
        CarrierRegistry.Carrier rawCarrier = CarrierRegistry.resolveCpCode(courierCode);
        if (rawCarrier != null) return rawCarrier.iconResource;
        if (carrierNormalization.recognized()) {
            return CarrierRegistry.icon(
                    carrierNormalization.standardCode,
                    carrierNormalization.displayName);
        }
        return CarrierRegistry.icon(courierCode, companyName);
    }

    public String displayWaybill() {
        return projectedWaybill.isEmpty() ? waybill : projectedWaybill;
    }

    /** A projected real waybill owns carrier identity; sourceProvider remains account provenance. */
    public String displayCourierCode() {
        if (!projectedCompanyName.isEmpty()) {
            return CarrierRegistry.queryCode("", projectedCompanyName);
        }
        if (!projectedWaybill.isEmpty()) return "";
        CarrierRegistry.Carrier exactCarrier = matchingExactCarrierNormalization();
        if (exactCarrier != null) return exactCarrier.kuaidi100Code;
        CarrierRegistry.Carrier rawCarrier = CarrierRegistry.resolveCpCode(courierCode);
        if (rawCarrier != null) return rawCarrier.kuaidi100Code;
        if (carrierNormalization.recognized()) {
            CarrierRegistry.Carrier current = CarrierRegistry.resolve(
                    carrierNormalization.standardCode);
            if (current != null) return current.kuaidi100Code;
            if (!carrierNormalization.kuaidi100Code.isEmpty()) {
                return carrierNormalization.kuaidi100Code;
            }
        }
        return courierCode;
    }

    private CarrierRegistry.Carrier matchingExactCarrierNormalization() {
        if (!carrierNormalization.recognized()) return null;
        CarrierRegistry.Carrier exact = CarrierRegistry.resolve(courierCode);
        CarrierRegistry.Carrier normalized = CarrierRegistry.resolve(
                carrierNormalization.standardCode);
        return exact != null && normalized != null
                && exact.standardCode.equalsIgnoreCase(normalized.standardCode)
                ? exact : null;
    }

    public boolean isAccountOrder() {
        String owner = stateOwner.isEmpty() ? source : stateOwner;
        if (!("I5-JD".equalsIgnoreCase(owner)
                || "I5-JD".equalsIgnoreCase(source)
                || "I6-JD".equalsIgnoreCase(owner)
                || "I6-JD".equalsIgnoreCase(source))) {
            return false;
        }
        return !manuallyAdded;
    }

    public boolean isInterface5ProjectedOrder() {
        String owner = stateOwner.isEmpty() ? source : stateOwner;
        return isAccountOrder() && !projectedWaybill.isEmpty()
                && ("I5-JD".equalsIgnoreCase(owner)
                || "I5-JD".equalsIgnoreCase(source));
    }

    /** Account timelines are trusted only when the row owns a supported account detail route. */
    public boolean usesInterface5AccountTimeline() {
        String owner = stateOwner.isEmpty() ? source : stateOwner;
        if ("I5-JD".equalsIgnoreCase(owner)) return true;
        return "INTERFACE5".equalsIgnoreCase(owner)
                && (CainiaoRoute.isToken(detailUrl)
                || CainiaoRoute.isLegacyCredentialedUrl(detailUrl));
    }

    /** Only the exact interface 5 ownership contract may opt into source-specific handling. */
    public boolean isInterface5ShunFengSource() {
        String owner = stateOwner.isEmpty() ? source : stateOwner;
        return !manuallyAdded
                && "INTERFACE5".equalsIgnoreCase(owner)
                && "ShunFeng".equalsIgnoreCase(sourceProvider);
    }

    /** Exact account-source SF ownership, independent from the selected account interface. */
    public boolean isShunFengSource() {
        String owner = stateOwner.isEmpty() ? source : stateOwner;
        return !manuallyAdded
                && ("INTERFACE5".equalsIgnoreCase(owner)
                || "INTERFACE6".equalsIgnoreCase(owner))
                && "ShunFeng".equalsIgnoreCase(sourceProvider);
    }

    /** Exact account-source JD ownership after the real carrier identity is available. */
    public boolean isJingDongSource() {
        String owner = stateOwner.isEmpty() ? source : stateOwner;
        return !manuallyAdded
                && ("INTERFACE5".equalsIgnoreCase(owner)
                || "INTERFACE6".equalsIgnoreCase(owner)
                || "I5-JD".equalsIgnoreCase(owner)
                || "I6-JD".equalsIgnoreCase(owner))
                && "JingDong".equalsIgnoreCase(sourceProvider);
    }

    public boolean usesSourceManualTakeover() {
        return isShunFengSource() || isJingDongSource();
    }

    /** Cainiao owns presentation through its credentialed H5 or the native owner package. */
    public boolean isCainiaoSource() {
        return !manuallyAdded && "CaiNiao".equalsIgnoreCase(sourceProvider);
    }

    public boolean hasManualTimelineAuthority() {
        return !manualTimelineProvider.isEmpty() && manualTimelineSuccessAt > 0L;
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
