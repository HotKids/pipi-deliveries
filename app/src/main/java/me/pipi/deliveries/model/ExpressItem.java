package me.pipi.deliveries.model;

import me.pipi.deliveries.R;
import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.data.ExpressStatusLabels;

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
    /** Immutable first completion anchor for visibility and deletion, never refresh evidence. */
    public final long signedRetainedAt;
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
    /** Independent metadata from this owner's account list, never a selected detail package. */
    public final String senderPhone;
    public final boolean sender;
    public final long listOriginAtMs;
    /**
     * Whether {@link #sourceSemantic} is the feed's own structured Worker status, read from the
     * stored row before any presentation downgrade or takeover (audit L8, user 2026-09-25). A later
     * v5_query takeover changes the presented status, never this.
     */
    public final boolean sourceStatusStructured;

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
        this(rowId, phone, waybill, courierCode, companyName, semantic,
                statusDescription, latestDetail, latestTime, tracksJson, remark,
                source, detailUrl, statusEventTime, updatedAt, stateOwner, routeOwner,
                routeInterface, routeCredential, routeCredentialAvailable, projectedWaybill,
                projectedCompanyName, projectedTracksJson, sourceProvider,
                manuallyAdded, manualTimelineProvider, manualTimelineSuccessAt,
                sourceSemantic, carrierNormalization, 0L);
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
            CarrierNormalization carrierNormalization,
            long signedRetainedAt) {
        this(rowId, phone, waybill, courierCode, companyName, semantic,
                statusDescription, latestDetail, latestTime, tracksJson, remark,
                source, detailUrl, statusEventTime, updatedAt, stateOwner, routeOwner,
                routeInterface, routeCredential, routeCredentialAvailable, projectedWaybill,
                projectedCompanyName, projectedTracksJson, sourceProvider, manuallyAdded,
                manualTimelineProvider, manualTimelineSuccessAt, sourceSemantic,
                carrierNormalization, signedRetainedAt, "", 0L, false, false);
    }

    private ExpressItem(long rowId, String phone, String waybill, String courierCode,
            String companyName, StatusSemantic semantic, String statusDescription,
            String latestDetail, String latestTime, String tracksJson, String remark,
            String source, String detailUrl, long statusEventTime, long updatedAt,
            String stateOwner, String routeOwner, String routeInterface, String routeCredential,
            boolean routeCredentialAvailable, String projectedWaybill, String projectedCompanyName,
            String projectedTracksJson, String sourceProvider, boolean manuallyAdded,
            String manualTimelineProvider, long manualTimelineSuccessAt,
            StatusSemantic sourceSemantic, CarrierNormalization carrierNormalization,
            long signedRetainedAt, String senderPhone, long listOriginAtMs, boolean sender,
            boolean sourceStatusStructured) {
        this.rowId = rowId;
        this.sourceStatusStructured = sourceStatusStructured;
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
        this.signedRetainedAt = Math.max(0L, signedRetainedAt);
        this.senderPhone = clean(senderPhone);
        this.sender = sender;
        this.listOriginAtMs = Math.max(0L, listOriginAtMs);
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

    public ExpressItem withSignedRetainedAt(long value) {
        if (signedRetainedAt == value) return this;
        return new ExpressItem(rowId, phone, waybill, courierCode, companyName, semantic,
                statusDescription, latestDetail, latestTime, tracksJson, remark,
                source, detailUrl, statusEventTime, updatedAt, stateOwner, routeOwner,
                routeInterface, routeCredential, routeCredentialAvailable, projectedWaybill,
                projectedCompanyName, projectedTracksJson, sourceProvider,
                manuallyAdded, manualTimelineProvider, manualTimelineSuccessAt,
                sourceSemantic, carrierNormalization, value);
    }

    /**
     * The one status display function behind list, detail, widgets and notification titles (audit
     * L5, user defaults of 2026-09-25): every word comes from the shared status label table
     * ({@link CarrierRegistry#statusLabels()}, served by the Worker with the carrier snapshot), so
     * DANGER reads 异常件 and UNKNOWN reads 暂无状态 whatever text a Worker once stored on the row.
     * The Worker projection still selects a subtype (待派送) and, on an order row without a real
     * waybill, the order word (订单已取消); a projected JD parcel reads the ordinary word (已签收).
     */
    public String displayStatus() {
        ExpressStatusLabels table = CarrierRegistry.statusLabels();
        boolean unprojectedOrder = isAccountOrder() && projectedWaybill.isEmpty();
        // 订单阶段自己走完的账号订单写「已完成」，不写「已签收」（用户定 2026-09-06，与 iOS
        // shipmentPresentationStatus 同口径）：这一票从来没有过承运商签收动作，只有订单终点。
        if (unprojectedOrder && semantic == StatusSemantic.COMPLETED) {
            String order = table.orderLabel(StatusSemantic.COMPLETED);
            if (!order.isEmpty()) return order;
        }
        WorkerStatusProjection projected = WorkerStatusProjection.cached(tracksJson);
        if (projected != null && projected.matches(semantic, statusEventTime)) {
            String subtype = table.subtypeLabel(semantic, projected.code);
            if (!subtype.isEmpty()) return subtype;
            if ("ORDER".equals(projected.scope) && unprojectedOrder) {
                String order = table.orderLabel(semantic);
                if (!order.isEmpty()) return order;
            }
        }
        return table.label(semantic);
    }

    public String displayCompany() {
        String shown = matchedCompany();
        // 其余裁决 32、33：识别进入终态、快递100 也没给名字的件，承运商位置填来源传回的 cpCode 原样（不是「京东快递」），
        // 没传回就空着（用户：「传回啥 cpcode 就填啥」）。
        return unmatched(shown) && carrierRecognitionExhausted() ? courierCode : shown;
    }

    /**
     * The carrier position as the list, widgets, detail header and notification title show it. 其余裁决 35
     * （用户 2026-09-27：「算了统一前面加 快递 两个字吧」）：承运商为空时统一写「快递」，例如「快递 4547 · 已揽收」；有承运商名
     * 或原始码时照旧显示它们。{@link #displayCompany()} itself stays the carrier name, empty when there is none.
     */
    public String displayCarrierLabel() {
        return carrierLabel(displayCompany());
    }

    /** 其余裁决 35: an empty carrier position reads 快递. */
    public static String carrierLabel(String company) {
        String value = company == null ? "" : company.trim();
        return value.isEmpty() ? "快递" : value;
    }

    private String matchedCompany() {
        if (isAccountOrder() && projectedWaybill.isEmpty()) return "京东购物";
        CarrierRegistry.Carrier carrier = resolvedCarrier();
        if (carrier != null) return carrier.companyName;
        // 其余裁决 29：快递100 认得出、内置表没有的承运商，显示它给的名字（只作显示）。
        String offTable = carrierNormalization.offTableName();
        if (!offTable.isEmpty()) return offTable;
        if (!projectedWaybill.isEmpty()) {
            return CarrierRegistry.resolveProjected(projectedCompanyName) != null
                    || "快递".equals(projectedCompanyName)
                    || CarrierNormalization.PROJECTION_EXHAUSTED.equals(projectedCompanyName)
                    ? "" : projectedCompanyName;
        }
        String display = CarrierRegistry.displayName(courierCode, companyName);
        if (CarrierRegistry.resolveCpCode(courierCode) != null
                || CarrierRegistry.resolveName(companyName) != null) return "";
        if (!courierCode.isEmpty() && !"快递".equals(courierCode)) return courierCode;
        return "快递".equals(display) ? "" : display;
    }

    /**
     * 承运商先对上再推送（T23，用户 2026-09-26，其余裁决 28）：这一行亮出了真实运单号，承运商却还没对上——显示的承运商
     * 为空，或只是原样搬过来的原始码（内置表认不出）。京东平台标签在非 JD 运单上不算承运商（R-20，已由
     * {@link #resolvedCarrier()} 拒掉）。内置表结果、快递100 表外名、上游或京粉页给的真名都算对上；未投影的订单显示
     * 「京东购物」，不在此列。与 iOS carrier-gate.ts carrierAwaitingRecognition 同口径。
     *
     * <p>其余裁决 32、33：识别已进入终态、快递100 没给名字的，不再挂着，照常放行；承运商位置是来源传回的 cpCode 原样，没有就
     * 空着，不造占位文案。</p>
     */
    public boolean carrierPending() {
        if (isAccountOrder() && projectedWaybill.isEmpty()) return false;
        if (displayWaybill().isEmpty()) return false;
        if (resolvedCarrier() != null) return false;
        return unmatched(matchedCompany()) && !carrierRecognitionExhausted();
    }

    /** What a row shows is no carrier: blank, the generic 快递, or its own raw code copied over. */
    private boolean unmatched(String shown) {
        if (shown.isEmpty() || "快递".equals(shown)) return true;
        return !carrierNormalization.offTableName().equals(shown)
                && shown.equalsIgnoreCase(courierCode);
    }

    /**
     * 其余裁决 32：这一行的承运商识别已进入终态（投影订单记在它的投影上，其它行记在它自己的识别结果上）。
     */
    public boolean carrierRecognitionExhausted() {
        if (isAccountOrder()) {
            return !projectedWaybill.isEmpty()
                    && CarrierNormalization.PROJECTION_EXHAUSTED.equals(projectedCompanyName);
        }
        return carrierNormalization.recognitionExhausted();
    }

    /** Account rows that expose only an order id always use our shopping asset. */
    public int displayIconResource() {
        if (isAccountOrder() && projectedWaybill.isEmpty()) return R.drawable.jdshopping;
        CarrierRegistry.Carrier carrier = resolvedCarrier();
        return carrier == null ? R.drawable.ic_card_express_cp_default : carrier.iconResource;
    }

    /** 只换表头（最新一条的文案和时间）；轨迹、状态和其它字段原样保留。 */
    public ExpressItem withHeadline(String detail, String time) {
        return new ExpressItem(rowId, phone, waybill, courierCode, companyName, semantic,
                statusDescription, detail, time, tracksJson, remark, source,
                detailUrl, statusEventTime, updatedAt, stateOwner, routeOwner, routeInterface,
                routeCredential, routeCredentialAvailable, projectedWaybill, projectedCompanyName,
                projectedTracksJson, sourceProvider, manuallyAdded, manualTimelineProvider,
                manualTimelineSuccessAt, sourceSemantic, carrierNormalization, signedRetainedAt,
                senderPhone, listOriginAtMs, sender, sourceStatusStructured);
    }

    /** Display projection only; persisted status and completion evidence stay in the owning row. */
    public ExpressItem withDisplayStatus(StatusSemantic displayStatus, long displayStatusAt) {
        return new ExpressItem(rowId, phone, waybill, courierCode, companyName, displayStatus,
                displayStatus.label, latestDetail, latestTime, tracksJson, remark, source,
                detailUrl, displayStatusAt, updatedAt, stateOwner, routeOwner, routeInterface,
                routeCredential, routeCredentialAvailable, projectedWaybill, projectedCompanyName,
                projectedTracksJson, sourceProvider, manuallyAdded, manualTimelineProvider,
                manualTimelineSuccessAt, sourceSemantic, carrierNormalization, signedRetainedAt,
                senderPhone, listOriginAtMs, sender, sourceStatusStructured);
    }

    public ExpressItem withAccountListMetadata(String senderPhone, long originAtMs) {
        return withAccountListMetadata(senderPhone, originAtMs, sender);
    }

    public ExpressItem withAccountListMetadata(String senderPhone, long originAtMs, boolean sender) {
        return new ExpressItem(rowId, phone, waybill, courierCode, companyName, semantic,
                statusDescription, latestDetail, latestTime, tracksJson, remark, source,
                detailUrl, statusEventTime, updatedAt, stateOwner, routeOwner, routeInterface,
                routeCredential, routeCredentialAvailable, projectedWaybill, projectedCompanyName,
                projectedTracksJson, sourceProvider, manuallyAdded, manualTimelineProvider,
                manualTimelineSuccessAt, sourceSemantic, carrierNormalization, signedRetainedAt,
                senderPhone, originAtMs, sender, sourceStatusStructured);
    }

    /** Carries the feed's own structured status flag onto a projected copy (audit L8). */
    public ExpressItem withSourceStatusStructured(boolean value) {
        if (sourceStatusStructured == value) return this;
        return new ExpressItem(rowId, phone, waybill, courierCode, companyName, semantic,
                statusDescription, latestDetail, latestTime, tracksJson, remark, source,
                detailUrl, statusEventTime, updatedAt, stateOwner, routeOwner, routeInterface,
                routeCredential, routeCredentialAvailable, projectedWaybill, projectedCompanyName,
                projectedTracksJson, sourceProvider, manuallyAdded, manualTimelineProvider,
                manualTimelineSuccessAt, sourceSemantic, carrierNormalization, signedRetainedAt,
                senderPhone, listOriginAtMs, sender, value);
    }

    public String displayWaybill() {
        return projectedWaybill.isEmpty() ? waybill : projectedWaybill;
    }

    /** A projected real waybill owns carrier identity; sourceProvider remains account provenance. */
    public String displayCourierCode() {
        CarrierRegistry.Carrier carrier = resolvedCarrier();
        if (carrier != null) return carrier.kuaidi100Code;
        return projectedWaybill.isEmpty() && CarrierRegistry.resolveCpCode(courierCode) == null
                ? courierCode : "";
    }

    /** Display and recognition use the same local-table decision for this real waybill. */
    public CarrierRegistry.Carrier resolvedCarrier() {
        if (isAccountOrder() && projectedWaybill.isEmpty()) return null;
        CarrierRegistry.Carrier exactCarrier = matchingExactCarrierNormalization();
        if (exactCarrier != null && !platformCarrierOnly(exactCarrier)) return exactCarrier;
        CarrierRegistry.Carrier rawCarrier = rawCarrierForDisplay();
        if (rawCarrier != null) return rawCarrier;
        CarrierRegistry.Carrier projected = CarrierRegistry.resolveProjected(projectedCompanyName);
        if (projected != null && !platformCarrierOnly(projected)) return projected;
        if (carrierNormalization.recognized()) {
            CarrierRegistry.Carrier current = CarrierRegistry.resolve(
                    carrierNormalization.standardCode);
            if (current != null && !platformCarrierOnly(current)) return current;
        }
        return null;
    }

    private boolean platformCarrierOnly(CarrierRegistry.Carrier carrier) {
        return carrier != null && "JD".equals(carrier.standardCode)
                && (isAccountOrder() || isJingDongSource())
                && !displayWaybill().toUpperCase(java.util.Locale.ROOT)
                        .replaceAll("[^A-Z0-9]", "").startsWith("JD");
    }

    private CarrierRegistry.Carrier rawCarrierForDisplay() {
        CarrierRegistry.Carrier carrier = CarrierRegistry.resolveCpCode(courierCode);
        // JD's platform label is not carrier evidence for a non-JD waybill.
        if (platformCarrierOnly(carrier) || isAccountOrder()
                && carrier != null && "JD".equals(carrier.standardCode)) {
            carrier = null;
        }
        if (carrier != null) return carrier;
        CarrierRegistry.Carrier named = CarrierRegistry.resolveName(companyName);
        return platformCarrierOnly(named) || isAccountOrder()
                && named != null && "JD".equals(named.standardCode) ? null : named;
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
