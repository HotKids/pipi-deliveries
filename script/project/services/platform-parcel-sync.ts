import { AbortController } from "scripting";
import type { AppState } from "../models";
import { detectManualCarrier } from "./manual-query";
import {
  currentPlatformSession, notePlatformSync, onPlatformAccountsChanged, platformSession, saveCainiaoNickname, PLATFORM_NAMES, PLATFORM_SOURCES,
  type ExpressPlatform, type PlatformSession,
} from "./platform-accounts";
import { CAINIAO_LIST_PARAMETERS, CAINIAO_RECIPIENT_LIST,
  PlatformWireError, readCainiao, readCainiaoProfileNickname, readCainiaoSenderAppointments, readPdd } from "./platform-wire";
import { cainiaoHandoffs, cainiaoRecipientParcels, pddPickupParcels, type PlatformParcel } from "./platform-parcel-data";
import { fetchFengchaoCabinets, requestCabinetOpening, supportsCabinetOpening } from "./fengchao-account";
import { fetchJdParcels, fetchPddOrders } from "./platform-web-parcels";
import { eligiblePickup } from "./platform-parcel-merge";
import { projectionSceneActive } from "./projection-viewport";
import { displayWaybill } from "./shipment-policy";
import { shipmentLifecycleKey } from "./shipment-lifecycle";
import {
  completeCurrentParcelCard, loadState, parcelCardKey, savePlatformParcelData, visibleShipments,
} from "./storage";
import { commitManualShipmentPreview, continueManualShipmentPreview, queryManualShipmentPreview } from "./sync";
import { activePickupCards, type ParcelActivityContent } from "./parcel-pickup";
import { writeDiagnostic } from "./logger";
import { EXPRESS_TOAST_COPY } from "./express-toast-copy";

const DISCOVERY_INTERVAL = 4 * 3_600_000;
const observedRows = new Map<ExpressPlatform, { generation: string; keys: Set<string> }>();
const regularAttempts = new Map<ExpressPlatform, { generation: string; atMs: number }>();
type PlatformSyncResult = { added: number; partial: boolean };
const inFlight = new Map<ExpressPlatform, { generation: string; task: Promise<PlatformSyncResult>; recheck: boolean }>();
const cainiaoProfileInFlight = new Set<string>();

type RefreshMode = "observe" | "pull" | "manual";
type ReadScope = { recipients: boolean; regular: boolean };
export type PlatformSyncProgress = (platform: ExpressPlatform, running: boolean) => void;
type PlatformRefreshIssue = { platform: ExpressPlatform; reason: "expired" | "partial" | "failed" };
type PlatformRefreshResult = { succeeded: number; failed: number; added: number; issues: PlatformRefreshIssue[] };

function scopeFor(platform: ExpressPlatform, session: PlatformSession, state: AppState, mode: RefreshMode): ReadScope {
  const now = Date.now();
  const visible = visibleShipments(state, now);
  const last = observedRows.get(platform);
  const keys = new Set<string>();
  for (const shipment of visible) {
    if (eligiblePickup(shipment)) keys.add("pickup:" + shipmentLifecycleKey(shipment));
    else if (shipment.identity.sourceProvider?.toLowerCase() === platform ||
      platform === "pinduoduo" && shipment.pddImport?.ownerKey === session.ownerKey) {
      keys.add("source:" + shipmentLifecycleKey(shipment));
    }
  }
  const newKeys = [...keys].filter((key) => last?.generation !== session.generation || !last.keys.has(key));
  const waiting = visible.some(eligiblePickup);
  const recipients = mode === "manual" || waiting && (mode === "pull" || newKeys.some((key) => key.startsWith("pickup:")));
  const hour = new Date(now + 8 * 3_600_000).getUTCHours();
  const attempt = regularAttempts.get(platform);
  const lastAt = platform === "pinduoduo" ? session.lastDiscoveryAtMs : session.syncedAtMs;
  const lastTry = attempt?.generation === session.generation ? attempt.atMs : 0;
  const due = now - (lastAt || 0) >= DISCOVERY_INTERVAL && now - lastTry >= DISCOVERY_INTERVAL;
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
  try {
    for (const item of observations) {
      if (!current()) throw new PlatformWireError("changed");
      const state = loadState();
      if (state.shipments.some((shipment) => displayWaybill(shipment) === item.waybill) ||
        state.pendingQueries.some((pending) => pending.waybill === item.waybill)) continue;
      const presentation = await detectManualCarrier(item.waybill, { signal: abort.signal }).catch(() => null);
      if (!presentation || presentation.requiresPhoneTail || !current()) continue;
      const preview = await queryManualShipmentPreview({ waybill: item.waybill, presentation }).catch(() => null);
      if (!preview?.shipment || (!preview.hasTimedResult && preview.roundComplete !== false) || !current()) continue;
      const tagged = {
        ...preview,
        shipment: { ...preview.shipment, pddImport: { ownerKey: session.ownerKey, orderId: item.orderIds?.[0] || "",
          ...(item.shippingId && item.orderIds?.length === 1 ? { shippingId: item.shippingId } : {}) } },
      };
      try {
        const committed = commitManualShipmentPreview(tagged);
        publish(committed);
        const final = preview.roundComplete === false && current()
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
): Promise<PlatformSyncResult> {
  const current = () => projectionSceneActive() && currentPlatformSession(platform, session.generation) != null;
  const before = loadState();
  const now = Date.now();
  const visible = visibleShipments(before);
  const persist = (value: Omit<Parameters<typeof savePlatformParcelData>[0], "observed" | "owner" | "current">,
    observed = before) => {
    const saved = savePlatformParcelData({ ...value, observed, owner: session.ownerKey, current }, Date.now());
    publish(saved.state);
    return saved;
  };
  let succeeded = false;
  let failed = false;
  async function read(operation: () => Promise<void>) {
    if (!current()) throw new PlatformWireError("changed");
    try {
      await operation();
      succeeded = true;
    } catch (error) {
      if (!current()) throw error;
      failed = true;
    }
  }
  if (platform === "cainiao") {
    const readStage = (recipient: boolean) => read(async () => {
      const stage = recipient ? "cainiao_recipient" : "cainiao_sender";
      const started = Date.now();
      let commitStarted: number | undefined;
      try {
        if (recipient) {
          const data = await readCainiao(session, CAINIAO_RECIPIENT_LIST, CAINIAO_LIST_PARAMETERS);
          commitStarted = Date.now();
          persist({ parcels: cainiaoRecipientParcels(data, now) });
        } else {
          const data = await readCainiaoSenderAppointments(session);
          commitStarted = Date.now();
          persist({ parcels: [], handoffs: cainiaoHandoffs(data, session.ownerKey, now) });
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
        }, "warning");
        throw error;
      }
    });
    if (scope.recipients) await readStage(true);
    if (scope.regular) await readStage(false);
  } else if (platform === "fengchao") {
    const saved = persist({ parcels: [], cabinets: await fetchFengchaoCabinets(session) });
    if (!notePlatformSync(platform, session.generation, Date.now(), { cabinetLinks: saved.cabinetLinks })) {
      throw new PlatformWireError("changed");
    }
    return { added: 0, partial: false };
  } else if (platform === "jingdong") {
    const data = await fetchJdParcels(session, visible, (parcels) => persist({ parcels }));
    try {
      if (data.parcels.length) persist({ parcels: data.parcels });
      if (!notePlatformSync(platform, session.generation, Date.now())) {
        throw new PlatformWireError("changed");
      }
    } catch (error) {
      writeDiagnostic("platform.jingdong.sync.failed", { stage: "jd_sync_save",
        result: error instanceof PlatformWireError ? error.reason : "failed" }, "warning");
      throw error;
    }
    return { added: 0, partial: false };
  } else {
    let added = 0;
    if (scope.regular) await read(async () => {
      const orders = await fetchPddOrders(session);
      added = await importPddParcels(session, orders, publish);
      persist({ parcels: orders }, loadState());
      if (!notePlatformSync(platform, session.generation, Date.now(), { discovery: true })) {
        throw new PlatformWireError("changed");
      }
    });
    const observed = scope.regular ? loadState() : before;
    const waiting = visibleShipments(observed).filter(eligiblePickup);
    if (waiting.length) await read(async () => {
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
    return { added, partial: failed };
  }
  if (!succeeded) throw new PlatformWireError("unavailable");
  return { added: 0, partial: failed };
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
  const state = loadState();
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
      return [{ platform, task }];
    }
    const scope = scopeFor(platform, session, state, mode);
    if (!scope.recipients && !scope.regular) return [];
    const task = syncPlatform(platform, session, scope, publish).finally(() => {
      const slot = inFlight.get(platform);
      if (slot?.task !== task) return;
      inFlight.delete(platform);
      if (slot.recheck) void refreshPlatformParcels(publish, "observe", platform).catch(() => {
        writeDiagnostic("platform.sync.unavailable", {}, "warning");
      });
    });
    inFlight.set(platform, { generation: session.generation, task, recheck: false });
    return [{ platform, task }];
  });
  const results = await Promise.allSettled(tasks.map(({ platform, task }) => {
    onProgress?.(platform, true);
    return task.finally(() => onProgress?.(platform, false));
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
      if (mode !== "manual" && platform !== "jingdong") writeDiagnostic("platform.sync.unavailable", {}, "warning");
    }
  }
  summary.failed = summary.issues.length;
  return summary;
}

export function platformRefreshMessage(result: PlatformRefreshResult): string {
  if (result.issues.length) {
    const details = result.issues.map(({ platform, reason }) => {
      const name = PLATFORM_NAMES[platform];
      if (reason === "expired") return `${name}登录已失效，请重新登录`;
      return `${name}${reason === "partial" ? "同步未完成" : "同步失败"}，请稍后重试`;
    });
    const prefix = result.added ? `已新增 ${result.added} 件快递` : result.succeeded ? "部分同步完成" : "";
    return prefix ? [prefix, ...details].join("，") : details.join("，");
  }
  if (!result.succeeded) return "没有可同步的平台账号";
  return result.added ? `同步完成，新增 ${result.added} 件快递` : "同步完成";
}

function cabinetForCard(session: PlatformSession | null, card: ParcelActivityContent) {
  if (session?.credentials.kind !== "cabinet" || card.platform !== "fengchao") return null;
  const candidates = session.credentials.cabinetLinks?.filter(({ recordKey, parcel }) =>
    recordKey === parcelCardKey(card) && parcel.code === card.code && supportsCabinetOpening(parcel)) || [];
  return candidates.length === 1 ? candidates[0].parcel : null;
}

export function canOpenParcelCabinet(card: ParcelActivityContent): boolean {
  return card.platform === "fengchao" && !!cabinetForCard(platformSession("fengchao"), card);
}

const opening = new Set<string>();

export async function performPickupAction(card: ParcelActivityContent, openCabinet: boolean, publish: (state: AppState) => void) {
  if (!openCabinet) {
    const next = completeCurrentParcelCard(card);
    publish(next);
    const target = card.target;
    if (!target || !("recordId" in target)) return EXPRESS_TOAST_COPY.signed;
    if (card.kind !== "handoff") return "已取件";
    const saved = next.pickupCodeRecords?.find((record) => record.id === target.recordId);
    return saved?.completedAtMs ? "已寄件" : "寄件码已失效";
  }
  const key = parcelCardKey(card);
  if (opening.has(key)) return "正在请求开柜，请稍候";
  const session = platformSession("fengchao");
  const cabinet = cabinetForCard(session, card);
  if (!session || !cabinet || !key) return "柜件状态已变更，请刷新后重试";
  opening.add(key);
  try {
    const label = [cabinet.cabinetName, cabinet.location].filter(Boolean).join(" · ");
    const confirmed = await Dialog.confirm({
      title: "确认开柜", message: "到达" + (label || "丰巢快递柜") + "后再开柜。",
      cancelLabel: "取消", confirmLabel: "开柜",
    });
    if (!confirmed) return "";
    const active = currentPlatformSession("fengchao", session.generation);
    const state = loadState();
    const current = activePickupCards(visibleShipments(state), state.pickupCodeRecords)
      .find((item) => parcelCardKey(item) === key && item.code === card.code);
    if (!current || !active || JSON.stringify(cabinetForCard(active, current)) !== JSON.stringify(cabinet)) {
      return "柜件状态已变更，请刷新后重试";
    }
    await requestCabinetOpening(active, cabinet);
    return "开柜请求已受理，请及时取件";
  } catch (error) {
    if (error instanceof PlatformWireError && error.reason === "expired") return "丰巢登录已失效，请重新登录";
    return "开柜结果未确认，请使用取件码取件";
  } finally {
    opening.delete(key);
  }
}
