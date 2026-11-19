import { LiveActivity, Path, Script, type ScenePhase } from "scripting";
import { PARCEL_ACTIVITY_ART, PipiParcelActivity } from "../live_activity";
import type { AppState } from "../models";
import { pauseWhileActive } from "./deadline";
import { activeMealCards } from "./meal/cards";
import { writeDiagnostic } from "./logger";
import { acquireDurableRefreshLease } from "./refresh-runtime-state";
import { PARCEL_LOCK_SCREEN_BOX, parcelCardArtwork } from "./parcel-card-appearance";
import {
  EMPTY_CONTENT,
  PARCEL_ACTIVITY_NAME,
  endActivity,
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
const previewListeners = new Set<() => void>();

export function onParcelActivityPreviewChanged(listener: () => void): () => void {
  previewListeners.add(listener);
  return () => { previewListeners.delete(listener); };
}

function notifyPreviewChanged(): void {
  for (const listener of previewListeners) listener();
}

export function parcelActivitySceneChanged(phase: ScenePhase): void {
  foreground = phase === "active";
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  queuedReconciliation = undefined;
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

export function parcelActivityStatus(): Promise<{ showAll: boolean; count: number; previewing: boolean }> {
  return serialize(async () => {
    const { showAll, receipts } = parcelActivityRegistry();
    const running = (await Promise.all(receipts.map(async (receipt) => await isRunning(receipt) ? receipt : null)))
      .filter(receipt => receipt !== null);
    return { showAll, count: running.filter(receipt => receipt.target).length,
      previewing: running.some(receipt => !receipt.target) };
  });
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

function activityData(content: ParcelActivityContent, linkId?: string, relevanceScore?: number) {
  const { target: _target, expiresAtMs, capturedAtMs: _capturedAtMs, businessDateKey: _businessDateKey, ...card } = content;
  return { card: { ...card, linkId }, options: { staleDate: content.target ? expiresAtMs : undefined, relevanceScore } };
}

async function createActivity(content: ParcelActivityContent, isCurrent: ActivityOwnership, relevanceScore?: number): Promise<boolean> {
  const linkId = content.target ? UUID.string() : undefined;
  const { card, options } = activityData(content, linkId, relevanceScore);
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
  if (!content.target) notifyPreviewChanged();
  return true;
}

function forgetReceipt(receipt: Receipt, isCurrent: ActivityOwnership, dismissedKey?: string): void {
  requireActivityOwnership(isCurrent);
  const registry = parcelActivityRegistry();
  saveParcelActivityRegistry({
    ...registry,
    receipts: registry.receipts.filter((item) => item.id !== receipt.id),
    dismissed: dismissedKey ? [...new Set([...registry.dismissed, dismissedKey])] : registry.dismissed,
  });
  displayed.delete(receipt.id);
  if (!receipt.target) notifyPreviewChanged();
}

async function closeActivity(receipt: Receipt, isCurrent: ActivityOwnership): Promise<void> {
  requireActivityOwnership(isCurrent);
  await endActivity(receipt.id);
  forgetReceipt(receipt, isCurrent);
}

async function updateActivity(receipt: Receipt, content: ParcelActivityContent, isCurrent: ActivityOwnership, relevanceScore?: number): Promise<boolean> {
  const { card, options } = activityData(content, receipt.linkId, relevanceScore);
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
    if (!await createActivity(content, isCurrent)) throw new Error("实时活动启动失败，请稍后重试。");
  });
}

export function startParcelActivityPreview(): Promise<void> {
  return serializeMutation(async isCurrent => {
    const preview = parcelActivityRegistry().receipts.find(receipt => !receipt.target);
    if (preview && await isRunning(preview)) {
      await updateActivity(preview, PARCEL_ACTIVITY_PREVIEW, isCurrent);
      return;
    }
    await requireActivitiesEnabled();
    if (preview) forgetReceipt(preview, isCurrent);
    if (!await createActivity(PARCEL_ACTIVITY_PREVIEW, isCurrent)) {
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
  const receipts = parcelActivityRegistry().receipts;
  for (let i = cards.length - 1; i >= 0; i--) {
    const oldest = cards[i];
    if (oldest.rank >= candidate.rank) return false;
    const receipt = receipts.find((item) => parcelCardKey(item) === oldest.key);
    if (!receipt || !await isRunning(receipt)) continue;
    if (!foreground) return false;
    await closeActivity(receipt, isCurrent);
    let replaced = false;
    try {
      replaced = foreground && await createActivity(candidate.content, isCurrent, candidate.rank);
      return replaced;
    } finally {
      if (!replaced && isCurrent() && foreground && (oldest.content.expiresAtMs ?? Infinity) > Date.now() &&
        !await createActivity(oldest.content, isCurrent, oldest.rank)) {
        writeDiagnostic("activity.parcel.restore.failed", { result: "rejected" }, "warning");
      }
    }
  }
  return false;
}

async function synchronizeActivities(
  state: AppState, isCurrent: ActivityOwnership, cards?: readonly ParcelActivityContent[],
  shortcutKeys?: ReadonlySet<string>,
): Promise<Set<string>> {
  const registry = parcelActivityRegistry();
  const shown = new Set<string>();
  if (stateLoadFailure() || cards && peekStateRevision() > state.revision ||
      !registry.showAll && (shortcutKeys || !registry.receipts.length)) return shown;
  if (shortcutKeys && !await LiveActivity.areActivitiesEnabled()) return shown;
  const byTime = (cards ?? [...activePickupCards(visibleShipments(state), state.pickupCodeRecords, state.pickupArtworkChoices), ...activeMealCards()])
    .filter((card) => card.target)
    .sort((left, right) => (right.capturedAtMs ?? 0) - (left.capturedAtMs ?? 0) ||
      parcelCardKey(left).localeCompare(parcelCardKey(right)));
  const ranked = byTime.map((content, index) => ({
    key: parcelCardKey(content), content, rank: byTime.length - index,
  }));
  const byKey = new Map(ranked.map((card) => [card.key, card]));
  let latest: AppState | undefined;
  for (const receipt of registry.receipts) {
    const key = parcelCardKey(receipt);
    if (shortcutKeys && !shortcutKeys.has(key)) continue;
    const next = byKey.get(key);
    if (!await isRunning(receipt)) {
      forgetReceipt(receipt, isCurrent, registry.showAll && next ? key : undefined);
    } else if (key && !next) {
      // A page snapshot can predate a meal committed by the Shortcut's separate runtime.
      if (cards && receipt.target && parcelForTarget(latest ??= committedState(), receipt.target)) continue;
      await closeActivity(receipt, isCurrent);
    } else if (next) {
      if (await updateActivity(receipt, next.content, isCurrent, registry.showAll ? next.rank : undefined)) shown.add(key);
    } else if (!receipt.target) {
      await updateActivity(receipt, PARCEL_ACTIVITY_PREVIEW, isCurrent);
    }
  }
  if (!registry.showAll) return shown;
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
    if (await createActivity(card.content, isCurrent, card.rank)) {
      shown.add(card.key);
      continue;
    }
    if (shortcutKeys) continue;
    const preview = parcelActivityRegistry().receipts.find(receipt => !receipt.target);
    if (preview) {
      await closeActivity(preview, isCurrent);
      if (await createActivity(card.content, isCurrent, card.rank)) continue;
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
    const shown = await serializeMutation(isCurrent => synchronizeActivities(committedState(), isCurrent, undefined, keys));
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
  void serialize(async () => {
    if (queuedReconciliation === request) queuedReconciliation = undefined;
    const registry = parcelActivityRegistry();
    if (registry.showAll || registry.receipts.length) {
      await withActivityOwnership(isCurrent => synchronizeActivities(state, isCurrent, cards));
    }
  }).catch(() => {
    writeDiagnostic("activity.parcel.reconcile.failed", { result: "failed" }, "warning");
  });
  queuedReconciliation = request;
}
