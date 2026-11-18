import { LiveActivity, Path, Script, type ScenePhase } from "scripting";
import { PARCEL_ACTIVITY_ART, PipiParcelActivity } from "../live_activity";
import type { AppState } from "../models";
import { writeDiagnostic } from "./logger";
import { parcelCardArtwork } from "./parcel-card-appearance";
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
import { loadState, parcelCardKey, stateLoadFailure, visibleShipments } from "./storage";

let pending: Promise<unknown> = Promise.resolve();
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
  const next = pending.then(operation);
  pending = next.catch(() => undefined);
  return next;
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
  const { mark, sticker } = parcelCardArtwork(content);
  const sources = [{ path: "parcel-activity/box.png", name: "box.png" }, mark, sticker];
  for (const file of sources) {
    if (!file) continue;
    const destination = Path.join(root, file.name);
    if (FileManager.existsSync(destination) && FileManager.isFileSync(destination)) continue;
    FileManager.copyFileSync(Path.join(Script.directory, "assets", file.path), destination);
  }
}

function activityData(content: ParcelActivityContent, linkId?: string, relevanceScore?: number) {
  const { target: _target, expiresAtMs, capturedAtMs: _capturedAtMs, businessDateKey: _businessDateKey, ...card } = content;
  return { card: { ...card, linkId }, options: { staleDate: content.target ? expiresAtMs : undefined, relevanceScore } };
}

async function createActivity(content: ParcelActivityContent, relevanceScore?: number): Promise<boolean> {
  const linkId = content.target ? UUID.string() : undefined;
  const { card, options } = activityData(content, linkId, relevanceScore);
  prepareArtwork(content);
  const activity = PipiParcelActivity();
  if (!await activity.start(card, options)) return false;
  const id = activity.activityId;
  try {
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

function forgetReceipt(receipt: Receipt, dismissedKey?: string): void {
  const registry = parcelActivityRegistry();
  saveParcelActivityRegistry({
    ...registry,
    receipts: registry.receipts.filter((item) => item.id !== receipt.id),
    dismissed: dismissedKey ? [...new Set([...registry.dismissed, dismissedKey])] : registry.dismissed,
  });
  displayed.delete(receipt.id);
  if (!receipt.target) notifyPreviewChanged();
}

async function closeActivity(receipt: Receipt): Promise<void> {
  await endActivity(receipt.id);
  forgetReceipt(receipt);
}

async function updateActivity(receipt: Receipt, content: ParcelActivityContent, relevanceScore?: number): Promise<void> {
  const { card, options } = activityData(content, receipt.linkId, relevanceScore);
  const serialized = JSON.stringify({ card, options });
  if (displayed.get(receipt.id) === serialized) return;
  const activity = await LiveActivity.from<ParcelActivityState>(receipt.id, PARCEL_ACTIVITY_NAME);
  prepareArtwork(content);
  if (await activity?.update(card, options)) {
    displayed.set(receipt.id, serialized);
    return;
  }
  if (await isRunning(receipt)) throw new Error("实时活动更新失败，请稍后重试。");
}

async function requireActivitiesEnabled(): Promise<void> {
  if (!(await LiveActivity.areActivitiesEnabled())) {
    throw new Error("请在系统设置中允许 Scripting 显示实时活动。");
  }
}

export function startParcelActivity(target: ParcelActivityTarget): Promise<void> {
  return serialize(async () => {
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
      for (const receipt of registry.receipts) displayed.delete(receipt.id);
      saveParcelActivityRegistry({ ...registry, receipts: [] });
    }
    if (!await createActivity(content)) throw new Error("实时活动启动失败，请稍后重试。");
  });
}

export function startParcelActivityPreview(): Promise<void> {
  return serialize(async () => {
    const preview = parcelActivityRegistry().receipts.find(receipt => !receipt.target);
    if (preview && await isRunning(preview)) {
      await updateActivity(preview, PARCEL_ACTIVITY_PREVIEW);
      return;
    }
    await requireActivitiesEnabled();
    if (preview) forgetReceipt(preview);
    if (!await createActivity(PARCEL_ACTIVITY_PREVIEW)) {
      throw new Error("锁屏预览暂时无法启动，请稍后重试。");
    }
  });
}

export function stopParcelActivityPreview(): Promise<void> {
  return serialize(async () => {
    const preview = parcelActivityRegistry().receipts.find(receipt => !receipt.target);
    if (preview) await closeActivity(preview);
  });
}

type RankedCard = { key: string; content: ParcelActivityContent; rank: number };

async function replaceOldest(candidate: RankedCard, cards: readonly RankedCard[]): Promise<boolean> {
  if (!foreground || !await LiveActivity.areActivitiesEnabled()) return false;
  const receipts = parcelActivityRegistry().receipts;
  for (let i = cards.length - 1; i >= 0; i--) {
    const oldest = cards[i];
    if (oldest.rank >= candidate.rank) return false;
    const receipt = receipts.find((item) => parcelCardKey(item) === oldest.key);
    if (!receipt || !await isRunning(receipt)) continue;
    if (!foreground) return false;
    await closeActivity(receipt);
    let replaced = false;
    try {
      replaced = foreground && await createActivity(candidate.content, candidate.rank);
      return replaced;
    } finally {
      if (!replaced && foreground && (oldest.content.expiresAtMs ?? Infinity) > Date.now() &&
        !await createActivity(oldest.content, oldest.rank)) {
        writeDiagnostic("activity.parcel.restore.failed", { result: "rejected" }, "warning");
      }
    }
  }
  return false;
}

async function synchronizeActivities(state: AppState): Promise<void> {
  const registry = parcelActivityRegistry();
  if (stateLoadFailure() || !registry.showAll && !registry.receipts.length) return;
  const byTime = activePickupCards(visibleShipments(state), state.pickupCodeRecords)
    .filter((card) => card.target)
    .sort((left, right) => (right.capturedAtMs ?? 0) - (left.capturedAtMs ?? 0) ||
      parcelCardKey(left).localeCompare(parcelCardKey(right)));
  const ranked = byTime.map((content, index) => ({
    key: parcelCardKey(content), content, rank: byTime.length - index,
  }));
  const byKey = new Map(ranked.map((card) => [card.key, card]));
  for (const receipt of registry.receipts) {
    const key = parcelCardKey(receipt);
    const next = byKey.get(key);
    if (!await isRunning(receipt)) {
      forgetReceipt(receipt, registry.showAll && next ? key : undefined);
    } else if (key && !next) {
      await closeActivity(receipt);
    } else if (next) {
      await updateActivity(receipt, next.content, registry.showAll ? next.rank : undefined);
    } else if (!receipt.target) {
      await updateActivity(receipt, PARCEL_ACTIVITY_PREVIEW);
    }
  }
  if (!registry.showAll) return;
  const current = parcelActivityRegistry();
  const dismissed = current.dismissed.filter((key) => byKey.has(key));
  if (dismissed.length !== current.dismissed.length) {
    saveParcelActivityRegistry({ ...current, dismissed });
  }
  if (!foreground || !await LiveActivity.areActivitiesEnabled()) return;
  for (const card of ranked) {
    if (!foreground) return;
    if (dismissed.includes(card.key) || (card.content.expiresAtMs ?? Infinity) <= Date.now() ||
      parcelActivityRegistry().receipts.some((item) => parcelCardKey(item) === card.key)) continue;
    if (await createActivity(card.content, card.rank)) continue;
    const preview = parcelActivityRegistry().receipts.find(receipt => !receipt.target);
    if (preview) {
      await closeActivity(preview);
      if (await createActivity(card.content, card.rank)) continue;
    }
    if (await replaceOldest(card, ranked)) continue;
    throw new Error("部分实时活动暂时无法显示，请在取件页查看。");
  }
}

export function startAllParcelActivities(): Promise<void> {
  return serialize(async () => {
    await requireActivitiesEnabled();
    const state = committedState();
    saveParcelActivityRegistry({ ...parcelActivityRegistry(), showAll: true, dismissed: [] });
    await synchronizeActivities(state);
  });
}

export function stopParcelActivity(): Promise<void> {
  return serialize(async () => {
    const registry = parcelActivityRegistry();
    saveParcelActivityRegistry({ ...registry, showAll: false, dismissed: [] });
    let failure: unknown;
    for (const receipt of registry.receipts) {
      try {
        await closeActivity(receipt);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  });
}

export function reconcileParcelActivity(state: AppState): void {
  void serialize(() => synchronizeActivities(state)).catch(() => {
    writeDiagnostic("activity.parcel.reconcile.failed", { result: "failed" }, "warning");
  });
}
