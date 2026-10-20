import type { StatusSemantic } from "../models";

/**
 * The status label table (audit L5, user default #2, 2026-09-25): one table for every surface — the
 * list, detail, widgets and notification titles — served by the Worker as `statusLabels` next to the
 * carrier authority snapshot (POST /api/express/carriers). The bundled copy below is the bootstrap until
 * the first verified snapshot arrives; it must equal the Worker's table (shared fixture
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
}>;

export const STATUS_SEMANTIC_VALUES: readonly StatusSemantic[] = [
  "UNKNOWN", "ORDERED", "SHIPPED", "PICKED", "TRANSIT", "DELIVERY", "WAITING_PICKUP", "COMPLETED",
  "DANGER", "CANCELLED",
];

export const BOOTSTRAP_STATUS_LABEL_TABLE: StatusLabelTable = Object.freeze({
  schemaVersion: 1,
  labels: Object.freeze({
    UNKNOWN: "暂无状态",
    ORDERED: "已下单",
    SHIPPED: "已发货",
    PICKED: "已揽件",
    TRANSIT: "运输中",
    DELIVERY: "派送中",
    WAITING_PICKUP: "待取件",
    COMPLETED: "已签收",
    DANGER: "异常件",
    CANCELLED: "已取消",
  }),
  orderLabels: Object.freeze({
    COMPLETED: "已完成",
    CANCELLED: "订单已取消",
  }),
  subtypes: Object.freeze([
    // 用户 2026-10-02「驿站派送中 统一映射成 待派送」: the subtype's word; its semantic stays DELIVERY.
    Object.freeze({ semantic: "DELIVERY", code: "STA_DELIVERING", label: "待派送", priority: 1 }),
  ]),
  unprojectedOrder: Object.freeze({
    scope: "ORDER",
    displaySemantic: Object.freeze({ PICKED: "ORDERED", SHIPPED: "ORDERED" }),
  }),
}) as StatusLabelTable;

let activeTable: StatusLabelTable = BOOTSTRAP_STATUS_LABEL_TABLE;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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
  return Object.freeze({
    schemaVersion: 1,
    labels: Object.freeze(labels),
    orderLabels: Object.freeze(orderLabels),
    subtypes: Object.freeze(subtypes),
    unprojectedOrder: Object.freeze({ scope: "ORDER", displaySemantic: Object.freeze(displaySemantic) }),
  }) as StatusLabelTable;
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
  const code = String(input.code || "");
  const subtype = code
    ? table.subtypes.find((value) => value.semantic === semantic && value.code === code)
    : undefined;
  const text = subtype?.label ||
    (input.scope === "ORDER" && semantic !== "CANCELLED" ? table.orderLabels[semantic] : undefined) ||
    table.labels[semantic] || table.labels.UNKNOWN;
  return { semantic, label: text };
}
