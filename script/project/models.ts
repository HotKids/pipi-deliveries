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

export type BindingSource = "interface5" | "interface6";

export type AccountBinding = {
  source: BindingSource;
  phone: string;
  boundAtMs: number;
};

export type ImportSuppression = {
  kind: "unbound" | "deleted";
  source: BindingSource;
  sourceIdHash: string;
  phoneHash: string;
  createdAtMs: number;
};

export type WaybillTombstone = {
  waybillHash: string;
  reason: "manual_delete" | "retention_expired";
  createdAtMs: number;
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
  kind: "cainiao";
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
  waybill: string;
  courierCode: string;
  companyName: string;
  semantic: StatusSemantic;
  statusEventAtMs: number | null;
  latestTimeText: string;
  latestDetail: string;
  tracks: readonly TrackNode[];
  successAtMs: number;
};

export type ShipmentIdentity = {
  id: string;
  bindingSource: BindingSource | null;
  sourceOwner: string;
  sourceId: string;
  phoneTail: string;
  phone?: string;
  courierCode: string;
  companyName: string;
  sourceProvider?: string;
  orderId?: string;
  projectedWaybill?: string;
  orderProjectionRetry?: {
    routeHash: string;
    failedAtMs?: number;
    attemptId?: string;
    attemptExpiresAtMs?: number;
  };
  accountOrder?: boolean;
  manuallyAdded: boolean;
  createdAtMs: number;
};

export type Shipment = {
  identity: ShipmentIdentity;
  timeline: TimelinePackage;
  sourceTimeline?: TimelinePackage | null;
  manualTimelines?: readonly TimelinePackage[];
  manualRefreshAttemptAtMs?: number;
  manualRefreshLease?: {
    attemptId: string;
    startedAtMs: number;
    expiresAtMs: number;
  };
  forcedCompletedAtMs?: number;
  route?: ShipmentRoute | null;
  accountRecord?: AccountDetailRecord | null;
  updatedAtMs: number;
};

export type PendingManualQuery = {
  id: string;
  source: BindingSource;
  waybill: string;
  phoneTail: string;
  courierCode: string;
  companyName: string;
  createdAtMs: number;
  lastAttemptAtMs: number;
  attempts: number;
  route?: ShipmentRoute | null;
};

export type AppState = {
  version: 2;
  revision: number;
  updatedAtMs: number;
  activeSource: BindingSource;
  bindings: readonly AccountBinding[];
  suppressions: readonly ImportSuppression[];
  tombstones: readonly WaybillTombstone[];
  pendingQueries: readonly PendingManualQuery[];
  shipments: readonly Shipment[];
};

export type WidgetRow = {
  shipmentId: string;
  companyName: string;
  courierCode: string;
  accountOrder: boolean;
  waybillSuffix: string;
  semantic: StatusSemantic;
  statusLabel: string;
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
};
