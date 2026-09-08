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

export type BindingSource = "interface5" | "interface6";

export type AccountBinding = {
  source: BindingSource;
  phone: string;
  boundAtMs: number;
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
  latestTimeText: string;
  latestDetail: string;
  tracks: readonly TrackNode[];
  successAtMs: number;
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
  orderId?: string;
  projectedWaybill?: string;
  orderProjectionRetry?: {
    routeHash: string;
    failedAtMs?: number;
    /** Set when the failed attempt saw JD risk control (AGENTS §9 cooldown, 60 min). */
    riskControlAtMs?: number;
    attemptId?: string;
    attemptExpiresAtMs?: number;
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
  detailSelection?: { provider: string; selectedAtMs: number };
  /**
   * 用户在详情页填的备注（用户定 2026-09-05 晚）：列表页、详情页、桌面卡片都以「状态词 · 备注」
   * 显示；只在详情页可以添加或修改。同步合并从不改它。
   */
  note?: string;
  route?: ShipmentRoute | null;
  accountRecord?: AccountDetailRecord | null;
  /**
   * 这一票第一次被观察到进入终态的时刻。留存期（签收 7 天 / 取消 4 小时）在没有可信节点时间时
   * 以它兜底，而不是 updatedAtMs——后者每次写入都会刷新，等于把倒计时一直归零，签收件既不过期
   * 也会被下一轮同步重新带回列表（用户 2026-09-07 报）。离开终态即清空。
   */
  settledAtMs?: number;
  updatedAtMs: number;
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
  /** feed 槽一次性重建已标记的时间（见 TimelinePackage.feedRebuildPending）。 */
  feedSlotRebuiltAtMs?: number;
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

export type ManualQueryInput = {
  waybill: string;
  phoneTail?: string;
};

export type RefreshSummary = {
  attempted: number;
  succeeded: number;
  failed: number;
  state: AppState;
  promotedPendingShipmentIds: readonly string[];
};
