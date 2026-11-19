import { LiveActivity, Path, Script, type LiveActivityDetail, type ScenePhase } from "scripting";
import { PARCEL_ACTIVITY_ART, PipiParcelActivity } from "../live_activity";
import type { AppState } from "../models";
import { pauseWhileActive } from "./deadline";
import { activeMealCards } from "./meal/cards";
import { writeDiagnostic } from "./logger";
import { acquireDurableRefreshLease } from "./refresh-runtime-state";
import { PARCEL_LOCK_SCREEN_BOX, parcelCardArtwork, type ParcelLockScreenStyle } from "./parcel-card-appearance";
import {
  EMPTY_CONTENT,
  PARCEL_ACTIVITY_NAME,
  endActivity,
  nativePickupTabCloseId,
  parcelActivityRegistry,
  parcelForTarget,
  saveParcelActivityRegistry,
  type ParcelActivityState,
  type Receipt,
} from "./parcel-activity-action";
import {
  PARCEL_ACTIVITY_PREVIEW,
  activePickupCards,
  type ParcelActivityContent,
  type ParcelActivityTarget,
} from "./parcel-pickup";
import { loadState, parcelCardKey, peekStateRevision, stateLoadFailure, visibleShipments } from "./storage";

let pending: Promise<unknown> = Promise.resolve();
let queuedReconciliation: { state: AppState; cards?: readonly ParcelActivityContent[] } | undefined;
let foreground = true;
const displayed = new Map<string, string>();
type ParcelActivityChange = { kind: "preview" } | { kind: "pickup-tab-empty"; activityId: string };
const activityListeners = new Set<(change: ParcelActivityChange) => void>();

export function onParcelActivityChanged(listener: (change: ParcelActivityChange) => void): () => void {
  if (!activityListeners.size) LiveActivity.addActivityUpdateListener?.(observeEndedActivity);
  activityListeners.add(listener);
  return () => {
    if (activityListeners.delete(listener) && !activityListeners.size) {
      LiveActivity.removeActivityUpdateListener?.(observeEndedActivity);
    }
  };
}

function notifyActivityChanged(change: ParcelActivityChange): void {
  for (const listener of activityListeners) listener(change);
}

function observeEndedActivity({ id, state }: LiveActivityDetail): void {
  if (state !== "ended" && state !== "dismissed") return;
  void serialize(async () => {
    const receipt = parcelActivityRegistry().receipts.find(item => item.id === id);
    if (!receipt) return;
    if (nativePickupTabCloseId() === id) notifyActivityChanged({ kind: "pickup-tab-empty", activityId: id });
    if (!receipt.target) await withActivityOwnership(async isCurrent => forgetReceipt(receipt, isCurrent));
  }).catch(() => writeDiagnostic("activity.parcel.end.observe.failed", {}, "warning"));
}

export function parcelActivitySceneChanged(phase: ScenePhase): void {
  foreground = phase === "active";
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = pending.then(operation);
  pending = next.catch(() => undefined);
  return next;
}

type ActivityOwnership = () => boolean;

async function withActivityOwnership<T>(operation: (isCurrent: ActivityOwnership) => Promise<T>): Promise<T> {
  // A Shortcut and the main page can run in separate JS contexts against the same receipts.
  const deadline = Date.now() + 1_500;
  do {
    const lease = acquireDurableRefreshLease("parcel-activities", 30_000);
    if (lease) {
      try { return await operation(lease.isCurrent); }
      finally { lease.release(); }
    }
    await pauseWhileActive(100);
  } while (Date.now() < deadline);
  throw new Error("实时活动正在更新，请稍后重试。");
}

function serializeMutation<T>(operation: (isCurrent: ActivityOwnership) => Promise<T>): Promise<T> {
  return serialize(() => withActivityOwnership(operation));
}

function requireActivityOwnership(isCurrent: ActivityOwnership): void {
  if (!isCurrent()) throw new Error("实时活动状态已更新，请稍后重试。");
}

async function isRunning(receipt: Receipt): Promise<boolean> {
  const state = await LiveActivity.getActivityState(receipt.id);
  return state === "active" || state === "stale";
}

export function parcelActivityStatus(includeRealCards = true): Promise<{ showAll: boolean; count: number; previewing: boolean; lockScreenStyle: ParcelLockScreenStyle }> {
  return serialize(async () => {
    const { showAll, receipts, lockScreenStyle } = parcelActivityRegistry();
    const relevant = includeRealCards ? receipts : receipts.filter(receipt => !receipt.target);
    const running = (await Promise.all(relevant.map(async (receipt) => await isRunning(receipt) ? receipt : null)))
      .filter(receipt => receipt !== null);
    return { showAll, lockScreenStyle, count: running.filter(receipt => receipt.target).length,
      previewing: running.some(receipt => !receipt.target) };
  });
}

export function hasRegisteredParcelPreview(): boolean {
  return parcelActivityRegistry().receipts.some(receipt => !receipt.target);
}

export function parcelActivityPreviewing(): Promise<boolean> {
  return serialize(async () => {
    for (const receipt of parcelActivityRegistry().receipts) {
      if (!receipt.target && await isRunning(receipt)) return true;
    }
    return false;
  });
}

function committedState(): AppState {
  const state = loadState();
  if (stateLoadFailure()) throw new Error("本地数据暂不可用，请稍后重试。");
  return state;
}

export function parcelActivityTarget(state: AppState, linkId: unknown): ParcelActivityTarget | undefined {
  if (typeof linkId !== "string" || !linkId || stateLoadFailure()) return undefined;
  const receipt = parcelActivityRegistry().receipts.find((item) => item.linkId === linkId);
  if (!receipt?.target) return undefined;
  return parcelForTarget(state, receipt.target) ? receipt.target : undefined;
}

function prepareArtwork(content: ParcelActivityContent): void {
  const root = Path.join(FileManager.appGroupDocumentsDirectory, PARCEL_ACTIVITY_ART);
  FileManager.createDirectorySync(root, true);
  const { mark, sticker, meal, mealSticker } = parcelCardArtwork(content);
  const sources = [
    { path: "parcel-activity/box.png", name: "box.png" },
    { path: `parcel-activity/${PARCEL_LOCK_SCREEN_BOX}`, name: PARCEL_LOCK_SCREEN_BOX },
    mark,
    sticker,
    meal,
    mealSticker,
  ];
  for (const file of sources) {
    if (!file) continue;
    const destination = Path.join(root, file.name);
    if (FileManager.existsSync(destination) && FileManager.isFileSync(destination)) continue;
    const source = Path.join(Script.directory, "assets", file.path);
    if (content.kind === "meal" && file === mark && !FileManager.isFileSync(source)) continue;
    FileManager.copyFileSync(source, destination);
  }
}

function activityData(content: ParcelActivityContent, lockScreenStyle: ParcelLockScreenStyle, linkId?: string, relevanceScore?: number) {
  const { target, expiresAtMs, capturedAtMs: _capturedAtMs, businessDateKey: _businessDateKey, ...card } = content;
  const link = target ? { linkId } : { previewLinkId: linkId };
  return { card: { ...card, ...link, lockScreenStyle }, options: { staleDate: target ? expiresAtMs : undefined, relevanceScore } };
}

async function createActivity(content: ParcelActivityContent, lockScreenStyle: ParcelLockScreenStyle, isCurrent: ActivityOwnership,
  relevanceScore?: number): Promise<boolean> {
  const linkId = UUID.string();
  const { card, options } = activityData(content, lockScreenStyle, linkId, relevanceScore);
  prepareArtwork(content);
  requireActivityOwnership(isCurrent);
  const activity = PipiParcelActivity();
  if (!await activity.start(card, options)) return false;
  const id = activity.activityId;
  try {
    requireActivityOwnership(isCurrent);
    if (!id) throw new Error("无法保存实时活动，请稍后重试。");
    const registry = parcelActivityRegistry();
    saveParcelActivityRegistry({
      ...registry, receipts: [...registry.receipts, { id, target: content.target, linkId }],
    });
  } catch (error) {
    await activity.end(EMPTY_CONTENT, { dismissTimeInterval: 0 });
    throw error;
  }
  displayed.set(id, JSON.stringify({ card, options }));
  if (!content.target) notifyActivityChanged({ kind: "preview" });
  return true;
}

function forgetReceipt(receipt: Receipt, isCurrent: ActivityOwnership, dismissedKey?: string): void {
  requireActivityOwnership(isCurrent);
  const registry = parcelActivityRegistry();
  if (!registry.receipts.some(item => item.id === receipt.id)) return;
  saveParcelActivityRegistry({
    ...registry,
    receipts: registry.receipts.filter((item) => item.id !== receipt.id),
    dismissed: dismissedKey ? [...new Set([...registry.dismissed, dismissedKey])] : registry.dismissed,
  });
  displayed.delete(receipt.id);
  if (!receipt.target) notifyActivityChanged({ kind: "preview" });
}

async function closeActivity(receipt: Receipt, isCurrent: ActivityOwnership): Promise<void> {
  requireActivityOwnership(isCurrent);
  await endActivity(receipt.id);
  forgetReceipt(receipt, isCurrent);
}

async function updateActivity(receipt: Receipt, content: ParcelActivityContent, lockScreenStyle: ParcelLockScreenStyle,
  isCurrent: ActivityOwnership, relevanceScore?: number): Promise<boolean> {
  if (!receipt.target && !receipt.linkId) {
    requireActivityOwnership(isCurrent);
    const registry = parcelActivityRegistry();
    receipt = { ...receipt, linkId: UUID.string() };
    saveParcelActivityRegistry({ ...registry, receipts: registry.receipts.map(item => item.id === receipt.id ? receipt : item) });
  }
  const { card, options } = activityData(content, lockScreenStyle, receipt.linkId, relevanceScore);
  const serialized = JSON.stringify({ card, options });
  if (displayed.get(receipt.id) === serialized) return true;
  const activity = await LiveActivity.from<ParcelActivityState>(receipt.id, PARCEL_ACTIVITY_NAME);
  prepareArtwork(content);
  requireActivityOwnership(isCurrent);
  if (await activity?.update(card, options)) {
    displayed.set(receipt.id, serialized);
    return isCurrent();
  }
  if (await isRunning(receipt)) throw new Error("实时活动更新失败，请稍后重试。");
  return false;
}

async function requireActivitiesEnabled(): Promise<void> {
  if (!(await LiveActivity.areActivitiesEnabled())) {
    throw new Error("请在系统设置中允许 Scripting 显示实时活动。");
  }
}

export function startParcelActivity(target: ParcelActivityTarget): Promise<void> {
  return serializeMutation(async isCurrent => {
    const registry = parcelActivityRegistry();
    if (registry.showAll || (await Promise.all(registry.receipts.map(isRunning))).some(Boolean)) {
      throw new Error("请先结束当前实时活动。");
    }
    await requireActivitiesEnabled();
    const content = parcelForTarget(committedState(), target);
    if (!content || (content.expiresAtMs !== undefined && content.expiresAtMs <= Date.now())) {
      throw new Error("该快递码已不可用。");
    }
    if (registry.receipts.length) {
      requireActivityOwnership(isCurrent);
      for (const receipt of registry.receipts) displayed.delete(receipt.id);
      saveParcelActivityRegistry({ ...registry, receipts: [] });
    }
    if (!await createActivity(content, registry.lockScreenStyle, isCurrent)) throw new Error("实时活动启动失败，请稍后重试。");
  });
}

export function startParcelActivityPreview(): Promise<void> {
  return serializeMutation(async isCurrent => {
    const { receipts, lockScreenStyle } = parcelActivityRegistry();
    const preview = receipts.find(receipt => !receipt.target);
    if (preview && await isRunning(preview)) {
      await updateActivity(preview, PARCEL_ACTIVITY_PREVIEW, lockScreenStyle, isCurrent);
      return;
    }
    await requireActivitiesEnabled();
    if (preview) forgetReceipt(preview, isCurrent);
    if (!await createActivity(PARCEL_ACTIVITY_PREVIEW, lockScreenStyle, isCurrent)) {
      throw new Error("锁屏预览暂时无法启动，请稍后重试。");
    }
  });
}

export function stopParcelActivityPreview(): Promise<void> {
  return serializeMutation(async isCurrent => {
    const preview = parcelActivityRegistry().receipts.find(receipt => !receipt.target);
    if (preview) await closeActivity(preview, isCurrent);
  });
}

type RankedCard = { key: string; content: ParcelActivityContent; rank: number };

async function replaceOldest(candidate: RankedCard, cards: readonly RankedCard[], isCurrent: ActivityOwnership): Promise<boolean> {
  if (!foreground || !await LiveActivity.areActivitiesEnabled()) return false;
  const { receipts, lockScreenStyle } = parcelActivityRegistry();
  for (let i = cards.length - 1; i >= 0; i--) {
    const oldest = cards[i];
    if (oldest.rank >= candidate.rank) return false;
    const receipt = receipts.find((item) => parcelCardKey(item) === oldest.key);
    if (!receipt || !await isRunning(receipt)) continue;
    if (!foreground) return false;
    await closeActivity(receipt, isCurrent);
    let replaced = false;
    try {
      replaced = foreground && await createActivity(candidate.content, lockScreenStyle, isCurrent, candidate.rank);
      return replaced;
    } finally {
      if (!replaced && isCurrent() && foreground && (oldest.content.expiresAtMs ?? Infinity) > Date.now() &&
        !await createActivity(oldest.content, lockScreenStyle, isCurrent, oldest.rank)) {
        writeDiagnostic("activity.parcel.restore.failed", { result: "rejected" }, "warning");
      }
    }
  }
  return false;
}

async function synchronizeActivities(
  state: AppState, isCurrent: ActivityOwnership,
  { cards, shortcutKeys, updateOnly }: {
    cards?: readonly ParcelActivityContent[];
    shortcutKeys?: ReadonlySet<string>;
    updateOnly?: boolean;
  } = {},
): Promise<Set<string>> {
  const registry = parcelActivityRegistry();
  const { lockScreenStyle } = registry;
  const shown = new Set<string>();
  if (stateLoadFailure() || cards && peekStateRevision() > state.revision ||
      !registry.showAll && (shortcutKeys || !registry.receipts.length)) return shown;
  if (shortcutKeys && !await LiveActivity.areActivitiesEnabled()) return shown;
  const now = Date.now();
  const byTime = (cards ?? [...activePickupCards(visibleShipments(state), state.pickupCodeRecords, state.pickupArtworkChoices), ...activeMealCards()])
    .filter((card) => card.target && (card.kind !== "meal" || (card.expiresAtMs ?? Infinity) > now))
    .sort((left, right) => (right.capturedAtMs ?? 0) - (left.capturedAtMs ?? 0) ||
      parcelCardKey(left).localeCompare(parcelCardKey(right)));
  const ranked = byTime.map((content, index) => ({
    key: parcelCardKey(content), content, rank: byTime.length - index,
  }));
  const byKey = new Map(ranked.map((card) => [card.key, card]));
  const activityStates = new Map((registry.receipts.length ? await LiveActivity.getAllActivities() : [])
    .map(({ id, state }) => [id, state]));
  let latest: AppState | undefined;
  for (const receipt of registry.receipts) {
    const key = parcelCardKey(receipt);
    const next = byKey.get(key);
    const activityState = activityStates.get(receipt.id);
    if (shortcutKeys && !shortcutKeys.has(key)) {
      const target = receipt.target;
      if (!next && target && "mealId" in target) {
        // A Shortcuts run is another chance to retire a meal after ActivityKit marks it stale.
        try {
          if (activityState === "stale" &&
              !parcelForTarget(latest ??= committedState(), target)) await closeActivity(receipt, isCurrent);
        } catch {
          writeDiagnostic("activity.parcel.expiry.failed", {}, "warning");
        }
      }
      continue;
    }
    if (activityState !== "active" && activityState !== "stale") {
      if (!updateOnly) forgetReceipt(receipt, isCurrent, registry.showAll && next ? key : undefined);
    } else if (key && !next) {
      if (updateOnly) continue;
      // A page snapshot can predate a meal committed by the Shortcut's separate runtime.
      if (cards && receipt.target && parcelForTarget(latest ??= committedState(), receipt.target)) continue;
      await closeActivity(receipt, isCurrent);
    } else if (next) {
      if (await updateActivity(receipt, next.content, lockScreenStyle, isCurrent, registry.showAll ? next.rank : undefined)) shown.add(key);
    } else if (!receipt.target) {
      await updateActivity(receipt, PARCEL_ACTIVITY_PREVIEW, lockScreenStyle, isCurrent);
    }
  }
  if (updateOnly || !registry.showAll) return shown;
  const current = parcelActivityRegistry();
  const dismissed = shortcutKeys ? current.dismissed : current.dismissed.filter((key) => byKey.has(key));
  if (dismissed.length !== current.dismissed.length) {
    requireActivityOwnership(isCurrent);
    saveParcelActivityRegistry({ ...current, dismissed });
  }
  if (!shortcutKeys && (!foreground || !await LiveActivity.areActivitiesEnabled())) return shown;
  for (const card of ranked) {
    if (shortcutKeys) {
      if (!shortcutKeys.has(card.key) || card.content.kind === "handoff") continue;
    } else if (!foreground) return shown;
    if (dismissed.includes(card.key) || (card.content.expiresAtMs ?? Infinity) <= Date.now() ||
      parcelActivityRegistry().receipts.some((item) => parcelCardKey(item) === card.key)) continue;
    if (await createActivity(card.content, lockScreenStyle, isCurrent, card.rank)) {
      shown.add(card.key);
      continue;
    }
    if (shortcutKeys) continue;
    const preview = parcelActivityRegistry().receipts.find(receipt => !receipt.target);
    if (preview) {
      await closeActivity(preview, isCurrent);
      if (await createActivity(card.content, lockScreenStyle, isCurrent, card.rank)) continue;
    }
    if (await replaceOldest(card, ranked, isCurrent)) continue;
    throw new Error("部分实时活动暂时无法显示，请在取件页查看。");
  }
  return shown;
}

export async function showShortcutPickupActivities(targets: readonly ParcelActivityTarget[]): Promise<boolean> {
  if (!targets.length) return false;
  try {
    if (!parcelActivityRegistry().showAll) return false;
    const keys = new Set(targets.map(target => parcelCardKey({ target })));
    const shown = await serializeMutation(isCurrent => synchronizeActivities(committedState(), isCurrent, { shortcutKeys: keys }));
    if (shown.size === keys.size) return true;
  } catch { /* The recognized records were already committed. */ }
  try { writeDiagnostic("shortcut.activity.unavailable", {}, "warning"); } catch { /* Diagnostics are optional. */ }
  return false;
}

export function startAllParcelActivities(): Promise<void> {
  return serializeMutation(async isCurrent => {
    await requireActivitiesEnabled();
    const state = committedState();
    requireActivityOwnership(isCurrent);
    saveParcelActivityRegistry({ ...parcelActivityRegistry(), showAll: true, dismissed: [] });
    await synchronizeActivities(state, isCurrent);
  });
}

export function setParcelLockScreenStyle(lockScreenStyle: ParcelLockScreenStyle): Promise<void> {
  return serializeMutation(async isCurrent => {
    const registry = parcelActivityRegistry();
    if (registry.lockScreenStyle === lockScreenStyle) return;
    requireActivityOwnership(isCurrent);
    saveParcelActivityRegistry({ ...registry, lockScreenStyle });
    if (registry.receipts.length) {
      // Repainting an existing activity cannot take a slot from the preview or another record.
      await synchronizeActivities(committedState(), isCurrent, { updateOnly: true });
    }
  });
}

export function stopParcelActivity(): Promise<void> {
  return serializeMutation(async isCurrent => {
    const registry = parcelActivityRegistry();
    requireActivityOwnership(isCurrent);
    saveParcelActivityRegistry({ ...registry, showAll: false, dismissed: [] });
    let failure: unknown;
    for (const receipt of registry.receipts) {
      try {
        await closeActivity(receipt, isCurrent);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  });
}

export function reconcileParcelActivity(state: AppState, cards?: readonly ParcelActivityContent[]): void {
  if (queuedReconciliation?.state === state && queuedReconciliation.cards === cards) return;
  const request = { state, cards };
  queuedReconciliation = request;
  void serialize(async () => {
    if (queuedReconciliation !== request) return;
    queuedReconciliation = undefined;
    const registry = parcelActivityRegistry();
    if (registry.showAll || registry.receipts.length) {
      await withActivityOwnership(isCurrent => synchronizeActivities(state, isCurrent, { cards }));
    }
  }).catch(() => {
    writeDiagnostic("activity.parcel.reconcile.failed", { result: "failed" }, "warning");
  });
}
