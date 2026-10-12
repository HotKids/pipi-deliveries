import type { AccountDetailRecord, AttachedCarrierStatus, Shipment } from "../models";
import { JING_DONG_ACCOUNT_CP_CODE, JING_DONG_ACCOUNT_NAME } from "./account-parser";
import { SCRIPT_BINDING_SOURCE } from "./script-source";
import { displayWaybill, forcedCompletedAt } from "./shipment-policy";
import { normalizedProjectedWaybill, normalizeWaybill } from "./status";
import { normalizeTimelineSlot, TIMELINE_SLOT } from "./timeline-slot";
import { timelineNormalizedStatus } from "./worker-status";

/*
 * 投影订单的归属（用户 2026-09-25 采纳归属方案 T1–T7，iOS 那一份）：一条上游记录只写它自己的行；同一个运单号上
 * 先占号的那一行显示，其余的行挂靠：行保留、照常写自己的数据、留存按自己的时间，不进列表、小组件、搜索与通知。
 * 运单行的占号时间是它的创建时间，订单是投影时刻（归属-5），升级前已投影的订单记为迁移时刻；同一时刻按 id 排序。
 * 手动行不参与占号：自动来源照 §5.2 接管它（归属-1，iOS 照现状并入手动轨迹）。
 */

function validTime(value: unknown): number {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? time : 0;
}

/** The rows that take part: this script's automatic rows, keyed by the number they stand for. */
function occupancyKey(shipment: Shipment): string {
  if (shipment.identity.manuallyAdded || shipment.identity.bindingSource !== SCRIPT_BINDING_SOURCE) return "";
  return displayWaybill(shipment);
}

function projectedOrder(shipment: Shipment): boolean {
  return Boolean(shipment.identity.accountOrder && normalizedProjectedWaybill(shipment.identity));
}

/**
 * A row's occupied-at time. A projected order that has not been stamped yet is an existing projection whose
 * migration has not run: it counts from the migration, after every row that already has a time.
 */
export function waybillOccupiedAtMs(shipment: Shipment): number {
  const stored = validTime(shipment.occupiedAtMs);
  if (stored) return stored;
  if (projectedOrder(shipment)) return Number.POSITIVE_INFINITY;
  return validTime(shipment.identity.createdAtMs);
}

function occupiesBefore(left: Shipment, right: Shipment): boolean {
  const leftAt = waybillOccupiedAtMs(left);
  const rightAt = waybillOccupiedAtMs(right);
  if (leftAt !== rightAt) return leftAt < rightAt;
  return left.identity.id.localeCompare(right.identity.id) < 0;
}

/** Displayed waybill → the row that occupied it first (T2, 归属-4/5). */
export function firstWaybillOccupants(shipments: readonly Shipment[]): Map<string, Shipment> {
  const first = new Map<string, Shipment>();
  for (const shipment of shipments) {
    const key = occupancyKey(shipment);
    if (!key) continue;
    const current = first.get(key);
    if (!current || occupiesBefore(shipment, current)) first.set(key, shipment);
  }
  return first;
}

/** Rows hidden behind the first occupant of their waybill (T3). */
export function attachedShipmentIds(shipments: readonly Shipment[]): Set<string> {
  const first = firstWaybillOccupants(shipments);
  const attached = new Set<string>();
  for (const shipment of shipments) {
    const key = occupancyKey(shipment);
    if (key && first.get(key) !== shipment) attached.add(shipment.identity.id);
  }
  return attached;
}

export function isAttachedShipment(shipments: readonly Shipment[], shipment: Shipment): boolean {
  const key = occupancyKey(shipment);
  if (!key) return false;
  const first = firstWaybillOccupants(
    shipments.filter((candidate) => occupancyKey(candidate) === key),
  ).get(key);
  return Boolean(first && first.identity.id !== shipment.identity.id);
}

/**
 * 归属-2（用户 2026-09-25）：只有先占号的可见行，它的详情页可以接上挂靠订单的订单阶段节点；挂靠行自己的详情页什么也不接。
 */
export function attachedProjectedOrders(
  shipments: readonly Shipment[],
  visible: Shipment | null | undefined,
): Shipment[] {
  if (!visible) return [];
  const key = occupancyKey(visible);
  if (!key) return [];
  const group = shipments.filter((candidate) => occupancyKey(candidate) === key);
  if (firstWaybillOccupants(group).get(key)?.identity.id !== visible.identity.id) return [];
  return group.filter((candidate) =>
    candidate.identity.id !== visible.identity.id && projectedOrder(candidate));
}

/**
 * What an attached carrier record reports (用户 2026-09-26 采纳 A): its presented structured status and headline.
 * The user's own sign-off on that row is not a report of the record.
 */
function attachedCarrierStatusOf(carrier: Shipment): AttachedCarrierStatus | undefined {
  if (forcedCompletedAt(carrier)) return undefined;
  const timeline = carrier.timeline;
  const eventAt = validTime(timeline.statusEventAtMs);
  if (timeline.structuredStatus !== true || timeline.semantic === "UNKNOWN" || !eventAt) return undefined;
  const normalizedStatus = timelineNormalizedStatus(timeline);
  return {
    shipmentId: carrier.identity.id,
    semantic: timeline.semantic,
    statusEventAtMs: eventAt,
    ...(normalizedStatus ? { normalizedStatus } : {}),
    latestTimeText: timeline.latestTimeText,
    latestDetail: timeline.latestDetail,
  };
}

/** Stored rows come back with sorted keys; compare values, not key order. */
function sameValue(left: unknown, right: unknown): boolean {
  const stable = (value: unknown) => JSON.stringify(value ?? null, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]]))
      : item);
  return stable(left) === stable(right);
}

function bumped(shipment: Shipment, now: number): number {
  return Math.max(now, (Number(shipment.updatedAtMs) || 0) + 1);
}

function withoutField<K extends "note" | "attachedCarrierStatus">(shipment: Shipment, key: K): Shipment {
  if (shipment[key] === undefined) return shipment;
  const copy: Shipment = { ...shipment };
  delete copy[key];
  return copy;
}

/**
 * The durable ownership pass, run wherever the whole list is written: at load (`previousShipments` null) and at every save.
 *
 * 1. Occupied-at (归属-5): a row keeps the time it already had for the same number; a projection that changed the
 *    number, or a new projection, takes `now`; an existing projection without a time takes `now` (the migration time);
 *    any other row takes its creation time.
 * 2. Remarks (归属-6): a row that becomes attached hands its remark to the visible row when that row has none. It only
 *    happens on the transition, so a remark the user later clears on the visible row does not come back.
 * 3. Order first (用户 2026-09-26 采纳 A): a visible projected order carries its attached carrier record's structured
 *    status and headline; `reselect` rebuilds a row whose carried status changed. An attached row never carries one.
 */
export function withWaybillOwnership(
  previousShipments: readonly Shipment[] | null,
  shipments: readonly Shipment[],
  now: number,
  reselect: (shipment: Shipment) => Shipment,
): Shipment[] {
  const previousById = new Map((previousShipments || []).map((shipment) => [shipment.identity.id, shipment]));
  const unstampedBefore = new Set<string>();
  let rows = shipments.map((shipment) => {
    const key = occupancyKey(shipment);
    if (!key) return shipment;
    if (!validTime(shipment.occupiedAtMs)) unstampedBefore.add(shipment.identity.id);
    const previous = previousById.get(shipment.identity.id);
    const sameNumber = !previous || displayWaybill(previous) === key;
    const occupiedAtMs = previous && sameNumber && validTime(previous.occupiedAtMs)
      ? validTime(previous.occupiedAtMs)
      : sameNumber && validTime(shipment.occupiedAtMs)
        ? validTime(shipment.occupiedAtMs)
        : projectedOrder(shipment)
          ? now
          : Math.min(validTime(shipment.identity.createdAtMs) || now, now);
    return shipment.occupiedAtMs === occupiedAtMs ? shipment : { ...shipment, occupiedAtMs };
  });

  const first = firstWaybillOccupants(rows);
  const attached = attachedShipmentIds(rows);
  const previouslyAttached = previousShipments ? attachedShipmentIds(previousShipments) : null;
  const byId = new Map(rows.map((shipment) => [shipment.identity.id, shipment]));
  const movers = rows
    .filter((shipment) => attached.has(shipment.identity.id) && String(shipment.note || "").trim() && (
      previouslyAttached
        ? !(previousById.has(shipment.identity.id) && previouslyAttached.has(shipment.identity.id))
        : unstampedBefore.has(shipment.identity.id)
    ))
    .sort((left, right) => occupiesBefore(left, right) ? -1 : 1);
  for (const mover of movers) {
    const visibleId = first.get(occupancyKey(mover))?.identity.id;
    const visible = visibleId ? byId.get(visibleId) : undefined;
    const current = byId.get(mover.identity.id)!;
    if (!visible || String(visible.note || "").trim()) continue;
    byId.set(visible.identity.id, { ...visible, note: String(current.note).trim(), updatedAtMs: bumped(visible, now) });
    byId.set(current.identity.id, { ...withoutField(current, "note"), updatedAtMs: bumped(current, now) });
  }
  rows = rows.map((shipment) => byId.get(shipment.identity.id) || shipment);

  const carriers = new Map<string, AttachedCarrierStatus>();
  for (const shipment of rows) {
    const key = occupancyKey(shipment);
    const visible = key ? first.get(key) : undefined;
    if (!visible || visible.identity.id === shipment.identity.id || !projectedOrder(visible) ||
        shipment.identity.accountOrder) continue;
    const status = attachedCarrierStatusOf(shipment);
    const known = carriers.get(visible.identity.id);
    if (status && (!known || status.statusEventAtMs > known.statusEventAtMs)) {
      carriers.set(visible.identity.id, status);
    }
  }
  return rows.map((shipment) => {
    if (!occupancyKey(shipment)) return shipment;
    const status = carriers.get(shipment.identity.id);
    if (sameValue(shipment.attachedCarrierStatus, status)) return shipment;
    const carried: Shipment = status
      ? { ...shipment, attachedCarrierStatus: status }
      : withoutField(shipment, "attachedCarrierStatus");
    return reselect({ ...carried, updatedAtMs: bumped(shipment, now) });
  });
}

/*
 * 归属-4（用户 2026-09-25，同意偏离 §5.6「不重新仲裁」）：旧版本把运单行并进了投影订单的行，留下的是订单号的行，里面装着
 * 那条运单记录的账号元组（运单号、来源）。升级时一次性拆开：运单行按运单记录自己的身份重建并照原样显示，订单回到它
 * 自己的身份并挂靠。不推送、不删行、不删缓存；拆不开的行原样不动，只记日志。只看没有占号时间的行（升级前的数据），
 * 所以同一行只拆一次。
 */

export type MergedOrderSplitSkip = "waybill_row_exists" | "shared_record" | "missing_phone";

export type MergedOrderSplit = Readonly<{
  orderId: string;
  waybillRowId: string;
  /** The waybill record's CaiNiao route pointer follows its own row. */
  routeMoved: boolean;
}>;

export type MergedOrderSplitPlan = Readonly<{
  shipments: Shipment[];
  splits: readonly MergedOrderSplit[];
  skipped: readonly MergedOrderSplitSkip[];
}>;

/** The waybill whose own account record this order-number row holds, or "" for a row in its normal shape. */
function heldWaybillRecord(shipment: Shipment): string {
  const identity = shipment.identity;
  if (identity.manuallyAdded || identity.bindingSource !== SCRIPT_BINDING_SOURCE || !identity.accountOrder ||
      validTime(shipment.occupiedAtMs)) return "";
  const waybill = normalizedProjectedWaybill(identity);
  const held = normalizeWaybill(shipment.accountRecord?.waybill || "");
  const own = normalizeWaybill(identity.orderId || identity.sourceId);
  return waybill && held === waybill && held !== own ? waybill : "";
}

function phoneOf(shipment: Shipment): string {
  const phone = String(shipment.identity.phone || shipment.accountRecord?.phone || "").replace(/\D/g, "");
  return phone.length >= 4 ? phone : "";
}

function keepsCainiaoRoute(provider: string): boolean {
  return provider.trim().toLowerCase() === "cainiao";
}

function splitMergedOrderRow(
  merged: Shipment,
  waybill: string,
  now: number,
): { order: Shipment; waybillRow: Shipment; routeMoved: boolean } {
  const record = merged.accountRecord as AccountDetailRecord;
  const phone = phoneOf(merged);
  const sourceProvider = String(record.provider || merged.identity.sourceProvider || "");
  const createdAtMs = Math.min(validTime(merged.identity.createdAtMs) || now - 1, now - 1);
  const routeMoved = merged.route?.kind === "cainiao" && keepsCainiaoRoute(sourceProvider);
  // The order's own jd_h5 page and its order-number query stay with the order; everything else is about the parcel.
  const parcelSlots = (merged.manualTimelines || []).filter((timeline) => {
    const slot = normalizeTimelineSlot(timeline.provider);
    return slot !== TIMELINE_SLOT.JD_H5 && slot !== TIMELINE_SLOT.V5_QUERY;
  });
  const selection = merged.detailSelection;
  const selectionSlot = selection ? normalizeTimelineSlot(selection.provider) : "";
  const waybillRow: Shipment = {
    identity: {
      id: `${SCRIPT_BINDING_SOURCE}:account:${waybill}`,
      bindingSource: SCRIPT_BINDING_SOURCE,
      sourceOwner: SCRIPT_BINDING_SOURCE,
      sourceId: waybill,
      phoneTail: merged.identity.phoneTail || phone.slice(-4),
      phone,
      courierCode: merged.identity.courierCode,
      rawCourierCode: record.companyCode || merged.identity.rawCourierCode,
      rawCompanyName: record.name || merged.identity.rawCompanyName,
      companyName: merged.identity.companyName,
      ...(merged.identity.carrierIsBuiltIn !== undefined
        ? { carrierIsBuiltIn: merged.identity.carrierIsBuiltIn } : {}),
      ...(merged.identity.carrierKuaidi100Code
        ? { carrierKuaidi100Code: merged.identity.carrierKuaidi100Code } : {}),
      ...(merged.identity.carrierTableVersion
        ? { carrierTableVersion: merged.identity.carrierTableVersion } : {}),
      sourceProvider,
      ...(merged.identity.sender !== undefined ? { sender: merged.identity.sender } : {}),
      orderId: "",
      projectedWaybill: "",
      accountOrder: false,
      manuallyAdded: false,
      createdAtMs,
    },
    // What the merged row showed stays on screen; each row's own list record replaces it from its next report on.
    timeline: merged.timeline,
    sourceTimeline: merged.sourceTimeline ?? null,
    manualTimelines: parcelSlots,
    route: routeMoved ? merged.route : null,
    accountRecord: record,
    ...(merged.forcedCompletedAtMs !== undefined ? { forcedCompletedAtMs: merged.forcedCompletedAtMs } : {}),
    ...(merged.settledAtMs !== undefined ? { settledAtMs: merged.settledAtMs } : {}),
    ...(merged.emptyTimelineHiddenAtMs !== undefined
      ? { emptyTimelineHiddenAtMs: merged.emptyTimelineHiddenAtMs } : {}),
    ...(merged.cainiaoH5FallbackActivatedAtMs !== undefined
      ? { cainiaoH5FallbackActivatedAtMs: merged.cainiaoH5FallbackActivatedAtMs } : {}),
    ...(merged.manualRefreshAttemptAtMs !== undefined
      ? { manualRefreshAttemptAtMs: merged.manualRefreshAttemptAtMs } : {}),
    ...(selection && selectionSlot !== TIMELINE_SLOT.JD_H5 && selectionSlot !== TIMELINE_SLOT.V5_QUERY
      ? { detailSelection: selection } : {}),
    occupiedAtMs: createdAtMs,
    updatedAtMs: merged.updatedAtMs,
  };
  const ownRecord: AccountDetailRecord = {
    waybill: merged.identity.orderId || merged.identity.sourceId,
    companyCode: JING_DONG_ACCOUNT_CP_CODE,
    name: JING_DONG_ACCOUNT_NAME,
    provider: "JingDong",
    stateNumber: 0,
    updateTime: "",
    phone: record.phone || phone,
    channel: record.channel || "1",
  };
  const orderIdentity = { ...merged.identity, sourceProvider: "JingDong" };
  const ownership = merged.automaticOwnership;
  const order: Shipment = {
    ...merged,
    identity: orderIdentity,
    accountRecord: ownRecord,
    route: null,
    ...(ownership ? {
      automaticOwnership: {
        ...ownership,
        observations: ownership.observations.map((observation) =>
          observation.identity.id === merged.identity.id
            ? { ...observation, identity: { ...observation.identity, sourceProvider: "JingDong" },
                accountRecord: ownRecord, routeCapability: null }
            : observation),
      },
    } : {}),
  };
  return { order, waybillRow, routeMoved };
}

export function splitMergedOrderRows(shipments: readonly Shipment[], now: number): MergedOrderSplitPlan {
  const holders = new Map<string, Shipment[]>();
  for (const shipment of shipments) {
    const waybill = heldWaybillRecord(shipment);
    if (waybill) holders.set(waybill, [...(holders.get(waybill) || []), shipment]);
  }
  if (!holders.size) return { shipments: [...shipments], splits: [], skipped: [] };
  const ids = new Set(shipments.map((shipment) => shipment.identity.id));
  const replaced = new Map<string, Shipment>();
  const added: Shipment[] = [];
  const splits: MergedOrderSplit[] = [];
  const skipped: MergedOrderSplitSkip[] = [];
  for (const [waybill, owners] of holders) {
    const waybillRowId = `${SCRIPT_BINDING_SOURCE}:account:${waybill}`;
    const reason: MergedOrderSplitSkip | null = owners.length > 1
      ? "shared_record"
      : ids.has(waybillRowId)
        ? "waybill_row_exists"
        : !phoneOf(owners[0]!)
          ? "missing_phone"
          : null;
    if (reason) {
      for (const _owner of owners) skipped.push(reason);
      continue;
    }
    const split = splitMergedOrderRow(owners[0]!, waybill, now);
    replaced.set(split.order.identity.id, split.order);
    added.push(split.waybillRow);
    splits.push({ orderId: split.order.identity.id, waybillRowId, routeMoved: split.routeMoved });
  }
  return {
    shipments: [...shipments.map((shipment) => replaced.get(shipment.identity.id) || shipment), ...added],
    splits,
    skipped,
  };
}
