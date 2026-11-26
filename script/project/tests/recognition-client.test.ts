import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { memory } from "./state-storage-mock";
import { clearDiagnostics, readDiagnostics, setDiagnosticsEnabled, type DiagnosticEntry } from "../services/logger";
import { GEMINI_URL, prepareRecognitionConfig, providerDefaults } from "../services/recognition/settings";

// Drives the real online recognition client (services/recognition/client.ts) against a synthetic
// Scripting runtime: the gateway prompt and its hash check, the Gemini thinking retry, HTTP failures,
// the streamed body decode and the attempt's diagnostic record. Synthetic data only: no real key or provider.
// The record carries the provider, protocol and model name (owner 2026-11-21: 记上（推荐）), and every failure
// keeps a Toast category for the connection test (IOS-SR-04).

class FakeData {
  constructor(public bytes: Buffer) {}
  get size(): number { return this.bytes.length; }
  append(other: FakeData): void { this.bytes = Buffer.concat([this.bytes, other.bytes]); }
  toRawString(encoding: string): string { assert.equal(encoding, "utf-8"); return this.bytes.toString("utf8"); }
  toBase64String(): string { return this.bytes.toString("base64"); }
}
Object.assign(globalThis, {
  Data: {
    fromIntArray: (value: number[]) => new FakeData(Buffer.from(value)),
    fromRawString: (value: string, encoding: string) => {
      assert.equal(encoding, "utf-8");
      return new FakeData(Buffer.from(value, "utf8"));
    },
  },
  Crypto: { sha256: (value: FakeData) => ({ toHexString: () => createHash("sha256").update(value.bytes).digest("hex") }) },
});

type Init = { method: string; headers: Record<string, string>; body?: string; timeout: number; signal: AbortSignal;
  handleRedirect: () => Promise<null> };
type Handler = (url: string, init: Init) => unknown;
const requests: { url: string; init: Init }[] = [];
const queue: Handler[] = [];
let cancelledReads = 0;
Object.assign(globalThis, {
  fetch: async (url: string, init: Init) => {
    requests.push({ url, init });
    const next = queue.shift();
    assert.ok(next, `unexpected request ${requests.length}`);
    return next(url, init);
  },
});

function reply(status: number, body: string | Buffer[], options: { url?: string; expected?: number } = {}): Handler {
  return url => {
    const chunks = typeof body === "string" ? [Buffer.from(body, "utf8")] : body;
    let index = 0;
    return {
      status, url: options.url ?? url, expectedContentLength: options.expected ?? -1,
      dataStream: { getReader: () => ({
        read: async () => index < chunks.length ? { done: false, value: new FakeData(chunks[index++]) } : { done: true },
        cancel: async () => { cancelledReads++; },
      }) },
    };
  };
}

function pending(): Handler {
  return (_url, init) => new Promise((_, reject) => {
    const abort = () => reject(Object.assign(new Error("synthetic abort"), { name: "AbortError" }));
    if (init.signal.aborted) abort();
    else init.signal.addEventListener("abort", abort);
  });
}

const PROMPT_URL = "https://pipiassistant.app/api/recognition/prompt";
const prompt = "Synthetic extraction rules";
const promptPayload = (version = createHash("sha256").update(prompt).digest("hex")) =>
  JSON.stringify({ schemaVersion: 1, prompt, version });
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const image = { toJPEGData: (quality: number) => { assert.equal(quality, 0.9); return new FakeData(jpeg); } } as unknown as UIImage;
const KEY = "synthetic-gemini-key", MODEL = "gemini-4-hydrogen";
const config = prepareRecognitionConfig({ ...providerDefaults("gemini"), mode: "online", model: MODEL }, KEY);
const providerURL = `${GEMINI_URL}/models/${MODEL}:generateContent`;

const pickup = { brand: null, pickupCode: "0123", productName: null, merchantName: "测试门店" };
const extraction = (value: unknown = pickup) => JSON.stringify({ pickup: value, express: null, movie: null, train: null, flight: null });
const gemini = (text: string, finishReason = "STOP") => JSON.stringify({
  candidates: [{ content: { role: "model", parts: [{ text: "Synthetic thought", thought: true },
    { text, thoughtSignature: "c3ludGhldGlj" }] }, finishReason, index: 0 }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }, modelVersion: "synthetic",
});

const { CONNECTION_TEST_BUDGET_MS, onlineRecognitionFailure, requestOnlineRecognition } =
  await import("../services/recognition/client");
setDiagnosticsEnabled(true);

async function attempt(handlers: Handler[], options: { trigger?: "connection_test" | "shortcut"; deadline?: number;
  signal?: AbortSignal; abortAfterRequest?: AbortController } = {}) {
  clearDiagnostics();
  requests.length = 0;
  queue.push(...handlers);
  let value: unknown, error: unknown;
  const run = requestOnlineRecognition(config, image, options.deadline ?? Date.now() + CONNECTION_TEST_BUDGET_MS,
    options.signal, options.trigger ?? "connection_test");
  if (options.abortAfterRequest) {
    while (!requests.some(request => request.init.method === "POST")) await new Promise(resolve => setTimeout(resolve, 1));
    options.abortAfterRequest.abort();
  }
  try { value = await run; } catch (failure) { error = failure; }
  assert.equal(queue.length, 0, "every expected exchange ran");
  queue.length = 0;
  const entries = readDiagnostics().filter(entry => entry.event.startsWith("recognition.online."));
  const completed = entries.filter(entry => entry.event === "recognition.online.completed");
  const started = entries.filter(entry => entry.event === "recognition.online.started");
  assert.equal(completed.length, 1, "one end record per attempt");
  // D4 (owner 2026-11-21 「开始并入终态，卡住另记（推荐）」): the start is merged into the end line, which keeps the
  // attempt's own trigger and budget.
  assert.equal(started.length, 0, "no separate start record");
  assert.match(String(completed[0].details.flowId), /^\d+$/, "D8: a numeric flow id");
  const text = JSON.stringify(entries);
  for (const secret of [KEY, "generativelanguage", "pipiassistant", prompt, jpeg.toString("base64"), "测试门店"]) {
    assert.equal(text.includes(secret), false, `diagnostics never carry ${secret}`);
  }
  for (const entry of [completed[0]]) {
    assert.equal(entry.details.onlineProvider, "gemini");
    assert.equal(entry.details.onlineProtocol, "gemini");
    assert.equal(entry.details.onlineModel, MODEL, "the configured model name is recorded");
  }
  return { value, error, started: completed[0] as DiagnosticEntry, completed: completed[0] as DiagnosticEntry,
    failure: onlineRecognitionFailure(error) };
}

// The gateway prompt: a rejected download and a failed hash check stop at the prompt stage with the gateway status.
{
  const { error, started, completed, failure } = await attempt([reply(503, "")]);
  assert.ok(error instanceof Error);
  assert.equal(failure, "prompt", "a gateway prompt failure is not the provider key's fault");
  assert.equal(requests[0].url, PROMPT_URL);
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.headers["X-Pipi-Meal-Order-Metadata"], "1");
  assert.equal(started.details.trigger, "connection_test");
  assert.ok(Number(started.details.budgetMs) > 0 && Number(started.details.budgetMs) <= CONNECTION_TEST_BUDGET_MS);
  assert.equal(completed.level, "warning");
  assert.equal(completed.details.trigger, "connection_test");
  assert.equal(completed.details.result, "failed");
  assert.equal(completed.details.stage, "prompt");
  assert.equal(completed.details.httpStatus, 503);
  assert.equal(completed.details.failureCode, "upstream_rejected");
}
{
  const { error, completed, failure } = await attempt([reply(200, promptPayload("0".repeat(64)))]);
  assert.ok(error instanceof Error, "a prompt whose version is not its SHA-256 is rejected");
  assert.equal(failure, "prompt");
  assert.equal(completed.details.stage, "prompt");
  assert.equal(completed.details.httpStatus, 200);
  assert.equal(completed.details.failureCode, "invalid_response");
  assert.equal(completed.details.requestPhase, "response_complete");
}

// Gemini rejects thinkingLevel once; the retry without it succeeds. The UTF-8 body arrives split
// inside a multi-byte character and must decode as one body.
{
  const body = Buffer.from(gemini(extraction()), "utf8");
  const split = body.indexOf(Buffer.from("测", "utf8")) + 1;
  const { value, error, completed } = await attempt([
    reply(200, promptPayload()),
    reply(400, JSON.stringify({ error: { code: 400, message: "Thinking level is not supported for this model.", status: "INVALID_ARGUMENT" } })),
    reply(200, [body.subarray(0, split), body.subarray(split, split + 7), body.subarray(split + 7)]),
  ]);
  assert.equal(error, undefined);
  assert.deepEqual(value, { family: "pickup", fields: pickup });
  assert.equal(onlineRecognitionFailure(value), undefined);
  assert.equal(requests.length, 3);
  for (const [index, thinking] of [[1, true], [2, false]] as const) {
    const { url, init } = requests[index];
    assert.equal(url, providerURL);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["x-goog-api-key"], KEY);
    assert.equal(init.headers["Accept-Encoding"], "identity");
    const sent = JSON.parse(init.body!);
    assert.equal(sent.contents[0].parts[0].inlineData.data, jpeg.toString("base64"));
    assert.equal(sent.systemInstruction.parts[0].text.endsWith("\n\n" + prompt), true);
    assert.deepEqual(sent.generationConfig.thinkingConfig, thinking ? { thinkingLevel: "low" } : undefined);
  }
  assert.equal(completed.level, "info");
  assert.equal(completed.details.result, "succeeded");
  assert.equal(completed.details.attempt, 2, "the record shows that the thinking retry ran");
  assert.equal(completed.details.httpStatus, 200);
  assert.equal(completed.details.requestPhase, "response_complete");
  assert.equal(completed.details.stage, undefined);
  assert.equal(memory.get("file:/group/pipi-deliveries/recognition-prompt-meal-metadata-v1.json"), promptPayload(),
    "the validated prompt is kept for the next process");
}

// Provider refusals keep their HTTP status: a model the key cannot use, and a refused retry.
{
  const { error, completed, failure } = await attempt([reply(404, JSON.stringify({ error: { code: 404,
    message: "models/synthetic is not found for API version v1beta", status: "NOT_FOUND" } }))]);
  assert.ok(error instanceof Error);
  assert.equal(failure, "model");
  assert.doesNotMatch(String((error as Error).message), /not found for API/, "the provider's message stays out");
  assert.equal(requests.length, 1, "the prompt stays cached and a refusal without thinking is not retried");
  assert.equal(completed.details.stage, "response");
  assert.equal(completed.details.httpStatus, 404);
  assert.equal(completed.details.attempt, 1);
  assert.equal(completed.details.failureCode, "upstream_rejected");
}
{
  const { error, completed, failure } = await attempt([
    reply(400, "Unknown name \"thinkingLevel\" at 'generation_config.thinking_config'"),
    reply(403, JSON.stringify({ error: { code: 403, message: "Synthetic permission denied", status: "PERMISSION_DENIED" } })),
  ]);
  assert.ok(error instanceof Error);
  assert.equal(failure, "authorization");
  assert.equal(completed.details.stage, "response");
  assert.equal(completed.details.httpStatus, 403);
  assert.equal(completed.details.attempt, 2);
  assert.equal(completed.details.errorCategory, "authorization");
}
{
  const compatible = prepareRecognitionConfig({ ...providerDefaults("compatible"), mode: "online",
    providerName: "Synthetic", baseUrl: "https://synthetic.invalid/v1", model: "vision-fixture" }, "synthetic-key");
  clearDiagnostics();
  requests.length = 0;
  queue.push(reply(400, "thinking is not supported"));
  let refused: unknown;
  await requestOnlineRecognition(compatible, image, Date.now() + CONNECTION_TEST_BUDGET_MS).catch(error => { refused = error; });
  assert.ok(refused instanceof Error);
  assert.equal(onlineRecognitionFailure(refused), undefined, "an HTTP 400 has no safe category");
  assert.equal(requests.length, 1, "only the Gemini protocol retries without thinking");
  assert.equal(requests[0].url, "https://synthetic.invalid/v1/chat/completions");
  const completed = readDiagnostics().find(entry => entry.event === "recognition.online.completed")!;
  assert.equal(completed.details.trigger, undefined, "an attempt without a trigger records none");
  assert.equal(completed.details.httpStatus, 400);
  assert.equal(completed.details.attempt, 1);
  assert.equal(completed.details.onlineProvider, "compatible");
  assert.equal(completed.details.onlineProtocol, "chat_completions");
  assert.equal(completed.details.onlineModel, "vision-fixture");
  assert.ok(!JSON.stringify(completed).includes("Synthetic"), "the provider name stays out");
}
// An invalid key and an exhausted quota or rate limit.
for (const [status, category] of [[401, "authorization"], [429, "rate_limited"]] as const) {
  const { failure, completed } = await attempt([reply(status, JSON.stringify({ error: { code: status, message: "Synthetic" } }))]);
  assert.equal(failure, category, `HTTP ${status}`);
  assert.equal(completed.details.httpStatus, status);
}
// A model name outside the strict pattern is left out of the record; the attempt itself is unchanged.
// A key pasted into the model field fits the pattern and is still never recorded.
for (const model of ["models/gemini-4-hydrogen", "m".repeat(65), KEY]) {
  const named = prepareRecognitionConfig({ ...providerDefaults("gemini"), mode: "online", model }, KEY);
  clearDiagnostics();
  requests.length = 0;
  queue.push(reply(200, gemini(extraction())));
  assert.deepEqual(await requestOnlineRecognition(named, image, Date.now() + CONNECTION_TEST_BUDGET_MS),
    { family: "pickup", fields: pickup });
  const records = readDiagnostics().filter(entry => entry.event.startsWith("recognition.online."));
  // D4: one end line per attempt; the start is merged into it.
  assert.equal(records.length, 1);
  for (const entry of records) {
    assert.equal(entry.details.onlineModel, undefined, `${model.slice(0, 12)} is not recorded`);
    assert.equal(entry.details.onlineProvider, "gemini");
  }
  assert.equal(JSON.stringify(records).includes(KEY), false, "the key never reaches the record");
}

// Transport and response checks name the exchange phase that stopped.
{
  const { error, completed, failure } = await attempt([reply(200, gemini(extraction()), { url: providerURL + "?redirected=1" })]);
  assert.ok(error instanceof Error, "a response from another address is rejected");
  assert.equal(failure, "invalid_response");
  assert.equal(completed.details.stage, "request");
  assert.equal(completed.details.requestPhase, "response_body");
  assert.equal(completed.details.httpStatus, 200);
  assert.equal(completed.details.failureCode, "invalid_response");
}
{
  const { error, completed, failure } = await attempt([reply(200, gemini(extraction()), { expected: 4 * 1024 * 1024 + 1 })]);
  assert.ok(error instanceof Error);
  assert.equal(failure, "invalid_response");
  assert.equal(completed.details.stage, "request");
  assert.equal(completed.details.failureCode, "body_too_large");
}
{
  const { error, completed, failure } = await attempt([() => { throw new Error("似乎已断开与互联网的连接。"); }], { trigger: "shortcut" });
  assert.ok(error instanceof Error);
  assert.equal(failure, "network");
  assert.equal(completed.details.trigger, "shortcut");
  assert.equal(completed.details.stage, "request");
  assert.equal(completed.details.requestPhase, "request");
  assert.equal(completed.details.httpStatus, undefined);
  assert.equal(completed.details.errorCategory, "network");
}

// Provider envelope, result validation and an empty result.
{
  const { error, completed, failure } = await attempt([reply(200, gemini(extraction(), "MAX_TOKENS"))]);
  assert.ok(error instanceof Error);
  assert.equal(failure, "invalid_response");
  assert.equal(completed.details.stage, "provider_parse");
  assert.equal(completed.details.httpStatus, 200);
}
{
  const { error, completed, failure } = await attempt([reply(200, gemini(JSON.stringify({ pickup })))]);
  assert.ok(error instanceof Error);
  assert.equal(failure, "invalid_response");
  assert.equal(completed.details.stage, "result_parse");
}
{
  const { value, error, completed } = await attempt([reply(200, gemini(extraction(null)))]);
  assert.equal(error, undefined);
  assert.equal(value, null);
  assert.equal(completed.details.result, "empty");
  assert.equal(completed.level, "info");
}

// The owner's cancellation and the attempt deadline.
{
  const controller = new AbortController();
  const { error, completed, failure } = await attempt([pending()], { signal: controller.signal, abortAfterRequest: controller });
  assert.ok(error instanceof Error);
  assert.equal(failure, undefined, "a cancelled test shows no failure");
  assert.equal(completed.details.result, "cancelled");
  assert.equal(completed.level, "info");
  assert.equal(completed.details.timeoutOrigin, "parent_signal");
}
{
  const { error, completed, failure } = await attempt([pending()], { deadline: Date.now() + 80 });
  assert.ok(error instanceof Error);
  assert.equal(failure, "timeout");
  assert.equal(completed.details.result, "failed");
  assert.equal(completed.details.stage, "request");
  assert.equal(completed.details.errorCategory, "timeout");
  assert.ok(Number(completed.details.requestBudgetMs) <= 80);
}

// Turning recording off changes nothing about the result.
{
  setDiagnosticsEnabled(false);
  clearDiagnostics();
  queue.push(reply(200, gemini(extraction())));
  assert.deepEqual(await requestOnlineRecognition(config, image, Date.now() + CONNECTION_TEST_BUDGET_MS),
    { family: "pickup", fields: pickup });
  assert.deepEqual(readDiagnostics(), []);
}
assert.ok(cancelledReads > 0, "readers are released after each body");
console.log("Online recognition client tests passed");
