import { fetch, type AbortSignal } from "scripting";
import { GATEWAY_ORIGIN } from "../build-track";
import { linkedTimeoutSignal, remainingTimeoutMs, waitForRefresh } from "../deadline";
import { readDurableTextCandidates, writeDurableText } from "../durable-files";
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

async function responseText(url: string, method: "GET" | "POST", headers: Record<string, string>,
  body: string | undefined, limit: number, deadline: number, owner?: AbortSignal) {
  const timeoutMs = remainingTimeoutMs(deadline, CONNECTION_TEST_BUDGET_MS);
  const request = linkedTimeoutSignal(timeoutMs, owner);
  try {
    return await waitForRefresh((async () => {
      if (request.signal.aborted) throw new Error("Recognition request expired");
      const response = await fetch(url, {
        method, headers: { ...headers, "Accept-Encoding": "identity" }, body,
        timeout: timeoutMs / 1000, signal: request.signal, handleRedirect: async () => null,
      });
      if (response.url !== url || (response.expectedContentLength ?? 0) > limit) throw new Error("Invalid recognition response");
      const data = Data.fromIntArray([]);
      const read = response.dataStream.getReader();
      try {
        while (!request.signal.aborted) {
          const { done, value } = await read.read();
          if (done) return { status: response.status, text: data.toRawString("utf-8") ?? "" };
          if (!value || data.size + value.size > limit) throw new Error("Recognition response exceeds limit");
          data.append(value);
        }
        throw new Error("Recognition request expired");
      } finally {
        void read.cancel().catch(() => undefined);
      }
    })(), deadline, request.signal);
  } finally {
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

function fetchPrompt(deadline: number): Promise<string> {
  if (refreshing) return refreshing;
  const promise = (async () => {
    const { status, text } = await responseText(PROMPT_URL, "GET",
      { "X-Pipi-Meal-Order-Metadata": "1", Accept: "application/json" }, undefined, PROMPT_LIMIT, deadline);
    const prompt = status === 200 ? promptText(text) : "";
    if (!prompt) throw new Error("Recognition prompt is unavailable");
    cachedPrompt = prompt;
    try { writeDurableText(PROMPT_FILE, text); } catch { /* The validated prompt is usable for this session. */ }
    return prompt;
  })().finally(() => { if (refreshing === promise) refreshing = undefined; });
  refreshing = promise;
  return promise;
}

async function recognitionPrompt(deadline: number, signal?: AbortSignal): Promise<string> {
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
  return waitForRefresh(fetchPrompt(deadline), deadline, signal);
}

export async function requestOnlineRecognition(config: RecognitionConfig, image: UIImage, deadline: number,
  signal?: AbortSignal) {
  const prompt = await recognitionPrompt(deadline, signal);
  if (signal?.aborted) throw new Error("Recognition cancelled");
  const data = image.toJPEGData(0.9);
  if (!data || data.size * 4 / 3 >= REQUEST_LIMIT) throw new Error("Recognition image exceeds limit");
  const encoded = data.toBase64String();
  async function exchange(thinkingLow: boolean) {
    const request = recognitionRequest(config, prompt, encoded, thinkingLow);
    if (utf8Data(request.body).size > REQUEST_LIMIT) throw new Error("Recognition request exceeds limit");
    return responseText(request.url, "POST", request.headers, request.body, RESPONSE_LIMIT, deadline, signal);
  }
  let response = await exchange(true);
  if (config.protocol === "gemini" && response.status === 400 && /thinking/iu.test(response.text)) {
    response = await exchange(false);
  }
  if (response.status < 200 || response.status >= 300) throw new Error("Recognition provider rejected the request");
  return parseRecognitionResult(providerRecognitionText(config.protocol, response.text));
}
