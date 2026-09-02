import { fetch } from "scripting";
import {
  linkedTimeoutSignal,
  OperationTimeoutError,
  remainingTimeoutMs,
} from "./deadline";

const KUAIDI100_AUTO_URL =
  "https://www.kuaidi100.com/autonumber/autoComNum";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

type JsonObject = Record<string, unknown>;

export type Kuaidi100CarrierCandidate = Readonly<{
  courierCode: string;
  companyName: string;
}>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(value: JsonObject, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = text(value[key]);
    if (candidate) return candidate;
  }
  return "";
}

export function parseKuaidi100CarrierCandidates(
  value: unknown,
): Kuaidi100CarrierCandidate[] {
  const root = object(value);
  const source = Array.isArray(value)
    ? value
    : Array.isArray(root.auto)
    ? root.auto
    : [];
  const result: Kuaidi100CarrierCandidate[] = [];
  for (const value of source) {
    const item = object(value);
    const courierCode = firstText(item, "comCode", "code");
    if (
      !/^[A-Za-z0-9_-]{1,32}$/.test(courierCode) ||
      result.some((entry) => entry.courierCode === courierCode)
    ) {
      continue;
    }
    result.push({
      courierCode,
      companyName: firstText(item, "name", "comName", "companyName"),
    });
  }
  return result;
}

export async function detectKuaidi100CarrierCandidates(
  waybillInput: string,
  options: { deadlineAtMs?: number; signal?: AbortSignal } = {},
): Promise<Kuaidi100CarrierCandidate[]> {
  const waybill = String(waybillInput || "").trim();
  if (!waybill) return [];
  const timeoutMs = remainingTimeoutMs(
    options.deadlineAtMs,
    REQUEST_TIMEOUT_MS,
  );
  const url = `${KUAIDI100_AUTO_URL}?text=${encodeURIComponent(waybill)}`;
  let response;
  let responseText = "";
  const lifecycleDeadlineAtMs = Date.now() + timeoutMs;
  const lifecycle = linkedTimeoutSignal(timeoutMs, options.signal);
  let rejectLifecycle: ((reason: Error) => void) | undefined;
  const abortLifecycle = () => rejectLifecycle?.(new OperationTimeoutError());
  try {
    if (lifecycle.signal.aborted) throw new OperationTimeoutError();
    const expired = new Promise<void>((_, reject) => {
      rejectLifecycle = reject;
    });
    lifecycle.signal.addEventListener("abort", abortLifecycle, { once: true });
    const request = (async () => {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body: "",
        timeout: timeoutMs / 1000,
        signal: lifecycle.signal,
        debugLabel: "Pipi Deliveries Kuaidi100 carrier detection",
      });
      if (
        typeof response.expectedContentLength === "number" &&
        response.expectedContentLength > MAX_RESPONSE_BYTES
      ) {
        throw new Error("response too large");
      }
      const text = await response.text();
      if (Date.now() >= lifecycleDeadlineAtMs) {
        throw new OperationTimeoutError();
      }
      responseText = text;
    })();
    await Promise.race([request, expired]);
  } catch (error) {
    if (error instanceof OperationTimeoutError) throw error;
    if (
      lifecycle.signal.aborted ||
      (error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      throw new OperationTimeoutError();
    }
    if (
      options.deadlineAtMs != null &&
      Date.now() >= options.deadlineAtMs
    ) {
      throw new OperationTimeoutError();
    }
    throw new Error("暂时无法识别承运商");
  } finally {
    rejectLifecycle = undefined;
    lifecycle.signal.removeEventListener("abort", abortLifecycle);
    lifecycle.dispose();
  }
  if (!response.ok || responseText.length > MAX_RESPONSE_BYTES) {
    throw new Error("暂时无法识别承运商");
  }
  try {
    return parseKuaidi100CarrierCandidates(JSON.parse(responseText));
  } catch {
    throw new Error("暂时无法识别承运商");
  }
}
