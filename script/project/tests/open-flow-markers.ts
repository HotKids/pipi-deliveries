import { memory } from "./state-storage-mock";

/**
 * The device-local markers of running diagnostic flows (D4), keyed `<flowId>:<event>`, as tests read and seed them.
 * R5-NEW-11 ⑥ keeps one file per flow under the diagnostic store; a build before it kept one shared map under
 * LEGACY_OPEN_FLOWS_KEY, which the reader still includes so a marker either way is seen.
 */
export const LEGACY_OPEN_FLOWS_KEY = "pipi_deliveries_diagnostic_open_flows_v1";
export const OPEN_FLOWS_DIRECTORY = "/group/pipi-deliveries/diagnostics-v2/open-flows";
export type OpenFlowMarker = { event: string; startedAtMs: number; runtime: string; host?: string };

const filePrefix = `file:${OPEN_FLOWS_DIRECTORY}/`;

export function openFlows(): Record<string, OpenFlowMarker> {
  const flows: Record<string, OpenFlowMarker> = {};
  const legacy = memory.get(LEGACY_OPEN_FLOWS_KEY);
  if (typeof legacy === "string") Object.assign(flows, JSON.parse(legacy));
  for (const [key, value] of memory) {
    if (!key.startsWith(filePrefix)) continue;
    const match = /^(\d+)-(.+)\.json$/.exec(key.slice(filePrefix.length));
    if (match) flows[`${match[1]}:${match[2]}`] = JSON.parse(String(value));
  }
  return flows;
}

/** Replaces every marker with `flows` (keyed `<flowId>:<event>`), as an earlier runtime would have left them. */
export function setOpenFlows(flows: Record<string, OpenFlowMarker>): void {
  memory.delete(LEGACY_OPEN_FLOWS_KEY);
  for (const key of [...memory.keys()]) if (key.startsWith(filePrefix)) memory.delete(key);
  memory.set(`dir:${OPEN_FLOWS_DIRECTORY}`, true);
  for (const [key, flow] of Object.entries(flows)) {
    const flowId = key.split(":")[0]!;
    memory.set(`${filePrefix}${flowId}-${flow.event}.json`, JSON.stringify(flow));
  }
}
