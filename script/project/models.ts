export type StatusSemantic =
  | "CANCELLED"
  | "DANGER"
  | "ORDERED"
  | "SHIPPED"
  | "PICKED"
  | "TRANSIT"
  | "DELIVERY"
  | "WAITING_PICKUP"
  | "COMPLETED"
  | "UNKNOWN";

export type StatusPresentation = {
  scope: "ORDER" | "SHIPMENT";
  semantic: StatusSemantic;
  text: string;
};

export type NormalizedStatus = StatusPresentation & {
  version: 1;
  code: string;
  priority: number;
  eventAtMs: number;
  structured: boolean;
};

export type BindingSource = "interface5" | "interface6";

export type AccountBinding = {
  source: BindingSource;
  phone: string;
  boundAtMs: number;
  enhancedMode?: true;
  enhancedAtMs?: number;
  enhancedIdentityFingerprint?: string;
};

export type AccountDetailRecord = {
  waybill: string;
  companyCode: string;
  name: string;
  provider: string;
  stateNumber: number;
  updateTime: string;
  phone: string;
  channel: string;
};

export type ShipmentRoute = {
  kind: "cainiao" | "web";
  source: BindingSource;
};

export type TrackNode = {
  timeText: string;
  timeMs: number | null;
  detail: string;
  /** Optional right-column JT text; detail retains the full label and body as evidence. */
  displayContext?: string;
  statusCode: string;
  raw: Readonly<Record<string, unknown>>;
};

export type TimelinePackage = {
  provider: string;
  // Whether the provider returned a self-contained history; unrelated to delivery status.
  complete?: boolean;
  // Whether semantic/statusEventAtMs came from a provider enum rather than prose.
  structuredStatus?: boolean;
  waybill: string;
  // Exact carrier/protocol code returned by this provider. Missing on legacy data
  // and on sources that did not return a carrier field.
  rawCourierCode?: string;
  courierCode: string;
  companyName: string;
  semantic: StatusSemantic;
  statusEventAtMs: number | null;
  /** Worker projection from the selected status donor, bound to that same event. */
  normalizedStatus?: NormalizedStatus;
  latestTimeText: string;
  latestDetail: string;
  /** Display-only donor metadata, valid only for this exact projected headline. */
  headlineDisplay?: { provider: string; timeText: string; detail: string; displayContext?: string };
  tracks: readonly TrackNode[];
  successAtMs: number;
  /** Earliest list time with origin evidence, retained when list snapshots replace their nodes. */
  listOriginAtMs?: number;
  /**
   * 一次性修复标记（2026-09-06）：老版本把接口 5 按件详情并进了 feed 槽；带这个标记的 feed 包在下一次
   * 列表同步时被 feed 整包替换而不是增量合并，之后标记消失。按件详情的占位副本保留标记，不清它。
   */
  feedRebuildPending?: boolean;
};

export type ShipmentIdentity = {
  id: string;
  bindingSource: BindingSource | null;
  sourceOwner: string;
  sourceId: string;
  phoneTail: string;
  phone?: string;
  courierCode: string;
  rawCourierCode?: string;
  rawCompanyName?: string;
  companyName: string;
  carrierIsBuiltIn?: boolean;
  carrierKuaidi100Code?: string;
  carrierTableVersion?: string;
  sourceProvider?: string;
  /** Sender evidence belongs to the account list, independently of selected history. */
  sender?: boolean;
  orderId?: string;
  enhancedMode?: true;
  productImageURL?: string;
  projectedWaybill?: string;
  /** Preserved with this order after its saved association packets are replaced or pruned. */
  hadRealWaybill?: true;
  orderProjectionRetry?: {
    routeHash: string;
    failedAtMs?: number;
    /** Set when the failed attempt saw JD risk control (AGENTS §9 cooldown, 60 min). */
    riskControlAtMs?: number;
    attemptId?: string;
    attemptExpiresAtMs?: number;
    /** A completed order's latest unconfirmed empty-shell page (方案 A, user 2026-09-25). */
    emptyShellAtMs?: number;
    /** Its second empty-shell page at least one rest later: the page is never reopened. */
    emptyShellConfirmedAtMs?: number;
  };
  /**
   * AGENTS §9 (2026-09-03, D-13 ruling): a projected JD order without a causally complete H5
   * timeline reopens the union page on a detail refresh; this records that attempt so the
   * 10-minute / 60-minute (risk control) cooldown applies to the reopen as well.
   */
  jingDongH5Retry?: {
    routeHash: string;
    failedAtMs?: number;
    riskControlAtMs?: number;
    attemptId?: string;
    attemptExpiresAtMs?: number;
  };
  /**
   * 承运商先对上再推送（T23，用户 2026-09-26，其余裁决 28）：京粉页给出了这张订单的运单号，那一轮承运商却没对上，
   * 订单行就保持原样（仍是未投影的订单）。页面拿到的运单号与轨迹存在这里，之后各轮只对它补识别、不再开页；
   * 认出承运商、投影落地后清掉。
   */
  pendingProjection?: {
    waybill: string;
    timeline?: TimelinePackage | null;
    capturedAtMs: number;
  };
  accountOrder?: boolean;
  manuallyAdded: boolean;
  createdAtMs: number;
};

export type AutomaticSourceObservation = {
  source: string;
  bindingIdentity: string;
  bindingValid?: boolean;
  observedAtMs: number;
  identity: ShipmentIdentity;
  sourceTimeline: TimelinePackage;
  statusPresentation?: StatusPresentation;
  routeCapability?: ShipmentRoute | null;
  accountRecord?: AccountDetailRecord | null;
};

export type AutomaticOwnership = {
  ownerSource: string | null;
  ownerBindingIdentity: string | null;
  claimedAtMs: number;
  lastTakeoverAtMs: number;
  ownerMisses: number;
  takeoverPending: boolean;
  observations: readonly AutomaticSourceObservation[];
};

export type Shipment = {
  identity: ShipmentIdentity;
  timeline: TimelinePackage;
  sourceTimeline?: TimelinePackage | null;
  manualTimelines?: readonly TimelinePackage[];
  automaticOwnership?: AutomaticOwnership;
  statusPresentation?: StatusPresentation;
  /** Set only after this shipment's trusted Cainiao H5 returned no usable timeline. */
  cainiaoH5FallbackActivatedAtMs?: number;
  manualRefreshAttemptAtMs?: number;
  manualRefreshLease?: {
    attemptId: string;
    startedAtMs: number;
    expiresAtMs: number;
  };
  forcedCompletedAtMs?: number;
  /** 详情页上一轮显示的包（粘性选包，用户定 2026-09-05 晚）：下一轮默认还显示它。 */
  detailSelection?: { provider: string; selectedAtMs: number; reason?: "sf_refresh_failed" };
  /**
   * 用户在详情页填的备注（用户定 2026-09-05 晚）：列表页、详情页、桌面卡片都以「状态词 · 备注」
   * 显示；只在详情页可以添加或修改。同步合并从不改它。
   */
  note?: string;
  route?: ShipmentRoute | null;
  accountRecord?: AccountDetailRecord | null;
  /** Stable fallback when a signed row has no valid list date; also owns the existing 4-hour cancelled window. */
  settledAtMs?: number;
  /** An empty signed history exhausted its authorized refresh; hidden for seven days. */
  emptyTimelineHiddenAtMs?: number;
  /**
   * 占号时间（归属-5，用户 2026-09-25）：同一运单号上先占的那一行显示，其余挂靠隐藏。运单行取创建时间，
   * 订单取投影时刻，升级前已投影的订单记为迁移时刻；同一时刻按 id 排序。手动行不参与，不写这个字段。
   */
  occupiedAtMs?: number;
  /**
   * 承运商复用旧运单号（用户 2026-10-01/02「C 新件优先（含 A）」，四端）：新件拿走这一行的时刻。这一代之前存的旧件
   * 不是它的上一次状态：落库时不沿用旧的签收时钟（settledAtMs），这一轮当新件初次出现、不通知。见 services/waybill-reuse.ts。
   */
  waybillReuseAtMs?: number;
  /**
   * The account list row's own structured status as the Worker reported it, before an unprojected
   * order's 已揽收 is shown as 已下单 (audit L8, adopted 2026-09-25): the stored-row Home projection gate
   * reads this instead of re-mapping the raw list state code. Written by every list sync; rows stored
   * before it existed fall back to the raw code.
   */
  listStructuredSemantic?: StatusSemantic;
  /**
   * 订单先占号时（用户 2026-09-26 采纳 A）：挂靠在这一行后面的、同一运单自己的承运商记录报出的结构化状态与
   * 表头。每次落库按挂靠关系重算，只在比订单自己的状态新时被列表采用；轨迹各存各的，这里不存轨迹。
   */
  attachedCarrierStatus?: AttachedCarrierStatus;
  updatedAtMs: number;
};

export type AttachedCarrierStatus = {
  /** The attached carrier row the status was read from. */
  shipmentId: string;
  semantic: StatusSemantic;
  statusEventAtMs: number;
  normalizedStatus?: NormalizedStatus;
  latestTimeText: string;
  latestDetail: string;
};

export type PendingManualQuery = {
  id: string;
  source: BindingSource;
  waybill: string;
  phoneTail: string;
  courierCode: string;
  rawCourierCode?: string;
  companyName: string;
  createdAtMs: number;
  lastAttemptAtMs: number;
  attempts: number;
  /** A foreground-only first-round continuation still has providers to run. */
  awaitingRoundCompletion?: boolean;
  route?: ShipmentRoute | null;
};

export type ShipmentNotificationEvent = Readonly<{
  id: string;
  shipmentId: string;
  batchId?: string;
  semantic: StatusSemantic;
  title: string;
  body: string;
  iconName: string | null;
  /**
   * T23（用户 2026-09-26）：排队时这一行的承运商还没对上。不投递；承运商对上的那次存盘按当时的行重新生成标题再放行。
   */
  awaitingCarrier?: true;
}>;

export type PendingEnhancementUnsubscribe = Readonly<{
  id: string;
  phone: string;
  boundAtMs: number;
  enhancedAtMs: number;
  identityFingerprint: string;
  createdAtMs: number;
}>;

export type AppState = {
  version: 2;
  revision: number;
  updatedAtMs: number;
  activeSource: BindingSource;
  bindings: readonly AccountBinding[];
  pendingQueries: readonly PendingManualQuery[];
  shipments: readonly Shipment[];
  pendingNotifications?: readonly ShipmentNotificationEvent[];
  pendingEnhancementUnsubscribes?: readonly PendingEnhancementUnsubscribe[];
  /** feed 槽一次性重建已标记的时间（见 TimelinePackage.feedRebuildPending）。 */
  feedSlotRebuiltAtMs?: number;
  /** Minimal durable identities prevent retired empty histories from being reimported. */
  emptyTimelineRetirements?: readonly {
    id: string;
    source: BindingSource;
    waybill: string;
    hiddenAtMs: number;
  }[];
};

export type WidgetRow = {
  shipmentId: string;
  companyName: string;
  courierCode: string;
  accountOrder: boolean;
  waybillSuffix: string;
  semantic: StatusSemantic;
  statusLabel: string;
  /** 用户备注；2×2 不显示，4×2 拼在状态词后面。旧快照没有这个字段，按空处理。 */
  note?: string;
  latestDetail: string;
};

export type WidgetSnapshot = {
  version: 2;
  generatedAtMs: number;
  totalCount: number;
  activeCount: number;
  headline: {
    semantic: StatusSemantic;
    label: string;
    count: number;
  } | null;
  compactIcons: readonly {
    shipmentId: string;
    companyName: string;
    courierCode: string;
    accountOrder: boolean;
  }[];
  rows: readonly WidgetRow[];
};

export type GatewayCredentials = {
  token: string;
};



export type RefreshSummary = {
  attempted: number;
  succeeded: number;
  failed: number;
  accountListUpdated?: boolean;
  skipReason?: "active_cross_runtime_refresh";
  state: AppState;
  promotedPendingShipmentIds: readonly string[];
};
