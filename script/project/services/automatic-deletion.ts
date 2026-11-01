import type { AccountBinding, AppState, Shipment, TimelinePackage } from "../models";
import { isNonEventDetail, NEAR_DUPLICATE_WINDOW_MS, normalizeWaybill,
  normalizedProjectedWaybill, parseProviderTime, trackFingerprint } from "./status";
import { automaticBindingIdentityOf, automaticSourceOf, displayWaybill,
  isOwnerFeedTrack, isQualifiedAutomaticShipment, normalizeAutomaticOwnership } from "./shipment-policy";
import { rowLedgerKey } from "./row-ledger";

type Fence = NonNullable<AppState["automaticDeletionFences"]>[number];
type Node = Fence["nodes"][number];
type DeletionState = Pick<AppState, "bindings" | "automaticDeletionFences">;

function orderKey(shipment: Shipment): string {
  return rowLedgerKey(`automatic-deletion:order:${shipment.identity.bindingSource}:${shipment.identity.sourceId}`);
}

function realWaybill(shipment: Shipment): string {
  return shipment.identity.accountOrder ? normalizedProjectedWaybill(shipment.identity) : displayWaybill(shipment);
}

function keys(shipment: Shipment): string[] {
  if (shipment.identity.accountOrder) return [orderKey(shipment)];
  const waybill = realWaybill(shipment);
  return waybill ? [rowLedgerKey(`automatic-deletion:waybill:${normalizeWaybill(waybill)}`)] : [orderKey(shipment)];
}

/** T1 deletes an order's own row, whereas a shipment deletion is scoped to its real waybill. */
function deletionKey(shipment: Shipment): string {
  return keys(shipment)[0];
}

export class AutomaticDeletionStateError extends Error {
  constructor() { super("Local automatic deletion data is invalid; original state was preserved."); }
}

export function normalizeAutomaticDeletions(values: AppState["automaticDeletionFences"]): Fence[] {
  const entries = new Map<string, Map<string, Node>>();
  if (values !== undefined && !Array.isArray(values)) throw new AutomaticDeletionStateError();
  for (const value of values || []) {
    if (!value || !/^row:[a-f0-9]{24}$/.test(value.key) || !Array.isArray(value.nodes)) throw new AutomaticDeletionStateError();
    const nodes = entries.get(value.key) || new Map<string, Node>();
    for (const node of value.nodes) {
      if (!node || !Number.isFinite(node.atMs) || node.atMs < 0 || !/^row:[a-f0-9]{24}$/.test(node.text)) throw new AutomaticDeletionStateError();
      nodes.set(`${node.atMs}:${node.text}`, { atMs: node.atMs, text: node.text });
    }
    entries.set(value.key, nodes);
  }
  return [...entries].map(([key, nodes]) => ({ key, nodes: [...nodes.values()] }));
}

function timelineNodes(timeline: TimelinePackage, now: number): Node[] {
  const result: Node[] = [];
  for (const track of timeline.tracks) {
    const fingerprint = trackFingerprint(track.detail);
    const atMs = track.timeMs ?? parseProviderTime(track.timeText);
    if (!fingerprint || isNonEventDetail(track.detail) || (atMs != null && (!Number.isFinite(atMs) || atMs < 0 || atMs > now))) continue;
    result.push({ atMs: atMs || 0, text: rowLedgerKey(`automatic-deletion:node:${fingerprint}`) });
  }
  return result;
}

function baselineNodes(shipment: Shipment, now: number): Node[] {
  const timelines = [shipment.timeline, ...(shipment.sourceTimeline ? [shipment.sourceTimeline] : []),
    ...(shipment.manualTimelines || []), ...(shipment.automaticOwnership?.observations || []).map(item => item.sourceTimeline)];
  return timelines.flatMap(timeline => {
    const nodes = timelineNodes(timeline, now);
    const atMs = parseProviderTime(timeline.latestTimeText);
    if (atMs && atMs <= now && timeline.latestDetail.trim() && !isNonEventDetail(timeline.latestDetail)) {
      nodes.push({ atMs, text: rowLedgerKey(`automatic-deletion:node:${trackFingerprint(timeline.latestDetail)}`) });
    }
    return nodes;
  });
}

export function rememberAutomaticDeletion(
  fences: AppState["automaticDeletionFences"], removed: Shipment | undefined,
  shipments: readonly Shipment[], now: number,
): Fence[] {
  if (!removed || removed.identity.manuallyAdded) return normalizeAutomaticDeletions(fences);
  const key = deletionKey(removed);
  const evidence = shipments.filter(shipment => keys(shipment).includes(key) || shipment.identity.id === removed.identity.id);
  return normalizeAutomaticDeletions([...(fences || []), { key, nodes: evidence.flatMap(row => baselineNodes(row, now)) }]);
}

function advances(fence: Fence, incoming: Shipment, now: number): boolean {
  const latest = Math.max(0, ...fence.nodes.map(node => node.atMs));
  const source = incoming.sourceTimeline || incoming.timeline;
  return timelineNodes({ ...source, tracks: source.tracks.filter(isOwnerFeedTrack) }, now).some(candidate =>
    candidate.atMs > 0 && candidate.atMs >= latest && !fence.nodes.some(node =>
      node.text === candidate.text && Math.abs(node.atMs - candidate.atMs) <= NEAR_DUPLICATE_WINDOW_MS));
}

function hasCurrentBinding(shipment: Shipment, bindings: readonly AccountBinding[], baseline?: readonly AccountBinding[]): boolean {
  const source = automaticSourceOf(shipment);
  const binding = automaticBindingIdentityOf(shipment);
  const candidates = bindings.filter(item => item.source === source);
  const matching = binding.startsWith("phone:")
    ? candidates.filter(item => `phone:${item.phone.replace(/\D/g, "")}` === binding)
    : binding.startsWith("tail:") ? candidates.filter(item => item.phone.endsWith(binding.slice(5))) : [];
  if (matching.length !== 1) return false;
  if (!baseline) return true;
  const current = matching[0];
  return baseline.some(item => item.source === current.source && item.phone === current.phone &&
    item.boundAtMs === current.boundAtMs && item.enhancedMode === current.enhancedMode &&
    item.enhancedAtMs === current.enhancedAtMs && item.enhancedIdentityFingerprint === current.enhancedIdentityFingerprint);
}

/** The early account gate precedes recognition; only the final qualified owner commit releases a fence. */
export function automaticDeletionAllows(state: DeletionState, incoming: Shipment, now: number, requireOwner = true,
  bindingBaseline?: readonly AccountBinding[]): boolean {
  if (incoming.identity.manuallyAdded) return true;
  const matching = (state.automaticDeletionFences || []).filter(fence => keys(incoming).includes(fence.key));
  if (!matching.length) return true;
  if (!hasCurrentBinding(incoming, state.bindings, bindingBaseline) || !matching.every(fence => advances(fence, incoming, now))) return false;
  if (!requireOwner) return true;
  const normalized = normalizeAutomaticOwnership(incoming, now);
  return isQualifiedAutomaticShipment(normalized) && normalized.automaticOwnership?.ownerSource === automaticSourceOf(normalized) &&
    normalized.automaticOwnership.ownerBindingIdentity === automaticBindingIdentityOf(normalized);
}

export function remainingAutomaticDeletions(
  state: DeletionState, committed: readonly Shipment[], now: number,
): Fence[] {
  return (state.automaticDeletionFences || []).filter(fence => !committed.some(shipment =>
    !shipment.identity.manuallyAdded && keys(shipment).includes(fence.key) && automaticDeletionAllows(state, shipment, now)));
}
