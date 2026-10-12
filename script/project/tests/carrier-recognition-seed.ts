import { activeCarrierTableVersion, resolveCarrierQuery } from "../services/carrier-query";

const CACHE_KEY = "pipi_deliveries_carrier_recognition_v1";

type SeedEntry = Readonly<{
  waybill: string;
  state: "resolved" | "terminal" | "retry";
  normalization?: unknown;
  candidates: readonly Readonly<{ courierCode: string; companyName: string }>[];
  retryStage?: "auto_com_num" | "worker_classify";
  networkFailures: number;
  retryAfterMs: number;
  updatedAtMs: number;
}>;

function write(entries: readonly SeedEntry[]): void {
  const raw = Storage.get<string>(CACHE_KEY, { shared: true });
  const existing = (typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : []) as SeedEntry[];
  const waybills = new Set(entries.map((entry) => entry.waybill));
  Storage.set(CACHE_KEY, JSON.stringify([
    ...entries,
    ...existing.filter((entry) => !waybills.has(entry.waybill)),
  ]), { shared: true });
}

/**
 * 承运商先对上再推送（T23，用户 2026-09-26，其余裁决 28）：订单文案或京粉页给的运单号，要识别链为它对上承运商以后才亮出来。
 * 测试的是亮出来之后的事情时，先把识别器已经给出的内置表结果写进识别缓存（与真机上前一轮识别落下的记录同形）。
 */
export function seedRecognizedCarriers(
  carriers: Readonly<Record<string, string>>,
  updatedAtMs = Date.now(),
): void {
  write(Object.entries(carriers).map(([waybill, code]) => {
    const record = resolveCarrierQuery(code);
    if (!record) throw new Error(`not a built-in carrier: ${code}`);
    return {
      waybill,
      state: "resolved",
      normalization: {
        standardCode: record.standardCode,
        displayName: record.displayName,
        kuaidi100Code: record.kuaidi100Code,
        isBuiltIn: true,
        tableVersion: activeCarrierTableVersion(),
      },
      candidates: [],
      networkFailures: 0,
      retryAfterMs: 0,
      updatedAtMs,
    };
  }));
}

/** A waybill the recognizer could not place yet: a network failure cooling down for fifteen minutes. */
export function seedCoolingRecognition(waybill: string, updatedAtMs = Date.now()): void {
  write([{
    waybill,
    state: "retry",
    candidates: [],
    retryStage: "auto_com_num",
    networkFailures: 1,
    retryAfterMs: updatedAtMs + 15 * 60 * 1_000,
    updatedAtMs,
  }]);
}

/**
 * 其余裁决 32：识别已进入终态、快递100 没给名字。`network` 是连续 3 次失败，`paid` 是付费级明确认不出。
 */
export function seedExhaustedRecognition(
  waybill: string,
  kind: "network" | "paid" = "paid",
  updatedAtMs = Date.now(),
): void {
  write([{
    waybill,
    state: "terminal",
    candidates: [],
    ...(kind === "network" ? { retryStage: "auto_com_num" as const } : {}),
    networkFailures: kind === "network" ? 3 : 0,
    retryAfterMs: 0,
    updatedAtMs,
  }]);
}
