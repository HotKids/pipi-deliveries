import { fetch } from "scripting";
import {
  linkedTimeoutSignal,
  OperationTimeoutError,
  remainingTimeoutMs,
} from "./deadline";

const KUAIDI100_AUTO_URL =
  "https://www.kuaidi100.com/autonumber/autoComNum";
/**
 * 公开识别接口按 UA 判客户端：不带浏览器 UA 会被 301，识别永远失败，行上没有内置承运商就一直
 * 显示「快递」（用户 2026-09-08 报）。Worker 侧 2026-09-03 就加了，三个客户端的直连调用一直没
 * 跟上；三端同字。
 */
const KUAIDI100_PUBLIC_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
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

/**
 * Kuaidi100's "no match" answer: `result:false` with returnCode 201, written as the string "201" or
 * as the number 201. Both read as unrecognized, the paid stage decides (user decision 2026-09-26).
 */
function isNoMatchAnswer(root: JsonObject): boolean {
  const code = root.returnCode;
  return root.result === false &&
    (typeof code === "string" ? code.trim() === "201" : code === 201);
}

/**
 * The free recognizer's answer read the Worker/Pipi way (audit C3, adopted 2026-09-25): a bare array
 * or an `auto` list gives candidates, the documented no-match answer gives none, and anything else —
 * an object without `auto` included — is a retryable failure that throws and never reaches the paid
 * stage (shared cases: tests/fixtures/express/k100-autocomnum-responses.v1.json).
 */
export function parseKuaidi100CarrierCandidates(
  value: unknown,
): Kuaidi100CarrierCandidate[] {
  const root = object(value);
  const source = Array.isArray(value)
    ? value
    : Array.isArray(root.auto)
    ? root.auto
    : Object.keys(root).length && isNoMatchAnswer(root)
    ? []
    : null;
  if (!source) throw new Error("invalid public carrier response");
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
        // The endpoint answers a browser UA with 200 and anything else with a 301. Following that
        // redirect turns the refusal into a 200 carrying non-JSON, which then reads as a parse
        // failure — the other three callers all pin this and iOS was the only one that did not.
        redirect: "error",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          "User-Agent": KUAIDI100_PUBLIC_USER_AGENT,
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
