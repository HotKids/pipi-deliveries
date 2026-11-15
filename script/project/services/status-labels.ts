import type { StatusSemantic } from "../models";
import { GENERATED_STATUS_LABEL_TABLE } from "./status-label-table.generated";
import {
  cloneJsonRecord,
  cloneJsonValue,
  isPlainObject as isObject,
} from "./value-guards";

/**
 * The status label table (audit L5, user default #2, 2026-09-25): one table for every surface — the
 * list, detail, widgets and notification titles — served by the Worker as `statusLabels` next to the
 * carrier authority snapshot (POST /api/express/carriers). The bundled generated table is the bootstrap
 * until the first verified snapshot arrives; it must equal the Worker's table (shared fixture
 * tests/fixtures/express/status-labels.v1.json). DANGER reads 异常件 and UNKNOWN reads 暂无状态 everywhere.
 *
 * Unprojected order rows (an order without a real waybill yet) show PICKED and SHIPPED as ORDERED
 * (audit L1): the carrier has not taken the parcel.
 */
export type StatusLabelSubtype = Readonly<{
  semantic: StatusSemantic;
  code: string;
  label: string;
  priority: number;
}>;

export type StatusLabelTable = Readonly<{
  schemaVersion: 1;
  labels: Readonly<Record<StatusSemantic, string>>;
  orderLabels: Readonly<Partial<Record<StatusSemantic, string>>>;
  subtypes: readonly StatusLabelSubtype[];
  unprojectedOrder: Readonly<{
    scope: "ORDER";
    displaySemantic: Readonly<Partial<Record<StatusSemantic, StatusSemantic>>>;
  }>;
  statusRules?: Readonly<Record<string, unknown>>;
  proseRules?: Readonly<Record<string, unknown>>;
}>;

const STATUS_SEMANTIC_VALUES: readonly StatusSemantic[] = [
  "UNKNOWN", "ORDERED", "SHIPPED", "PICKED", "TRANSIT", "DELIVERY", "WAITING_PICKUP", "COMPLETED",
  "DANGER", "CANCELLED",
];

export const BOOTSTRAP_STATUS_LABEL_TABLE =
  GENERATED_STATUS_LABEL_TABLE as unknown as StatusLabelTable;

let activeTable: StatusLabelTable = BOOTSTRAP_STATUS_LABEL_TABLE;

function isSemantic(value: unknown): value is StatusSemantic {
  return typeof value === "string" && STATUS_SEMANTIC_VALUES.includes(value as StatusSemantic);
}

function label(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= 32 && !/[\u0000-\u001f\u007f]/.test(clean) ? clean : null;
}

/** Validates the Worker's `statusLabels` shape; any defect rejects the whole table. */
export function parseStatusLabelTable(value: unknown): StatusLabelTable | null {
  if (!isObject(value) || value.schemaVersion !== 1 || !isObject(value.labels) ||
      !isObject(value.orderLabels) || !Array.isArray(value.subtypes) || value.subtypes.length > 32 ||
      !isObject(value.unprojectedOrder)) return null;
  const labels = {} as Record<StatusSemantic, string>;
  for (const semantic of STATUS_SEMANTIC_VALUES) {
    const text = label(value.labels[semantic]);
    if (!text) return null;
    labels[semantic] = text;
  }
  const orderLabels: Partial<Record<StatusSemantic, string>> = {};
  for (const [semantic, raw] of Object.entries(value.orderLabels)) {
    const text = label(raw);
    if (!isSemantic(semantic) || !text) return null;
    orderLabels[semantic] = text;
  }
  const subtypes: StatusLabelSubtype[] = [];
  for (const raw of value.subtypes) {
    if (!isObject(raw) || !isSemantic(raw.semantic) || typeof raw.code !== "string" ||
        !raw.code.trim() || raw.code.length > 64 || !Number.isSafeInteger(raw.priority) ||
        Number(raw.priority) < 0) return null;
    const text = label(raw.label);
    if (!text) return null;
    subtypes.push(Object.freeze({ semantic: raw.semantic, code: raw.code.trim(), label: text,
      priority: Number(raw.priority) }));
  }
  const order = value.unprojectedOrder;
  if (order.scope !== "ORDER" || !isObject(order.displaySemantic)) return null;
  const displaySemantic: Partial<Record<StatusSemantic, StatusSemantic>> = {};
  for (const [from, to] of Object.entries(order.displaySemantic)) {
    if (!isSemantic(from) || !isSemantic(to)) return null;
    displaySemantic[from] = to;
  }
  if (value.statusRules !== undefined && !isObject(value.statusRules)) return null;
  if (value.proseRules !== undefined && !isObject(value.proseRules)) return null;
  const statusRules = mergeRuleGroups(value.statusRules, BOOTSTRAP_STATUS_LABEL_TABLE.statusRules);
  const proseRules = mergeRuleGroups(value.proseRules, BOOTSTRAP_STATUS_LABEL_TABLE.proseRules);
  return Object.freeze({
    schemaVersion: 1,
    labels: Object.freeze(labels),
    orderLabels: Object.freeze(orderLabels),
    subtypes: Object.freeze(subtypes),
    unprojectedOrder: Object.freeze({ scope: "ORDER", displaySemantic: Object.freeze(displaySemantic) }),
    ...(statusRules ? { statusRules } : {}),
    ...(proseRules ? { proseRules } : {}),
  }) as StatusLabelTable;
}

/** Remote groups overlay the bootstrap wholesale; missing groups keep the bundled snapshot. */
function mergeRuleGroups(
  remote: unknown,
  bundled: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  const merged = cloneJsonRecord(bundled) ?? {};
  if (remote === undefined) {
    return Object.keys(merged).length ? merged : undefined;
  }
  if (!isObject(remote)) return undefined;
  for (const [key, value] of Object.entries(remote)) {
    merged[key] = cloneJsonValue(value);
  }
  return merged;
}

/** Samsung JD descriptor override. Missing policy returns null. */
export function samsungDescriptorOverride(raw: string, description: string): StatusSemantic | null {
  const policy = activeTable.statusRules?.v3JD;
  if (!isObject(policy)) return null;
  const overrides = policy.descriptorOverrides;
  if (!isObject(overrides)) return null;
  const rawKey = String(raw ?? "").trim();
  const described = String(description ?? "").trim();
  if (!rawKey || !described) return null;
  const listed = overrides[rawKey];
  if (!Array.isArray(listed) || !listed.some((item) => typeof item === "string" && item.trim() === described)) {
    return null;
  }
  const aliases = policy.statusAliases;
  if (!isObject(aliases) || typeof aliases[described] !== "string") return null;
  const semantic = aliases[described];
  return isSemantic(semantic) && semantic !== "UNKNOWN" ? semantic : null;
}

/** proseRules[group][field] string list. Missing group or field returns empty. */
export function proseWords(group: string, field: string): readonly string[] {
  const rules = activeTable.proseRules?.[group];
  if (!isObject(rules) || !field) return [];
  const listed = rules[field];
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []);
}

/** True when compactText contains any word from proseRules[group][field]. */
export function proseContains(group: string, field: string, compactText: string): boolean {
  const text = String(compactText ?? "");
  if (!text) return false;
  return proseWords(group, field).some((word) => text.includes(word));
}

/** Whole-token lookup in `statusRules[group]` (semantic → string[]). Missing rules return null. */
export function statusRuleSemantic(group: string, code: string): StatusSemantic | null {
  const token = String(code ?? "").trim().toUpperCase();
  if (!token) return null;
  const rules = activeTable.statusRules?.[group];
  if (!isObject(rules)) return null;
  for (const semantic of STATUS_SEMANTIC_VALUES) {
    const tokens = rules[semantic];
    if (!Array.isArray(tokens)) continue;
    for (const raw of tokens) {
      if (typeof raw === "string" && raw.trim().toUpperCase() === token) return semantic;
    }
  }
  return null;
}

/** Exact structured description, not prose. Empty text returns null. */
export function exactStructuredSemantic(text: string): StatusSemantic | null {
  return statusRuleSemantic("structuredDescriptions", text);
}

/** Exact JT DOM label. Empty text returns null. */
export function jtLabelSemantic(text: string): StatusSemantic | null {
  return statusRuleSemantic("jtLabels", text);
}

/** Installs a verified table from the Worker snapshot; the previous table stays on any defect. */
export function installStatusLabelTable(table: StatusLabelTable | null | undefined): boolean {
  if (!table) return false;
  activeTable = table;
  return true;
}

export function activeStatusLabelTable(): StatusLabelTable {
  return activeTable;
}

export function resetStatusLabelTableForTesting(): void {
  activeTable = BOOTSTRAP_STATUS_LABEL_TABLE;
}

export type StatusDisplayInput = Readonly<{
  /** ORDER for an order row that has no real waybill yet; SHIPMENT for everything else. */
  scope: "ORDER" | "SHIPMENT";
  semantic: StatusSemantic;
  /** The Worker's upstream status code (normalizedStatus.code), which selects a subtype label. */
  code?: string;
}>;

/** The one display function: the shown semantic and its label. */
export function statusDisplay(
  input: StatusDisplayInput,
  table: StatusLabelTable = activeTable,
): Readonly<{ semantic: StatusSemantic; label: string }> {
  const semantic = input.scope === table.unprojectedOrder.scope
    ? table.unprojectedOrder.displaySemantic[input.semantic] || input.semantic
    : input.semantic;
  if (semantic === "CANCELLED") return { semantic, label: table.labels.CANCELLED };
  const code = String(input.code || "");
  const subtype = code
    ? table.subtypes.find((value) => value.semantic === semantic && value.code === code)
    : undefined;
  const text = subtype?.label ||
    (input.scope === "ORDER" ? table.orderLabels[semantic] : undefined) ||
    table.labels[semantic] || table.labels.UNKNOWN;
  return { semantic, label: text };
}
