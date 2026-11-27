import type { AbortSignal } from "scripting";
import { RefreshInvalidatedError } from "./refresh-coordination";
import type { AppState, BindingSource } from "../models";
import { SCRIPT_BINDING_SOURCE } from "./script-source";
import { SCRIPT_BUILD_TRACK, SCRIPT_CLIENT_BUILD, SCRIPT_VERSION } from "./build-track";
import { sha256Hex } from "./scripting-data";
import { OperationTimeoutError, type RequestTimeoutDetails, type WaitTimeoutDetails } from "./deadline";
import { DIAGNOSTIC_EVENTS } from "./diagnostic-events";
import {
  claimDiagnosticHandleReset, claimOpenFlowMarker, clearDiagnosticFiles, clearOpenFlowMarkers, diagnosticBatchId,
  diagnosticEpoch, diagnosticFiles, diagnosticLegacyImported, markDiagnosticLegacyImported, openFlowMarkers,
  pruneDiagnosticBatchesAsync, pruneDiagnosticBatchesByMetadata, pruneDiagnosticFiles, publishDiagnosticBatch,
  publishDiagnosticBatchAsync, readDiagnosticEpoch, releaseDiagnosticHandleReset, removeOpenFlowMarker,
  retireUnkeyedDiagnosticBatches, writeOpenFlowMarker,
} from "./diagnostic-store";

export type DiagnosticLevel = "info" | "warning" | "error";

export type DiagnosticDetails = Partial<RequestTimeoutDetails & WaitTimeoutDetails> & {
  cooldownRemainingMs?: number;
  projectionComplete?: boolean;
  commitProtocol?: "immutable_link";
  commitSequence?: number;
  selectionScope?: "query_response" | "display";
  /** account.owner.superseded（承运商复用旧运单号，用户 2026-10-02；与 Pipi 同一事件与字段）。 */
  takeoverReason?: "waybill_reuse";
  fromProvider?: "v5" | "v6" | "manual";
  toProvider?: "v5" | "v6";
  returnedTrackCount?: number;
  displayedTrackCount?: number;
  /** The runtime that wrote the line (D103): the app, a widget, an App Intent or the Shortcut intent host. */
  runtimeHost?: DiagnosticRuntimeHost;
  /** diagnostic.flow.unfinished: the operation that started and never wrote its end line (D4). */
  unfinishedEvent?: string;
  /** diagnostic.flow.unfinished: how long ago that operation started. */
  ageMs?: number;
  /** recognition.online.completed: who cancelled the attempt (D34, D119). */
  cancelReason?: "user" | "superseded" | "settings_saved" | "page_closed" | "deadline";
  /** The lock-screen style of the parcel live activity (D121); `valueKind` stays the JSON type of a reply value. */
  lockScreenStyle?: "dynamic" | "black" | "white";
  /** Which layer published a notification line (AGENTS.md section 10); iOS only has local notifications. */
  pushOrigin?: "app_local";
  /** express.row.*: the row is the user's own sent parcel (the 寄 mark). */
  senderRole?: boolean;
  /** express.row.*: the row has reached the signed freeze. */
  signedFrozen?: boolean;
  /** binding.unbind.completed: the binding was removed on this device only. */
  localOnly?: boolean;
  /** A flow's end line: whether it brought newer evidence or changed stored data. */
  changed?: boolean;
  /** carrier.authority.refreshed: what happened to the meal rule pack offered in the same reply (D113). */
  mealRulesResult?: "accepted" | "rejected" | "absent";
  /**
   * refresh.succeeded / refresh.failed (D158): each phase's duration, folded into the refresh's end line instead of a
   * start and an end line per phase.
   */
  preparationMs?: number;
  accountMs?: number;
  enrichmentMs?: number;
  finalizationMs?: number;
  /** refresh.*: whether the account phase let the refresh go on to per-row work (D158). */
  accountContinued?: boolean;
  /**
   * refresh.* (D201, owner 2026-11-21 「只记失败，成功并入流程终态（推荐）」): the cloud PDD read inside the refresh, folded
   * into its end line: the parcels it returned and whether saving them changed the list.
   */
  cloudPddRecords?: number;
  cloudPddChanged?: boolean;
  /**
   * account.sync.failed (D175, D20): the Worker's own error code, a closed word (the gateway codes); `failureCode` then
   * names the account-list condition with Pipi's codes.
   */
  workerError?: string;
  /** The newest state revision the app's screen had applied when the line was written (D161). */
  appliedRevision?: number;
  /** widget.run.completed (D159): the widget size and the duration of its refresh within the run. */
  widgetSize?: "small" | "medium" | "unsupported";
  refreshMs?: number;
  /** alignment.completed (D25, D183): forced refreshes used for this tuple (of 3) and whether this one counted. */
  alignmentAttempts?: number;
  attemptCounted?: boolean;
  /** alignment.completed: the time until the next forced refresh may run for this tuple. */
  nextAttemptInMs?: number;
  /** activity.parcel.operation.completed (D38, D190): which live surface the operation was for. */
  surface?: "express_live" | "pickup_live" | "handoff_live";
  /** cloud.sync.completed (D29, D188): which synchronized domain the line reports. */
  domain?: "pdd" | "parcel_metadata" | "meal_pickup" | "international" | "parcel_cloud";
  /**
   * detail.timeline.selected (D181, D24): the candidate packages as one compact map, comma-separated fragments
   * `provider:selected|available|empty:count:full|part:gate:0|aN|bN` (N minutes ahead or behind the selected package).
   */
  candidateMap?: string;
  /** order.projection.* (D4): why a union page attempt opened; carried by the attempt's end line. */
  projectionReason?: "timeline_reopen" | "forced" | "scheduled";
  /** storage.retention.applied (D237, D245): rows hidden by the signed or cancelled windows and rows deleted. */
  hiddenRecords?: number;
  removedRecords?: number;
  // Relative times (D6, owner 2026-11-21 「改成相对量（推荐）」): the logger turns every absolute business time
  // below (`*AtMs`) into its distance from the line's own time before the line is kept.
  listEventAgeMs?: number;
  preparedEventAgeMs?: number;
  previousFeedEventAgeMs?: number;
  mergedFeedEventAgeMs?: number;
  carrierFetchedAgeMs?: number;
  carrierLastAttemptAgeMs?: number;
  foreignAnchorAgeMs?: number;
  earliestTrackAgeMs?: number;
  headlineAgeMs?: number;
  detailAgeMs?: number;
  providerLastAttemptAgeMs?: number;
  providerNextDueInMs?: number;
  latestEventAgeMs?: number;
  latestTrackAgeMs?: number;
  feedEventAgeMs?: number;
  statusEventAgeMs?: number;
  sqliteOpenAvailable?: boolean;
  sharedFilesAvailable?: boolean;
  carrierTableVersion?: string;
  carrierFetchedAtMs?: number;
  carrierLastAttemptAtMs?: number;
  carrierRefreshRemainingMs?: number;
  hotlinePresent?: boolean;
  hotlineMatchesExpected?: boolean;
  flowId?: string;
  blockingFlowId?: string;
  blockingTrigger?: string;
  readDurationMs?: number;
  writeDurationMs?: number;
  /** Notification replay scheduling phase, including preparation and the host wait. */
  scheduleDurationMs?: number;
  verifyDurationMs?: number;
  pruneDurationMs?: number;
  blockingLeaseAgeMs?: number;
  blockingLeaseRemainingMs?: number;
  source?: BindingSource;
  requestedSource?: BindingSource;
  handlerSource?: BindingSource;
  activeSource?: BindingSource;
  baseActiveSource?: BindingSource;
  baseRevision?: number;
  revision?: number;
  resultRevision?: number;
  v5Bindings?: number;
  attempted?: number;
  candidateCount?: number;
  availableCandidateCount?: number;
  candidateEligible?: boolean;
  cainiaoFallbackActive?: boolean;
  captureComplete?: boolean;
  hasPickup?: boolean;
  foreignPackage?: boolean;
  foreignAnchorAtMs?: number;
  earliestTrackAtMs?: number;
  waybillMatches?: boolean;
  waybillMatchesOrder?: boolean;
  incompleteReason?: string;
  attempt?: number;
  mode?: "manual" | "refresh" | "last_detail";
  upstreamCode?: number;
  valueKind?: string;
  redirectPresent?: boolean;
  succeeded?: number;
  failed?: number;
  pendingNotifications?: number;
  rawRecords?: number;
  records?: number;
  rejectedRecords?: number;
  orders?: number;
  requestedOrderCount?: number;
  matchedOrderCount?: number;
  /** Accepted metadata only; an image address does not prove a decoded image. */
  realWaybillCount?: number;
  imageURLCount?: number;
  productImageCount?: number;
  purpose?: "waybill" | "image";
  ambiguousOrderCount?: number;
  enhancedMode?: boolean;
  productImagePresent?: boolean;
  routableOrders?: number;
  ownerFingerprint?: string;
  waybillTail?: string;
  sourceProvider?: string;
  carrierCode?: string;
  /** The raw platform code the source sent (JD/JDKD…), before recognition. */
  rawCarrierCode?: string;
  /** Whitelisted StatusSemantic value. */
  statusSemantic?: string;
  listStateNumber?: number;
  listStatusScope?: "ORDER" | "SHIPMENT" | "unknown";
  listStatusSemantic?: string;
  preparedStatusSemantic?: string;
  previousFeedStatusSemantic?: string;
  mergedFeedStatusSemantic?: string;
  feedStatusSemantic?: string;
  listEventAtMs?: number;
  preparedEventAtMs?: number;
  previousFeedEventAtMs?: number;
  mergedFeedEventAtMs?: number;
  bindingMatched?: boolean;
  structuredStatus?: boolean;
  detailStatusSemantic?: string;
  latestTrackSemantic?: string;
  missingStatusRefresh?: boolean;
  unprojectedOrder?: boolean;
  detailComplete?: boolean;
  /** What started this refresh: detail_pull / detail_open / identity_projection / status_alignment. */
  trigger?: string;
  /**
   * alignment.completed（用户 2026-10-02 状态对齐强刷；D183 前为 detail.refresh.alignment）：哪一边落后——status_ahead / headline_ahead /
   * detail_behind（与 Pipi ExpressStatusAlignment.reason 同一套）。
   */
  alignmentReason?: "status_ahead" | "headline_ahead" | "detail_behind";
  /** The list headline time the alignment check compared (before its headline swap). */
  headlineAtMs?: number;
  /** The local detail selection's newest timed node the alignment check compared. */
  detailAtMs?: number;
  /** The list already shows the status package's newest node in place of its own headline. */
  headlineAligned?: boolean;
  /** Why a chain ran or was skipped: owner_pickup / jd_h5_complete / cooldown / no_evidence. */
  gateReason?: string;
  routeKind?: string;
  skipReason?: string;
  extractionSource?: string;
  exitReason?: string;
  historyProvider?: string;
  headlineProvider?: string;
  statusProvider?: string;
  selectionReason?: string;
  timelineProvider?: string;
  requestProvider?: string;
  displayTimelineProvider?: string;
  finalTimelineProvider?: string;
  detailTimelineProvider?: string;
  executionBoundary?: "per_stage" | "host_budget";
  scriptVersion?: string;
  clientBuild?: number;
  httpStatus?: number;
  failureCode?: string;
  authRuntime?: string;
  durationMs?: number;
  budgetMs?: number;
  blockedMs?: number;
  deadlineLagMs?: number;
  /** Widget timeline cadence: wall time since this widget last started a run. */
  sincePreviousMs?: number;
  /** The reload delay this widget run asked WidgetKit for. */
  reloadAfterMs?: number;
  cooldownReason?: string;
  providerLastAttemptAtMs?: number;
  providerNextDueAtMs?: number;
  providerFailures?: number;
  loadSettled?: boolean;
  loadCompleted?: boolean;
  mainPresent?: boolean;
  parsedScriptCount?: number;
  lastParsedScript?: string;
  vuePresent?: boolean;
  jqueryPresent?: boolean;
  phoneChallengeVisible?: boolean;
  locationNuMatches?: boolean;
  vmNumMatches?: boolean;
  lastQueriedNumMatches?: boolean;
  vmLoading?: boolean;
  carrierSelected?: boolean;
  carrierCandidateCount?: number;
  allListsCount?: number;
  listsCount?: number;
  queryErrorType?: string;
  rawExtractedCount?: number;
  firstTimePresent?: boolean;
  firstFtimePresent?: boolean;
  firstContextPresent?: boolean;
  firstRowOutcome?: string;
  startupRecovery?: string;
  phoneVerificationAttempted?: boolean;
  timedTrackCount?: number;
  captureSeen?: boolean;
  replayAttempted?: boolean;
  replaySucceeded?: boolean;
  probeInstalled?: boolean;
  probeMatched?: boolean;
  riskControlSeen?: boolean;
  probeRequestCount?: number;
  unionSignalSeen?: boolean;
  unionResourceSeen?: boolean;
  unionResponseStatuses?: string;
  unionPendingCount?: number;
  probeCaptureCount?: number;
  projectionProbeRevision?: number;
  unionFetchResponseCount?: number;
  unionXhrResponseCount?: number;
  unionXhrJsonResponseCount?: number;
  unionBodyReadCount?: number;
  unionBodyReadFailureCount?: number;
  unionBodyParseFailureCount?: number;
  unionBodyNoIdentityCount?: number;
  unionBodyAcceptedCount?: number;
  unionBodyTypeRejectedCount?: number;
  unionBodySizeRejectedCount?: number;
  domModalItemCount?: number;
  fullProgressClicked?: boolean;
  fullProgressControlSeen?: boolean;
  unionResourceBeforeProbe?: boolean;
  domModalHeaderPresent?: boolean;
  domModalWaybillPresent?: boolean;
  resourceReplayBlockReason?: string;
  domMatched?: boolean;
  requestCallbackCount?: number;
  evaluationAttempts?: number;
  evaluationFailures?: number;
  loadDurationMs?: number;
  resourceCount?: number;
  projectionTrackCount?: number;
  viewportHosted?: boolean;
  rawTrackCount?: number;
  validTrackCount?: number;
  effectiveTrackCount?: number;
  detailEffectiveTrackCount?: number;
  orderStagePrepended?: boolean;
  latestEventAtMs?: number;
  latestTrackAtMs?: number;
  feedEventAtMs?: number;
  statusEventAtMs?: number;
  primarySuccessCount?: number;
  primaryReachedTimelineStart?: boolean;
  pageClass?: string;
  readyState?: string;
  visibilityState?: string;
  viewportAvailable?: boolean;
  automatic?: boolean;
  selected?: boolean;
  routePointerPresent?: boolean;
  routePresent?: boolean;
  routeTrusted?: boolean;
  routeCaptured?: boolean;
  waybillPresent?: boolean;
  persisted?: boolean;
  v4QuerySupported?: boolean;
  v4QuerySucceeded?: boolean;
  k100H5Succeeded?: boolean;
  jtH5Succeeded?: boolean;
  kdniaoAttempted?: boolean;
  kdniaoSucceeded?: boolean;
  jdPage?: string;
  jdNativeLoad?: "pending" | "returned_true" | "returned_false" | "rejected";
  result?: string;
  stage?: string;
  stagePhase?: "query" | "parse" | "write";
  errorCategory?: string;
  /** 统一用词（2026-09-05）：这一行归属的接口，v1…v6；手动件省略。 */
  interface?: string;
  /** 统一用词（2026-09-05）：链上的哪一级，见 unifiedLevel()。 */
  level?: string;
  /**
   * recognition.online.*: the configured provider, protocol and model name, like Pipi (owner 2026-11-21: 记上（推荐）;
   * the model name is the owner's own configuration). Closed enums; a model name outside 1–64 letters, digits,
   * `.`, `_` or `-` is left out.
   */
  onlineProvider?: "openai" | "gemini" | "compatible";
  onlineProtocol?: "responses" | "chat_completions" | "gemini";
  onlineModel?: string;
};

export type DiagnosticRuntimeHost = "app" | "widget" | "app_intent" | "shortcut";

export type DiagnosticEntry = {
  id: string;
  at: string;
  level: DiagnosticLevel;
  event: string;
  details: DiagnosticDetails;
};

const DIAGNOSTIC_KEY = "pipi_deliveries_diagnostic_log_v1";
/**
 * Recording is a user switch. Beta defaults to enabled; formal builds require an explicit opt-in.
 */
const DIAGNOSTIC_ENABLED_KEY = "pipi_deliveries_diagnostic_enabled_v1";
/** The beta SCRIPT_VERSION that last turned recording back on; shared like the switch itself. */
const DIAGNOSTIC_BETA_VERSION_KEY = "pipi_deliveries_diagnostic_beta_version_v1";
// A single foreground refresh can emit dozens of causally related stage records.
// Keep enough history to preserve several complete refresh flows for diagnosis.
const MAX_RECORDS = 200;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOSED_FLOWS = 256;
const SAFE_TEXT = /^[A-Za-z0-9._:-]{1,64}$/;
const SOURCES = new Set<BindingSource>([SCRIPT_BINDING_SOURCE]);
const closedFlowIds = new Set<string>();
const flowTriggers = new Map<string, string>();
const bufferedEntries: DiagnosticEntry[] = [];
const FLUSH_RECORDS = 20;
let flushScheduled = false;
let bufferedEpoch: string | undefined;
type DiagnosticPublication = { id: string; epoch: string; entries: DiagnosticEntry[]; bufferedIds: Set<string> };
let pendingPublication: DiagnosticPublication | undefined;
let appDiagnosticWrites = false;
let appFlushRequested = false;
let appFlush: Promise<void> | undefined;

const JD_PROBE_COUNT_KEYS = new Set<keyof DiagnosticDetails>([
  "unionFetchResponseCount", "unionXhrResponseCount", "unionXhrJsonResponseCount",
  "unionBodyReadCount", "unionBodyReadFailureCount", "unionBodyParseFailureCount",
  "unionBodyNoIdentityCount", "unionBodyAcceptedCount", "unionBodyTypeRejectedCount",
  "unionBodySizeRejectedCount", "domModalItemCount",
]);

const ENHANCEMENT_COUNT_KEYS = new Set<keyof DiagnosticDetails>([
  "requestedOrderCount", "matchedOrderCount", "realWaybillCount", "imageURLCount", "productImageCount", "ambiguousOrderCount",
]);

const DETAIL_KEYS = new Set<keyof DiagnosticDetails>([
  "listStateNumber", "listStatusScope", "listStatusSemantic", "preparedStatusSemantic",
  "previousFeedStatusSemantic", "mergedFeedStatusSemantic", "feedStatusSemantic",
  "listEventAtMs", "preparedEventAtMs", "previousFeedEventAtMs", "mergedFeedEventAtMs", "bindingMatched",
  "commitProtocol", "commitSequence",
  "runtimeHost", "sqliteOpenAvailable", "sharedFilesAvailable",
  "carrierTableVersion", "carrierFetchedAtMs", "carrierLastAttemptAtMs", "carrierRefreshRemainingMs",
  "hotlinePresent", "hotlineMatchesExpected",
  "waitTimeoutOrigin", "waitBudgetMs", "waitElapsedMs",
  "selectionScope", "returnedTrackCount", "displayedTrackCount",
  "readDurationMs", "writeDurationMs", "scheduleDurationMs", "verifyDurationMs", "pruneDurationMs",
  "blockingFlowId", "blockingTrigger", "blockingLeaseAgeMs", "blockingLeaseRemainingMs",
  "timeoutOrigin", "requestPhase", "requestBudgetMs", "requestElapsedMs", "responseHeadersAfterMs", "responseBodyAfterMs",
  "requestId", "signalAbortAfterMs", "callerSettledAfterMs",
  "foreignAnchorAtMs", "earliestTrackAtMs",
  "hasPickup", "foreignPackage", "waybillMatches", "waybillMatchesOrder",
  "candidateCount", "availableCandidateCount", "captureComplete", "incompleteReason",
  "candidateEligible", "cainiaoFallbackActive",
  "requestProvider", "displayTimelineProvider",
  "historyProvider", "headlineProvider", "statusProvider", "selectionReason",
  "interface",
  "takeoverReason", "fromProvider", "toProvider",
  "alignmentReason", "headlineAtMs", "detailAtMs", "headlineAligned",
  "level",
  "flowId",
  "source",
  "requestedSource",
  "handlerSource",
  "activeSource",
  "baseActiveSource",
  "baseRevision",
  "revision",
  "resultRevision",
  "v5Bindings",
  "attempted",
  "attempt",
  "mode",
  "upstreamCode",
  "valueKind",
  "redirectPresent",
  "succeeded",
  "failed",
  "pendingNotifications",
  "rawRecords",
  "records",
  "rejectedRecords",
  "orders",
  "requestedOrderCount", "matchedOrderCount", "realWaybillCount", "imageURLCount", "productImageCount", "ambiguousOrderCount", "purpose",
  "enhancedMode", "productImagePresent",
  "routableOrders",
  "ownerFingerprint",
  "waybillTail",
  "sourceProvider",
  "carrierCode",
  "rawCarrierCode",
  "statusSemantic",
  "structuredStatus",
  "detailStatusSemantic",
  "latestTrackSemantic",
  "missingStatusRefresh",
  "unprojectedOrder",
  "detailComplete",
  "trigger",
  "gateReason",
  "routeKind",
  "skipReason",
  "extractionSource",
  "exitReason",
  "timelineProvider",
  "finalTimelineProvider",
  "detailTimelineProvider",
  "executionBoundary",
  "scriptVersion",
  "clientBuild",
  "httpStatus",
  "failureCode",
  "authRuntime",
  "durationMs",
  "budgetMs",
  "blockedMs",
  "deadlineLagMs",
  "sincePreviousMs",
  "reloadAfterMs",
  "projectionTrackCount",
  "cooldownRemainingMs",
  "cooldownReason", "providerLastAttemptAtMs", "providerNextDueAtMs", "providerFailures",
  "loadSettled",
  "loadCompleted",
  "mainPresent",
  "parsedScriptCount",
  "lastParsedScript",
  "vuePresent",
  "jqueryPresent",
  "phoneChallengeVisible",
  "locationNuMatches",
  "vmNumMatches",
  "lastQueriedNumMatches",
  "vmLoading",
  "carrierSelected",
  "carrierCandidateCount",
  "allListsCount",
  "listsCount",
  "queryErrorType",
  "rawExtractedCount",
  "firstTimePresent",
  "firstFtimePresent",
  "firstContextPresent",
  "firstRowOutcome",
  "startupRecovery",
  "phoneVerificationAttempted",
  "timedTrackCount",
  "captureSeen",
  "replayAttempted",
  "replaySucceeded",
  "probeInstalled",
  "probeMatched",
  "riskControlSeen",
  "probeRequestCount",
  "unionSignalSeen",
  "unionResourceSeen",
  "unionResponseStatuses",
  "unionPendingCount",
  "probeCaptureCount",
  "projectionProbeRevision",
  ...JD_PROBE_COUNT_KEYS,
  "fullProgressClicked",
  "fullProgressControlSeen",
  "unionResourceBeforeProbe",
  "domModalHeaderPresent",
  "domModalWaybillPresent",
  "resourceReplayBlockReason",
  "domMatched",
  "requestCallbackCount",
  "evaluationAttempts",
  "evaluationFailures",
  "loadDurationMs",
  "resourceCount",
  "rawTrackCount",
  "validTrackCount",
  "effectiveTrackCount",
  "detailEffectiveTrackCount",
  "orderStagePrepended",
  "latestEventAtMs",
  "latestTrackAtMs",
  "feedEventAtMs",
  "statusEventAtMs",
  "primarySuccessCount",
  "primaryReachedTimelineStart",
  "pageClass",
  "readyState",
  "visibilityState",
  "viewportAvailable",
  "viewportHosted",
  "projectionComplete",
  "automatic",
  "selected",
  "routePointerPresent",
  "routePresent",
  "routeTrusted",
  "routeCaptured",
  "waybillPresent",
  "persisted",
  "v4QuerySupported",
  "v4QuerySucceeded",
  "k100H5Succeeded",
  "jtH5Succeeded",
  "kdniaoAttempted",
  "kdniaoSucceeded",
  "jdPage", "jdNativeLoad",
  "result",
  "stage",
  "stagePhase",
  "errorCategory",
  "onlineProvider", "onlineProtocol", "onlineModel",
]);

/**
 * D6 (owner 2026-11-21 「改成相对量（推荐）」): absolute business times are not kept. Each key on the left is replaced by
 * its distance from the line's own time: a past time by its age, a due time by the time left. An absent time (zero or
 * not a number) is left out, and a time on the wrong side of the line's time counts as zero.
 */
const RELATIVE_TIME_KEYS: Readonly<Partial<Record<keyof DiagnosticDetails, Readonly<{ key: keyof DiagnosticDetails; due?: true }>>>> = {
  listEventAtMs: { key: "listEventAgeMs" },
  preparedEventAtMs: { key: "preparedEventAgeMs" },
  previousFeedEventAtMs: { key: "previousFeedEventAgeMs" },
  mergedFeedEventAtMs: { key: "mergedFeedEventAgeMs" },
  carrierFetchedAtMs: { key: "carrierFetchedAgeMs" },
  carrierLastAttemptAtMs: { key: "carrierLastAttemptAgeMs" },
  foreignAnchorAtMs: { key: "foreignAnchorAgeMs" },
  earliestTrackAtMs: { key: "earliestTrackAgeMs" },
  headlineAtMs: { key: "headlineAgeMs" },
  detailAtMs: { key: "detailAgeMs" },
  providerLastAttemptAtMs: { key: "providerLastAttemptAgeMs" },
  providerNextDueAtMs: { key: "providerNextDueInMs", due: true },
  latestEventAtMs: { key: "latestEventAgeMs" },
  latestTrackAtMs: { key: "latestTrackAgeMs" },
  feedEventAtMs: { key: "feedEventAgeMs" },
  statusEventAtMs: { key: "statusEventAgeMs" },
};
for (const [absolute, relative] of Object.entries(RELATIVE_TIME_KEYS)) {
  DETAIL_KEYS.delete(absolute as keyof DiagnosticDetails);
  DETAIL_KEYS.add(relative!.key);
}
for (const key of ["runtimeHost", "unfinishedEvent", "ageMs", "cancelReason", "lockScreenStyle", "pushOrigin",
  "senderRole", "signedFrozen", "localOnly", "changed", "mealRulesResult",
  "preparationMs", "accountMs", "enrichmentMs", "finalizationMs", "accountContinued", "appliedRevision",
  "widgetSize", "refreshMs", "alignmentAttempts", "attemptCounted", "nextAttemptInMs", "surface", "domain",
  "hiddenRecords", "removedRecords", "candidateMap", "projectionReason", "cloudPddRecords", "cloudPddChanged",
  "workerError"] as const) DETAIL_KEYS.add(key);

/** The detail keys a kept line can hold (D170: the log page reads no other key). */
export const DIAGNOSTIC_DETAIL_KEYS: ReadonlySet<string> = DETAIL_KEYS as ReadonlySet<string>;

/** Replaces absolute business times with their distance from `referenceMs` (D6). */
function withRelativeTimes(details: DiagnosticDetails, referenceMs: number): DiagnosticDetails {
  let result: DiagnosticDetails | undefined;
  for (const [absolute, relative] of Object.entries(RELATIVE_TIME_KEYS)) {
    if (!(absolute in details)) continue;
    result ??= { ...details };
    const value = Number((details as Record<string, unknown>)[absolute]);
    delete (result as Record<string, unknown>)[absolute];
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(referenceMs)) continue;
    (result as Record<string, unknown>)[relative!.key] = Math.max(0, relative!.due ? value - referenceMs : referenceMs - value);
  }
  return result ?? details;
}

/** The operations that record one end line with their duration and may be reported unfinished (D4). */
const TRACKED_FLOW_EVENTS = new Set<string>([
  "platform.identity", "platform.parcel_sync", "platform.cabinet", "platform.parcel_detail", "platform.account.code",
  "cloud.pdd", "cloud.parcel.metadata", "meal.sync", "cloud.sync",
  "shortcut.screen", "shortcut.query", "shortcut.phone_tail", "activity.parcel.operation", "pickup.action",
  "recognition.online", "account.enhanced.operation", "binding.unbind", "app.startup", "home.query",
  // Top-level flows whose start is merged into their end line (D4 applied to every iOS start line, step 5).
  "refresh", "detail.refresh", "widget.run", "notification.replay", "binding.code", "binding.verify", "order.projection",
]);
const RUNTIME_HOSTS = new Set<DiagnosticRuntimeHost>(["app", "widget", "app_intent", "shortcut"]);
const CANCEL_REASONS = new Set(["user", "superseded", "settings_saved", "page_closed", "deadline"]);
const LOCK_SCREEN_STYLES = new Set(["dynamic", "black", "white"]);
const MEAL_RULES_RESULTS = new Set(["accepted", "rejected", "absent"]);
const WIDGET_SIZES = new Set(["small", "medium", "unsupported"]);
const CANDIDATE_FRAGMENT = "[a-z][a-z0-9_]{1,15}:(?:selected|available|empty):\\d{1,4}:(?:full|part):[a-z][a-z0-9_]{1,31}:(?:0|[ab]\\d{1,7})";
const CANDIDATE_MAP = new RegExp(`^${CANDIDATE_FRAGMENT}(?:,${CANDIDATE_FRAGMENT}){0,15}$`);
const LIVE_SURFACES = new Set(["express_live", "pickup_live", "handoff_live"]);
const CLOUD_DOMAINS = new Set(["pdd", "parcel_metadata", "meal_pickup", "international", "parcel_cloud"]);

/**
 * D11 (owner 2026-11-21 「三项都改（推荐）」): the kind of page a JD web read stopped on, as a closed enum. No host name,
 * path or query is kept. Older lines that stored `scheme:host` read back through the same classification.
 */
const JD_PAGE_KINDS = new Set(["jd_login", "jd_account", "jd_orders", "jd_other", "web_other", "error_page",
  "local_page", "other"]);

const ONLINE_PROVIDERS = new Set(["openai", "gemini", "compatible"]);
const ONLINE_PROTOCOLS = new Set(["responses", "chat_completions", "gemini"]);
const ONLINE_MODEL = /^[A-Za-z0-9._-]{1,64}$/;

const SOURCE_KEYS = new Set<keyof DiagnosticDetails>([
  "source",
  "requestedSource",
  "handlerSource",
  "activeSource",
  "baseActiveSource",
]);

const NUMBER_KEYS = new Set<keyof DiagnosticDetails>([
  "providerLastAttemptAtMs", "providerNextDueAtMs", "providerFailures",
  "pendingNotifications",
  "listEventAtMs", "preparedEventAtMs", "previousFeedEventAtMs", "mergedFeedEventAtMs",
  "commitSequence",
  "carrierFetchedAtMs", "carrierLastAttemptAtMs", "carrierRefreshRemainingMs",
  "waitBudgetMs", "waitElapsedMs", "returnedTrackCount", "displayedTrackCount",
  "readDurationMs", "writeDurationMs", "scheduleDurationMs", "verifyDurationMs", "pruneDurationMs",
  "blockingLeaseAgeMs", "blockingLeaseRemainingMs",
  "requestBudgetMs", "requestElapsedMs", "responseHeadersAfterMs", "responseBodyAfterMs",
  "signalAbortAfterMs", "callerSettledAfterMs",
  "foreignAnchorAtMs", "earliestTrackAtMs",
  "candidateCount", "availableCandidateCount",
  "headlineAtMs", "detailAtMs",
  "baseRevision",
  "revision",
  "resultRevision",
  "v5Bindings",
  "attempted",
  "succeeded",
  "failed",
  "rawRecords",
  "records",
  "rejectedRecords",
  "orders",
  "routableOrders",
  "httpStatus",
  "durationMs",
  "budgetMs",
  "blockedMs",
  "deadlineLagMs",
  "sincePreviousMs",
  "reloadAfterMs",
  "projectionTrackCount",
  "cooldownRemainingMs",
  "probeRequestCount",
  "unionPendingCount",
  "requestCallbackCount",
  "evaluationAttempts",
  "evaluationFailures",
  "loadDurationMs",
  "resourceCount",
  "rawTrackCount",
  "validTrackCount",
  "effectiveTrackCount",
  "detailEffectiveTrackCount",
  "latestEventAtMs",
  "latestTrackAtMs",
  "feedEventAtMs",
  "statusEventAtMs",
  "primarySuccessCount",
  "clientBuild",
]);

const BOOLEAN_KEYS = new Set<keyof DiagnosticDetails>([
  "enhancedMode", "productImagePresent",
  "fullProgressClicked", "fullProgressControlSeen", "unionResourceBeforeProbe",
  "domModalHeaderPresent", "domModalWaybillPresent",
  "bindingMatched",
  "headlineAligned",
  "orderStagePrepended",
  "sqliteOpenAvailable", "sharedFilesAvailable", "hotlinePresent", "hotlineMatchesExpected",
  "candidateEligible", "cainiaoFallbackActive",
  "riskControlSeen",
  "hasPickup", "foreignPackage", "waybillMatches", "waybillMatchesOrder",
  "captureComplete",
  "vuePresent",
  "jqueryPresent",
  "mainPresent",
  "phoneChallengeVisible",
  "locationNuMatches",
  "vmNumMatches",
  "lastQueriedNumMatches",
  "vmLoading",
  "firstTimePresent",
  "firstFtimePresent",
  "firstContextPresent",
  "carrierSelected",
  "phoneVerificationAttempted",
  "redirectPresent",
  "structuredStatus",
  "missingStatusRefresh",
  "unprojectedOrder",
  "detailComplete",
  "loadSettled",
  "loadCompleted",
  "captureSeen",
  "replayAttempted",
  "replaySucceeded",
  "probeInstalled",
  "probeMatched",
  "unionSignalSeen",
  "unionResourceSeen",
  "domMatched",
  "viewportAvailable",
  "viewportHosted",
  "projectionComplete",
  "automatic",
  "selected",
  "routePointerPresent",
  "routePresent",
  "routeTrusted",
  "routeCaptured",
  "waybillPresent",
  "persisted",
  "v4QuerySupported",
  "v4QuerySucceeded",
  "k100H5Succeeded",
  "jtH5Succeeded",
  "primaryReachedTimelineStart",
  "kdniaoAttempted",
  "kdniaoSucceeded",
]);
for (const relative of Object.values(RELATIVE_TIME_KEYS)) NUMBER_KEYS.add(relative!.key);
for (const key of ["ageMs", "preparationMs", "accountMs", "enrichmentMs", "finalizationMs", "appliedRevision",
  "refreshMs", "alignmentAttempts", "nextAttemptInMs", "hiddenRecords", "removedRecords", "cloudPddRecords"] as const) {
  NUMBER_KEYS.add(key);
}
for (const key of ["senderRole", "signedFrozen", "localOnly", "changed", "accountContinued", "attemptCounted",
  "cloudPddChanged"] as const) {
  BOOLEAN_KEYS.add(key);
}

export const SAFE_FAILURE_CODES: ReadonlySet<string> = new Set([
  "attestation_rejected",
  "body_too_large",
  "carrier_mismatch",
  "carrier_unknown",
  // R5-NEW-07 ③: the Worker's cloud-record answers (gateway.ts keeps the same words).
  "cloud_metadata_not_granted",
  "cloud_record_retention_pending",
  "cloud_record_storage_unavailable",
  "cloud_snapshot_changed",
  "cloud_sync_disabled",
  "delegation_unavailable",
  "detail_route_not_reconstructable",
  "expired_request",
  "forbidden",
  "gateway_not_configured",
  "invalid_company_code",
  "invalid_content_length",
  "invalid_express_identity",
  "invalid_express_interface",
  "invalid_express_operation",
  "invalid_cloud_record_identity",
  "invalid_flight_operation",
  "invalid_input",
  "invalid_jd_app_route",
  "invalid_json",
  "invalid_movie_operation",
  "invalid_order_id",
  "invalid_primary_routes",
  "invalid_push_receipt",
  "invalid_query",
  "invalid_railway_operation",
  "invalid_response",
  "invalid_route_credential",
  "invalid_timeline_query",
  "invalid_upstream_response",
  "invalid_waybill",
  "invalid_weather_operation",
  "key_activated_elsewhere",
  "key_store_unavailable",
  "method_not_allowed",
  "network",
  "not_found",
  "phone_tail",
  "phone_verification_required",
  "rate_limited",
  "rejected",
  "replay_store_unavailable",
  "replayed_request",
  "unauthorized",
  "upstream_rejected",
  "upstream_business_error",
  "upstream_unavailable",
]);

/**
 * D175 (D20, plan step 7): the account-list conditions an account.sync.failed line names, the same codes Pipi's
 * account flow writes (PhoneSyncClient, ExpressDiagnosticLog.accountFailure). The Worker's own code goes in
 * `workerError`.
 */
export const ACCOUNT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "account_list_request_failed", "account_list_rejected", "account_list_invalid", "phone_verification_required",
  "cancelled",
]);

/**
 * The fixed failure code and Worker code of an account-list stage that ended without a list (D175): a Worker that
 * answered with its own error code rejected the request; no answer, a timeout or an answer without a code is a failed
 * request; a reply that did not parse is an invalid list. A cancellation by the parent refresh is `cancelled`.
 */
export function accountListFailureDetails(error: unknown): DiagnosticDetails {
  const details = diagnosticErrorDetails(error);
  const workerCode = error && typeof error === "object" && "gatewayCode" in error
    ? String((error as { gatewayCode?: unknown }).gatewayCode || "").trim().toLowerCase() : "";
  const name = error instanceof Error ? error.name : "";
  const failureCode = details.errorCategory === "cancelled" ? "cancelled"
    : workerCode === "phone_verification_required" ? "phone_verification_required"
    : workerCode || (name === "AccountApiError" && details.failureCode === "upstream_rejected")
      ? "account_list_rejected"
    : name === "AccountParseError" || details.errorCategory === "protocol" ? "account_list_invalid"
    : "account_list_request_failed";
  const { failureCode: _code, ...rest } = details;
  return { ...rest, failureCode, ...(workerCode ? { workerError: workerCode } : {}) };
}

function validEntry(value: unknown, now: number): value is DiagnosticEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DiagnosticEntry>;
  const at = typeof item.at === "string" ? new Date(item.at).getTime() : NaN;
  return Boolean(
    typeof item.id === "string" &&
      SAFE_TEXT.test(item.id) &&
      typeof item.event === "string" &&
      SAFE_TEXT.test(item.event) &&
      (item.level === "info" || item.level === "warning" || item.level === "error") &&
      Number.isFinite(at) &&
      at <= now &&
      now - at < MAX_AGE_MS &&
      item.details &&
      typeof item.details === "object" &&
      !Array.isArray(item.details),
  );
}

/**
 * 统一用词（用户定 2026-09-05，三端同一套）：日志里的参数值一律写规范化后的词——接口 v1…v6，
 * 链上的一级写 level 词（v5_list / v5_query / v6_query / v4_query / v2_query / jd_h5 / cn_h5 /
 * k100_h5 / kdniao / k100_autoCom）。调用点还是按各自的类型传旧名，落日志前在这里统一换掉。
 */
const SOURCE_WIRE: Record<string, string> = {
  interface5: "v5",
  interface6: "v6",
};
const STAGE_WIRE: Record<string, string> = {
  account_list: "v5_list",
  account_detail: "v5_query",
  jingdong_h5: "jd_h5",
  cainiao_h5: "cn_h5",
  pinduoduo_h5: "pdd_h5",
  pdd_h5: "pdd_h5",
  kuaidi100_query: "k100_h5",
  web_timeline: "k100_h5",
  picker_query: "v6_query",
  pending_picker: "v6_query",
  route: "v6_query",
  moto_query: "v4_query",
  pending_moto: "v4_query",
  local: "v4_query",
  kdniao_fallback: "kdniao",
  pending_kdniao: "kdniao",
  fallback: "kdniao",
  classify: "k100_autoCom",
  carrier_detect: "k100_autoCom",
};
const PROVIDER_WIRE: Record<string, string> = {
  interface5: "v5_list",
  account: "v5_list",
  v5_list: "v5_list",
  meizu: "v6_query",
  route: "v6_query",
  moto: "v4_query",
  local: "v4_query",
  fallback: "kdniao",
  kuaidi100_h5: "k100_h5",
  kuaidi100: "k100_h5",
  jingdong_h5: "jd_h5",
  cainiao_h5: "cn_h5",
  pinduoduo_h5: "pdd_h5",
  pdd_h5: "pdd_h5",
  web: "cn_h5",
};
const PROVIDER_KEYS = new Set<keyof DiagnosticDetails>([
  "requestProvider", "displayTimelineProvider",
  "timelineProvider",
  "finalTimelineProvider",
  "detailTimelineProvider",
  // Selection evidence names the same packages (audit R10, adopted 2026-09-25): a feed package
  // is written v5_list here too, never its internal id interface5.
  "historyProvider", "headlineProvider", "statusProvider",
]);
const NORMALIZED_SOURCES = new Set(Object.values(SOURCE_WIRE));

function unifiedWire(key: keyof DiagnosticDetails, value: string): string {
  const lower = value.trim().toLowerCase();
  if ((key === "level" || key === "stage" || PROVIDER_KEYS.has(key)) &&
      (lower === "v6_picker" || lower === "meizu_picker")) return "v6_query";
  if (key === "sourceProvider") return ({ cainiao: "cainiao", jingdong: "jingdong",
    shunfeng: "sfexpress", sfexpress: "sfexpress", douyin: "douyin" } as Record<string, string>)[lower] || value;
  if (key === "stage") return STAGE_WIRE[lower] || value;
  if (PROVIDER_KEYS.has(key)) return PROVIDER_WIRE[lower] || value;
  return value;
}

/** A package's provider in the shared log words (2026-09-05), for compact fields that name packages. */
export function diagnosticProviderWord(provider: string): string {
  const wire = unifiedWire("timelineProvider", String(provider || "").trim());
  const lower = wire.toLowerCase();
  return /^[a-z][a-z0-9_]{1,15}$/.test(lower) ? lower : "other";
}

export function jdDiagnosticPage(scheme: unknown, hostname: unknown): string {
  if (typeof scheme !== "string") return "other";
  if (scheme === "webkit-error:") return "error_page";
  if (/^(?:file|data|blob|applewebdata):$/.test(scheme)) return "local_page";
  if (!/^https?:$/.test(scheme)) return "other";
  const host = typeof hostname === "string" && hostname.length <= 55 ? hostname.toLowerCase() : "";
  if (!/^(?:[a-z0-9-]+\.)*(?:jd\.com|jd\.hk|360buyimg\.com)$/.test(host)) return "web_other";
  // The same login hosts the JD reader treats as a signed-out session (platform-web-parcels.ts).
  if (host === "plogin.m.jd.com" || host === "passport.jd.com" || host === "passport.m.jd.com") return "jd_login";
  if (host === "my.m.jd.com" || host === "home.m.jd.com") return "jd_account";
  if (host === "trade.m.jd.com" || host === "o.m.jd.com") return "jd_orders";
  return "jd_other";
}

function sanitizeDetails(value: DiagnosticDetails, event = ""): DiagnosticDetails {
  const result: DiagnosticDetails = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey as keyof DiagnosticDetails;
    if (!DETAIL_KEYS.has(key) || rawValue == null) continue;
    if (key === "jdPage") {
      if (typeof rawValue === "string") {
        const separator = rawValue.indexOf(":");
        if (JD_PAGE_KINDS.has(rawValue)) result.jdPage = rawValue;
        else if (separator > 0) result.jdPage = jdDiagnosticPage(rawValue.slice(0, separator + 1), rawValue.slice(separator + 1));
      }
      continue;
    }
    if (key === "runtimeHost") {
      if (RUNTIME_HOSTS.has(rawValue as DiagnosticRuntimeHost)) result.runtimeHost = rawValue as DiagnosticRuntimeHost;
      continue;
    }
    if (key === "unfinishedEvent") {
      if (typeof rawValue === "string" && TRACKED_FLOW_EVENTS.has(rawValue)) result.unfinishedEvent = rawValue;
      continue;
    }
    if (key === "cancelReason" || key === "lockScreenStyle" || key === "mealRulesResult") {
      const allowed = key === "cancelReason" ? CANCEL_REASONS : key === "lockScreenStyle" ? LOCK_SCREEN_STYLES : MEAL_RULES_RESULTS;
      if (typeof rawValue === "string" && allowed.has(rawValue)) (result as Record<string, unknown>)[key] = rawValue;
      continue;
    }
    if (key === "pushOrigin") {
      if (rawValue === "app_local") result.pushOrigin = rawValue;
      continue;
    }
    if (key === "candidateMap") {
      if (typeof rawValue === "string" && CANDIDATE_MAP.test(rawValue) && !/\d{5,}/.test(rawValue.replace(/:[ab]?\d+(?=,|$)/g, ""))) {
        result.candidateMap = rawValue;
      }
      continue;
    }
    if (key === "projectionReason") {
      if (rawValue === "timeline_reopen" || rawValue === "forced" || rawValue === "scheduled") result.projectionReason = rawValue;
      continue;
    }
    if (key === "widgetSize" || key === "surface" || key === "domain") {
      const allowed = key === "widgetSize" ? WIDGET_SIZES : key === "surface" ? LIVE_SURFACES : CLOUD_DOMAINS;
      if (typeof rawValue === "string" && allowed.has(rawValue)) (result as Record<string, unknown>)[key] = rawValue;
      continue;
    }
    if (key === "jdNativeLoad") {
      if (rawValue === "pending" || rawValue === "returned_true" || rawValue === "returned_false" || rawValue === "rejected") {
        result.jdNativeLoad = rawValue;
      }
      continue;
    }
    if (key === "listStateNumber") {
      if (typeof rawValue === "number" && Number.isInteger(rawValue) && rawValue >= 101 && rawValue <= 111) result[key] = rawValue;
      continue;
    }
    if (key === "purpose") {
      if (rawValue === "waybill" || rawValue === "image") result.purpose = rawValue;
      continue;
    }
    if (key === "alignmentReason") {
      if (rawValue === "status_ahead" || rawValue === "headline_ahead" || rawValue === "detail_behind") {
        result.alignmentReason = rawValue;
      }
      continue;
    }
    if (key === "listStatusScope") {
      if (rawValue === "ORDER" || rawValue === "SHIPMENT" || rawValue === "unknown") result[key] = rawValue;
      continue;
    }
    if (key === "onlineProvider" || key === "onlineProtocol") {
      if (typeof rawValue === "string" && (key === "onlineProvider" ? ONLINE_PROVIDERS : ONLINE_PROTOCOLS).has(rawValue)) {
        (result as Record<string, unknown>)[key] = rawValue;
      }
      continue;
    }
    if (key === "onlineModel") {
      if (typeof rawValue === "string" && ONLINE_MODEL.test(rawValue)) result.onlineModel = rawValue;
      continue;
    }
    if (key === "listStatusSemantic" || key === "preparedStatusSemantic" ||
        key === "previousFeedStatusSemantic" || key === "mergedFeedStatusSemantic" || key === "feedStatusSemantic") {
      if (["UNKNOWN", "ORDERED", "SHIPPED", "PICKED", "TRANSIT", "DELIVERY", "WAITING_PICKUP", "COMPLETED", "CANCELLED", "DANGER"].includes(String(rawValue))) result[key] = String(rawValue);
      continue;
    }
    if (key === "unionResponseStatuses") {
      if (typeof rawValue === "string" && /^(?:0|[1-5]\d{2})(?:,(?:0|[1-5]\d{2})){0,7}$/.test(rawValue)) {
        result.unionResponseStatuses = rawValue;
      }
      continue;
    }
    if (key === "probeCaptureCount") {
      if (typeof rawValue === "number" && Number.isInteger(rawValue) && rawValue >= 0 && rawValue <= 4) {
        result.probeCaptureCount = rawValue;
      }
      continue;
    }
    if (key === "projectionProbeRevision" || JD_PROBE_COUNT_KEYS.has(key) || ENHANCEMENT_COUNT_KEYS.has(key)) {
      const maximum = key === "projectionProbeRevision" ? 100 : 100_000;
      if (typeof rawValue === "number" && Number.isInteger(rawValue) && rawValue >= 0 && rawValue <= maximum) {
        (result as Record<string, unknown>)[key] = rawValue;
      }
      continue;
    }
    if (key === "readyState") {
      if (["loading", "interactive", "complete", "unknown"].includes(rawValue as string)) result.readyState = rawValue as string;
      continue;
    }
    if (key === "timedTrackCount" || key === "parsedScriptCount" ||
        key === "carrierCandidateCount" || key === "allListsCount" || key === "listsCount" || key === "rawExtractedCount") {
      if (typeof rawValue === "number" && Number.isInteger(rawValue) && rawValue >= 0 && rawValue <= 100) result[key] = rawValue;
      continue;
    }
    if (key === "startupRecovery") {
      if (["pending", "applied", "skipped", "failed"].includes(rawValue as string)) result.startupRecovery = rawValue as string;
      continue;
    }
    if (key === "firstRowOutcome") {
      if (["not_object", "missing_time", "missing_detail", "same_text", "not_extracted", "invalid_time", "provider_error", "valid"].includes(rawValue as string)) result.firstRowOutcome = rawValue as string;
      continue;
    }
    if (key === "queryErrorType") {
      if (["", "empty", "network", "none"].includes(rawValue as string)) result.queryErrorType = rawValue as string;
      continue;
    }
    if (key === "lastParsedScript") {
      if (["baidinet", "jquery", "app_base", "promotion", "appGuide", "vue", "result", "inline", "other"].includes(rawValue as string)) result.lastParsedScript = rawValue as string;
      continue;
    }
    if (key === "attempt") {
      // A request retries once; the paid carrier stage allows three attempts in a waybill's life (D124).
      if (rawValue === 1 || rawValue === 2 || rawValue === 3 && event.startsWith("carrier.recognition.")) {
        result.attempt = rawValue;
      }
      continue;
    }
    if (key === "upstreamCode") {
      if (typeof rawValue === "number" && Number.isSafeInteger(rawValue)) result.upstreamCode = rawValue;
      continue;
    }
    if (key === "mode") {
      if (rawValue === "manual" || rawValue === "refresh" || rawValue === "last_detail") result.mode = rawValue;
      continue;
    }
    if (key === "valueKind") {
      if (["missing", "null", "object", "array", "string", "number", "boolean"].includes(rawValue as string)) {
        result.valueKind = rawValue as string;
      }
      continue;
    }
    if (key === "waybillTail") {
      const tail = String(rawValue).trim().toUpperCase();
      if (/^[A-Z0-9]{4}$/.test(tail)) result.waybillTail = tail;
      continue;
    }
    if (key === "cooldownReason") {
      if (["success", "no_result", "invalid_query", "upstream_rejected", "timeout", "network", "failed"].includes(rawValue as string)) {
        result.cooldownReason = rawValue as string;
      }
      continue;
    }
    if (key === "failureCode") {
      const code = String(rawValue).trim().toLowerCase();
      if (SAFE_FAILURE_CODES.has(code) || ACCOUNT_FAILURE_CODES.has(code)) {
        result.failureCode = code;
      }
      continue;
    }
    if (key === "workerError") {
      // A Worker code from the closed gateway list, `other` otherwise, as Pipi's workerErrorCode does.
      const code = String(rawValue).trim().toLowerCase();
      if (code) result.workerError = SAFE_FAILURE_CODES.has(code) ? code : "other";
      continue;
    }
    if (SOURCE_KEYS.has(key)) {
      const raw = String(rawValue);
      const wire = SOURCE_WIRE[raw] || raw;
      if (SOURCES.has(raw as BindingSource) || NORMALIZED_SOURCES.has(wire)) {
        (result as Record<string, unknown>)[key] = wire;
      }
      continue;
    }
    if (NUMBER_KEYS.has(key)) {
      const number = Number(rawValue);
      if (Number.isFinite(number) && number >= 0) {
        (result as Record<string, unknown>)[key] = Math.round(number);
      }
      continue;
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof rawValue === "boolean") {
        (result as Record<string, unknown>)[key] = rawValue;
      }
      continue;
    }
    const text = unifiedWire(key, String(rawValue || "").trim());
    if (diagnosticTextAllowed(key, text)) {
      (result as Record<string, unknown>)[key] = text;
    }
  }
  return result;
}

/**
 * D10 (plan step 7): the remaining text fields hold enumerated words, not free text. An identifier key (a flow or
 * request id, a version, the local order handle) keeps the safe-text shape. A code key (carrier and status codes)
 * takes letters, digits and underscores starting with a letter. Every other key takes a lowercase word of letters,
 * digits and underscores (k100_autoCom keeps its one capital). No word may hold a run of four or more digits, so a
 * waybill, an order number or a phone tail passed by mistake is dropped rather than kept.
 */
const IDENTIFIER_TEXT_KEYS = new Set<keyof DiagnosticDetails>([
  "flowId", "blockingFlowId", "requestId", "scriptVersion", "carrierTableVersion", "ownerFingerprint",
]);
const CODE_TEXT_KEYS = new Set<keyof DiagnosticDetails>([
  "carrierCode", "rawCarrierCode", "statusSemantic", "detailStatusSemantic", "latestTrackSemantic",
]);
const ENUM_WORD = /^[a-z][A-Za-z0-9_]{0,63}$/;
const CODE_WORD = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;

/**
 * D10: the text keys whose words form a known closed set take only those words. The sets follow their owning types
 * (StatusSemantic in models.ts, DetailIncompleteReason in shipment-policy.ts, ShipmentRoute["kind"], the page readers'
 * extraction sources and page classes, classifyDiagnosticError) plus the words older stored lines still carry;
 * tests/diagnostics-log-steps-5-7.test.ts checks every word the code writes against them.
 */
const STATUS_SEMANTIC_WORDS = new Set(["UNKNOWN", "ORDERED", "SHIPPED", "PICKED", "TRANSIT", "DELIVERY",
  "WAITING_PICKUP", "COMPLETED", "CANCELLED", "DANGER"]);
export const CLOSED_TEXT_VALUES: Readonly<Partial<Record<keyof DiagnosticDetails, ReadonlySet<string>>>> = {
  statusSemantic: STATUS_SEMANTIC_WORDS,
  detailStatusSemantic: STATUS_SEMANTIC_WORDS,
  latestTrackSemantic: STATUS_SEMANTIC_WORDS,
  // latest_unknown is an older reason that stored lines may still hold.
  incompleteReason: new Set(["no_tracks", "status_unknown", "status_mismatch", "sf_active", "missing_source_time",
    "missing_pickup", "time_mismatch", "latest_unknown"]),
  routeKind: new Set(["cainiao", "web", "none"]),
  extractionSource: new Set(["data_array", "data_missing", "vue", "dom", "none", "diagnostic", "dom_modal", "script",
    "probe", "replay", "resource_replay"]),
  pageClass: new Set(["jd", "other", "invalid", "feed", "unknown"]),
  visibilityState: new Set(["visible", "hidden", "prerender", "unknown"]),
  interface: new Set(["v1", "v2", "v3", "v4", "v5", "v6"]),
  errorCategory: new Set(["cancelled", "timeout", "upstream", "authorization", "rate_limited", "service", "protocol",
    "validation", "no_result", "removed", "state_changed", "network", "storage", "unknown", "ownership_lost",
    "superseded", "stale_timeline"]),
};

function diagnosticTextAllowed(key: keyof DiagnosticDetails, text: string): boolean {
  if (!SAFE_TEXT.test(text)) return false;
  const closed = CLOSED_TEXT_VALUES[key];
  if (closed) return closed.has(text);
  if (IDENTIFIER_TEXT_KEYS.has(key)) return true;
  if (/\d{4,}/.test(text)) return false;
  return (CODE_TEXT_KEYS.has(key) ? CODE_WORD : ENUM_WORD).test(text);
}

/**
 * 启动 / 回前台刷新的触发名 2026-09-26 由 `foreground_sync` 改为 `foreground`（用户，跨端对齐裁决第 21 条）。
 * 新写入由 sync.ts 直接写 `foreground`；存盘的旧日志不改写，只在读取时翻译（trigger 与记录阻塞方
 * 触发名的 blockingTrigger 同一口径）。
 */
const LEGACY_TRIGGER_WIRE: Record<string, string> = {
  foreground_sync: "foreground",
};

function readLegacyTriggers(details: DiagnosticDetails): DiagnosticDetails {
  const result = { ...details };
  for (const key of ["trigger", "blockingTrigger"] as const) {
    const value = result[key];
    if (value && LEGACY_TRIGGER_WIRE[value]) result[key] = LEGACY_TRIGGER_WIRE[value];
  }
  return result;
}

function cleanStoredEntry(entry: DiagnosticEntry, translate = true): DiagnosticEntry {
  // A line kept before D6 still holds absolute times; they read back relative to that line's own time.
  const details = sanitizeDetails(withRelativeTimes(entry.details, Date.parse(entry.at)), entry.event);
  if (translate && entry.event.startsWith("carrier.authority.") && details.carrierCode === "HTKY") delete details.carrierCode;
  return { id: entry.id, at: entry.at, level: entry.level, event: entry.event,
    details: translate ? readLegacyTriggers(details) : details };
}

function storedEntries(now = Date.now(), sanitize = false): DiagnosticEntry[] {
  let legacy: unknown = null;
  let epoch = "legacy";
  let files: ReturnType<typeof diagnosticFiles> = [];
  try {
    epoch = diagnosticEpoch();
    files = diagnosticFiles(epoch);
    if (epoch === "legacy" && !diagnosticLegacyImported()) legacy = Storage.get(DIAGNOSTIC_KEY, { shared: true });
  } catch {
    // Without the current clear epoch, an old shared array cannot safely become visible again.
  }
  const rows = [
    ...(Array.isArray(legacy) ? legacy.map((value, index) => ({ value, path: "", order: `0-${String(index).padStart(4, "0")}` })) : []),
    ...files,
  ].filter((row): row is { value: DiagnosticEntry; path: string; order: string } => validEntry(row.value, now));
  rows.sort((a, b) => a.order.localeCompare(b.order));
  const unique = new Map<string, typeof rows[number]>();
  for (const row of rows) unique.set(row.value.id, row);
  const kept = [...unique.values()].slice(-MAX_RECORDS);
  if (sanitize) {
    if (epoch === "legacy" && Array.isArray(legacy) && legacy.length
      && !legacy.some(entry => validEntry(entry, now))) {
      try { migrateLegacyDiagnostics(now); } catch { /* Legacy cleanup remains retryable. */ }
    }
    // Another runtime can publish after this read's clock snapshot; it is not an expired record.
    const observed = files.filter(row => !(row.value && typeof row.value === "object"
      && typeof (row.value as DiagnosticEntry).at === "string" && Date.parse((row.value as DiagnosticEntry).at) > now));
    try { pruneDiagnosticFiles(new Set(kept.map(row => row.path)), epoch, observed); }
    catch { /* Optional cleanup retries at the next boundary. */ }
  }
  return kept.map(row => sanitize ? cleanStoredEntry(row.value) : row.value);
}

function legacyDiagnosticEntries(now: number): DiagnosticEntry[] | undefined {
  if (diagnosticLegacyImported()) return;
  let value: unknown;
  try { value = Storage.get(DIAGNOSTIC_KEY, { shared: true }); } catch { return; }
  return Array.isArray(value) ? value.filter(entry => validEntry(entry, now)).slice(-MAX_RECORDS)
    .map(entry => cleanStoredEntry(entry, false)) : [];
}

function retireLegacyDiagnostics(): void {
  markDiagnosticLegacyImported();
  try { Storage.remove(DIAGNOSTIC_KEY, { shared: true }); }
  catch { /* Published immutable records remain authoritative if legacy cleanup fails. */ }
}

function migrateLegacyDiagnostics(now: number): void {
  if (diagnosticEpoch() !== "legacy") return;
  const entries = legacyDiagnosticEntries(now);
  if (!entries) return;
  if (entries.length) publishDiagnosticBatch(diagnosticBatchId(), "legacy", entries, true);
  retireLegacyDiagnostics();
}

let flowSequence = Math.floor(Math.random() * 1024);

/**
 * D8 (owner 2026-11-21 「三项都改（推荐）」): a flow id is a non-negative number, generated locally from the clock and a
 * per-runtime sequence, as Pipi's AppDiagnosticLog.newFlowId does: `(epochMs << 10) ^ (sequence & 0x3ff)`. The start time
 * of a flow can be read back from its id (D4). It is written as decimal digits so lease records and map keys keep their
 * string type. `_kind` names the flow at the call site only; it is not part of the id.
 */
export function createDiagnosticFlowId(_kind?: string): string {
  flowSequence = (flowSequence + 1) & 0x3ff;
  return String(Math.max(0, Date.now()) * 1024 + flowSequence);
}

/** The runtime this script session writes from (D103); entrypoints set it before their first line. */
let runtimeHost: DiagnosticRuntimeHost | undefined;

export function setDiagnosticRuntimeHost(host: DiagnosticRuntimeHost): void {
  runtimeHost = host;
}

export function diagnosticRuntimeHost(): DiagnosticRuntimeHost | undefined {
  return runtimeHost;
}

/**
 * D161: the newest revision the app's screen applied. The app's state hook reports it instead of writing a line per
 * applied state; a refresh's end line carries it, so the log still shows whether the screen received the new revision.
 */
let appliedRevision: number | undefined;

export function noteDiagnosticAppliedRevision(revision: number): void {
  if (Number.isFinite(revision) && revision >= 0) appliedRevision = Math.max(appliedRevision ?? 0, revision);
}

export function diagnosticAppliedRevision(): number | undefined {
  return appliedRevision;
}

/**
 * D7 (owner 2026-11-21 「保留尾号写成例外，订单指纹换句柄（推荐）」): a local handle for a value that must not be written
 * itself, such as a JD order number. It is a keyed SHA-256 with a random key that stays on this device and changes
 * when the log is cleared, so the same order reads alike within one log, while the handle cannot be reversed or
 * matched against an order number without the key. Returns "" while recording is off or no key can be kept.
 */
const HANDLE_KEY = "pipi_deliveries_diagnostic_handle_key_v1";
let handleKey: string | undefined;

const HANDLE_KEY_PATTERN = /^[0-9a-f]{32,64}$/;

function diagnosticHandleKey(): string {
  if (handleKey) return handleKey;
  try {
    const stored = Storage.get<string>(HANDLE_KEY, { shared: true });
    if (typeof stored === "string" && HANDLE_KEY_PATTERN.test(stored)) return handleKey = stored;
  } catch { /* A new key is generated below. */ }
  let generated = "";
  try { generated = Crypto.generateSymmetricKey(256).toHexString().toLowerCase(); } catch { /* Fallback below. */ }
  // A host without the native key generator keeps a key for this runtime only.
  if (!HANDLE_KEY_PATTERN.test(generated)) {
    generated = Array.from({ length: 4 }, () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0")).join("");
  }
  try { Storage.set(HANDLE_KEY, generated, { shared: true }); } catch { /* The key stays in this runtime. */ }
  return handleKey = generated;
}

export function diagnosticHandle(scope: string, value: string): string {
  if (!value || !diagnosticsEnabled()) return "";
  try {
    return sha256Hex(`${diagnosticHandleKey()}\u0000${scope}\u0000${value}`).slice(0, 12);
  } catch {
    return "";
  }
}

function retireDiagnosticHandleKey(): void {
  handleKey = undefined;
  try { Storage.remove(HANDLE_KEY, { shared: true }); } catch { /* A later handle generates its own key. */ }
}

/**
 * D4 (owner 2026-11-21 「开始并入终态，卡住另记（推荐）」): an operation writes no start line, only its end line with
 * its duration. While it runs, a small marker is kept on the device; a marker left by an earlier runtime and older than
 * UNFINISHED_AFTER_MS is reported as `diagnostic.flow.unfinished` when the next runtime starts, then dropped.
 * R5-NEW-11 ⑥: each marker is its own file (diagnostic-store `writeOpenFlowMarker`), so runtimes never rewrite each
 * other's markers. The shared map that builds before it kept under OPEN_FLOWS_KEY is moved into those files once.
 */
const OPEN_FLOWS_KEY = "pipi_deliveries_diagnostic_open_flows_v1";
const OPEN_FLOW_LIMIT = 32;
const UNFINISHED_AFTER_MS = 10 * 60 * 1000;
const runtimeInstance = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
type OpenFlow = { event: string; startedAtMs: number; runtime: string; host?: DiagnosticRuntimeHost };

function openFlowRecord(value: unknown): OpenFlow | null {
  const flow = value as Partial<OpenFlow> | null;
  if (!flow || typeof flow !== "object" || typeof flow.event !== "string" || !TRACKED_FLOW_EVENTS.has(flow.event) ||
      typeof flow.startedAtMs !== "number" || !Number.isFinite(flow.startedAtMs) ||
      typeof flow.runtime !== "string") return null;
  return { event: flow.event, startedAtMs: flow.startedAtMs, runtime: flow.runtime,
    ...(RUNTIME_HOSTS.has(flow.host as DiagnosticRuntimeHost) ? { host: flow.host } : {}) };
}

function openFlowFile(flowId: string, event: string): string {
  return `${flowId}-${event}.json`;
}

/** The open markers by file name, with their flow id. */
function readOpenFlows(): { name: string; flowId: string; flow: OpenFlow }[] {
  const flows: { name: string; flowId: string; flow: OpenFlow }[] = [];
  for (const { name, text } of openFlowMarkers()) {
    let flow: OpenFlow | null = null;
    try { flow = openFlowRecord(JSON.parse(text)); } catch { /* A marker being written is read again later. */ }
    const flowId = name.slice(0, name.indexOf("-"));
    if (flow && name === openFlowFile(flowId, flow.event)) flows.push({ name, flowId, flow });
  }
  return flows;
}

function clearOpenFlows(): void {
  try { clearOpenFlowMarkers(); } catch { /* A lost marker only loses an unfinished report. */ }
  try { Storage.remove(OPEN_FLOWS_KEY, { shared: true }); } catch { /* Moved or dropped by the next report. */ }
}

/**
 * Moves the shared map of builds before R5-NEW-11 ⑥ into marker files, once, so what such a build left open is still
 * reported. Entries were keyed by `<flowId>:<event>`, or by the flow id alone before that keying.
 */
function migrateLegacyOpenFlows(): void {
  let raw: unknown;
  try { raw = Storage.get<string>(OPEN_FLOWS_KEY, { shared: true }); } catch { return; }
  if (raw == null) return;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) as unknown : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const flowId = key.split(":")[0]!;
        const flow = openFlowRecord(value);
        if (!flow || !/^\d{1,17}$/.test(flowId) || key !== flowId && key !== `${flowId}:${flow.event}`) continue;
        writeOpenFlowMarker(openFlowFile(flowId, flow.event), JSON.stringify(flow));
      }
    }
    Storage.remove(OPEN_FLOWS_KEY, { shared: true });
  } catch { /* The next runtime moves what is left. */ }
}

function openDiagnosticFlow(flowId: string, event: string, startedAtMs: number): void {
  if (!TRACKED_FLOW_EVENTS.has(event) || !diagnosticsEnabled()) return;
  try {
    writeOpenFlowMarker(openFlowFile(flowId, event), JSON.stringify(
      { event, startedAtMs, runtime: runtimeInstance, ...(runtimeHost ? { host: runtimeHost } : {}) }));
    const flows = readOpenFlows();
    if (flows.length <= OPEN_FLOW_LIMIT) return;
    flows.sort((left, right) => left.flow.startedAtMs - right.flow.startedAtMs);
    for (const { name } of flows.slice(0, flows.length - OPEN_FLOW_LIMIT)) removeOpenFlowMarker(name);
  } catch { /* A lost marker only loses an unfinished report. */ }
}

function closeDiagnosticFlow(flowId: string, event: string): void {
  try { removeOpenFlowMarker(openFlowFile(flowId, event)); }
  catch { /* A marker left behind is reported once by a later runtime. */ }
}

/**
 * Called once by each entrypoint (app, widget, App Intent, Shortcut) after it names its runtime: one warning line for
 * every operation an earlier runtime started and never ended (D4 「上次未结束」). Markers older than the log's own
 * seven days are dropped without a line. Runtimes that start together report each marker once: the one that claims it.
 */
export function reportUnfinishedDiagnosticFlows(now = Date.now()): void {
  if (!diagnosticsEnabled()) return;
  migrateLegacyOpenFlows();
  let flows: ReturnType<typeof readOpenFlows> = [];
  try { flows = readOpenFlows(); } catch { return; }
  for (const { name, flowId, flow } of flows) {
    if (flow.runtime === runtimeInstance || now - flow.startedAtMs < UNFINISHED_AFTER_MS) continue;
    if (!claimOpenFlowMarker(name, runtimeInstance)) continue;
    if (now - flow.startedAtMs >= MAX_AGE_MS) continue;
    writeDiagnostic("diagnostic.flow.unfinished", {
      flowId, unfinishedEvent: flow.event, ageMs: now - flow.startedAtMs,
      ...(flow.host ? { runtimeHost: flow.host } : {}),
    }, "warning");
  }
}

export function diagnosticState(state: AppState): DiagnosticDetails {
  return {
    activeSource: SCRIPT_BINDING_SOURCE,
    revision: state.revision,
    v5Bindings: state.bindings.filter(
      (binding) => binding.source === "interface5",
    ).length,
  };
}

/**
 * R5-NEW-07 ③: a parcel provider's PlatformWireError (platform-wire.ts) names its reason; it reads in the same categories
 * as Pipi's PDD lines (ExpressDiagnosticLog.pddCategory): an expired or verification-gated login is an authorization
 * failure, an unavailable answer a service failure and a changed session a validation failure. Matched by name, as the
 * account errors are, so the logger imports no provider code.
 */
const PLATFORM_WIRE_CATEGORIES: Readonly<Record<string, string>> = {
  expired: "authorization",
  verification: "authorization",
  unavailable: "service",
  changed: "validation",
};

export function classifyDiagnosticError(error: unknown): string {
  if (error instanceof RefreshInvalidatedError) return error.reason;
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  if (name === "platformwireerror") {
    const reason = (error as { reason?: unknown }).reason;
    const category = typeof reason === "string" ? PLATFORM_WIRE_CATEGORIES[reason] : undefined;
    if (category) return category;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const rawCode = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : "";
  const code = typeof rawCode === "string" ? rawCode.trim().toLowerCase() : "";
  const rawGatewayCode = error && typeof error === "object" && "gatewayCode" in error
    ? (error as { gatewayCode?: unknown }).gatewayCode
    : "";
  const status = Number(
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : 0,
  );
  if (name.includes("abort") || message.includes("取消")) return "cancelled";
  if (name.includes("timeout") || message.includes("超时")) return "timeout";
  if (typeof rawGatewayCode === "string" && rawGatewayCode.trim().toLowerCase() === "upstream_unavailable") return "upstream";
  if (status === 401 || status === 403) return "authorization";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "service";
  if (code === "invalid_upstream_response") return "protocol";
  if (code === "invalid_company_code" || code === "invalid_input") {
    return "validation";
  }
  if (code === "rate_limited") return "rate_limited";
  if (
    code === "upstream_rejected" ||
    code === "upstream_unavailable"
  ) return "upstream";
  if (
    name.includes("accountparse") ||
    message.includes("响应与当前运单不匹配") ||
    message.includes("物流信息与当前运单不符")
  ) return "protocol";
  if (name.includes("accountapi")) {
    return message.includes("参数") || message.includes("手机号") ||
        message.includes("验证码") || message.includes("身份") ||
        message.includes("设备验证") || message.includes("无法打开")
      ? "validation"
      : "upstream";
  }
  if (
    name.includes("kuaidi100") ||
    message.includes("暂无轨迹") ||
    message.includes("无法识别")
  ) return "no_result";
  if (
    message.includes("已不在列表") ||
    message.includes("已从列表中移除")
  ) return "removed";
  if (message.includes("状态已更新")) return "state_changed";
  if (message.includes("服务暂时不可用")) return "service";
  if (
    message.includes("网络") ||
    message.includes("连接")
  ) return "network";
  if (
    message.includes("token") ||
    message.includes("access key") ||
    message.includes("授权")
  ) return "authorization";
  if (message.includes("保存") || message.includes("storage")) return "storage";
  if (message.includes("手机号") || message.includes("验证码")) return "validation";
  return "unknown";
}

export function diagnosticErrorDetails(error: unknown): DiagnosticDetails {
  const status = Number(
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : 0,
  );
  const rawGatewayCode = error && typeof error === "object" && "gatewayCode" in error
    ? (error as { gatewayCode?: unknown }).gatewayCode
    : "";
  const gatewayCode = typeof rawGatewayCode === "string"
    ? rawGatewayCode.trim().toLowerCase()
    : "";
  const rawAccountCode = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : "";
  const accountCode = typeof rawAccountCode === "string"
    ? rawAccountCode.trim().toLowerCase()
    : "";
  const rawAuthRuntime = error && typeof error === "object" && "authRuntime" in error
    ? (error as { authRuntime?: unknown }).authRuntime
    : "";
  const authRuntime = typeof rawAuthRuntime === "string"
    ? rawAuthRuntime.trim().toLowerCase()
    : "";
  const failureCode = SAFE_FAILURE_CODES.has(gatewayCode)
    ? gatewayCode
    : SAFE_FAILURE_CODES.has(accountCode)
      ? accountCode
      : "";
  return {
    errorCategory: classifyDiagnosticError(error),
    ...(error instanceof OperationTimeoutError ? error.requestDetails : {}),
    ...(error instanceof OperationTimeoutError ? error.waitDetails : {}),
    ...(Number.isInteger(status) && status >= 100 && status <= 599
      ? { httpStatus: status }
      : {}),
    ...(failureCode
      ? { failureCode }
      : {}),
    ...(authRuntime === "data-key" || authRuntime === "key-data" ||
        authRuntime === "sha256-invalid" || authRuntime === "hmac-invalid"
      ? { authRuntime }
      : {}),
  };
}

/** Beta records by default; the formal build stays quiet until the user turns it on. */
const diagnosticsTrack: string = SCRIPT_BUILD_TRACK;
const DIAGNOSTICS_DEFAULT_ENABLED = diagnosticsTrack === "beta";
let diagnosticsInstallChecked = false;

/**
 * 用户 2026-09-27：以后安装 beta 版就默认重新打开，安装正式版就跟随之前的设置（iOS 同 Pipi）。
 * The first touch of the switch in each runtime (app, widget, App Intent) checks the package once: a
 * beta whose SCRIPT_VERSION differs from the recorded one turns recording on and records its version,
 * so a user who turns it off within that same beta keeps it off. Formal builds leave the stored
 * switch alone (never set → the formal default, off). Storage failures change nothing else; an
 * unrecorded reopen is retried by the next runtime.
 */
function reopenDiagnosticsForNewBeta(): void {
  if (diagnosticsInstallChecked) return;
  diagnosticsInstallChecked = true;
  if (!DIAGNOSTICS_DEFAULT_ENABLED) return;
  try {
    if (Storage.get<string>(DIAGNOSTIC_BETA_VERSION_KEY, { shared: true }) === SCRIPT_VERSION) return;
    if (Storage.set(DIAGNOSTIC_ENABLED_KEY, true, { shared: true }) === false) return;
    Storage.set(DIAGNOSTIC_BETA_VERSION_KEY, SCRIPT_VERSION, { shared: true });
  } catch {
    /* the switch keeps its stored value or the track default */
  }
}

/**
 * Owner 2026-11-24 「Clear once after update (Recommended)」: lines kept by builds before the keyed handle (D7) can still
 * hold the old unsalted, reversible ownerFingerprint for up to seven days. The first touch of the log in each runtime
 * (app, widget, App Intent, Shortcut) checks a device-wide marker once; of all runtimes, only the one that creates it
 * clears those lines (the older build's shared array and every batch without the keyed-handle mark) and, when it
 * cleared one, writes the fixed line `diagnostics.log.cleared result=handle_upgrade`. The marker stays, so this never
 * repeats. It is not clearDiagnostics: lines this version writes, in this or another runtime, stay, and the recording
 * switch, the handle key and business data are unchanged. While recording is off the old lines are cleared and, as for
 * every line, the fixed line is not written.
 */
let handleResetChecked = false;

function retirePreHandleDiagnostics(): void {
  if (handleResetChecked) return;
  handleResetChecked = true;
  try {
    if (!claimDiagnosticHandleReset(runtimeInstance)) return;
  } catch {
    return; // Nothing was claimed; the next runtime checks again.
  }
  let cleared = false;
  try {
    const legacy = Storage.get<unknown>(DIAGNOSTIC_KEY, { shared: true });
    if (Array.isArray(legacy) && legacy.length) {
      retireLegacyDiagnostics();
      cleared = true;
    }
    // After the shared array, so a batch migrated from it meanwhile is cleared too.
    if (retireUnkeyedDiagnosticBatches()) cleared = true;
  } catch {
    try { releaseDiagnosticHandleReset(); } catch { /* The old lines then expire after seven days. */ }
    return;
  }
  if (cleared) writeDiagnostic("diagnostics.log.cleared", { result: "handle_upgrade" });
}

let diagnosticsEnabledInTurn: { get: unknown; value: boolean } | undefined;
let diagnosticsEnabledResetScheduled = false;

function forgetDiagnosticsEnabledInTurn(): void {
  diagnosticsEnabledInTurn = undefined;
}

export function diagnosticsEnabled(): boolean {
  reopenDiagnosticsForNewBeta();
  retirePreHandleDiagnostics();
  const storageGet = typeof Storage !== "undefined" ? Storage.get : undefined;
  if (diagnosticsEnabledInTurn && diagnosticsEnabledInTurn.get === storageGet) {
    return diagnosticsEnabledInTurn.value;
  }
  let enabled = DIAGNOSTICS_DEFAULT_ENABLED;
  try {
    const stored = typeof Storage !== "undefined"
      ? Storage.get<boolean>(DIAGNOSTIC_ENABLED_KEY, { shared: true })
      : undefined;
    enabled = typeof stored === "boolean" ? stored : DIAGNOSTICS_DEFAULT_ENABLED;
  } catch {
    enabled = DIAGNOSTICS_DEFAULT_ENABLED;
  }
  diagnosticsEnabledInTurn = { get: storageGet, value: enabled };
  if (!diagnosticsEnabledResetScheduled) {
    diagnosticsEnabledResetScheduled = true;
    void Promise.resolve().then(() => {
      diagnosticsEnabledResetScheduled = false;
      diagnosticsEnabledInTurn = undefined;
    });
  }
  return enabled;
}

/** Turning recording off stops new records; existing diagnostics remain readable. */
export function setDiagnosticsEnabled(enabled: boolean): boolean {
  reopenDiagnosticsForNewBeta();
  forgetDiagnosticsEnabledInTurn();
  try {
    if (typeof Storage === "undefined") return false;
    Storage.set(DIAGNOSTIC_ENABLED_KEY, enabled === true, { shared: true });
    diagnosticsEnabledInTurn = { get: Storage.get, value: enabled === true };
    if (!diagnosticsEnabledResetScheduled) {
      diagnosticsEnabledResetScheduled = true;
      void Promise.resolve().then(() => {
        diagnosticsEnabledResetScheduled = false;
        diagnosticsEnabledInTurn = undefined;
      });
    }
    // A recording that starts begins with a clean repeat filter (G-MED-21).
    if (enabled) forgetRepeatedLines();
    if (!enabled) {
      bufferedEntries.length = 0;
      pendingPublication = undefined;
      // An operation that was running when recording stopped has nothing to report later.
      clearOpenFlows();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 统一用词（用户定 2026-09-05，三端同一套）：每行带 `level`（链上的哪一级）与 `interface`
 * （归属接口）。旧字段 `stage` / `timelineProvider` 先并存一版方便对照，值来自它们推导：
 * v5_list / v5_query / v6_query / v4_query / v2_query / jd_h5 / cn_h5 / k100_h5 / kdniao /
 * k100_autoCom。账号归属仍是 v5；三星增强的批量元数据请求是 v3_list / interface=v3。
 */
const LEVEL_BY_STAGE: Record<string, string> = {
  jt_h5: "jt_h5",
  v6_query: "v6_query",
  v6_refresh: "v6_refresh",
  account_list: "v5_list",
  account_detail: "v5_query",
  jingdong_h5: "jd_h5",
  detail_webview: "jd_h5",
  detail_webview_commit: "jd_h5",
  cainiao_h5: "cn_h5",
  pinduoduo_h5: "pdd_h5",
  pdd_h5: "pdd_h5",
  kuaidi100_query: "k100_h5",
  web_timeline: "k100_h5",
  picker_query: "v6_query",
  pending_picker: "v6_query",
  route: "v6_query",
  moto_query: "v4_query",
  pending_moto: "v4_query",
  local: "v4_query",
  kdniao_fallback: "kdniao",
  pending_kdniao: "kdniao",
  fallback: "kdniao",
  classify: "k100_autoCom",
  carrier_detect: "k100_autoCom",
};
const LEVEL_BY_PROVIDER: Record<string, string> = {
  jt_h5: "jt_h5",
  interface5: "v5_list",
  account: "v5_list",
  v5_list: "v5_list",
  meizu: "v6_query",
  route: "v6_query",
  moto: "v4_query",
  local: "v4_query",
  kdniao: "kdniao",
  fallback: "kdniao",
  kuaidi100_h5: "k100_h5",
  kuaidi100: "k100_h5",
  jingdong_h5: "jd_h5",
  cainiao_h5: "cn_h5",
  pinduoduo_h5: "pdd_h5",
  pdd_h5: "pdd_h5",
  web: "cn_h5",
  v5_query: "v5_query",
  v4_query: "v4_query",
  v6_query: "v6_query",
  v6_refresh: "v6_refresh",
  v2_query: "v2_query",
  jd_h5: "jd_h5",
  cn_h5: "cn_h5",
  k100_h5: "k100_h5",
};
const INTERFACE_LEVELS = new Set(["v5_list", "v5_query"]);

function unifiedLevel(details: DiagnosticDetails): string {
  if (details.level) return String(details.level);
  if (details.requestProvider) return String(details.requestProvider);
  const stage = String(details.stage || "").trim().toLowerCase();
  const byStage = LEVEL_BY_STAGE[stage];
  const provider = String(details.timelineProvider || "").trim().toLowerCase();
  const byProvider = LEVEL_BY_PROVIDER[provider];
  // manual_refresh / manual_query / detail_refresh 这类阶段名不指向某一级，看包/来源名。
  if (byStage) return byStage;
  if (byProvider) return byProvider;
  return "";
}

/**
 * Each host's first diagnostic call (app, widget, App Intent, Shortcut). It names the runtime for later lines (D103),
 * reports what an earlier runtime left unfinished (D4) and records missing capabilities. Capability presence is host
 * evidence, not proof of a working transaction.
 */
export function writeRuntimeCapabilities(runtimeHost: DiagnosticRuntimeHost, flowId?: string): void {
  setDiagnosticRuntimeHost(runtimeHost);
  if (!diagnosticsEnabled()) return;
  try { reportUnfinishedDiagnosticFlows(); } catch { /* Diagnostics are optional. */ }
  try {
    const runtime = globalThis as unknown as {
      SQLite?: { open?: unknown };
      FileManager?: {
        appGroupDocumentsDirectory?: unknown;
        readAsStringSync?: unknown;
        writeAsStringSync?: unknown;
      };
    };
    const sqliteOpenAvailable = typeof runtime.SQLite?.open === "function";
    const sharedFilesAvailable = typeof runtime.FileManager?.appGroupDocumentsDirectory === "string" &&
      typeof runtime.FileManager?.readAsStringSync === "function" &&
      typeof runtime.FileManager?.writeAsStringSync === "function";
    if (!sqliteOpenAvailable || !sharedFilesAvailable) {
      writeDiagnostic("runtime.capabilities", {
        runtimeHost, flowId, sqliteOpenAvailable, sharedFilesAvailable,
      }, "warning");
    }
  } catch {
    writeDiagnostic("runtime.capabilities", { runtimeHost, flowId, result: "probe_failed" }, "warning");
  }
}

export function writeDiagnostic(
  event: string,
  details: DiagnosticDetails = {},
  level: DiagnosticLevel = "info",
): void {
  if (!bufferDiagnosticBatch(event, [details], level)) return;
  if (bufferedEntries.length >= FLUSH_RECORDS || event === "refresh.succeeded" || event === "refresh.failed") {
    flushDiagnostics();
  } else if (!flushScheduled) {
    flushScheduled = true;
    void Promise.resolve().then(() => {
      flushScheduled = false;
      flushDiagnostics();
    });
  }
}

export type OperationEvent =
  | "platform.identity" | "platform.parcel_sync" | "platform.cabinet" | "platform.parcel_detail" | "platform.account.code"
  | "cloud.sync"
  | "shortcut.screen" | "shortcut.query" | "shortcut.phone_tail" | "activity.parcel.operation" | "pickup.action"
  | "recognition.online" | "account.enhanced.operation" | "binding.unbind" | "app.startup" | "home.query";

export type DiagnosticOperationEnd = ((result: string, extra?: DiagnosticDetails, level?: DiagnosticLevel) => void) &
  Readonly<{
    flowId: string;
    /** Ends the operation without a line, for an outcome its caller writes once per change of result. */
    discard: () => void;
  }>;

/**
 * One operation, one end line `<event>.completed` with its duration (D4, owner 2026-11-21 「开始并入终态，卡住另记
 * （推荐）」; the start line this used to write is merged into the end). The flow id is returned on the end function so a
 * caller can pass it to work the operation runs. An operation that never ends is reported by the next runtime.
 */
export function beginDiagnosticOperation(event: OperationEvent, details: DiagnosticDetails = {}): DiagnosticOperationEnd {
  const startedAt = Date.now();
  const flowId = createDiagnosticFlowId(event);
  try { openDiagnosticFlow(flowId, event, startedAt); } catch { /* Diagnostics are optional. */ }
  let finished = false;
  const end = (result: string, extra: DiagnosticDetails = {}, level: DiagnosticLevel = "info") => {
    if (finished) return;
    finished = true;
    try {
      closeDiagnosticFlow(flowId, event);
      writeDiagnostic(event + ".completed", {
        ...details, ...extra, flowId, result, durationMs: Math.max(0, Date.now() - startedAt),
      }, level);
    } catch { /* Diagnostics are optional. */ }
  };
  const discard = () => {
    if (finished) return;
    finished = true;
    try { closeDiagnosticFlow(flowId, event); } catch { /* Diagnostics are optional. */ }
  };
  return Object.assign(end, { flowId, discard });
}

/**
 * D4 for the flows that used to write their own start line (owner 2026-11-21 「开始并入终态，卡住另记（推荐）」, applied
 * to every iOS start line in step 5): the start's details are kept in memory and merged into the first end line of the
 * same flow, which then carries the start's evidence, the end's own values and the flow's duration. A family names its
 * end events and the detail keys that tie an end line to its start. A `marker` family also keeps the device-local
 * marker, so a flow an earlier runtime left unfinished is reported at the next host start.
 */
export type DiagnosticStartEvent =
  | "refresh.started" | "refresh.wait.started" | "detail.refresh.started" | "detail.refresh.stage_started"
  | "refresh.stage.started" | "account.sync.started" | "order.projection.started" | "binding.code.started"
  | "binding.verify.started" | "notification.replay.started" | "widget.run.started" | "alignment.started";

type StartFamily = Readonly<{
  family: string;
  ends: readonly string[];
  keys: readonly (keyof DiagnosticDetails)[];
  marker?: true;
}>;

const START_FAMILIES: Readonly<Record<DiagnosticStartEvent, StartFamily>> = {
  "refresh.started": { family: "refresh", ends: ["refresh.succeeded", "refresh.failed"], keys: ["flowId"], marker: true },
  "refresh.wait.started": { family: "refresh.wait", ends: ["refresh.wait.completed", "refresh.failed"], keys: ["flowId"] },
  "detail.refresh.started": {
    family: "detail.refresh", ends: ["detail.refresh.committed", "detail.refresh.skipped", "detail.refresh.failed"],
    keys: ["flowId"], marker: true,
  },
  "detail.refresh.stage_started": {
    family: "detail.refresh.stage",
    ends: ["detail.refresh.stage_succeeded", "detail.refresh.stage_failed"],
    keys: ["flowId", "stage", "waybillTail"],
  },
  "refresh.stage.started": {
    family: "refresh.stage", ends: ["refresh.stage.succeeded", "refresh.stage.failed", "refresh.stage.skipped"],
    keys: ["flowId", "stage", "waybillTail"],
  },
  "account.sync.started": { family: "account.sync", ends: ["account.sync.completed", "account.sync.failed"], keys: ["flowId", "stage"] },
  "order.projection.started": {
    family: "order.projection",
    ends: ["order.projection.extracted", "order.projection.empty", "order.projection.failed", "order.projection.rejected",
      "order.projection.skipped"],
    keys: ["flowId", "ownerFingerprint"], marker: true,
  },
  "binding.code.started": { family: "binding.code", ends: ["binding.code.succeeded", "binding.code.failed"], keys: ["flowId"], marker: true },
  "binding.verify.started": {
    family: "binding.verify", ends: ["binding.verify.succeeded", "binding.verify.failed"], keys: ["flowId"], marker: true,
  },
  "notification.replay.started": {
    family: "notification.replay", ends: ["notification.replay.completed"], keys: ["flowId"], marker: true,
  },
  "widget.run.started": { family: "widget.run", ends: ["widget.run.completed"], keys: ["flowId"], marker: true },
  "alignment.started": { family: "alignment", ends: ["alignment.completed"], keys: ["flowId"] },
};
const STARTS_BY_END = new Map<string, StartFamily[]>();
for (const family of Object.values(START_FAMILIES)) {
  for (const end of family.ends) STARTS_BY_END.set(end, [...(STARTS_BY_END.get(end) || []), family]);
}
const START_STASH_LIMIT = 256;
const startStash = new Map<string, { startedAtMs: number; details: DiagnosticDetails }>();

function startStashKey(family: StartFamily, details: DiagnosticDetails): string {
  return [family.family, ...family.keys.map((key) => {
    const value = String(details[key] ?? "").trim();
    if (key === "stage") return STAGE_WIRE[value.toLowerCase()] || value;
    return key === "waybillTail" ? value.toUpperCase() : value;
  })].join("\u0000");
}

/**
 * Starts a flow without a start line (D4). Its details reach the flow's end line; a `marker` family is reported as
 * unfinished by a later runtime if no end line follows. The trigger is remembered for the flow's later lines, as the
 * start line used to do.
 */
export function beginDiagnosticFlow(event: DiagnosticStartEvent, details: DiagnosticDetails = {}): void {
  try {
    if (!diagnosticsEnabled()) return;
    const family = START_FAMILIES[event];
    const startedAtMs = Date.now();
    const key = startStashKey(family, details);
    startStash.delete(key);
    startStash.set(key, { startedAtMs, details });
    while (startStash.size > START_STASH_LIMIT) startStash.delete(startStash.keys().next().value!);
    const flowId = String(details.flowId || "");
    if (flowId && details.trigger) {
      const trigger = sanitizeDetails({ trigger: details.trigger }).trigger;
      if (trigger) flowTriggers.set(flowId, trigger);
    }
    if (family.marker && /^\d{1,17}$/.test(flowId)) openDiagnosticFlow(flowId, family.family, startedAtMs);
  } catch { /* Diagnostics are optional. */ }
}

/** The end line of a started flow, with its start's details underneath its own and the flow's duration. */
function withDiagnosticStart(event: string, details: DiagnosticDetails, now: number): DiagnosticDetails {
  const families = STARTS_BY_END.get(event);
  if (!families) return details;
  for (const family of families) {
    const key = startStashKey(family, details);
    const start = startStash.get(key);
    if (!start) continue;
    startStash.delete(key);
    const flowId = String(details.flowId || start.details.flowId || "");
    if (family.marker && flowId) {
      try { closeDiagnosticFlow(flowId, family.family); } catch { /* Diagnostics are optional. */ }
    }
    // A start that described the displayed selection and an end that describes a query response are different scopes:
    // the display's selection evidence stays out of the response's line.
    const startDetails = start.details.selectionScope && details.selectionScope &&
        start.details.selectionScope !== details.selectionScope
      ? Object.fromEntries(Object.entries(start.details).filter(([key]) => !DISPLAY_SCOPE_KEYS.has(key)))
      : start.details;
    // An end value left undefined does not erase the start's value.
    const merged: Record<string, unknown> = { ...startDetails };
    for (const [key, value] of Object.entries(details)) if (value !== undefined) merged[key] = value;
    return { ...merged, durationMs: details.durationMs ?? Math.max(0, now - start.startedAtMs) } as DiagnosticDetails;
  }
  return details;
}

/** Keys that only a display-scope line carries (shipmentDiagnosticDetails without a response). */
const DISPLAY_SCOPE_KEYS = new Set<string>([
  "historyProvider", "headlineProvider", "statusProvider", "selectionReason", "feedEventAtMs",
]);

type PendingStageEnd = { signal?: AbortSignal; ended: boolean; write: () => void };
const pendingStageEnds = new Map<string, Set<PendingStageEnd>>();

export type StageCancellationEnd = Readonly<{ end: () => void; close: () => void }>;

/**
 * 用户 2026-09-28 (log authorization): a stage that logged its start under `flowId` and now waits on work its flow's
 * `signal` can cut off. Its cancelled end (`write`) is written once: by the stage where the cancellation reaches it
 * (`end`), or, when the flow's end line comes first, right before that line. The log drops a flow's lines after its end
 * line, and a refresh's coordinator reports that end as soon as it cancels the refresh, while its stages still unwind.
 * `close` once the stage no longer waits.
 */
export function openStageCancellationEnd(
  flowId: string | undefined,
  signal: AbortSignal | undefined,
  write: () => void,
): StageCancellationEnd {
  const entry: PendingStageEnd = { signal, ended: false, write };
  const key = flowId && signal ? flowId : "";
  if (key) {
    const open = pendingStageEnds.get(key) || new Set<PendingStageEnd>();
    open.add(entry);
    pendingStageEnds.set(key, open);
  }
  const close = () => {
    const open = key ? pendingStageEnds.get(key) : undefined;
    if (!open) return;
    open.delete(entry);
    if (!open.size) pendingStageEnds.delete(key);
  };
  return {
    end: () => {
      close();
      if (entry.ended) return;
      entry.ended = true;
      write();
    },
    close,
  };
}

/** Right before a flow's end line: the cancelled ends its stages still owe it, innermost first. */
function writePendingStageEnds(flowId: string): void {
  const open = pendingStageEnds.get(flowId);
  if (!open) return;
  pendingStageEnds.delete(flowId);
  for (const entry of [...open].reverse()) {
    if (entry.ended || !entry.signal?.aborted) continue;
    entry.ended = true;
    entry.write();
  }
}

function bufferDiagnosticBatch(
  event: string,
  details: readonly DiagnosticDetails[],
  level: DiagnosticLevel = "info",
): boolean {
  if (event === "refresh.succeeded" || event === "refresh.failed") {
    for (const detail of details) writePendingStageEnds(String(detail.flowId || ""));
  }
  if (!details.length || !diagnosticsEnabled()) return false;
  const cleanEvent = String(event || "").trim();
  // D10: only an event from the closed table is written.
  if (!SAFE_TEXT.test(cleanEvent) || !DIAGNOSTIC_EVENTS.has(cleanEvent)) return false;
  const now = Date.now();
  const entries: DiagnosticEntry[] = [];
  const terminalFlowIds = new Set<string>();
  for (const rawDetail of details) {
    const detail = withDiagnosticStart(cleanEvent, rawDetail, now);
    const unified = unifiedLevel(detail);
    const cleanDetails = sanitizeDetails({
      ...withRelativeTimes(detail, now),
      clientBuild: SCRIPT_CLIENT_BUILD,
      ...(unified ? { level: unified } : {}),
      ...(unified && INTERFACE_LEVELS.has(unified) && !detail.interface
        ? { interface: "v5" }
        : {}),
    }, cleanEvent);
    const flowId = cleanDetails.flowId || "";
    if (flowId && (closedFlowIds.has(flowId) || terminalFlowIds.has(flowId))) continue;
    if (level === "info" && repeatedRoutineLine(cleanEvent, cleanDetails, now)) continue;
    if (flowId) {
      if (cleanDetails.trigger) {
        flowTriggers.set(flowId, cleanDetails.trigger);
        while (flowTriggers.size > MAX_CLOSED_FLOWS) {
          flowTriggers.delete(flowTriggers.keys().next().value!);
        }
      } else if (flowTriggers.has(flowId)) {
        cleanDetails.trigger = flowTriggers.get(flowId);
      }
    }
    entries.push({
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date(now).toISOString(),
      level,
      event: cleanEvent,
      details: cleanDetails,
    });
    if (flowId && (cleanEvent === "refresh.succeeded" || cleanEvent === "refresh.failed")) {
      terminalFlowIds.add(flowId);
    }
  }
  if (!entries.length) return false;
  if (!bufferedEntries.length && !pendingPublication) bufferedEpoch = undefined;
  try {
    const epoch = diagnosticEpoch();
    if (bufferedEpoch !== undefined && bufferedEpoch !== epoch
      || bufferedEpoch === undefined && bufferedEntries.length > 0 && epoch !== "legacy") {
      bufferedEntries.length = 0;
      pendingPublication = undefined;
    }
    bufferedEpoch = epoch;
  } catch { /* Keep the sanitized buffer available when native file APIs are unavailable. */ }
  bufferedEntries.push(...entries);
  if (bufferedEntries.length > MAX_RECORDS) bufferedEntries.splice(0, bufferedEntries.length - MAX_RECORDS);
  for (const flowId of terminalFlowIds) {
    closedFlowIds.add(flowId);
    flowTriggers.delete(flowId);
    while (closedFlowIds.size > MAX_CLOSED_FLOWS) {
      const oldest = closedFlowIds.values().next().value;
      if (typeof oldest !== "string") break;
      closedFlowIds.delete(oldest);
    }
  }
  return true;
}

/**
 * Step 5 (D164, D165, D166, D168; owner 2026-11-21 「删噪声，低价值类保底降到 10（推荐）」): routine info lines that
 * repeat the same outcome for the same subject are written once per change, shared by every runtime
 * (changedSinceLastLogged). `subject` names the fields that identify what the line is about, `outcome` the fields
 * whose change makes it new; `when` limits a filter to the outcomes the plan lists. Warnings and errors pass.
 */
const REPEAT_FILTERS: Readonly<Record<string, Readonly<{
  subject: readonly (keyof DiagnosticDetails)[];
  outcome: readonly (keyof DiagnosticDetails)[];
  when?: (details: DiagnosticDetails) => boolean;
}>>> = {
  "order.projection.skipped": { subject: ["ownerFingerprint", "waybillTail", "stage", "source"], outcome: ["result", "skipReason"] },
  "refresh.stage.skipped": {
    subject: ["stage", "waybillTail", "source"], outcome: ["result", "skipReason"],
    when: (details) => details.skipReason === "cooldown" || details.skipReason === "signed_frozen",
  },
  "carrier.recognition.completed": {
    subject: ["waybillTail"], outcome: ["result", "skipReason"], when: (details) => details.result === "cooldown",
  },
  "carrier.authority.loaded": { subject: [], outcome: ["result"], when: (details) => details.result === "cache_unavailable" },
};

function repeatedRoutineLine(event: string, details: DiagnosticDetails, now: number): boolean {
  const filter = REPEAT_FILTERS[event];
  if (!filter || (filter.when && !filter.when(details))) return false;
  const subject = [event, ...filter.subject.map((key) => String(details[key] ?? ""))].join("\u0000");
  const outcome = filter.outcome.map((key) => String(details[key] ?? "")).join("\u0000");
  return !changedSinceLastLogged(subject, outcome, now);
}

function reconcileBufferedEpoch(epoch: string): boolean {
  if (bufferedEpoch !== undefined && bufferedEpoch !== epoch) {
    bufferedEntries.length = 0;
    lastLoadedDiagnostics = [];
    pendingPublication = undefined;
    bufferedEpoch = epoch;
    return false;
  }
  // An unobserved clear cannot authorize publishing older records into its new epoch.
  if (bufferedEpoch === undefined && epoch !== "legacy") return false;
  bufferedEpoch = epoch;
  return true;
}

function nextDiagnosticPublication(epoch: string, now: number): DiagnosticPublication {
  return pendingPublication ??= {
    id: diagnosticBatchId(), epoch,
    entries: bufferedEntries.filter(entry => validEntry(entry, now)),
    bufferedIds: new Set(bufferedEntries.map(entry => entry.id)),
  };
}

function acknowledgeDiagnosticPublication(batch: DiagnosticPublication): void {
  if (pendingPublication !== batch) return;
  for (let index = bufferedEntries.length - 1; index >= 0; index--) {
    if (batch.bufferedIds.has(bufferedEntries[index]!.id)) bufferedEntries.splice(index, 1);
  }
  pendingPublication = undefined;
}

function hasDiagnosticWork(): boolean {
  if (!bufferedEntries.length) return false;
  if (diagnosticsEnabled()) return true;
  bufferedEntries.length = 0;
  pendingPublication = undefined;
  return false;
}

async function flushAppDiagnosticBatch(): Promise<void> {
  if (!hasDiagnosticWork()) return;
  try {
    const observedEpoch = bufferedEpoch;
    const epoch = await readDiagnosticEpoch();
    if (!hasDiagnosticWork() || bufferedEpoch !== observedEpoch || !reconcileBufferedEpoch(epoch)) return;
    const now = Date.now();
    if (epoch === "legacy") {
      const legacy = legacyDiagnosticEntries(now);
      const current = () => bufferedEpoch === epoch && hasDiagnosticWork();
      if (legacy && (!legacy.length
        || await publishDiagnosticBatchAsync(diagnosticBatchId(), epoch, legacy, current, true))
        && current()) retireLegacyDiagnostics();
    }
    for (let pass = 0; pass < 2 && bufferedEntries.length && bufferedEpoch === epoch; pass++) {
      const batch = nextDiagnosticPublication(epoch, Date.now());
      if (batch.entries.length && !await publishDiagnosticBatchAsync(batch.id, batch.epoch, batch.entries,
        () => pendingPublication === batch && diagnosticsEnabled())) return;
      acknowledgeDiagnosticPublication(batch);
    }
    await pruneDiagnosticBatchesAsync(epoch, now, MAX_RECORDS, MAX_AGE_MS);
  } catch { /* Retry the same batch at the next flush boundary. */ }
}

export function startAppDiagnosticWrites(): void {
  appDiagnosticWrites = true;
}

function requestAppDiagnosticFlush(): void {
  appFlushRequested = true;
  if (appFlush) return;
  appFlush = Promise.resolve().then(async () => {
    do {
      appFlushRequested = false;
      await flushAppDiagnosticBatch();
    } while (appFlushRequested);
    appFlush = undefined;
  });
}

export async function drainAppDiagnostics(): Promise<void> {
  flushDiagnostics();
  await appFlush;
}

/** Each runtime publishes its own batch. Short-lived widget and intent hosts flush before exiting. */
export function flushDiagnostics(): void {
  persistRepeatStore();
  if (!bufferedEntries.length) return;
  if (appDiagnosticWrites) {
    requestAppDiagnosticFlush();
    return;
  }
  if (!hasDiagnosticWork()) return;
  const now = Date.now();
  try {
    const epoch = diagnosticEpoch();
    if (!reconcileBufferedEpoch(epoch)) return;
    migrateLegacyDiagnostics(now);
    for (let pass = 0; pass < 2 && bufferedEntries.length; pass++) {
      const batch = nextDiagnosticPublication(epoch, now);
      if (batch.entries.length) publishDiagnosticBatch(batch.id, batch.epoch, batch.entries);
      acknowledgeDiagnosticPublication(batch);
    }
    pruneDiagnosticBatchesByMetadata(epoch, now, MAX_RECORDS, MAX_AGE_MS);
  } catch {
    /* diagnostics must never change app behavior */
  }
}

/** Schedule a batch including this runtime's preceding buffered records. */
export function writeDiagnosticBatch(
  event: string,
  details: readonly DiagnosticDetails[],
  level: DiagnosticLevel = "info",
): void {
  if (bufferDiagnosticBatch(event, details, level)) flushDiagnostics();
}

let lastLoadedDiagnostics: DiagnosticEntry[] = [];

/**
 * Returns the most recently loaded diagnostic entries merged with any in-memory buffered entries
 * without touching disk, flushing batches, or pruning retention files.
 */
export function peekRecentDiagnostics(): DiagnosticEntry[] {
  const now = Date.now();
  const unique = new Map<string, DiagnosticEntry>();
  for (const entry of lastLoadedDiagnostics) {
    if (validEntry(entry, now)) unique.set(entry.id, entry);
  }
  for (const entry of bufferedEntries) {
    if (validEntry(entry, now)) unique.set(entry.id, cleanStoredEntry(entry));
  }
  return [...unique.values()]
    .filter(({ event }) => event !== "carrier.authority.current")
    .slice(-MAX_RECORDS)
    .reverse();
}

/**
 * Cancelably reads and sanitizes stored + buffered diagnostic entries for view display without
 * triggering batch flush or file-pruning work on the navigation path.
 */
export function readDiagnosticsSnapshot(signal?: AbortSignal): Promise<DiagnosticEntry[]> {
  if (signal?.aborted) return Promise.resolve([]);
  return new Promise<DiagnosticEntry[]>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        resolve([]);
        return;
      }
      const now = Date.now();
      const entries = storedEntries(now, false).map((entry) => cleanStoredEntry(entry));
      const unique = new Map(entries.map((entry) => [entry.id, entry]));
      let showPending = false;
      try { showPending = diagnosticEpoch() === bufferedEpoch; }
      catch { showPending = bufferedEpoch === undefined; }
      if (showPending) {
        for (const entry of bufferedEntries.filter((entry) => validEntry(entry, now))) {
          unique.set(entry.id, cleanStoredEntry(entry));
        }
      }
      const result = [...unique.values()]
        .filter(({ event }) => event !== "carrier.authority.current")
        .slice(-MAX_RECORDS)
        .reverse();
      lastLoadedDiagnostics = [...result].reverse();
      resolve(result);
    }, 0);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve([]);
    };
    signal?.addEventListener("abort", onAbort);
  });
}

export function readDiagnostics(): DiagnosticEntry[] {
  retirePreHandleDiagnostics();
  flushDiagnostics();
  const now = Date.now();
  const entries = storedEntries(now, true);
  const unique = new Map(entries.map(entry => [entry.id, entry]));
  let showPending = false;
  try { showPending = diagnosticEpoch() === bufferedEpoch; }
  catch { showPending = bufferedEpoch === undefined; }
  if (showPending) {
    for (const entry of bufferedEntries.filter(entry => validEntry(entry, now))) {
      unique.set(entry.id, cleanStoredEntry(entry));
    }
  }
  const result = [...unique.values()].filter(({ event }) => event !== "carrier.authority.current").slice(-MAX_RECORDS).reverse();
  lastLoadedDiagnostics = [...result].reverse();
  return result;
}

/**
 * 2026-11-12 诊断日志清理（与 Pipi AppDiagnosticLog.changedSinceLastLogged 同一规则）: an unchanged
 * per-row line is written again only after this long, so a parcel that sits still is not re-logged on
 * every sync while the log still shows it a few times a day.
 */
export const REPEAT_RELOG_MS = 6 * 60 * 60 * 1000;
const REPEAT_KEYS = 512;
const repeatedLines = new Map<string, { fingerprint: string; atMs: number }>();
/**
 * Step 5 (plan section 4.2): the widget, App Intent and Shortcut hosts are short-lived runtimes, so the record of
 * what was last written is kept on the device as well, shared by every runtime. Keys and fingerprints are stored as
 * short hashes, never as the values they describe.
 */
const REPEAT_STORE_KEY = "pipi_deliveries_diagnostic_repeat_v1";
let repeatStoreLoaded = false;
let repeatStoreDirty = false;
let repeatPersistScheduled = false;

function repeatHash(value: string): string {
  try { return sha256Hex(value).slice(0, 16); } catch { return value.length > 64 ? value.slice(0, 64) : value; }
}

function readRepeatStore(): Record<string, [string, number]> {
  try {
    const raw = Storage.get<string>(REPEAT_STORE_KEY, { shared: true });
    const parsed = typeof raw === "string" ? JSON.parse(raw) as unknown : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries: Record<string, [string, number]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "number" && Number.isFinite(value[1])) {
        entries[key] = [value[0], value[1]];
      }
    }
    return entries;
  } catch {
    return {};
  }
}

/**
 * The records belong to the device's current log. A small shared generation marks them: when it is gone (the shared
 * storage was reset) or another runtime replaced it, this runtime's records are dropped and the shared ones reread.
 */
const REPEAT_GENERATION_KEY = "pipi_deliveries_diagnostic_repeat_generation_v1";
let repeatGeneration: string | undefined;

function syncRepeatGeneration(): void {
  let stored: unknown;
  try { stored = Storage.get<string>(REPEAT_GENERATION_KEY, { shared: true }); } catch { return; }
  if (typeof stored === "string" && stored === repeatGeneration) return;
  repeatedLines.clear();
  repeatStoreLoaded = false;
  repeatStoreDirty = false;
  if (typeof stored === "string" && stored) {
    repeatGeneration = stored;
    return;
  }
  repeatGeneration = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  try {
    Storage.set(REPEAT_GENERATION_KEY, repeatGeneration, { shared: true });
    Storage.remove(REPEAT_STORE_KEY, { shared: true });
  } catch { /* The records stay in this runtime. */ }
}

function loadRepeatStore(): void {
  if (repeatStoreLoaded) return;
  repeatStoreLoaded = true;
  const stored = Object.entries(readRepeatStore()).sort((left, right) => left[1][1] - right[1][1]);
  for (const [key, [fingerprint, atMs]] of stored) {
    if (!repeatedLines.has(key)) repeatedLines.set(key, { fingerprint, atMs });
  }
}

/** Writes this runtime's records over the shared ones, keeping the newer record of each key. */
function persistRepeatStore(): void {
  if (!repeatStoreDirty) return;
  repeatStoreDirty = false;
  try {
    const merged = readRepeatStore();
    for (const [key, line] of repeatedLines) {
      const stored = merged[key];
      if (!stored || stored[1] <= line.atMs) merged[key] = [line.fingerprint, line.atMs];
    }
    const kept = Object.entries(merged).sort((left, right) => right[1][1] - left[1][1]).slice(0, REPEAT_KEYS);
    Storage.set(REPEAT_STORE_KEY, JSON.stringify(Object.fromEntries(kept)), { shared: true });
  } catch { /* A lost record only repeats one line later. */ }
}

/**
 * Whether a repeating info line for `key` carries something new: its first sighting, a changed `fingerprint`, or
 * REPEAT_RELOG_MS since it was last written by any runtime on this device. Clearing the log forgets every key.
 * Warnings and errors never go through this filter.
 */
export function changedSinceLastLogged(key: string, fingerprint: string, now = Date.now()): boolean {
  // An off log writes nothing, so it registers no sighting either (G-MED-21): a line skipped now must not collapse
  // the same line once recording is on.
  if (!diagnosticsEnabled()) return true;
  syncRepeatGeneration();
  loadRepeatStore();
  const hashedKey = repeatHash(key);
  const hashedFingerprint = repeatHash(fingerprint);
  const last = repeatedLines.get(hashedKey);
  if (last && last.fingerprint === hashedFingerprint && now - last.atMs >= 0 && now - last.atMs < REPEAT_RELOG_MS) {
    return false;
  }
  repeatedLines.delete(hashedKey);
  repeatedLines.set(hashedKey, { fingerprint: hashedFingerprint, atMs: now });
  while (repeatedLines.size > REPEAT_KEYS) {
    const eldest = repeatedLines.keys().next().value;
    if (eldest === undefined) break;
    repeatedLines.delete(eldest);
  }
  repeatStoreDirty = true;
  if (!repeatPersistScheduled) {
    repeatPersistScheduled = true;
    void Promise.resolve().then(() => {
      repeatPersistScheduled = false;
      persistRepeatStore();
    });
  }
  return true;
}

/** Forgets every repeat record, in this runtime and on the device. */
function forgetRepeatedLines(): void {
  repeatedLines.clear();
  repeatStoreDirty = false;
  repeatStoreLoaded = false;
  repeatGeneration = undefined;
  try {
    Storage.remove(REPEAT_STORE_KEY, { shared: true });
    Storage.remove(REPEAT_GENERATION_KEY, { shared: true });
  } catch { /* Old records expire on their own. */ }
}

export function clearDiagnostics(): void {
  try {
    forgetDiagnosticsEnabledInTurn();
    forgetRepeatedLines();
    startStash.clear();
    migrateLegacyDiagnostics(Date.now());
    Storage.remove(DIAGNOSTIC_KEY, { shared: true });
    clearDiagnosticFiles();
    bufferedEntries.length = 0;
    lastLoadedDiagnostics = [];
    pendingPublication = undefined;
    bufferedEpoch = diagnosticEpoch();
    closedFlowIds.clear();
    flowTriggers.clear();
    // A cleared log starts with a new handle key (D7) and no earlier operation to report (D4).
    retireDiagnosticHandleKey();
    clearOpenFlows();
    storedEntries(Date.now(), true);
  } catch {
    throw new Error("诊断日志清空失败");
  }
}

/**
 * D221/D230: the kind a line belongs to on the log page, from its event name. A folded flow takes the kind of its
 * newest line, so one flow is never split between kinds. The words are Pipi's kind words (AppDiagnosticLog.Kind: app,
 * express, pickup, platform, ocr, notification) for the features iOS has; `cloud` is iOS's own kind for the cloud.sync
 * lines, which Pipi files under app.
 */
export type DiagnosticCategory = "express" | "pickup" | "platform" | "ocr" | "cloud" | "notification" | "app";

export function diagnosticCategory(event: string): DiagnosticCategory {
  // A meal pull stored before D188 as meal.sync.* is the same cloud flow as today's cloud.sync line.
  if (/^(?:cloud\.|meal\.sync\.)/.test(event)) return "cloud";
  if (/^(?:notification\.)/.test(event)) return "notification";
  if (/^(?:recognition\.|shortcut\.screen)/.test(event)) return "ocr";
  if (/^(?:pickup\.|meal\.|activity\.|shortcut\.)/.test(event)) return "pickup";
  if (/^(?:platform\.|binding\.|account\.enhanced|manager\.|gateway\.|settings\.)/.test(event)) return "platform";
  if (/^(?:refresh\.|detail\.|manual\.|account\.|order\.|carrier\.|express\.|alignment\.|shipment\.|ownership\.|note\.|product\.|home\.)/
    .test(event)) return "express";
  return "app";
}

/**
 * D225 (D14 on iOS): the short summary copied above the raw lines: the script version, track and build, the number of
 * lines of each kind and level, the failed events and the flows reported unfinished. Counts and enumerated words only.
 * The log keeps no count of evicted lines, so none is given.
 */
export function diagnosticSummaryText(entries = readDiagnostics()): string {
  const byCategory = new Map<DiagnosticCategory, number>();
  const failures = new Map<string, number>();
  let warnings = 0, errors = 0, unfinished = 0, recordingSince = "";
  for (const entry of entries) {
    const category = diagnosticCategory(entry.event);
    byCategory.set(category, (byCategory.get(category) || 0) + 1);
    if (entry.level === "warning") warnings++;
    if (entry.level === "error") errors++;
    if (entry.level !== "info") failures.set(entry.event, (failures.get(entry.event) || 0) + 1);
    if (entry.event === "diagnostic.flow.unfinished") unfinished++;
    if (entry.event === "diagnostics.recording.started" && (!recordingSince || entry.at < recordingSince)) {
      recordingSince = entry.at;
    }
  }
  const oldest = entries.reduce((value, entry) => !value || entry.at < value ? entry.at : value, "");
  const lines = [
    `# summary version=${SCRIPT_VERSION} track=${SCRIPT_BUILD_TRACK} build=${SCRIPT_CLIENT_BUILD} entries=${entries.length}` +
      ` warnings=${warnings} errors=${errors} unfinished=${unfinished}` +
      (oldest ? ` oldest=${oldest}` : "") + (recordingSince ? ` recordingSince=${recordingSince}` : ""),
    `# kinds ${[...byCategory].sort(([left], [right]) => left.localeCompare(right))
      .map(([category, count]) => `${category}=${count}`).join(" ")}`,
  ];
  if (failures.size) {
    lines.push(`# problems ${[...failures].sort(([left], [right]) => left.localeCompare(right))
      .map(([event, count]) => `${event}=${count}`).join(" ")}`);
  }
  return lines.join("\n");
}

export function diagnosticText(entries = readDiagnostics()): string {
  return entries
    .map((entry) => {
      const details = Object.entries(entry.details)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ");
      return `${entry.at} ${entry.level.toUpperCase()} ${entry.event}${
        details ? ` ${details}` : ""
      }`;
    })
    .join("\n");
}
