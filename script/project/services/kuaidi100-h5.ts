import { fetch } from "scripting";
import type { TimelinePackage } from "../models";
import {
  assertWithinDeadline,
  linkedTimeoutSignal,
  OperationTimeoutError,
  remainingTimeoutMs,
} from "./deadline";
import {
  kuaidi100NoTrackYet,
  kuaidi100PhoneRejected,
  parseKuaidi100Timeline,
  rejectKuaidi100Response,
  type JsonObject,
} from "./manual-query-parser";
import {
  detectKuaidi100CarrierCandidates,
  type Kuaidi100CarrierCandidate,
} from "./kuaidi100-carrier-detection";
import {
  resolveCarrierKuaidi100Code,
  resolveCarrierName,
  resolveCarrierQuery,
} from "./carrier-query";
import {
  normalizeWaybill,
  timedTracks,
} from "./status";

export const KUAIDI100_H5_QUERY_URL = "https://m.kuaidi100.com/query";
export const KUAIDI100_H5_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class Kuaidi100H5Error extends Error {
  constructor(
    message: string,
    readonly code:
      | "phone_tail"
      | "network"
      | "rejected"
      | "carrier_unknown"
      | "carrier_mismatch"
      | "invalid_response",
  ) {
    super(message);
    this.name = "Kuaidi100H5Error";
  }
}

type Kuaidi100Response = Readonly<{
  ok: boolean;
  status: number;
  expectedContentLength?: number;
  text: () => Promise<string>;
}>;

type Kuaidi100Request = (
  url: string,
  options: Record<string, unknown>,
) => Promise<Kuaidi100Response>;

export type Kuaidi100H5Dependencies = Readonly<{
  now?: () => number;
  request?: Kuaidi100Request;
  detect?: (
    waybill: string,
    options?: Readonly<{ deadlineAtMs?: number; signal?: AbortSignal }>,
  ) => Promise<readonly Kuaidi100CarrierCandidate[]>;
}>;

export type Kuaidi100H5Diagnostics = Readonly<{
  carrierCode: string;
  extractionSource: "data_array" | "data_missing";
  rawTrackCount: number;
  validTrackCount: number;
  effectiveTrackCount: number;
  exitReason:
    | "timed_tracks"
    | "no_track_yet"
    | "missing_data"
    | "empty_data"
    | "invalid_track_nodes"
    | "no_usable_timed_tracks";
}>;

export function kuaidi100ToastMessage(
  error: unknown,
  diagnostics: Kuaidi100H5Diagnostics | null,
): string {
  const trackCount = diagnostics?.effectiveTrackCount || 0;
  if (trackCount > 0) {
    return "轨迹加载成功";
  }
  if (error instanceof OperationTimeoutError) {
    return "查询超时，请稍后下拉刷新";
  }
  if (error instanceof Kuaidi100H5Error) {
    if (error.code === "phone_tail") return error.message;
    if (error.code === "network") return "网络连接异常，请稍后重试";
    if (error.message.includes("过于频繁")) {
      return "请求过于频繁，请稍后重试";
    }
    if (error.code === "carrier_unknown") return "暂时无法识别承运商";
    return "暂未获取到可用轨迹";
  }
  if (diagnostics) return "暂未获取到可用轨迹";
  return "暂未获取到可用轨迹";
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function requestBody(
  waybill: string,
  phoneTail: string,
  kuaidi100Code: string,
  now: number,
): string {
  return [
    ["postid", waybill],
    ["id", "1"],
    ["valicode", ""],
    ["temp", String(now)],
    ["type", kuaidi100Code],
    ["phone", phoneTail],
  ].map(([key, value]) =>
    `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
  ).join("&");
}

async function requestJson(input: Readonly<{
  waybill: string;
  phoneTail: string;
  kuaidi100Code: string;
  now: number;
  deadlineAtMs?: number;
  signal?: AbortSignal;
  request: Kuaidi100Request;
}>): Promise<JsonObject> {
  const timeoutMs = remainingTimeoutMs(
    input.deadlineAtMs,
    KUAIDI100_H5_TIMEOUT_MS,
  );
  const lifecycle = linkedTimeoutSignal(timeoutMs, input.signal);
  let rejectLifecycle: ((reason: Error) => void) | undefined;
  const abortLifecycle = () => rejectLifecycle?.(new OperationTimeoutError());
  try {
    if (lifecycle.signal.aborted) throw new OperationTimeoutError();
    const expired = new Promise<void>((_, reject) => {
      rejectLifecycle = reject;
    });
    lifecycle.signal.addEventListener("abort", abortLifecycle, { once: true });
    let response: Kuaidi100Response | undefined;
    let responseText = "";
    const request = (async () => {
      response = await input.request(KUAIDI100_H5_QUERY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: requestBody(
          input.waybill,
          input.phoneTail,
          input.kuaidi100Code,
          input.now,
        ),
        timeout: timeoutMs / 1000,
        signal: lifecycle.signal,
        debugLabel: "Pipi Deliveries K100 timeline",
      });
      if (
        typeof response.expectedContentLength === "number" &&
        response.expectedContentLength > MAX_RESPONSE_BYTES
      ) {
        throw new Kuaidi100H5Error("K100 响应异常", "invalid_response");
      }
      responseText = await response.text();
      if (responseText.length > MAX_RESPONSE_BYTES) {
        throw new Kuaidi100H5Error("K100 响应异常", "invalid_response");
      }
    })();
    await Promise.race([request, expired]);
    if (!response?.ok) {
      throw new Kuaidi100H5Error(
        response?.status === 429 ? "K100 查询过于频繁" : "K100 查询失败",
        "rejected",
      );
    }
    try {
      return jsonObject(JSON.parse(responseText));
    } catch {
      throw new Kuaidi100H5Error("K100 响应异常", "invalid_response");
    }
  } catch (error) {
    if (error instanceof Kuaidi100H5Error || error instanceof OperationTimeoutError) {
      throw error;
    }
    if (
      lifecycle.signal.aborted ||
      (error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      throw new OperationTimeoutError();
    }
    throw new Kuaidi100H5Error("K100 网络连接失败", "network");
  } finally {
    rejectLifecycle = undefined;
    lifecycle.signal.removeEventListener("abort", abortLifecycle);
    lifecycle.dispose();
  }
}

export async function queryKuaidi100JdTimeline(input: Readonly<{
  waybill: string;
  phoneTail: string;
  courierCode?: string;
  companyName?: string;
  deadlineAtMs?: number;
  signal?: AbortSignal;
  observe?: (diagnostics: Kuaidi100H5Diagnostics) => void;
  dependencies?: Kuaidi100H5Dependencies;
}>): Promise<TimelinePackage | null> {
  const waybill = normalizeWaybill(input.waybill);
  if (waybill.length < 6 || waybill.length > 64) {
    throw new Error("请输入有效的快递单号");
  }
  assertWithinDeadline(input.deadlineAtMs);
  if (input.signal?.aborted) throw new OperationTimeoutError();
  const dependencies = input.dependencies || {};
  const now = (dependencies.now || Date.now)();
  let detectedCarrier = resolveCarrierQuery(input.courierCode || "") ||
    resolveCarrierName(input.companyName || "");
  if (!detectedCarrier) {
    const candidates = await (
      dependencies.detect || detectKuaidi100CarrierCandidates
    )(waybill, {
      deadlineAtMs: input.deadlineAtMs,
      signal: input.signal,
    });
    detectedCarrier = candidates
      .map((candidate) => resolveCarrierKuaidi100Code(candidate.courierCode))
      .find((candidate) => Boolean(candidate)) || null;
  }
  if (!detectedCarrier?.kuaidi100Code) {
    throw new Kuaidi100H5Error("暂时无法识别承运商", "carrier_unknown");
  }
  const suppliedPhoneTail = String(input.phoneTail || "").trim();
  if (detectedCarrier.requiresPhoneTail && !/^\d{4}$/.test(suppliedPhoneTail)) {
    throw new Kuaidi100H5Error("请输入 4 位手机尾号", "phone_tail");
  }
  const phoneTail = detectedCarrier.requiresPhoneTail ? suppliedPhoneTail : "";
  assertWithinDeadline(input.deadlineAtMs);
  const request = dependencies.request || (fetch as unknown as Kuaidi100Request);
  const root = await requestJson({
    waybill,
    phoneTail,
    kuaidi100Code: detectedCarrier.kuaidi100Code,
    now,
    deadlineAtMs: input.deadlineAtMs,
    signal: input.signal,
    request,
  });
  const returnedWaybill = normalizeWaybill(String(root.nu || ""));
  if (returnedWaybill && returnedWaybill !== waybill) {
    throw new Kuaidi100H5Error("K100 返回的运单不一致", "invalid_response");
  }
  if (kuaidi100PhoneRejected(root)) {
    throw new Kuaidi100H5Error(
      "手机尾号不正确，请重新输入",
      "phone_tail",
    );
  }
  if (rejectKuaidi100Response(root)) {
    throw new Kuaidi100H5Error("K100 查询失败", "rejected");
  }
  const returnedCarrierCode = String(root.com || "").trim();
  const returnedCarrier = resolveCarrierKuaidi100Code(returnedCarrierCode);
  if (!returnedCarrierCode || !returnedCarrier) {
    throw new Kuaidi100H5Error(
      "K100 未返回可信的承运商信息",
      "invalid_response",
    );
  }
  if (returnedCarrier.standardCode !== detectedCarrier.standardCode) {
    throw new Kuaidi100H5Error(
      "K100 返回的承运商与识别结果不一致",
      "carrier_mismatch",
    );
  }
  const parsed = parseKuaidi100Timeline(root);
  const rawTrackCount = Array.isArray(root.data) ? root.data.length : 0;
  const validTrackCount = parsed.tracks.length;
  const effectiveTrackCount = timedTracks(parsed.tracks).length;
  const exitReason: Kuaidi100H5Diagnostics["exitReason"] =
    effectiveTrackCount > 0
      ? "timed_tracks"
      : kuaidi100NoTrackYet(root)
        ? "no_track_yet"
        : !Array.isArray(root.data)
          ? "missing_data"
          : rawTrackCount === 0
            ? "empty_data"
            : parsed.tracks.length === 0
              ? "invalid_track_nodes"
              : "no_usable_timed_tracks";
  input.observe?.({
    carrierCode: detectedCarrier.standardCode,
    extractionSource: Array.isArray(root.data) ? "data_array" : "data_missing",
    rawTrackCount,
    validTrackCount,
    effectiveTrackCount,
    exitReason,
  });
  if (!parsed.hasTimedTracking) return null;
  return {
    provider: "kuaidi100_h5",
    complete: true,
    structuredStatus: parsed.hasStructuredStatus,
    waybill,
    rawCourierCode: returnedCarrierCode,
    courierCode: detectedCarrier.standardCode,
    companyName: detectedCarrier.displayName,
    semantic: parsed.semantic,
    statusEventAtMs: parsed.statusEventAtMs,
    latestTimeText: parsed.latestTimeText,
    latestDetail: parsed.latestDetail,
    tracks: parsed.tracks.map((track) => ({
      ...track,
      raw: {
        ...track.raw,
        _pipiKuaidi100Com: returnedCarrierCode,
      },
    })),
    successAtMs: (dependencies.now || Date.now)(),
  };
}
