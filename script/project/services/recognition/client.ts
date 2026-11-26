import { fetch, type AbortSignal } from "scripting";
import { GATEWAY_ORIGIN } from "../build-track";
import { linkedTimeoutSignal, remainingTimeoutMs, waitForRefresh } from "../deadline";
import { readDurableTextCandidates, writeDurableText } from "../durable-files";
import { beginDiagnosticOperation, diagnosticErrorDetails, type DiagnosticDetails } from "../logger";
import { sha256Hex, utf8Data } from "../scripting-data";
import type { RecognitionConfig } from "./settings";
import { parseRecognitionResult, providerRecognitionText, recognitionRequest } from "./wire";

const PROMPT_URL = `${GATEWAY_ORIGIN}/api/recognition/prompt`;
const PROMPT_FILE = "recognition-prompt-meal-metadata-v1.json";
const PROMPT_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const REQUEST_LIMIT = 20_000_000;
export const ONLINE_BUDGET_MS = 25_000;
export const CONNECTION_TEST_BUDGET_MS = 30_000;

/** Who asked for the attempt, recorded as the diagnostic trigger. */
export type OnlineRecognitionTrigger = "connection_test" | "shortcut";

/** Timing and status of the latest HTTP exchange; never its URL, headers, key or body. */
type ExchangeFacts = Pick<DiagnosticDetails, "httpStatus" | "requestPhase" | "requestBudgetMs" |
  "requestElapsedMs" | "responseHeadersAfterMs" | "responseBodyAfterMs" | "timeoutOrigin">;

/** The code and status only feed the diagnostic record; callers still see an ordinary failure. */
class OnlineRecognitionError extends Error {
  constructor(message: string, readonly code: "invalid_input" | "invalid_response" | "body_too_large" | "upstream_rejected",
    readonly status?: number) {
    super(message);
    this.name = "OnlineRecognitionError";
  }
}

/**
 * A safe category of a failed attempt for the connection test's Toast (IOS-SR-04, owner 2026-11-21). It is derived
 * from the stage, the HTTP status and the exchange phase that the diagnostic record also names, never from the
 * provider's message. An attempt without a fitting category, such as an HTTP 400 or 5xx, has none.
 */
export type OnlineRecognitionFailure =
  | "authorization" | "model" | "rate_limited" | "timeout" | "network" | "invalid_response" | "prompt";
const failures = new WeakMap<object, OnlineRecognitionFailure>();

/** The category recorded for an error thrown by requestOnlineRecognition; the error itself is unchanged. */
export function onlineRecognitionFailure(error: unknown): OnlineRecognitionFailure | undefined {
  return error && typeof error === "object" ? failures.get(error) : undefined;
}

function failureCategory(error: unknown, stage: string, facts: ExchangeFacts,
  errorCategory: string | undefined): OnlineRecognitionFailure | undefined {
  if (errorCategory === "timeout" || facts.timeoutOrigin === "timeout_signal" || facts.timeoutOrigin === "native_timeout") {
    return "timeout";
  }
  // The transport failed: no response arrived, or the response stopped while it was read.
  const transport = (stage === "prompt" || stage === "request") && !(error instanceof OnlineRecognitionError) &&
    (facts.requestPhase === "request" && facts.httpStatus == null || facts.requestPhase === "response_body");
  if (transport) return "network";
  if (stage === "prompt") return "prompt";
  if (error instanceof OnlineRecognitionError) {
    if (error.status === 401 || error.status === 403) return "authorization";
    if (error.status === 404) return "model";
    if (error.status === 429) return "rate_limited";
    return (error.code === "invalid_response" || error.code === "body_too_large") &&
      facts.requestPhase === "response_body" ? "invalid_response" : undefined;
  }
  return stage === "provider_parse" || stage === "result_parse" ? "invalid_response" : undefined;
}

/**
 * The provider, protocol and model name of an attempt for its records, like Pipi (owner 2026-11-21: 记上（推荐）).
 * The logger keeps only the closed provider and protocol values and a model name of 1–64 letters, digits, `.`,
 * `_` or `-`; it never receives the URL, key or provider name.
 */
export function onlineRecognitionIdentity(config: RecognitionConfig): DiagnosticDetails {
  // A key pasted into the model field fits the model pattern; it is never recorded (AGENTS.md section 10).
  const model = config.model && config.model !== config.apiKey.trim() ? config.model : undefined;
  return { onlineProvider: config.provider, onlineProtocol: config.protocol, ...(model ? { onlineModel: model } : {}) };
}

async function responseText(url: string, method: "GET" | "POST", headers: Record<string, string>,
  body: string | undefined, limit: number, deadline: number, owner?: AbortSignal, facts: ExchangeFacts = {}) {
  for (const key of Object.keys(facts) as (keyof ExchangeFacts)[]) delete facts[key];
  const startedAt = Date.now();
  facts.requestPhase = "request";
  const timeoutMs = remainingTimeoutMs(deadline, CONNECTION_TEST_BUDGET_MS);
  facts.requestBudgetMs = timeoutMs;
  const request = linkedTimeoutSignal(timeoutMs, owner);
  try {
    return await waitForRefresh((async () => {
      if (request.signal.aborted) throw new Error("Recognition request expired");
      const response = await fetch(url, {
        method, headers: { ...headers, "Accept-Encoding": "identity" }, body,
        timeout: timeoutMs / 1000, signal: request.signal, handleRedirect: async () => null,
      });
      facts.httpStatus = response.status;
      facts.responseHeadersAfterMs = Date.now() - startedAt;
      facts.requestPhase = "response_body";
      if (response.url !== url) throw new OnlineRecognitionError("Invalid recognition response", "invalid_response");
      if ((response.expectedContentLength ?? 0) > limit) {
        throw new OnlineRecognitionError("Invalid recognition response", "body_too_large");
      }
      const data = Data.fromIntArray([]);
      const read = response.dataStream.getReader();
      try {
        while (!request.signal.aborted) {
          const { done, value } = await read.read();
          if (done) {
            const text = data.toRawString("utf-8") ?? "";
            facts.responseBodyAfterMs = Date.now() - startedAt;
            facts.requestPhase = "response_complete";
            return { status: response.status, text };
          }
          if (!value) throw new OnlineRecognitionError("Recognition response exceeds limit", "invalid_response");
          if (data.size + value.size > limit) {
            throw new OnlineRecognitionError("Recognition response exceeds limit", "body_too_large");
          }
          data.append(value);
        }
        throw new Error("Recognition request expired");
      } finally {
        void read.cancel().catch(() => undefined);
      }
    })(), deadline, request.signal);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    facts.timeoutOrigin = owner?.aborted ? "parent_signal" : request.signal.aborted ? "timeout_signal"
      : name === "TimeoutError" ? "native_timeout" : name === "AbortError" ? "native_abort" : undefined;
    throw error;
  } finally {
    facts.requestElapsedMs = Date.now() - startedAt;
    request.cancel();
    request.dispose();
  }
}

let cachedPrompt = "";
let refreshing: Promise<string> | undefined;
function promptText(payload: string): string {
  const value = JSON.parse(payload);
  return value?.schemaVersion === 1 && typeof value.prompt === "string" && value.prompt.trim() &&
    value.prompt.length <= PROMPT_LIMIT && value.version === sha256Hex(value.prompt) ? value.prompt : "";
}

function fetchPrompt(deadline: number, facts?: ExchangeFacts): Promise<string> {
  if (refreshing) return refreshing;
  const promise = (async () => {
    const { status, text } = await responseText(PROMPT_URL, "GET",
      { "X-Pipi-Meal-Order-Metadata": "1", Accept: "application/json" }, undefined, PROMPT_LIMIT, deadline,
      undefined, facts);
    const prompt = status === 200 ? promptText(text) : "";
    if (!prompt) {
      throw new OnlineRecognitionError("Recognition prompt is unavailable",
        status === 200 ? "invalid_response" : "upstream_rejected", status);
    }
    cachedPrompt = prompt;
    try { writeDurableText(PROMPT_FILE, text); } catch { /* The validated prompt is usable for this session. */ }
    return prompt;
  })().finally(() => { if (refreshing === promise) refreshing = undefined; });
  refreshing = promise;
  return promise;
}

async function recognitionPrompt(deadline: number, signal?: AbortSignal, facts?: ExchangeFacts): Promise<string> {
  if (cachedPrompt) return cachedPrompt;
  for (const stored of readDurableTextCandidates(PROMPT_FILE)) {
    try {
      if (stored.length > PROMPT_LIMIT) continue;
      const prompt = promptText(stored);
      if (prompt) {
        cachedPrompt = prompt;
        void fetchPrompt(Date.now() + CONNECTION_TEST_BUDGET_MS).catch(() => undefined);
        return prompt;
      }
    } catch { /* Continue with another last-good copy or the same gateway. */ }
  }
  return waitForRefresh(fetchPrompt(deadline, facts), deadline, signal);
}

/**
 * Records one start and one end per attempt (AGENTS.md section 10). Both carry the provider, protocol and
 * model name (see onlineRecognitionIdentity). The end names the stage that stopped the attempt, the latest
 * exchange's HTTP status and timing, and `attempt: 2` when the Gemini thinking retry ran; it never carries the
 * URL, key, prompt, image or reply. A failure also keeps its Toast category for onlineRecognitionFailure.
 */
export async function requestOnlineRecognition(config: RecognitionConfig, image: UIImage, deadline: number,
  signal?: AbortSignal, trigger?: OnlineRecognitionTrigger,
  /** Who aborted `signal`, read when the attempt ends cancelled (D119); diagnostics only. */
  cancelReason?: () => DiagnosticDetails["cancelReason"]) {
  const finish = beginDiagnosticOperation("recognition.online", {
    ...(trigger ? { trigger } : {}), ...onlineRecognitionIdentity(config), budgetMs: Math.max(0, deadline - Date.now()),
  });
  const facts: ExchangeFacts = {};
  let stage = "prompt";
  let attempt: 1 | 2 | undefined;
  try {
    const prompt = await recognitionPrompt(deadline, signal, facts);
    if (signal?.aborted) throw new Error("Recognition cancelled");
    stage = "image";
    const data = image.toJPEGData(0.9);
    if (!data) throw new OnlineRecognitionError("Recognition image exceeds limit", "invalid_input");
    if (data.size * 4 / 3 >= REQUEST_LIMIT) throw new OnlineRecognitionError("Recognition image exceeds limit", "body_too_large");
    const encoded = data.toBase64String();
    async function exchange(thinkingLow: boolean, number: 1 | 2) {
      stage = "request";
      attempt = number;
      const request = recognitionRequest(config, prompt, encoded, thinkingLow);
      if (utf8Data(request.body).size > REQUEST_LIMIT) {
        throw new OnlineRecognitionError("Recognition request exceeds limit", "body_too_large");
      }
      return responseText(request.url, "POST", request.headers, request.body, RESPONSE_LIMIT, deadline, signal, facts);
    }
    let response = await exchange(true, 1);
    if (config.protocol === "gemini" && response.status === 400 && /thinking/iu.test(response.text)) {
      response = await exchange(false, 2);
    }
    stage = "response";
    if (response.status < 200 || response.status >= 300) {
      throw new OnlineRecognitionError("Recognition provider rejected the request", "upstream_rejected", response.status);
    }
    stage = "provider_parse";
    const text = providerRecognitionText(config.protocol, response.text);
    stage = "result_parse";
    const result = parseRecognitionResult(text);
    finish(result ? "succeeded" : "empty", { ...facts, attempt });
    return result;
  } catch (error) {
    try {
      const cancelled = signal?.aborted === true;
      const details = diagnosticErrorDetails(error);
      const category = cancelled ? undefined : failureCategory(error, stage, facts, details.errorCategory);
      if (category && error && typeof error === "object") failures.set(error, category);
      finish(cancelled ? "cancelled" : "failed", {
        ...facts, stage, attempt, ...details,
        ...(cancelled ? { cancelReason: cancelReason?.() } : {}),
      }, cancelled ? "info" : "warning");
    } catch { /* Diagnostics and the Toast category never replace the recognition failure. */ }
    throw error;
  }
}
