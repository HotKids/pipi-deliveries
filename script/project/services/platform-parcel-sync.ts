import { AbortController } from "scripting";
import type { AppState, ParcelHandoffRecord, Shipment } from "../models";
import { detectManualCarrier } from "./manual-query";
import {
  currentPlatformSession, notePlatformSync, onPlatformAccountsChanged, platformSession, saveCainiaoNickname, savePddPhoneTails, PLATFORM_NAMES, PLATFORM_SOURCES,
  type ExpressPlatform, type PlatformSession,
} from "./platform-accounts";
import { CAINIAO_LIST_PARAMETERS, CAINIAO_RECIPIENT_LIST,
  fetchPddBoundPhoneTails, PlatformWireError, readCainiao, readCainiaoProfileNickname, readCainiaoSenderAppointments, readPdd } from "./platform-wire";
import { cainiaoHandoffId, cainiaoHandoffs, cainiaoRecipientParcels, pddPickupParcels, pddTimelineFromTraces, type PlatformParcel } from "./platform-parcel-data";
import { fetchFengchaoCabinets, requestCabinetOpening, supportsCabinetOpening } from "./fengchao-account";
import { fetchJdParcels, fetchPddOrders, fetchPddParcelDetails } from "./platform-web-parcels";
import { eligiblePickup, enrichPlatformParcel } from "./platform-parcel-merge";
import { projectionSceneActive } from "./projection-viewport";
import { displayWaybill, selectShipmentTimeline } from "./shipment-policy";
import { mergeTimelineAuthorities } from "./status";
import { SCRIPT_BINDING_SOURCE } from "./script-source";
import { ShipmentLifecycleChangedError, shipmentLifecycleKey } from "./shipment-lifecycle";
import {
  completeCurrentParcelCard, loadState, parcelCardKey, readAppStateSnapshot, savePlatformParcelData, visibleShipments,
} from "./storage";
import { commitManualShipmentPreview, continueManualShipmentPreview, queryManualShipmentPreview, type ManualShipmentPreview } from "./sync";
import { activePickupCards, type ParcelActivityContent } from "./parcel-pickup";
import { beginDiagnosticOperation, diagnosticErrorDetails, writeDiagnostic } from "./logger";
import { EXPRESS_TOAST_COPY } from "./express-toast-copy";

const DISCOVERY_INTERVAL = 4 * 3_600_000;
const observedRows = new Map<ExpressPlatform, { generation: string; keys: Set<string> }>();
const regularAttempts = new Map<ExpressPlatform, { generation: string; atMs: number }>();
type PlatformSyncResult = { added: number; partial: boolean; changed: boolean };
/** Diagnostics only (D116): the stage a round is in, and the first stage that failed in a partial round. */
type PlatformSyncProgressNote = { stage: string; failedStage?: string; failure?: unknown };
// A joined caller still learns when a Cainiao round has moved on to its sender appointments.
type SenderStage = { started: boolean; listeners: Set<() => void> };
const inFlight = new Map<ExpressPlatform, {
  generation: string; task: Promise<PlatformSyncResult>; recheck: boolean; sender: SenderStage;
}>();
const cainiaoProfileInFlight = new Set<string>();

type RefreshMode = "observe" | "pull" | "manual";
type ReadScope = { recipients: boolean; regular: boolean };
/** `stage: "sender"` reports a running Cainiao round that committed its recipients and now reads sender appointments. */
export type PlatformSyncProgress = (platform: ExpressPlatform, running: boolean, stage?: "sender") => void;
type PlatformRefreshIssue = { platform: ExpressPlatform; reason: "expired" | "partial" | "failed" };
type PlatformRefreshResult = { succeeded: number; failed: number; added: number; issues: PlatformRefreshIssue[] };

function scopeFor(platform: ExpressPlatform, session: PlatformSession, visible: readonly Shipment[], mode: RefreshMode,
  records: AppState["pickupCodeRecords"]): ReadScope {
  const now = Date.now();
  const last = observedRows.get(platform);
  const keys = new Set<string>();
  let waiting = false;
  for (const shipment of visible) {
    if (eligiblePickup(shipment)) {
      waiting = true;
      keys.add("pickup:" + shipmentLifecycleKey(shipment));
    } else if (shipment.identity.sourceProvider?.toLowerCase() === platform ||
      platform === "pinduoduo" && shipment.pddImport?.ownerKey === session.ownerKey) {
      keys.add("source:" + shipmentLifecycleKey(shipment));
    }
  }
  const newKeys = [...keys].filter((key) => last?.generation !== session.generation || !last.keys.has(key));
  const hour = new Date(now + 8 * 3_600_000).getUTCHours();
  const attempt = regularAttempts.get(platform);
  const lastAt = platform === "pinduoduo" ? session.lastDiscoveryAtMs : session.syncedAtMs;
  const lastTry = attempt?.generation === session.generation ? attempt.atMs : 0;
  const due = now - (lastAt || 0) >= DISCOVERY_INTERVAL && now - lastTry >= DISCOVERY_INTERVAL;
  const standalone = platform === "cainiao" && records?.some((row) => row.kind === "pickup" && row.platform === "cainiao" &&
    row.id.startsWith("cn-station:") && !row.completedAtMs);
  const recipients = mode === "manual" || waiting && (mode === "pull" || newKeys.some((key) => key.startsWith("pickup:"))) ||
    Boolean(standalone && (mode === "pull" || due));
  const regular = mode === "manual" || due && (platform !== "pinduoduo" || hour >= 7 && hour < 23) ||
    platform === "jingdong" && newKeys.some((key) => key.startsWith("source:"));
  observedRows.set(platform, { generation: session.generation, keys });
  if (regular) regularAttempts.set(platform, { generation: session.generation, atMs: now });
  return { recipients, regular };
}

async function importPddParcels(session: PlatformSession, observations: readonly PlatformParcel[],
  publish: (state: AppState) => void): Promise<number> {
  const current = () => projectionSceneActive() && currentPlatformSession("pinduoduo", session.generation) != null;
  const abort = new AbortController();
  const unsubscribe = onPlatformAccountsChanged(() => { if (!current()) abort.abort(); });
  let added = 0;
  let knownWaybills: Set<string> | undefined;
  let resolvedPhoneTails: string[] | undefined;
  try {
    for (const item of observations) {
      if (!knownWaybills) {
        if (!current()) throw new PlatformWireError("changed");
        const { state } = readAppStateSnapshot();
        knownWaybills = new Set([...state.shipments.map(displayWaybill), ...state.pendingQueries.map(pending => pending.waybill)]);
      }
      if (knownWaybills.has(item.waybill)) continue;
      // A network wait can let another host add, remove or replace a waybill.
      knownWaybills = undefined;
      const presentation = await detectManualCarrier(item.waybill, { signal: abort.signal }).catch(() => null);
      if (!presentation || !current()) continue;
      let phoneTails: string[] = [];
      if (presentation.requiresPhoneTail) {
        if (!resolvedPhoneTails) {
          const fetched = await fetchPddBoundPhoneTails(session, abort.signal).catch(() => []);
          if (fetched.length) savePddPhoneTails(session.generation, fetched);
          const live = currentPlatformSession("pinduoduo", session.generation);
          const cached = live?.credentials.kind === "web" ? live.credentials.pddPhoneTails || [] : [];
          const localBound = readAppStateSnapshot().state.bindings
            .filter(binding => binding.source === SCRIPT_BINDING_SOURCE)
            .map(binding => binding.phone.slice(-4));
          resolvedPhoneTails = [...new Set([...fetched, ...cached, ...localBound].filter(tail => /^\d{4}$/.test(tail)))];
        }
        phoneTails = resolvedPhoneTails;
      }
      let detailParcel: PlatformParcel | undefined;
      if (!item.traces?.length && item.shippingId && item.orderIds?.length === 1) {
        detailParcel = await fetchPddParcelDetails(
          session, item.shippingId, item.waybill, !item.title, !item.estimate, true, current, abort.signal, true,
        ).catch(() => undefined);
      }
      if (!current()) break;
      const now = Date.now();
      const pddTimeline = pddTimelineFromTraces(
        item.waybill, presentation.courierCode, presentation.companyName, detailParcel?.traces ?? item.traces, now,
      );
      let preview: Awaited<ReturnType<typeof queryManualShipmentPreview>> | null = null;
      const tailsToTry = phoneTails.length ? phoneTails : [""];
      for (const candidateTail of tailsToTry) {
        preview = await queryManualShipmentPreview({
          waybill: item.waybill,
          ...(candidateTail ? { phoneTail: candidateTail } : {}),
          presentation,
        }).catch(() => null);
        if (!current()) break;
        if (preview?.hasTimedResult) break;
      }
      if (!current()) break;
      if (!preview?.shipment && !pddTimeline) continue;
      if (!preview?.hasTimedResult && preview?.roundComplete !== false && !pddTimeline) continue;
      const pddImport = {
        ownerKey: session.ownerKey,
        orderId: item.orderIds?.[0] || "",
        ...(item.shippingId && item.orderIds?.length === 1 ? { shippingId: item.shippingId } : {}),
      };
      const basePreview: ManualShipmentPreview = preview ?? {
        shipment: {
          identity: {
            id: `${SCRIPT_BINDING_SOURCE}:manual:${item.waybill}`,
            bindingSource: SCRIPT_BINDING_SOURCE,
            sourceOwner: "manual",
            sourceId: item.waybill,
            phoneTail: phoneTails[0] || "",
            courierCode: presentation.courierCode,
            companyName: presentation.companyName,
            manuallyAdded: true,
            createdAtMs: now,
          },
          timeline: pddTimeline!,
          sourceTimeline: null,
          manualTimelines: [pddTimeline!],
          route: null,
          updatedAtMs: now,
        },
        pending: {
          id: `${SCRIPT_BINDING_SOURCE}:${item.waybill}`,
          source: SCRIPT_BINDING_SOURCE,
          waybill: item.waybill,
          phoneTail: phoneTails[0] || "",
          courierCode: presentation.courierCode,
          companyName: presentation.companyName,
          createdAtMs: now,
          lastAttemptAtMs: now,
          attempts: 1,
          route: null,
        },
        routeUrl: "",
        commitBase: { shipment: null, pending: null },
        hasTimedResult: true,
        roundComplete: true,
      };
      let mergedShipment: Shipment | null = basePreview.shipment ? { ...basePreview.shipment, pddImport } : null;
      if (mergedShipment && pddTimeline) {
        const manualTimelines = mergeTimelineAuthorities(mergedShipment.manualTimelines || [], pddTimeline);
        const withPdd: Shipment = { ...mergedShipment, manualTimelines };
        mergedShipment = { ...withPdd, timeline: selectShipmentTimeline(withPdd) };
      }
      if (mergedShipment && detailParcel) {
        mergedShipment = enrichPlatformParcel(mergedShipment, detailParcel, now);
      }
      const tagged: ManualShipmentPreview = {
        ...basePreview,
        hasTimedResult: basePreview.hasTimedResult || Boolean(pddTimeline),
        roundComplete: basePreview.hasTimedResult || Boolean(pddTimeline) ? true : basePreview.roundComplete,
        shipment: mergedShipment,
      };
      try {
        const committed = commitManualShipmentPreview(tagged);
        publish(committed);
        const final = preview && preview.roundComplete === false && !basePreview.hasTimedResult && !pddTimeline && current()
          ? (await continueManualShipmentPreview(tagged, { signal: abort.signal })).state : committed;
        publish(final);
        if (final.shipments.some((shipment) => displayWaybill(shipment) === item.waybill)) added++;
      } catch {
        if (!current()) throw new PlatformWireError("changed");
        writeDiagnostic("platform.pdd.import.unavailable", {}, "warning");
      }
    }
    return added;
  } finally {
    unsubscribe();
  }
}

async function syncPlatform(
  platform: ExpressPlatform, session: PlatformSession, scope: ReadScope, publish: (state: AppState) => void,
  before: AppState, visible: readonly Shipment[], onSenderStage?: () => void,
  note: PlatformSyncProgressNote = { stage: "platform_parcel_sync" },
): Promise<PlatformSyncResult> {
  const current = () => projectionSceneActive() && currentPlatformSession(platform, session.generation) != null;
  const now = Date.now();
  let changed = false;
  const persist = (value: Omit<Parameters<typeof savePlatformParcelData>[0], "observed" | "owner" | "current">,
    observed = before) => {
    const saved = savePlatformParcelData({ ...value, observed, owner: session.ownerKey, current }, Date.now());
    changed ||= saved.changed;
    publish(saved.state);
    return saved;
  };
  let succeeded = false;
  let failed = false;
  async function read(stage: string, operation: () => Promise<void>) {
    if (!current()) throw new PlatformWireError("changed");
    note.stage = stage;
    try {
      await operation();
      succeeded = true;
    } catch (error) {
      if (!current()) throw error;
      failed = true;
      if (!note.failedStage) {
        note.failedStage = stage;
        note.failure = error;
      }
    }
  }
  if (platform === "cainiao") {
    const readStage = (recipient: boolean) => read(recipient ? "cainiao_recipient" : "cainiao_sender", async () => {
      const stage = recipient ? "cainiao_recipient" : "cainiao_sender";
      const started = Date.now();
      let commitStarted: number | undefined;
      try {
        if (recipient) {
          const data = await readCainiao(session, CAINIAO_RECIPIENT_LIST, CAINIAO_LIST_PARAMETERS);
          commitStarted = Date.now();
          persist({ parcels: cainiaoRecipientParcels(data, now) });
        } else {
          const known = (loadState().pickupCodeRecords || []).filter((row): row is ParcelHandoffRecord => row.kind === "handoff" &&
            row.platform === "cainiao" && row.id.startsWith("cn-handoff:") && !row.completedAtMs && !row.expiredAtMs);
          const data = await readCainiaoSenderAppointments(session, (ids) => {
            if (!known.length) return false;
            const observed = new Set(ids.map(id => cainiaoHandoffId(session.ownerKey, id)));
            return known.some(row => !observed.has(row.id));
          });
          commitStarted = Date.now();
          persist({
            parcels: [], handoffs: cainiaoHandoffs(data, session.ownerKey, now, known),
            sentHandoffIds: data.sentOrders.map((id) => cainiaoHandoffId(session.ownerKey, id)),
          });
          if (data.incomplete) throw new PlatformWireError("unavailable");
        }
        if (!notePlatformSync(platform, session.generation, Date.now())) throw new PlatformWireError("changed");
        writeDiagnostic("platform.cainiao.sync.completed", { stage, durationMs: Date.now() - started,
          result: "succeeded" }, "info");
      } catch (error) {
        writeDiagnostic("platform.cainiao.sync.failed", {
          stage: stage + (commitStarted === undefined ? "_request" : "_commit"),
          durationMs: Date.now() - started,
          result: error instanceof PlatformWireError ? error.reason : "failed",
          ...diagnosticErrorDetails(error),
        }, "warning");
        throw error;
      }
    });
    if (scope.recipients) await readStage(true);
    if (scope.regular) {
      // The recipient sync time is already published; the same round continues with sender appointments.
      if (scope.recipients && succeeded) onSenderStage?.();
      await readStage(false);
    }
  } else if (platform === "fengchao") {
    note.stage = "fengchao_cabinets";
    const saved = persist({ parcels: [], cabinets: await fetchFengchaoCabinets(session) });
    if (!notePlatformSync(platform, session.generation, Date.now(), { cabinetLinks: saved.cabinetLinks })) {
      throw new PlatformWireError("changed");
    }
    return { added: 0, partial: false, changed };
  } else if (platform === "jingdong") {
    note.stage = "jd_sync_orders";
    const data = await fetchJdParcels(session, visible, (parcels) => persist({ parcels }));
    try {
      if (data.parcels.length) persist({ parcels: data.parcels });
      if (!notePlatformSync(platform, session.generation, Date.now())) {
        throw new PlatformWireError("changed");
      }
    } catch (error) {
      writeDiagnostic("platform.jingdong.sync.failed", { stage: "jd_sync_save",
        result: error instanceof PlatformWireError ? error.reason : "failed", ...diagnosticErrorDetails(error) }, "warning");
      throw error;
    }
    return { added: 0, partial: false, changed };
  } else {
    let added = 0;
    if (scope.regular) await read("pdd_orders", async () => {
      const orders = await fetchPddOrders(session);
      added = await importPddParcels(session, orders, publish);
      persist({ parcels: orders }, readAppStateSnapshot().state);
      if (!notePlatformSync(platform, session.generation, Date.now(), { discovery: true })) {
        throw new PlatformWireError("changed");
      }
    });
    const observed = scope.regular ? readAppStateSnapshot().state : before;
    const waiting = visibleShipments(observed).filter(eligiblePickup);
    if (waiting.length) await read("pdd_pickup", async () => {
      const round = observedRows.get(platform);
      if (round?.generation === session.generation) {
        for (const shipment of waiting) round.keys.add("pickup:" + shipmentLifecycleKey(shipment));
      }
      const data = await readPdd(session, "/api/express_trackbox/station/package", {
        entry_source: "8", dynamic_qrcode: false, install_token: "", dp_source: "", redirect_app: false,
      });
      persist({ parcels: pddPickupParcels(data) }, observed);
      notePlatformSync(platform, session.generation, Date.now());
    });
    if (!succeeded) throw new PlatformWireError("unavailable");
    return { added, partial: failed, changed };
  }
  if (!succeeded) throw new PlatformWireError("unavailable");
  return { added: 0, partial: failed, changed };
}

export async function refreshPlatformParcels(
  publish: (state: AppState) => void, mode: RefreshMode, only?: ExpressPlatform,
  onProgress?: PlatformSyncProgress,
): Promise<PlatformRefreshResult> {
  const summary: PlatformRefreshResult = { succeeded: 0, failed: 0, added: 0, issues: [] };
  if (!projectionSceneActive()) return summary;
  const sessions = (only ? [only] : PLATFORM_SOURCES).flatMap((platform) => {
    const session = platformSession(platform);
    return session ? [{ platform, session }] : [];
  });
  if (!sessions.length) return summary;
  let snapshot: { state: AppState; visible: Shipment[] } | undefined;
  const readSnapshot = () => {
    const { state } = readAppStateSnapshot();
    return { state, visible: visibleShipments(state) };
  };
  const tasks = sessions.flatMap(({ platform, session }) => {
    if (platform === "cainiao" && mode === "manual" && session.cainiaoLabelKind !== "nickname" &&
      !cainiaoProfileInFlight.has(session.generation)) {
      cainiaoProfileInFlight.add(session.generation);
      void readCainiaoProfileNickname(session).then((nickname) => {
        if (nickname) saveCainiaoNickname(session.generation, nickname);
        writeDiagnostic("platform.cainiao.profile", { result: nickname ? "found" : "unavailable" }, "info");
      }).catch(() => {
        writeDiagnostic("platform.cainiao.profile", { result: "unavailable" }, "info");
      }).finally(() => cainiaoProfileInFlight.delete(session.generation));
    }
    const previous = inFlight.get(platform);
    if (previous?.generation === session.generation) {
      if (mode === "observe") previous.recheck = true;
      const task = mode === "manual" ? previous.task : previous.task.then((outcome) => ({ ...outcome, added: 0 }));
      return [{ platform, task, sender: previous.sender }];
    }
    const { state, visible } = snapshot ??= readSnapshot();
    const scope = scopeFor(platform, session, visible, mode, state.pickupCodeRecords);
    if (!scope.recipients && !scope.regular) return [];
    const userInitiated = mode !== "observe";
    const finish = beginDiagnosticOperation("platform.parcel_sync", {
      sourceProvider: platform, trigger: mode, stage: "platform_parcel_sync",
    });
    const note: PlatformSyncProgressNote = { stage: "platform_parcel_sync" };
    const sender: SenderStage = { started: false, listeners: new Set() };
    const task = syncPlatform(platform, session, scope, publish, state, visible, () => {
      sender.started = true;
      for (const listener of sender.listeners) listener();
    }, note).then(result => {
      // D116: an automatic round of any platform, Cainiao included, writes its end when it changed something or
      // failed in part; an unchanged automatic round closes without a line. A partial round names its failed stage.
      if (userInitiated || result.partial || result.changed || result.added > 0) {
        finish(result.partial ? "partial" : "succeeded", {
          succeeded: result.added, changed: result.changed,
          ...(result.partial && note.failedStage ? { stage: note.failedStage, ...diagnosticErrorDetails(note.failure) } : {}),
        }, result.partial ? "warning" : "info");
      } else finish.discard();
      return result;
    }, error => {
      if (error instanceof PlatformWireError && error.reason === "changed") {
        if (userInitiated) finish("cancelled");
        else finish.discard();
      } else {
        finish(error instanceof PlatformWireError ? error.reason : "failed", {
          stage: note.failedStage || note.stage, ...diagnosticErrorDetails(note.failure ?? error),
        }, "warning");
      }
      throw error;
    }).finally(() => {
      const slot = inFlight.get(platform);
      if (slot?.task !== task) return;
      inFlight.delete(platform);
      if (slot.recheck) void refreshPlatformParcels(publish, "observe", platform).catch(() => {
        writeDiagnostic("platform.sync.unavailable", {}, "warning");
      });
    });
    inFlight.set(platform, { generation: session.generation, task, recheck: false, sender });
    return [{ platform, task, sender }];
  });
  const results = await Promise.allSettled(tasks.map(({ platform, task, sender }) => {
    onProgress?.(platform, true);
    const senderStarted = () => onProgress?.(platform, true, "sender");
    if (sender.started) senderStarted();
    else sender.listeners.add(senderStarted);
    return task.finally(() => {
      sender.listeners.delete(senderStarted);
      onProgress?.(platform, false);
    });
  }));
  for (const [index, result] of results.entries()) {
    const { platform } = tasks[index];
    if (result.status === "fulfilled") {
      summary.succeeded++;
      summary.added += result.value.added;
      if (result.value.partial) summary.issues.push({ platform, reason: "partial" });
    } else {
      const expired = result.reason instanceof PlatformWireError && result.reason.reason === "expired";
      summary.issues.push({ platform, reason: expired ? "expired" : "failed" });
    }
  }
  summary.failed = summary.issues.length;
  return summary;
}

export function platformRefreshMessage(result: PlatformRefreshResult): string {
  if (result.issues.length) {
    const affected = (reason: PlatformRefreshResult["issues"][number]["reason"]) => result.issues
      .filter(issue => issue.reason === reason).map(issue => PLATFORM_NAMES[issue.platform]).join("、");
    const expired = affected("expired");
    const partial = affected("partial");
    const failed = affected("failed");
    const prefix = result.added ? `已新增 ${result.added} 件快递` : result.succeeded ? "部分同步完成" : "";
    return [prefix, expired && `${expired}需重新登录`, partial && `${partial}同步未完成，请稍后重试`,
      failed && `${failed}同步失败，请稍后重试`].filter(Boolean).join(" · ");
  }
  if (!result.succeeded) return "没有可同步的平台账号";
  return result.added ? `已新增 ${result.added} 件快递` : "同步完成";
}

function cabinetForCard(session: PlatformSession | null, card: ParcelActivityContent) {
  if (session?.credentials.kind !== "cabinet" || card.platform !== "fengchao") return null;
  const candidates = session.credentials.cabinetLinks?.filter(({ recordKey, parcel }) =>
    recordKey === parcelCardKey(card) && parcel.code === card.code && supportsCabinetOpening(parcel)) || [];
  return candidates.length === 1 ? candidates[0].parcel : null;
}

export function pickupCabinetActions(cards: readonly ParcelActivityContent[]): ReadonlySet<ParcelActivityContent> {
  const candidates = cards.filter(card => card.platform === "fengchao");
  if (!candidates.length) return new Set();
  const session = platformSession("fengchao");
  return new Set(candidates.filter(card => cabinetForCard(session, card)));
}

const opening = new Set<string>();

export async function performPickupAction(card: ParcelActivityContent, openCabinet: boolean, publish: (state: AppState) => void) {
  if (!openCabinet) {
    const finish = beginDiagnosticOperation("pickup.action", { stage: "commit", trigger: card.kind ?? "pickup" });
    try {
      const next = completeCurrentParcelCard(card);
      const target = card.target;
      const independent = target && "recordId" in target;
      const expired = independent && card.kind === "handoff" &&
        !next.pickupCodeRecords?.find((record) => record.id === target.recordId)?.completedAtMs;
      finish(expired ? "expired" : "committed");
      publish(next);
      if (!independent) return EXPRESS_TOAST_COPY.signed;
      if (card.kind !== "handoff") return "已取件";
      return expired ? EXPRESS_TOAST_COPY.handoffExpired : EXPRESS_TOAST_COPY.handoffCompleted;
    } catch (error) {
      if (error instanceof ShipmentLifecycleChangedError) finish("stale");
      else finish("failed", {}, "warning");
      throw error;
    }
  }
  const finish = beginDiagnosticOperation("platform.cabinet", { sourceProvider: "fengchao", stage: "cabinet_open" });
  const key = parcelCardKey(card);
  if (opening.has(key)) {
    finish("busy");
    return "正在请求开柜，请稍候";
  }
  const session = platformSession("fengchao");
  const cabinet = cabinetForCard(session, card);
  if (!session || !cabinet || !key) {
    finish("unavailable");
    return "柜件状态已变更，请刷新后重试";
  }
  opening.add(key);
  try {
    const label = [cabinet.cabinetName, cabinet.location].filter(Boolean).join(" · ");
    const confirmed = await Dialog.confirm({
      title: "确认开柜",
      message: `${label ? `即将打开「${label}」。` : "即将打开当前丰巢格口。"}\n\n注意：请您已到达柜机前再点击开门，避免格口打开，没有及时取件快件丢失。`,
      cancelLabel: "取消",
      confirmLabel: "开柜",
    });
    if (!confirmed) {
      finish("cancelled");
      return "";
    }
    const active = currentPlatformSession("fengchao", session.generation);
    const state = loadState();
    const current = activePickupCards(visibleShipments(state), state.pickupCodeRecords)
      .find((item) => parcelCardKey(item) === key && item.code === card.code);
    if (!current || !active || JSON.stringify(cabinetForCard(active, current)) !== JSON.stringify(cabinet)) {
      finish("changed");
      return "柜件状态已变更，请刷新后重试";
    }
    const outcome = await requestCabinetOpening(active, cabinet);
    if (outcome === "opened") {
      finish("accepted");
      return "柜门已开启";
    }
    if (outcome === "expired") {
      finish("expired", {}, "warning");
      return "丰巢登录已失效，请重新登录";
    }
    if (outcome === "unconfirmed") {
      finish("unconfirmed", {}, "warning");
      return "暂未确认柜门开启，请查看柜机";
    }
    finish("failed", {}, "warning");
    return "开柜失败，请在柜机输入取件码";
  } catch (error) {
    if (error instanceof PlatformWireError && error.reason === "changed") {
      finish("changed");
      return "柜件状态已变更，请刷新后重试";
    }
    finish("failed", {}, "warning");
    return "开柜失败，请在柜机输入取件码";
  } finally {
    opening.delete(key);
  }
}
