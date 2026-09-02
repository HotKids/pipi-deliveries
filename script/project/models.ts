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
  rawCourierCode?: string;
  companyName: string;
  createdAtMs: number;
  lastAttemptAtMs: number;
  attempts: number;
  /** A foreground-only first-round continuation still has providers to run. */
  awaitingRoundCompletion?: boolean;
  route?: ShipmentRoute | null;
};

export type AppState = {
  version: 2;
  revision: number;
  updatedAtMs: number;
  activeSource: BindingSource;
  bindings: readonly AccountBinding[];
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
  promotedPendingShipmentIds: readonly string[];
};
