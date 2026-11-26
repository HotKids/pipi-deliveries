import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizedRecognitionURL, prepareRecognitionConfig, providerDefaults, recognitionOperation,
  recognitionSettings, saveRecognitionSettings, type RecognitionDraft } from "../services/recognition/settings";
import { parseRecognitionResult, providerRecognitionText, recognitionRequest, recognitionSchema } from "../services/recognition/wire";

const protectedInput = new Map<string, string>();
Object.assign(globalThis, { UUID: { string: randomUUID }, Keychain: {
  get: (name: string) => protectedInput.get(name),
  set: (name: string, value: string) => { protectedInput.set(name, value); return true; },
} });
assert.equal(recognitionSettings().draft.mode, "local");
assert.equal(recognitionOperation().config, undefined);
const online: RecognitionDraft = { ...providerDefaults("compatible"), mode: "online", providerName: "Synthetic",
  baseUrl: "https://synthetic.invalid/v1", model: "vision-fixture" };
assert.throws(() => normalizedRecognitionURL("compatible", "https://example:info@synthetic.invalid/v1/"));
assert.throws(() => normalizedRecognitionURL("compatible", "http://synthetic.invalid/v1/"));
assert.throws(() => normalizedRecognitionURL("compatible", "https://synthetic.invalid/v1?x=1"));
assert.throws(() => prepareRecognitionConfig(online, ""));
const fixtureKey = "synthetic-key";
saveRecognitionSettings(online, fixtureKey);
assert.deepEqual(recognitionSettings().draft, online);
assert.equal(recognitionSettings().keyLength, fixtureKey.length);
assert.doesNotMatch(JSON.stringify(recognitionSettings()), /synthetic-key/);
const prior = recognitionOperation();
assert.ok(prior.isCurrent());
assert.throws(() => prepareRecognitionConfig({ ...online, baseUrl: "https://different.invalid/v1" }, ""));
assert.throws(() => prepareRecognitionConfig({ ...providerDefaults("gemini"), mode: "online", model: "vision" }, ""));
saveRecognitionSettings({ ...online, mode: "local" }, "");
assert.equal(recognitionOperation().mode, "local");
assert.equal(prior.isCurrent(), false);
assert.equal(prepareRecognitionConfig(online, "").baseUrl, online.baseUrl);

const pickup = { brand: "Synthetic", pickupCode: "0123", productName: null, merchantName: null, itemCount: 2, totalAmount: "00.50" };
const result = { pickup, express: null, train: null, flight: null, movie: null };
const extraction = JSON.stringify(result);
assert.deepEqual(parseRecognitionResult(extraction), { family: "pickup", fields: pickup });
assert.equal(parseRecognitionResult(JSON.stringify({ ...result, pickup: null })), null);
for (const invalid of [
  extraction.replace('"pickupCode":', '"pickupCode":null,"pickupCode":'),
  extraction.replace('"0123"', '"12**"'),
  JSON.stringify({ ...result, express: { waybill: "TEST12345678", pickupCode: null } }),
  JSON.stringify({ ...result, pickup: { ...pickup, totalAmount: 0.5 } }),
  JSON.stringify({ ...result, pickup: { ...pickup, qrPayload: "invented" } }),
]) assert.throws(() => parseRecognitionResult(invalid));

const config = prepareRecognitionConfig(online, "");
const chat = recognitionRequest(config, "Synthetic prompt", "SYNTHETIC_DATA");
assert.equal(chat.url, online.baseUrl + "/chat/completions");
const chatBody = JSON.parse(chat.body);
assert.equal(chatBody.messages[1].content[0].image_url.url, "data:image/jpeg;base64,SYNTHETIC_DATA");
assert.deepEqual(chatBody.response_format.json_schema.schema, recognitionSchema);
const responses = JSON.parse(recognitionRequest({ ...config, protocol: "responses" }, "Synthetic prompt", "SYNTHETIC_DATA").body);
assert.equal(responses.store, false);
assert.equal(responses.input[0].content[0].type, "input_image");
const gemini = JSON.parse(recognitionRequest({ ...config, protocol: "gemini" }, "Synthetic prompt", "SYNTHETIC_DATA", false).body);
assert.equal(gemini.contents[0].parts[0].inlineData.mimeType, "image/jpeg");
assert.equal(gemini.generationConfig.thinkingConfig, undefined);

const reply = { status: "completed", output: [{ type: "message", role: "assistant",
  content: [{ type: "output_text", text: extraction }] }] };
assert.equal(providerRecognitionText("responses", JSON.stringify(reply)), extraction);
assert.throws(() => providerRecognitionText("responses", JSON.stringify({ ...reply, status: "incomplete" })));
assert.throws(() => providerRecognitionText("chat_completions", JSON.stringify({
  choices: [{ finish_reason: "stop", message: { refusal: "Synthetic refusal" } }],
})));
assert.equal(providerRecognitionText("gemini", JSON.stringify({ candidates: [{ finishReason: "STOP",
  content: { parts: [{ thought: true, text: "ignored" }, { text: extraction }] } }] })), extraction);

const page = readFileSync(new URL("../pages/RecognitionSettingsPage.tsx", import.meta.url), "utf8");
const start = page.indexOf("  async function testConnection() {");
const end = page.indexOf("\n  function save()", start);
const copyStart = page.indexOf("const CONNECTION_TESTING =");
const copyEnd = page.indexOf("\nfunction ProviderLogo", copyStart);
assert.ok(start >= 0 && end > start && copyStart >= 0 && copyEnd > copyStart);
const makeConnectionTest = new Function(
  "cancelTest", "setValidation", "request", "prepareRecognitionConfig", "draft", "key", "setTesting", "setNotice",
  "UIImage", "Script", "requestOnlineRecognition", "CONNECTION_TEST_BUDGET_MS", "RecognitionSettingError",
  "writeDiagnostic", "onlineRecognitionFailure", "onlineRecognitionIdentity", "cancelReason",
  `${page.slice(copyStart, copyEnd)}\nreturn (${page.slice(start, end).trim()});`,
);
// A failed test names a safe category (IOS-SR-04, owner 2026-11-21); a failure without one keeps the general copy.
const categories: Record<string, string> = {
  authorization: "连接测试失败，密钥无效或无权限",
  model: "连接测试失败，模型不可用",
  rate_limited: "连接测试失败，请求过于频繁或额度不足",
  timeout: "连接测试失败，连接超时",
  network: "连接测试失败，网络连接失败",
  invalid_response: "连接测试失败，返回内容无法识别",
  prompt: "连接测试失败，提示词下载失败",
};
const identity = { onlineProvider: "compatible", onlineProtocol: "chat_completions", onlineModel: "vision-fixture" };
const outcomes = ["success", "no_match", "cancel", "uncategorized", ...Object.keys(categories)];
for (const outcome of outcomes) {
  const notices: string[] = [];
  const busy: boolean[] = [];
  const recorded: Array<{ event: string; details: Record<string, unknown> }> = [];
  const requests: unknown[][] = [];
  const request = { current: null as AbortController | null };
  let complete!: (value: unknown) => void;
  let fail!: (error: unknown) => void;
  const response = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  const thrown = new Error("Synthetic provider message: key sk-synthetic is invalid");
  const run = makeConnectionTest(
    () => {}, () => {}, request, prepareRecognitionConfig, online, "", (value: boolean) => busy.push(value),
    (message: string) => notices.push(message), { fromFile: () => ({}) }, { directory: "/fixture" },
    (...args: unknown[]) => { requests.push(args); return response; }, 5_000, class SyntheticSettingError extends Error {},
    (event: string, details: Record<string, unknown>) => recorded.push({ event, details }),
    (error: unknown) => error === thrown && outcome in categories ? outcome : undefined,
    () => identity,
    { current: undefined },
  ) as () => Promise<void>;
  const pending = run();
  assert.deepEqual(notices, ["正在测试连接"]);
  if (outcome === "cancel") {
    request.current?.abort();
    request.current = null;
  }
  if (outcome === "uncategorized" || outcome in categories) fail(thrown);
  else complete(outcome === "no_match" ? null : { family: "pickup", fields: pickup });
  await pending;
  const expected = outcome === "success" ? "连接测试成功" : outcome === "no_match" ? "连接测试失败，识别结果不符"
    : outcome === "uncategorized" ? "连接测试失败，请检查在线识别配置" : categories[outcome];
  assert.deepEqual(notices, outcome === "cancel" ? ["正在测试连接"] : ["正在测试连接", expected], outcome);
  assert.ok(!notices.join("").includes("sk-synthetic") && !notices.join("").includes("Synthetic provider"),
    "the provider's message never reaches the Toast");
  assert.deepEqual(busy, outcome === "cancel" ? [true] : [true, false]);
  assert.equal(requests[0]?.[4], "connection_test", "the page marks its attempt as a connection test");
  assert.deepEqual(recorded, outcome === "no_match" ? [{ event: "recognition.online.validation",
    details: { trigger: "connection_test", ...identity, stage: "validation", result: "no_match" } }] : [],
    "a reply that is not the test code is recorded with the configured provider, protocol and model");
}
console.log("Online recognition settings and provider wire tests passed");
